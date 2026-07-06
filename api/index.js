import crypto from 'crypto';
import https from 'https';
import vm from 'vm';

// ============================================================
// VERCEL CONFIG & CORS MIDDLEWARE
// ============================================================
export const config = {
    api: {
        bodyParser: {
            sizeLimit: '2mb' // Allow decent sized prompts
        }
    }
};

const allowCors = fn => async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    return await fn(req, res);
};

// ============================================================
// CONSTANTS & CACHES (Persists across Vercel warm starts)
// ============================================================
const BASE_URL = 'https://chat.deepseek.com/api/v0';
const WORKER_URL = 'https://static.deepseek.com/chat/static/33614.25c7f8f220.js';
const WASM_URL = 'https://static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

let workerCache = null;
let wasmCache = null;

const HEADERS = {
    'Accept': '*/*',
    'Content-Type': 'application/json',
    'Origin': 'https://chat.deepseek.com',
    'Referer': 'https://chat.deepseek.com/a/chat/s/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    'X-Client-Bundle-Id': 'com.deepseek.chat',
    'X-Client-Locale': 'en_US',
    'X-Client-Platform': 'web',
    'X-Client-Timezone-Offset': String(new Date().getTimezoneOffset() * -60),
    'X-Client-Version': '2.2.0'
};

// ============================================================
// CRYPTO: X-Hif-Leim (Web JS Dynamic Key + AES-CBC)
// ============================================================
let cachedLeimKey = null;
let leimKeyExpiry = 0;

async function fetchLeimKey(token) {
    if (cachedLeimKey && Date.now() < leimKeyExpiry) return cachedLeimKey;
    const res = await fetch(`${BASE_URL}/chat/leim_key`, {
        headers: { ...HEADERS, 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.code === 0) {
        cachedLeimKey = data.data.biz_data.leim_key;
        leimKeyExpiry = Date.now() + 600000; // Cache for 10 mins
        return cachedLeimKey;
    }
    throw new Error('Failed to fetch Leim Key');
}

async function generateHifLeim(token, sessionId) {
    const keyString = await fetchLeimKey(token);
    const key = Buffer.from(keyString, 'utf-8');
    const iv = Buffer.alloc(16, 0); // Web JS uses 16 bytes of 0x00
    const payload = JSON.stringify({ s: sessionId, t: Math.floor(Date.now() / 1000) });
    
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
    return encrypted.toString('base64');
}

// ============================================================
// POW: Web JS Local Challenge Generator
// ============================================================
function generateLocalChallenge() {
    const chars = 'abcdef0123456789';
    let salt = '';
    for(let i=0; i<10; i++) salt += chars[Math.floor(Math.random() * chars.length)];
    
    return {
        algorithm: "DeepSeekHashV1",
        challenge: crypto.randomBytes(32).toString('hex'),
        salt: salt,
        difficulty: 4,
        expire_at: Math.floor(Date.now() / 1000) + 600
    };
}

// ============================================================
// POW: WASM VM Sandbox Solver (From your previous script)
// ============================================================
function download(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            const data = [];
            res.on('data', chunk => data.push(chunk));
            res.on('end', () => resolve(Buffer.concat(data)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

async function loadAssets() {
    if (!workerCache) workerCache = (await download(WORKER_URL)).toString();
    if (!wasmCache) wasmCache = await download(WASM_URL);
    return { workerScript: workerCache, wasmBuffer: wasmCache };
}

function generateFinalToken(originalPayload, answer) {
    return Buffer.from(JSON.stringify({
        algorithm: originalPayload.algorithm,
        challenge: originalPayload.challenge,
        salt: originalPayload.salt,
        answer: answer,
        signature: originalPayload.signature,
        target_path: originalPayload.target_path
    })).toString('base64');
}

async function solvePow() {
    const payload = generateLocalChallenge();
    payload.target_path = "/api/v0/chat/completion";
    // Web JS calculates an initial dummy signature to pass to the worker
    payload.signature = crypto.createHash('sha256').update(payload.challenge).digest('hex').substring(0, 16);

    const { workerScript, wasmBuffer } = await loadAssets();

    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => reject(new Error('PoW timeout')), 15000); // 15s strict timeout for Vercel

        class MockResponse {
            constructor(buffer) { this.buffer = buffer; this.ok = true; this.status = 200; this.headers = { get: () => 'application/wasm' }; }
            async arrayBuffer() { return this.buffer; }
        }

        const sandbox = {
            console: { log: () => {}, error: () => {} }, setTimeout, clearTimeout, setInterval, clearInterval,
            TextEncoder, TextDecoder, URL, Response: MockResponse,
            location: { href: WORKER_URL, origin: 'https://static.deepseek.com', pathname: '/chat/static/33614.25c7f8f220.js', toString: () => WORKER_URL },
            WebAssembly: { Module: WebAssembly.Module, Instance: WebAssembly.Instance, instantiate: WebAssembly.instantiate, validate: WebAssembly.validate, Memory: WebAssembly.Memory, Table: WebAssembly.Table, Global: WebAssembly.Global, CompileError: WebAssembly.CompileError, LinkError: WebAssembly.LinkError, RuntimeError: WebAssembly.RuntimeError },
            fetch: async (input) => { if (input.toString().includes('wasm')) return new MockResponse(wasmBuffer); throw new Error("Blocked fetch"); },
            postMessage: (msg) => {
                if (msg?.type === 'pow-answer') { clearTimeout(timeoutId); resolve(generateFinalToken(payload, msg.answer.answer)); }
                else if (msg?.type === 'pow-error') { clearTimeout(timeoutId); reject(new Error('POW error')); }
            }
        };
        sandbox.self = sandbox; sandbox.window = sandbox; sandbox.globalThis = sandbox;
        const context = vm.createContext(sandbox);

        try {
            vm.runInContext(workerScript, context);
            setTimeout(() => {
                const handler = sandbox.onmessage || sandbox.self?.onmessage;
                if (handler) handler({ data: { type: "pow-challenge", challenge: payload } });
                else reject(new Error('Worker has no onmessage handler'));
            }, 500);
        } catch (e) { clearTimeout(timeoutId); reject(e); }
    });
}

// ============================================================
// NON-STREAMING WEB CHAT (Vercel Compatible)
// ============================================================
async function getFullChatResponse(token, sessionId, prompt, thinkingEnabled, searchEnabled) {
    // 1. Solve PoW (Web Local Style)
    const powToken = await solvePow();
    
    // 2. Generate Hif-Leim (Web Dynamic Style)
    const hifLeim = await generateHifLeim(token, sessionId);

    const payload = {
        chat_session_id: sessionId,
        parent_message_id: null,
        model_type: "expert", // Web default
        prompt: prompt,
        ref_file_ids: [],
        thinking_enabled: thinkingEnabled,
        search_enabled: searchEnabled,
        action: null,
        preempt: false
    };

    const response = await fetch(`${BASE_URL}/chat/completion`, {
        method: 'POST',
        headers: {
            ...HEADERS,
            'Authorization': `Bearer ${token}`,
            'x-ds-pow-response': powToken,
            'X-Hif-Leim': hifLeim
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`DeepSeek API Error: ${response.status} - ${errText}`);
    }

    // 3. Accumulate SSE Stream (Non-Streaming for Vercel)
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let thinkText = '';
    let currentFragment = 'RESPONSE';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || ''; // Keep incomplete chunk in buffer

        for (const block of lines) {
            for (const line of block.split('\n')) {
                if (!line.startsWith('data: ')) continue;
                const dataStr = line.substring(6).trim();
                if (!dataStr || dataStr === ':') continue;

                try {
                    const parsed = JSON.parse(dataStr);
                    let textToAdd = '';
                    let fragmentType = null;

                    // Handle Web JSON-Patch format
                    if (parsed.p && parsed.o) {
                        if (parsed.o === 'APPEND' && parsed.p.includes('content')) {
                            textToAdd = parsed.v;
                        } else if (parsed.o === 'BATCH' && Array.isArray(parsed.v)) {
                            for (const item of parsed.v) {
                                if (item.o === 'APPEND' && item.p?.includes('content')) textToAdd += item.v;
                            }
                        }
                    } 
                    // Handle Fragment Drops
                    else if (parsed.v && typeof parsed.v === 'object') {
                        const extractFromFragments = (obj) => {
                            if (obj.type === 'THINK' || obj.type === 'SEARCH' || obj.type === 'RESPONSE') {
                                fragmentType = obj.type;
                                return obj.content || '';
                            }
                            if (Array.isArray(obj.v)) return obj.v.map(extractFromFragments).join('');
                            return '';
                        };
                        textToAdd = extractFromFragments(parsed.v);
                    } 
                    // Handle Lazy Strings
                    else if (typeof parsed.v === 'string' && !['FINISHED', 'WIP'].includes(parsed.v)) {
                        if (!parsed.p || parsed.p.includes('content')) textToAdd = parsed.v;
                    }

                    if (fragmentType) currentFragment = fragmentType;

                    if (textToAdd) {
                        if (currentFragment === 'THINK') thinkText += textToAdd;
                        else fullText += textToAdd;
                    }
                } catch (e) { /* Ignore malformed JSON chunks */ }
            }
        }
    }

    return {
        response: fullText.trim(),
        thinking: thinkText.trim() || undefined
    };
}

// ============================================================
// VERCEL MAIN HANDLER
// ============================================================
const handler = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { prompt, thinking_enabled, search_enabled } = req.body;
    
    // Authorization from client (e.g., fetch(..., { headers: { Authorization: 'Bearer xxx' }}) )
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing Bearer Token in Authorization header' });
    }
    const token = authHeader.split(' ')[1];

    if (!prompt) {
        return res.status(400).json({ error: 'Missing "prompt" parameter' });
    }

    let sessionId = null;
    try {
        // 1. Create Session (Web Style)
        const sessionRes = await fetch(`${BASE_URL}/chat_session/create`, {
            method: 'POST',
            headers: { ...HEADERS, 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({})
        });
        const sessionData = await sessionRes.json();
        if (sessionData.code !== 0) throw new Error(sessionData.msg || 'Failed to create session');
        sessionId = sessionData.data.biz_data.id;

        // 2. Get Full Response (Blocking/Non-Streaming for Vercel)
        const result = await getFullChatResponse(
            token, 
            sessionId, 
            prompt, 
            thinking_enabled === true, 
            search_enabled === true
        );

        return res.status(200).json({ status: 'success', ...result });

    } catch (error) {
        console.error('Handler Error:', error.message);
        return res.status(500).json({ status: 'error', message: error.message });
    } finally {
        // 3. Cleanup Session
        if (sessionId) {
            try {
                await fetch(`${BASE_URL}/chat_session/delete`, {
                    method: 'POST',
                    headers: { ...HEADERS, 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ chat_session_id: sessionId })
                });
            } catch (e) { /* Ignore cleanup errors */ }
        }
    }
};

export default allowCors(handler);