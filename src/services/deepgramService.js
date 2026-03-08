const WebSocket = require('ws');

function setupDeepgramWebSocket(server) {
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
            '&smart_format=true',     // Cleans up punctuation and numbers
            '&dictation=true',        // Ignores background noise to focus on spoken words
            '&filler_words=false'     // Don't transcribe "um", "uh", or background hums
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
}

module.exports = { setupDeepgramWebSocket };
