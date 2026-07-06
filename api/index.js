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
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Accept, Authorization');
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
// SAFE JSON FETCH WRAPPER
// ============================================================
async function fetchJSON(url, options) {
    const response = await fetch(url, options);
    const contentType = response.headers.get('content-type') || '';
    
    // If it returns HTML, it means we hit a non-existent endpoint or got blocked
    if (!contentType.includes('application/json')) {
        const errorText = await response.text();
        throw new Error(`API Error at ${url}. Expected JSON, got HTML. Body: ${errorText.substring(0, 100)}`);
    }
    
    const data = await response.json();
    if (data.code !== 0 && data.code !== undefined) {
        throw new Error(`DeepSeek Error: ${data.msg || 'Unknown API error'}`);
    }
    return data;
}

// ============================================================
// 1. PROOF OF WORK SOLVER (Server-Side Challenge)
// Uses the official API endpoint to get the challenge, 
// then solves it using native SHA3-256 (No WASM needed)
// ============================================================
function solveChallenge(challengeData, targetPath) {
    const { challenge, salt, difficulty } = challengeData;
    const target = '0'.repeat(difficulty || 4);
    
    // Pre-compute challenge hash for HMAC signature
    const challengeHash = crypto.createHash('sha256').update(challenge).digest();
    let answer = 0;

    while (true) {
        // Native Node.js SHA3-256
        const hash = crypto.createHash('sha3-256')
            .update(`${challenge}:${salt}:${answer}`)
            .digest('hex');

        if (hash.startsWith(target)) {
            // Create signature exactly like Web JS
            const signature = crypto.createHmac('sha256', challengeHash)
                .update(`${challenge}:${salt}:${answer}:${targetPath}`)
                .digest('hex');

            return Buffer.from(JSON.stringify({
                algorithm: "DeepSeekHashV1",
                challenge: challenge,
                salt: salt,
                answer: answer,
                signature: signature,
                target_path: targetPath
            })).toString('base64');
        }
        answer++;
    }
}

async function getPowToken(token, targetPath) {
    // Fetch the challenge directly from DeepSeek's server
    const data = await fetchJSON(`${BASE_URL}/chat/create_pow_challenge`, {
        method: 'POST',
        headers: { ...HEADERS, 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ target_path: targetPath })
    });
    
    const challengeData = data.data.biz_data.challenge;
    return solveChallenge(challengeData, targetPath);
}

// ============================================================
// 2. NON-STREAMING CHAT ACCUMULATOR
// ============================================================
async function getFullResponse(token, sessionId, prompt, thinkingEnabled, searchEnabled) {
    const targetPath = '/api/v0/chat/completion';
    
    // Solve PoW (We removed X-Hif-Leim entirely as it's not strictly required)
    const powToken = await getPowToken(token, targetPath);

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
            'x-ds-pow-response': powToken
            // Notice: NO X-Hif-Leim header here!
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
                        else if (parsed.o === 'BATCH' && Array.isArray(parsed.v)) {
                            for (const item of parsed.v) { if (item.o === 'APPEND' && item.p?.includes('content')) textToAdd += item.v; }
                        }
                    } else if (parsed.v && typeof parsed.v === 'object') {
                        const ex = (o) => { if (['THINK','SEARCH','RESPONSE'].includes(o.type)) { fragmentType = o.type; return o.content||''; } if (Array.isArray(o.v)) return o.v.map(ex).join(''); return ''; };
                        textToAdd = ex(parsed.v);
                    } else if (typeof parsed.v === 'string' && !['FINISHED','WIP'].includes(parsed.v)) { 
                        if (!parsed.p || parsed.p.includes('content')) textToAdd = parsed.v; 
                    }

                    if (fragmentType) currentFragment = fragmentType;
                    if (textToAdd) { if (currentFragment === 'THINK') thinkText += textToAdd; else fullText += textToAdd; }
                } catch (e) {}
            }
        }
    }
    return { response: fullText.trim(), thinking: thinkText.trim() || undefined };
}

// ============================================================
// 3. MAIN VERCEL HANDLER
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
        // 1. Create Session
        const sessionData = await fetchJSON(`${BASE_URL}/chat_session/create`, {
            method: 'POST',
            headers: { ...HEADERS, 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({})
        });
        sessionId = sessionData.data.biz_data.id;

        // 2. Get Full Accumulated Response
        const result = await getFullResponse(token, sessionId, prompt, thinking_enabled === true, search_enabled === true);
        return res.status(200).json({ status: 'success', ...result });

    } catch (error) {
        console.error('Handler Error:', error.message);
        return res.status(500).json({ status: 'error', message: error.message });
    } finally {
        // 3. ALWAYS cleanup session
        if (sessionId) {
            try { await fetch(`${BASE_URL}/chat_session/delete`, { method: 'POST', headers: { ...HEADERS, 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ chat_session_id: sessionId }) }); } catch(e){}
        }
    }
};

export default allowCors(handler);