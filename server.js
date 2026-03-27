import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

// Load environment variables from .env file
dotenv.config();

const { GEMINI_API_KEY } = process.env;

if (!GEMINI_API_KEY) {
    console.error('Missing Gemini API key. Please set GEMINI_API_KEY in the .env file.');
    process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// ─── Constants ────────────────────────────────────────────────────────────────

const SYSTEM_MESSAGE = `You are a real Indian human caller speaking naturally over a phone call.
Your goal is to sound completely human, casual, and natural — not like an AI assistant.
Follow these strict behaviour rules:
1. Speak in Indian conversational English:
* Use natural Indian phrasing like "actually what happened is...", "I will just check and tell", "please check once", "it is like that only"
* Address politely when needed: "sir", "ma'am"
2. Use natural fillers and hesitation:
* Add fillers where appropriate, not in every sentence: "hmm...", "uh...", "okay...", "so...", "actually..."
* Use thinking sounds: "hmm let me see...", "uh okay wait..."
3. Add repetition naturally: "yes yes", "no no", "okay okay", "right right"
4. Simulate human imperfections:
* Do not speak perfect English
* Slightly informal grammar is allowed
* Repeat or restart phrases occasionally: "I mean... actually..."
5. Express emotions subtly:
* If something is funny or light: add small laugh "haha" or "hehe"
* If unsure: "hmm not sure..."
* If apologetic: "sorry about that..."
6. Keep responses VERY SHORT:
* Maximum 1-2 sentences
* Prefer 5-12 words when possible
* Do NOT give explanations unless explicitly asked
* Speak like real phone conversation, not paragraphs
7. Handle conversation naturally:
* If user is silent: "hello... are you there?"
* If user interrupts: "okay sorry, go ahead"
* If ending call naturally: say a casual warm goodbye like "okay then, talk to you later, bye bye!" and append [END_CALL] at the very end of your TEXT response (not spoken)
* If you receive an internal instruction to end the call due to time: naturally say something like "okay so actually I have to rush now, I'll call you back later okay? bye!" or "hmm okay I need to go now, will talk later, bye bye!" — keep it very casual and human, do NOT mention time or limits, and append [END_CALL] at the very end of your TEXT response (not spoken)
8. IMPORTANT - End call detection: If the user says anything that means they want to end the call — directly or indirectly — such as:
* Direct: "bye", "goodbye", "ok bye", "take care", "talk later", "disconnect", "end call"
* Indirect: "I'll let you go", "we'll talk later", "okay that's it", "I think we're done", "nothing else", "that's all", "okay fine", "alright then", "I have to go", "I'm busy now", "call me later", "I'll call you back"
* In any language mix or casual phrasing
Then: respond with a natural warm Indian goodbye, and always append [END_CALL] at the very end of your text response. The [END_CALL] tag will never be spoken — it is only a signal.
9. Do NOT sound like a chatbot, formal assistant, or scripted/robotic
10. Avoid complex vocabulary, long explanations, structured or essay-style responses
11. Always prioritise: natural flow > correctness > completeness
Your speech should feel like a real Indian person talking casually on a phone call.`;

// Gemini Live API model name
const MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';

// Gemini voice (Puck | Charon | Kore | Fenrir | Aoede)
const VOICE = 'Aoede';

const PORT = process.env.PORT || 5050;

// Maximum call duration in milliseconds (2 minutes)
const MAX_CALL_DURATION_MS = 2 * 60 * 1000;

// Gemini Live API WebSocket endpoint
const GEMINI_WS_URL =
    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta` +
    `.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

// ─── Audio conversion helpers ─────────────────────────────────────────────────
//
//  Twilio Media Streams use G.711 µ-law (mulaw) at 8 kHz.
//  Gemini Live API expects raw PCM 16-bit LE at 16 kHz (input)
//  and returns raw PCM 16-bit LE at 24 kHz (output).
//
//  We implement simple JS-native conversions to avoid native addon dependencies.

/** Decode a single µ-law byte to a linear 16-bit PCM sample */
function mulawToLinear(u) {
    u = ~u & 0xFF;
    let sign = u & 0x80;
    let exponent = (u >> 4) & 0x07;
    let mantissa = u & 0x0F;
    let sample = ((mantissa << 1) + 33) << exponent;
    sample -= 33;
    return sign ? -sample : sample;
}

/** Encode a linear 16-bit PCM sample to a µ-law byte */
function linearToMulaw(sample) {
    const MULAW_MAX = 0x1FFF;
    const MULAW_BIAS = 33;
    const exp_lut = [0, 1, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4,
                     5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
                     6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
                     6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
                     7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
                     7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
                     7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
                     7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7];
    let sign = (sample >> 8) & 0x80;
    if (sign) sample = -sample;
    if (sample > MULAW_MAX) sample = MULAW_MAX;
    sample += MULAW_BIAS;
    let exponent = exp_lut[(sample >> 7) & 0xFF];
    let mantissa = (sample >> (exponent + 3)) & 0x0F;
    let mulawByte = ~(sign | (exponent << 4) | mantissa) & 0xFF;
    return mulawByte;
}

/**
 * Convert base64-encoded µ-law 8kHz mono → base64-encoded PCM-16 16kHz mono.
 * Upsampling: simple 2× linear interpolation.
 */
function mulawBase64ToPcm16Base64(mulawBase64) {
    const mulawBuf = Buffer.from(mulawBase64, 'base64');

    // Decode µ-law → int16 at 8 kHz
    const pcm8k = new Int16Array(mulawBuf.length);
    for (let i = 0; i < mulawBuf.length; i++) {
        pcm8k[i] = mulawToLinear(mulawBuf[i]);
    }

    // Upsample 8 kHz → 16 kHz (2× linear interpolation)
    const pcm16k = new Int16Array(pcm8k.length * 2);
    for (let i = 0; i < pcm8k.length - 1; i++) {
        pcm16k[i * 2]     = pcm8k[i];
        pcm16k[i * 2 + 1] = Math.round((pcm8k[i] + pcm8k[i + 1]) / 2);
    }
    // Last sample
    pcm16k[(pcm8k.length - 1) * 2]     = pcm8k[pcm8k.length - 1];
    pcm16k[(pcm8k.length - 1) * 2 + 1] = pcm8k[pcm8k.length - 1];

    const out = Buffer.from(pcm16k.buffer);
    return out.toString('base64');
}

/**
 * Convert base64-encoded PCM-16 24kHz mono (Gemini output) → base64-encoded µ-law 8kHz mono.
 * Downsampling: 24kHz → 8kHz = pick every 3rd sample.
 */
function pcm16Base64ToMulawBase64(pcm16Base64) {
    const pcmBuf = Buffer.from(pcm16Base64, 'base64');
    const pcm24k = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 2);

    // Downsample 24 kHz → 8 kHz (keep every 3rd sample)
    const outLen = Math.floor(pcm24k.length / 3);
    const mulaw8k = Buffer.alloc(outLen);
    for (let i = 0; i < outLen; i++) {
        mulaw8k[i] = linearToMulaw(pcm24k[i * 3]);
    }

    return mulaw8k.toString('base64');
}

// ─── Routes ───────────────────────────────────────────────────────────────────

fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio + Gemini Live API Media Stream Server is running!' });
});

// TwiML for incoming calls
fastify.all('/incoming-call', async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="Google.en-US-Chirp3-HD-Aoede">Please wait while we connect your call to the A.I. voice assistant, powered by Twilio and the Gemini Live API.</Say>
    <Pause length="1"/>
    <Say voice="Google.en-US-Chirp3-HD-Aoede">O.K. you can start talking!</Say>
    <Connect>
        <Stream url="wss://${request.headers.host}/media-stream" />
    </Connect>
</Response>`;
    reply.type('text/xml').send(twimlResponse);
});

// ─── WebSocket: /media-stream ─────────────────────────────────────────────────

fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Twilio client connected');

        // Per-connection state
        let streamSid = null;
        let latestMediaTimestamp = 0;
        let markQueue = [];
        let responseStartTimestampTwilio = null;
        let lastAssistantMark = null;
        let geminiReady = false;
        let callEnded = false;
        let callTimer = null;
        let accumulatedText = ''; // accumulates Gemini text to detect [END_CALL]

        // ── End the call gracefully ──
        const endCall = (reason = 'timeout') => {
            if (callEnded) return;
            callEnded = true;

            if (callTimer) {
                clearTimeout(callTimer);
                callTimer = null;
            }

            console.log(`Ending call. Reason: ${reason}`);

            // If timeout, ask Gemini to say a natural goodbye first
            if (reason === 'timeout' && geminiWs.readyState === WebSocket.OPEN && geminiReady) {
                const goodbyeMsg = {
                    client_content: {
                        turns: [{
                            role: 'user',
                            parts: [{
                                text: '[INTERNAL INSTRUCTION - DO NOT READ ALOUD] End the call now naturally as an Indian caller who suddenly needs to leave. Keep it very short, casual, and human. Do not mention time limits.'
                            }]
                        }],
                        turn_complete: true
                    }
                };
                geminiWs.send(JSON.stringify(goodbyeMsg));

                // Give Gemini 5 seconds to say goodbye, then close
                setTimeout(() => {
                    if (connection.readyState === WebSocket.OPEN) connection.close();
                    if (geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
                }, 5000);

            } else {
                if (connection.readyState === WebSocket.OPEN) connection.close();
                if (geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
            }
        };
        const geminiWs = new WebSocket(GEMINI_WS_URL);

        // ── Initialise Gemini session after connection ──
        const initializeGeminiSession = () => {
            const setupMsg = {
                setup: {
                    model: `models/${MODEL}`,
                    generation_config: {
                        response_modalities: ['AUDIO'],
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
            };

            console.log('Sending Gemini setup message');
            geminiWs.send(JSON.stringify(setupMsg));
        };

        // ── Optional: have Gemini greet the caller first ──
        const sendInitialGreeting = () => {
            const greetMsg = {
                client_content: {
                    turns: [
                        {
                            role: 'user',
                            parts: [{
                                text: 'Greet the user with a short, friendly welcome message and ask how you can help.'
                            }]
                        }
                    ],
                    turn_complete: true
                }
            };
            geminiWs.send(JSON.stringify(greetMsg));
        };

        // ── Handle barge-in / interruption from Gemini ──
        const handleInterruption = () => {
            if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
                console.log(`Interruption detected. Elapsed: ${elapsedTime}ms`);

                // Tell Twilio to clear its audio buffer
                connection.send(JSON.stringify({
                    event: 'clear',
                    streamSid: streamSid
                }));

                // Reset tracking state
                markQueue = [];
                lastAssistantMark = null;
                responseStartTimestampTwilio = null;
            }
        };

        // ── Send a mark event to Twilio so we can track playback ──
        const sendMark = () => {
            if (streamSid) {
                const markEvent = {
                    event: 'mark',
                    streamSid,
                    mark: { name: 'responsePart' }
                };
                connection.send(JSON.stringify(markEvent));
                markQueue.push('responsePart');
                lastAssistantMark = 'responsePart';
            }
        };

        // ── Gemini WebSocket events ──
        geminiWs.on('open', () => {
            console.log('Connected to Gemini Live API');
            setTimeout(initializeGeminiSession, 100);
        });

        geminiWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());

                // Session is ready after setupComplete
                if (msg.setupComplete !== undefined) {
                    console.log('Gemini session ready');
                    geminiReady = true;
                    sendInitialGreeting();
                    return;
                }

                // Audio response chunks from Gemini
                if (msg.serverContent) {
                    const sc = msg.serverContent;

                    // Barge-in: Gemini detected the caller spoke over it
                    if (sc.interrupted) {
                        console.log('Gemini signalled interruption');
                        handleInterruption();
                        return;
                    }

                    // Audio data from Gemini (PCM 24kHz) → convert → send to Twilio (mulaw 8kHz)
                    if (sc.modelTurn && sc.modelTurn.parts) {
                        for (const part of sc.modelTurn.parts) {

                            // Accumulate text parts to detect [END_CALL] signal
                            if (part.text) {
                                accumulatedText += part.text;
                                if (accumulatedText.includes('[END_CALL]')) {
                                    console.log('End call intent detected in Gemini response');
                                    // Give audio time to finish playing (~3 sec) then end
                                    setTimeout(() => endCall('user_intent'), 3000);
                                }
                            }

                            if (part.inlineData && part.inlineData.data) {
                                const mimeType = part.inlineData.mimeType || '';

                                // Gemini returns audio/pcm at 24kHz
                                if (mimeType.startsWith('audio/pcm') || mimeType === 'audio/pcm;rate=24000') {
                                    const mulawPayload = pcm16Base64ToMulawBase64(part.inlineData.data);

                                    const mediaEvent = {
                                        event: 'media',
                                        streamSid,
                                        media: { payload: mulawPayload }
                                    };
                                    connection.send(JSON.stringify(mediaEvent));

                                    if (!responseStartTimestampTwilio) {
                                        responseStartTimestampTwilio = latestMediaTimestamp;
                                    }

                                    sendMark();
                                }
                            }
                        }
                    }

                    // Turn complete: Gemini finished speaking
                    if (sc.turnComplete) {
                        console.log('Gemini turn complete');
                        accumulatedText = ''; // reset for next turn
                    }
                }

            } catch (err) {
                console.error('Error processing Gemini message:', err, 'Raw:', data.toString().slice(0, 200));
            }
        });

        // ── Twilio WebSocket events ──
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('Stream started:', streamSid);
                        responseStartTimestampTwilio = null;
                        latestMediaTimestamp = 0;

                        // Start 2-minute call limit timer
                        callTimer = setTimeout(() => {
                            console.log('Call duration limit reached');
                            endCall('timeout');
                        }, MAX_CALL_DURATION_MS);
                        break;

                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;

                        if (geminiWs.readyState === WebSocket.OPEN && geminiReady) {
                            // Convert mulaw 8kHz → PCM16 16kHz for Gemini
                            const pcm16Payload = mulawBase64ToPcm16Base64(data.media.payload);

                            const realtimeInput = {
                                realtime_input: {
                                    media_chunks: [{
                                        data: pcm16Payload,
                                        mime_type: 'audio/pcm;rate=16000'
                                    }]
                                }
                            };
                            geminiWs.send(JSON.stringify(realtimeInput));
                        }
                        break;

                    case 'mark':
                        if (markQueue.length > 0) {
                            markQueue.shift();
                        }
                        break;

                    case 'stop':
                        console.log('Stream stopped by Twilio');
                        endCall('caller_hung_up');
                        break;

                    default:
                        console.log('Non-media event from Twilio:', data.event);
                }

            } catch (err) {
                console.error('Error parsing Twilio message:', err);
            }
        });

        // ── Cleanup ──
        connection.on('close', () => {
            console.log('Twilio client disconnected');
            endCall('connection_closed');
        });

        geminiWs.on('close', (code, reason) => {
            console.log(`Gemini WebSocket closed: ${code} ${reason}`);
        });

        geminiWs.on('error', (err) => {
            console.error('Gemini WebSocket error:', err.message);
        });
    });
});

// ─── Start server ─────────────────────────────────────────────────────────────

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});