// Short-lived RAM copies of streaming server answers that the TV asks for more than once.
//
// The core and the tweaks each ask for the subtitle hash and the track list of the same
// video, and the TV media pipeline reads the start of an HLS conversion twice (once to
// probe it, once to play it). Every repeat costs the TV server real work: track parsing,
// file reads on a cold torrent, or a whole segment encoded again after the converter was
// told to cancel its running job. One answer is streamed to the first caller while it is
// copied; identical requests that arrive meanwhile wait for it, later ones get the copy.

function AnswerCache(config) {
    this.config = config;
    this.entries = {};
    this.bytes = 0;
}

AnswerCache.prototype.drop = function(key) {
    // Forget one stored answer and release its bytes
    var entry = this.entries[key];
    if (!entry) return;
    if (entry.body) this.bytes -= entry.body.length;
    delete this.entries[key];
};

AnswerCache.prototype.evict = function(group) {
    // Keep one group only when configured, then remove expired and oldest answers until the limits hold
    var self = this;
    var now = Date.now();
    Object.keys(this.entries).forEach(function(key) {
        var entry = self.entries[key];
        if (!entry.body) return;
        if (now - entry.at > self.config.ttlMs || (self.config.singleGroup && entry.group !== group)) self.drop(key);
    });
    // Oldest first, so the newest answers survive the size and count limits
    var keys = Object.keys(this.entries).filter(function(key) { return self.entries[key].body; }).sort(function(a, b) { return self.entries[a].at - self.entries[b].at; });
    while (keys.length && (this.bytes > this.config.maxBytes || keys.length > this.config.maxEntries)) this.drop(keys.shift());
};

AnswerCache.prototype.reply = function(res, entry) {
    // Write a stored answer to a caller that is still listening
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(entry.status, entry.headers);
    res.end(entry.body);
};

AnswerCache.prototype.serve = function(key, res) {
    // Answer from memory or join the identical request in flight; false when the caller must fetch it
    var entry = this.entries[key];
    if (!entry) return false;
    if (entry.waiters) {
        entry.waiters.push(res);
        return true;
    }
    if (Date.now() - entry.at > this.config.ttlMs) {
        this.drop(key);
        return false;
    }
    this.reply(res, entry);
    return true;
};

AnswerCache.prototype.begin = function(key, group) {
    // Mark the request as in flight before its answer arrives, so identical ones wait for it
    this.entries[key] = { waiters: [], group: group, started: false };
};

AnswerCache.prototype.abandon = function(key, refetch) {
    // A request that failed before any answer sends its waiters to fetch their own
    var entry = this.entries[key];
    if (!entry || !entry.waiters || entry.started) return;
    delete this.entries[key];
    entry.waiters.forEach(function(waiter) { if (!waiter.destroyed && !waiter.headersSent) refetch(waiter); });
};

AnswerCache.prototype.capture = function(key, proxyRes, res, refetch) {
    // Stream the upstream answer to the first caller, copy it, then keep it and hand it to the callers that waited
    var self = this;
    var entry = this.entries[key] && this.entries[key].waiters ? this.entries[key] : { waiters: [], group: null };
    this.entries[key] = entry;
    var chunks = [];
    var size = 0;
    var complete = false;
    entry.started = true;
    if (!res.destroyed) res.writeHead(proxyRes.statusCode, proxyRes.headers);
    // A first caller that hangs up stops receiving, while the copy keeps filling for the others
    proxyRes.on('data', function(chunk) {
        size += chunk.length;
        if (!res.destroyed) res.write(chunk);
        // An answer larger than one entry may hold is only streamed, never copied
        if (size <= self.config.maxEntryBytes) chunks.push(chunk);
    });
    proxyRes.on('end', function() {
        complete = true;
        if (!res.destroyed) res.end();
    });
    proxyRes.on('close', function() {
        delete self.entries[key];
        // An answer cut short upstream can only drop the first caller's connection
        if (!complete && !res.destroyed) res.destroy();
        var keep = complete && (proxyRes.statusCode === 200 || proxyRes.statusCode === 206) && size <= self.config.maxEntryBytes;
        if (!keep) return entry.waiters.forEach(function(waiter) { if (!waiter.destroyed && !waiter.headersSent) refetch(waiter); });
        var stored = { at: Date.now(), group: entry.group, status: proxyRes.statusCode, headers: proxyRes.headers, body: Buffer.concat(chunks) };
        self.entries[key] = stored;
        self.bytes += stored.body.length;
        self.evict(entry.group);
        entry.waiters.forEach(function(waiter) { self.reply(waiter, stored); });
    });
};

AnswerCache.prototype.status = function() {
    // Stored answers and their bytes, for the diagnostics status
    var self = this;
    return { entries: Object.keys(this.entries).filter(function(key) { return self.entries[key].body; }).length, bytes: this.bytes };
};

module.exports = AnswerCache;
