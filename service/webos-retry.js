// Keeps playback inside the Stremio player when the webOS media pipeline fails.
//
// WebOsVideo calls window.__stremioStallRetry from its error handler; returning
// true suppresses the error. A torrent that never delivered data is reloaded at
// the last position, because the pipeline reports starvation as "Format error".
// A stream the pipeline rejected after receiving data is switched to an HLS
// remux produced by the streaming server. Parameters come from window.STREMIO_TWEAKS.
(function () {
    var config = window.STREMIO_TWEAKS || {};
    var retryConfig = config.stallRetry || { maxRetries: 10, retryDelayMs: 3000 };
    var hlsConfig = config.hlsFallback || { enabled: false };
    var TORRENT_URL = /^(https?:\/\/[^/]+)\/([0-9a-f]{40})\/(\d+)/i;
    var state = { url: null, retries: 0, hlsUrl: null };
    var overlay = null;
    var overlayText = null;

    function showOverlay(text) {
        // Lazily create the toast and slide it in with the latest status
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'twk-toast';
            overlay.appendChild(document.createElement('span')).className = 'twk-pulse';
            overlayText = overlay.appendChild(document.createElement('span'));
            document.body.appendChild(overlay);
        }
        overlayText.textContent = text;
        requestAnimationFrame(function () { overlay.classList.add('twk-visible'); });
    }

    function hideOverlay() {
        // Slide the toast out without destroying it
        if (overlay) overlay.classList.remove('twk-visible');
    }

    function fetchStats(match) {
        // Read peers and speed for the stalled file from the streaming server
        return fetch(match[1] + '/' + match[2] + '/' + match[3] + '/stats.json')
            .then(function (resp) { return resp.json(); })
            .catch(function () { return null; });
    }

    function describe(stats) {
        // Build the pt-BR status line shown while waiting for the swarm; simple mode hides the swarm numbers
        if ((config.simple || {}).enabled) return 'Carregando o vídeo...';
        if (!stats) return 'Aguardando o torrent...';
        var kbps = Math.round((stats.downloadSpeed || 0) / 1024);
        return 'Aguardando o torrent: ' + (stats.peers || 0) + ' peers, ' + kbps + ' KB/s';
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

    function buildHlsUrl(server, mediaUrl) {
        // Ask the server to remux into codecs the webOS pipeline accepts
        var params = new URLSearchParams([['mediaURL', mediaUrl]]);
        hlsConfig.videoCodecs.forEach(function (codec) { params.append('videoCodecs', codec); });
        hlsConfig.audioCodecs.forEach(function (codec) { params.append('audioCodecs', codec); });
        params.set('maxAudioChannels', String(hlsConfig.maxAudioChannels));
        return server.replace(/\/$/, '') + '/hlsv2/' + randomId() + '/master.m3u8?' + params.toString();
    }

    function reload(video, url, resumeAt, expectedSrc, delayMs) {
        // Load a URL into the element and seek back once metadata is known
        setTimeout(function () {
            // Skip the reload when the player was unloaded or moved on meanwhile
            if (!video.isConnected || video.getAttribute('src') !== expectedSrc) return;
            video.addEventListener('loadedmetadata', function onMeta() {
                video.removeEventListener('loadedmetadata', onMeta);
                if (resumeAt > 1) video.currentTime = resumeAt;
            });
            video.src = url;
            try { video.load(); } catch (_e) {}
            try { video.play(); } catch (_e) {}
        }, delayMs);
    }

    function switchToHls(video, stream, resumeAt, message) {
        // Replace a rejected source with an HLS remux from the streaming server
        var currentSrc = video.getAttribute('src');
        var torrent = TORRENT_URL.exec(stream.url);
        var serverPromise = torrent ? Promise.resolve(torrent[1] + '/') : activeServer();
        showOverlay(message || 'Formato não suportado direto, convertendo no servidor...');
        serverPromise.then(function (server) {
            if (!server) return;
            state.hlsUrl = buildHlsUrl(server, stream.url);
            console.warn('[stall-retry] switching to HLS', state.hlsUrl);
            reload(video, state.hlsUrl, resumeAt, currentSrc, 0);
        });
    }

    function retryStalled(video, stream, match, resumeAt) {
        // Reload a starved torrent at the same position and show swarm state
        var attempt = state.retries;
        var currentSrc = video.getAttribute('src');
        fetchStats(match).then(function (stats) {
            showOverlay(describe(stats) + ((config.simple || {}).enabled ? '' : ' (tentativa ' + attempt + '/' + retryConfig.maxRetries + ')'));
            reload(video, currentSrc, resumeAt, currentSrc, retryConfig.retryDelayMs);
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

    function probeHasAudio(server, mediaUrl) {
        // Ask the streaming server whether the source carries any audio stream
        var probeUrl = server.replace(/\/$/, '') + '/hlsv2/probe?mediaURL=' + encodeURIComponent(mediaUrl);
        return fetch(probeUrl).then(function (resp) { return resp.json(); }).then(function (probe) {
            return (probe.streams || []).some(function (s) { return s.track === 'audio'; });
        }).catch(function () { return false; });
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
                if (window.__stremioDoctor) window.__stremioDoctor.nextSource('áudio incompatível com a TV', true);
                return;
            }
            var torrent = TORRENT_URL.exec(src);
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
                switchToHls(video, { url: src }, video.currentTime, 'Áudio incompatível com a TV, convertendo no servidor...');
            });
        }, hlsConfig.audioCheckDelayMs);
    }

    // A stream that plays again clears the retry budget, the status box, and checks its audio
    document.addEventListener('playing', function (e) {
        if (!(e.target instanceof HTMLMediaElement)) return;
        state.retries = 0;
        hideOverlay();
        checkMissingAudio(e.target);
    }, true);

    function onRouteChange() {
        // Leaving the player route hides any pending status box
        if ((location.hash || '').indexOf('#/player') !== 0) hideOverlay();
    }

    // The app router navigates with pushState and announces it as historyChange
    window.addEventListener('hashchange', onRouteChange);
    window.addEventListener('historyChange', onRouteChange);

    window.__stremioRetryState = state;
    window.__stremioToast = { show: showOverlay, hide: hideOverlay };

    window.__stremioStallRetry = function (video, stream) {
        if (!stream || typeof stream.url !== 'string') return false;
        // Reset the budget when a different stream starts failing
        if (state.url !== stream.url) {
            state.url = stream.url;
            state.retries = 0;
            state.hlsUrl = null;
        }
        var code = video.error ? video.error.code : null;
        var resumeAt = video.__lastTime || 0;
        var onHls = state.hlsUrl !== null && video.getAttribute('src') === state.hlsUrl;
        var match = TORRENT_URL.exec(stream.url);
        var starved = match !== null && video.readyState === 0 && code !== 3;
        console.warn('[stall-retry] code', code, 'ready', video.readyState, 'hls', onHls, 'resumeAt', resumeAt, stream.url);
        // A starved torrent is retried as is, also when already on HLS
        if (starved && retryConfig.enabled !== false && state.retries < retryConfig.maxRetries) {
            state.retries++;
            retryStalled(video, stream, match, resumeAt);
            return true;
        }
        // A rejected format gets one HLS attempt before the error is shown
        if (hlsConfig.enabled && !onHls && !starved && canConvert()) {
            switchToHls(video, stream, resumeAt);
            return true;
        }
        // Out of options for this source: let the doctor move to the next ranked one
        if (window.__stremioDoctor && window.__stremioDoctor.nextSource(starved ? 'o torrent não entregou dados' : 'a TV não conseguiu tocar esta fonte', true)) {
            return true;
        }
        hideOverlay();
        return false;
    };
})();
