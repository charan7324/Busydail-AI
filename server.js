import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

dotenv.config();

const { GEMINI_API_KEY } = process.env;

if (!GEMINI_API_KEY) {
    console.error('Missing Gemini API key');
    process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const VOICE = 'Aoede';
const PORT = process.env.PORT || 5050;

const GEMINI_WS_URL =
`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const SYSTEM_MESSAGE = 'You are a voice assistant. Keep responses short.';

/* ---------------- SAFE WS HELPERS ---------------- */

function waitForOpen(ws) {
    return new Promise((resolve) => {
        if (ws.readyState === WebSocket.OPEN) return resolve();
        ws.on('open', resolve);
    });
}

async function safeSend(ws, data) {
    if (ws.readyState !== WebSocket.OPEN) {
        await waitForOpen(ws);
    }
    ws.send(JSON.stringify(data));
}

/* ---------------- AUDIO ---------------- */

function mulawToLinear(u) {
    u = ~u & 0xFF;
    let sign = u & 0x80;
    let exponent = (u >> 4) & 0x07;
    let mantissa = u & 0x0F;
    let sample = ((mantissa << 1) + 33) << exponent;
    sample -= 33;
    return sign ? -sample : sample;
}

function linearToMulaw(sample) {
    const MULAW_MAX = 0x1FFF;
    const MULAW_BIAS = 33;

    let sign = (sample >> 8) & 0x80;
    if (sign) sample = -sample;
    if (sample > MULAW_MAX) sample = MULAW_MAX;

    sample += MULAW_BIAS;

    let exponent = Math.floor(Math.log2(sample)) - 5;
    exponent = Math.max(0, Math.min(7, exponent));

    let mantissa = (sample >> (exponent + 3)) & 0x0F;

    return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

function mulawToPCM16(base64) {
    const buf = Buffer.from(base64, 'base64');
    const pcm = new Int16Array(buf.length);

    for (let i = 0; i < buf.length; i++) {
        pcm[i] = mulawToLinear(buf[i]);
    }

    const upsampled = new Int16Array(pcm.length * 2);

    for (let i = 0; i < pcm.length - 1; i++) {
        upsampled[i * 2] = pcm[i];
        upsampled[i * 2 + 1] = (pcm[i] + pcm[i + 1]) / 2;
    }

    return Buffer.from(upsampled.buffer).toString('base64');
}

function pcmToMulaw(base64) {
    const buf = Buffer.from(base64, 'base64');
    const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);

    const down = Buffer.alloc(Math.floor(pcm.length / 3));

    for (let i = 0; i < down.length; i++) {
        down[i] = linearToMulaw(pcm[i * 3]);
    }

    return down.toString('base64');
}

/* ---------------- ROUTES ---------------- */

fastify.get('/', async (_, reply) => {
    reply.send({ status: 'running' });
});

fastify.all('/incoming-call', async (req, reply) => {
    reply.type('text/xml').send(`<?xml version="1.0"?>
<Response>
<Connect>
<Stream url="wss://${req.headers.host}/media-stream"/>
</Connect>
</Response>`);
});

/* ---------------- WS ---------------- */

fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection) => {

        let streamSid = null;
        let geminiReady = false;
        let transcript = [];
        let lastSpeechTime = Date.now();
        let callStart = Date.now();
        let ending = false;

        const geminiWs = new WebSocket(GEMINI_WS_URL);

        /* ---------- INIT ---------- */

        geminiWs.on('open', async () => {
            await safeSend(geminiWs, {
                setup: {
                    model: `models/${MODEL}`,
                    generation_config: {
                        response_modalities: ['AUDIO', 'TEXT'],
                        speech_config: {
                            voice_config: {
                                prebuilt_voice_config: { voice_name: VOICE }
                            }
                        }
                    },
                    system_instruction: {
                        parts: [{ text: SYSTEM_MESSAGE }]
                    }
                }
            });
        });

        geminiWs.on('message', (data) => {
            const msg = JSON.parse(data.toString());

            if (msg.setupComplete !== undefined) {
                geminiReady = true;
                return;
            }

            const sc = msg.serverContent;
            if (!sc) return;

            if (sc.modelTurn?.parts) {
                for (const part of sc.modelTurn.parts) {

                    if (part.text) {
                        console.log('AI:', part.text);
                    }

                    if (part.inlineData?.data) {
                        const mulaw = pcmToMulaw(part.inlineData.data);

                        connection.send(JSON.stringify({
                            event: 'media',
                            streamSid,
                            media: { payload: mulaw }
                        }));
                    }
                }
            }
        });

        /* ---------- INTENT DETECTION ---------- */

        async function checkEndIntent(text) {
            const tempWs = new WebSocket(GEMINI_WS_URL);
            await waitForOpen(tempWs);

            await safeSend(tempWs, {
                setup: { model: "models/gemini-2.0-flash" }
            });

            await safeSend(tempWs, {
                client_content: {
                    turns: [{
                        role: "user",
                        parts: [{
                            text: `User said: "${text}". Is the user ending the conversation? Answer YES or NO.`
                        }]
                    }],
                    turn_complete: true
                }
            });

            return new Promise((resolve) => {
                tempWs.on('message', (d) => {
                    const m = JSON.parse(d.toString());
                    if (m.serverContent?.modelTurn?.parts) {
                        const txt = m.serverContent.modelTurn.parts[0]?.text || '';
                        resolve(txt.toLowerCase().includes('yes'));
                        tempWs.close();
                    }
                });
            });
        }

        /* ---------- SUMMARY ---------- */

        async function generateSummary() {
            const tempWs = new WebSocket(GEMINI_WS_URL);
            await waitForOpen(tempWs);

            await safeSend(tempWs, {
                setup: { model: "models/gemini-2.0-flash" }
            });

            await safeSend(tempWs, {
                client_content: {
                    turns: [{
                        role: "user",
                        parts: [{
                            text: `Summarize this conversation:\n${transcript.join('\n')}`
                        }]
                    }],
                    turn_complete: true
                }
            });

            return new Promise((resolve) => {
                tempWs.on('message', (d) => {
                    const m = JSON.parse(d.toString());
                    if (m.serverContent?.modelTurn?.parts) {
                        console.log('\n📊 SUMMARY:\n', m.serverContent.modelTurn.parts[0]?.text);
                        resolve();
                        tempWs.close();
                    }
                });
            });
        }

        /* ---------- TWILIO ---------- */

        connection.on('message', async (message) => {
            const data = JSON.parse(message);

            switch (data.event) {

                case 'start':
                    streamSid = data.start.streamSid;
                    break;

                case 'media':

                    if (ending) return;

                    if (Date.now() - callStart > 120000) {
                        ending = true;
                        await generateSummary();
                        connection.close();
                        return;
                    }

                    lastSpeechTime = Date.now();

                    const pcm = mulawToPCM16(data.media.payload);

                    if (geminiReady) {
                        await safeSend(geminiWs, {
                            realtime_input: {
                                media_chunks: [{
                                    data: pcm,
                                    mime_type: 'audio/pcm;rate=16000'
                                }]
                            }
                        });
                    }

                    break;
            }
        });

        /* ---------- SILENCE ---------- */

        const interval = setInterval(async () => {
            if (ending) return;

            if (Date.now() - lastSpeechTime > 8000) {
                ending = true;
                await generateSummary();
                connection.close();
            }
        }, 2000);

        connection.on('close', () => {
            clearInterval(interval);
            if (geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
        });
    });
});

/* ---------------- START ---------------- */

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log('Server running on', PORT);
});