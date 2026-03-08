const express = require('express');

// Store active calls in memory (for production, use Redis or a DB)
const activeCalls = new Map();

function setupDashboardRoutes(telnyx) {
    const router = express.Router();

    router.get('/calls', (req, res) => {
        // Return all active calls as an array
        res.json(Array.from(activeCalls.values()));
    });

    router.post('/calls/:id/answer', async (req, res) => {
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

    router.post('/calls/:id/reject', async (req, res) => {
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

    return { router, activeCalls };
}

module.exports = { setupDashboardRoutes };
