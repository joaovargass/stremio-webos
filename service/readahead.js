// RAM read-ahead buffer for the streaming proxy.
//
// The webOS media pipeline keeps only ~30 s of video buffered. This module keeps
// one upstream reader per playing file, downloads ahead of the player into memory
// up to a budget that shrinks when the TV runs low on RAM, and serves the player
// from that memory. Requests far away from the buffered window (container index
// reads at the end of a file) are passed through untouched.
var fs = require('fs');
var http = require('http');
var EventEmitter = require('events');

var MB = 1024 * 1024;

function availableBytes() {
    // MemAvailable reflects reclaimable cache, unlike os.freemem() on Node 16
    try {
        var match = /MemAvailable:\s+(\d+)\s+kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
        return match ? parseInt(match[1], 10) * 1024 : Infinity;
    } catch (_) {
        return Infinity;
    }
}

function parseRange(header) {
    // Only single "bytes=start-end" ranges are handled; anything else passes through
    var match = /^bytes=(\d+)-(\d*)$/.exec(header || 'bytes=0-');
    return match ? { start: parseInt(match[1], 10), end: match[2] ? parseInt(match[2], 10) : null } : null;
}

function ReadAhead(config) {
    this.config = config;
    this.buffer = null;
    // Set by the proxy: other torrents verified to hold the same file, as { key, hostname, port, path }
    this.mirrorsFor = function() { return []; };
}

ReadAhead.prototype.budget = function() {
    // Cap the window by config and by the RAM left above the reserve
    var spare = availableBytes() - this.config.reserveMb * MB;
    return Math.max(this.config.minMb * MB, Math.min(this.config.maxMb * MB, spare));
};

ReadAhead.prototype.limitFor = function(window) {
    // Keep a small window while the player only probes headers, the full budget once it reads on
    var warm = (this.config.warmupMb || 4) * MB;
    var pos = window.minReaderPos();
    var consumed = pos === null ? 0 : pos - window.origin;
    return consumed < warm ? warm : this.budget();
};

ReadAhead.prototype.status = function() {
    // Snapshot for the diagnostics panel
    var b = this.buffer;
    if (!b) return { enabled: this.config.enabled, active: false, budgetMb: Math.round(this.budget() / MB) };
    var reader = b.minReaderPos();
    return {
        enabled: this.config.enabled,
        active: true,
        path: b.path,
        total: b.total,
        start: b.start,
        end: b.end,
        readerPos: reader,
        aheadBytes: reader === null ? 0 : Math.max(0, b.end - reader),
        readers: b.readers.length,
        heldBytes: b.heldBytes(),
        mirrorBytes: b.mirrorBytes,
        segments: b.segments.length,
        paused: b.paused,
        done: b.done,
        limitMb: Math.round(this.limitFor(b) / MB),
        budgetMb: Math.round(this.budget() / MB)
    };
};

ReadAhead.prototype.resetFor = function(hash) {
    // Drop the window of one torrent so its next request opens a fresh one; other files keep theirs
    var b = this.buffer;
    if (!b || b.path.toLowerCase().indexOf(hash) === -1) return false;
    b.destroy();
    this.buffer = null;
    return true;
};

ReadAhead.prototype.reroute = function(hash, upstream) {
    // Move the open window of one torrent to another server without the player noticing; false when there is none
    var b = this.buffer;
    if (!b || b.done || b.failed || b.path.toLowerCase().indexOf(hash) === -1) return false;
    b.switchSource(upstream);
    return true;
};

ReadAhead.prototype.handle = function(req, res, upstream, passthrough) {
    // Serve a stream request from the window, or decide to pass it through
    var range = parseRange(req.headers.range);
    if (!this.config.enabled || req.method !== 'GET' || !range) return passthrough();
    var b = this.buffer;
    var near = b && b.path === req.url && range.start >= b.start && range.start <= b.end + this.config.joinGapMb * MB;
    // A window someone is reading stays put: far reads of the same file and reads of other files go straight through
    if (b && !near && b.readers.length > 0) return passthrough();
    if (!near) {
        if (b) b.destroy();
        b = this.buffer = new Window(this, req, upstream, range.start);
    }
    b.attach(req, res, range, passthrough);
};

function Window(owner, req, upstream, start) {
    EventEmitter.call(this);
    this.owner = owner;
    this.path = req.url;
    this.origin = start;
    this.start = start;
    this.end = start;
    this.chunks = [];
    this.readers = [];
    this.headers = null;
    this.total = null;
    this.failed = false;
    this.done = false;
    this.paused = false;
    this.idleTimer = null;
    this.requestHeaders = req.headers;
    this.generation = 0;
    this.segments = [];
    this.helpers = {};
    this.mirrorBytes = 0;
    this.open(upstream, start);
    // Other torrents of the same file download later parts of it in parallel while the main read goes on
    var self = this;
    this.mirrorTimer = setInterval(function() { self.fillFromMirrors(); }, 1000);
}

Window.prototype = Object.create(EventEmitter.prototype);

Window.prototype.open = function(upstream, from) {
    // Start the single sequential upstream read for this window; events of a replaced read are ignored
    var self = this;
    var gen = ++this.generation;
    var current = function() { return gen === self.generation; };
    var headers = Object.assign({}, this.requestHeaders, { range: 'bytes=' + from + '-' });
    this.upstream = upstream;
    this.upstreamReq = http.request({ hostname: upstream.hostname, port: upstream.port, path: this.path, method: 'GET', headers: headers }, function(res) {
        if (!current()) return res.resume();
        var contentRange = /\/(\d+)$/.exec(res.headers['content-range'] || '');
        if (res.statusCode !== 206 || !contentRange) {
            res.resume();
            return self.fail();
        }
        // The first answer fixes the size and headers the player sees; a later server only continues the bytes
        if (self.total === null) {
            self.total = parseInt(contentRange[1], 10);
            self.headers = res.headers;
        }
        self.upstreamRes = res;
        res.on('data', function(chunk) { if (current()) self.push(chunk); });
        res.on('end', function() { if (current()) { self.done = true; self.emit('data'); } });
        res.on('error', function() { if (current()) self.fail(); });
        self.emit('headers');
    });
    this.upstreamReq.on('error', function() { if (current()) self.fail(); });
    this.upstreamReq.end();
};

Window.prototype.switchSource = function(upstream) {
    // The same torrent file has identical bytes on every server: continue right after the last byte held
    var previous = this.upstreamReq;
    this.paused = false;
    this.open(upstream, this.end);
    if (previous) previous.destroy();
};

Window.prototype.fillFromMirrors = function() {
    // Ask every idle mirror for the next part past what is held or requested, within the memory budget
    if (this.failed || this.done || this.total === null) return;
    var mirrors = this.owner.mirrorsFor(this.path);
    if (!mirrors.length) return;
    var chunk = ((this.owner.config.mirrors || {}).chunkMb || 8) * MB;
    var limit = this.owner.limitFor(this);
    var self = this;
    var used = this.heldBytes() + this.inflightBytes();
    // Mirror parts take at most half the budget, so the main read always has room and the player never waits on a gap
    var mirrorUsed = this.segmentBytes() + this.inflightBytes();
    mirrors.forEach(function(mirror) {
        var helper = self.helpers[mirror.key] = self.helpers[mirror.key] || { busy: false, restUntil: 0 };
        if (helper.busy || Date.now() < helper.restUntil) return;
        // The part right after the main read stays with the main read; mirrors take the ones after it
        var from = Math.max(self.end + chunk, self.frontier());
        if (from >= self.total) return;
        var to = Math.min(from + chunk, self.total) - 1;
        if (used + (to - from + 1) > limit || mirrorUsed + (to - from + 1) > limit / 2) return;
        used += to - from + 1;
        mirrorUsed += to - from + 1;
        self.fetchMirror(mirror, helper, from, to);
    });
};

Window.prototype.frontier = function() {
    // First byte nobody holds or has asked for yet
    var edge = this.end;
    this.segments.forEach(function(s) { edge = Math.max(edge, s.offset + s.data.length); });
    var helpers = this.helpers;
    Object.keys(helpers).forEach(function(key) { if (helpers[key].busy) edge = Math.max(edge, helpers[key].to + 1); });
    return edge;
};

Window.prototype.segmentBytes = function() {
    // Bytes held past the contiguous window, waiting for the main read to reach them
    return this.segments.reduce(function(sum, s) { return sum + s.data.length; }, 0);
};

Window.prototype.inflightBytes = function() {
    // Bytes mirrors were asked for and have not delivered yet
    var helpers = this.helpers;
    return Object.keys(helpers).reduce(function(sum, key) { return sum + (helpers[key].busy ? helpers[key].to - helpers[key].from + 1 : 0); }, 0);
};

Window.prototype.fetchMirror = function(mirror, helper, from, to) {
    // Read one part from a mirror; a failed or short answer rests that mirror for 30 s
    var self = this;
    var parts = [];
    helper.busy = true;
    helper.from = from;
    helper.to = to;
    var done = function(ok) {
        if (!helper.busy) return;
        helper.busy = false;
        helper.req = null;
        var data = ok ? Buffer.concat(parts) : null;
        if (!data || data.length !== to - from + 1) {
            helper.restUntil = Date.now() + 30000;
            return;
        }
        if (self.failed) return;
        self.mirrorBytes += data.length;
        self.segments.push({ offset: from, data: data });
        self.segments.sort(function(a, b) { return a.offset - b.offset; });
        self.mergeSegments();
    };
    helper.req = http.get({ hostname: mirror.hostname, port: mirror.port, path: mirror.path, headers: { Range: 'bytes=' + from + '-' + to } }, function(res) {
        // A mirror of another size is a different file, whatever its name says
        var total = /\/(\d+)$/.exec(res.headers['content-range'] || '');
        if (res.statusCode !== 206 || !total || parseInt(total[1], 10) !== self.total) {
            res.resume();
            return done(false);
        }
        res.on('data', function(part) { parts.push(part); });
        res.on('end', function() { done(true); });
        res.on('error', function() { done(false); });
    });
    helper.req.setTimeout(120000, function() { helper.req.destroy(); });
    helper.req.on('error', function() { done(false); });
};

Window.prototype.mergeSegments = function() {
    // Parts the main read has reached join the window; the main read then jumps past them
    var jumped = false;
    while (this.segments.length && this.segments[0].offset <= this.end) {
        var seg = this.segments.shift();
        var skip = this.end - seg.offset;
        if (skip >= seg.data.length) continue;
        var data = skip ? seg.data.slice(skip) : seg.data;
        this.chunks.push({ offset: this.end, data: data });
        this.end += data.length;
        jumped = true;
    }
    if (!jumped) return;
    if (this.end >= this.total) {
        this.done = true;
        if (this.upstreamReq) this.upstreamReq.destroy();
    } else {
        // A new main read continues after the merged part; events of the previous one are ignored
        var previous = this.upstreamReq;
        this.paused = false;
        this.open(this.upstream, this.end);
        if (previous) previous.destroy();
    }
    this.trim();
    this.emit('data');
};

Window.prototype.fail = function() {
    // Wake every reader so it can fall back or finish
    this.failed = true;
    this.emit('headers');
    this.emit('data');
};

Window.prototype.push = function(chunk) {
    // Append downloaded bytes and pause the upstream once the budget is reached
    this.chunks.push({ offset: this.end, data: chunk });
    this.end += chunk.length;
    this.trim();
    // The main read may just have reached a part a mirror already delivered
    if (this.segments.length && this.segments[0].offset <= this.end) return this.mergeSegments();
    if (this.heldBytes() >= this.owner.limitFor(this) && !this.paused) {
        this.paused = true;
        this.upstreamRes.pause();
    }
    this.emit('data');
};

Window.prototype.minReaderPos = function() {
    // The slowest reader decides what can be evicted
    if (!this.readers.length) return null;
    return Math.min.apply(null, this.readers.map(function(r) { return r.pos; }));
};

Window.prototype.aheadBytes = function() {
    // Bytes buffered past the slowest reader (all of them when nobody reads yet)
    var pos = this.minReaderPos();
    return this.end - (pos === null ? this.start : pos);
};

Window.prototype.heldBytes = function() {
    // Everything kept in memory ahead of the slowest reader, mirror parts included
    return this.aheadBytes() + this.segmentBytes();
};

Window.prototype.trim = function() {
    // Drop chunks fully behind the slowest reader minus the back buffer
    var pos = this.minReaderPos();
    if (pos === null) return;
    var keepFrom = pos - this.owner.config.backMb * MB;
    while (this.chunks.length && this.chunks[0].offset + this.chunks[0].data.length <= keepFrom) {
        var dropped = this.chunks.shift();
        this.start = dropped.offset + dropped.data.length;
    }
};

Window.prototype.maybeResume = function() {
    // Resume downloading once the readers consumed a quarter of the budget
    this.trim();
    if (this.paused && this.heldBytes() < this.owner.limitFor(this) * 0.75) {
        this.paused = false;
        this.upstreamRes.resume();
    }
};

Window.prototype.slice = function(pos, limit) {
    // Return the bytes stored at pos, at most limit long, without copying whole chunks
    for (var i = 0; i < this.chunks.length; i++) {
        var c = this.chunks[i];
        if (pos >= c.offset && pos < c.offset + c.data.length) {
            var from = pos - c.offset;
            return c.data.slice(from, Math.min(c.data.length, from + limit));
        }
    }
    return null;
};

Window.prototype.attach = function(req, res, range, passthrough) {
    // Answer the player once the file size is known, then stream from memory
    var self = this;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    var start = function() {
        if (self.failed || self.total === null) return passthrough();
        var last = range.end === null ? self.total - 1 : Math.min(range.end, self.total - 1);
        var headers = {
            'Content-Type': self.headers['content-type'] || 'application/octet-stream',
            'Accept-Ranges': 'bytes',
            'Content-Range': 'bytes ' + range.start + '-' + last + '/' + self.total,
            'Content-Length': last - range.start + 1
        };
        res.writeHead(206, headers);
        self.serve(res, { pos: range.start, last: last });
    };
    if (this.headers || this.failed) start();
    else this.once('headers', start);
};

Window.prototype.serve = function(res, reader) {
    // Copy bytes to the player respecting its backpressure, waiting when the window is empty
    var self = this;
    this.readers.push(reader);
    var finished = false;
    var finish = function() {
        if (finished) return;
        finished = true;
        self.removeListener('data', pump);
        self.readers = self.readers.filter(function(r) { return r !== reader; });
        self.maybeResume();
        if (!self.readers.length) self.scheduleIdle();
    };
    var pump = function() {
        // A reader waiting for drain must not be written to again
        if (reader.waitingDrain) return;
        while (!finished && reader.pos <= reader.last) {
            var bytes = self.slice(reader.pos, Math.min(256 * 1024, reader.last - reader.pos + 1));
            if (!bytes) break;
            reader.pos += bytes.length;
            var more = res.write(bytes);
            self.maybeResume();
            if (!more) {
                reader.waitingDrain = true;
                return res.once('drain', function() { reader.waitingDrain = false; pump(); });
            }
        }
        if (reader.pos > reader.last || (self.done && reader.pos >= self.end) || self.failed) {
            res.end();
            finish();
        }
    };
    res.on('close', finish);
    this.on('data', pump);
    pump();
};

Window.prototype.scheduleIdle = function() {
    // Free the memory when the player stays away from this window
    var self = this;
    this.idleTimer = setTimeout(function() {
        if (!self.readers.length && self.owner.buffer === self) {
            self.destroy();
            self.owner.buffer = null;
        }
    }, this.owner.config.idleMs);
};

Window.prototype.destroy = function() {
    // Abort the upstream read, end pending readers and release every chunk
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.mirrorTimer) clearInterval(this.mirrorTimer);
    if (this.upstreamReq) this.upstreamReq.destroy();
    var helpers = this.helpers;
    Object.keys(helpers).forEach(function(key) { if (helpers[key].req) helpers[key].req.destroy(); });
    this.failed = true;
    this.emit('data');
    this.chunks = [];
    this.segments = [];
    this.removeAllListeners();
};

module.exports = ReadAhead;
