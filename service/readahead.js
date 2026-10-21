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
    this.open(upstream, start);
}

Window.prototype = Object.create(EventEmitter.prototype);

Window.prototype.open = function(upstream, from) {
    // Start the single sequential upstream read for this window; events of a replaced read are ignored
    var self = this;
    var gen = ++this.generation;
    var current = function() { return gen === self.generation; };
    var headers = Object.assign({}, this.requestHeaders, { range: 'bytes=' + from + '-' });
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
    if (this.aheadBytes() >= this.owner.limitFor(this) && !this.paused) {
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
    if (this.paused && this.aheadBytes() < this.owner.limitFor(this) * 0.75) {
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
    if (this.upstreamReq) this.upstreamReq.destroy();
    this.failed = true;
    this.emit('data');
    this.chunks = [];
    this.removeAllListeners();
};

module.exports = ReadAhead;
