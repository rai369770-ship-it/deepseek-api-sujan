import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import crypto from 'crypto';
import https from 'https';
import vm from 'vm';
import FormData from 'form-data';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({ dest: os.tmpdir() });

const CONFIG = {
    BASE_URL: "https://chat.deepseek.com/api/v0",
    HEADERS: {
        'User-Agent': 'DeepSeek/1.6.4 Android/35',
        'Accept': 'application/json',
        'x-client-platform': 'android',
        'x-client-version': '1.6.4',
        'x-client-locale': 'id',
        'x-client-bundle-id': 'com.deepseek.chat',
        'x-rangers-id': '7392079989945982465',
        'accept-charset': 'UTF-8'
    }
};

const WORKER_URL = 'https://static.deepseek.com/chat/static/33614.25c7f8f220.js';
const WASM_URL = 'https://static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

let workerCache = null;
let wasmCache = null;

const EMAIL = process.env.DEEPSEEK_EMAIL || '';
const PASSWORD = process.env.DEEPSEEK_PASSWORD || '';

let cachedToken = null;
let tokenExpiry = 0;

const utils = {
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),

    generateDeviceId: () => {
        const baseId = "BUelgEoBdkHyhwE8q/4YOodITQ1Ef99t7Y5KAR4CyHwdApr+lf4LJ+QAKXEUJ2lLtPQ+mmFtt6MpbWxpRmnWITA==";
        let chars = baseId.split('');
        const start = 50;
        const end = 70;
        const changes = Math.floor(Math.random() * 3) + 2;
        const possibleChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        for (let i = 0; i < changes; i++) {
            const randomIndex = Math.floor(Math.random() * (end - start)) + start;
            chars[randomIndex] = possibleChars.charAt(Math.floor(Math.random() * possibleChars.length));
        }
        return chars.join('');
    },

    parseSSE: (chunk) => {
        const lines = chunk.toString().split('\n');
        const events = [];
        let currentEvent = { event: 'message', data: '' };
        for (const line of lines) {
            if (line.startsWith('event:')) {
                if (currentEvent.data) events.push({ ...currentEvent });
                currentEvent = { event: line.substring(6).trim(), data: '' };
            } else if (line.startsWith('data:')) {
                currentEvent.data += line.substring(5).trim();
            } else if (line === '' && currentEvent.data) {
                events.push({ ...currentEvent });
                currentEvent = { event: 'message', data: '' };
            }
        }
        if (currentEvent.data) events.push(currentEvent);
        return events;
    }
};

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
    const jsonBody = {
        algorithm: originalPayload.algorithm,
        challenge: originalPayload.challenge,
        salt: originalPayload.salt,
        answer: answer,
        signature: originalPayload.signature,
        target_path: originalPayload.target_path
    };
    return Buffer.from(JSON.stringify(jsonBody)).toString('base64');
}

async function solvePow(payload) {
    const cleanPayload = {
        algorithm: payload.algorithm,
        challenge: payload.challenge,
        salt: payload.salt,
        difficulty: payload.difficulty,
        signature: payload.signature,
        expireAt: payload.expire_at || payload.expireAt
    };

    const { workerScript, wasmBuffer } = await loadAssets();

    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error('PoW timeout'));
        }, 60000);

        class MockResponse {
            constructor(buffer) {
                this.buffer = buffer;
                this.ok = true;
                this.status = 200;
                this.headers = { get: () => 'application/wasm' };
            }
            async arrayBuffer() { return this.buffer; }
        }

        const sandbox = {
            console: { log: () => {} },
            setTimeout, clearTimeout, setInterval, clearInterval,
            TextEncoder, TextDecoder, URL,
            Response: MockResponse,
            location: {
                href: WORKER_URL,
                origin: 'https://static.deepseek.com',
                pathname: '/chat/static/33614.25c7f8f220.js',
                toString: () => WORKER_URL
            },
            WebAssembly: {
                Module: WebAssembly.Module,
                Instance: WebAssembly.Instance,
                instantiate: WebAssembly.instantiate,
                validate: WebAssembly.validate,
                Memory: WebAssembly.Memory,
                Table: WebAssembly.Table,
                Global: WebAssembly.Global,
                CompileError: WebAssembly.CompileError,
                LinkError: WebAssembly.LinkError,
                RuntimeError: WebAssembly.RuntimeError
            },
            fetch: async (input) => {
                if (input.toString().includes('wasm')) return new MockResponse(wasmBuffer);
                throw new Error("Blocked");
            },
            postMessage: (msg) => {
                if (msg && msg.type === 'pow-answer') {
                    clearTimeout(timeoutId);
                    resolve(generateFinalToken(payload, msg.answer.answer));
                } else if (msg && msg.type === 'pow-error') {
                    clearTimeout(timeoutId);
                    reject(new Error('POW worker error: ' + JSON.stringify(msg.error)));
                }
            }
        };

        sandbox.self = sandbox;
        sandbox.window = sandbox;
        sandbox.globalThis = sandbox;

        const context = vm.createContext(sandbox);

        try {
            vm.runInContext(workerScript, context);
            setTimeout(() => {
                if (sandbox.onmessage) {
                    sandbox.onmessage({ data: { type: "pow-challenge", challenge: cleanPayload } });
                } else if (sandbox.self && sandbox.self.onmessage) {
                    sandbox.self.onmessage({ data: { type: "pow-challenge", challenge: cleanPayload } });
                } else {
                    reject(new Error('Worker has no onmessage handler'));
                }
            }, 1000);
        } catch (e) {
            clearTimeout(timeoutId);
            reject(e);
        }
    });
}

async function getPowToken(token, targetPath) {
    try {
        const response = await axios.post(`${CONFIG.BASE_URL}/chat/create_pow_challenge`,
            { target_path: targetPath },
            { headers: { ...CONFIG.HEADERS, 'Authorization': `Bearer ${token}` } }
        );
        const challengeData = response.data.data.biz_data.challenge;
        return await solvePow(challengeData);
    } catch (e) {
        return null;
    }
}

async function login(email, password) {
    const deviceId = utils.generateDeviceId();
    const response = await axios.post(`${CONFIG.BASE_URL}/users/login`, {
        email, password, device_id: deviceId, os: 'android'
    }, { headers: CONFIG.HEADERS });
    if (response.data.code !== 0) throw new Error(response.data.msg);
    return response.data.data.biz_data.user.token;
}

async function getToken() {
    if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
    cachedToken = await login(EMAIL, PASSWORD);
    tokenExpiry = Date.now() + 3600000;
    return cachedToken;
}

async function createSession(token) {
    const response = await axios.post(`${CONFIG.BASE_URL}/chat_session/create`, {}, {
        headers: { ...CONFIG.HEADERS, 'Authorization': `Bearer ${token}` }
    });
    if (response.data.code !== 0) throw new Error('Failed to create session');
    return response.data.data.biz_data.id;
}

async function deleteSession(token, sessionId) {
    await axios.post(`${CONFIG.BASE_URL}/chat_session/delete`,
        { chat_session_id: sessionId },
        { headers: { ...CONFIG.HEADERS, 'Authorization': `Bearer ${token}` } }
    );
}

async function uploadFile(token, filePath, originalName) {
    const stats = fs.statSync(filePath);
    const stream = fs.createReadStream(filePath);
    const powToken = await getPowToken(token, '/api/v0/file/upload_file');
    if (!powToken) throw new Error('Failed to solve PoW for upload');

    const form = new FormData();
    form.append('file', stream, { filename: originalName });

    const headers = {
        ...CONFIG.HEADERS,
        ...form.getHeaders(),
        'Authorization': `Bearer ${token}`,
        'x-ds-pow-response': powToken,
        'x-file-size': stats.size.toString(),
        'x-thinking-enabled': '0'
    };

    const response = await axios.post(`${CONFIG.BASE_URL}/file/upload_file`, form, { headers });
    if (response.data.code !== 0) throw new Error('Upload failed');

    const fileId = response.data.data.biz_data.id;
    let attempts = 0;
    const maxAttempts = 30;

    while (attempts < maxAttempts) {
        await utils.sleep(2000);
        const checkRes = await axios.get(`${CONFIG.BASE_URL}/file/fetch_files?file_ids=${fileId}`, {
            headers: { ...CONFIG.HEADERS, 'Authorization': `Bearer ${token}` }
        });
        if (checkRes.data.code === 0) {
            const fileData = checkRes.data.data.biz_data.files[0];
            if (fileData.status === 'SUCCESS') return fileId;
            if (fileData.status === 'FAILED') throw new Error('File processing failed');
        }
        attempts++;
    }
    throw new Error('File processing timeout');
}

async function chat(token, sessionId, prompt, options = {}) {
    const powToken = await getPowToken(token, '/api/v0/chat/completion');
    if (!powToken) throw new Error('Failed to solve PoW');

    const payload = {
        chat_session_id: sessionId,
        parent_message_id: null,
        prompt: prompt,
        ref_file_ids: options.fileIds || [],
        thinking_enabled: options.thinkingEnabled || false,
        search_enabled: options.searchEnabled || false,
        audio_id: null
    };

    const response = await axios.post(`${CONFIG.BASE_URL}/chat/completion`, payload, {
        headers: {
            ...CONFIG.HEADERS,
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'x-ds-pow-response': powToken
        },
        responseType: 'stream'
    });

    let fullText = '';
    let thoughtText = '';
    let searchResults = [];
    let sessionTitle = '';
    let currentFragment = null;
    let buffer = '';

    const findFragmentType = (obj) => {
        if (obj.type === 'THINK' || obj.type === 'SEARCH' || obj.type === 'RESPONSE') return obj.type;
        if (Array.isArray(obj.v)) {
            for (const item of obj.v) {
                const found = findFragmentType(item);
                if (found) return found;
            }
        }
        return null;
    };

    return new Promise((resolve, reject) => {
        response.data.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const events = utils.parseSSE(line + '\n\n');
                for (const event of events) {
                    if (!event.data || event.data === ':' || event.event === 'keep-alive') continue;

                    if (event.event === 'title') {
                        try {
                            const titleData = JSON.parse(event.data);
                            sessionTitle = titleData.content;
                        } catch (e) {}
                        continue;
                    }

                    try {
                        const parsed = JSON.parse(event.data);
                        const newType = findFragmentType(parsed);
                        if (newType) {
                            if (currentFragment !== newType) currentFragment = newType;
                        }

                        let resultsFound = null;
                        if (parsed.p && parsed.p.endsWith('results') && Array.isArray(parsed.v)) {
                            resultsFound = parsed.v;
                        } else if (parsed.v && Array.isArray(parsed.v)) {
                            const searchInV = (arr) => {
                                for (let item of arr) {
                                    if (item.results && Array.isArray(item.results)) return item.results;
                                    if (item.v && Array.isArray(item.v)) {
                                        const found = searchInV(item.v);
                                        if (found) return found;
                                    }
                                }
                                return null;
                            };
                            resultsFound = searchInV(parsed.v);
                        }

                        if (resultsFound) {
                            searchResults = [...searchResults, ...resultsFound];
                        }

                        const extractText = (obj) => {
                            if (obj.content && typeof obj.content === 'string') return obj.content;
                            if (Array.isArray(obj.v)) return obj.v.map(extractText).join('');
                            return '';
                        };

                        let contentToAdd = extractText(parsed);
                        if (!contentToAdd && typeof parsed.v === 'string') {
                            if (!parsed.p || parsed.p.endsWith('content')) contentToAdd = parsed.v;
                        }

                        if (contentToAdd) {
                            if (!currentFragment) currentFragment = 'RESPONSE';
                            if (currentFragment === 'THINK') thoughtText += contentToAdd;
                            else if (currentFragment === 'RESPONSE') fullText += contentToAdd;
                        }
                    } catch (e) {}
                }
            }
        });

        response.data.on('end', () => {
            resolve({
                status: 'success',
                session_title: sessionTitle,
                thinking: thoughtText.trim() || undefined,
                search_results: searchResults.length > 0 ? searchResults : undefined,
                response: fullText.trim()
            });
        });

        response.data.on('error', (err) => {
            resolve({ status: 'error', message: err.message });
        });
    });
}

function parseBool(val) {
    if (val === undefined || val === null) return false;
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') return val.toLowerCase() === 'true' || val === '1';
    return Boolean(val);
}

async function handleChat(prompt, searchEnabled, thinkingEnabled, file) {
    if (!prompt) throw new Error('prompt is required');

    const token = await getToken();
    const sessionId = await createSession(token);

    try {
        let fileIds = [];

        if (file) {
            const fileId = await uploadFile(token, file.path, file.originalname);
            fileIds.push(fileId);
        }

        const result = await chat(token, sessionId, prompt, {
            searchEnabled: parseBool(searchEnabled),
            thinkingEnabled: parseBool(thinkingEnabled),
            fileIds
        });

        return result;
    } finally {
        try { await deleteSession(token, sessionId); } catch (e) {}
        if (file && fs.existsSync(file.path)) {
            try { fs.unlinkSync(file.path); } catch (e) {}
        }
    }
}

app.get('/api/chat', async (req, res) => {
    try {
        const { prompt, search, thinking } = req.query;
        const result = await handleChat(prompt, search, thinking, null);
        res.json(result);
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.post('/api/chat', upload.single('file'), async (req, res) => {
    try {
        const prompt = req.body.prompt;
        const search = req.body.search;
        const thinking = req.body.thinking;
        const file = req.file || null;
        const result = await handleChat(prompt, search, thinking, file);
        res.json(result);
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.get('/', (req, res) => {
    res.json({
        status: 'active',
        endpoints: {
            'GET /api/chat': {
                params: { prompt: 'string', search: 'bool', thinking: 'bool' }
            },
            'POST /api/chat': {
                body: { prompt: 'string', search: 'bool', thinking: 'bool', file: 'multipart file (optional)' }
            }
        }
    });
});
export default app;
});

export default app;