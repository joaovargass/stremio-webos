process.env.NODE_PATH = (process.env.NODE_PATH || '') + ':/usr/lib/node_modules:/usr/lib/nodejs';
require('module').Module._initPaths();
process.env.APP_PATH = process.env.APP_PATH || __dirname;

var dgram = require('dgram');
var dns = require('dns');
var http = require('http');
var https = require('https');
var fs = require('fs');
var os = require('os');
var path = require('path');
var url = require('url');
var util = require('util');
var Service = require('webos-service');
var ReadAhead = require('./readahead');
var AnswerCache = require('./answercache');
var subsync = require('./subsync');
var subtitles = require('./subtitles');

var logLines = [];
var logSeq = 0;
keepLogs();
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
var subtitleCache = [];
var syncQueue = Promise.resolve();
var syncResults = {};
var ownServer = false;
var hlsSessions = {};
var lastScan = 0;
var lastSubnetScan = 0;
var lastNetwork = null;
var discovered = {};
var serverInfo = {};
var readAhead = new ReadAhead(tweaks.readAhead || { enabled: false });
var answerSettings = tweaks.answerCache || {};
var metaAnswers = new AnswerCache(answerSettings.meta || {});
var hlsStartAnswers = new AnswerCache(answerSettings.hlsStart || {});
var META_PATH = /^\/(opensubHash\?|tracks\/)/;
var HLS_START_PATH = /^\/hlsv2\/([^/?]+)\/[^/?]+\/(?:init\.mp4|segment(\d+)\.m4s)(\?|$)/;
readAhead.mirrorsFor = mirrorsFor;
var proxyUrl = url.parse(tweaks.servers.coreUrl);
var PROXY_LOOPBACK = new RegExp('http(%3A|:)(%2F|\\/)(%2F|\\/)' + proxyUrl.hostname.replace(/\./g, '\\.') + '(%3A|:)' + proxyUrl.port, 'gi');

function keepLogs() {
    // Keep the latest service log lines in memory for the on-screen debug log
    ['log', 'warn', 'error'].forEach(function(level) {
        var original = console[level].bind(console);
        console[level] = function() {
            // Formatted like the console itself, so objects and errors read as their content
            logLines.push({ n: ++logSeq, at: Date.now(), level: level, text: util.format.apply(util, arguments) });
            if (logLines.length > 300) logLines.shift();
            original.apply(null, arguments);
        };
    });
}

function serveLogs(reqUrl, res) {
    // Service log lines newer than the given sequence number
    var since = parseInt(url.parse(reqUrl, true).query.since, 10) || 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ last: logSeq, lines: logLines.filter(function(line) { return line.n > since; }) }));
}

function familyOf(net) {
    // Node names the address family with a string or, in some versions, with a number
    return net.family === 6 || net.family === 'IPv6' ? 'IPv6' : 'IPv4';
}

function tvAddresses() {
    // Every address of this TV that another host of the network can reach; link-local IPv6 needs a zone no peer knows
    var nets = os.networkInterfaces();
    return Object.keys(nets).reduce(function(all, name) {
        return all.concat((nets[name] || []).filter(function(n) { return !n.internal && !/^fe80:/i.test(n.address); }).map(function(n) {
            return { address: n.address, family: familyOf(n), interface: name };
        }));
    }, []);
}

function tvAddress(family) {
    // The first address of this TV in one family, or null when the network offers none (an IPv6-only hotspot has no IPv4)
    return (tvAddresses().filter(function(a) { return a.family === family; })[0] || {}).address || null;
}

function tvAddressFor(peerHost) {
    // The TV address a LAN host can reach: the same family as that host
    return tvAddress(String(peerHost).indexOf(':') !== -1 ? 'IPv6' : 'IPv4');
}

function urlHost(address) {
    // An IPv6 address goes between brackets inside a URL
    return String(address).indexOf(':') !== -1 ? '[' + address + ']' : address;
}

function networkKey() {
    // Changes whenever the TV joins another network or gets new addresses
    return tvAddresses().map(function(a) { return a.address; }).sort().join(',');
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
        tweaks.subtitles = tweaks.subtitles || {};
        if (typeof overrides['subtitles.convert'] === 'boolean') tweaks.subtitles.convert = overrides['subtitles.convert'];
        if (typeof overrides['subtitles.allowHttp'] === 'boolean') tweaks.subtitles.allowHttp = overrides['subtitles.allowHttp'];
        if (typeof overrides['subtitles.syncOnTv'] === 'boolean') tweaks.subtitles.syncOnTv = overrides['subtitles.syncOnTv'];
        tweaks.devMode = tweaks.devMode || {};
        if (typeof overrides['devMode.keepAlive'] === 'boolean') tweaks.devMode.keepAlive = overrides['devMode.keepAlive'];
        if (typeof overrides['answerCache.enabled'] === 'boolean') answerSettings.enabled = overrides['answerCache.enabled'];
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
    // Where the target server can read the source media, ready for a URL: its own loopback, the TV address it can reach or the source host
    if (target.host === source.host) return '127.0.0.1';
    var host = isLocal(source) ? tvAddressFor(target.hostname) : source.hostname;
    return host ? urlHost(host) : null;
}

function rewriteLoopback(path, target, source) {
    // Media URLs passed to a server point at this proxy; the server must read the source directly instead
    var host = mediaHost(target, source);
    return path.replace(PROXY_LOOPBACK, function(match, colon, slash1, slash2, portColon) {
        return 'http' + colon + slash1 + slash2 + host + portColon + (source.port || 80);
    });
}

function localTranscoder() {
    // The TV converts by itself when its own bundled server runs with the bundled ffmpeg
    return ownServer && fs.existsSync(process.env.FFMPEG_BIN) ? url.parse(candidates.filter(function(c) { return isLocal(url.parse(c)); })[0] || 'http://127.0.0.1:11470/') : null;
}

function lanTranscoder(source) {
    // The source when it is a LAN server with ffmpeg, else the first reachable configured one
    if (transcoders.indexOf(url.format(source)) !== -1) return source;
    var best = transcoders.filter(function(candidate) { return serverStatus[candidate] && allowed(candidate); })[0];
    if (!best) return null;
    // A remote transcoder can only read media from this TV when its LAN address is known
    return mediaHost(url.parse(best), source) ? url.parse(best) : null;
}

function pickTranscoder(source, heavy) {
    // Audio conversions and probes run on the TV; a picture re-encode, too slow for the TV in real time, goes to a LAN server when one answers
    var local = localTranscoder();
    var lan = lanTranscoder(source);
    return heavy ? lan || local : local || lan;
}

function transcoderFor(req, source) {
    // Every request of one HLS session goes to the server that started it
    var id = (/^\/hlsv2\/([^/?]+)/.exec(req.url) || [])[1];
    var pinned = id && id !== 'probe' ? hlsSessions[id] : null;
    // A session stays on its server only while that server may still be used: the TV, or a LAN server that answers and is allowed
    if (pinned && (isLocal(pinned) || (serverStatus[url.format(pinned)] && allowed(url.format(pinned))))) return pinned;
    var target = pickTranscoder(source, /[?&]forceTranscoding=/.test(req.url));
    if (id && id !== 'probe' && target) {
        hlsSessions[id] = target;
        // Only recent sessions matter; older ids are forgotten
        var ids = Object.keys(hlsSessions);
        if (ids.length > 50) delete hlsSessions[ids[0]];
    }
    return target;
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

function ipBits(address) {
    // An IPv4 or IPv6 address as a string of 32 or 128 bits, or null when it is a name
    var plain = String(address || '').split('%')[0];
    if (/^\d+\.\d+\.\d+\.\d+$/.test(plain)) return plain.split('.').map(function(n) { return (+n).toString(2).padStart(8, '0'); }).join('');
    if (plain.indexOf(':') === -1) return null;
    var halves = plain.split('::');
    var head = halves[0] ? halves[0].split(':') : [];
    var tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
    // The "::" stands for as many zero groups as the written ones leave out of eight
    var groups = head.concat(new Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), tail);
    return groups.map(function(g) { return parseInt(g, 16).toString(2).padStart(16, '0'); }).join('');
}

function isHomeNetwork(hostname) {
    // Hosts that never leave the home network: loopback, private and link-local ranges, and any address inside a subnet of the TV's own interfaces
    if (/^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i.test(hostname || '')) return true;
    var bits = ipBits(hostname);
    if (!bits) return false;
    var nets = os.networkInterfaces();
    return Object.keys(nets).some(function(name) {
        return (nets[name] || []).some(function(n) {
            var own = ipBits(n.address);
            var prefix = parseInt(String(n.cidr || '').split('/')[1], 10);
            return !!own && own.length === bits.length && prefix > 0 && own.slice(0, prefix) === bits.slice(0, prefix);
        });
    });
}

function subtitleTargets(from) {
    // Public subtitles are read over https only; plain http stays for the home network or when the viewer allows it
    var parsed = url.parse(from);
    if (parsed.protocol !== 'http:' || isHomeNetwork(parsed.hostname)) return [from];
    var secure = 'https:' + from.slice(5);
    return (tweaks.subtitles || {}).allowHttp ? [secure, from] : [secure];
}

function fetchFile(target, redirects, done) {
    // GET a small file over http or https, following redirects that never downgrade to plain http; done gets the body or null
    var settings = tweaks.subtitles || {};
    var finish = once(done);
    var parsed = url.parse(target);
    var client = parsed.protocol === 'https:' ? https : http;
    var req = client.get(Object.assign(parsed, { headers: { 'User-Agent': 'Stremio', 'Accept-Encoding': 'gzip' } }), function(res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
            res.resume();
            var next = url.resolve(target, res.headers.location);
            var downgrade = parsed.protocol === 'https:' && url.parse(next).protocol !== 'https:';
            return downgrade && !settings.allowHttp ? finish(null) : fetchFile(next, redirects - 1, finish);
        }
        if (res.statusCode !== 200) {
            res.resume();
            return finish(null);
        }
        var parts = [];
        var size = 0;
        res.on('data', function(part) {
            size += part.length;
            // A subtitle file is small; anything bigger is not one and must not fill the TV memory
            if (size > (settings.convertMaxBytes || 4194304)) {
                req.destroy();
                return finish(null);
            }
            parts.push(part);
        });
        res.on('end', function() { finish(Buffer.concat(parts)); });
        res.on('error', function() { finish(null); });
    });
    // A total deadline: a socket timeout alone misses a DNS lookup or a connection that never opens
    var deadline = setTimeout(function() {
        req.destroy();
        finish(null);
    }, settings.convertTimeoutMs || 20000);
    req.on('close', function() { clearTimeout(deadline); });
    req.on('error', function() { finish(null); });
}

function convertSubtitles(targets, done) {
    // Try each address in turn and convert the first file that reads as subtitles
    if (!targets.length) return done(null);
    fetchFile(targets[0], 5, function(body) {
        var vtt = null;
        try { vtt = body ? subtitles.toVtt(body) : null; } catch (err) { console.warn('subtitles unreadable', targets[0], err.message); }
        if (vtt) return done(vtt);
        convertSubtitles(targets.slice(1), done);
    });
}

function isOwnConverter(address) {
    // A subtitle address that already points at this converter, by loopback name or address
    var parsed = url.parse(address);
    return parsed.protocol === 'http:' && isLocal(parsed) && parsed.port === proxyUrl.port && parsed.pathname === '/subtitles.vtt';
}

function originalSubtitle(address) {
    // A track the page already pointed at this converter is read from its original address
    var from = String(address || '');
    while (isOwnConverter(from)) from = String(url.parse(from, true).query.from || '');
    return from;
}

function subtitleVtt(from, done) {
    // Clean WebVTT of an external subtitle, converted once and kept among the last few for player reloads and the sync
    var cached = subtitleCache.filter(function(entry) { return entry.from === from; })[0];
    if (cached) return done(cached.vtt);
    var started = Date.now();
    convertSubtitles(subtitleTargets(from), function(vtt) {
        console.log('subtitles', vtt ? 'converted ' + (vtt.split('-->').length - 1) + ' cues' : 'unavailable', 'in', Date.now() - started, 'ms from', from.slice(0, 80));
        if (vtt) subtitleCache = [{ from: from, vtt: vtt }].concat(subtitleCache).slice(0, 6);
        done(vtt);
    });
}

function serveSubtitles(req, res) {
    // Convert an external subtitle to clean WebVTT on the TV
    var from = originalSubtitle(url.parse(req.url, true).query.from);
    if (!/^https?:\/\//i.test(from)) {
        res.writeHead(400);
        return res.end();
    }
    subtitleVtt(from, function(vtt) {
        if (!vtt) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'subtitle unavailable or unreadable' }));
        }
        res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8' });
        res.end(vtt);
    });
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
    if (ownServer && isLocal(server)) ensureCacheDir(hash);
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
        return { servers: { coreUrl: 'http://127.0.0.1:8080/', candidates: ['http://127.0.0.1:11470/'], probePath: 'stats.json', probeTimeoutMs: 10000, recheckIntervalMs: 0 } };
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

function onNetworkChange() {
    // Servers found on the previous network must answer again before they get any request, and discovery runs at once
    var key = networkKey();
    if (key === lastNetwork) return;
    if (lastNetwork !== null) console.log('network changed:', key || 'no address');
    lastNetwork = key;
    lastScan = 0;
    lastSubnetScan = 0;
    Object.keys(discovered).forEach(function(found) { serverStatus[found] = false; });
}

function maybeDiscover() {
    // Look for a LAN server whenever none answers: at start, after a network change and every discover.everyMs
    var discover = tweaks.servers.discover || {};
    onNetworkChange();
    var lanUp = candidates.some(function(c) { return !isLocal(url.parse(c)) && serverStatus[c]; });
    if (!discover.enabled || !lanAllowed() || lanUp || Date.now() - lastScan < discover.everyMs) return;
    lastScan = Date.now();
    askLan(discover, function(answers) {
        if (answers.length) return adoptAnswers(answers, discover);
        // A server without the discovery responder can still be found on an IPv4 network by its port, less often since it probes every address
        var own = tvAddress('IPv4');
        if (!own || Date.now() - lastSubnetScan < discover.scanEveryMs) return;
        lastSubnetScan = Date.now();
        scanSubnet(own, discover, function(found) { if (found) adoptServer(found, {}); });
    });
}

function askLan(discover, done) {
    // One query datagram per address family: an IPv4 broadcast and the IPv6 group on every interface; done gets one answer per server after answerWaitMs
    var answers = {};
    var sockets = [];
    var onAnswer = function(message, rinfo) {
        var body = null;
        try { body = JSON.parse(message.toString('utf8')); } catch (_) { return; }
        if (!body || body.service !== 'stremio-lan' || !body.port) return;
        // A server with several interfaces answers once per interface and family; its addresses are merged
        var key = body.name + '|' + body.port;
        var answer = answers[key] = answers[key] || { body: body, from: [] };
        answer.from.push(rinfo.address);
    };
    var open = function(type, send) {
        var socket = dgram.createSocket(type === 'udp6' ? { type: 'udp6', ipv6Only: true } : 'udp4');
        sockets.push(socket);
        socket.on('message', onAnswer);
        socket.on('error', function(err) { console.warn('discovery', type, err.message); });
        socket.bind(0, function() { send(socket); });
    };
    var query = Buffer.from(discover.query);
    if (tvAddress('IPv4')) open('udp4', function(socket) {
        socket.setBroadcast(true);
        socket.send(query, discover.queryPort, '255.255.255.255', function() {});
    });
    var v6 = tvAddresses().filter(function(a) { return a.family === 'IPv6'; });
    if (v6.length) open('udp6', function(socket) {
        // The group is link-local, so each interface with IPv6 gets its own copy
        v6.map(function(a) { return a.interface; }).filter(function(name, i, all) { return all.indexOf(name) === i; }).forEach(function(name) {
            socket.send(query, discover.queryPort, discover.group6 + '%' + name, function() {});
        });
    });
    setTimeout(function() {
        sockets.forEach(function(socket) { try { socket.close(); } catch (_) {} });
        done(Object.keys(answers).map(function(key) { return answers[key]; }));
    }, discover.answerWaitMs);
}

function answerUrls(answer) {
    // Addresses to try for one answering server, the one the answer came from first since it proved reachable
    var hosts = answer.from.concat((answer.body.addresses || []).map(function(a) { return a.address; }));
    return hosts.filter(function(host, i) {
        return host && !/^fe80:/i.test(host) && hosts.indexOf(host) === i;
    }).map(function(host) { return 'http://' + urlHost(host) + ':' + answer.body.port + '/'; });
}

function adoptAnswers(answers, discover) {
    // Probe every address of the answering servers in parallel and adopt, per server, the first one in order that answers
    answers.forEach(function(answer) {
        var urls = answerUrls(answer);
        var results = urls.map(function() { return null; });
        var settle = function() {
            if (results.indexOf(null) !== -1) return;
            var best = urls.filter(function(u, i) { return results[i]; })[0];
            if (best) adoptServer(best, { subsyncPort: answer.body.subsyncPort, name: answer.body.name });
        };
        urls.forEach(function(candidate, i) {
            probe(candidate, function(ok) {
                results[i] = ok ? 1 : 0;
                settle();
            }, discover.probeTimeoutMs);
        });
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

function dropServer(server) {
    // Forget a discovered server that no longer answers, with the videos routed to it
    candidates.splice(candidates.indexOf(server), 1);
    if (transcoders.indexOf(server) !== -1) transcoders.splice(transcoders.indexOf(server), 1);
    Object.keys(routes).forEach(function(hash) { if (routes[hash] === server) delete routes[hash]; });
    delete serverStatus[server];
    delete probeFailures[server];
    delete serverInfo[server];
    delete discovered[server];
}

function adoptServer(found, info) {
    // Use the discovered server right after the TV, and as transcoder since it is the ffmpeg build
    console.log('discovered LAN streaming server', found, info.name || '');
    // Servers found earlier on another network or address are gone, so they leave the list instead of piling up
    Object.keys(discovered).forEach(function(old) { if (old !== found && !serverStatus[old]) dropServer(old); });
    discovered[found] = true;
    serverInfo[found] = info;
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
    entry.played = true;
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

function removeTorrent(entry) {
    // Remove one torrent from its server so it stops dialing peers, and forget what the proxy knew about it
    delete touched[entry.hash + '@' + entry.server.host];
    delete seeded[entry.hash + '@' + entry.server.host];
    forgetMirrors(entry);
    var req = http.get({ hostname: entry.server.hostname, port: entry.server.port, path: '/' + entry.hash + '/remove', timeout: 10000 }, function(res) { res.resume(); });
    req.on('timeout', function() { req.destroy(); });
    req.on('error', function() {});
}

function serveForget(reqUrl, res) {
    // Drop a torrent the source test rejected, unless a video is reading it
    var hash = String(url.parse(reqUrl, true).query.hash || '').toLowerCase();
    var removed = Object.keys(touched).filter(function(key) {
        return touched[key].hash === hash && touched[key].open === 0;
    }).map(function(key) {
        var entry = touched[key];
        removeTorrent(entry);
        console.log('removed rejected torrent', hash, 'on', entry.server.host);
        return entry.server.host;
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hash: hash, removed: removed }));
}

function removeIdleTorrents() {
    // A torrent nobody read for a while keeps dialing peers forever; through a carrier NAT that starves every new connection of the home
    var played = (tweaks.servers.idleTorrentMinutes || 0) * 60000;
    // A torrent only warmed in the background (source test, race, mirror) was never watched, so it goes much sooner
    var warmed = (tweaks.servers.warmIdleMinutes || 0) * 60000;
    if (!played) return;
    Object.keys(touched).forEach(function(key) {
        var entry = touched[key];
        var limit = entry.played || !warmed ? played : warmed;
        if (entry.open > 0 || Date.now() - entry.at < limit) return;
        removeTorrent(entry);
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
    // Only reads of the file itself count as watching; stats and track lists just keep the torrent from the idle cleanup
    if (hashMatch && STREAM_PATH.test(req.url)) touchTorrent(hashMatch[1].toLowerCase(), source, TORRENT_FILE_PATH.test(req.url) ? res : null);
    if (TORRENT_FILE_PATH.test(req.url)) {
        trackStream(res);
        // The first request of a torrent on a server creates it there with the configured peer sources
        return seedPeers(INFO_HASH.exec(req.url)[1].toLowerCase(), source, function() {
            readAhead.handle(req, res, source, function() { proxyRequest(req, res, source, source); });
        });
    }
    if (STREAM_PATH.test(req.url)) trackStream(res);
    if (!HLS_PATH.test(req.url)) {
        // Subtitle hashes and track lists are asked by the core and the tweaks alike; one server answer serves both
        if (answerSettings.enabled && req.method === 'GET' && META_PATH.test(req.url)) return shareAnswer(req, res, metaAnswers, 'meta', function(r, s, onResponse) { proxyRequest(r, s, source, source, null, onResponse); });
        return proxyRequest(req, res, source, source);
    }
    traceRequest(req, res, 'hls');
    // HLS conversion needs ffmpeg; answer at once when no server can convert so the player moves on
    var transcoder = transcoderFor(req, source);
    if (!transcoder) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'no transcoder available' }));
    }
    var session = hlsStartSession(req);
    if (session) return shareAnswer(req, res, hlsStartAnswers, session, function(r, s, onResponse) { proxyHls(r, s, transcoder, source, onResponse); });
    proxyHls(req, res, transcoder, source);
}

function hlsStartSession(req) {
    // The conversion session of an init or early segment request, the part the TV pipeline reads twice at every start
    var match = HLS_START_PATH.exec(req.url);
    if (!answerSettings.enabled || req.method !== 'GET' || !match) return null;
    return !match[2] || parseInt(match[2], 10) <= (answerSettings.hlsStart || {}).segments ? match[1] : null;
}

function shareAnswer(req, res, cache, group, send) {
    // Serve a repeated request from one upstream answer kept in RAM, fetching it once when it is not there
    var key = req.url + '|' + (req.headers.range || '');
    if (cache.serve(key, res)) return;
    var refetch = function(waiter) { send(req, waiter); };
    cache.begin(key, group);
    // Headers sent without an answer to copy mean the upstream failed; a caller that only hung up leaves the request running for the waiters
    res.on('close', function() { if (res.headersSent) cache.abandon(key, refetch); });
    send(req, res, function(proxyRes) { cache.capture(key, proxyRes, res, refetch); });
}

function alternateTranscoder(current, source) {
    // The other converter for a failed HLS request: the LAN server when the TV failed, the TV when the LAN server failed
    var other = isLocal(current) ? lanTranscoder(source) : localTranscoder();
    return other && other.host !== current.host ? other : null;
}

function proxyHls(req, res, transcoder, source, onResponse) {
    // Forward an HLS request; a converter that fails before answering hands the request, and the rest of the session, to the other converter
    var id = (/^\/hlsv2\/([^/?]+)/.exec(req.url) || [])[1];
    var moved = false;
    var moveOn = function(reason) {
        var other = req.method === 'GET' && !moved && !res.headersSent ? alternateTranscoder(transcoder, source) : null;
        if (!other) return false;
        moved = true;
        console.warn('hls', id, 'failed on', transcoder.host, '(' + reason + '), moving to', other.host);
        if (id && id !== 'probe') hlsSessions[id] = other;
        proxyRequest(req, res, other, source, null, onResponse);
        return true;
    };
    var opts = { hostname: transcoder.hostname, port: transcoder.port, path: rewriteLoopback(req.url, transcoder, source), method: req.method, headers: req.headers };
    var proxy = http.request(opts, function(proxyRes) {
        if (proxyRes.statusCode >= 500 && moveOn('HTTP ' + proxyRes.statusCode)) return proxyRes.resume();
        if (onResponse) return onResponse(proxyRes);
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
    });
    proxy.on('error', function(err) {
        if (moveOn(err.code || err.message)) return;
        if (res.headersSent) return res.destroy();
        res.writeHead(502);
        res.end();
    });
    // Release the upstream request as soon as the player closes its side, unless it moved or its answer is shared with other callers
    res.on('close', function() { if (!moved && !onResponse) proxy.destroy(); });
    sendBody(req, proxy);
}

function sendBody(req, proxy) {
    // Forward the caller's body, or just finish the upstream request when it was already read for an earlier attempt
    if (req.readableEnded) return proxy.end();
    req.pipe(proxy);
}

function traceRequest(req, res, label) {
    // Debug log of when a request got its answer and when it finished, to find where a start waits
    var started = Date.now();
    var headersAt = null;
    var writeHead = res.writeHead;
    res.writeHead = function() {
        headersAt = Date.now() - started;
        return writeHead.apply(res, arguments);
    };
    res.on('close', function() { console.log(label, req.url.split('?')[0].slice(0, 70), res.statusCode, 'answer', headersAt, 'ms, end', Date.now() - started, 'ms'); });
}

function trackStream(res) {
    // Count open video responses so the upstream is not switched under them
    activeStreams++;
    var released = false;
    var release = function() { if (!released) { released = true; activeStreams--; } };
    res.on('finish', release);
    res.on('close', release);
}

function proxyRequest(req, res, target, source, path, onResponse) {
    // Forward the request to the chosen server, rewriting media URLs it must read from the source
    var opts = { hostname: target.hostname, port: target.port, path: rewriteLoopback(path || req.url, target, source), method: req.method, headers: req.headers };
    var proxy = http.request(opts, function(proxyRes) {
        if (onResponse) return onResponse(proxyRes);
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
    });
    // An upstream failure after headers were sent can only drop the connection
    proxy.on('error', function() {
        if (res.headersSent) return res.destroy();
        res.writeHead(502);
        res.end();
    });
    // Release the upstream request as soon as the player closes its side, unless its answer is shared with other callers
    res.on('close', function() { if (!onResponse) proxy.destroy(); });
    sendBody(req, proxy);
}

function subsyncServer(source) {
    // The sync service runs on the host of the LAN ffmpeg server, on its own port
    var transcoder = lanTranscoder(source);
    if (!transcoder || isLocal(transcoder)) return null;
    // A discovered server tells its own sync port; a configured one uses the default
    var info = serverInfo[url.format(transcoder)] || {};
    return url.parse('http://' + urlHost(transcoder.hostname) + ':' + (info.subsyncPort || tweaks.servers.subsyncPort) + '/');
}

function answerJson(res, status, body) {
    // JSON answer for the page
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

function syncOnTv(query, source, done) {
    // Measure the subtitle delay with the TV ffmpeg, one job at a time, reusing a result of the same subtitle and audio slot
    var settings = (tweaks.subtitles || {}).tvSync || {};
    var key = query.media + '|' + query.sub + '|' + Math.floor(query.at / settings.windowS);
    if (syncResults[key]) return done(null, Object.assign({ cached: true }, syncResults[key]));
    var from = originalSubtitle(query.sub);
    // The TV reads the video from the server holding it, not through this proxy and its read-ahead window
    var reader = url.parse(candidates.filter(function(c) { return isLocal(url.parse(c)); })[0] || 'http://127.0.0.1:11470/');
    var media = rewriteLoopback(String(query.media), reader, source);
    syncQueue = syncQueue.then(function() {
        return new Promise(function(resolve) { subtitleVtt(from, resolve); }).then(function(vtt) {
            if (!vtt) throw new Error('subtitle unavailable or unreadable');
            return subsync.sync(Object.assign({ ffmpeg: process.env.FFMPEG_BIN, media: media, subtitle: vtt, at: query.at }, settings));
        }).then(function(result) {
            // Only the latest results are kept, enough for the slots of the videos being watched
            Object.keys(syncResults).slice(0, -20).forEach(function(old) { delete syncResults[old]; });
            syncResults[key] = result;
            console.log('subsync on the TV', JSON.stringify(result));
            done(null, result);
        }, function(err) {
            console.warn('subsync on the TV failed', err.message);
            done(err);
        });
    });
}

function serveSubsync(req, res) {
    // Align a subtitle with the audio around the playback position on the TV; the LAN sync service only answers when the TV cannot or is unsure
    var source = sourceFor(req.url);
    var query = url.parse(req.url, true).query;
    query.at = parseFloat(query.at || '0');
    var lan = subsyncServer(source);
    var askLan = function(status, error) {
        if (!lan) return answerJson(res, status, { error: error });
        proxyRequest(req, res, lan, source, req.url.replace('/__tweaks/subsync', '/sync'));
    };
    var subs = tweaks.subtitles || {};
    if (!query.media || !query.sub) return answerJson(res, 400, { error: 'media and sub are required' });
    if (subs.syncOnTv === false || !fs.existsSync(process.env.FFMPEG_BIN)) return askLan(503, 'no sync available');
    syncOnTv(query, source, function(err, result) {
        if (err) return askLan(500, err.message);
        if (result.confidence >= (subs.syncMinConfidence || 0.5) || !lan) return answerJson(res, 200, result);
        console.log('subsync on the TV unsure (' + result.confidence + '), asking the LAN sync service');
        askLan(200);
    });
}

function serveDeviceInfo(res) {
    // The bundled server answers this by test-encoding with every desktop GPU profile, failing each time on a TV; a TV has none
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ availableHardwareAccelerations: false }));
}

function serveStatus(res) {
    // Report the selected upstream for the diagnostics panel
    res.writeHead(200, { 'Content-Type': 'application/json' });
    var transcoder = pickTranscoder(upstream);
    var subsync = subsyncServer(upstream);
    res.end(JSON.stringify({ upstream: url.format(upstream), candidates: serverStatus, transcoder: transcoder ? url.format(transcoder) : null, subsync: subsync ? url.format(subsync) : null, fallback: remoteFallback(), routes: routes, activeStreams: activeStreams, readAhead: readAhead.status(), answerCache: { enabled: answerSettings.enabled !== false, meta: metaAnswers.status(), hlsStart: hlsStartAnswers.status() }, mirrors: Object.keys(mirrors).reduce(function(all, p) { all[p] = mirrors[p].map(function(m) { return m.path + '@' + m.server.host; }); return all; }, {}) }));
}

// Single server, reachable from this TV only since its routes change settings and read logs: tweaks routes, static files, then the streaming proxy
http.createServer(function(req, res) {
    var urlPath = req.url.split('?')[0];
    if (urlPath === '/__tweaks/status') return serveStatus(res);
    if (urlPath === '/__tweaks/route') return serveRoute(req.url, res);
    if (urlPath === '/__tweaks/warm') return serveWarm(req.url, res);
    if (urlPath === '/__tweaks/mirror') return serveMirror(req.url, res);
    if (urlPath === '/__tweaks/logs') return serveLogs(req.url, res);
    if (urlPath === '/__tweaks/forget') return serveForget(req.url, res);
    if (urlPath === '/device-info' && isLocal(sourceFor(req.url))) return serveDeviceInfo(res);
    if (urlPath === '/subtitles.vtt' && (tweaks.subtitles || {}).convert !== false) return serveSubtitles(req, res);
    if (urlPath === '/__tweaks/subsync') return serveSubsync(req, res);
    if (urlPath === '/__tweaks/overrides' && req.method === 'POST') return serveOverrides(req, res);
    serveStatic(urlPath, res, function() { proxyToStreaming(req, res); });
}).listen(proxyUrl.port, proxyUrl.hostname, function() {
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

function cacheRoot() {
    // Where the bundled server keeps one folder per torrent
    return path.join(process.env.APP_PATH, 'stremio-cache');
}

function ensureCacheDir(hash) {
    // With the disk cache off the server never creates the torrent folder, then fails to save the torrent metadata there; saved metadata also reopens a title without asking peers again
    try { fs.mkdirSync(path.join(cacheRoot(), hash), { recursive: true }); } catch (err) { console.error('torrent folder not created', hash, err.message); }
}

function pruneCache(keep) {
    // Keep the metadata of the most recent torrents only, so the small app partition never fills up
    var root = cacheRoot();
    var dirs = [];
    try {
        dirs = fs.readdirSync(root).map(function(name) { return { name: name, at: fs.statSync(path.join(root, name)).mtimeMs }; });
    } catch (_) {
        return;
    }
    dirs.sort(function(a, b) { return b.at - a.at; }).slice(keep).forEach(function(dir) {
        try { fs.rmSync(path.join(root, dir.name), { recursive: true, force: true }); } catch (err) { console.error('old torrent folder not removed', dir.name, err.message); }
    });
}

function renewDevMode(attempt) {
    // Reset the Developer Mode session from the TV itself, so the TV never removes the app when no computer renews it
    var settings = tweaks.devMode || {};
    if (settings.keepAlive === false) return;
    var token = '';
    try { token = fs.readFileSync(settings.tokenPath, 'utf8').trim(); } catch (err) { return console.warn('dev mode token not readable', err.code); }
    if (!/^[0-9A-Za-z]+$/.test(token)) return console.warn('dev mode token has an unexpected format');
    attempt = attempt || 1;
    // A dropped connection or a refused answer is tried again a few minutes later instead of waiting for the next long interval
    var retry = once(function(reason) {
        var again = attempt < (settings.retries || 0);
        console.warn('dev mode renewal failed', reason, again ? '(attempt ' + attempt + ', retrying in ' + Math.round(settings.retryMs / 1000) + ' s)' : '(attempt ' + attempt + ', giving up until the next renewal)');
        if (again) setTimeout(function() { renewDevMode(attempt + 1); }, settings.retryMs);
    });
    var target = url.parse(settings.resetUrl + '?sessionToken=' + encodeURIComponent(token));
    // The LG host has several addresses and some never answer from a home network; each one is tried in turn, as a browser does
    dns.lookup(target.hostname, { all: true }, function(err, addresses) {
        if (err) return retry(err.code || err.message);
        renewThrough(target, addresses, settings, attempt, retry);
    });
}

function renewThrough(target, addresses, settings, attempt, retry) {
    // Ask one address of the reset service; a connection that fails or stays silent moves on to the next address
    if (!addresses.length) return retry('no address of ' + target.hostname + ' answered');
    var address = addresses[0];
    var moveOn = once(function(reason) {
        console.warn('dev mode renewal: ' + address.address + ' did not answer (' + reason + '), trying the next address');
        renewThrough(target, addresses.slice(1), settings, attempt, retry);
    });
    // Node asks a custom lookup for one address or, when it races address families, for a list
    var lookup = function(host, opts, callback) {
        if (opts && opts.all) return callback(null, [address]);
        callback(null, address.address, address.family);
    };
    var options = Object.assign({}, target, { timeout: settings.answerTimeoutMs, lookup: lookup });
    var req = https.get(options, function(res) {
        var body = '';
        res.setEncoding('utf8');
        res.on('data', function(part) { body += part; });
        // The answer is logged by its outcome only, so the session token never reaches a log
        res.on('end', function() {
            if (/"result"\s*:\s*"success"/.test(body)) return console.log('dev mode session renewed through ' + address.address + (attempt > 1 ? ' (attempt ' + attempt + ')' : ''));
            retry('HTTP ' + res.statusCode);
        });
        res.on('error', function(err) { retry(err.code || err.message); });
    });
    // An address that never opens a connection is dropped quickly; once connected, the slow reset service gets the longer answer limit
    req.on('socket', function(socket) {
        var connectTimer = setTimeout(function() { req.destroy(new Error('no connection in ' + Math.round(settings.connectTimeoutMs / 1000) + ' s')); }, settings.connectTimeoutMs);
        socket.once('connect', function() { clearTimeout(connectTimer); });
        socket.once('close', function() { clearTimeout(connectTimer); });
    });
    req.on('timeout', function() { req.destroy(new Error('no answer in ' + Math.round(settings.answerTimeoutMs / 1000) + ' s')); });
    req.on('error', function(err) { moveOn(err.code || err.message); });
}

function seedServerSettings() {
    // A TV has none of the GPUs the bundled server tests at start, and an update replaces its saved settings; saying so up front skips the failing tests
    var file = path.join(process.env.APP_PATH, 'server-settings.json');
    var settings = {};
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
    if (settings.transcodeHardwareAccel === false) return;
    settings.transcodeHardwareAccel = false;
    try { fs.writeFileSync(file, JSON.stringify(settings, null, 4)); } catch (err) { console.error('server settings not writable', err.message); }
}

// Start the bundled server only when no streaming server already owns :11470, saving RAM
probe('http://127.0.0.1:11470/', function(running) {
    if (!running) {
        seedServerSettings();
        pruneCache((tweaks.servers || {}).keepTorrentFolders || 30);
        ownServer = true;
        require('./server.js');
    }
    selectUpstream();
    if (tweaks.servers.recheckIntervalMs) {
        setInterval(selectUpstream, tweaks.servers.recheckIntervalMs);
    }
    setInterval(removeIdleTorrents, 60000);
    // The session counts 1000 hours down; one renewal shortly after start and then on a long interval keeps it full
    var devMode = tweaks.devMode || {};
    if (devMode.everyHours) {
        setTimeout(renewDevMode, devMode.startDelayMs);
        setInterval(renewDevMode, devMode.everyHours * 3600000);
    }
});
