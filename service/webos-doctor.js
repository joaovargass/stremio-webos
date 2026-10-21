// Playback doctor: watches the playing stream, computes the total buffer
// (player plus proxy RAM) and the download speed against the bitrate the file
// needs, and reports a status. It acts only on real symptoms the viewer sees, a
// video that does not start or a picture that stays frozen, first by fetching the
// same source through the LAN server, then by one switch to the next ranked
// source, with a calm period after every action. Also owns the "next source"
// action, router-safe navigation and the first-run hint.
(function () {
    var config = (window.STREMIO_TWEAKS || {}).doctor || {};
    var hints = (window.STREMIO_TWEAKS || {}).hints || {};
    var TORRENT_URL = /^(https?:\/\/[^/]+)\/([0-9a-f]{40})\/(\d+)/i;
    var HINT_KEY = 'twk.hint.v2';
    var state = { status: 'ok', reason: '', totalBufferS: 0, playerBufferS: 0, ramBufferS: 0, speed: 0, needed: 0, switches: {}, exhausted: {} };
    var stalledSince = null;
    var calmUntil = 0;
    var hintShown = false;
    var lastTime = null;
    var loadingSince = null;
    var busy = false;
    var rerouted = {};
    var learned = readTvRate();
    var learnedSavedAt = 0;

    function readTvRate() {
        // Learned download rate of the TV's own server: { rate: bytes per second, n: samples }
        try {
            return JSON.parse(localStorage.getItem('twk.tvRate') || 'null') || { rate: 0, n: 0 };
        } catch (_e) {
            return { rate: 0, n: 0 };
        }
    }

    function learnTvRate(speed) {
        // Moving average of what the TV server delivers while the player is hungry, saved every 30 s
        learned.rate = learned.n ? learned.rate * 0.95 + speed * 0.05 : speed;
        learned.n++;
        if (Date.now() - learnedSavedAt < 30000) return;
        learnedSavedAt = Date.now();
        try { localStorage.setItem('twk.tvRate', JSON.stringify(learned)); } catch (_e) {}
    }

    function toast(text, hideAfterMs) {
        // Reuse the recovery toast so every notice looks the same
        if (!window.__stremioToast) return;
        window.__stremioToast.show(text);
        if (hideAfterMs) setTimeout(window.__stremioToast.hide, hideAfterMs);
    }

    function onPlayer() {
        // The doctor only works on the player route
        return (location.hash || '').indexOf('#/player') === 0;
    }

    function playerBuffer(video) {
        // Seconds the native pipeline holds past the playhead
        for (var i = 0; i < video.buffered.length; i++) {
            if (video.buffered.start(i) <= video.currentTime && video.buffered.end(i) >= video.currentTime) {
                return video.buffered.end(i) - video.currentTime;
            }
        }
        return 0;
    }

    function fetchJson(target) {
        // Fetch JSON and resolve null on any failure
        return fetch(target).then(function (r) { return r.json(); }).catch(function () { return null; });
    }

    function currentVideoId() {
        // Episodes and movies share one switch budget per video id
        var parts = (location.hash || '').split('/');
        return parts[parts.length - 1] || location.hash;
    }

    function currentStream() {
        // The stream the player is using, as reported by the core
        if (!window.core) return Promise.resolve(null);
        return window.core.getState('player').then(function (p) {
            return p && p.selected ? p.selected.stream : null;
        }).catch(function () { return null; });
    }

    function sameStream(a, b) {
        // Torrents compare by hash and file, direct links by URL
        if (!a || !b) return false;
        if (a.infoHash || b.infoHash) return a.infoHash === b.infoHash && (a.fileIdx || 0) === (b.fileIdx || 0);
        return a.url === b.url;
    }

    function rankedStreams() {
        // The ranked list, loaded from the addons when the player was opened straight from the library
        if (window.__stremioSources && window.__stremioSources.ensure) return window.__stremioSources.ensure();
        return Promise.resolve(window.__stremioRankedStreams || []);
    }

    function nextSource(reason, automatic) {
        // Move to the stream ranked right after the current one
        var videoId = currentVideoId();
        if (automatic) {
            var used = state.switches[videoId] || 0;
            if (!config.autoSwitch) return false;
            if (used >= (config.maxAutoSwitches || 0)) {
                // Out of automatic attempts: tell the viewer once what can still help
                if (!state.exhausted[videoId]) {
                    state.exhausted[videoId] = true;
                    var lan = window.STREMIO_TWEAKS && window.STREMIO_TWEAKS.servers && window.STREMIO_TWEAKS.servers.useLan === false;
                    toast('Nenhuma fonte rápida o bastante agora. ' + (lan ? 'Ligue "Usar o servidor do Mac" (tecla amarela) ou escolha' : 'Escolha') + ' outra fonte (tecla verde)', 9000);
                }
                return false;
            }
            state.switches[videoId] = used + 1;
        }
        Promise.all([rankedStreams(), currentStream()]).then(function (results) {
            var ranked = results[0] || [];
            var current = results[1];
            var index = -1;
            ranked.forEach(function (s, i) { if (index === -1 && sameStream(s, current)) index = i; });
            var next = ranked[index + 1] || null;
            if (!next) {
                toast('Não há outra fonte disponível para este título', 5000);
                return;
            }
            console.warn('[doctor] next source', automatic ? 'auto' : 'manual', reason);
            playStream(next, (automatic ? 'Fonte instável (' + reason + '). ' : '') + 'Trocando para: ');
        });
        return true;
    }

    function navigate(hash, replace) {
        // Go through the app router so its own history, and with it the Back key, stays correct
        if (window.__stremioHistory) return window.__stremioHistory.navigate(hash, replace);
        location.hash = hash;
    }

    function playStream(stream, prefix) {
        // Replace the current player entry with the chosen stream
        // A short quality summary reads better than the release file name
        var short = window.__stremioTweaks && window.__stremioTweaks.summary ? window.__stremioTweaks.summary(stream) : '';
        var title = short || String(stream.description || stream.title || '').split('\n').filter(function (l) { return l && l.indexOf('⭐') !== 0 && l.indexOf('⚠') !== 0; })[0] || 'próxima fonte';
        toast(prefix + title.slice(0, 70), 5000);
        stalledSince = null;
        loadingSince = null;
        // Replacing the player entry reloads the player and keeps the title page under it for Back
        navigate(stream.deepLinks.player.replace(/^#/, ''), true);
    }

    function detailsPath(playerPath) {
        // The title page with the stream list, built from the type, meta id and video id ending the player path
        var parts = playerPath.replace(/^#/, '').split('/');
        return '/detail/' + parts.slice(-3).join('/');
    }

    function openPlayer(playerHash) {
        // Open a player with the title page under it, so Back returns to the stream list
        var target = playerHash.replace(/^#/, '');
        var started = Date.now();
        navigate(detailsPath(target));
        // The title page rewrites its own entry once mounted; push the player only after that, or it would be replaced
        var wait = setInterval(function () {
            var settled = (location.hash || '').indexOf('#/detail') === 0 && location.hash.indexOf('stream=') !== -1;
            if (!settled && Date.now() - started < 5000) return;
            clearInterval(wait);
            navigate(target);
        }, 100);
    }

    function reloadInPlace(video) {
        // Ask the player for the same URL again; the proxy now serves it from another server
        var resumeAt = video.__lastTime || video.currentTime || 0;
        video.addEventListener('loadedmetadata', function onMeta() {
            video.removeEventListener('loadedmetadata', onMeta);
            if (resumeAt > 1) video.currentTime = resumeAt;
        });
        video.src = video.getAttribute('src');
        try { video.load(); } catch (_e) {}
        try { video.play(); } catch (_e) {}
    }

    function useRemoteServer(video, hash, proxy, reason) {
        // First remedy for a slow torrent on the TV: fetch this one video through the LAN server
        var local = !proxy.routes || !proxy.routes[hash];
        if (!hash || !proxy.fallback || !local || rerouted[hash] || /^https?:\/\/(?!127\.|localhost)/.test(proxy.upstream)) return false;
        rerouted[hash] = true;
        console.warn('[doctor] rerouting', hash, 'to', proxy.fallback, reason);
        toast('Usando o Mac para esta fonte (' + reason + ')', 6000);
        fetch('/__tweaks/route?hash=' + hash + '&to=remote').then(function () {
            stalledSince = null;
            loadingSince = null;
            reloadInPlace(video);
        });
        return true;
    }

    function remedy(video, hash, proxy, reason) {
        // Try the LAN server for this video first, then the next ranked source, then wait before judging again
        state.status = 'trocando';
        state.reason = reason;
        calmUntil = Date.now() + (config.graceMs || 60000);
        if (hintShown && window.__stremioSources && window.__stremioSources.hint) window.__stremioSources.hint(false);
        hintShown = false;
        if (proxy && useRemoteServer(video, hash, proxy, reason)) return;
        if (nextSource(reason, true)) return;
        // Nothing automatic is left to try for this video
        state.status = 'crítico';
        state.reason = reason + ', sem outra troca automática';
    }

    function evaluate(video, stats, proxy, hash) {
        // Turn the raw numbers into a status, a reason and possibly an automatic fix
        var now = Date.now();
        var needed = stats && stats.streamLen && video.duration ? stats.streamLen / video.duration : 0;
        var speed = stats ? stats.downloadSpeed || 0 : 0;
        var ra = proxy && proxy.readAhead;
        var ramBytes = ra && ra.active ? ra.aheadBytes : 0;
        // Remember whether any server can convert to HLS, so recovery skips a conversion that cannot work
        if (proxy) state.transcoder = proxy.transcoder;
        state.playerBufferS = playerBuffer(video);
        state.ramBufferS = needed ? ramBytes / needed : 0;
        state.totalBufferS = state.playerBufferS + state.ramBufferS;
        state.speed = speed;
        state.needed = needed;
        var playing = !video.paused && !video.ended;
        var onTv = !!proxy && /^https?:\/\/(127\.|localhost)/.test(proxy.upstream) && !(proxy.routes || {})[hash];
        // Only a hungry player shows what the TV server can deliver
        if (config.learnTvSpeed !== false && onTv && hash && playing && speed > 0 && state.playerBufferS < 20) learnTvRate(speed);
        // A frozen picture: the viewer wants playback, the playhead does not move and the player waits for data
        var advancing = lastTime === null || video.currentTime > lastTime + 0.2;
        lastTime = video.currentTime;
        // A video that never reached its first frame is still loading, which is not a freeze
        var loading = video.readyState < 2 && video.currentTime < 0.5;
        loadingSince = loading ? loadingSince || now : null;
        stalledSince = playing && !loading && !video.seeking && !advancing && video.readyState < 3 ? stalledSince || now : null;
        var slow = !!stats && needed > 0 && speed < needed * 0.9;
        var low = state.totalBufferS < (config.minBufferS || 10);
        describe(slow, low, needed, !!hash);
        // A short freeze only earns a hint, never an action; only the hint shown here is hidden here
        var stalledMs = stalledSince ? now - stalledSince : 0;
        var wantHint = stalledMs > 10000;
        if (wantHint !== hintShown && window.__stremioSources && window.__stremioSources.hint) window.__stremioSources.hint(wantHint);
        hintShown = wantHint;
        if (now < calmUntil) return;
        var bitrate = hash ? (window.__stremioStreamBitrate || {})[hash] : null;
        var heavy = bitrate && learned.n >= 60 && bitrate > learned.rate * 1.1;
        if (config.startOnLanWhenHeavy !== false && loadingSince && onTv && heavy && proxy.fallback && !rerouted[hash]) {
            // Start sources the TV clearly cannot sustain on the LAN server, before any picture is shown
            calmUntil = now + (config.graceMs || 60000);
            useRemoteServer(video, hash, proxy, 'acima da velocidade da TV');
        } else if (loadingSince && now - loadingSince > (config.startTimeoutMs || 60000)) {
            remedy(video, hash, proxy, 'não começou');
        } else if (stalledMs > (config.stalledForMs || 45000)) {
            remedy(video, hash, proxy, 'vídeo travado');
        }
    }

    function describe(slow, low, needed, torrent) {
        // Status shown in the diagnostics panel; slowness alone is reported, not acted on
        if (loadingSince) {
            state.status = 'carregando';
            state.reason = 'aguardando os primeiros dados';
        } else if (stalledSince) {
            state.status = 'crítico';
            state.reason = 'vídeo parado esperando dados';
        } else if (slow && low) {
            state.status = 'atenção';
            state.reason = 'download lento, buffer baixo';
        } else if (slow) {
            state.status = 'atenção';
            state.reason = 'download abaixo do necessário, usando o buffer';
        } else {
            state.status = 'ok';
            state.reason = needed ? 'download acompanha o vídeo' : torrent ? 'sem dados do torrent ainda' : 'sem dados de velocidade (link direto)';
        }
        // Keep telling that nothing automatic is left while the problem lasts
        if (state.status !== 'ok' && state.exhausted[currentVideoId()]) state.reason += ', sem outra troca automática';
    }

    function tick() {
        // Sample the player, the torrent and the proxy, then evaluate
        if (busy || !config.enabled || !onPlayer()) return;
        var video = document.querySelector('video');
        if (!video) return;
        var src = video.currentSrc || video.src || '';
        var torrent = TORRENT_URL.exec(src);
        busy = true;
        Promise.all([
            torrent ? fetchJson(torrent[1] + '/' + torrent[2] + '/' + torrent[3] + '/stats.json') : null,
            fetchJson('/__tweaks/status')
        ]).then(function (results) {
            busy = false;
            evaluate(video, results[0], results[1], torrent ? torrent[2].toLowerCase() : null);
        });
    }

    function showFirstRunHint() {
        // Tell the viewer once about the new player buttons
        if (!hints.firstRunToast || !onPlayer()) return;
        try {
            if (localStorage.getItem(HINT_KEY)) return;
            localStorage.setItem(HINT_KEY, '1');
        } catch (_e) {
            return;
        }
        toast('Teclas: verde troca a fonte · vermelho troca a legenda · amarelo abre os ajustes', 9000);
    }

    function onRouteChange() {
        // Reset per-video state and show the hint the first time the player opens
        lastTime = null;
        stalledSince = null;
        loadingSince = null;
        calmUntil = 0;
        setTimeout(showFirstRunHint, 4000);
    }

    // The app router navigates with pushState and announces it as historyChange
    window.addEventListener('hashchange', onRouteChange);
    window.addEventListener('historyChange', onRouteChange);

    if (config.enabled) setInterval(tick, config.checkEveryMs || 2000);

    window.__stremioDoctor = {
        nextSource: nextSource,
        playStream: playStream,
        openPlayer: openPlayer,
        navigate: navigate,
        currentStream: currentStream,
        sameStream: sameStream,
        state: state
    };
})();
