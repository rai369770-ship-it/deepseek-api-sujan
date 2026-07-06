import crypto from 'crypto';

// ============================================================
// VERCEL CONFIG & CORS MIDDLEWARE
// ============================================================
export const config = {
    // Increased timeout slightly to allow PoW solving + generation
    maxDuration: 15, 
    api: {
        bodyParser: {
            sizeLimit: '2mb'
        }
    }
};

const allowCors = fn => async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*'); // Allow all origins
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    // Allow all necessary headers including Authorization
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Accept, Authorization, X-Client-Version');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    return await fn(req, res);
};

// ============================================================
// CONSTANTS & EXACT BROWSER HEADERS (CRITICAL FOR CLOUDFRONT)
// ============================================================
const BASE_URL = 'https://chat.deepseek.com/api/v0';

// These headers exactly mirror your Chrome network capture. 
// Missing even one 'Sec-*' header causes CloudFront to throw an HTML error page.
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
// Prevents "Unexpected token '<'" crashes when CloudFront blocks us
// ============================================================
async function fetchJSON(url, options) {
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
// 1. X-HIF-LEIM GENERATOR (WEB JS LOGIC)
// Fetches dynamic key, encrypts with AES-128-CBC, IV of 0x00
// ============================================================
let cachedLeimKey = null;
let leimKeyExpiry = 0;

async function generateLeim(token, sessionId) {
    // Cache key for 10 minutes to reduce API calls
    if (cachedLeimKey && Date.now() < leimKeyExpiry) {
        return encryptLeim(cachedLeimKey, sessionId);
    }

    const data = await fetchJSON(`${BASE_URL}/chat/leim_key`, {
        method: 'GET',
        headers: { ...HEADERS, 'Authorization': `Bearer ${token}` }
    });

    cachedLeimKey = data.data.biz_data.leim_key;
    leimKeyExpiry = Date.now() + 600000; // 10 mins
    return encryptLeim(cachedLeimKey, sessionId);
}

function encryptLeim(keyString, sessionId) {
    const key = Buffer.from(keyString, 'utf-8');
    const iv = Buffer.alloc(16, 0); // Web JS uses exactly 16 bytes of zeros
    const payload = JSON.stringify({ s: sessionId, t: Math.floor(Date.now() / 1000) });
    
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
    return encrypted.toString('base64');
}

// ============================================================
// 2. PROOF OF WORK SOLVER (WEB JS LOCAL GENERATION)
// Generates challenge locally, solves SHA3-256, creates signature
// ============================================================
async function solvePow(targetPath) {
    const chars = 'abcdef0123456789';
    let salt = '';
    for (let i = 0; i < 10; i++) salt += chars[Math.floor(Math.random() * chars.length)];
    
    const challenge = crypto.randomBytes(32).toString('hex');
    const difficulty = 4;
    const target = '0'.repeat(difficulty);
    
    // Pre-compute challenge hash for the HMAC signature (matches Web Worker logic)
    const challengeHash = crypto.createHash('sha256').update(challenge).digest();
    let answer = 0;

    // Brute force loop for SHA3-256
    while (true) {
        const hash = crypto.createHash('sha3-256')
            .update(`${challenge}:${salt}:${answer}`)
            .digest('hex');

        if (hash.startsWith(target)) {
            // Generate HMAC-SHA256 signature exactly like the Web JS
            const signature = crypto.createHmac('sha256', challengeHash)
                .update(`${challenge}:${salt}:${answer}:${targetPath}`)
                .digest('hex');

            const payload = {
                algorithm: "DeepSeekHashV1",
                challenge: challenge,
                salt: salt,
                answer: answer,
                signature: signature,
                target_path: targetPath
            };
            
            return Buffer.from(JSON.stringify(payload)).toString('base64');
        }
        answer++;
    }
}

// ============================================================
// 3. NON-STREAMING CHAT ACCUMULATOR (VERCEL COMPATIBLE)
// Reads the SSE stream, parses Web JSON-Patches, accumulates text
// ============================================================
async function getFullResponse(token, sessionId, prompt, thinkingEnabled, searchEnabled) {
    const targetPath = '/api/v0/chat/completion';
    
    // Execute cryptographic steps concurrently to save time
    const [powToken, hifLeim] = await Promise.all([
        solvePow(targetPath),
        generateLeim(token, sessionId)
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
    
    let buffer = '';
    let fullText = '';
    let thinkText = '';
    let currentFragment = 'RESPONSE';

    // Read stream chunk by chunk
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        
        // SSE format separates events by double newlines
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || ''; // Keep incomplete chunk in buffer

        for (const block of blocks) {
            const lines = block.split('\n');
            for (const line of lines) {
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
                                if (item.o === 'APPEND' && item.p?.includes('content')) {
                                    textToAdd += item.v;
                                }
                            }
                        }
                    } 
                    // Handle Initial Fragment Drops
                    else if (parsed.v && typeof parsed.v === 'object') {
                        const extractFragments = (obj) => {
                            if (obj.type === 'THINK' || obj.type === 'SEARCH' || obj.type === 'RESPONSE') {
                                fragmentType = obj.type;
                                return obj.content || '';
                            }
                            if (Array.isArray(obj.v)) return obj.v.map(extractFragments).join('');
                            return '';
                        };
                        textToAdd = extractFragments(parsed.v);
                    } 
                    // Handle Lazy String Chunks
                    else if (typeof parsed.v === 'string' && !['FINISHED', 'WIP'].includes(parsed.v)) {
                        if (!parsed.p || parsed.p.includes('content')) {
                            textToAdd = parsed.v;
                        }
                    }

                    if (fragmentType) currentFragment = fragmentType;

                    if (textToAdd) {
                        if (currentFragment === 'THINK') {
                            thinkText += textToAdd;
                        } else {
                            fullText += textToAdd;
                        }
                    }
                } catch (e) {
                    // Ignore malformed JSON chunks (e.g., [DONE] or incomplete objects)
                }
            }
        }
    }

    return {
        response: fullText.trim(),
        thinking: thinkText.trim() || undefined
    };
}

// ============================================================
// 4. MAIN VERCEL HANDLER
// ============================================================
const handler = async (req, res) => {
    // Only allow POST
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
    }

    const { prompt, thinking_enabled, search_enabled } = req.body;
    
    // Validate Authorization Header
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid Bearer Token in Authorization header.' });
    }
    const token = authHeader.split(' ')[1];

    // Validate Prompt
    if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ error: 'Missing "prompt" parameter in JSON body.' });
    }

    let sessionId = null;

    try {
        // Step 1: Create Chat Session
        const sessionData = await fetchJSON(`${BASE_URL}/chat_session/create`, {
            method: 'POST',
            headers: { ...HEADERS, 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({})
        });
        sessionId = sessionData.data.biz_data.id;

        // Step 2: Get Full Accumulated Response
        const result = await getFullResponse(
            token, 
            sessionId, 
            prompt, 
            thinking_enabled === true, 
            search_enabled === true
        );

        // Step 3: Return Success
        return res.status(200).json({ 
            status: 'success', 
            ...result 
        });

    } catch (error) {
        console.error('Handler Error:', error.message);
        return res.status(500).json({ 
            status: 'error', 
            message: error.message 
        });
    } finally {
        // Step 4: ALWAYS cleanup session to prevent ghost sessions on DeepSeek servers
        if (sessionId) {
            try {
                await fetch(`${BASE_URL}/chat_session/delete`, {
                    method: 'POST',
                    headers: { ...HEADERS, 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ chat_session_id: sessionId })
                });
            } catch (e) {
                // Silently ignore cleanup errors
            }
        }
    }
};

export default allowCors(handler);