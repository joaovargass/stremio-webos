// Keeps playback inside the Stremio player when the webOS media pipeline fails.
//
// WebOsVideo calls window.__stremioStallRetry from its error handler; returning
// true suppresses the error. A torrent that never delivered data is reloaded at
// the last position, because the pipeline reports starvation as "Format error".
// A stream the pipeline rejected after receiving data is switched to an HLS
// remux produced by the streaming server. Parameters come from window.STREMIO_TWEAKS.
(function () {
    var config = window.STREMIO_TWEAKS || {};
    var shared = window.__twkShared;
    var t = window.__twkI18n.t;
    var retryConfig = config.stallRetry || { maxRetries: 10, retryDelayMs: 3000 };
    var hlsConfig = config.hlsFallback || { enabled: false };
    var state = { url: null, retries: 0, hlsUrl: null, forced: false, attempt: 0, retryTimer: null };
    var playerActive = shared.onPlayer();
    var playerVideoId = currentVideoId();
    var statusNotice = null;

    function currentVideoId() {
        // The video a player route shows, its last path part
        var parts = (location.hash || '').split('/');
        return parts[parts.length - 1] || location.hash;
    }

    function isCurrentAttempt(video, src, attempt) {
        // A timer or reply of an earlier attempt, another video or another source must not act anymore
        return state.attempt === attempt && playerVideoId === currentVideoId() && video.isConnected && shared.onPlayer() && video.getAttribute('src') === src;
    }

    function invalidateAttempt() {
        // Start a new attempt: pending retry timers and replies of the previous one are dropped
        state.attempt++;
        if (state.retryTimer !== null) clearTimeout(state.retryTimer);
        state.retryTimer = null;
    }

    function requestPlay(video, src, attempt) {
        // Ask to play; a cancelled request is routine, a refused one is told to the viewer
        Promise.resolve().then(function () { return video.play(); }).catch(function (error) {
            if (!isCurrentAttempt(video, src, attempt)) return;
            if (error && error.name === 'AbortError') return console.info('[stall-retry] a play request was cancelled by a newer one');
            // A source with no playable data yet also fails the media element, whose error handler retries or converts it
            if (error && error.name === 'NotSupportedError') return console.info('[stall-retry] play waits for data the source has not delivered yet');
            console.warn('[stall-retry] the player refused to play:', error && error.message || 'unknown error');
            showOverlay(t('retry.playFailed'));
        });
    }

    function showOverlay(text) {
        // Recovery status stays in the shared toast until playback resumes
        statusNotice = shared.notify(text);
    }

    function hideOverlay() {
        // Playback resumed or the player closed: the recovery status goes, a notice of another module stays
        if (statusNotice !== null) shared.hideNotice(statusNotice);
        statusNotice = null;
    }

    function fetchStats(match) {
        // Peers and speed of the stalled file, time-limited: the server holds stats exactly for torrents without data, and the reload must not wait
        return shared.fetchJson(match[1] + '/' + match[2] + '/' + match[3] + '/stats.json');
    }

    function describe(stats) {
        // The status line shown while waiting for the swarm; simple mode hides the swarm numbers
        if ((config.simple || {}).enabled) return t('retry.loading');
        if (!stats) return t('retry.waiting');
        var kbps = Math.round((stats.downloadSpeed || 0) / 1024);
        return t('retry.waitingStats', { peers: stats.peers || 0, speed: kbps });
    }

    function randomId() {
        // HLS sessions on the streaming server are keyed by an arbitrary id
        return Math.random().toString(16).slice(2) + Date.now().toString(16);
    }

    function activeServer() {
        // Resolve the streaming server URL currently configured in the profile
        if (!window.core) return Promise.resolve(null);
        return window.core.getState('ctx').then(function (ctx) {
            return ctx && ctx.profile && ctx.profile.settings ? ctx.profile.settings.streamingServerUrl : null;
        }).catch(function () { return null; });
    }

    function buildHlsUrl(server, mediaUrl, force) {
        // Ask the server to remux into codecs the webOS pipeline accepts, or to re-encode the picture when a remux was rejected too
        var params = new URLSearchParams([['mediaURL', mediaUrl]]);
        if (force) params.set('forceTranscoding', '1');
        hlsConfig.videoCodecs.forEach(function (codec) { params.append('videoCodecs', codec); });
        hlsConfig.audioCodecs.forEach(function (codec) { params.append('audioCodecs', codec); });
        params.set('maxAudioChannels', String(hlsConfig.maxAudioChannels));
        return server.replace(/\/$/, '') + '/hlsv2/' + randomId() + '/master.m3u8?' + params.toString();
    }

    function reload(video, url, resumeAt, expectedSrc, delayMs, trackRetry) {
        // Load a URL into the element and seek back once metadata is known
        var attempt = state.attempt;
        var timer = setTimeout(function () {
            if (trackRetry && state.retryTimer === timer) state.retryTimer = null;
            // Skip the reload when the player was unloaded or moved on meanwhile
            if (!isCurrentAttempt(video, expectedSrc, attempt)) return;
            // The player seeks to this position itself when the new source reports its metadata
            video.__twkResumeMs = Math.max(0, Math.round((resumeAt || 0) * 1000));
            video.src = url;
            try { video.load(); } catch (error) {
                console.warn('[stall-retry] the player could not load the source:', error && error.message || 'unknown error');
                return showOverlay(t('retry.playFailed'));
            }
            requestPlay(video, url, attempt);
        }, delayMs);
        if (trackRetry) state.retryTimer = timer;
    }

    function switchToHls(video, stream, resumeAt, message, force, rejected) {
        // Replace a rejected source with an HLS remux from the streaming server, re-encoded when asked or when the probe shows a remux cannot help
        var currentSrc = video.getAttribute('src');
        var attempt = state.attempt;
        var torrent = shared.torrentOf(stream.url);
        var serverPromise = torrent ? Promise.resolve(torrent[1] + '/') : activeServer();
        showOverlay(message || t('retry.unsupported'));
        serverPromise.then(function (server) {
            if (!isCurrentAttempt(video, currentSrc, attempt)) return null;
            if (!server || force || !rejected) return { server: server, force: force };
            return probe(server, stream.url).then(function (info) { return { server: server, force: needsReencode(info) }; });
        }).then(function (plan) {
            if (!plan || !plan.server || !isCurrentAttempt(video, currentSrc, attempt)) return;
            force = plan.force;
            if (force) showOverlay(t('retry.convertVideo'));
            state.hlsUrl = buildHlsUrl(plan.server, stream.url, force);
            state.forced = !!force;
            console.warn('[stall-retry] switching to HLS', force ? '(re-encoding the picture)' : '', state.hlsUrl);
            reload(video, state.hlsUrl, resumeAt, currentSrc, 0);
            confirmSwitch(video, state.hlsUrl, resumeAt);
        }).catch(function (error) {
            if (!isCurrentAttempt(video, currentSrc, attempt)) return;
            console.error('[stall-retry] the conversion could not start:', error && error.message || 'unknown error');
            hideOverlay();
        });
    }

    function confirmSwitch(video, url, resumeAt) {
        // The TV pipeline can ignore a new source while the old one plays; one more load makes the conversion take over
        var attempt = state.attempt;
        setTimeout(function () {
            if (!isCurrentAttempt(video, url, attempt) || video.currentSrc === url) return;
            console.warn('[stall-retry] the player kept the previous source after the switch, loading the conversion again');
            video.__twkResumeMs = Math.max(0, Math.round((resumeAt || 0) * 1000));
            try { video.load(); } catch (error) {
                console.warn('[stall-retry] the player could not load the conversion:', error && error.message || 'unknown error');
                return showOverlay(t('retry.playFailed'));
            }
            requestPlay(video, url, attempt);
        }, hlsConfig.switchCheckMs || 3000);
    }

    function retryStalled(video, stream, match, resumeAt) {
        // Schedule the reload of a starved torrent at the same position first, then show the swarm state when it arrives
        var count = state.retries;
        var attempt = state.attempt;
        var currentSrc = video.getAttribute('src');
        showOverlay(t('retry.waiting'));
        reload(video, currentSrc, resumeAt, currentSrc, retryConfig.retryDelayMs, true);
        fetchStats(match).then(function (stats) {
            if (!isCurrentAttempt(video, currentSrc, attempt)) return;
            showOverlay(describe(stats) + ((config.simple || {}).enabled ? '' : t('retry.attempt', { current: count, total: retryConfig.maxRetries })));
        });
    }

    // Remember the last playback position of any media element
    document.addEventListener('timeupdate', function (e) {
        var v = e.target;
        if (v instanceof HTMLMediaElement && v.currentTime > 0) v.__lastTime = v.currentTime;
    }, true);

    function canConvert() {
        // HLS needs a server with ffmpeg; an unknown state still allows one attempt
        var doctor = window.__stremioDoctor;
        return !doctor || doctor.state.transcoder !== null;
    }

    function probe(server, mediaUrl) {
        // The streams of a source as the streaming server's ffprobe sees them; ffprobe takes seconds, so it gets its own, longer limit
        var probeUrl = server.replace(/\/$/, '') + '/hlsv2/probe?mediaURL=' + encodeURIComponent(mediaUrl);
        return shared.fetchJson(probeUrl, hlsConfig.probeTimeoutMs);
    }

    function probeHasAudio(server, mediaUrl) {
        // Whether the source carries any audio stream
        return probe(server, mediaUrl).then(function (info) {
            return !!info && (info.streams || []).some(function (s) { return s.track === 'audio'; });
        });
    }

    function needsReencode(info) {
        // Codecs the TV lists as playable that it still rejected mean a picture format it cannot decode (10-bit H.264, 4:2:2): a remux keeps it, so only a re-encode helps
        var streams = (info && info.streams) || [];
        var video = streams.filter(function (s) { return s.track === 'video'; })[0];
        var audio = streams.filter(function (s) { return s.track === 'audio'; })[0];
        return !!video && hlsConfig.videoCodecs.indexOf(video.codec) !== -1 && (!audio || hlsConfig.audioCodecs.indexOf(audio.codec) !== -1);
    }

    function checkMissingAudio(video) {
        // The webOS pipeline plays DTS/TrueHD files silently, exposing zero audio tracks
        var src = video.getAttribute('src');
        if (!hlsConfig.enabled || !hlsConfig.onMissingAudio || !src || src === state.hlsUrl || video.__audioChecked === src) return;
        video.__audioChecked = src;
        setTimeout(function () {
            if (video.getAttribute('src') !== src || !video.audioTracks || video.audioTracks.length > 0) return;
            // Without a converter the silent source cannot be fixed, so another source is the only cure
            if (!canConvert()) {
                if (window.__stremioDoctor) window.__stremioDoctor.nextSource('tvCannotPlay', true);
                return;
            }
            var torrent = shared.torrentOf(src);
            var serverPromise = torrent ? Promise.resolve(torrent[1] + '/') : activeServer();
            serverPromise.then(function (server) {
                return server ? probeHasAudio(server, src) : false;
            }).then(function (hasAudio) {
                if (!hasAudio || video.getAttribute('src') !== src) return;
                console.warn('[stall-retry] no playable audio track, switching to HLS', src);
                if (state.url !== src) {
                    state.url = src;
                    state.retries = 0;
                }
                switchToHls(video, { url: src }, video.currentTime, t('retry.convertAudio'));
            });
        }, hlsConfig.audioCheckDelayMs);
    }

    // A stream that plays again clears the retry budget, the status box, and checks its audio
    document.addEventListener('playing', function (e) {
        if (!(e.target instanceof HTMLMediaElement)) return;
        // Remember which source really played, so a later error on it reads as starvation, not as a rejected format
        e.target.__playedSrc = e.target.getAttribute('src');
        state.retries = 0;
        hideOverlay();
        checkMissingAudio(e.target);
    }, true);

    function onRouteChange() {
        // Opening the player for a video starts a fresh attempt and budget; leaving it drops pending retries and the status box
        var active = shared.onPlayer();
        var videoId = currentVideoId();
        if (active && (!playerActive || playerVideoId !== videoId)) {
            invalidateAttempt();
            state.retries = 0;
            state.url = null;
            state.hlsUrl = null;
            state.forced = false;
        } else if (!active && playerActive) {
            invalidateAttempt();
        }
        playerActive = active;
        playerVideoId = videoId;
        if (!active) hideOverlay();
    }

    // The app router navigates with pushState and announces it as historyChange
    window.addEventListener('hashchange', onRouteChange);
    window.addEventListener('historyChange', onRouteChange);

    window.__stremioRetryState = state;
    window.__stremioInvalidateRetryAttempt = function () {
        // A source switch by the doctor ends every pending recovery of the previous source
        invalidateAttempt();
        hideOverlay();
    };

    window.__stremioConvert = function (video, message) {
        // Convert the playing source to HLS on the server, for a picture that froze although its data is already there
        var src = video.getAttribute('src');
        if (!hlsConfig.enabled || !src || src === state.hlsUrl) return false;
        if (state.url !== src) {
            invalidateAttempt();
            state.url = src;
            state.retries = 0;
            state.hlsUrl = null;
            state.forced = false;
        }
        switchToHls(video, { url: src }, video.__lastTime || video.currentTime || 0, message || t('retry.convertFrozen'));
        return true;
    };

    window.__stremioStallRetry = function (video, stream) {
        if (!stream || typeof stream.url !== 'string') return false;
        // Reset the budget when a different stream starts failing
        if (state.url !== stream.url) {
            invalidateAttempt();
            state.url = stream.url;
            state.retries = 0;
            state.hlsUrl = null;
            state.forced = false;
        }
        var code = video.error ? video.error.code : null;
        var resumeAt = video.__lastTime || 0;
        var onHls = state.hlsUrl !== null && video.getAttribute('src') === state.hlsUrl;
        var match = shared.torrentOf(stream.url);
        // A torrent with no data yet, or one that already played and stopped, is starving; a decode error (3) means a broken file
        var played = video.__playedSrc === video.getAttribute('src');
        var starved = match !== null && code !== 3 && (video.readyState === 0 || played);
        console.warn('[stall-retry] code', code, 'ready', video.readyState, 'hls', onHls, 'resumeAt', resumeAt, stream.url);
        // A starved torrent is retried as is, also when already on HLS
        if (starved && retryConfig.enabled !== false && state.retries < retryConfig.maxRetries) {
            // An error repeated while a reload is already scheduled is the same stall, not a new attempt
            if (state.retryTimer !== null) return true;
            state.retries++;
            retryStalled(video, stream, match, resumeAt);
            return true;
        }
        // A rejected format gets one HLS attempt before the error is shown
        if (hlsConfig.enabled && !onHls && !starved && canConvert()) {
            switchToHls(video, stream, resumeAt, null, false, true);
            return true;
        }
        // A remux the TV rejected as well carries a picture format it cannot decode (10-bit H.264, for one): re-encode it once
        if (hlsConfig.enabled && onHls && !state.forced && !starved && canConvert()) {
            switchToHls(video, stream, resumeAt, t('retry.convertVideo'), true);
            return true;
        }
        // Out of options for this source: let the doctor move to the next ranked one
        if (window.__stremioDoctor && window.__stremioDoctor.nextSource(starved ? 'torrentEmpty' : 'tvCannotPlay', true)) {
            return true;
        }
        hideOverlay();
        return false;
    };
})();
