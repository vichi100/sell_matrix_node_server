const { analyzeWithLLM } = require('./llmService');
const redisService = require('./redisService');

/**
 * Main entrypoint called by Deepgram/Soniox whenever a new sentence finishes.
 * It appends the sentence to Redis and triggers the LLM pipeline asynchronously.
 * 
 * @param {string} call_control_id - ID of the active Telnyx call
 * @param {string} newSentence - The finalized transcript snippet
 */
async function processUtterance(call_control_id, newSentence) {
    if (!newSentence || newSentence.trim() === '') return;

    try {
        // 1. Accumulate Context in Redis List
        await redisService.addTranscriptSegment(call_control_id, 'caller', newSentence.trim());

        // We only retrieve the last ~5 sentences (approx 1 minute) to keep inference fast
        const recentContextArray = await redisService.getRecentTranscript(call_control_id, 5);
        if (recentContextArray.length === 0) return;
        const recentContext = recentContextArray.join('\n');

        // Log that pipeline started for debug
        console.log(`\n[Pipeline] Triggered for call ${call_control_id.slice(-6)}...`);

        // Run pipeline asynchronously so it doesn't block the WebSocket stream
        runAnalysisPipeline(call_control_id, recentContext).catch(err => {
            console.error('[Pipeline Error]', err.message);
        });
    } catch (err) {
        console.error('[Process Utterance Redis Error]', err.message);
    }
}

/**
 * Orchestrates the prompts using a Hybrid Parallel/Sequential approach:
 * 1. Fires Intent and Signals in PARALLEL for sub-second UI updates.
 * 2. Fires the smart Score Engine SEQUENTIALLY after step 1 completes.
 */
async function runAnalysisPipeline(call_control_id, recentContext) {
    const startTime = Date.now();

    // === Step 1: PARALLEL Intent & Signal Extraction ===
    const intentPrompt = `
    You are an AI sales assistant listening to a real-time call transcript. 
    The transcript may contain English, Hindi (Devanagari script), or Hinglish (mixed). You must understand and analyze all of them equally.
    Analyze the recent dialogue and categorize the caller's current intent.
    Choose exactly one of the following categories:
    - "Information Gathering" (Asking questions, learning, asking for details)
    - "Objection" (Pushing back on price, timing, or feature)
    - "Interested" (Showing positive reception, wanting to visit or see it, "देखने आ सकता हूँ")
    - "Ready to Buy" (Asking for next steps, exact pricing details, "प्राइस क्या है", "कितना एरिया है")
    - "Not Interested" (Trying to leave, hanging up, angry, "नहीं चाहिए")
    - "Neutral" (Pleasantries, greeting, unclear)

    Return ONLY a raw JSON object with the translation, the intent, a provisional AI estimated fast-score (0-100), and reasoning:
    { "english_translation": "Briefly translate the dialogue to English", "intent": "Chosen Category", "provisional_score": 65, "reasoning": "1 short sentence why" }
    `;

    const signalPrompt = `
    You are an AI sales assistant. Extract specific "Buying Signals" from this transcript.
    The transcription may be in English, Hindi (Devanagari script), or Hinglish.
    Buying signals are explicit mentions of timeline, budget, authority, or specific feature needs (e.g., asking for price, area, details, "फ्लैट का प्राइस", "देखने आ सकता हूँ", "मिलने आ सकता हूँ").
    Extract the actual spoken phrase. If none exist yet, output an empty array.
    
    Return ONLY a raw JSON object:
    { "buying_signals": ["original spoken signal 1", "original spoken signal 2"] }
    `;

    // Fire both prompts simultaneously
    const [intentResult, signalResult] = await Promise.all([
        analyzeWithLLM(intentPrompt, recentContext),
        analyzeWithLLM(signalPrompt, recentContext)
    ]);

    const finalIntent = intentResult?.intent || 'Neutral';
    const finalSignals = signalResult?.buying_signals || [];

    // The AI now decides the instant Fast Score dynamically based on organic dialogue cues
    let fastScore = intentResult?.provisional_score || 45;

    // Fast Dashboard Update 1 (< 800ms) - Saved Directly to Redis Timeline
    await redisService.updateScore(call_control_id, fastScore, finalIntent, finalSignals);
    console.log(`\n⚡ [FAST UI UPDATE] (${Date.now() - startTime}ms) Pipeline 1/2 complete`);

    // === Step 2: SEQUENTIAL Deep Score Engine ===
    const scorePrompt = `
    You are an AI sales assistant calculating a deep, contextual "Interest Score" from 0 to 100.
    You previously estimated a provisional score of ${fastScore} based on their instant intent. 
    Now, deeply review the full transcript context one last time to output the absolute final refined score.
    Understand that the customer may be speaking Hindi (Devanagari script) or Hinglish. Always translate the context to English in your mind before scoring.
    - 0-20: Hostile/Hanging up
    - 21-40: Cold/Skeptical
    - 41-60: Neutral/Information Gathering
    - 61-80: Warm/Asking specific buying questions (e.g. asking for prices "प्राइस क्या है", site visits "देखने आना", areas)
    - 81-100: Hot/Ready to close

    Transcript:
    ${recentContext}

    Current Intent: ${finalIntent}
    Signals Found: ${finalSignals.join(', ') || 'None'}

    Return ONLY a raw JSON object:
    { "interest_score": <number> }
    `;

    const scoreResult = await analyzeWithLLM(scorePrompt, recentContext);
    const deepScore = scoreResult?.interest_score || fastScore;

    // Final Dashboard Update 2 (~1.5s total) - Saved to Redis
    await redisService.updateScore(call_control_id, deepScore, finalIntent, finalSignals);

    // Print beautifully to terminal
    console.log(`\n============== [AI INSIGHTS] (${Date.now() - startTime}ms total) ==============`);
    console.log(`🧠 Intent:   ${finalIntent}`);
    console.log(`🎯 Score:    ${deepScore}/100`);
    console.log(`🛒 Signals:  ${finalSignals.length > 0 ? finalSignals.join(', ') : 'None detected'}`);
    console.log(`====================================================\n`);
}

/**
 * Clean up Redis memory when a call hangs up
 */
async function cleanupCallContext(call_control_id) {
    try {
        await redisService.cleanupCall(call_control_id);
        console.log(`[Redis Cleanup] Scrubbed data for call ${call_control_id.slice(-6)}`);
    } catch (err) {
        console.error('[Redis Cleanup Error]', err.message);
    }
}

module.exports = { processUtterance, cleanupCallContext };
