// Service log kept in memory for the on-screen debug log and the log viewer.
//
// Every console line of this process (the proxy and the bundled streaming server) is sanitized and kept in one ring
// per level, so a stream of request traces never pushes a warning out. Request lines of the streaming server become
// short sentences that keep the raw request beside them, and the polls the pages repeat every few seconds are kept
// once a minute with a count of the repeats instead of filling the ring.
var util = require('util');

var RANK = { error: 0, warn: 0, log: 1, info: 1, verbose: 2 };
var DETAIL = { essential: 0, detailed: 1, everything: 2 };
var TORRENT_PATH = /^\/([0-9a-f]{40})(?:\/(\d+))?(\/[^?]*)?$/i;
var REQUEST = /^-> (\w+) ?(\S*)\s*(.*)$/;
var CACHE_CLEANUP = /^Resizing cache size to \S+ from \S+ by deleting (\d+) files/;
var ENGINE_DETAIL = /^(hls-converter - |hls executables|Using app path|EngineFS|Resizing cache)/;
var PERIODIC = /^(Stremio checked that the streaming server answers|Read the state of|Read the file map of)/;
var REPEAT_WINDOW_MS = 60000;
var rings = [[], [], []];
var limits = [200, 300, 400];
var seq = 0;
var repeats = {};

function safeText(text) {
    // Credentials and personal data never reach the log; media paths stay, since they are what a diagnosis needs
    return String(text)
        .replace(/\b(https?:\/\/)([^/\s?#@]+(?::[^/@\s?#]*)?@)/gi, '$1[REDACTED]@')
        .replace(/([?&](?:access_token|token|key|auth|password|profile|sessionToken|from)=)[^&\s]+/gi, '$1[REDACTED]')
        .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]');
}

function megabytes(bytes) {
    // A byte offset in megabytes with one decimal
    return (bytes / 1048576).toFixed(1) + ' MB';
}

function rangeText(range) {
    // The part of the file a "bytes=from-to" range asks for
    var match = /bytes=(\d+)-(\d*)/.exec(range || '');
    if (!match) return '';
    return ', ' + (match[2] ? megabytes(+match[1]) + ' to ' + megabytes(+match[2] + 1) : 'from ' + megabytes(+match[1]));
}

function torrentRequest(method, torrent, range) {
    // A request about one torrent or one of its files, named by the first characters of its hash
    var name = 'torrent ' + torrent[1].slice(0, 8).toLowerCase() + (torrent[2] !== undefined ? ' file ' + torrent[2] : '');
    var rest = torrent[3] || '';
    if (rest === '/stats.json') return 'Read the state of ' + name;
    if (rest === '/pieces.json') return 'Read the file map of ' + name;
    if (rest === '/create') return 'Started ' + name + ' with its peer sources';
    if (rest === '/remove') return 'Removed ' + name + ' from the server';
    if (!rest && torrent[2] !== undefined) return 'Video data of ' + name + rangeText(range);
    return 'Streaming server request ' + method + ' ' + rest + ' of ' + name;
}

function conversionRequest(clean) {
    // A request to the converter: its session, then the playlist, the start or a numbered segment of one track
    var parts = clean.split('/').slice(2);
    if (parts.join('/') === 'probe') return 'Converter read the format of a video';
    var name = 'Conversion ' + (parts.shift() || '').slice(0, 8);
    var file = parts.join('/');
    if (!file) return name + ': session requested';
    var segment = /^([^/]+)\/segment(\d+)\.m4s$/.exec(file);
    if (segment) return name + ': segment ' + segment[2] + ' of ' + segment[1] + ' requested';
    if (/\/init\.mp4$/.test(file)) return name + ': start of ' + file.split('/')[0] + ' requested';
    if (/\.m3u8$/.test(file)) return name + ': playlist ' + file + ' requested';
    return name + ': ' + file + ' requested';
}

function describeRequest(method, path, range) {
    // One sentence for a request line of the streaming server
    var clean = path.split('?')[0];
    var torrent = TORRENT_PATH.exec(clean);
    if (torrent) return torrentRequest(method, torrent, range);
    if (/^\/hlsv2\//.test(clean)) return conversionRequest(clean);
    if (clean === '/heartbeat') return 'Stremio checked that the streaming server answers';
    if (clean === '/stats.json') return 'Read the state of every torrent';
    if (/^\/tracks\//.test(clean)) return 'Listed the audio and subtitle tracks of a video';
    if (clean === '/opensubHash') return 'Computed the subtitle hash of a video';
    if (/^\/subtitles\./.test(clean)) return 'Converted a subtitle file';
    if (clean === '/settings') return method === 'POST' ? 'Changed the streaming server settings' : 'Read the streaming server settings';
    if (clean === '/casting') return 'Looked for casting devices';
    if (clean === '/network-info') return 'Read the network addresses of the TV';
    if (clean === '/device-info') return 'Read what the TV can decode';
    if (/^\/local-addon\//.test(clean)) return 'Asked the local addon for ' + clean.slice('/local-addon/'.length);
    return 'Streaming server request ' + method + ' ' + (clean || '/');
}

function classify(level, text) {
    // Level, area and sentence of one console line; traces of the streaming server are detail-level evidence
    var request = REQUEST.exec(text);
    if (request) return { level: 'verbose', area: 'server', text: describeRequest(request[1], request[2], request[3]), raw: text };
    var cleanup = CACHE_CLEANUP.exec(text);
    if (cleanup) return { level: 'verbose', area: 'server', text: 'Cleaned the torrent cache folder (' + cleanup[1] + ' files removed)', raw: text };
    if (ENGINE_DETAIL.test(text)) return { level: 'verbose', area: 'server', text: text };
    return { level: level, text: text };
}

function push(entry) {
    // Keep the line in the ring of its level; each ring drops only its own oldest lines
    var rank = RANK[entry.level] === undefined ? RANK.log : RANK[entry.level];
    entry.n = ++seq;
    rings[rank].push(entry);
    if (rings[rank].length > limits[rank]) rings[rank].shift();
}

function record(level, text) {
    // Sanitize, classify and keep one line; a poll already kept in this minute is only counted
    var entry = classify(level, safeText(text));
    var now = Date.now();
    if (PERIODIC.test(entry.text)) {
        var repeat = repeats[entry.text];
        if (repeat && now - repeat.since < REPEAT_WINDOW_MS) {
            repeat.count++;
            return;
        }
        repeats[entry.text] = { since: now, count: 0 };
    }
    entry.at = now;
    push(entry);
}

function flushRepeats() {
    // Once a minute, say how many times each kept poll ran again after it
    var now = Date.now();
    Object.keys(repeats).forEach(function(text) {
        var repeat = repeats[text];
        if (now - repeat.since < REPEAT_WINDOW_MS) return;
        if (repeat.count) push({ at: now, level: 'verbose', area: 'server', text: text + ': ' + repeat.count + ' more times in the last minute' });
        delete repeats[text];
    });
}

function capture() {
    // Keep every console line of this process from now on; the console itself still prints everything
    ['log', 'info', 'warn', 'error'].forEach(function(level) {
        var original = console[level].bind(console);
        console[level] = function() {
            // Formatted like the console itself, so objects and errors read as their content
            record(level, util.format.apply(util, arguments));
            original.apply(null, arguments);
        };
    });
    setInterval(flushRepeats, REPEAT_WINDOW_MS).unref();
}

function setLimits(ring) {
    // Ring sizes from the settings: warnings and errors, normal lines, detail lines
    if (!ring) return;
    limits = [ring.important || limits[0], ring.normal || limits[1], ring.verbose || limits[2]];
}

function read(since, detail) {
    // Lines newer than the cursor up to a detail level, in the order they were logged; null for an unknown level
    var maxRank = DETAIL[detail];
    if (maxRank === undefined) return null;
    var lines = [];
    for (var rank = 0; rank <= maxRank; rank++) lines = lines.concat(rings[rank].filter(function(line) { return line.n > since; }));
    return { last: seq, lines: lines.sort(function(a, b) { return a.n - b.n; }) };
}

module.exports = { capture: capture, setLimits: setLimits, read: read };
