import crypto from 'crypto';

// ============================================================
// VERCEL CONFIG & CORS MIDDLEWARE
// ============================================================
export const config = {
    maxDuration: 15, 
    api: { bodyParser: { sizeLimit: '2mb' } }
};

const allowCors = fn => async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Accept, Authorization, X-Client-Version');
    if (req.method === 'OPTIONS') return res.status(200).end();
    return await fn(req, res);
};

// ============================================================
// CONSTANTS & EXACT BROWSER HEADERS
// ============================================================
const BASE_URL = 'https://chat.deepseek.com/api/v0';

const HEADERS = {
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Content-Type': 'application/json',
    'Origin': 'https://chat.deepseek.com',
    'Referer': 'https://chat.deepseek.com/a/chat/s/',
    'Sec-Ch-Ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    'X-Client-Bundle-Id': 'com.deepseek.chat',
    'X-Client-Locale': 'en_US',
    'X-Client-Platform': 'web',
    'X-Client-Timezone-Offset': String(new Date().getTimezoneOffset() * -60),
    'X-Client-Version': '2.2.0'
};

// ============================================================
// NEW: WEB SESSION INITIALIZER (THE FIX)
// DeepSeek's Load Balancer requires a 'ds_session_id' cookie 
// to route requests to the API backend instead of the HTML frontend.
// ============================================================
let webCookies = null;

async function initializeWebSession() {
    if (webCookies) return webCookies;
    
    try {
        // Hit the main page to generate and grab the routing cookies
        const res = await fetch('https://chat.deepseek.com/', {
            headers: { 'User-Agent': HEADERS['User-Agent'] }
        });
        
        // Node.js 18+ native fetch parses Set-Cookie into an array
        const setCookies = res.headers.getSetCookie(); 
        if (setCookies && setCookies.length > 0) {
            // Extract just the cookie names/values (ignore path/expiry attributes)
            webCookies = setCookies.map(c => c.split(';')[0]).join('; ');
        } else {
            webCookies = ''; // Fallback if no cookies are set
        }
    } catch (e) {
        console.error('Failed to initialize web session:', e.message);
        webCookies = '';
    }
    
    return webCookies;
}

// ============================================================
// SAFE JSON FETCH WRAPPER
// ============================================================
async function fetchJSON(url, options) {
    // Inject the routing cookies into EVERY API request
    const cookies = await initializeWebSession();
    options.headers = { ...options.headers, 'Cookie': cookies };

    const response = await fetch(url, options);
    const contentType = response.headers.get('content-type') || '';
    
    if (!contentType.includes('application/json')) {
        const errorText = await response.text();
        throw new Error(`CloudFront Block at ${url}. Status: ${response.status}. Body: ${errorText.substring(0, 200)}`);
    }
    
    const data = await response.json();
    if (data.code !== 0 && data.code !== undefined) {
        throw new Error(`DeepSeek API Error: ${data.msg || 'Unknown error'}`);
    }
    return data;
}

// ============================================================
// 1. X-HIF-LEIM GENERATOR
// ============================================================
let cachedLeimKey = null;
let leimKeyExpiry = 0;

async function generateLeim(token, sessionId) {
    if (cachedLeimKey && Date.now() < leimKeyExpiry) {
        return encryptLeim(cachedLeimKey, sessionId);
    }

    const data = await fetchJSON(`${BASE_URL}/chat/leim_key`, {
        method: 'GET',
        headers: { ...HEADERS, 'Authorization': `Bearer ${token}` }
    });

    cachedLeimKey = data.data.biz_data.leim_key;
    leimKeyExpiry = Date.now() + 600000;
    return encryptLeim(cachedLeimKey, sessionId);
}

function encryptLeim(keyString, sessionId) {
    const key = Buffer.from(keyString, 'utf-8');
    const iv = Buffer.alloc(16, 0); 
    const payload = JSON.stringify({ s: sessionId, t: Math.floor(Date.now() / 1000) });
    
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
    return encrypted.toString('base64');
}

// ============================================================
// 2. PROOF OF WORK SOLVER (SHA3-256)
// ============================================================
async function solvePow(targetPath) {
    const chars = 'abcdef0123456789';
    let salt = '';
    for (let i = 0; i < 10; i++) salt += chars[Math.floor(Math.random() * chars.length)];
    
    const challenge = crypto.randomBytes(32).toString('hex');
    const difficulty = 4;
    const target = '0'.repeat(difficulty);
    const challengeHash = crypto.createHash('sha256').update(challenge).digest();
    let answer = 0;

    while (true) {
        const hash = crypto.createHash('sha3-256').update(`${challenge}:${salt}:${answer}`).digest('hex');
        if (hash.startsWith(target)) {
            const signature = crypto.createHmac('sha256', challengeHash).update(`${challenge}:${salt}:${answer}:${targetPath}`).digest('hex');
            return Buffer.from(JSON.stringify({ algorithm: "DeepSeekHashV1", challenge, salt, answer, signature, target_path: targetPath })).toString('base64');
        }
        answer++;
    }
}

// ============================================================
// 3. NON-STREAMING CHAT ACCUMULATOR
// ============================================================
async function getFullResponse(token, sessionId, prompt, thinkingEnabled, searchEnabled) {
    const targetPath = '/api/v0/chat/completion';
    
    // Execute crypto steps concurrently
    const [powToken, hifLeim, cookies] = await Promise.all([
        solvePow(targetPath),
        generateLeim(token, sessionId),
        initializeWebSession() // Grab cookies concurrently to save time
    ]);

    const payload = {
        chat_session_id: sessionId,
        parent_message_id: null,
        model_type: "expert",
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
            'Cookie': cookies, // INJECT COOKIES HERE
            'x-ds-pow-response': powToken,
            'X-Hif-Leim': hifLeim
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Chat API Error ${response.status}: ${errText.substring(0, 200)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', fullText = '', thinkText = '', currentFragment = 'RESPONSE';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';

        for (const block of blocks) {
            for (const line of block.split('\n')) {
                if (!line.startsWith('data: ')) continue;
                const dataStr = line.substring(6).trim();
                if (!dataStr || dataStr === ':') continue;

                try {
                    const parsed = JSON.parse(dataStr);
                    let textToAdd = '', fragmentType = null;

                    if (parsed.p && parsed.o) {
                        if (parsed.o === 'APPEND' && parsed.p.includes('content')) textToAdd = parsed.v;
                        else if (parsed.o === 'BATCH' && Array.isArray(parsed.v)) for (const item of parsed.v) { if (item.o === 'APPEND' && item.p?.includes('content')) textToAdd += item.v; }
                    } else if (parsed.v && typeof parsed.v === 'object') {
                        const ex = (o) => { if (['THINK','SEARCH','RESPONSE'].includes(o.type)) { fragmentType = o.type; return o.content||''; } if (Array.isArray(o.v)) return o.v.map(ex).join(''); return ''; };
                        textToAdd = ex(parsed.v);
                    } else if (typeof parsed.v === 'string' && !['FINISHED','WIP'].includes(parsed.v)) { if (!parsed.p || parsed.p.includes('content')) textToAdd = parsed.v; }

                    if (fragmentType) currentFragment = fragmentType;
                    if (textToAdd) { if (currentFragment === 'THINK') thinkText += textToAdd; else fullText += textToAdd; }
                } catch (e) {}
            }
        }
    }
    return { response: fullText.trim(), thinking: thinkText.trim() || undefined };
}

// ============================================================
// 4. MAIN VERCEL HANDLER
// ============================================================
const handler = async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
    
    const { prompt, thinking_enabled, search_enabled } = req.body;
    const authHeader = req.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing Bearer Token' });
    const token = authHeader.split(' ')[1];
    if (!prompt) return res.status(400).json({ error: 'Missing "prompt" parameter' });

    let sessionId = null;
    try {
        const sessionData = await fetchJSON(`${BASE_URL}/chat_session/create`, {
            method: 'POST',
            headers: { ...HEADERS, 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({})
        });
        sessionId = sessionData.data.biz_data.id;

        const result = await getFullResponse(token, sessionId, prompt, thinking_enabled === true, search_enabled === true);
        return res.status(200).json({ status: 'success', ...result });

    } catch (error) {
        console.error('Handler Error:', error.message);
        return res.status(500).json({ status: 'error', message: error.message });
    } finally {
        if (sessionId) {
            const cookies = await initializeWebSession();
            try { await fetch(`${BASE_URL}/chat_session/delete`, { method: 'POST', headers: { ...HEADERS, 'Authorization': `Bearer ${token}`, 'Cookie': cookies }, body: JSON.stringify({ chat_session_id: sessionId }) }); } catch(e){}
        }
    }
};

export default allowCors(handler);