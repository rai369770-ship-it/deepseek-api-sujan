import crypto from 'crypto';

// ============================================================
// VERCEL CONFIG & CORS
// ============================================================
export const config = {
    api: { bodyParser: { sizeLimit: '2mb' } }
};

const allowCors = fn => async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    return await fn(req, res);
};

const BASE_URL = 'https://chat.deepseek.com/api/v0';
const HEADERS = {
    'Accept': '*/*', 'Content-Type': 'application/json',
    'Origin': 'https://chat.deepseek.com', 'Referer': 'https://chat.deepseek.com/a/chat/s/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    'X-Client-Bundle-Id': 'com.deepseek.chat', 'X-Client-Locale': 'en_US',
    'X-Client-Platform': 'web', 'X-Client-Version': '2.2.0',
    'X-Client-Timezone-Offset': String(new Date().getTimezoneOffset() * -60)
};

// ============================================================
// 1. X-HIF-LEIM (AES-CBC)
// ============================================================
let cachedLeimKey = null;
let leimKeyExpiry = 0;

async function getLeimKey(token) {
    if (cachedLeimKey && Date.now() < leimKeyExpiry) return cachedLeimKey;
    const res = await fetch(`${BASE_URL}/chat/leim_key`, { headers: { ...HEADERS, 'Authorization': `Bearer ${token}` } });
    const data = await res.json();
    if (data.code === 0) { cachedLeimKey = data.data.biz_data.leim_key; leimKeyExpiry = Date.now() + 600000; return cachedLeimKey; }
    throw new Error('Failed to fetch Leim Key');
}

async function generateLeim(token, sessionId) {
    const key = Buffer.from(await getLeimKey(token), 'utf-8');
    const iv = Buffer.alloc(16, 0); // 16 bytes of 0x00
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    return Buffer.concat([cipher.update(JSON.stringify({ s: sessionId, t: Math.floor(Date.now() / 1000) }), 'utf8'), cipher.final()]).toString('base64');
}

// ============================================================
// 2. NATIVE POW SOLVER (No VM, No WASM, 100% Vercel Safe)
// Implements DeepSeekHashV1 natively in JS (SHA3-256)
// ============================================================
async function solvePow(targetPath) {
    const chars = 'abcdef0123456789';
    let salt = ''; for(let i=0; i<10; i++) salt += chars[Math.floor(Math.random() * chars.length)];
    const challenge = crypto.randomBytes(32).toString('hex');
    const difficulty = 4;
    const target = '0'.repeat(difficulty);
    
    // Pre-compute challenge hash for HMAC (Matches Web Worker internal logic)
    const challengeHash = crypto.createHash('sha256').update(challenge).digest();
    let answer = 0;

    while (true) {
        // Native Node.js SHA3-256 generation
        const hash = crypto.createHash('sha3-256').update(`${challenge}:${salt}:${answer}`).digest('hex');
        if (hash.startsWith(target)) {
            // Generate HMAC signature exactly like Web JS
            const signature = crypto.createHmac('sha256', challengeHash).update(`${challenge}:${salt}:${answer}:${targetPath}`).digest('hex');
            
            return Buffer.from(JSON.stringify({
                algorithm: "DeepSeekHashV1", challenge, salt, answer, signature, target_path: targetPath
            })).toString('base64');
        }
        answer++;
    }
}

// ============================================================
// 3. CHAT FETCH & ACCUMULATOR
// ============================================================
async function getFullResponse(token, sessionId, prompt, think, search) {
    const powToken = await solvePow("/api/v0/chat/completion");
    const hifLeim = await generateLeim(token, sessionId);

    const res = await fetch(`${BASE_URL}/chat/completion`, {
        method: 'POST',
        headers: { ...HEADERS, 'Authorization': `Bearer ${token}`, 'x-ds-pow-response': powToken, 'X-Hif-Leim': hifLeim },
        body: JSON.stringify({
            chat_session_id: sessionId, parent_message_id: null, model_type: "expert",
            prompt, ref_file_ids: [], thinking_enabled: think, search_enabled: search, action: null, preempt: false
        })
    });

    if (!res.ok) throw new Error(`API Error: ${res.status}`);
    
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', fullText = '', thinkText = '', currentFrag = 'RESPONSE';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n'); buffer = blocks.pop() || '';

        for (const block of blocks) {
            for (const line of block.split('\n')) {
                if (!line.startsWith('data: ')) continue;
                const d = line.substring(6).trim();
                if (!d || d === ':') continue;
                try {
                    const p = JSON.parse(d); let txt = '', frag = null;
                    if (p.p && p.o) {
                        if (p.o === 'APPEND' && p.p.includes('content')) txt = p.v;
                        else if (p.o === 'BATCH' && Array.isArray(p.v)) for (const i of p.v) { if (i.o === 'APPEND' && i.p?.includes('content')) txt += i.v; }
                    } else if (p.v && typeof p.v === 'object') {
                        const ex = (o) => { if (['THINK','SEARCH','RESPONSE'].includes(o.type)) { frag = o.type; return o.content||''; } if (Array.isArray(o.v)) return o.v.map(ex).join(''); return ''; };
                        txt = ex(p.v);
                    } else if (typeof p.v === 'string' && !['FINISHED','WIP'].includes(p.v)) { if (!p.p || p.p.includes('content')) txt = p.v; }
                    if (frag) currentFrag = frag;
                    if (txt) { if (currentFrag === 'THINK') thinkText += txt; else fullText += txt; }
                } catch (e) {}
            }
        }
    }
    return { response: fullText.trim(), thinking: thinkText.trim() || undefined };
}

// ============================================================
// 4. MAIN HANDLER
// ============================================================
const handler = async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    const { prompt, thinking_enabled, search_enabled } = req.body;
    const auth = req.headers['authorization'];
    if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing Bearer Token' });
    const token = auth.split(' ')[1];
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    let sid = null;
    try {
        const sRes = await fetch(`${BASE_URL}/chat_session/create`, { method: 'POST', headers: { ...HEADERS, 'Authorization': `Bearer ${token}` }, body: '{}' });
        const sData = await sRes.json();
        if (sData.code !== 0) throw new Error(sData.msg);
        sid = sData.data.biz_data.id;

        const result = await getFullResponse(token, sid, prompt, thinking_enabled === true, search_enabled === true);
        return res.status(200).json({ status: 'success', ...result });
    } catch (e) {
        return res.status(500).json({ status: 'error', message: e.message });
    } finally {
        if (sid) try { await fetch(`${BASE_URL}/chat_session/delete`, { method: 'POST', headers: { ...HEADERS, 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ chat_session_id: sid }) }); } catch(e){}
    }
};

export default allowCors(handler);