// AI recommendation service for the webOS app, run on the computer next to the streaming server.
//
// The TV sends a compact summary of the viewer's history and a pool of candidate titles; a local model (Ollama)
// answers with one or two themed rows picked from that pool only, with a short reason each. The answer is checked:
// ids outside the pool are dropped, so nothing invented reaches the screen. One job runs at a time, and the last
// answer of each period (daily, weekly) is kept in memory. Only Node built-ins are used.
//
// Env: AI_PORT (11482), OLLAMA_URL (http://127.0.0.1:11434), OLLAMA_MODEL (gemma4:12b), AI_TIMEOUT_MS (240000)
'use strict';

const http = require('http');
const crypto = require('crypto');

const PORT = parseInt(process.env.AI_PORT || '11482', 10);
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const MODEL = process.env.OLLAMA_MODEL || 'gemma4:12b';
const TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS || '240000', 10);
const MAX_BODY = 400000;
const MIN_ROW = 6;
const MAX_ROW = 15;
const SCHEMA = {
    type: 'object',
    properties: {
        rows: {
            type: 'array',
            maxItems: 2,
            items: {
                type: 'object',
                properties: { title: { type: 'string' }, reason: { type: 'string' }, ids: { type: 'array', items: { type: 'string' } } },
                required: ['title', 'reason', 'ids']
            }
        }
    },
    required: ['rows']
};
const answers = {};
let queue = Promise.resolve();

function log(...args) {
    // Timestamped lines for the service log
    console.log(new Date().toISOString(), ...args);
}

function readBody(req) {
    // The JSON body of a request, refused when it is too large
    return new Promise((resolve, reject) => {
        let size = 0;
        const parts = [];
        req.on('data', (part) => {
            size += part.length;
            if (size > MAX_BODY) return reject(new Error('request too large'));
            parts.push(part);
        });
        req.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch (err) { reject(new Error('request is not JSON')); }
        });
        req.on('error', reject);
    });
}

function prompt(body) {
    // Instructions and the data for the model, in the viewer's language
    const period = body.period === 'weekly' ? 'this week' : 'today';
    const language = body.language === 'pt-BR' ? 'Brazilian Portuguese' : 'English';
    const history = (body.history || []).slice(0, 40).map((h) => `${h.name} (${h.type}, ${h.year || '?'}; ${(h.genres || []).join(', ')}; watched ${Math.round((h.engagement || 0) * 100)}%)`).join('\n');
    const pool = (body.candidates || []).slice(0, 150).map((c) => `${c.id} | ${c.name} | ${c.type} | ${c.year || '?'} | ${(c.genres || []).join(', ')} | IMDb ${c.rating || '?'}`).join('\n');
    return [
        { role: 'system', content: `You are the recommendation curator of a streaming app. From the candidate list only, build up to 2 themed rows for ${period} that fit what this viewer watched. Each row has a short catchy title in ${language} (at most 6 words), a one-sentence reason in ${language}, and ${MIN_ROW} to ${MAX_ROW} ids copied exactly from the candidate list, best first. Never use an id that is not in the list. Prefer variety across rows.` },
        { role: 'user', content: `Viewer history, most recent first:\n${history}\n\nCandidates (id | name | type | year | genres | rating):\n${pool}` }
    ];
}

function askModel(body) {
    // One structured answer from the local model, within the time limit
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    return fetch(OLLAMA_URL + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Thinking off and a capped answer: the schema already gives the shape, and a thinking model takes minutes instead of seconds
        body: JSON.stringify({ model: body.model || MODEL, stream: false, think: false, format: SCHEMA, messages: prompt(body), options: { temperature: 0.4, num_predict: 900 } }),
        signal: controller.signal
    }).then((res) => res.json()).finally(() => clearTimeout(timer));
}

function checked(reply, candidates) {
    // Keep only ids from the pool, once each, and rows long enough to be worth a row
    const allowed = new Set((candidates || []).map((c) => c.id));
    let parsed = {};
    try { parsed = JSON.parse((reply && reply.message && reply.message.content) || '{}'); } catch (err) { log('model answer is not JSON:', err.message); }
    const used = new Set();
    return (parsed.rows || []).map((row) => ({
        title: String(row.title || '').slice(0, 60),
        reason: String(row.reason || '').slice(0, 200),
        ids: (row.ids || []).filter((id) => allowed.has(id) && !used.has(id) && used.add(id)).slice(0, MAX_ROW)
    })).filter((row) => row.title && row.ids.length >= MIN_ROW);
}

function recommend(body) {
    // The rows for one period, reused while the same history and pool are asked again
    const key = crypto.createHash('sha1').update(JSON.stringify([body.period, body.language, body.history, (body.candidates || []).map((c) => c.id)])).digest('hex');
    if (answers[key]) return Promise.resolve(answers[key]);
    // One model job at a time: the computer stays responsive and the TV's next request reuses the answer
    const job = queue.then(() => {
        const started = Date.now();
        return askModel(body).then((reply) => {
            const rows = checked(reply, body.candidates);
            log(`${body.period} rows from ${body.model || MODEL} in ${Date.now() - started} ms:`, rows.map((r) => `${r.title} (${r.ids.length})`).join(' | ') || 'none usable');
            answers[key] = { rows: rows, model: body.model || MODEL, at: Date.now() };
            return answers[key];
        });
    });
    queue = job.catch(() => {});
    return job;
}

function send(res, status, body) {
    // JSON answer for the TV
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

http.createServer((req, res) => {
    // POST /recommend builds rows; GET /health says which model answers
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, model: MODEL });
    if (req.method !== 'POST' || req.url !== '/recommend') return send(res, 404, { error: 'not found' });
    readBody(req).then(recommend).then((answer) => send(res, 200, answer)).catch((err) => {
        log('recommendation failed:', err.message);
        send(res, 502, { error: err.message });
    });
}).listen(PORT, () => log(`AI recommendations on :${PORT} with ${MODEL}`));
