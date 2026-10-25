// Automatic subtitle sync: while an external subtitle is showing and the video plays,
// asks the service (measured on the TV, the LAN sync service only when the TV is unsure) how far the cues are from the voices
// around the playback position and applies that delay through the player, the same way
// the manual delay control does. Release-matched subtitles are skipped, a delay the
// viewer set by hand is never overridden, and every ten-minute slot is checked once to
// catch drift. Parameters come from STREMIO_TWEAKS.subtitles.
(function () {
    var config = (window.STREMIO_TWEAKS || {}).subtitles || {};
    var shared = window.__twkShared;
    var t = window.__twkI18n.t;
    var done = {};
    var retried = {};
    var lastApplied = null;
    var playingSince = null;
    var busy = false;
    var warnedUnavailable = false;

    function playerState() {
        // Current props of the player video, exposed by the player patch
        var video = window.__stremioPlayerVideo;
        if (!video || !video.state) return null;
        return typeof video.state === 'function' ? video.state() : video.state;
    }

    function selectedTrack(state) {
        // The external subtitle track currently shown, if any
        var id = state && state.selectedExtraSubtitlesTrackId;
        if (!id) return null;
        return (state.extraSubtitlesTracks || []).filter(function (track) { return track.id === id; })[0] || null;
    }

    function formatSeconds(ms) {
        // Signed seconds with one decimal, as shown in the toast
        return (ms > 0 ? '+' : '') + window.__twkI18n.number(ms / 1000, 1) + ' s';
    }

    function apply(result, track, manual) {
        // Set the delay only when the subtitle really matches the speech and the shift is large enough to matter; a requested sync always says how it went
        if (!(result.confidence >= (config.syncMinConfidence || 0.5))) {
            console.warn('[subsync] low confidence result ignored', JSON.stringify(result));
            if (manual) shared.notify(t('subsync.unsure'), 4000);
            return;
        }
        if (Math.abs(result.offsetMs) < (config.syncMinOffsetMs || 300)) {
            console.info('[subsync] already in sync', result.offsetMs, 'ms');
            if (manual) shared.notify(t('subsync.inSync'), 3000);
            return;
        }
        lastApplied = result.offsetMs;
        window.__stremioSetSubtitlesDelay(result.offsetMs);
        window.__stremioSubSync = { offsetMs: result.offsetMs, track: track.id, at: Date.now() };
        console.info('[subsync] applied', result.offsetMs, 'ms to', track.id);
        shared.notify(t(result.on === 'tv' ? 'subsync.appliedTv' : 'subsync.appliedComputer', { offset: formatSeconds(result.offsetMs) }), 4000);
    }

    function check(manual) {
        // Run at most one measurement at a time, only on the player with an external subtitle; a requested sync skips the automatic limits
        if (manual && busy) return shared.notify(t('subsync.busy'), 3000);
        if (busy || !config.enabled || (!manual && config.autoSync === false) || !shared.onPlayer() || !window.__stremioSetSubtitlesDelay) return;
        var video = document.querySelector('video');
        var state = playerState();
        var track = selectedTrack(state);
        var playing = video && !video.paused && video.readyState >= 3;
        playingSince = playing ? playingSince || Date.now() : null;
        if (manual && !track) return shared.notify(t('subsync.needsExternal'), 4000);
        if (!track || !track.url || (!manual && (!playing || Date.now() - playingSince < (config.syncAfterPlayingS || 20) * 1000))) return;
        // A delay the viewer chose by hand wins over any automatic correction
        var delay = state.extraSubtitlesDelay || 0;
        if (!manual && delay !== 0 && delay !== lastApplied) return;
        // Subtitles matched to this exact release by hash are already in sync
        if (!manual && window.__stremioSubs && window.__stremioSubs.scoreOf(track) >= 100) return;
        var key = track.id + '|' + Math.floor(video.currentTime / (config.syncEverySlotS || 600));
        if (done[key] && !manual) return;
        if (manual) shared.notify(t('subsync.measuring'), 4000);
        done[key] = true;
        busy = true;
        // The sync reads the audio from the original torrent file, even while the TV plays an HLS conversion of it
        var torrent = shared.sourceTorrent(video.currentSrc);
        var media = torrent ? torrent[0] : video.currentSrc;
        var query = 'media=' + encodeURIComponent(media) + '&sub=' + encodeURIComponent(track.url) + '&at=' + Math.floor(video.currentTime);
        // A job that never ends must not keep the measurement busy and a page connection taken forever
        var controller = new AbortController();
        var timer = setTimeout(function () { controller.abort(); }, config.syncTimeoutMs || 600000);
        fetch('/__tweaks/subsync?' + query, { signal: controller.signal }).then(function (resp) {
            clearTimeout(timer);
            // No way to measure (503: TV sync off and no Mac) and a Mac that does not answer (502) both mean no sync for now
            if (resp.status === 502 || resp.status === 503) return { status: 503, body: null };
            return resp.json().then(function (body) { return { status: resp.status, body: body }; });
        }).then(function (r) {
            busy = false;
            if (r.status === 503) {
                // Without any way to measure the subtitle stays as chosen; tell the viewer once, and on every requested sync
                if (!warnedUnavailable || manual) shared.notify(t('subsync.unavailable'), 5000);
                warnedUnavailable = true;
                return;
            }
            if (r.status !== 200) {
                // A busy server can fail once; this slot gets one more try a minute later
                if (!retried[key]) {
                    retried[key] = true;
                    setTimeout(function () { delete done[key]; }, 60000);
                }
                if (manual) shared.notify(t('subsync.failed'), 4000);
                return console.warn('[subsync] failed', r.status, JSON.stringify(r.body));
            }
            apply(r.body, track, manual);
        }).catch(function (err) {
            clearTimeout(timer);
            busy = false;
            if (manual) shared.notify(t('subsync.failed'), 4000);
            console.warn('[subsync] request failed', err);
        });
    }

    function onRouteChange() {
        // A new video starts with no automatic delay applied
        lastApplied = null;
        playingSince = null;
        window.__stremioSubSync = null;
    }

    // The app router navigates with pushState and announces it as historyChange
    window.addEventListener('hashchange', onRouteChange);
    window.addEventListener('historyChange', onRouteChange);
    // The check always runs and reads the switches each time, so the settings apply without a reload
    setInterval(function () { check(false); }, 5000);
    window.__stremioSyncNow = function () { check(true); };
})();
