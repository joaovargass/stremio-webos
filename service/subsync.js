// Subtitle sync computed on the TV, with the same answer as the LAN sync service.
//
// The TV ffmpeg cuts a window of audio around the playback position (mono, low rate, raw
// samples on a pipe, nothing written to the small app partition). Every 10 ms frame becomes
// a speech-energy value, every subtitle cue a block of frames, and the subtitle is slid over
// the audio (FFT cross-correlation) for each common framerate ratio. The best lag gives the
// delay the player must apply at the playback position; the two halves of the window are
// aligned on their own and must agree, so an unrelated subtitle that fits by chance is
// rejected. Plain Node built-ins only, sized for the TV CPU.
var os = require('os');
var spawn = require('child_process').spawn;
var threads = (function() {
    // Worker threads keep the compute away from the streaming proxy; a runtime without them computes inline
    try { return require('worker_threads'); } catch (_) { return null; }
})();

var RATE = 8000;
var FRAME = 80;
var FPS = RATE / FRAME;
var TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/;
var RATIOS = [1, 25 / 23.976, 23.976 / 25, 24 / 23.976, 23.976 / 24, 25 / 24, 24 / 25];
var RATIO_MARGIN = 1.1;

function seconds(text) {
    // Parse an SRT or WebVTT timestamp, hours optional
    var m = TIME.exec(text);
    if (!m) return null;
    return parseInt(m[1] || '0', 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt((m[4] + '00').slice(0, 3), 10) / 1000;
}

function parseCues(text) {
    // Start and end of every cue of SRT or WebVTT content
    var cues = [];
    text.replace(/\r/g, '').split(/\n{2,}/).forEach(function(block) {
        var timing = block.split('\n').filter(function(line) { return line.indexOf('-->') !== -1; })[0];
        if (!timing) return;
        var parts = timing.split('-->');
        var start = seconds(parts[0]);
        var end = seconds(parts[1]);
        if (start !== null && end !== null && end > start) cues.push({ start: start, end: end });
    });
    return cues;
}

function cutAudio(ffmpeg, media, from, length, timeoutMs) {
    // Decode a window of the video's audio to 8 kHz mono 16-bit samples; seeking before the input reads only the needed byte ranges
    return new Promise(function(resolve, reject) {
        // WAV with 16-bit samples is what the small TV ffmpeg can write to a pipe; the header is skipped when reading
        var args = ['-nostdin', '-loglevel', 'error', '-ss', String(from), '-t', String(length), '-i', media, '-vn', '-ac', '1', '-ar', String(RATE), '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'];
        var child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        // Playback and the streaming server keep the CPU first; the cut only takes what is left
        try { os.setPriority(child.pid, 10); } catch (_) {}
        var chunks = [];
        var errors = '';
        var timer = setTimeout(function() { child.kill('SIGKILL'); }, timeoutMs);
        child.stdout.on('data', function(chunk) { chunks.push(chunk); });
        child.stderr.on('data', function(chunk) { errors = (errors + chunk).slice(-400); });
        child.on('error', function(err) { clearTimeout(timer); reject(err); });
        child.on('close', function(code) {
            clearTimeout(timer);
            var pcm = Buffer.concat(chunks);
            // A cut that ended early still serves when it holds enough audio
            if (code !== 0 && pcm.length < RATE * 2 * 30) return reject(new Error('ffmpeg failed (' + code + '): ' + errors.trim()));
            resolve(pcm);
        });
    });
}

function wavSamples(wav) {
    // Where the samples of a streamed WAV start: right after its "data" chunk header
    var at = wav.indexOf('data', 12, 'latin1');
    return at === -1 ? wav : wav.subarray(at + 8);
}

function speechEnergy(wav) {
    // Log energy per 10 ms frame after a high-pass that removes rumble and most music bass, centred and scaled
    var pcm = wavSamples(wav);
    var frames = Math.floor(pcm.length / 2 / FRAME);
    // A typed view over the aligned copy reads the little-endian samples without a call per sample
    var aligned = Buffer.alloc(frames * FRAME * 2);
    pcm.copy(aligned, 0, 0, aligned.length);
    var samples = new Int16Array(aligned.buffer, aligned.byteOffset, frames * FRAME);
    var energy = new Float64Array(frames);
    var prevIn = 0;
    var prevOut = 0;
    for (var f = 0, k = 0; f < frames; f++) {
        var sum = 0;
        for (var i = 0; i < FRAME; i++, k++) {
            // One-pole high-pass around 200 Hz at 8 kHz
            var y = 0.86 * (prevOut + samples[k] - prevIn);
            prevIn = samples[k];
            prevOut = y;
            sum += y * y;
        }
        energy[f] = Math.log(1 + sum / FRAME);
    }
    return standardize(energy);
}

function standardize(values) {
    // Zero mean and unit spread, clipped so a few loud bangs cannot dominate the match
    var n = values.length;
    var mean = 0;
    for (var i = 0; i < n; i++) mean += values[i];
    mean /= n || 1;
    var spread = 0;
    for (i = 0; i < n; i++) spread += (values[i] - mean) * (values[i] - mean);
    spread = Math.sqrt(spread / (n || 1)) || 1;
    for (i = 0; i < n; i++) values[i] = Math.max(-3, Math.min(3, (values[i] - mean) / spread));
    return values;
}

function cueMask(cues, ratio, from, frames) {
    // +1 on frames where a cue shows (times scaled by the framerate ratio, relative to the window), -1 elsewhere
    var mask = new Float64Array(frames).fill(-1);
    var active = 0;
    cues.forEach(function(cue) {
        var a = Math.max(0, Math.round((cue.start * ratio - from) * FPS));
        var b = Math.min(frames, Math.round((cue.end * ratio - from) * FPS));
        for (var f = a; f < b; f++) {
            if (mask[f] < 0) active++;
            mask[f] = 1;
        }
    });
    return { mask: mask, active: active };
}

function fft(re, im, inverse) {
    // In-place iterative radix-2 complex FFT
    var n = re.length;
    for (var i = 1, j = 0; i < n; i++) {
        var bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            var t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
        }
    }
    for (var len = 2; len <= n; len <<= 1) {
        var angle = (inverse ? 2 : -2) * Math.PI / len;
        var wr = Math.cos(angle);
        var wi = Math.sin(angle);
        for (i = 0; i < n; i += len) {
            var cr = 1;
            var ci = 0;
            for (var k = 0; k < len / 2; k++) {
                var ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
                var ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
                re[i + k + len / 2] = re[i + k] - ar;
                im[i + k + len / 2] = im[i + k] - ai;
                re[i + k] += ar;
                im[i + k] += ai;
                var nr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = nr;
            }
        }
    }
    if (inverse) for (i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

function spectrum(signal, size) {
    // Zero-padded FFT of a real signal
    var re = new Float64Array(size);
    var im = new Float64Array(size);
    re.set(signal);
    fft(re, im, false);
    return { re: re, im: im };
}

function correlate(audio, mask, size, count) {
    // sum over t of audio[t] * mask[t + k] for k = 0..count-1, as the inverse FFT of conj(audio) times mask
    var m = spectrum(mask, size);
    var re = new Float64Array(size);
    var im = new Float64Array(size);
    for (var i = 0; i < size; i++) {
        re[i] = audio.re[i] * m.re[i] + audio.im[i] * m.im[i];
        im[i] = audio.re[i] * m.im[i] - audio.im[i] * m.re[i];
    }
    fft(re, im, true);
    return re.subarray(0, count);
}

function bestLag(scores, maxLag) {
    // Highest score refined between frames with a parabola, and how far it stands above the other lags
    var best = 0;
    for (var i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
    var a = scores[best - 1];
    var c = scores[best + 1];
    var shift = a !== undefined && c !== undefined && a - 2 * scores[best] + c !== 0 ? 0.5 * (a - c) / (a - 2 * scores[best] + c) : 0;
    // Prominence against the lags farther than one second from the peak
    var others = [];
    for (i = 0; i < scores.length; i++) if (Math.abs(i - best) > FPS) others.push(scores[i]);
    var mean = others.reduce(function(s, v) { return s + v; }, 0) / (others.length || 1);
    var spread = Math.sqrt(others.reduce(function(s, v) { return s + (v - mean) * (v - mean); }, 0) / (others.length || 1)) || 1;
    return { lag: (best - maxLag + shift) / FPS, score: scores[best], prominence: (scores[best] - mean) / spread };
}

function alignWindow(energy, cues, from, maxOffsetS) {
    // Best framerate ratio and lag (speech time minus scaled cue time, in seconds) of the cues against audio starting at `from`
    var maxLag = Math.round(maxOffsetS * FPS);
    var frames = energy.length;
    var size = 1;
    while (size < frames + 2 * maxLag) size <<= 1;
    var audio = spectrum(energy, size);
    var best = null;
    RATIOS.forEach(function(ratio) {
        // Cues that may land in the audio once moved by up to the largest offset
        var near = cues.filter(function(c) { return c.end * ratio > from - maxOffsetS && c.start * ratio < from + frames / FPS + maxOffsetS; });
        // The mask starts one largest offset before the audio: mask frame u is time from - maxOffset + u / FPS
        var shaped = cueMask(near, ratio, from - maxOffsetS, frames + 2 * maxLag);
        if (shaped.active < FPS * 10) return;
        // Score index k pairs audio frame t with mask frame t + k, which is a lag of maxLag - k frames
        var scores = correlate(audio, shaped.mask, size, 2 * maxLag + 1);
        var byLag = new Float64Array(2 * maxLag + 1);
        for (var k = 0; k <= 2 * maxLag; k++) byLag[2 * maxLag - k] = scores[k];
        var found = bestLag(byLag, maxLag);
        found.ratio = ratio;
        found.cues = near.length;
        // Nearby ratios fit a short stretch almost equally, so a framerate change must clearly beat the unchanged timing
        var margin = ratio === 1 || (best && best.ratio !== 1) ? 1 : RATIO_MARGIN;
        if (!best || found.prominence > best.prominence * margin) best = found;
    });
    return best;
}

function delayAt(found, at) {
    // Delay to apply at the playback position: the cue shown there was written for speech at (at - lag) / ratio
    return at - (at - found.lag) / found.ratio;
}

function measure(job) {
    // Energy, alignment and the two-halves check of one cut window; plain data in and out so it can run on a worker thread
    var energy = speechEnergy(Buffer.from(job.wav.buffer, job.wav.byteOffset, job.wav.byteLength));
    var options = job.options;
    var audioS = energy.length / FPS;
    var inWindow = job.cues.filter(function(c) { return c.start >= job.from && c.end <= job.from + audioS; }).length;
    if (inWindow < options.minCues) throw new Error('too few cues in the window (' + inWindow + ')');
    var full = alignWindow(energy, job.cues, job.from, options.maxOffsetS);
    if (!full) throw new Error('too little subtitle time in the window');
    // The second half of the audio on its own must land on the same delay, since an unrelated subtitle fits a long stretch by chance
    var half = Math.floor(energy.length / 2);
    var second = alignWindow(standardize(energy.slice(half)), job.cues, job.from + half / FPS, options.maxOffsetS);
    var offset = delayAt(full, options.at);
    var disagreement = second ? Math.abs(offset - delayAt(second, options.at)) : Infinity;
    var confidence = disagreement > options.agreeS ? 0 : Math.min(1, full.prominence / options.goodProminence);
    return {
        offsetMs: Math.round(offset * 1000), scale: Number(full.ratio.toFixed(5)), confidence: Number(confidence.toFixed(3)),
        prominence: Number(full.prominence.toFixed(2)), disagreementMs: Math.round(Math.min(disagreement, 999.999) * 1000),
        cues: full.cues, audioS: Math.round(audioS)
    };
}

function measureOffThread(job) {
    // The proxy streams video on the main thread, so the second-long compute runs on a worker; inline only when workers are missing
    if (!threads) return Promise.resolve().then(function() { return measure(job); });
    return new Promise(function(resolve, reject) {
        var worker = new threads.Worker(__filename, { workerData: { subsyncJob: job } });
        worker.once('message', function(reply) { return reply.error ? reject(new Error(reply.error)) : resolve(reply.result); });
        worker.once('error', reject);
        worker.once('exit', function(code) { if (code !== 0) reject(new Error('sync worker stopped with code ' + code)); });
    });
}

function sync(options) {
    // Align a subtitle with the audio of a window ending shortly after the playback position, checked by its two halves
    var started = Date.now();
    var cues = parseCues(options.subtitle);
    var from = Math.max(0, options.at + options.leadS - options.windowS);
    var settings = { at: options.at, minCues: options.minCues, maxOffsetS: options.maxOffsetS, agreeS: options.agreeS, goodProminence: options.goodProminence };
    var cutMs = 0;
    return cutAudio(options.ffmpeg, options.media, from, options.windowS, options.timeoutMs).then(function(wav) {
        cutMs = Date.now() - started;
        return measureOffThread({ wav: new Uint8Array(wav.buffer, wav.byteOffset, wav.byteLength), cues: cues, from: from, options: settings });
    }).then(function(result) {
        return Object.assign(result, { cutMs: cutMs, computeMs: Date.now() - started - cutMs, tookMs: Date.now() - started, on: 'tv' });
    });
}

// Inside a sync worker: measure the job it was given and hand the result back
if (threads && !threads.isMainThread && threads.workerData && threads.workerData.subsyncJob) {
    try {
        threads.parentPort.postMessage({ result: measure(threads.workerData.subsyncJob) });
    } catch (err) {
        threads.parentPort.postMessage({ error: err.message });
    }
}

module.exports = {
    sync: sync,
    parseCues: parseCues,
    speechEnergy: speechEnergy,
    alignWindow: alignWindow,
    delayAt: delayAt
};
