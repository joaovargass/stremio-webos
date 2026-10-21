process.env.NODE_PATH = (process.env.NODE_PATH || '') + ':/usr/lib/node_modules:/usr/lib/nodejs';
require('module').Module._initPaths();
process.env.APP_PATH = process.env.APP_PATH || __dirname;

var http = require('http');
var fs = require('fs');
var os = require('os');
var path = require('path');
var url = require('url');
var Service = require('webos-service');
var ReadAhead = require('./readahead');

var tweaks = loadTweaks();
var candidates = tweaks.servers.candidates;
var transcoders = tweaks.servers.transcoders || [];
var upstream = url.parse(candidates[0]);
var serverStatus = {};
var activeStreams = 0;
var STREAM_PATH = /^\/([0-9a-f]{40}\/\d+|hlsv2\/)/i;
var TORRENT_FILE_PATH = /^\/[0-9a-f]{40}\/\d+(\?|$)/i;
var HLS_PATH = /^\/hlsv2\//i;
var INFO_HASH = /(?:^|\/|%2F)([0-9a-f]{40})(?=\/|%2F|$)/i;
var routes = {};
var lastScan = 0;
var readAhead = new ReadAhead(tweaks.readAhead || { enabled: false });
var PROXY_LOOPBACK = /http(%3A|:)(%2F|\/)(%2F|\/)127\.0\.0\.1(%3A|:)8080/gi;

function lanAddress() {
    // The address other LAN hosts use to reach the streaming server running on this TV
    var nets = os.networkInterfaces();
    var names = Object.keys(nets);
    for (var i = 0; i < names.length; i++) {
        var found = nets[names[i]].filter(function(n) { return n.family === 'IPv4' && !n.internal; })[0];
        if (found) return found.address;
    }
    return null;
}

function isLocal(server) {
    // The TV's own streaming server listens on loopback
    return /^(127\.|localhost)/.test(server.hostname);
}

function lanAllowed() {
    // Servers outside the TV are used only while the viewer keeps that switch on
    return tweaks.servers.useLan !== false;
}

function allowed(candidate) {
    // A candidate is usable when it is the TV or LAN servers are allowed
    return lanAllowed() || isLocal(url.parse(candidate));
}

function readBody(req, callback) {
    // Collect a small JSON request body, ignoring anything malformed
    var chunks = [];
    req.on('data', function(chunk) { chunks.push(chunk); });
    req.on('end', function() {
        try { callback(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (_) { callback({}); }
    });
}

function serveOverrides(req, res) {
    // Apply the viewer's on/off choices that live in the service
    readBody(req, function(overrides) {
        if (typeof overrides['servers.useLan'] === 'boolean') tweaks.servers.useLan = overrides['servers.useLan'];
        if (typeof overrides['readAhead.enabled'] === 'boolean') readAhead.config.enabled = overrides['readAhead.enabled'];
        if (!lanAllowed()) {
            routes = {};
            selectUpstream();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ useLan: lanAllowed(), readAhead: readAhead.config.enabled }));
    });
}

function sourceFor(reqUrl) {
    // The server holding a torrent: a per-video override when the TV could not keep up, else the upstream
    var hash = INFO_HASH.exec(reqUrl);
    var routed = hash && routes[hash[1].toLowerCase()];
    return routed && serverStatus[routed] ? url.parse(routed) : upstream;
}

function mediaHost(target, source) {
    // Where the target server can read the source media: its own loopback, the TV LAN address or the source host
    if (target.host === source.host) return '127.0.0.1';
    return isLocal(source) ? lanAddress() : source.hostname;
}

function rewriteLoopback(path, target, source) {
    // Media URLs passed to a server point at this proxy; the server must read the source directly instead
    var host = mediaHost(target, source);
    return path.replace(PROXY_LOOPBACK, function(match, colon, slash1, slash2, portColon) {
        return 'http' + colon + slash1 + slash2 + host + portColon + (source.port || 80);
    });
}

function pickTranscoder(source) {
    // The source when it has ffmpeg, else the first reachable configured transcoder
    if (transcoders.indexOf(url.format(source)) !== -1) return source;
    var best = transcoders.filter(function(candidate) { return serverStatus[candidate] && allowed(candidate); })[0];
    if (!best) return null;
    // A remote transcoder can only read media from this TV when its LAN address is known
    return mediaHost(url.parse(best), source) ? url.parse(best) : null;
}

function remoteFallback() {
    // First reachable candidate outside the TV, used when the TV swarm is too slow for one video
    if (!lanAllowed()) return null;
    return candidates.filter(function(candidate) { return serverStatus[candidate] && !isLocal(url.parse(candidate)); })[0] || null;
}

function serveRoute(reqUrl, res) {
    // Move one torrent to the remote fallback server, or back to the default upstream
    var query = url.parse(reqUrl, true).query;
    var hash = String(query.hash || '').toLowerCase();
    var target = query.to === 'remote' ? remoteFallback() : null;
    if (/^[0-9a-f]{40}$/.test(hash)) {
        if (target) routes[hash] = target;
        else delete routes[hash];
        // The memory window was filled from the previous server and must not be mixed with the new one
        readAhead.reset();
        console.log('route', hash, '->', target || 'default');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hash: hash, server: target, routes: routes }));
}

function loadTweaks() {
    // Read the shared tweaks configuration, falling back to the local server only
    try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, 'tweaks.json'), 'utf8'));
    } catch (err) {
        console.error('tweaks.json unreadable, using local server only', err.message);
        return { servers: { candidates: ['http://127.0.0.1:11470/'], probeTimeoutMs: 2500, recheckIntervalMs: 0 } };
    }
}

function probe(candidate, callback, timeoutMs) {
    // A streaming server is usable when its /settings endpoint answers 200
    var opts = url.parse(candidate + 'settings');
    opts.timeout = timeoutMs || tweaks.servers.probeTimeoutMs;
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
    // Probe every candidate and transcoder in parallel so the diagnostics panel sees all of them
    var targets = candidates.concat(transcoders.filter(function(t) { return candidates.indexOf(t) === -1; }));
    var pending = targets.length;
    targets.forEach(function(candidate) {
        probe(candidate, function(ok) {
            serverStatus[candidate] = ok;
            if (--pending > 0) return;
            applyBestUpstream();
            maybeDiscover();
        });
    });
}

function maybeDiscover() {
    // Look for the LAN server on the TV subnet when no configured LAN server answers, e.g. after the router changed IPs
    var discover = tweaks.servers.discover || {};
    var lanUp = candidates.some(function(c) { return !isLocal(url.parse(c)) && serverStatus[c]; });
    var own = lanAddress();
    if (!discover.enabled || !lanAllowed() || lanUp || !own || Date.now() - lastScan < (discover.everyMs || 300000)) return;
    lastScan = Date.now();
    scanSubnet(own, discover, function(found) {
        if (found) adoptServer(found);
    });
}

function scanSubnet(own, discover, done) {
    // Probe every address of the /24 subnet with a small number of parallel requests
    var prefix = own.split('.').slice(0, 3).join('.');
    var hosts = [];
    for (var i = 1; i < 255; i++) hosts.push(prefix + '.' + i);
    var found = null;
    var running = 0;
    var next = function() {
        if (found) return;
        if (!hosts.length) {
            if (running === 0) done(null);
            return;
        }
        var candidate = 'http://' + hosts.shift() + ':' + discover.port + '/';
        running++;
        probe(candidate, function(ok) {
            running--;
            if (ok && !found) {
                found = candidate;
                return done(found);
            }
            next();
        }, discover.timeoutMs || 700);
    };
    for (var n = 0; n < (discover.concurrency || 32); n++) next();
}

function adoptServer(found) {
    // Use the discovered server right after the TV, and as transcoder since it is the ffmpeg build
    console.log('discovered LAN streaming server', found);
    if (candidates.indexOf(found) === -1) {
        var firstRemote = candidates.filter(function(c) { return !isLocal(url.parse(c)); })[0];
        candidates.splice(firstRemote ? candidates.indexOf(firstRemote) : candidates.length, 0, found);
    }
    if (transcoders.indexOf(found) === -1) transcoders.unshift(found);
    serverStatus[found] = true;
    applyBestUpstream();
}

function applyBestUpstream() {
    // Keep the first candidate, in configured order, that answered
    var best = candidates.filter(function(candidate) { return serverStatus[candidate] && allowed(candidate); })[0];
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
    // Torrent files go through the RAM read-ahead window, everything else is proxied as is
    var source = sourceFor(req.url);
    if (TORRENT_FILE_PATH.test(req.url)) {
        trackStream(res);
        return readAhead.handle(req, res, source, function() { proxyRequest(req, res, source, source); });
    }
    if (STREAM_PATH.test(req.url)) trackStream(res);
    if (!HLS_PATH.test(req.url)) return proxyRequest(req, res, source, source);
    // HLS conversion needs ffmpeg; answer at once when no server can convert so the player moves on
    var transcoder = pickTranscoder(source);
    if (transcoder) return proxyRequest(req, res, transcoder, source);
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'no transcoder available' }));
}

function trackStream(res) {
    // Count open video responses so the upstream is not switched under them
    activeStreams++;
    var released = false;
    var release = function() { if (!released) { released = true; activeStreams--; } };
    res.on('finish', release);
    res.on('close', release);
}

function proxyRequest(req, res, target, source, path) {
    // Forward the request to the chosen server, rewriting media URLs it must read from the source
    var opts = { hostname: target.hostname, port: target.port, path: rewriteLoopback(path || req.url, target, source), method: req.method, headers: req.headers };
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

function subsyncServer(source) {
    // The sync service runs on the host of the ffmpeg server, on its own port
    var transcoder = pickTranscoder(source);
    if (!transcoder || isLocal(transcoder)) return null;
    return url.parse('http://' + transcoder.hostname + ':' + (tweaks.servers.subsyncPort || 11481) + '/');
}

function serveSubsync(req, res) {
    // Ask the LAN sync service to align a subtitle with the audio around the playback position
    var source = sourceFor(req.url);
    var target = subsyncServer(source);
    if (!target) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'no sync server available' }));
    }
    proxyRequest(req, res, target, source, req.url.replace('/__tweaks/subsync', '/sync'));
}

function serveStatus(res) {
    // Report the selected upstream for the diagnostics panel
    res.writeHead(200, { 'Content-Type': 'application/json' });
    var transcoder = pickTranscoder(upstream);
    var subsync = subsyncServer(upstream);
    res.end(JSON.stringify({ upstream: url.format(upstream), candidates: serverStatus, transcoder: transcoder ? url.format(transcoder) : null, subsync: subsync ? url.format(subsync) : null, fallback: remoteFallback(), routes: routes, activeStreams: activeStreams, readAhead: readAhead.status() }));
}

// Single server: tweaks status and routes, static files, then proxy to streaming server
http.createServer(function(req, res) {
    var urlPath = req.url.split('?')[0];
    if (urlPath === '/__tweaks/status') return serveStatus(res);
    if (urlPath === '/__tweaks/route') return serveRoute(req.url, res);
    if (urlPath === '/__tweaks/subsync') return serveSubsync(req, res);
    if (urlPath === '/__tweaks/overrides' && req.method === 'POST') return serveOverrides(req, res);
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
