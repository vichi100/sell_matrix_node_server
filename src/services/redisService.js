const redis = require('redis');

// Initialize Redis Client
const client = redis.createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

client.on('error', (err) => console.log('Redis Client Error', err));
client.on('connect', () => console.log('Redis Client Connected'));

// Connect immediately, gracefully handle failures
client.connect().catch(console.error);

// ---------------------------------------------------------
// Call State Management
// ---------------------------------------------------------
const TTL_SECONDS = 7200; // 2 hours

async function initializeCallState(callId, data) {
    if (!client.isOpen) return;
    const key = `call:${callId}:state`;
    await client.set(key, JSON.stringify(data));
    await client.expire(key, TTL_SECONDS);
    await client.sAdd('active_calls', callId);
}

async function getCallState(callId) {
    if (!client.isOpen) return null;
    const key = `call:${callId}:state`;
    const data = await client.get(key);
    return data ? JSON.parse(data) : null;
}

// ---------------------------------------------------------
// Transcript Buffer
// ---------------------------------------------------------
async function addTranscriptSegment(callId, speaker, text) {
    if (!client.isOpen) return;
    const key = `call:${callId}:transcript`;
    const payload = JSON.stringify({ speaker, text, time: Date.now() });
    await client.lPush(key, payload);
    await client.lTrim(key, 0, 99); // Keep only last 100 segments
    await client.expire(key, TTL_SECONDS);

    // Provide instant UI updates for the Live Transcript widget
    await client.publish('transcript_update', JSON.stringify({ call_id: callId, speaker, text }));
}

async function getRecentTranscript(callId, numSentences = 5) {
    if (!client.isOpen) return [];
    const key = `call:${callId}:transcript`;
    // LRANGE returns an array from index 0 (newest due to LPUSH) down
    const segmentsRaw = await client.lRange(key, 0, numSentences - 1);

    // We want the oldest of the recent segments first, so reverse it
    return segmentsRaw
        .map(raw => JSON.parse(raw))
        .reverse()
        .map(seg => `Caller: ${seg.text}`);
}

// ---------------------------------------------------------
// Score Timeline / Graph
// ---------------------------------------------------------
async function updateScore(callId, score, intent, signals) {
    if (!client.isOpen) return;
    const keyScore = `call:${callId}:score`;
    const keyTimeline = `call:${callId}:score_timeline`;
    const timestamp = Date.now();

    // 1. Set current score
    await client.set(keyScore, JSON.stringify({ score, intent, signals }));
    await client.expire(keyScore, TTL_SECONDS);

    // 2. Add to timeline (ZADD score: timestamp value: JSON)
    // Actually, storing the JSON in the sorted set is fine for graphs
    const payload = JSON.stringify({ time: new Date().toISOString(), score, intent, signals });
    await client.zAdd(keyTimeline, { score: timestamp, value: payload });
    await client.zRemRangeByRank(keyTimeline, 0, -201); // Keep last 200 graph points
    await client.expire(keyTimeline, TTL_SECONDS);

    // 3. Optional: Publish Dashboard Event
    await client.publish('call_updates', JSON.stringify({ call_id: callId, score, intent }));
}

async function getScoreTimeline(callId) {
    if (!client.isOpen) return [];
    const key = `call:${callId}:score_timeline`;
    // Get all from smallest to largest timestamp
    const rawData = await client.zRange(key, 0, -1);
    return rawData.map(raw => JSON.parse(raw));
}

// ---------------------------------------------------------
// Cleanup
// ---------------------------------------------------------
async function cleanupCall(callId) {
    if (!client.isOpen) return;

    try {
        // 1. Fetch all data one last time before deletion
        const [stateStr, scoreStr, transcriptRaw, timelineRaw] = await Promise.all([
            client.get(`call:${callId}:state`),
            client.get(`call:${callId}:score`),
            client.lRange(`call:${callId}:transcript`, 0, -1),
            client.zRange(`call:${callId}:score_timeline`, 0, -1)
        ]);

        const dbService = require('./dbService');

        const finalState = {
            state: stateStr ? JSON.parse(stateStr) : null,
            scoreInfo: scoreStr ? JSON.parse(scoreStr) : null,
            transcriptArray: transcriptRaw ? transcriptRaw.map(r => JSON.parse(r)).reverse() : [],
            scoreTimeline: timelineRaw ? timelineRaw.map(r => JSON.parse(r)) : []
        };

        // 2. Insert into PostgreSQL
        await dbService.persistCallData(callId, finalState);

    } catch (dbErr) {
        console.error(`[Redis Cleanup] Failed to persist data to DB for ${callId}:`, dbErr.message);
        // Continue to delete from Redis to prevent memory leaks!
    }

    // 3. Delete from Redis
    const keysToDelete = [
        `call:${callId}:state`,
        `call:${callId}:score`,
        `call:${callId}:transcript`,
        `call:${callId}:events`,
        `call:${callId}:score_timeline`
    ];

    await client.del(keysToDelete);
    await client.sRem('active_calls', callId);
}

module.exports = {
    client,
    initializeCallState,
    getCallState,
    addTranscriptSegment,
    getRecentTranscript,
    updateScore,
    getScoreTimeline,
    cleanupCall
};
