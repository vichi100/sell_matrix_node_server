require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const telnyx = require('telnyx')(process.env.TELNYX_API_KEY);
const { createClient } = require('@deepgram/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Store active calls in memory (for production, use Redis or a DB)
const activeCalls = new Map();

// --- Dashboard APIs ---
app.get('/api/calls', (req, res) => {
    // Return all active calls as an array
    res.json(Array.from(activeCalls.values()));
});

app.post('/api/calls/:id/answer', async (req, res) => {
    const call_control_id = req.params.id;
    if (!activeCalls.has(call_control_id)) {
        return res.status(404).json({ error: 'Call not found' });
    }

    try {
        console.log(`Answering call from dashboard: ${call_control_id}`);
        await telnyx.calls.actions.answer(call_control_id);

        // Update status to prevent double-answering
        const callData = activeCalls.get(call_control_id);
        activeCalls.set(call_control_id, { ...callData, status: 'answering' });

        res.json({ success: true, message: 'Call answered successfully' });
    } catch (error) {
        console.error('Error answering call:', error.message);
        res.status(500).json({ error: 'Failed to answer call', details: error.message });
    }
});

app.post('/api/calls/:id/reject', async (req, res) => {
    const call_control_id = req.params.id;
    if (!activeCalls.has(call_control_id)) {
        return res.status(404).json({ error: 'Call not found' });
    }

    try {
        console.log(`Rejecting call from dashboard: ${call_control_id}`);
        await telnyx.calls.actions.reject(call_control_id);

        // Remove from active calls
        activeCalls.delete(call_control_id);
        res.json({ success: true, message: 'Call rejected' });
    } catch (error) {
        console.error('Error rejecting call:', error.message);
        res.status(500).json({ error: 'Failed to reject call', details: error.message });
    }
});
// Main HTTP server
const server = http.createServer(app);

// WebSocket server setup
const wss = new WebSocket.Server({ server, path: '/media-stream' });

wss.on('connection', (ws) => {
    console.log('WebSocket connection established on /media-stream');

    // Connect directly to Deepgram API via raw WebSocket (bypasses SDK param issues)
    const dgUrl = [
        'wss://api.deepgram.com/v1/listen',
        '?model=nova-2',
        '&language=en',
        '&encoding=mulaw',
        '&sample_rate=8000',
        '&interim_results=true',
        '&endpointing=300',       // Force finalize quickly after speech pauses
        '&utterance_end_ms=1000', // Hard fallback for long silences
        '&vad_events=true',       // Voice activity detection
    ].join('');

    const dgWs = new WebSocket(dgUrl, {
        headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` }
    });

    let dgReady = false;
    const audioBuffer = [];
    let lastWordEnd = 0;       // Track highest timestamp of printed words
    let printedAnything = false; // Track if we've outputted words for the current sentence

    dgWs.on('open', () => {
        console.log('\nDeepgram connection opened. Flushing buffered audio...');
        dgReady = true;
        for (const chunk of audioBuffer) {
            dgWs.send(chunk);
        }
        audioBuffer.length = 0;

        // Prevent Deepgram 1011 timeout during speech pauses
        ws.keepAliveInterval = setInterval(() => {
            if (dgWs.readyState === WebSocket.OPEN) {
                dgWs.send(JSON.stringify({ type: 'KeepAlive' }));
            }
        }, 8000);
    });

    dgWs.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);
            const msgType = msg?.type;

            if (msgType === 'Results') {
                const words = msg?.channel?.alternatives?.[0]?.words || [];

                // Print strictly new words that were spoken *after* our last printed word
                for (const wordObj of words) {
                    if (wordObj.end > lastWordEnd) {
                        process.stdout.write(wordObj.word + ' ');
                        lastWordEnd = wordObj.end;
                        printedAnything = true;
                    }
                }

                // If Deepgram finalizes the phrase, lock it with .....
                if (msg.is_final || msg.speech_final) {
                    if (printedAnything) {
                        process.stdout.write('..... ');
                        printedAnything = false;
                    }
                    lastWordEnd = 0; // Reset timeline for new sentence
                }
            } else if (msgType === 'UtteranceEnd') {
                if (printedAnything) {
                    process.stdout.write('..... ');
                    printedAnything = false;
                }
                lastWordEnd = 0;
            }
        } catch (e) {
            // ignore non-JSON
        }
    });

    dgWs.on('error', (err) => console.error('\nDeepgram WS error:', err.message));
    dgWs.on('close', (code, reason) => {
        if (printedAnything) {
            process.stdout.write('..... \n');
            printedAnything = false;
        }
        lastWordEnd = 0;
        console.log(`\nDeepgram connection closed. Code: ${code}, Reason: ${reason?.toString() || 'none'}`);
        if (ws.keepAliveInterval) clearInterval(ws.keepAliveInterval);
    });

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.event === 'media' && data.media?.payload) {
                const audio = Buffer.from(data.media.payload, 'base64');
                if (dgReady) {
                    dgWs.send(audio);
                } else {
                    audioBuffer.push(audio);
                }
            }
        } catch (e) {
            // ignore non-JSON
        }
    });

    ws.on('close', () => {
        console.log('Telnyx WebSocket connection closed.');
        if (ws.keepAliveInterval) clearInterval(ws.keepAliveInterval);
        if (dgWs.readyState === WebSocket.OPEN) {
            dgWs.close();
        }
    });
});

app.get('/', (req, res) => {
    res.send('Telnyx Gateway is running!');
});

// Telnyx Webhook Route
app.post('/api/telnyx/webhook', async (req, res) => {
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

            // Store the call as ringing so the dashboard can see it
            activeCalls.set(call_control_id, {
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

                // Update status locally 
                const callData = activeCalls.get(call_control_id);
                activeCalls.set(call_control_id, { ...callData, status: 'answering' });
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
            console.log(`Started media streaming to ${streamUrl}. Deepgram will transcribe via WebSocket.`);

            // Update call status
            if (activeCalls.has(call_control_id)) {
                const callData = activeCalls.get(call_control_id);
                activeCalls.set(call_control_id, { ...callData, status: 'answered' });
            }
        } else if (eventType === 'call.hangup') {
            console.log(`Call hung up: ${call_control_id}`);
            // Remove the call from active list so it drops off the dashboard
            activeCalls.delete(call_control_id);
        } else if (eventType === 'call.transcription') {
            const transcriptionData = event.data.payload.transcriptionData || event.data.payload.transcription_data;
            if (transcriptionData) {
                const isFinal = transcriptionData.is_final;

                // Since Deepgram sends many rapid updates, \r overwriting can swallow other logs. 
                // Using standard console.log is safer!
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

server.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});
