// Source evidence: what each torrent file under consideration really delivers, measured over time from the
// streaming server statistics and shared by the source test of the title page and the doctor of the player.
// A verdict needs time and a comparison: on a lossy home network trackers can take a minute to answer, so a
// source is called dead only when it found no peer and no byte for deadAfterMs while another source measured in
// the same period proved that the network reaches swarms. Speed is the bytes the file gained over a window,
// never a single sample, so a short burst does not make a source look better than it is, and it is judged only after
// rampMs past the first byte, while a swarm is still adding peers.
(function () {
    var config = (window.STREMIO_TWEAKS || {}).evidence || {};
    var shared = window.__twkShared;
    var RATED = ['fast', 'ok', 'slow', 'tooSlow'];
    var entries = {};
    var inFlight = {};

    function keyOf(stream) {
        // A torrent file as the streaming server names it; direct links have no swarm to measure
        return stream && stream.infoHash ? stream.infoHash.toLowerCase() + '/' + (stream.fileIdx || 0) : null;
    }

    function peersFound(stats) {
        // Distinct peer addresses each tracker and the DHT returned so far, reachable or not; repeated announces count once
        return (stats.sources || []).reduce(function (sum, source) { return sum + (source.numFoundUniq || 0); }, 0);
    }

    function fileBytes(stats) {
        // Bytes of the selected file itself; the torrent total also counts other files and pieces it shares with them
        return stats.streamLen ? Math.round((stats.streamProgress || 0) * stats.streamLen) : stats.downloaded || 0;
    }

    function record(key, stats, playing) {
        // Keep the samples of the last window, the best values seen since the measurement started and when bytes last grew
        var now = Date.now();
        var entry = entries[key] || (entries[key] = { since: now, samples: [], peers: 0, peersSeen: 0, found: 0, bytes: 0, complete: false });
        var bytes = fileBytes(stats);
        entry.lastAt = now;
        entry.playing = entry.playing || !!playing;
        entry.peers = stats.peers || 0;
        entry.peersSeen = Math.max(entry.peersSeen, entry.peers);
        entry.found = Math.max(entry.found, peersFound(stats));
        if (bytes > entry.bytes) entry.lastGrowthAt = now;
        if (bytes > 0 && !entry.firstByteAt) {
            entry.firstByteAt = now;
            entry.firstBytes = bytes;
        }
        entry.bytes = bytes;
        entry.complete = (stats.streamProgress || 0) >= 0.999;
        entry.samples.push({ at: now, bytes: entry.bytes });
        // The window is the oldest sample still inside windowMs, plus the newest
        while (entry.samples.length > 2 && now - entry.samples[1].at >= (config.windowMs || 30000)) entry.samples.shift();
        return entry;
    }

    function prune() {
        // Measurements nobody refreshed for a while belong to titles the viewer left
        var limit = Date.now() - (config.pruneAfterMs || 600000);
        Object.keys(entries).forEach(function (key) { if (entries[key].lastAt < limit) delete entries[key]; });
    }

    function sample(stream) {
        // Read the statistics of one file once, merging calls that overlap; resolves to its entry or null
        var key = keyOf(stream);
        if (!key) return Promise.resolve(null);
        if (inFlight[key]) return inFlight[key];
        inFlight[key] = shared.fetchJson('/' + key + '/stats.json').then(function (stats) {
            delete inFlight[key];
            prune();
            return stats ? record(key, stats) : entries[key] || null;
        });
        return inFlight[key];
    }

    function rate(entry) {
        // Sustained bytes per second over the window, once it spans minSpanMs; null before that
        var first = entry.samples[0];
        var last = entry.samples[entry.samples.length - 1];
        if (!first || last.at - first.at < (config.minSpanMs || 10000)) return null;
        return Math.max(0, last.bytes - first.bytes) / ((last.at - first.at) / 1000);
    }

    function deliveredRate(entry) {
        // Rate of a finished test read, which stops by design; the playing file's silence is starvation, so it gets none
        if (entry.playing || !entry.lastGrowthAt || Date.now() - entry.lastGrowthAt < (config.idleAfterMs || 8000)) return null;
        // Only a read that got its test bytes finished; one that stopped short stalled, and its window rate tells that
        if (entry.bytes < ((window.STREMIO_TWEAKS || {}).prewarm || {}).warmBytes * 0.9) return null;
        // Bytes that came within one sample interval give at least that interval as their time, never an infinite rate
        var seconds = Math.max(config.sampleMs || 2000, entry.lastGrowthAt - entry.firstByteAt) / 1000;
        return Math.max(0, entry.bytes - (entry.lastGrowthAt === entry.firstByteAt ? 0 : entry.firstBytes)) / seconds;
    }

    function networkProven(except, since) {
        // Another source measured since the given time reached peers or bytes: silence is then the swarm's, not the network's
        return Object.keys(entries).some(function (key) {
            var other = entries[key];
            return key !== except && other.lastAt >= since && (other.peersSeen > 0 || other.found > 0 || other.bytes > 0);
        });
    }

    function needed(stream) {
        // The bitrate the file needs, from its size and the runtime; 1 MB/s when either is unknown
        return (window.__stremioStreamBitrate || {})[stream.infoHash] || 1048576;
    }

    function assess(stream) {
        // Verdict and sustained speed against the bitrate: searching, starting, fast, ok, slow, tooSlow or dead
        var key = keyOf(stream);
        var entry = key && entries[key];
        if (!key) return { verdict: 'direct', ratio: null, entry: null };
        if (!entry) return { verdict: 'unknown', ratio: null, entry: null };
        if (entry.complete) return { verdict: 'fast', ratio: Infinity, entry: entry };
        if (!entry.peersSeen && !entry.found && !entry.bytes) {
            var dead = Date.now() - entry.since >= (config.deadAfterMs || 45000) && networkProven(key, entry.since);
            return { verdict: dead ? 'dead' : 'searching', ratio: null, entry: entry };
        }
        var delivered = deliveredRate(entry);
        var speed = delivered !== null ? delivered : entry.bytes ? rate(entry) : null;
        if (speed === null) return { verdict: 'starting', ratio: null, entry: entry };
        var ratio = speed / needed(stream);
        // A swarm still adds peers for a while after its first byte; until then its speed is shown but not judged
        if (delivered === null && Date.now() - entry.firstByteAt < (config.rampMs || 30000)) return { verdict: 'starting', ratio: ratio, speed: speed, entry: entry };
        return { verdict: ratio >= 1.5 ? 'fast' : ratio >= 1 ? 'ok' : ratio >= 0.5 ? 'slow' : 'tooSlow', ratio: ratio, speed: speed, delivered: delivered !== null, entry: entry };
    }

    function measured(verdict) {
        // Whether a verdict comes from a sustained speed measurement
        return RATED.indexOf(verdict) !== -1;
    }

    function note(stream, stats) {
        // Record statistics a caller already read, so the playing source is measured without a second request
        var key = keyOf(stream);
        if (key && stats) record(key, stats, true);
    }

    window.__twkEvidence = { key: keyOf, sample: sample, note: note, assess: assess, measured: measured, peersFound: peersFound };
})();
