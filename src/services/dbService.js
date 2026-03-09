const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/sellmatrix'
});

pool.on('error', (err, client) => {
    console.error('Unexpected error on idle client', err);
});

/**
 * Persists the final state of a call from Redis into the PostgreSQL database.
 * This should be called immediately before the Redis keys are deleted.
 * 
 * @param {string} callId - The ID of the call (call_control_id)
 * @param {object} finalState - The collected final state from Redis
 */
async function persistCallData(callId, finalState) {
    const { state, scoreInfo, transcriptArray, eventsArray, scoreTimeline } = finalState;

    // We need a stable DB connection
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Ensure Buyer exists (Upsert)
        // In a real app we'd look up by caller_number. We create a placeholder if missing.
        let buyerId = null;
        if (state && state.caller_number) {
            const buyerResult = await client.query(
                `INSERT INTO buyers (phone_number, first_contacted_at, last_contacted_at) 
                 VALUES ($1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) 
                 ON CONFLICT (phone_number) DO UPDATE SET last_contacted_at = CURRENT_TIMESTAMP 
                 RETURNING id`,
                [state.caller_number]
            );
            buyerId = buyerResult.rows[0].id;
        }

        // 2. Insert into `calls` table
        // We calculate duration based on start vs end timestamp
        const startTime = state ? new Date(state.timestamp) : new Date();
        const endTime = new Date(); // now
        const durationSeconds = Math.round((endTime - startTime) / 1000);

        const finalScore = scoreInfo ? scoreInfo.score : 0;
        const finalIntent = scoreInfo ? scoreInfo.intent : 'Unknown';

        const callResult = await client.query(
            `INSERT INTO calls (telnyx_call_id, buyer_id, started_at, ended_at, duration_seconds, final_interest_score, final_intent)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (telnyx_call_id) DO UPDATE 
             SET ended_at = EXCLUDED.ended_at, 
                 duration_seconds = EXCLUDED.duration_seconds,
                 final_interest_score = EXCLUDED.final_interest_score,
                 final_intent = EXCLUDED.final_intent
             RETURNING id`,
            [
                callId,
                buyerId,
                startTime.toISOString(),
                endTime.toISOString(),
                durationSeconds,
                finalScore,
                finalIntent
            ]
        );

        const internalCallId = callResult.rows[0].id;

        // 3. Insert Transcript into call_events (Type: 'transcript')
        if (transcriptArray && transcriptArray.length > 0) {
            await client.query(
                `INSERT INTO call_events (call_id, event_type, event_time_seconds, payload) VALUES ($1, $2, $3, $4)`,
                [internalCallId, 'transcript', durationSeconds, JSON.stringify({ segments: transcriptArray })]
            );
        }

        // 4. Insert Score Timeline into call_events (Type: 'score_timeline')
        if (scoreTimeline && scoreTimeline.length > 0) {
            await client.query(
                `INSERT INTO call_events (call_id, event_type, event_time_seconds, payload) VALUES ($1, $2, $3, $4)`,
                [internalCallId, 'score_timeline', durationSeconds, JSON.stringify({ timeline: scoreTimeline })]
            );
        }

        // 5. Insert raw signals/intents specifically into call_events
        if (scoreInfo && scoreInfo.signals && scoreInfo.signals.length > 0) {
            await client.query(
                `INSERT INTO call_events (call_id, event_type, event_time_seconds, payload) VALUES ($1, $2, $3, $4)`,
                [internalCallId, 'buying_signals_detected', durationSeconds, JSON.stringify({ signals: scoreInfo.signals, intent: scoreInfo.intent })]
            );
        }

        await client.query('COMMIT');
        console.log(`[DB Success] Call ${callId.slice(-6)} persisted to PostgreSQL.`);

    } catch (e) {
        await client.query('ROLLBACK');
        console.error(`[DB Error] Failed to persist call ${callId}:`, e.message);
        throw e;
    } finally {
        client.release();
    }
}

/**
 * Returns summary metrics for the dashboard history
 */
async function getRecentCalls(limit = 20) {
    try {
        const res = await pool.query(
            `SELECT c.telnyx_call_id, c.started_at, c.duration_seconds, c.final_interest_score, c.final_intent, b.phone_number 
             FROM calls c
             LEFT JOIN buyers b ON c.buyer_id = b.id
             ORDER BY c.started_at DESC
             LIMIT $1`,
            [limit]
        );
        return res.rows;
    } catch (e) {
        console.error('[DB Error] Fetching recent calls:', e.message);
        return [];
    }
}

module.exports = { pool, persistCallData, getRecentCalls };
