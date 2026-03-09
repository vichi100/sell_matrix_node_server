const express = require('express');
const redisService = require('../services/redisService');

function setupTelnyxRoutes(telnyx) {
    const router = express.Router();

    // Telnyx Webhook Route
    router.post('/webhook', async (req, res) => {
        // Always return 200 OK immediately to prevent Telnyx from timing out the webhook
        res.status(200).send('OK');

        const event = req.body;
        if (!event || !event.data || !event.data.payload) return;

        const eventType = event.data.event_type;
        const { call_control_id } = event.data.payload;

        try {
            if (eventType === 'call.initiated') {
                const caller_number = event.data.payload.from;
                console.log(`Call initiated: ${call_control_id} from ${caller_number}. Ringing...`);

                // Store the call as ringing in Redis
                await redisService.initializeCallState(call_control_id, {
                    call_control_id,
                    caller_number,
                    status: 'ringing',
                    direction: event.data.payload.direction,
                    timestamp: new Date().toISOString()
                });

                // Auto answer config check
                const shouldAutoAnswer = process.env.AUTO_ANSWER === 'true';
                if (shouldAutoAnswer) {
                    console.log(`Auto-answer is ON. Answering call: ${call_control_id}`);
                    await telnyx.calls.actions.answer(call_control_id);

                    // Update status in Redis
                    const callData = await redisService.getCallState(call_control_id);
                    if (callData) {
                        await redisService.initializeCallState(call_control_id, { ...callData, status: 'answering' });
                    }
                } else {
                    console.log(`Auto-answer is OFF. Waiting for dashboard to pick up.`);
                }
            } else if (eventType === 'call.answered') {
                console.log(`Call answered: ${call_control_id}. Starting media stream...`);

                const wssUrl = process.env.WEBSOCKET_URL || 'wss://api.sellmatrices.com/media-stream';
                const streamUrl = wssUrl;

                // Issue a Telnyx command to start streaming audio (Media Streaming) to the local WebSocket endpoint
                await telnyx.calls.actions.startStreaming(call_control_id, {
                    stream_url: streamUrl,
                    stream_track: 'inbound_track' // Stream audio coming from the caller
                });
                const transcriberName = (process.env.TRANSCRIPT_PROVIDER || 'deepgram').toUpperCase();
                console.log(`Started media streaming to ${streamUrl}. ${transcriberName} will transcribe via WebSocket.\n`);

                // Update call status in Redis
                const callData = await redisService.getCallState(call_control_id);
                if (callData) {
                    await redisService.initializeCallState(call_control_id, { ...callData, status: 'answered' });
                }
            } else if (eventType === 'call.hangup') {
                console.log(`Call hung up: ${call_control_id}`);
                // Remove the call from active Redis DB so it drops off the dashboard
                await redisService.cleanupCall(call_control_id);

                // Note: In production, trigger a background worker here to persist history to Postgres

            } else if (eventType === 'call.transcription') {
                const transcriptionData = event.data.payload.transcriptionData || event.data.payload.transcription_data;
                if (transcriptionData) {
                    const isFinal = transcriptionData.is_final;

                    if (isFinal && transcriptionData.transcript) {
                        console.log(`\n✅ [FINAL SENTENCE]: "${transcriptionData.transcript}"\n`);
                    } else if (transcriptionData.transcript) {
                        console.log(`⏳ [GUESSING]: "${transcriptionData.transcript}"`);
                    }
                }
            }
        } catch (error) {
            console.error('Error handling Telnyx webhook event:', error.message);
        }
    });

    return router;
}

module.exports = { setupTelnyxRoutes };
