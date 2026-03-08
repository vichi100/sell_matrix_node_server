const { GoogleGenAI } = require('@google/genai');
const OpenAI = require('openai');

// Initialize clients lazily based on environment variables
let geminiClient = null;
let openaiClient = null;

const provider = process.env.LLM_PROVIDER || 'gemini';

if (provider === 'gemini' && process.env.GEMINI_API_KEY) {
    geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
} else if (provider === 'openai' && process.env.OPENAI_API_KEY) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

/**
 * Sends a prompt to the configured LLM and expects a JSON response.
 * @param {string} systemPrompt - The system instructions detailing the JSON schema
 * @param {string} userPrompt - The transcript or data to analyze
 * @returns {Promise<object>} - Parsed JSON object from the LLM
 */
async function analyzeWithLLM(systemPrompt, userPrompt) {
    if (provider === 'gemini' && geminiClient) {
        return await callGemini(systemPrompt, userPrompt);
    } else if (provider === 'openai' && openaiClient) {
        return await callOpenAI(systemPrompt, userPrompt);
    } else {
        throw new Error(`LLM provider '${provider}' is not configured properly. Check your .env file.`);
    }
}

async function callGemini(systemPrompt, userPrompt) {
    try {
        const response = await geminiClient.models.generateContent({
            // Using standard flash model since flash-lite is no longer available to new users
            model: 'gemini-2.0-flash',
            contents: userPrompt,
            config: {
                systemInstruction: systemPrompt,
                responseMimeType: 'application/json',
                temperature: 0.1, // Keep it deterministic for JSON extraction
            }
        });

        let cleanText = response.text || '';
        cleanText = cleanText.replace(/```json/gi, '').replace(/```/g, '').trim();

        return JSON.parse(cleanText);
    } catch (error) {
        console.error('Gemini API Error:', error.message);
        return null; // Return null gracefully so the pipeline doesn't crash the call
    }
}

async function callOpenAI(systemPrompt, userPrompt) {
    try {
        const response = await openaiClient.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            response_format: { type: 'json_object' },
            temperature: 0.1,
        });

        return JSON.parse(response.choices[0].message.content);
    } catch (error) {
        console.error('OpenAI API Error:', error.message);
        return null;
    }
}

module.exports = { analyzeWithLLM };
