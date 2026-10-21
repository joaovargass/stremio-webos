process.env.NODE_PATH = (process.env.NODE_PATH || '') + ':/usr/lib/node_modules:/usr/lib/nodejs';
require('module').Module._initPaths();
process.env.APP_PATH = process.env.APP_PATH || __dirname;

var http = require('http');
var fs = require('fs');
var path = require('path');
var url = require('url');
var Service = require('webos-service');

var tweaks = loadTweaks();
var candidates = tweaks.servers.candidates;
var upstream = url.parse(candidates[candidates.length - 1]);
var serverStatus = {};
var activeStreams = 0;
var STREAM_PATH = /^\/([0-9a-f]{40}\/\d+|hlsv2\/)/i;

function loadTweaks() {
    // Read the shared tweaks configuration, falling back to the local server only
    try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, 'tweaks.json'), 'utf8'));
    } catch (err) {
        console.error('tweaks.json unreadable, using local server only', err.message);
        return { servers: { candidates: ['http://127.0.0.1:11470/'], probeTimeoutMs: 2500, recheckIntervalMs: 0 } };
    }
}

function probe(candidate, callback) {
    // A streaming server is usable when its /settings endpoint answers 200
    var opts = url.parse(candidate + 'settings');
    opts.timeout = tweaks.servers.probeTimeoutMs;
    var done = false;
    var finish = function(ok) { if (!done) { done = true; callback(ok); } };
    var req = http.get(opts, function(res) {
        res.resume();
        finish(res.statusCode === 200);
    });
    req.on('timeout', function() { req.destroy(); finish(false); });
    req.on('error', function() { finish(false); });
}

function selectUpstream() {
    // Probe every candidate in parallel so the diagnostics panel sees all of them
    var pending = candidates.length;
    candidates.forEach(function(candidate) {
        probe(candidate, function(ok) {
            serverStatus[candidate] = ok;
            if (--pending === 0) applyBestUpstream();
        });
    });
}

function applyBestUpstream() {
    // Keep the first candidate, in configured order, that answered
    var best = candidates.filter(function(candidate) { return serverStatus[candidate]; })[0];
    if (!best) return;
    var next = url.parse(best);
    // Never move the proxy while a video is being served from the current upstream
    if (next.host !== upstream.host && activeStreams === 0) {
        console.log('streaming upstream ->', best);
        upstream = next;
    }
}

var service = new Service('com.joaovargass.stremiodbg.server');
var ready = false;
var pendingMessages = [];

// Keep the service alive indefinitely
service.activityManager.create('keepAlive', function() {});

// Register the start method — responds once the HTTP server is listening
service.register('start', function(message) {
    if (ready) {
        message.respond({ ready: true });
    } else {
        pendingMessages.push(message);
    }
});

// Static file serving
var wwwDir = path.join(__dirname, 'www');
var mimeTypes = {
    '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon', '.gif': 'image/gif', '.webp': 'image/webp',
    '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.json': 'application/json',
    '.map': 'application/json', '.txt': 'text/plain', '.mp3': 'audio/mpeg'
};

function serveStatic(urlPath, res, next) {
    // Reject path traversal
    var filePath = path.join(wwwDir, urlPath === '/' ? 'index.html' : urlPath);
    if (filePath.indexOf(wwwDir) !== 0) return next();

    fs.stat(filePath, function(err, stat) {
        if (err || !stat.isFile()) return next();
        var ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
        var stream = fs.createReadStream(filePath);
        stream.on('error', function() { try { res.end(); } catch (_) {} });
        stream.pipe(res);
    });
}

function proxyToStreaming(req, res) {
    var opts = { hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: req.headers };
    // Count open video responses so the upstream is not switched under them
    var isStream = STREAM_PATH.test(req.url);
    if (isStream) {
        activeStreams++;
        var released = false;
        var release = function() { if (!released) { released = true; activeStreams--; } };
        res.on('finish', release);
        res.on('close', release);
    }
    var proxy = http.request(opts, function(proxyRes) {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
    });
    // An upstream failure after headers were sent can only drop the connection
    proxy.on('error', function() {
        if (res.headersSent) return res.destroy();
        res.writeHead(502);
        res.end();
    });
    // Release the upstream request as soon as the player closes its side
    res.on('close', function() { proxy.destroy(); });
    req.pipe(proxy);
}

function serveStatus(res) {
    // Report the selected upstream for the diagnostics panel
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ upstream: url.format(upstream), candidates: serverStatus, activeStreams: activeStreams }));
}

// Single server: tweaks status, static files, then proxy to streaming server
http.createServer(function(req, res) {
    var urlPath = req.url.split('?')[0];
    if (urlPath === '/__tweaks/status') return serveStatus(res);
    serveStatic(urlPath, res, function() { proxyToStreaming(req, res); });
}).listen(8080, function() {
    ready = true;
    // Respond to any start calls that arrived before the server was ready
    pendingMessages.forEach(function(msg) { msg.respond({ ready: true }); });
    pendingMessages = [];
});

// Point the streaming server at the bundled ffmpeg binaries.
// HLS remux/transcode requires ffmpeg+ffprobe; without these the streaming
// server's /hlsv2/* endpoints return 500 "no ffmpeg found".
process.env.FFMPEG_BIN = path.join(__dirname, 'bin', 'ffmpeg');
process.env.FFPROBE_BIN = path.join(__dirname, 'bin', 'ffprobe');

// Start the bundled server only when no streaming server already owns :11470, saving RAM
probe('http://127.0.0.1:11470/', function(running) {
    if (!running) require('./server.js');
    selectUpstream();
    if (tweaks.servers.recheckIntervalMs) {
        setInterval(selectUpstream, tweaks.servers.recheckIntervalMs);
    }
});
