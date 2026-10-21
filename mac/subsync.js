// Subtitle sync service for the webOS app, run on the Mac next to the streaming server.
//
// GET /sync?media=<video url>&sub=<subtitle url>&at=<seconds>
// cuts a window of audio that ends shortly after the playback position with ffmpeg (HTTP
// range reads of data the server just delivered, never the whole file), aligns the subtitle cues of that window to the speech with
// ffsubsync and answers { offsetMs, scale, confidence, cues, spreadMs } where offsetMs is
// the delay the player must apply at the playback position so the cues match the voices
// (framerate drift included) and confidence is the aligner score per 10 ms audio frame
// (about 0.9 for a matching subtitle, about 0.2 for an unrelated one). Only Node built-ins are used.
//
// Env: SUBSYNC_PORT (11481), FFMPEG_BIN, FFS_BIN, SUBSYNC_WINDOW_S (240), SUBSYNC_LEAD_S (60), SUBSYNC_MAX_OFFSET_S (60)
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PORT = parseInt(process.env.SUBSYNC_PORT || '11481', 10);
const FFMPEG = process.env.FFMPEG_BIN || '/opt/homebrew/bin/ffmpeg';
const FFS = process.env.FFS_BIN || path.join(os.homedir(), '.local/share/stremio-subsync/venv/bin/ffs');
const WINDOW_S = parseInt(process.env.SUBSYNC_WINDOW_S || '240', 10);
const LEAD_S = parseInt(process.env.SUBSYNC_LEAD_S || '60', 10);
const MAX_OFFSET_S = parseInt(process.env.SUBSYNC_MAX_OFFSET_S || '60', 10);
const AGREE_S = 0.3;
const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/;
const cache = new Map();
let queue = Promise.resolve();

function log(...args) {
    // Timestamped lines for the launchd log
    console.log(new Date().toISOString(), ...args);
}

function seconds(text) {
    // Parse an SRT or WebVTT timestamp, hours optional
    const m = TIME.exec(text);
    if (!m) return null;
    return (parseInt(m[1] || '0', 10) * 3600) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4].padEnd(3, '0'), 10) / 1000;
}

function parseCues(text) {
    // Read start, end and text of every cue from SRT or WebVTT content
    const cues = [];
    const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
    for (const block of blocks) {
        const lines = block.split('\n');
        const timing = lines.findIndex((l) => l.includes('-->'));
        if (timing === -1) continue;
        const [from, to] = lines[timing].split('-->');
        const start = seconds(from);
        const end = seconds(to);
        if (start === null || end === null) continue;
        cues.push({ start, end, text: lines.slice(timing + 1).join('\n').trim() });
    }
    return cues;
}

function srtTime(value) {
    // Format seconds as an SRT timestamp
    const ms = Math.max(0, Math.round(value * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor(ms % 3600000 / 60000);
    const s = Math.floor(ms % 60000 / 1000);
    const pad = (n, w) => String(n).padStart(w, '0');
    return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms % 1000, 3)}`;
}

function writeSrt(file, cues) {
    // Write cues as a minimal SRT file
    const body = cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
    fs.writeFileSync(file, body);
}

function run(bin, args, timeoutMs) {
    // Run a tool, resolve with its combined output and reject with its stderr on failure
    return new Promise((resolve, reject) => {
        execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(`${path.basename(bin)} failed: ${String(stderr || err.message).slice(-400)}`));
            resolve(`${stdout}\n${stderr}`);
        });
    });
}

function median(values) {
    // Middle value, robust to the few cues the aligner could not place
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function fitLine(xs, ys) {
    // Least squares line of the aligned times against the original times
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
        num += (xs[i] - mx) * (ys[i] - my);
        den += (xs[i] - mx) * (xs[i] - mx);
    }
    const slope = den ? num / den : 1;
    return { slope, intercept: my - slope * mx };
}

function pairCues(original, aligned) {
    // Pair cues by text in order, since the aligner drops cues pushed before the start of the audio
    const pairs = [];
    let from = 0;
    for (const cue of aligned) {
        for (let i = from; i < original.length && i < from + 20; i++) {
            if (original[i].text === cue.text) {
                pairs.push([original[i].start, cue.start]);
                from = i + 1;
                break;
            }
        }
    }
    return pairs;
}

async function align(dir, name, wav, cues) {
    // Run ffsubsync on one set of cues against the cut audio and fit the result
    const input = path.join(dir, `${name}.in.srt`);
    const output = path.join(dir, `${name}.out.srt`);
    writeSrt(input, cues);
    const log = await run(FFS, [wav, '-i', input, '-o', output, '--max-offset-seconds', String(MAX_OFFSET_S)], 240000);
    const pairs = pairCues(cues, parseCues(fs.readFileSync(output, 'utf8')));
    if (pairs.length < 8) throw new Error('aligner returned too few cues');
    const score = parseFloat((/score:\s*([\d.]+)/.exec(log) || [])[1] || '0');
    const line = fitLine(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
    const spread = median(pairs.map((p) => Math.abs(p[1] - (line.intercept + line.slope * p[0]))));
    return { line, score, spread, cues: pairs.length };
}

function offsetAt(line, at0) {
    // A framerate mismatch makes the shift grow over time: find the subtitle time shown at the playback position
    return at0 - (at0 - line.intercept) / line.slope;
}

async function sync(media, sub, at) {
    // Align the subtitle cues of a window ending shortly after the playback position to the speech in it
    const started = Date.now();
    // Mostly behind the playhead: those bytes are cached on the server, so the cut is fast and downloads nothing new
    const winStart = Math.max(0, at + LEAD_S - WINDOW_S);
    const resp = await fetch(sub);
    if (!resp.ok) throw new Error(`subtitle download failed: ${resp.status}`);
    const all = parseCues(await resp.text());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subsync-'));
    try {
        const wav = path.join(dir, 'audio.wav');
        // Seeking before -i reads only the needed byte ranges of the remote file
        await run(FFMPEG, ['-nostdin', '-loglevel', 'error', '-ss', String(winStart), '-t', String(WINDOW_S), '-i', media, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wav], 240000);
        // Near the end of a video the cut audio is shorter than the window
        const audioS = Math.max(0, (fs.statSync(wav).size - 44) / 2 / 16000);
        // Only cues inside the cut audio: cues past its end have no voice to match and pull the alignment off
        const cues = all.filter((c) => c.start >= winStart && c.end <= winStart + audioS)
            .map((c) => ({ start: c.start - winStart, end: c.end - winStart, text: c.text || '...' }));
        if (cues.length < 16) throw new Error(`too few cues in the window (${cues.length})`);
        const at0 = at - winStart;
        const full = await align(dir, 'full', wav, cues);
        // Two independent checks must agree: the second half of the cues against the second half of the audio only,
        // since half of the cues against all of the audio fits anywhere in continuous speech
        const halfS = audioS / 2;
        const halfWav = path.join(dir, 'half.wav');
        await run(FFMPEG, ['-nostdin', '-loglevel', 'error', '-ss', String(halfS), '-i', wav, '-c', 'copy', halfWav], 60000);
        const halfCues = cues.filter((c) => c.start >= halfS).map((c) => ({ start: c.start - halfS, end: c.end - halfS, text: c.text }));
        const half = await align(dir, 'half', halfWav, halfCues);
        const offset = offsetAt(full.line, at0);
        const disagreement = Math.abs(offset - offsetAt(half.line, at0 - halfS));
        const confidence = disagreement > AGREE_S ? 0 : full.score / Math.max(1, audioS * 100);
        return {
            offsetMs: Math.round(offset * 1000), scale: Number(full.line.slope.toFixed(5)), confidence: Number(confidence.toFixed(3)),
            disagreementMs: Math.round(disagreement * 1000), cues: full.cues, spreadMs: Math.round(full.spread * 1000), tookMs: Date.now() - started
        };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function answer(res, status, body) {
    // JSON response readable from the TV app
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body));
}

http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') return answer(res, 200, { ok: true, ffs: fs.existsSync(FFS) });
    if (url.pathname !== '/sync') return answer(res, 404, { error: 'not found' });
    const media = url.searchParams.get('media');
    const sub = url.searchParams.get('sub');
    const at = parseFloat(url.searchParams.get('at') || '0');
    if (!media || !sub) return answer(res, 400, { error: 'media and sub are required' });
    // One result per subtitle and audio-window slot, so repeated requests are free
    const key = `${media}|${sub}|${Math.floor(at / WINDOW_S)}`;
    if (cache.has(key)) return answer(res, 200, Object.assign({ cached: true }, cache.get(key)));
    // Jobs run one at a time to keep ffmpeg and the aligner from competing for the CPU
    queue = queue.then(() => sync(media, sub, at)).then((result) => {
        cache.set(key, result);
        log('synced', JSON.stringify(result), sub);
        answer(res, 200, result);
    }, (err) => {
        log('sync failed', err.message, sub);
        answer(res, 500, { error: err.message });
    });
}).listen(PORT, () => log(`subsync listening on :${PORT}, ffs=${FFS}`));
