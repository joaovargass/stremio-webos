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
var probeFailures = {};
var activeStreams = 0;
var STREAM_PATH = /^\/([0-9a-f]{40}\/\d+|hlsv2\/)/i;
var TORRENT_FILE_PATH = /^\/[0-9a-f]{40}\/\d+(\?|$)/i;
var HLS_PATH = /^\/hlsv2\//i;
var INFO_HASH = /(?:^|\/|%2F)([0-9a-f]{40})(?=\/|%2F|$)/i;
var routes = {};
var seeded = {};
var touched = {};
var mirrors = {};
var mirrorChecks = {};
var lastScan = 0;
var readAhead = new ReadAhead(tweaks.readAhead || { enabled: false });
readAhead.mirrorsFor = mirrorsFor;
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
        if (typeof overrides['peerBoost.enabled'] === 'boolean') tweaks.peerBoost = Object.assign({}, tweaks.peerBoost, { enabled: overrides['peerBoost.enabled'] });
        if (typeof overrides['readAhead.mergeSources'] === 'boolean') readAhead.config.mergeSources = overrides['readAhead.mergeSources'];
        if (!lanAllowed()) {
            routes = {};
            selectUpstream();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ useLan: lanAllowed(), readAhead: readAhead.config.enabled, peerBoost: (tweaks.peerBoost || {}).enabled !== false }));
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

function setRoute(hash, target) {
    // Serve one torrent from a server, or from the default upstream when target is null; true when the player does not notice
    if (target) routes[hash] = target;
    else delete routes[hash];
    // The open memory window continues from the new server at the next byte, so the player keeps playing untouched
    var seamless = readAhead.reroute(hash, target ? url.parse(target) : upstream);
    // Only this torrent's own window is dropped; a video playing from another file keeps its buffer
    if (!seamless) readAhead.resetFor(hash);
    console.log('route', hash, '->', target || 'default', seamless ? '(seamless)' : '');
    return seamless;
}

function serveRoute(reqUrl, res) {
    // Move one torrent to the remote fallback server, or back to the default upstream
    var query = url.parse(reqUrl, true).query;
    var hash = String(query.hash || '').toLowerCase();
    var target = query.to === 'remote' ? remoteFallback() : null;
    var seamless = /^[0-9a-f]{40}$/.test(hash) ? setRoute(hash, target) : false;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hash: hash, server: target, seamless: seamless, routes: routes }));
}

function readRange(server, filePath, range, done) {
    // Read and discard a byte range so the server downloads it; done gets the file size from Content-Range, or null
    var finish = once(done);
    var req = http.get({ hostname: server.hostname, port: server.port, path: filePath, headers: { Range: 'bytes=' + range[0] + '-' + range[1] } }, function(res) {
        var total = /\/(\d+)$/.exec(res.headers['content-range'] || '');
        res.on('end', function() { finish(total ? parseInt(total[1], 10) : null); });
        res.resume();
    });
    req.setTimeout((tweaks.prewarm || {}).timeoutMs || 120000, function() { req.destroy(); });
    req.on('error', function() { finish(null); });
}

function warmTorrent(hash, server, query) {
    // Seed the peer sources, then read the configured bytes at the requested position of the file
    var bytes = (tweaks.prewarm || {}).warmBytes || 1048576;
    var filePath = '/' + hash + '/' + (parseInt(query.idx, 10) || 0);
    touchTorrent(hash, server, null);
    var fraction = Math.min(Math.max(parseFloat(query.at) || 0, 0), 0.99);
    var log = function(total) { console.log('warmed', hash, 'at', Math.round(fraction * 100) + '%', 'on', server.host, total ? '' : '(no answer)'); };
    seedPeers(hash, server, function() {
        if (!fraction) return readRange(server, filePath, [0, bytes - 1], log);
        // A position inside the file needs its size first; a one-byte read answers with it
        readRange(server, filePath, [0, 0], function(total) {
            var from = Math.floor((total || 0) * fraction);
            if (total) readRange(server, filePath, [from, Math.min(from + bytes, total) - 1], log);
        });
    });
}

function serveWarm(reqUrl, res) {
    // Start a torrent and fetch its bytes at a position inside the service, so the page keeps its few connections for playback
    var query = url.parse(reqUrl, true).query;
    var hash = String(query.hash || '').toLowerCase();
    var valid = /^[0-9a-f]{40}$/.test(hash);
    // A source that will play from the Mac starts and warms there
    if (valid && query.lan === '1' && remoteFallback() && !routes[hash]) setRoute(hash, remoteFallback());
    var server = sourceFor('/' + hash + '/');
    res.writeHead(valid ? 202 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hash: hash, server: url.format(server) }));
    if (valid) warmTorrent(hash, server, query);
}

function filePathOf(reqUrl) {
    // The torrent file part of a request path, without its query
    return reqUrl.split('?')[0].toLowerCase();
}

function readHead(server, filePath, bytes, done) {
    // Read the first bytes of a file; done gets the file size and those bytes, or nulls
    var finish = once(done);
    var parts = [];
    var req = http.get({ hostname: server.hostname, port: server.port, path: filePath, headers: { Range: 'bytes=0-' + (bytes - 1) } }, function(res) {
        var total = /\/(\d+)$/.exec(res.headers['content-range'] || '');
        if (res.statusCode !== 206 || !total) {
            res.resume();
            return finish(null, null);
        }
        res.on('data', function(part) { parts.push(part); });
        res.on('end', function() { finish(parseInt(total[1], 10), Buffer.concat(parts)); });
        res.on('error', function() { finish(null, null); });
    });
    req.setTimeout((tweaks.prewarm || {}).timeoutMs || 120000, function() { req.destroy(); });
    req.on('error', function() { finish(null, null); });
}

function mirrorSettings() {
    // Limits for merging other torrents of the same file into the playing one
    return (tweaks.readAhead || {}).mirrors || {};
}

function mirrorLimit(server) {
    // Every torrent costs memory and peer connections on its server, and the TV has little of both
    return isLocal(server) ? mirrorSettings().maxOnTv || 1 : mirrorSettings().max || 2;
}

function mirrorsFor(windowPath) {
    // Verified mirrors of a playing file for the read-ahead window; using them keeps them from the idle cleanup
    if (readAhead.config.mergeSources === false) return [];
    var list = mirrors[filePathOf(windowPath)] || [];
    list.forEach(function(m) { touchTorrent(m.hash, m.server, null); });
    return list.map(function(m) { return { key: m.path + '@' + m.server.host, hostname: m.server.hostname, port: m.server.port, path: m.path }; });
}

function verifyMirror(primaryPath, mirrorHash, mirrorIdx) {
    // Another torrent is merged only when its file has the same size and the same first bytes as the playing one
    var mirrorPath = '/' + mirrorHash + '/' + mirrorIdx;
    var checkKey = primaryPath + '|' + mirrorPath;
    var mirrorServer = sourceFor(mirrorPath);
    if (mirrorChecks[checkKey] || primaryPath.indexOf('/' + mirrorHash + '/') === 0 || (mirrors[primaryPath] || []).length >= mirrorLimit(mirrorServer)) return false;
    mirrorChecks[checkKey] = true;
    var primaryServer = sourceFor(primaryPath);
    var bytes = mirrorSettings().verifyBytes || 65536;
    seedPeers(mirrorHash, mirrorServer, function() {
        touchTorrent(mirrorHash, mirrorServer, null);
        var heads = [];
        var pending = 2;
        var compare = function() {
            if (--pending > 0) return;
            var same = heads[0].size && heads[0].size === heads[1].size && heads[0].data.equals(heads[1].data);
            console.log('mirror', mirrorPath, 'for', primaryPath, same ? 'verified' : 'differs');
            var list = mirrors[primaryPath] = mirrors[primaryPath] || [];
            if (same && list.length < mirrorLimit(mirrorServer)) list.push({ hash: mirrorHash, path: mirrorPath, server: mirrorServer });
        };
        [primaryServer, mirrorServer].forEach(function(server, i) {
            var filePath = i ? mirrorPath : primaryPath;
            readHead(server, filePath, bytes, function(size, data) {
                heads[i] = { size: size, data: data || Buffer.alloc(0) };
                compare();
            });
        });
    });
    return true;
}

function serveMirror(reqUrl, res) {
    // Offer another torrent of the playing file as a mirror; the check runs in the background
    var query = url.parse(reqUrl, true).query;
    var hash = String(query.hash || '').toLowerCase();
    var other = String(query.with || '').toLowerCase();
    var valid = /^[0-9a-f]{40}$/.test(hash) && /^[0-9a-f]{40}$/.test(other) && hash !== other;
    var primaryPath = '/' + hash + '/' + (parseInt(query.idx, 10) || 0);
    var started = valid && verifyMirror(primaryPath, other, parseInt(query.widx, 10) || 0);
    res.writeHead(valid ? 202 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ file: primaryPath, checking: !!started, mirrors: (mirrors[primaryPath] || []).map(function(m) { return m.path; }) }));
}

function once(fn) {
    // Wrap a callback so a timer, an answer and an error cannot run it twice
    var called = false;
    return function() {
        if (called) return;
        called = true;
        fn.apply(null, arguments);
    };
}

function seedPeers(hash, server, done) {
    // Create a torrent on a server with the configured peer sources before anything else opens it there, once per server
    var boost = tweaks.peerBoost || {};
    var key = hash + '@' + server.host;
    var finish = once(done);
    if (seeded[key] || !tweaks.trackers || boost.enabled === false) return finish();
    seeded[key] = true;
    var sources = tweaks.trackers.map(function(t) { return 'tracker:' + t; }).concat(['dht:' + hash]);
    var body = JSON.stringify({ torrent: { infoHash: hash }, peerSearch: Object.assign({ sources: sources }, tweaks.peerSearch) });
    var req = http.request({ hostname: server.hostname, port: server.port, path: '/' + hash + '/create', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, function(res) {
        res.resume();
        finish();
    });
    // The server answers only once the torrent metadata is known; reaching it first is what counts, so the caller goes on shortly after
    setTimeout(finish, boost.waitMs || 500);
    req.setTimeout((tweaks.prewarm || {}).timeoutMs || 120000, function() { req.destroy(); });
    req.on('error', function() { finish(); });
    req.end(body);
}

function loadTweaks() {
    // Read the shared tweaks configuration, falling back to the local server only
    try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, 'tweaks.json'), 'utf8'));
    } catch (err) {
        console.error('tweaks.json unreadable, using local server only', err.message);
        return { servers: { candidates: ['http://127.0.0.1:11470/'], probePath: 'stats.json', probeTimeoutMs: 10000, recheckIntervalMs: 0 } };
    }
}

function probe(candidate, callback, timeoutMs) {
    // A streaming server is usable when its probe path answers 200; /stats.json stays fast while /settings waits on network lookups
    var opts = url.parse(candidate + tweaks.servers.probePath);
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

function probeTwice(candidate, callback) {
    // The first packet over an idle Wi-Fi link can take seconds; a second try right after runs on the woken link
    probe(candidate, function(ok) {
        if (ok) return callback(true);
        probe(candidate, callback);
    });
}

function recordProbe(candidate, ok) {
    // A server comes back on its first answer but goes down only after several failed probes in a row
    probeFailures[candidate] = ok ? 0 : (probeFailures[candidate] || 0) + 1;
    // A busy server serving a video can miss one probe; moving its videos to another server would starve the player
    var downAfter = tweaks.servers.downAfterFailures || 3;
    serverStatus[candidate] = ok || (!!serverStatus[candidate] && probeFailures[candidate] < downAfter);
}

function selectUpstream() {
    // Probe every candidate and transcoder in parallel so the diagnostics panel sees all of them
    var targets = candidates.concat(transcoders.filter(function(t) { return candidates.indexOf(t) === -1; }));
    var pending = targets.length;
    targets.forEach(function(candidate) {
        probeTwice(candidate, function(ok) {
            recordProbe(candidate, ok);
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

function touchTorrent(hash, server, res) {
    // Remember when a torrent was last used on a server; an open video response keeps it in use until it closes
    var key = hash + '@' + server.host;
    var entry = touched[key] = touched[key] || { hash: hash, server: server, open: 0 };
    entry.at = Date.now();
    if (!res) return;
    entry.open++;
    var released = false;
    var release = function() {
        if (released) return;
        released = true;
        entry.open--;
        entry.at = Date.now();
    };
    res.on('finish', release);
    res.on('close', release);
}

function removeIdleTorrents() {
    // A torrent nobody read for a while keeps dialing peers forever; through a carrier NAT that starves every new connection of the home
    var limit = (tweaks.servers.idleTorrentMinutes || 0) * 60000;
    if (!limit) return;
    Object.keys(touched).forEach(function(key) {
        var entry = touched[key];
        if (entry.open > 0 || Date.now() - entry.at < limit) return;
        delete touched[key];
        delete seeded[key];
        forgetMirrors(entry);
        var req = http.get({ hostname: entry.server.hostname, port: entry.server.port, path: '/' + entry.hash + '/remove', timeout: 10000 }, function(res) { res.resume(); });
        req.on('timeout', function() { req.destroy(); });
        req.on('error', function() {});
        console.log('removed idle torrent', entry.hash, 'on', entry.server.host);
    });
}

function forgetMirrors(entry) {
    // A removed torrent can no longer be a mirror, and a removed playing file needs none
    Object.keys(mirrors).forEach(function(primaryPath) {
        if (primaryPath.indexOf('/' + entry.hash + '/') === 0) return delete mirrors[primaryPath];
        mirrors[primaryPath] = mirrors[primaryPath].filter(function(m) { return m.hash !== entry.hash || m.server.host !== entry.server.host; });
    });
    Object.keys(mirrorChecks).forEach(function(key) { if (key.indexOf(entry.hash) !== -1) delete mirrorChecks[key]; });
}

function proxyToStreaming(req, res) {
    // Torrent files go through the RAM read-ahead window, everything else is proxied as is
    var source = sourceFor(req.url);
    var hashMatch = INFO_HASH.exec(req.url);
    if (hashMatch && STREAM_PATH.test(req.url)) touchTorrent(hashMatch[1].toLowerCase(), source, res);
    if (TORRENT_FILE_PATH.test(req.url)) {
        trackStream(res);
        // The first request of a torrent on a server creates it there with the configured peer sources
        return seedPeers(INFO_HASH.exec(req.url)[1].toLowerCase(), source, function() {
            readAhead.handle(req, res, source, function() { proxyRequest(req, res, source, source); });
        });
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
    res.end(JSON.stringify({ upstream: url.format(upstream), candidates: serverStatus, transcoder: transcoder ? url.format(transcoder) : null, subsync: subsync ? url.format(subsync) : null, fallback: remoteFallback(), routes: routes, activeStreams: activeStreams, readAhead: readAhead.status(), mirrors: Object.keys(mirrors).reduce(function(all, p) { all[p] = mirrors[p].map(function(m) { return m.path + '@' + m.server.host; }); return all; }, {}) }));
}

// Single server: tweaks status and routes, static files, then proxy to streaming server
http.createServer(function(req, res) {
    var urlPath = req.url.split('?')[0];
    if (urlPath === '/__tweaks/status') return serveStatus(res);
    if (urlPath === '/__tweaks/route') return serveRoute(req.url, res);
    if (urlPath === '/__tweaks/warm') return serveWarm(req.url, res);
    if (urlPath === '/__tweaks/mirror') return serveMirror(req.url, res);
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
    setInterval(removeIdleTorrents, 60000);
});
