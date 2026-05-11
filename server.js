import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import { createClient } from '@supabase/supabase-js';
import { spawn } from 'child_process';

dotenv.config();

const {
    GEMINI_API_KEY,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_PHONE_NUMBER,
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY
} = process.env;

if (!GEMINI_API_KEY) { console.error('Missing GEMINI_API_KEY'); process.exit(1); }
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) { console.error('Missing Twilio credentials'); process.exit(1); }
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) { console.error('Missing Supabase credentials'); process.exit(1); }

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

fastify.addHook('onRequest', (request, reply, done) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (request.method === 'OPTIONS') { reply.code(200).send(); return; }
    done();
});

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

const MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const VOICE = 'Aoede';
const PORT = process.env.PORT || 5050;
const MAX_CALL_DURATION_MS = 2 * 60 * 1000;

const GEMINI_WS_URL =
    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta` +
    `.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

// ─── Background Sound URLs ────────────────────────────────────────────────────

const BACKGROUND_SOUND_URLS = {
    office:      `https://atauxjrnhbobpelsiggj.supabase.co/storage/v1/object/public/sounds%20bucket/office.mp3`,
    call_center: `https://atauxjrnhbobpelsiggj.supabase.co/storage/v1/object/public/sounds%20bucket/call_center.mp3`,
    traffic:     `https://atauxjrnhbobpelsiggj.supabase.co/storage/v1/object/public/sounds%20bucket/traffic.mp3`,
    nature:      `https://atauxjrnhbobpelsiggj.supabase.co/storage/v1/object/public/sounds%20bucket/nature.mp3`,
    cafe:        `https://atauxjrnhbobpelsiggj.supabase.co/storage/v1/object/public/sounds%20bucket/cafe.mp3`,
    rain:        `https://atauxjrnhbobpelsiggj.supabase.co/storage/v1/object/public/sounds%20bucket/rain.mp3`,
};

const soundCache = {};

// ─── Filler words by language ─────────────────────────────────────────────────
// These are sent to Gemini to speak during silence gaps to feel natural
const FILLER_PHRASES = {
    english:  ['hmm...', 'uh...', 'okay...', 'so...', 'right...', 'let me see...', 'one moment...'],
    hindi:    ['hmm...', 'haan...', 'achha...', 'theek hai...', 'ek second...', 'sun raha hoon...'],
    hinglish: ['hmm...', 'haan okay...', 'achha so...', 'ek second...', 'theek hai...', 'okay so...'],
    telugu:   ['hmm...', 'okay...', 'oka second...', 'chustha...', 'aaa...', 'sare...'],
    tamil:    ['hmm...', 'okay...', 'oru nimisham...', 'sari...', 'aama...', 'paakiren...'],
    kannada:  ['hmm...', 'okay...', 'ondu nimisha...', 'sari...', 'nodthini...', 'hauda...'],
};

// ─── Audio conversion helpers ─────────────────────────────────────────────────

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
    const exp_lut = [0,1,2,2,3,3,3,3,4,4,4,4,4,4,4,4,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,
                     6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
                     7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
                     7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7];
    let sign = (sample >> 8) & 0x80;
    if (sign) sample = -sample;
    if (sample > MULAW_MAX) sample = MULAW_MAX;
    sample += MULAW_BIAS;
    let exponent = exp_lut[(sample >> 7) & 0xFF];
    let mantissa = (sample >> (exponent + 3)) & 0x0F;
    return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

function mulawBase64ToPcm16Base64(mulawBase64) {
    const mulawBuf = Buffer.from(mulawBase64, 'base64');
    const pcm8k = new Int16Array(mulawBuf.length);
    for (let i = 0; i < mulawBuf.length; i++) pcm8k[i] = mulawToLinear(mulawBuf[i]);
    const pcm16k = new Int16Array(pcm8k.length * 2);
    for (let i = 0; i < pcm8k.length - 1; i++) {
        pcm16k[i * 2]     = pcm8k[i];
        pcm16k[i * 2 + 1] = Math.round((pcm8k[i] + pcm8k[i + 1]) / 2);
    }
    pcm16k[(pcm8k.length - 1) * 2]     = pcm8k[pcm8k.length - 1];
    pcm16k[(pcm8k.length - 1) * 2 + 1] = pcm8k[pcm8k.length - 1];
    return Buffer.from(pcm16k.buffer).toString('base64');
}

function pcm16Base64ToMulawBase64(pcm16Base64) {
    const pcmBuf = Buffer.from(pcm16Base64, 'base64');
    const pcm24k = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 2);
    const outLen = Math.floor(pcm24k.length / 3);
    const mulaw8k = Buffer.alloc(outLen);
    for (let i = 0; i < outLen; i++) mulaw8k[i] = linearToMulaw(pcm24k[i * 3]);
    return mulaw8k.toString('base64');
}

// ─── Background Sound helpers ─────────────────────────────────────────────────

function convertAudioToPcm24k(inputBuffer) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const ff = spawn('ffmpeg', [
            '-i', 'pipe:0',
            '-f', 's16le',
            '-ar', '24000',
            '-ac', '1',
            '-loglevel', 'quiet',
            'pipe:1'
        ]);
        ff.stdout.on('data', chunk => chunks.push(chunk));
        ff.stdout.on('end', () => {
            const pcmBuf = Buffer.concat(chunks);
            resolve(new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 2));
        });
        ff.stderr.on('data', () => {});
        ff.on('error', (err) => reject(new Error(`ffmpeg error: ${err.message}`)));
        ff.stdin.on('error', () => {});
        ff.stdin.write(inputBuffer);
        ff.stdin.end();
    });
}

async function loadSoundPCM(soundId) {
    if (soundCache[soundId]) { console.log(`Sound cache hit: ${soundId}`); return soundCache[soundId]; }
    const url = BACKGROUND_SOUND_URLS[soundId];
    if (!url) { console.log(`Unknown sound id: ${soundId}`); return null; }
    try {
        console.log(`Fetching background sound: ${soundId}`);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const audioBuffer = Buffer.from(await response.arrayBuffer());
        const pcmSamples = await convertAudioToPcm24k(audioBuffer);
        soundCache[soundId] = pcmSamples;
        console.log(`Sound decoded & cached: ${soundId} — ${pcmSamples.length} samples`);
        return pcmSamples;
    } catch (err) {
        console.error(`Failed to load sound ${soundId}:`, err.message);
        return null;
    }
}

function mixSoundIntoAudio(geminiPcm, soundSamples, soundOffset, volumePct) {
    if (!soundSamples || soundSamples.length === 0) return { mixed: geminiPcm, newOffset: soundOffset };
    const vol = Math.max(0, Math.min(100, volumePct)) / 100;
    const mixed = new Int16Array(geminiPcm.length);
    let offset = soundOffset;
    for (let i = 0; i < geminiPcm.length; i++) {
        const bgSample = soundSamples[offset % soundSamples.length];
        const mixedVal = geminiPcm[i] + Math.round(bgSample * vol);
        mixed[i] = Math.max(-32768, Math.min(32767, mixedVal));
        offset++;
    }
    return { mixed, newOffset: offset };
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────

async function createCallRecord({ businessId, contactId, direction, twilioCallSid }) {
    const { data, error } = await supabase.from('calls').insert({
        business_id: businessId || null,
        contact_id: contactId || null,
        direction,
        status: 'in-progress',
        twilio_call_sid: twilioCallSid || null,
        started_at: new Date().toISOString()
    }).select().single();
    if (error) { console.error('Error creating call record:', error.message); return null; }
    console.log(`Call record created: ${data.id}`);
    return data.id;
}

async function updateCallRecord(callId, { status, callerTranscript, geminiTranscript, durationSeconds, summary }) {
    if (!callId) return;
    const { error } = await supabase.from('calls').update({
        status,
        caller_transcript: callerTranscript || null,
        gemini_transcript: geminiTranscript || null,
        duration_seconds: durationSeconds || 0,
        summary: summary || null,
        ended_at: new Date().toISOString()
    }).eq('id', callId);
    if (error) console.error('Error updating call record:', error.message);
    else console.log(`Call record updated: ${callId} — ${status}`);
}

async function incrementBusinessCallCount(businessId) {
    if (!businessId) return;
    const { error } = await supabase.rpc('increment_calls_used', { business_id_input: businessId });
    if (error) console.error('Error incrementing call count:', error.message);
}

async function checkCallLimit(businessId) {
    if (!businessId) return true;
    const { data, error } = await supabase.from('businesses').select('plan, calls_used_this_month').eq('id', businessId).single();
    if (error || !data) return true;
    const limits = { free: 50, starter: 500, pro: 2000, enterprise: Infinity };
    if (data.calls_used_this_month >= (limits[data.plan] || 50)) {
        console.log(`Business ${businessId} reached ${data.plan} plan limit`);
        return false;
    }
    return true;
}

async function getAgentById(agentId) {
    if (!agentId) return null;
    const { data, error } = await supabase.from('agents').select('*').eq('id', agentId).single();
    if (error) { console.error('Error fetching agent:', error.message); return null; }
    return data;
}

async function generateCallSummary(callerTranscript, geminiTranscript) {
    if (!callerTranscript && !geminiTranscript) { console.log('No transcript to summarize'); return null; }
    try {
        const fullTranscript = [callerTranscript, geminiTranscript].filter(Boolean).join('\n').trim();
        console.log('Transcript length for summary:', fullTranscript.length, 'chars');
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: `Summarize this phone call in 3-4 bullet points. Cover what was discussed, decisions made, and next steps. Be concise and professional. Only return bullet points, no intro text.\n\nTranscript:\n${fullTranscript}` }] }],
                    generationConfig: { maxOutputTokens: 300, temperature: 0.2 }
                })
            }
        );
        const responseText = await response.text();
        const data = JSON.parse(responseText);
        if (data.error) { console.error('Gemini summary API error:', data.error.message); return null; }
        const summary = data.candidates?.[0]?.content?.parts?.[0]?.text;
        console.log('Summary result:', summary ? summary.slice(0, 100) + '...' : 'NULL');
        return summary || null;
    } catch (err) {
        console.error('Summary generation failed:', err.message);
        return null;
    }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio + Gemini Live API Media Stream Server is running!' });
});

fastify.all('/incoming-call', async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="wss://${request.headers.host}/media-stream">
            <Parameter name="businessId" value="${request.query.businessId || ''}" />
            <Parameter name="contactId" value="${request.query.contactId || ''}" />
            <Parameter name="direction" value="${request.query.direction || 'inbound'}" />
            <Parameter name="agentId" value="${request.query.agentId || ''}" />
        </Stream>
    </Connect>
</Response>`;
    reply.type('text/xml').send(twimlResponse);
});

fastify.post('/make-call', async (request, reply) => {
    const { to, businessId, contactId, agentId } = request.body;
    if (!to) return reply.status(400).send({ error: 'Missing "to" phone number' });
    const withinLimit = await checkCallLimit(businessId);
    if (!withinLimit) return reply.status(403).send({ error: 'Monthly call limit reached. Please upgrade your plan.' });
    try {
        const credentials = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
        const webhookUrl = new URL(`https://${request.headers.host}/incoming-call`);
        if (businessId) webhookUrl.searchParams.set('businessId', businessId);
        if (contactId) webhookUrl.searchParams.set('contactId', contactId);
        if (agentId) webhookUrl.searchParams.set('agentId', agentId);
        webhookUrl.searchParams.set('direction', 'outbound');
        const response = await fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`,
            {
                method: 'POST',
                headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ To: to, From: TWILIO_PHONE_NUMBER, Url: webhookUrl.toString() }).toString()
            }
        );
        const data = await response.json();
        if (data.sid) {
            console.log(`Outbound call initiated: ${data.sid} → ${to}`);
            reply.send({ success: true, callSid: data.sid, to });
        } else {
            reply.status(500).send({ success: false, error: data.message || 'Failed to initiate call' });
        }
    } catch (err) {
        reply.status(500).send({ success: false, error: err.message });
    }
});

// ─── WebSocket: /media-stream ─────────────────────────────────────────────────

fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Twilio client connected');

        let streamSid = null;
        let latestMediaTimestamp = 0;
        let markQueue = [];
        let responseStartTimestampTwilio = null;
        let lastAssistantMark = null;
        let geminiReady = false;
        let callEnded = false;
        let callTimer = null;
        let accumulatedText = '';
        let agentPromptOverride = null;
        let agentVoiceOverride = null;
        let agentLanguage = 'english';

        // Background sound state
        let soundSamples = null;
        let soundOffset = 0;
        let soundVolume = 30;
        let soundPumpInterval = null;
        let isSpeaking = false;

        // Filler word state
        let silenceTimer = null;           // triggers filler after N seconds of silence
        let fillerSent = false;            // prevent multiple fillers at once
        const FILLER_SILENCE_MS = 2500;    // send filler after 2.5s of silence

        // Call tracking
        let callId = null;
        let businessId = null;
        let contactId = null;
        let direction = 'inbound';
        let callStartTime = null;
        let callerTranscriptParts = [];
        let geminiTranscriptParts = [];

        // ── Continuous background sound pump ──
        const startSoundPump = () => {
            if (!soundSamples || soundPumpInterval) return;
            const CHUNK_24K = 480;  // 20ms at 24kHz
            const CHUNK_8K  = 160;  // 20ms at 8kHz

            soundPumpInterval = setInterval(() => {
                if (!streamSid || callEnded || isSpeaking) return;
                try {
                    const chunk = new Int16Array(CHUNK_24K);
                    const vol = soundVolume / 100;
                    for (let i = 0; i < CHUNK_24K; i++) {
                        chunk[i] = Math.round(soundSamples[soundOffset % soundSamples.length] * vol);
                        soundOffset++;
                    }
                    const mulaw8k = Buffer.alloc(CHUNK_8K);
                    for (let i = 0; i < CHUNK_8K; i++) {
                        mulaw8k[i] = linearToMulaw(Math.max(-32768, Math.min(32767, chunk[i * 3])));
                    }
                    if (connection.readyState === WebSocket.OPEN) {
                        connection.send(JSON.stringify({ event: 'media', streamSid, media: { payload: mulaw8k.toString('base64') } }));
                    }
                } catch (err) {
                    console.error('Sound pump error:', err.message);
                }
            }, 20);
            console.log('Background sound pump started');
        };

        const stopSoundPump = () => {
            if (soundPumpInterval) { clearInterval(soundPumpInterval); soundPumpInterval = null; }
        };

        // ── Filler word helpers ──
        const getRandomFiller = () => {
            const lang = agentLanguage?.toLowerCase() || 'english';
            const phrases = FILLER_PHRASES[lang] || FILLER_PHRASES['english'];
            return phrases[Math.floor(Math.random() * phrases.length)];
        };

        const sendFillerWord = () => {
            if (!geminiReady || callEnded || isSpeaking || fillerSent) return;
            fillerSent = true;
            const filler = getRandomFiller();
            console.log(`Sending filler word: "${filler}"`);
            if (geminiWs.readyState === WebSocket.OPEN) {
                geminiWs.send(JSON.stringify({
                    client_content: {
                        turns: [{
                            role: 'user',
                            parts: [{ text: `[INTERNAL INSTRUCTION - DO NOT REPEAT THIS] Say only this short filler sound naturally as if thinking: "${filler}" — just that, nothing more.` }]
                        }],
                        turn_complete: true
                    }
                }));
            }
        };

        const resetSilenceTimer = () => {
            if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
            fillerSent = false;
        };

        const startSilenceTimer = () => {
            resetSilenceTimer();
            if (!callEnded && geminiReady) {
                silenceTimer = setTimeout(sendFillerWord, FILLER_SILENCE_MS);
            }
        };

        // ── End the call gracefully ──
        const endCall = async (reason = 'timeout') => {
            if (callEnded && reason !== 'timeout' && reason !== 'caller_hung_up') return;
            if (callTimer) { clearTimeout(callTimer); callTimer = null; }
            resetSilenceTimer();
            console.log(`Ending call. Reason: ${reason}`);

            if (reason === 'timeout' && geminiWs.readyState === WebSocket.OPEN && geminiReady) {
                callEnded = true;
                geminiWs.send(JSON.stringify({
                    client_content: {
                        turns: [{ role: 'user', parts: [{ text: '[INTERNAL INSTRUCTION - DO NOT READ ALOUD] End the call now naturally as an Indian caller who suddenly needs to leave. Keep it very short, casual, and human. Do not mention time limits. Append [END_CALL] at the end of your text response.' }] }],
                        turn_complete: true
                    }
                }));
            } else {
                callEnded = true;
                stopSoundPump();
                await saveCallToDatabase(reason);
                if (connection.readyState === WebSocket.OPEN) connection.close();
                if (geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
            }
        };

        const saveCallToDatabase = async (reason) => {
            if (!callId) return;
            const durationSeconds = callStartTime ? Math.floor((Date.now() - callStartTime) / 1000) : 0;
            const callerTranscript = callerTranscriptParts.join('\n') || null;
            const geminiTranscript = geminiTranscriptParts.join('\n') || null;
            console.log('--- SAVING CALL TO DATABASE ---');
            const summary = await generateCallSummary(callerTranscript, geminiTranscript);
            await updateCallRecord(callId, { status: 'completed', callerTranscript, geminiTranscript, durationSeconds, summary });
            await incrementBusinessCallCount(businessId);
            console.log('--- CALL SAVED SUCCESSFULLY ---');
        };

        const geminiWs = new WebSocket(GEMINI_WS_URL);

        const initializeGeminiSession = () => {
            const finalPrompt = agentPromptOverride
                ? `${agentPromptOverride}

Additionally follow these natural conversation rules:
- Use natural fillers: "hmm...", "uh...", "okay...", "actually..."
- Keep responses VERY SHORT — 1-2 sentences max
- If user is silent: "hello... are you there?"
- If user wants to end call: say a warm goodbye and append [END_CALL] at the very end of your text response
- If you receive internal instruction to end due to time: say casual goodbye and append [END_CALL]
- Detect end intent from: "bye", "goodbye", "I'll let you go", "I have to go", "call me later", "we're done", "that's all", "I'm busy" etc.
- The [END_CALL] tag is never spoken — it is only a signal`
                : SYSTEM_MESSAGE;

            const finalVoice = agentVoiceOverride || VOICE;
            geminiWs.send(JSON.stringify({
                setup: {
                    model: `models/${MODEL}`,
                    generation_config: {
                        response_modalities: ['AUDIO'],
                        speech_config: { voice_config: { prebuilt_voice_config: { voice_name: finalVoice } } }
                    },
                    input_audio_transcription: {},
                    output_audio_transcription: {},
                    system_instruction: { parts: [{ text: finalPrompt }] }
                }
            }));
            console.log('Gemini session initialized | Voice:', finalVoice);
        };

        // ── Smart greeting based on call direction and language ──
        const sendInitialGreeting = () => {
            const lang = agentLanguage?.toLowerCase() || 'english';
            let greetInstruction;

            if (direction === 'outbound') {
                // Outbound: agent called the person — introduce yourself and state purpose
                const outboundGreetings = {
                    english:  'You have called this person. Greet them like a real outbound caller — say hello, introduce yourself briefly, and state why you are calling. Keep it short and natural.',
                    hindi:    'Aapne is vyakti ko call kiya hai. Hindi mein naturally greet karo — apna naam batao aur call ka reason batao. Chhota aur natural rakho.',
                    hinglish: 'You have called this person. Greet them in Hinglish — mix Hindi and English naturally, introduce yourself and state why you are calling. Keep it short.',
                    telugu:   'Mీరు ఈ వ్యక్తిని call చేశారు. Telugu లో naturally greet చేయండి — మీ పేరు చెప్పి, call చేసిన కారణం చెప్పండి. చిన్నగా మరియు natural గా ఉండండి.',
                    tamil:    'நீங்கள் இந்த நபரை அழைத்தீர்கள். Tamil இல் இயற்கையாக வாழ்த்துங்கள் — உங்கள் பெயரை சொல்லி, ஏன் அழைத்தீர்கள் என்று சொல்லுங்கள்.',
                    kannada:  'Nೀವು ಈ ವ್ಯಕ್ತಿಗೆ call ಮಾಡಿದ್ದೀರಿ. Kannada ನಲ್ಲಿ naturally greet ಮಾಡಿ — ನಿಮ್ಮ ಹೆಸರು ಹೇಳಿ ಮತ್ತು call ಮಾಡಿದ ಕಾರಣ ಹೇಳಿ.',
                };
                greetInstruction = outboundGreetings[lang] || outboundGreetings['english'];
            } else {
                // Inbound: person called the agent — receive the call warmly
                const inboundGreetings = {
                    english:  'Someone has called you. Answer like a real person receiving an inbound call — say hello warmly, mention your name or company if relevant, and ask how you can help. Keep it natural and short.',
                    hindi:    'Kisi ne aapko call kiya hai. Ek real inbound call ki tarah receive karo — warmly hello bolo, apna naam/company batao aur poochho kaise help kar sakte ho.',
                    hinglish: 'Someone called you. Receive it in Hinglish — say hello warmly mixing Hindi and English, mention who you are, and ask how you can help.',
                    telugu:   'మీకు ఎవరో call చేశారు. Inbound call లా receive చేయండి — warmly hello చెప్పి, మీరు ఎవరో చెప్పి, ఎలా help చేయగలరో అడగండి.',
                    tamil:    'யாரோ உங்களை அழைத்தார்கள். Inbound call போல் பதில் சொல்லுங்கள் — warmly வாழ்த்துங்கள், நீங்கள் யார் என்று சொல்லுங்கள், எப்படி உதவலாம் என்று கேளுங்கள்.',
                    kannada:  'ಯಾರೋ ನಿಮಗೆ call ಮಾಡಿದ್ದಾರೆ. Inbound call ತರಹ receive ಮಾಡಿ — warmly hello ಹೇಳಿ, ನೀವು ಯಾರು ಎಂದು ಹೇಳಿ, ಹೇಗೆ help ಮಾಡಬಹುದು ಎಂದು ಕೇಳಿ.',
                };
                greetInstruction = inboundGreetings[lang] || inboundGreetings['english'];
            }

            console.log(`Sending ${direction} greeting in ${lang}`);
            geminiWs.send(JSON.stringify({
                client_content: {
                    turns: [{ role: 'user', parts: [{ text: greetInstruction }] }],
                    turn_complete: true
                }
            }));
        };

        const handleInterruption = () => {
            if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                console.log(`Interruption detected.`);
                connection.send(JSON.stringify({ event: 'clear', streamSid }));
                markQueue = [];
                lastAssistantMark = null;
                responseStartTimestampTwilio = null;
            }
        };

        const sendMark = () => {
            if (streamSid) {
                connection.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'responsePart' } }));
                markQueue.push('responsePart');
                lastAssistantMark = 'responsePart';
            }
        };

        geminiWs.on('open', () => {
            console.log('Connected to Gemini Live API');
        });

        geminiWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());

                if (msg.setupComplete !== undefined) {
                    console.log('Gemini session ready');
                    geminiReady = true;
                    sendInitialGreeting();
                    // Start silence timer after greeting
                    setTimeout(() => startSilenceTimer(), 3000);
                    return;
                }

                if (msg.serverContent) {
                    const sc = msg.serverContent;

                    if (sc.interrupted) {
                        console.log('Gemini signalled interruption');
                        isSpeaking = false;
                        handleInterruption();
                        startSilenceTimer(); // restart silence detection
                        return;
                    }

                    if (sc.inputTranscription?.text) {
                        const text = sc.inputTranscription.text;
                        console.log(`Caller said: "${text}"`);
                        callerTranscriptParts.push(`Caller: ${text}`);
                        // User spoke — reset silence timer
                        resetSilenceTimer();
                    }

                    if (sc.outputTranscription?.text) {
                        const text = sc.outputTranscription.text;
                        console.log(`Gemini said: "${text}"`);
                        geminiTranscriptParts.push(`AI: ${text}`);
                    }

                    if (sc.modelTurn?.parts) {
                        for (const part of sc.modelTurn.parts) {

                            if (part.text) {
                                accumulatedText += part.text;
                                if (accumulatedText.includes('[END_CALL]')) {
                                    console.log('End call intent detected');
                                    callEnded = true;
                                }
                            }

                            if (part.inlineData?.data) {
                                const mimeType = part.inlineData.mimeType || '';
                                if (mimeType.startsWith('audio/pcm') || mimeType === 'audio/pcm;rate=24000') {
                                    isSpeaking = true;
                                    resetSilenceTimer(); // AI is speaking — no filler needed

                                    let audioBase64 = part.inlineData.data;

                                    // Mix background sound into Gemini audio
                                    if (soundSamples && soundSamples.length > 0) {
                                        try {
                                            const pcmBuf = Buffer.from(audioBase64, 'base64');
                                            const geminiPcm = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 2);
                                            const { mixed, newOffset } = mixSoundIntoAudio(geminiPcm, soundSamples, soundOffset, soundVolume);
                                            soundOffset = newOffset;
                                            audioBase64 = Buffer.from(mixed.buffer).toString('base64');
                                        } catch (mixErr) {
                                            console.error('Sound mixing error:', mixErr.message);
                                        }
                                    }

                                    const mulawPayload = pcm16Base64ToMulawBase64(audioBase64);
                                    connection.send(JSON.stringify({ event: 'media', streamSid, media: { payload: mulawPayload } }));
                                    if (!responseStartTimestampTwilio) responseStartTimestampTwilio = latestMediaTimestamp;
                                    sendMark();
                                }
                            }
                        }
                    }

                    if (sc.turnComplete) {
                        console.log('Gemini turn complete');
                        isSpeaking = false;

                        if (callEnded) {
                            console.log('Goodbye audio finished, saving and ending call');
                            stopSoundPump();
                            resetSilenceTimer();
                            setTimeout(async () => {
                                await saveCallToDatabase('user_intent');
                                if (connection.readyState === WebSocket.OPEN) connection.close();
                                if (geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
                            }, 500);
                        } else {
                            // AI finished speaking — start silence timer for filler words
                            startSilenceTimer();
                        }
                        accumulatedText = '';
                    }
                }

            } catch (err) {
                console.error('Error processing Gemini message:', err, 'Raw:', data.toString().slice(0, 200));
            }
        });

        connection.on('message', async (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'start':
                        streamSid = data.start.streamSid;
                        callStartTime = Date.now();

                        const params = data.start.customParameters || {};
                        businessId = params.businessId || null;
                        contactId = params.contactId || null;
                        direction = params.direction || 'inbound';
                        const agentId = params.agentId || null;

                        if (agentId) {
                            const agent = await getAgentById(agentId);
                            if (agent) {
                                agentPromptOverride = agent.prompt;
                                agentVoiceOverride = agent.voice;
                                agentLanguage = agent.language || 'english';
                                console.log(`Using agent: ${agent.name} | Voice: ${agent.voice} | Language: ${agentLanguage}`);

                                if (agent.background_sound && agent.background_sound !== 'none') {
                                    soundVolume = agent.sound_volume ?? 30;
                                    soundSamples = await loadSoundPCM(agent.background_sound);
                                    if (soundSamples) {
                                        console.log(`Background sound ready: ${agent.background_sound}`);
                                        startSoundPump();
                                    }
                                }
                            }
                        }

                        console.log(`Stream: ${streamSid} | Direction: ${direction} | Sound: ${soundSamples ? 'loaded' : 'none'}`);

                        if (geminiWs.readyState === WebSocket.OPEN) {
                            setTimeout(initializeGeminiSession, 100);
                        } else {
                            geminiWs.once('open', () => setTimeout(initializeGeminiSession, 100));
                        }

                        callId = await createCallRecord({ businessId, contactId, direction, twilioCallSid: streamSid });
                        responseStartTimestampTwilio = null;
                        latestMediaTimestamp = 0;

                        callTimer = setTimeout(() => {
                            console.log('Call duration limit reached');
                            endCall('timeout');
                        }, MAX_CALL_DURATION_MS);
                        break;

                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
                        if (geminiWs.readyState === WebSocket.OPEN && geminiReady) {
                            const pcm16Payload = mulawBase64ToPcm16Base64(data.media.payload);
                            geminiWs.send(JSON.stringify({
                                realtime_input: { media_chunks: [{ data: pcm16Payload, mime_type: 'audio/pcm;rate=16000' }] }
                            }));
                        }
                        break;

                    case 'mark':
                        if (markQueue.length > 0) markQueue.shift();
                        break;

                    case 'stop':
                        console.log('Stream stopped by Twilio');
                        endCall('caller_hung_up');
                        break;

                    default:
                        console.log('Non-media event:', data.event);
                }
            } catch (err) {
                console.error('Error parsing Twilio message:', err);
            }
        });

        connection.on('close', () => {
            console.log('Twilio client disconnected');
            stopSoundPump();
            resetSilenceTimer();
            endCall('connection_closed');
        });

        geminiWs.on('close', (code, reason) => console.log(`Gemini WebSocket closed: ${code} ${reason}`));
        geminiWs.on('error', (err) => console.error('Gemini WebSocket error:', err.message));
    });
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) { console.error(err); process.exit(1); }
    console.log(`Server is listening on port ${PORT}`);
});