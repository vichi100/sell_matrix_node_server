const express = require('express');
const redisService = require('../services/redisService');

function setupDashboardRoutes(telnyx) {
    const router = express.Router();

    router.get('/calls', async (req, res) => {
        try {
            if (!redisService.client.isOpen) return res.json([]);

            const callIds = await redisService.client.sMembers('active_calls');
            const activeCallsData = [];

            for (const callId of callIds) {
                const state = await redisService.getCallState(callId);
                const scoreTimeline = await redisService.getScoreTimeline(callId);

                // Build the frontend payload structure
                if (state) {
                    // Fetch the latest score from Redis (or default it)
                    const latestScoreStr = await redisService.client.get(`call:${callId}:score`);
                    const latestScore = latestScoreStr ? JSON.parse(latestScoreStr) : { score: 0, intent: 'Neutral', signals: [] };

                    activeCallsData.push({
                        call_control_id: callId,
                        ...state,
                        pipeline: {
                            intent: latestScore.intent,
                            interest_score: latestScore.score,
                            buying_signals: latestScore.signals,
                            score_history: scoreTimeline,
                            last_updated: new Date().toISOString()
                        }
                    });
                }
            }
            res.json(activeCallsData);
        } catch (err) {
            console.error('Dashboard Error:', err);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    router.post('/calls/:id/answer', async (req, res) => {
        const call_control_id = req.params.id;

        try {
            const state = await redisService.getCallState(call_control_id);
            if (!state) return res.status(404).json({ error: 'Call not found' });

            console.log(`Answering call from dashboard: ${call_control_id}`);
            await telnyx.calls.actions.answer(call_control_id);

            // Update status to prevent double-answering
            await redisService.initializeCallState(call_control_id, { ...state, status: 'answering' });

            res.json({ success: true, message: 'Call answered successfully' });
        } catch (error) {
            console.error('Error answering call:', error.message);
            res.status(500).json({ error: 'Failed to answer call', details: error.message });
        }
    });

    router.post('/calls/:id/reject', async (req, res) => {
        const call_control_id = req.params.id;

        try {
            const state = await redisService.getCallState(call_control_id);
            if (!state) return res.status(404).json({ error: 'Call not found' });

            console.log(`Rejecting call from dashboard: ${call_control_id}`);
            await telnyx.calls.actions.reject(call_control_id);

            // Note: In production we let the webhook 'call.hangup' delete it, 
            // but for UI responsiveness we can eagerly delete here.
            await redisService.cleanupCall(call_control_id);

            res.json({ success: true, message: 'Call rejected' });
        } catch (error) {
            console.error('Error rejecting call:', error.message);
            res.status(500).json({ error: 'Failed to reject call', details: error.message });
        }
    });

    return { router };
}

module.exports = { setupDashboardRoutes };
