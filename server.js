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
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY
} = process.env;

if (!GEMINI_API_KEY) { console.error('Missing GEMINI_API_KEY'); process.exit(1); }
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

const GEMINI_WS_URL =
    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta` +
    `.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const BACKGROUND_SOUND_URLS = {
    office:      `https://atauxjrnhbobpelsiggj.supabase.co/storage/v1/object/public/sounds%20bucket/office.mp3`,
    call_center: `https://atauxjrnhbobpelsiggj.supabase.co/storage/v1/object/public/sounds%20bucket/call_center.mp3`,
    traffic:     `https://atauxjrnhbobpelsiggj.supabase.co/storage/v1/object/public/sounds%20bucket/traffic.mp3`,
    nature:      `https://atauxjrnhbobpelsiggj.supabase.co/storage/v1/object/public/sounds%20bucket/nature.mp3`,
    cafe:        `https://atauxjrnhbobpelsiggj.supabase.co/storage/v1/object/public/sounds%20bucket/cafe.mp3`,
    rain:        `https://atauxjrnhbobpelsiggj.supabase.co/storage/v1/object/public/sounds%20bucket/rain.mp3`,
};

const soundCache = {};

function mulawToLinear(u) {
    u = ~u & 0xFF; let sign = u & 0x80; let exponent = (u >> 4) & 0x07; let mantissa = u & 0x0F;
    let sample = ((mantissa << 1) + 33) << exponent; sample -= 33; return sign ? -sample : sample;
}

function linearToMulaw(sample) {
    const MULAW_MAX = 0x1FFF; const MULAW_BIAS = 33;
    const exp_lut = [0,1,2,2,3,3,3,3,4,4,4,4,4,4,4,4,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,
                     6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
                     7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
                     7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7];
    let sign = (sample >> 8) & 0x80; if (sign) sample = -sample; if (sample > MULAW_MAX) sample = MULAW_MAX;
    sample += MULAW_BIAS; let exponent = exp_lut[(sample >> 7) & 0xFF]; let mantissa = (sample >> (exponent + 3)) & 0x0F;
    return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

function mulawBase64ToPcm16Base64(mulawBase64) {
    const mulawBuf = Buffer.from(mulawBase64, 'base64'); const pcm8k = new Int16Array(mulawBuf.length);
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
    const pcmBuf = Buffer.from(pcm16Base64, 'base64'); const pcm24k = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 2);
    const outLen = Math.floor(pcm24k.length / 3); const mulaw8k = Buffer.alloc(outLen);
    for (let i = 0; i < outLen; i++) mulaw8k[i] = linearToMulaw(pcm24k[i * 3]); return mulaw8k.toString('base64');
}

function convertAudioToPcm24k(inputBuffer) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const ff = spawn('ffmpeg', ['-i', 'pipe:0', '-f', 's16le', '-ar', '24000', '-ac', '1', '-loglevel', 'quiet', 'pipe:1']);
        ff.stdout.on('data', chunk => chunks.push(chunk));
        ff.stdout.on('end', () => { const pcmBuf = Buffer.concat(chunks); resolve(new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 2)); });
        ff.on('error', (err) => reject(new Error(`ffmpeg error: ${err.message}`)));
        ff.stdin.write(inputBuffer); ff.stdin.end();
    });
}

async function loadSoundPCM(soundId) {
    if (soundCache[soundId]) return soundCache[soundId];
    if (!BACKGROUND_SOUND_URLS[soundId]) return null;
    try {
        const response = await fetch(BACKGROUND_SOUND_URLS[soundId]);
        if (!response.ok) throw new Error(`HTTP ${response.status} for sound ${soundId}`);
        const pcmSamples = await convertAudioToPcm24k(Buffer.from(await response.arrayBuffer()));
        soundCache[soundId] = pcmSamples; return pcmSamples;
    } catch (err) { console.error(`Failed to load sound ${soundId}:`, err.message); return null; }
}

function mixSoundIntoAudio(geminiPcm, soundSamples, soundOffset, volumePct) {
    if (!soundSamples || soundSamples.length === 0) return { mixed: geminiPcm, newOffset: soundOffset };
    const vol = Math.max(0, Math.min(100, volumePct)) / 100;
    const mixed = new Int16Array(geminiPcm.length); let offset = soundOffset;
    for (let i = 0; i < geminiPcm.length; i++) {
        mixed[i] = Math.max(-32768, Math.min(32767, geminiPcm[i] + Math.round(soundSamples[offset % soundSamples.length] * vol)));
        offset++;
    }
    return { mixed, newOffset: offset };
}

async function createCallRecord({ businessId, contactId, campaignId, targetNumber, direction, twilioCallSid, maxDurationLimit }) {
    const { data, error } = await supabase.from('calls').insert({
        business_id: businessId || null, contact_id: contactId || null, campaign_id: campaignId || null,
        target_number: targetNumber || null, direction, status: 'initiated', twilio_call_sid: twilioCallSid || null,
        max_duration_limit: maxDurationLimit || 120, started_at: new Date().toISOString()
    }).select().maybeSingle();
    if (error) { console.error('Error creating call record:', error.message); return null; }
    return data ? data.id : null;
}

async function updateCallRecord(callId, { status, callerTranscript, geminiTranscript, durationSeconds, summary, creditsUsed }) {
    if (!callId) return;
    await supabase.from('calls').update({
        status, caller_transcript: callerTranscript || null, gemini_transcript: geminiTranscript || null,
        duration_seconds: durationSeconds || 0, credits_used: creditsUsed || 0, summary: summary || null,
        ended_at: new Date().toISOString()
    }).eq('id', callId);
}

async function incrementBusinessCallCount(businessId) {
    if (!businessId) return;
    await supabase.rpc('increment_calls_used', { business_id_input: businessId });
}

async function getAgentById(agentId) {
    if (!agentId) return null;
    const { data } = await supabase.from('agents').select('*').eq('id', agentId).maybeSingle();
    return data;
}

async function getGroupById(groupId) {
    if (!groupId) return null;
    const { data } = await supabase.from('ai_groups').select(`id, name, routing_conditions, primary_agent_id, group_members(agent_id)`).eq('id', groupId).maybeSingle();
    return data;
}

async function getActiveCallSettings(businessId, campaignId) {
    if (!businessId) return null;
    const { data } = await supabase.from('businesses').select('live_call_tasks_prompt').eq('id', businessId).maybeSingle();
    return data ? { liveCallTasksPrompt: data.live_call_tasks_prompt || '' } : null;
}

async function generateCallSummary(callerTranscript, geminiTranscript) {
    if (!callerTranscript && !geminiTranscript) return null;
    try {
        const fullTranscript = [callerTranscript, geminiTranscript].filter(Boolean).join('\n').trim();
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: `Summarize this phone call in 3-4 bullet points. Cover what was discussed, decisions made, and next steps. Be concise and professional. Only return bullet points, no intro text.\n\nTranscript:\n${fullTranscript}` }] }],
                generationConfig: { maxOutputTokens: 300, temperature: 0.2 }
            })
        });
        const data = await response.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
    } catch (err) { return null; }
}

fastify.get('/', async (request, reply) => { reply.send({ message: 'Twilio + Gemini Live API is running!' }); });

// --- CRASH-PROOF GLOBAL CALL STATUS CALLBACK WEBHOOK ---
fastify.post('/call-status', async (request, reply) => {
    const { CallSid, CallStatus } = request.body;
    const { businessId, campaignId, targetNumber, contactId } = request.query;
    console.log(`[TWILIO STATUS] ${CallSid} => ${CallStatus}`);

    // Use maybeSingle to PREVENT crash if DB is lagging
    const { data: existingCall } = await supabase.from('calls').select('id, status').eq('twilio_call_sid', CallSid).maybeSingle();

    if (existingCall) {
        if (['busy', 'no-answer', 'canceled', 'failed', 'completed'].includes(CallStatus)) {
            await supabase.from('calls').update({ status: CallStatus, ended_at: new Date().toISOString() }).eq('id', existingCall.id);
        }
    } else {
        if (['busy', 'no-answer', 'canceled', 'failed', 'completed'].includes(CallStatus)) {
            await supabase.from('calls').insert({
                business_id: businessId || null, contact_id: contactId || null, campaign_id: campaignId !== 'null' ? campaignId : null,
                target_number: targetNumber || null, direction: 'outbound', status: CallStatus, twilio_call_sid: CallSid,
                duration_seconds: 0, credits_used: 0, started_at: new Date().toISOString(), ended_at: new Date().toISOString()
            });
        }
    }
    reply.send({ received: true });
});

fastify.all('/incoming-call', async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="wss://${request.headers.host}/media-stream">
            <Parameter name="businessId" value="${request.query.businessId || ''}" />
            <Parameter name="contactId" value="${request.query.contactId || ''}" />
            <Parameter name="campaignId" value="${request.query.campaignId || ''}" />
            <Parameter name="targetNumber" value="${request.query.targetNumber || ''}" />
            <Parameter name="direction" value="${request.query.direction || 'inbound'}" />
            <Parameter name="agentId" value="${request.query.agentId || ''}" />
            <Parameter name="groupId" value="${request.query.groupId || ''}" />
            <Parameter name="maxDuration" value="${request.query.maxDuration || '120'}" />
        </Stream>
    </Connect>
</Response>`;
    reply.type('text/xml').send(twimlResponse);
});

fastify.post('/make-call', async (request, reply) => {
    const { to, businessId, contactId, agentId, groupId, campaignId, maxDuration } = request.body;
    if (!to || !businessId) return reply.status(400).send({ error: 'Missing parameters' });

    const { data: businessData, error: dbError } = await supabase.from('businesses').select('twilio_account_sid, twilio_auth_token, twilio_number, credits_balance').eq('id', businessId).maybeSingle();
    if (dbError || !businessData) return reply.status(500).send({ error: 'Failed to retrieve business profile.' });
    if (businessData.credits_balance <= 0) return reply.status(402).send({ error: 'Insufficient credits.' });

    const userTwilioSid = businessData.twilio_account_sid.trim();
    const userTwilioAuth = businessData.twilio_auth_token.trim();
    const credentials = Buffer.from(`${userTwilioSid}:${userTwilioAuth}`).toString('base64');
    
    const webhookUrl = new URL(`https://${request.headers.host}/incoming-call`);
    webhookUrl.searchParams.set('businessId', businessId);
    webhookUrl.searchParams.set('targetNumber', to);
    if (contactId) webhookUrl.searchParams.set('contactId', contactId);
    if (agentId) webhookUrl.searchParams.set('agentId', agentId);
    if (groupId) webhookUrl.searchParams.set('groupId', groupId);
    if (campaignId) webhookUrl.searchParams.set('campaignId', campaignId);
    webhookUrl.searchParams.set('maxDuration', maxDuration || '120');
    webhookUrl.searchParams.set('direction', 'outbound');

    const statusCallbackUrl = new URL(`https://${request.headers.host}/call-status`);
    statusCallbackUrl.searchParams.set('businessId', businessId);
    statusCallbackUrl.searchParams.set('targetNumber', to);
    if (campaignId) statusCallbackUrl.searchParams.set('campaignId', campaignId);

    try {
        const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${userTwilioSid}/Calls.json`, {
            method: 'POST',
            headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ 
                To: to, From: businessData.twilio_number.trim(), Url: webhookUrl.toString(),
                StatusCallback: statusCallbackUrl.toString(), StatusCallbackMethod: 'POST',
                StatusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'].join(' ')
            }).toString()
        });

        const data = await response.json();
        if (data.sid) {
            await createCallRecord({ businessId, contactId, campaignId, targetNumber: to, direction: 'outbound', twilioCallSid: data.sid, maxDurationLimit: maxDuration });
            reply.send({ success: true, callSid: data.sid, to });
        } else {
            reply.status(500).send({ success: false, error: data.message });
        }
    } catch (err) { reply.status(500).send({ success: false, error: err.message }); }
});

fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        let geminiWs = null, geminiReady = false, isTransferring = false, isDisconnecting = false, isTransferContextActive = false;
        let streamSid = null, latestMediaTimestamp = 0, markQueue = [], responseStartTimestampTwilio = null;
        let callEnded = false, callTimer = null, accumulatedText = '', accumulatedTranscription = '';
        let soundPumpInterval = null, isSpeaking = false, soundSamples = null, soundOffset = 0, soundVolume = 30;
        let callId = null, businessId = null, targetNumber = null, callStartTime = null;
        let callerTranscriptParts = [], geminiTranscriptParts = [], currentAgent = null, availableAgents = [];
        let isGroupCall = false, groupRoutingConditions = '', liveCallTasksPrompt = '';

        const endCall = async (reason = 'timeout') => {
            if (callEnded) return;
            if (reason === 'timeout' && geminiWs && geminiWs.readyState === WebSocket.OPEN && geminiReady) {
                geminiWs.send(JSON.stringify({ client_content: { turns: [{ role: 'user', parts: [{ text: '[INTERNAL INSTRUCTION] The call time limit reached. End the call naturally.' }] }], turn_complete: true } }));
                return; 
            }
            callEnded = true; isDisconnecting = true;
            if (callTimer) clearTimeout(callTimer);
            stopSoundPump();

            if (callId) {
                const durationSeconds = callStartTime ? Math.floor((Date.now() - callStartTime) / 1000) : 0;
                const minutesUsed = Math.ceil(durationSeconds / 60);
                await updateCallRecord(callId, { 
                    status: 'completed', durationSeconds, creditsUsed: minutesUsed,
                    callerTranscript: callerTranscriptParts.join('\n'), geminiTranscript: geminiTranscriptParts.join('\n'),
                    summary: await generateCallSummary(callerTranscriptParts.join('\n'), geminiTranscriptParts.join('\n'))
                });
                await incrementBusinessCallCount(businessId);
                if (minutesUsed > 0) await supabase.rpc('subtract_credits', { business_id_input: businessId, amount_to_subtract: minutesUsed });
            }
            if (connection.readyState === WebSocket.OPEN) connection.close();
            if (geminiWs && geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
        };

        const startSoundPump = () => {
            if (!soundSamples || soundPumpInterval) return;
            soundPumpInterval = setInterval(() => {
                if (!streamSid || callEnded || isTransferring || isDisconnecting || isSpeaking) return;
                const chunk = new Int16Array(480); const vol = soundVolume / 100;
                for (let i = 0; i < 480; i++) { chunk[i] = Math.round(soundSamples[soundOffset % soundSamples.length] * vol); soundOffset++; }
                const mulaw8k = Buffer.alloc(160);
                for (let i = 0; i < 160; i++) mulaw8k[i] = linearToMulaw(Math.max(-32768, Math.min(32767, chunk[i * 3])));
                if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ event: 'media', streamSid, media: { payload: mulaw8k.toString('base64') } }));
            }, 20);
        };

        const stopSoundPump = () => { if (soundPumpInterval) { clearInterval(soundPumpInterval); soundPumpInterval = null; } };
        const sendMark = () => { if (streamSid) { connection.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'responsePart' } })); markQueue.push('responsePart'); } };

        const connectGemini = (transferContext = null) => {
            geminiReady = false; geminiWs = new WebSocket(GEMINI_WS_URL);
            geminiWs.on('open', () => {
                let finalPrompt = currentAgent ? currentAgent.prompt : SYSTEM_MESSAGE;
                if (liveCallTasksPrompt) finalPrompt += `\n[TASKS]: ${liveCallTasksPrompt}`;
                geminiWs.send(JSON.stringify({ setup: { model: `models/${MODEL}`, generation_config: { response_modalities: ['AUDIO'], speech_config: { voice_config: { prebuilt_voice_config: { voice_name: currentAgent?.voice || VOICE } } } }, system_instruction: { parts: [{ text: finalPrompt }] } } }));
                if (transferContext) isTransferContextActive = true;
            });

            geminiWs.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.setupComplete !== undefined) {
                    geminiReady = true; isTransferring = false;
                    geminiWs.send(JSON.stringify({ client_content: { turns: [{ role: 'user', parts: [{ text: isTransferContextActive ? 'Acknowledge transfer and continue.' : 'Greet the user.' }] }], turn_complete: true } }));
                    isTransferContextActive = false; return;
                }
                if (msg.serverContent) {
                    const sc = msg.serverContent;
                    if (sc.interrupted) { if (markQueue.length > 0) connection.send(JSON.stringify({ event: 'clear', streamSid })); markQueue = []; }
                    if (sc.inputTranscription?.text) callerTranscriptParts.push(`Caller: ${sc.inputTranscription.text}`);
                    if (sc.outputTranscription?.text) {
                        accumulatedTranscription += sc.outputTranscription.text; geminiTranscriptParts.push(`AI: ${sc.outputTranscription.text}`);
                        if (accumulatedTranscription.includes('[END_CALL]') && !isDisconnecting) { isDisconnecting = true; setTimeout(() => endCall('user_intent'), 1500); }
                    }
                    if (sc.modelTurn?.parts) {
                        for (const part of sc.modelTurn.parts) {
                            if (part.inlineData?.data) {
                                isSpeaking = true;
                                let audioBase64 = part.inlineData.data;
                                if (soundSamples) {
                                    const pcmBuf = Buffer.from(audioBase64, 'base64');
                                    const { mixed, newOffset } = mixSoundIntoAudio(new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 2), soundSamples, soundOffset, soundVolume);
                                    soundOffset = newOffset; audioBase64 = Buffer.from(mixed.buffer).toString('base64');
                                }
                                connection.send(JSON.stringify({ event: 'media', streamSid, media: { payload: pcm16Base64ToMulawBase64(audioBase64) } }));
                                sendMark();
                            }
                        }
                    }
                    if (sc.turnComplete) { isSpeaking = false; accumulatedTranscription = ''; }
                }
            });
        };

        connection.on('message', async (message) => {
            const data = JSON.parse(message);
            if (data.event === 'start') {
                streamSid = data.start.streamSid; callStartTime = Date.now();
                const params = data.start.customParameters || {};
                businessId = params.businessId; targetNumber = params.targetNumber;

                // Sync with existing record safely
                const { data: existingRecord } = await supabase.from('calls').select('id').eq('twilio_call_sid', streamSid).maybeSingle();
                if (existingRecord) {
                    callId = existingRecord.id;
                    await supabase.from('calls').update({ status: 'in-progress' }).eq('id', callId);
                }
                
                if (params.agentId) currentAgent = await getAgentById(params.agentId);
                if (currentAgent?.background_sound) { soundVolume = currentAgent.sound_volume ?? 30; soundSamples = await loadSoundPCM(currentAgent.background_sound); startSoundPump(); }

                connectGemini();
                callTimer = setTimeout(() => endCall('timeout'), parseInt(params.maxDuration || '120') * 1000);
            }
            if (data.event === 'media' && geminiReady && !isDisconnecting) {
                geminiWs.send(JSON.stringify({ realtime_input: { media_chunks: [{ data: mulawBase64ToPcm16Base64(data.media.payload), mime_type: 'audio/pcm;rate=16000' }] } }));
            }
            if (data.event === 'mark') markQueue.shift();
            if (data.event === 'stop') endCall('caller_hung_up');
        });
        connection.on('close', () => endCall('connection_closed'));
    });
});

fastify.post('/verify-payment', async (request, reply) => {
    try {
        const { paymentId, businessId, creditsToAdd } = request.body;
        const credentials = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
        const response = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}`, { headers: { 'Authorization': `Basic ${credentials}` } });
        const rzpData = await response.json();
        if (rzpData.status === 'captured' || rzpData.status === 'authorized') {
            await supabase.rpc('add_credits', { business_id_input: businessId, amount_to_add: creditsToAdd });
            return reply.send({ success: true });
        }
        reply.status(400).send({ success: false });
    } catch (err) { reply.status(500).send({ success: false }); }
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) { console.error(err); process.exit(1); }
    console.log(`Server is listening on port ${PORT}`);
});