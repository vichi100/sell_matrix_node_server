const WebSocket = require('ws');
const { PassThrough } = require('stream');
const { SonioxNodeClient } = require('@soniox/node');
const { processUtterance } = require('./pipelineService');

function setupSonioxWebSocket(server, activeCalls) {
    const wss = new WebSocket.Server({ server, path: '/media-stream' });

    let client = null;
    try {
        if (process.env.SONIOX_API_KEY) {
            client = new SonioxNodeClient({ apiKey: process.env.SONIOX_API_KEY });
        }
    } catch (e) {
        console.error('Failed to initialize Soniox Client:', e.message);
    }

    wss.on('connection', async (ws) => {
        console.log('\nWebSocket connection established on /media-stream (Soniox Provider)');

        if (!client) {
            console.error('Soniox API key missing or invalid. Cannot transcribe.\n');
            return;
        }

        // Find the call_control_id tied to this specific WebSocket stream
        let call_control_id = 'unknown_call';
        for (const [id, callData] of activeCalls.entries()) {
            if (callData.status === 'answered') {
                call_control_id = id;
                break;
            }
        }

        let session;
        let sentenceBuffer = "";

        try {
            session = client.realtime.stt({
                model: "stt-rt-v4",
                audio_format: "mulaw", // Telnyx sends raw headerless µ-law audio
                sample_rate: 8000,     // Telnyx standard sample rate
                num_channels: 1,
                // Add Hinglish support by prioritizing Hindi and English
                language_hints: ["hi", "en"],
                enable_language_identification: true,
                enable_endpoint_detection: true
            });

            console.log('Soniox connection opened. Waiting for Telnyx audio...');
            await session.connect();

            let lastFinalTokensCount = 0; // Track how many final tokens we've already processed
            let lastOutputLength = 0;     // Track the length of the string printed to console to overwrite it

            session.on("result", (result) => {
                let currentStr = "";
                let newFinalTokensStr = "";

                for (let i = 0; i < result.tokens.length; i++) {
                    const token = result.tokens[i];
                    currentStr += token.text;

                    // If it's a new final token we haven't processed yet
                    if (token.is_final && i >= lastFinalTokensCount) {
                        newFinalTokensStr += token.text;
                        sentenceBuffer += token.text;
                        lastFinalTokensCount++;

                        // Trigger LLM pipeline when a sentence finishes (punctuation)
                        if (token.text.match(/[.!?]/)) {
                            // Clear current line, print the final sentence + punctuation trigger
                            process.stdout.write('\r' + ' '.repeat(lastOutputLength) + '\r');
                            process.stdout.write(currentStr + ' ..... \n');

                            if (sentenceBuffer.trim().length > 0) {
                                processUtterance(call_control_id, sentenceBuffer.trim(), activeCalls);
                                sentenceBuffer = "";
                            }
                            // Reset tracking for the next sentence
                            currentStr = "";
                            lastOutputLength = 0;
                            lastFinalTokensCount = 0;
                            return; // Wait for next result payload
                        }
                    }
                }

                if (currentStr.length > 0) {
                    process.stdout.write('\r' + ' '.repeat(lastOutputLength) + '\r');
                    process.stdout.write(currentStr);
                    lastOutputLength = currentStr.length;
                }
            });

            session.on("error", (err) => {
                console.error("\nSoniox WS Error:", err.message || err);
            });

        } catch (err) {
            console.error("Soniox setup failed:", err);
            return;
        }

        ws.on('message', (msg) => {
            try {
                const data = JSON.parse(msg);
                if (data.event === 'media' && data.media?.payload) {
                    const audio = Buffer.from(data.media.payload, 'base64');
                    // Send directly to Soniox bypassing Node streams for zero latency
                    if (session && typeof session.sendAudio === 'function') {
                        // Suppress state errors if Soniox disconnects early
                        try {
                            session.sendAudio(audio);
                        } catch (e) { }
                    }
                }
            } catch (e) {
                // ignore non-JSON control messages
            }
        });

        ws.on('close', () => {
            console.log('\nTelnyx WebSocket connection closed.');
            if (sentenceBuffer.trim().length > 0) {
                process.stdout.write(' ..... \n');
                processUtterance(call_control_id, sentenceBuffer.trim(), activeCalls);
            }
            if (session && typeof session.close === 'function') {
                session.close();
            }
        });
    });
}

module.exports = { setupSonioxWebSocket };
