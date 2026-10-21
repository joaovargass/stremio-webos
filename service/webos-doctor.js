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
    var HINT_KEY = 'twk.hint.v3';
    var state = { status: 'ok', reason: '', totalBufferS: 0, playerBufferS: 0, ramBufferS: 0, speed: 0, needed: 0, switches: {}, exhausted: {}, tried: {}, started: {} };
    var stalledSince = null;
    var calmUntil = 0;
    var hintShown = false;
    var lastTime = null;
    var loadingSince = null;
    var busy = false;
    var rerouted = {};
    var lanLost = {};
    var prepared = {};
    var prerouted = {};
    var announced = {};
    var converted = {};
    var lastProxy = null;
    var lastHash = null;
    var struggleSince = null;
    var progress = [];
    var race = { videoId: null, list: [], best: null };
    var rates = { tv: { key: 'twk.tvRate', savedAt: 0 }, lan: { key: 'twk.lanRate', savedAt: 0 } };
    rates.tv.value = readRate(rates.tv.key);
    rates.lan.value = readRate(rates.lan.key);
    var learned = rates.tv.value;

    function readRate(key) {
        // Learned download rate of one server: { rate: bytes per second, n: samples }
        try {
            return JSON.parse(localStorage.getItem(key) || 'null') || { rate: 0, n: 0 };
        } catch (_e) {
            return { rate: 0, n: 0 };
        }
    }

    function learnRate(slot, speed) {
        // Moving average of what one server delivers while the player is hungry, saved every 30 s
        var learnedRate = slot.value;
        learnedRate.rate = learnedRate.n ? learnedRate.rate * 0.95 + speed * 0.05 : speed;
        learnedRate.n++;
        if (Date.now() - slot.savedAt < 30000) return;
        slot.savedAt = Date.now();
        try { localStorage.setItem(slot.key, JSON.stringify(learnedRate)); } catch (_e) {}
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

    function candidates(ranked, current, count) {
        // The next ranked streams after the current one, skipping the ones this video already tried
        var videoId = currentVideoId();
        var tried = state.tried[videoId] || [];
        var index = -1;
        ranked.forEach(function (s, i) { if (index === -1 && sameStream(s, current)) index = i; });
        return ranked.slice(index + 1).filter(function (s) {
            return !sameStream(s, current) && !tried.some(function (t) { return sameStream(s, t); });
        }).slice(0, count);
    }

    function pickLive(list) {
        // Among prepared torrents, the one really downloading wins; direct links need no swarm; unknown keeps ranked order
        return Promise.all(list.map(function (s) {
            if (!s.infoHash) return Promise.resolve(Infinity);
            return fetchJson('/' + s.infoHash + '/' + (s.fileIdx || 0) + '/stats.json').then(function (st) {
                return st ? (st.downloadSpeed || 0) + (st.unchoked || 0) : 0;
            });
        })).then(function (scores) {
            var best = 0;
            scores.forEach(function (score, i) { if (score > scores[best]) best = i; });
            return list[best] || null;
        });
    }

    function nextSource(reason, automatic) {
        // Move to the best next source: the live one among those prepared in the background, else the next ranked
        var videoId = currentVideoId();
        if (automatic) {
            var used = state.switches[videoId] || 0;
            // Before the first picture a switch disturbs nothing, so more attempts are allowed than during playback
            var budget = state.started[videoId] ? (config.maxAutoSwitches || 0) : (config.maxStartSwitches || config.maxAutoSwitches || 0);
            if (!config.autoSwitch) return false;
            if (used >= budget) {
                // Out of automatic attempts: tell the viewer once what can still help
                if (!state.exhausted[videoId]) {
                    state.exhausted[videoId] = true;
                    var lanOff = window.STREMIO_TWEAKS && window.STREMIO_TWEAKS.servers && window.STREMIO_TWEAKS.servers.useLan === false;
                    // Name the missing Mac when the switch is on but no LAN server answers
                    var help = lanOff ? 'Ligue "Usar o servidor do Mac" (tecla amarela) ou escolha' : state.lanFallback ? 'Escolha' : 'Ligue o Mac ou escolha';
                    toast('Nenhuma fonte rápida o bastante agora. ' + help + ' outra fonte (tecla verde)', 9000);
                }
                return false;
            }
            state.switches[videoId] = used + 1;
        }
        Promise.all([rankedStreams(), currentStream()]).then(function (results) {
            var current = results[1];
            var list = candidates(results[0] || [], current, automatic && prepared[videoId] ? (config.raceCandidates || 2) : 1);
            if (!list.length) {
                toast('Não há outra fonte disponível para este título', 5000);
                return null;
            }
            state.tried[videoId] = (state.tried[videoId] || []).concat(current ? [current] : []);
            return (list.length > 1 ? pickLive(list) : Promise.resolve(list[0])).then(function (next) {
                console.warn('[doctor] next source', automatic ? 'auto' : 'manual', reason, next.infoHash || next.url);
                playStream(next, (automatic ? 'Fonte instável (' + reason + '). ' : '') + 'Trocando para: ');
            });
        });
        return true;
    }

    function heavyForTv(hash) {
        // A source whose bitrate the TV server measurably cannot sustain
        var bitrate = hash ? (window.__stremioStreamBitrate || {})[hash] : null;
        return !!bitrate && learned.n >= 60 && bitrate > learned.rate * 1.1;
    }

    function prepareOn(next, fraction) {
        // Warm a candidate on the server that would play it: the Mac when the current video already uses it or the TV cannot keep up
        var hash = next.infoHash ? next.infoHash.toLowerCase() : null;
        var proxy = lastProxy;
        var currentOnLan = !!(proxy && lastHash && (proxy.routes || {})[lastHash]);
        var lan = !!(config.prewarmOnLan !== false && hash && proxy && proxy.fallback && !(proxy.routes || {})[hash] && (currentOnLan || heavyForTv(hash)));
        // The race then measures and later plays this source on the Mac, where it was warmed
        if (lan) {
            prerouted[hash] = true;
            rerouted[hash] = true;
        }
        console.info('[doctor] preparing a source in the background', next.infoHash || next.url, Math.round(fraction * 100) + '%', lan ? 'on the Mac' : '');
        window.__stremioTweaks.prewarm(next, fraction, lan);
    }

    function prepareNext(video) {
        // Start the next ranked sources in the background at the playback position (the start while loading), once per video
        var videoId = currentVideoId();
        if (prepared[videoId] || !window.__stremioTweaks || !window.__stremioTweaks.prewarm) return;
        prepared[videoId] = true;
        var fraction = video.duration ? video.currentTime / video.duration : 0;
        Promise.all([rankedStreams(), currentStream()]).then(function (results) {
            var list = candidates(results[0] || [], results[1], config.raceCandidates || 2);
            race = { videoId: videoId, list: list, best: null };
            list.forEach(function (next) { prepareOn(next, fraction); });
        });
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
        // Say when the new source comes from the Mac, as every other Mac use is announced
        var viaMac = stream.infoHash && prerouted[stream.infoHash.toLowerCase()] ? ' · pelo Mac' : '';
        if (viaMac) announced[stream.infoHash.toLowerCase()] = true;
        toast(prefix + title.slice(0, 70) + viaMac, 5000);
        stalledSince = null;
        loadingSince = null;
        // The new source gets its own race once it is loading
        race = { videoId: null, list: [], best: null };
        prepared[currentVideoId()] = false;
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
        // The player seeks to this position itself when the same URL reports its metadata again
        video.__twkResumeMs = Math.max(0, Math.round((resumeAt || 0) * 1000));
        video.src = video.getAttribute('src');
        try { video.load(); } catch (_e) {}
        try { video.play(); } catch (_e) {}
    }

    function useRemoteServer(video, hash, proxy, reason) {
        // First remedy for a slow torrent on the TV: fetch this one video through the LAN server
        var local = !proxy.routes || !proxy.routes[hash];
        if (!hash || !proxy.fallback || !local || rerouted[hash] || /^https?:\/\/(?!127\.|localhost)/.test(proxy.upstream)) return false;
        rerouted[hash] = true;
        announced[hash] = true;
        console.warn('[doctor] rerouting', hash, 'to', proxy.fallback, reason);
        toast('Usando o Mac para esta fonte (' + reason + ')', 6000);
        fetch('/__tweaks/route?hash=' + hash + '&to=remote').then(function (r) { return r.json(); }).then(function (route) {
            stalledSince = null;
            loadingSince = null;
            // The proxy moved the running download to the Mac at the next byte; reload only when it could not
            if (!route.seamless) reloadInPlace(video);
        }).catch(function () { reloadInPlace(video); });
        return true;
    }

    function calmFor() {
        // Before the first picture nobody watches, so the calm period is short; during playback it stays patient
        return state.started[currentVideoId()] ? (config.graceMs || 60000) : (config.startGraceMs || 20000);
    }

    function remedy(video, hash, proxy, reason) {
        // Try the LAN server for this video first, then the next ranked source, then wait before judging again
        state.status = 'trocando';
        state.reason = reason;
        calmUntil = Date.now() + calmFor();
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
        if (proxy) lastProxy = proxy;
        lastHash = hash;
        if (proxy) state.lanFallback = proxy.fallback;
        // A video moved to the Mac goes back to the TV when the Mac stops answering; tell the viewer once
        var routedTo = hash && proxy && (proxy.routes || {})[hash];
        if (routedTo && (proxy.candidates || {})[routedTo] === false && !lanLost[hash]) {
            lanLost[hash] = true;
            toast('O Mac parou de responder: este vídeo voltou para a TV', 6000);
        }
        // A source already warmed on the Mac (heavy for the TV) starts there; say so once, as every Mac use is announced
        if (routedTo && (proxy.candidates || {})[routedTo] !== false && !announced[hash]) {
            announced[hash] = true;
            toast('Esta fonte vem do Mac (pesada para a TV)', 5000);
        }
        state.playerBufferS = playerBuffer(video);
        state.ramBufferS = needed ? ramBytes / needed : 0;
        state.totalBufferS = state.playerBufferS + state.ramBufferS;
        state.speed = speed;
        state.needed = needed;
        var playing = !video.paused && !video.ended;
        // Once a picture has played, switches become rare: the viewer is watching
        if (video.currentTime > 1 && video.readyState >= 3) state.started[currentVideoId()] = true;
        var onTv = !!proxy && /^https?:\/\/(127\.|localhost)/.test(proxy.upstream) && !(proxy.routes || {})[hash];
        // Only a hungry player shows what its server can deliver: the TV for its own videos, the Mac for routed ones
        var hungry = hash && playing && speed > 0 && state.playerBufferS < 20;
        if (config.learnTvSpeed !== false && onTv && hungry) learnRate(rates.tv, speed);
        if (config.learnLanSpeed !== false && !onTv && proxy && hungry) learnRate(rates.lan, speed);
        // A frozen picture: the viewer wants playback, the playhead does not move and the player waits for data
        var advancing = lastTime === null || video.currentTime > lastTime + 0.2;
        lastTime = video.currentTime;
        // A video that never reached its first frame is still loading, which is not a freeze
        var loading = video.readyState < 2 && video.currentTime < 0.5;
        loadingSince = loading ? loadingSince || now : null;
        stalledSince = playing && !loading && !video.seeking && !advancing && video.readyState < 3 ? stalledSince || now : null;
        var choppy = isChoppy(video, now, playing && !loading && !video.seeking);
        // Data the server already holds past the playhead counts as buffer: a finished file never downloads, yet is not slow
        var serverAheadS = stats && stats.streamLen && video.duration ? (stats.streamProgress || 0) * video.duration - video.currentTime : 0;
        state.serverAheadS = Math.max(0, serverAheadS);
        var slow = !!stats && needed > 0 && speed < needed * 0.9 && serverAheadS < (config.targetBufferS || 120);
        var low = state.totalBufferS < (config.minBufferS || 10);
        describe(slow, low, needed, !!hash);
        // While playback struggles, get the next ranked source ready at the same position so a switch starts at once
        struggleSince = (slow && low) || stalledSince || loadingSince || choppy ? struggleSince || now : null;
        // A slow start races the next sources almost at once; trouble during playback waits a little longer
        var waitedMs = loadingSince ? now - loadingSince : 0;
        var raceNow = waitedMs > (config.raceAfterMs || 5000) || (struggleSince && now - struggleSince > (config.prewarmAfterMs || 15000));
        if (config.prewarmNext !== false && raceNow) prepareNext(video);
        // A short freeze only earns a hint, never an action; only the hint shown here is hidden here
        var stalledMs = stalledSince ? now - stalledSince : 0;
        var wantHint = stalledMs > 10000;
        if (wantHint !== hintShown && window.__stremioSources && window.__stremioSources.hint) window.__stremioSources.hint(wantHint);
        hintShown = wantHint;
        if (now < calmUntil) return;
        var heavy = heavyForTv(hash);
        if (config.startOnLanWhenHeavy !== false && loadingSince && onTv && heavy && proxy.fallback && !rerouted[hash]) {
            // Start sources the TV clearly cannot sustain on the LAN server, before any picture is shown
            calmUntil = now + calmFor();
            useRemoteServer(video, hash, proxy, 'acima da velocidade da TV');
        } else if (loadingSince && (waitedMs > (config.startTimeoutMs || 60000) || (waitedMs > (config.quickStartMs || 20000) && race.best && race.videoId === currentVideoId()))) {
            remedy(video, hash, proxy, 'não começou');
        } else if (frozenWithData(video, hash, proxy, stalledMs)) {
            // The data is on the server yet the picture does not move: the TV cannot decode this file, a remux on the Mac can
            converted[hash] = true;
            calmUntil = now + calmFor();
            state.status = 'trocando';
            state.reason = 'imagem parada com dados prontos';
            console.warn('[doctor] frozen with data on the server, converting', hash);
            window.__stremioConvert(video, 'A TV não conseguiu decodificar este trecho, convertendo no Mac...');
        } else if (stalledMs > (config.stalledForMs || 45000) || choppy) {
            progress = [];
            remedy(video, hash, proxy, choppy ? 'vídeo travando' : 'vídeo travado');
        }
    }

    function frozenWithData(video, hash, proxy, stalledMs) {
        // A freeze is a decoding problem when the server already holds plenty past the playhead and a converter exists
        return config.convertFrozen !== false && !!hash && !converted[hash] && !!proxy && !!proxy.transcoder &&
            stalledMs > (config.convertFrozenMs || 10000) && state.serverAheadS >= (config.convertMinServerAheadS || 30) &&
            !/\/hlsv2\//.test(video.currentSrc || video.src || '');
    }

    function isChoppy(video, now, watching) {
        // A picture that keeps stopping and starting: over the last stalledForMs it played less than minPlayRatio of real time
        var last = progress[progress.length - 1];
        // Not watching, or a jump back by the viewer, restarts the measurement
        if (!watching || (last && video.currentTime < last.t - 1)) {
            progress = [];
            return false;
        }
        var span = config.stalledForMs || 45000;
        progress.push({ at: now, t: video.currentTime });
        while (progress.length > 1 && now - progress[1].at >= span) progress.shift();
        var first = progress[0];
        if (now - first.at < span) return false;
        return video.currentTime - first.t < (now - first.at) / 1000 * (config.minPlayRatio || 0.5);
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

    function raceStatus(video) {
        // While a start waits, check which prepared source is really downloading, so a switch can be quick and certain
        if (!race.list.length || race.videoId !== currentVideoId() || video.readyState >= 2) return null;
        return pickLive(race.list).then(function (best) {
            // A direct link needs no swarm to start
            if (!best.infoHash) { race.best = best; return null; }
            return fetchJson('/' + best.infoHash + '/' + (best.fileIdx || 0) + '/stats.json').then(function (st) {
                // Fast enough to play: most of the bitrate its size and runtime need, or 1 MB/s when that is unknown
                var needed = (window.__stremioStreamBitrate || {})[best.infoHash] || 1048576;
                race.best = st && (st.downloadSpeed || 0) >= needed * (config.raceMinRatio || 0.8) ? best : null;
            });
        }).catch(function () {});
    }

    function hlsSourceTorrent(src) {
        // An HLS conversion of a torrent keeps reporting that torrent: its swarm still feeds the picture
        var match = /[?&]mediaURL=([^&]+)/.exec(src);
        return match && /\/hlsv2\//.test(src) ? TORRENT_URL.exec(decodeURIComponent(match[1])) : null;
    }

    function tick() {
        // Sample the player, the torrent and the proxy, then evaluate
        if (busy || !config.enabled || !onPlayer()) return;
        var video = document.querySelector('video');
        if (!video) return;
        var src = video.currentSrc || video.src || '';
        var torrent = TORRENT_URL.exec(src) || hlsSourceTorrent(src);
        busy = true;
        Promise.all([
            torrent ? fetchJson(torrent[1] + '/' + torrent[2] + '/' + torrent[3] + '/stats.json') : null,
            fetchJson('/__tweaks/status'),
            raceStatus(video)
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
        toast('Teclas: verde troca a fonte · vermelho troca a legenda · azul recomeça · amarelo abre os ajustes', 9000);
    }

    function onRouteChange() {
        // Reset per-video state and show the hint the first time the player opens
        lastTime = null;
        stalledSince = null;
        loadingSince = null;
        struggleSince = null;
        progress = [];
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
        sourceTorrent: function (src) { return TORRENT_URL.exec(src) || hlsSourceTorrent(src); },
        heavyForTv: heavyForTv,
        state: state
    };
})();
