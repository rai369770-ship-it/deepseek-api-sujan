import crypto from 'crypto';

export const config = {
    maxDuration: 60,
    api: { bodyParser: { sizeLimit: '10mb' } }
};

const allowCors = fn => async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    return await fn(req, res);
};

const BASE_URL = 'https://chat.deepseek.com/api/v0';

function buildHeaders(token, powResponse) {
    const h = {
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Origin': 'https://chat.deepseek.com',
        'Referer': 'https://chat.deepseek.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
        'X-App-Version': '20241129.1',
        'X-Client-Locale': 'en_US',
        'X-Client-Platform': 'web',
        'X-Client-Version': '2.0.0'
    };
    if (powResponse) h['x-ds-pow-response'] = powResponse;
    return h;
}

function solvePow(challengeConfig) {
    const { challenge, salt, difficulty, expire_at } = challengeConfig;
    const prefix = `${salt}_${expire_at}_`;
    const threshold = Math.floor(4294967296 / difficulty);
    for (let nonce = 0; nonce < 50000000; nonce++) {
        const h = crypto.createHash('sha3-256')
            .update(challenge + prefix + nonce)
            .digest();
        if (h.readUInt32LE(0) < threshold) return nonce;
    }
    throw new Error('PoW solve failed: no nonce found within limit');
}

function encodePowResponse(challengeConfig, answer) {
    return Buffer.from(JSON.stringify({
        algorithm: challengeConfig.algorithm,
        challenge: challengeConfig.challenge,
        salt: challengeConfig.salt,
        answer: answer,
        signature: challengeConfig.signature,
        target_path: challengeConfig.target_path
    })).toString('base64');
}

async function fetchJSON(url, options) {
    const r = await fetch(url, options);
    if (r.status === 429) throw new Error('Rate limit exceeded');
    if (r.status === 401) throw new Error('Authentication failed: invalid or expired token');
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
        const t = await r.text();
        throw new Error(`Non-JSON response (${r.status}): ${t.substring(0, 200)}`);
    }
    const d = await r.json();
    if (d.code !== 0 && d.code !== undefined) {
        throw new Error(`DeepSeek error ${d.code}: ${d.msg || 'Unknown'}`);
    }
    return d;
}

async function getPowToken(token, targetPath) {
    const d = await fetchJSON(`${BASE_URL}/chat/create_pow_challenge`, {
        method: 'POST',
        headers: buildHeaders(token),
        body: JSON.stringify({ target_path: targetPath })
    });
    const biz = d.data && d.data.biz_data;
    if (!biz || !biz.challenge) throw new Error('Empty PoW challenge response');
    const c = biz.challenge;
    const answer = solvePow(c);
    return encodePowResponse(c, answer);
}

async function createSession(token) {
    const d = await fetchJSON(`${BASE_URL}/chat_session/create`, {
        method: 'POST',
        headers: buildHeaders(token),
        body: JSON.stringify({ character_id: null })
    });
    const biz = d.data && d.data.biz_data;
    if (!biz) throw new Error('Empty session creation response');
    const cs = biz.chat_session;
    const id = (cs && cs.id) || biz.id;
    if (!id) throw new Error('No session ID in response');
    return id;
}

async function deleteSession(token, sessionId) {
    try {
        await fetch(`${BASE_URL}/chat_session/delete`, {
            method: 'POST',
            headers: buildHeaders(token),
            body: JSON.stringify({ chat_session_id: sessionId })
        });
    } catch (e) {}
}

async function uploadSingleFile(token, fileBuffer, fileName, modelType) {
    const pow = await getPowToken(token, '/api/v0/file/upload_file');
    const boundary = '----DSFormBoundary' + crypto.randomBytes(8).toString('hex');
    const crlf = '\r\n';
    const preamble = `--${boundary}${crlf}Content-Disposition: form-data; name="file"; filename="${fileName}"${crlf}Content-Type: application/octet-stream${crlf}${crlf}`;
    const epilogue = `${crlf}--${boundary}--${crlf}`;
    const bodyBuf = Buffer.concat([
        Buffer.from(preamble),
        fileBuffer,
        Buffer.from(epilogue)
    ]);

    const r = await fetch(`${BASE_URL}/file/upload_file`, {
        method: 'POST',
        headers: {
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Authorization': `Bearer ${token}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Origin': 'https://chat.deepseek.com',
            'Referer': 'https://chat.deepseek.com/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
            'X-App-Version': '20241129.1',
            'X-Client-Locale': 'en_US',
            'X-Client-Platform': 'web',
            'X-Client-Version': '2.0.0',
            'X-Model-Type': modelType || 'default',
            'x-ds-pow-response': pow
        },
        body: bodyBuf
    });

    if (r.status === 429) throw new Error('Rate limit exceeded during upload');
    if (r.status === 401) throw new Error('Authentication failed during upload');

    const d = await r.json();
    if (d.code !== 0) throw new Error(`Upload error ${d.code}: ${d.msg || 'Unknown'}`);
    const fileId = d.data && d.data.biz_data && d.data.biz_data.id;
    if (!fileId) throw new Error('No file ID in upload response');

    for (let i = 0; i < 30; i++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const fpow = await getPowToken(token, '/api/v0/chat/completion');
        const fr = await fetch(`${BASE_URL}/file/fetch_files?file_ids=${fileId}`, {
            method: 'GET',
            headers: buildHeaders(token, fpow)
        });
        if (!fr.ok) continue;
        const fd = await fr.json();
        const files = fd.data && fd.data.biz_data && fd.data.biz_data.files;
        if (files && files.length > 0) {
            const status = files[0].status;
            if (status === 'SUCCESS') return fileId;
            if (status !== 'PARSING') throw new Error(`File processing failed: ${status}`);
        }
    }
    throw new Error('File processing timeout after 60s');
}

function parseSseLine(line, state) {
    if (!line) return null;
    let ds;
    if (line.startsWith('data: ')) ds = line.substring(6);
    else if (line.startsWith('data:')) ds = line.substring(5);
    else return null;

    ds = ds.trim();
    if (!ds || ds === ':' || ds === '[DONE]') return null;

    let obj;
    try { obj = JSON.parse(ds); } catch (e) { return null; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

    if (obj.request_message_id !== undefined && obj.response_message_id !== undefined) {
        state.responseMessageId = obj.response_message_id;
        return null;
    }

    const val = obj.v;
    const path = obj.p || '';
    const op = obj.o || '';

    if (val && typeof val === 'object' && !Array.isArray(val)) {
        if (val.type === 'error') {
            return { type: 'error', value: val.content || val.finish_reason || 'Stream error' };
        }
        const resp = val.response;
        if (resp && typeof resp === 'object') {
            const frags = resp.fragments;
            if (Array.isArray(frags) && frags.length > 0) {
                let result = null;
                for (const frag of frags) {
                    if (frag && typeof frag === 'object') {
                        if (frag.type) state.fragmentType = frag.type;
                        if (typeof frag.content === 'string' && frag.content) {
                            result = {
                                type: state.fragmentType === 'THINK' ? 'thinking' : 'content',
                                value: frag.content
                            };
                        }
                    }
                }
                return result;
            }
            if (resp.status === 'FINISHED') return { type: 'done', value: '' };
            return null;
        }
        return null;
    }

    if (path === 'response/fragments' && op === 'APPEND' && Array.isArray(val)) {
        if (val.length > 0) {
            const last = val[val.length - 1];
            if (last && typeof last === 'object') {
                if (last.type) state.fragmentType = last.type;
                if (typeof last.content === 'string' && last.content) {
                    return {
                        type: state.fragmentType === 'THINK' ? 'thinking' : 'content',
                        value: last.content
                    };
                }
            }
        }
        return null;
    }

    if (path === 'response/fragments/-1/content') {
        if (typeof val === 'string' && val) {
            return {
                type: state.fragmentType === 'THINK' ? 'thinking' : 'content',
                value: val
            };
        }
        return null;
    }

    if (path === 'response/content') {
        state.phase = 'content';
        if (typeof val === 'string' && val) return { type: 'content', value: val };
        return null;
    }

    if (path === 'response/thinking_content') {
        state.phase = 'thinking';
        if (typeof val === 'string' && val) return { type: 'thinking', value: val };
        return null;
    }

    if (path === 'response/status') {
        if (val === 'FINISHED') return { type: 'done', value: '' };
        return null;
    }

    if (path) return null;

    if (typeof val === 'string' && val) {
        if (state.fragmentType !== null) {
            return {
                type: state.fragmentType === 'THINK' ? 'thinking' : 'content',
                value: val
            };
        }
        return {
            type: state.phase === 'thinking' ? 'thinking' : 'content',
            value: val
        };
    }

    return null;
}

async function chatCompletion(token, sessionId, prompt, thinkingEnabled, searchEnabled, modelType, refFileIds) {
    const pow = await getPowToken(token, '/api/v0/chat/completion');

    const payload = {
        chat_session_id: sessionId,
        parent_message_id: null,
        prompt: prompt,
        ref_file_ids: refFileIds || [],
        thinking_enabled: thinkingEnabled,
        search_enabled: searchEnabled,
        model_type: modelType,
        preempt: false,
        action: null
    };

    const response = await fetch(`${BASE_URL}/chat/completion`, {
        method: 'POST',
        headers: buildHeaders(token, pow),
        body: JSON.stringify(payload)
    });

    if (response.status === 429) throw new Error('Rate limit exceeded');
    if (response.status === 401) throw new Error('Authentication failed');
    if (!response.ok) {
        const t = await response.text();
        throw new Error(`Chat error ${response.status}: ${t.substring(0, 300)}`);
    }

    const ct = response.headers.get('content-type') || '';
    if (!ct.includes('text/event-stream') && !ct.includes('application/json')) {
        const t = await response.text();
        throw new Error(`Unexpected content-type (${ct}): ${t.substring(0, 200)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state = { phase: 'thinking', fragmentType: null, responseMessageId: null };
    let buffer = '';
    let fullContent = '';
    let fullThinking = '';
    let finished = false;

    while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || line.startsWith('event:') || line.startsWith(':')) continue;
            const parsed = parseSseLine(line, state);
            if (!parsed) continue;
            if (parsed.type === 'content') fullContent += parsed.value;
            else if (parsed.type === 'thinking') fullThinking += parsed.value;
            else if (parsed.type === 'error') throw new Error(parsed.value);
            else if (parsed.type === 'done') { finished = true; break; }
        }
    }

    return {
        response: fullContent.trim(),
        thinking: fullThinking.trim() || undefined,
        message_id: state.responseMessageId
    };
}

const handler = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
    }

    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid Authorization header. Use: Bearer <token>' });
    }
    const token = authHeader.substring(7);

    const body = req.body || {};
    const { prompt, thinking_enabled, search_enabled, mode, files } = body;

    if (!prompt && (!files || !Array.isArray(files) || files.length === 0)) {
        return res.status(400).json({ error: 'Missing "prompt" in request body' });
    }

    let modelType = 'default';
    if (mode === 'expert') modelType = 'expert';
    else if (mode === 'vision') modelType = 'vision';

    const thinkBool = thinking_enabled === true;
    const searchBool = search_enabled === true;
    const hasFiles = files && Array.isArray(files) && files.length > 0;

    if (modelType === 'expert' && hasFiles) modelType = 'default';
    if (hasFiles && searchBool) {
        return res.status(400).json({ error: 'search_enabled must be false when uploading files' });
    }

    let sessionId = null;
    try {
        sessionId = await createSession(token);

        let refFileIds = [];
        if (hasFiles) {
            for (const f of files) {
                if (!f.data || !f.name) throw new Error('Each file must have "name" and "data" (base64)');
                const buf = Buffer.from(f.data, 'base64');
                const fid = await uploadSingleFile(token, buf, f.name, modelType);
                refFileIds.push(fid);
            }
        }

        const result = await chatCompletion(
            token, sessionId, prompt || '', thinkBool, searchBool, modelType, refFileIds
        );

        return res.status(200).json({ status: 'success', ...result });
    } catch (error) {
        return res.status(500).json({ status: 'error', message: error.message });
    } finally {
        if (sessionId) await deleteSession(token, sessionId);
    }
};

export default allowCors(handler);