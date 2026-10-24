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
    var shared = window.__twkShared;
    var fetchJson = shared.fetchJson;
    var onPlayer = shared.onPlayer;
    var t = window.__twkI18n.t;
    var HINT_KEY = 'twk.hint.v3';
    var state = { status: 'ok', reason: '', totalBufferS: 0, playerBufferS: 0, ramBufferS: 0, speed: 0, needed: 0, switches: {}, exhausted: {}, blocked: {}, tried: {}, started: {} };
    var UNPLAYABLE = ['tvCannotPlay'];
    var manual = { busy: false, generation: 0 };
    var lastCurrent = null;
    var playerActive = onPlayer();
    var playerVideoId = null;
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
    var lanCheck = null;
    var lastProxy = null;
    var lastHash = null;
    var struggleSince = null;
    var progress = [];
    var race = { videoId: null, list: [] };
    var subtitleLangs = {};
    var probeQueue = [];
    var probing = false;
    var pendingResume = null;
    var rates = { tv: { key: 'twk.tvRate', savedAt: 0 }, lan: { key: 'twk.lanRate', savedAt: 0 } };
    rates.tv.value = shared.savedRate(rates.tv.key);
    rates.lan.value = shared.savedRate(rates.lan.key);
    var learned = rates.tv.value;

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
        // Every doctor notice goes to the shared toast for a set time
        shared.notify(text, hideAfterMs);
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
        // The player address carries the hash in lower case, addons send either case
        if (a.infoHash || b.infoHash) return String(a.infoHash).toLowerCase() === String(b.infoHash).toLowerCase() && (a.fileIdx || 0) === (b.fileIdx || 0);
        return a.url === b.url;
    }

    function rankedStreams() {
        // The ranked list, loaded from the addons when the player was opened straight from the library
        if (window.__stremioSources && window.__stremioSources.ensure) return window.__stremioSources.ensure();
        return Promise.resolve(window.__stremioRankedStreams || []);
    }

    function resolutionOf(stream) {
        // Vertical resolution named by the source, 0 when unknown
        return shared.resolution(String(stream.name || '') + ' ' + String(stream.description || stream.title || ''));
    }

    function candidates(ranked, current, count) {
        // The next ranked streams after the current one, skipping the ones this video already tried
        var videoId = currentVideoId();
        var tried = state.tried[videoId] || [];
        var index = -1;
        ranked.forEach(function (s, i) { if (index === -1 && sameStream(s, current)) index = i; });
        var open = ranked.slice(index + 1).filter(function (s) {
            return !sameStream(s, current) && !tried.some(function (other) { return sameStream(s, other); });
        });
        var list = open.slice(0, count);
        // A thin swarm often hits a whole resolution, so one candidate is always the best source of a lower one
        // The ranked entry carries the release text even when the player reports only the hash
        var top = index !== -1 ? resolutionOf(ranked[index]) || resolutionOf(current) : current ? resolutionOf(current) : 0;
        var lower = open.filter(function (s) { var r = resolutionOf(s); return r && top && r < top; })[0];
        if (count > 1 && lower && list.indexOf(lower) === -1) list[list.length - 1] = lower;
        return list;
    }

    function evidenceValue(result) {
        // Order candidates by what they delivered: sustained speed against their bitrate, then peers found, then nothing
        if (result.verdict === 'direct') return 1;
        if (result.ratio !== null) return result.ratio;
        return result.verdict === 'starting' ? 0.01 : 0;
    }

    function startPick(best, now) {
        // Before the first picture a switch interrupts nothing: a measured candidate far ahead of the current source wins
        var evidence = window.__twkEvidence;
        if (!evidence.measured(best.result.verdict) || best.result.ratio < (config.startSwitchRatio || 0.25)) return null;
        if (evidence.measured(now.verdict) && best.result.ratio < now.ratio * (config.startSwitchMargin || 2)) return null;
        return best.stream;
    }

    function probeSubtitles(streams) {
        // Read the subtitle languages inside each torrent file, one request at a time so the player keeps its connections
        streams.forEach(function (s) {
            var key = s && s.infoHash ? window.__twkEvidence.key(s) : null;
            if (key && subtitleLangs[key] === undefined && probeQueue.indexOf(s) === -1) probeQueue.push(s);
        });
        if (probing || !probeQueue.length || !window.__stremioSubs) return;
        var stream = probeQueue.shift();
        var key = window.__twkEvidence.key(stream);
        var server = (window.__STREMIO_SERVER_URL__ || 'http://127.0.0.1:11470').replace(/\/$/, '');
        var media = server + '/' + stream.infoHash.toLowerCase() + '/' + (stream.fileIdx || 0);
        probing = true;
        // The track list needs the file header, which a slow torrent may take a while to deliver
        fetchJson(server + '/tracks/' + encodeURIComponent(media), config.tracksTimeoutMs).then(function (tracks) {
            probing = false;
            if (Array.isArray(tracks)) {
                subtitleLangs[key] = window.__stremioSubs.textLanguages(tracks);
                console.info('[doctor] subtitles inside', key + ':', subtitleLangs[key].join(', ') || 'none');
            }
            probeSubtitles([]);
        });
    }

    function keepsSubtitles(stream, current) {
        // When only files carry the viewer's subtitle language, a switch goes only to a file known to carry it, unless the current one is known not to
        var wanted = window.__stremioSubs ? window.__stremioSubs.onlyInFile(decodeURIComponent(currentVideoId())) : null;
        if (!wanted || !current) return true;
        var has = function (s) {
            var langs = subtitleLangs[window.__twkEvidence.key(s)];
            return langs ? wanted.some(function (lang) { return langs.indexOf(lang) !== -1; }) : null;
        };
        return has(current) === false || has(stream) === true;
    }

    function choose(list, current, unplayable, beforePicture) {
        // The candidate worth switching to, or null: one measured clearly better than the current source, any live one when the current cannot play or is proven dead
        var evidence = window.__twkEvidence;
        var now = current ? evidence.assess(current) : { verdict: 'unknown', ratio: null };
        // A source the TV cannot play leaves whatever subtitles the next one carries
        var pool = unplayable ? list : list.filter(function (s) { return keepsSubtitles(s, current); });
        var best = pool.map(function (s) { return { stream: s, result: evidence.assess(s) }; })
            .filter(function (c) { return c.result.verdict !== 'dead'; })
            .sort(function (a, b) { return evidenceValue(b.result) - evidenceValue(a.result); })[0];
        if (!best) return null;
        if (unplayable) return best.stream;
        if (now.verdict === 'dead') return evidenceValue(best.result) > 0 ? best.stream : null;
        var nowGood = evidence.measured(now.verdict) && now.ratio >= (config.raceMinRatio || 0.8);
        if (best.result.verdict === 'direct') return nowGood ? null : best.stream;
        if (beforePicture && !nowGood && startPick(best, now)) return best.stream;
        if (!evidence.measured(best.result.verdict) || best.result.ratio < (config.raceMinRatio || 0.8)) return null;
        // A switch costs a reload, so the new source must be clearly faster than a current one that already downloads
        if (evidence.measured(now.verdict) && best.result.ratio < now.ratio * (config.switchMargin || 1.2)) return null;
        return best.stream;
    }

    function evidenceLine(stream) {
        // What the doctor based a decision on, for the log
        var result = window.__twkEvidence.assess(stream);
        var entry = result.entry || {};
        return result.verdict + (result.ratio !== null && isFinite(result.ratio) ? ' ' + result.ratio.toFixed(2) + 'x bitrate' : '') + ', ' + (entry.peers || 0) + ' peers, ' + (entry.found || 0) + ' found';
    }

    function nextSource(reason, automatic) {
        // A manual press plays the next ranked source; an automatic one switches only on evidence
        return automatic ? autoSwitch(reason) : manualSwitch(reason);
    }

    function autoSwitch(reason) {
        // Switch to a source the evidence shows is better, within the budget of this video; returns whether it switched
        var videoId = currentVideoId();
        if (config.autoSwitch === false) {
            state.blocked[videoId] = 'autoSwitchDisabled';
            return false;
        }
        var used = state.switches[videoId] || 0;
        // Before the first picture a switch disturbs nothing, so more attempts are allowed than during playback
        var budget = state.started[videoId] ? (config.maxAutoSwitches || 0) : (config.maxStartSwitches || config.maxAutoSwitches || 0);
        if (used >= budget) {
            state.blocked[videoId] = 'noSwitch';
            // Out of automatic attempts: tell the viewer once what can still help
            if (!state.exhausted[videoId]) {
                state.exhausted[videoId] = true;
                explainExhausted(videoId);
            }
            return false;
        }
        var unplayable = UNPLAYABLE.indexOf(reason) !== -1;
        var list = race.videoId === videoId ? race.list : [];
        // A source the TV cannot play leaves even when nothing was prepared yet: the next ranked one is the best guess
        if (unplayable && !list.length) return guessNext(reason, videoId);
        var next = choose(list, lastCurrent, unplayable, !state.started[videoId]);
        if (!next && noPeersAnywhere(list)) return playDirect(videoId, list.length + 1);
        if (!next) {
            state.blocked[videoId] = 'noBetterSource';
            var noSubtitles = list.filter(function (s) { return !keepsSubtitles(s, lastCurrent); }).length;
            console.info('[doctor] keeping the current source:', reasonText(reason) + ';', 'current', lastCurrent ? evidenceLine(lastCurrent) : 'not a torrent', '| candidates', list.map(evidenceLine).join(' ; ') || 'none prepared', noSubtitles ? '| ' + noSubtitles + ' skipped: not known to carry the subtitle language' : '');
            return false;
        }
        state.switches[videoId] = used + 1;
        state.tried[videoId] = (state.tried[videoId] || []).concat(lastCurrent ? [lastCurrent] : []);
        console.warn('[doctor] switching source automatically:', reasonText(reason) + ';', 'new', next.infoHash || next.url, evidenceLine(next), '| current', lastCurrent ? evidenceLine(lastCurrent) : 'not a torrent');
        playStream(next, t('doctor.switchUnstable', { reason: reasonText(reason) }) + ' ' + t('doctor.switch'));
        return true;
    }

    function noPeersAnywhere(list) {
        // The playing torrent and every prepared one found no peer at all: the network, not a swarm, is the likely cause
        if (!lastCurrent || !list.length) return false;
        return [lastCurrent].concat(list).every(function (s) {
            var verdict = window.__twkEvidence.assess(s).verdict;
            return verdict === 'searching' || verdict === 'dead';
        });
    }

    function playDirect(videoId, tried) {
        // A direct link plays without any swarm; without one, tell the viewer once that torrents do not connect here
        var direct = (window.__stremioRankedStreams || []).filter(function (s) { return !s.infoHash && typeof s.url === 'string'; })[0];
        if (!direct) {
            state.blocked[videoId] = 'noBetterSource';
            if (!state.exhausted[videoId]) toast(t('doctor.noPeersNetwork', { count: tried }), 12000);
            state.exhausted[videoId] = true;
            return false;
        }
        state.switches[videoId] = (state.switches[videoId] || 0) + 1;
        console.warn('[doctor] no torrent of this title found a peer (' + tried + ' measured); playing a direct link', direct.url);
        playStream(direct, t('doctor.noPeersDirect', { count: tried }));
        return true;
    }

    function guessNext(reason, videoId) {
        // No prepared source to compare: play the next ranked one, counted against the budget
        state.switches[videoId] = (state.switches[videoId] || 0) + 1;
        Promise.all([rankedStreams(), currentStream()]).then(function (results) {
            if (videoId !== currentVideoId()) return;
            var next = candidates(results[0] || [], results[1], 1)[0];
            if (!next) return toast(t('doctor.noOtherSource'), 5000);
            state.tried[videoId] = (state.tried[videoId] || []).concat(results[1] ? [results[1]] : []);
            console.warn('[doctor] switching source automatically:', reasonText(reason) + ';', 'nothing was prepared, next ranked', next.infoHash || next.url);
            playStream(next, t('doctor.switchUnstable', { reason: reasonText(reason) }) + ' ' + t('doctor.switch'));
        });
        return true;
    }

    function manualSwitch(reason) {
        // The next ranked source after the playing one, one change at a time; a slow source list keeps the current source
        if (manual.busy) return false;
        manual.busy = true;
        var videoId = currentVideoId();
        var generation = ++manual.generation;
        var release = function () { if (generation === manual.generation) manual.busy = false; };
        var lookup = setTimeout(function () {
            if (generation !== manual.generation) return;
            manual.generation++;
            manual.busy = false;
            if (videoId !== currentVideoId() || !onPlayer()) return;
            console.warn('[doctor] the source list did not load in time; the current source stays');
            toast(t('doctor.sourceListUnavailable'), 5000);
        }, (window.STREMIO_TWEAKS.sources || {}).loadWaitMs || 8000);
        Promise.all([rankedStreams(), currentStream()]).then(function (results) {
            // A reply for a video the viewer already left changes nothing
            if (generation !== manual.generation || videoId !== currentVideoId()) return;
            var next = candidates(results[0] || [], results[1], 1)[0];
            if (!next) return toast(t('doctor.noOtherSource'), 5000);
            state.tried[videoId] = (state.tried[videoId] || []).concat(results[1] ? [results[1]] : []);
            console.warn('[doctor] switching source by request:', reason, next.infoHash || next.url);
            playStream(next, t('doctor.switch'));
        }).catch(function (error) {
            if (generation !== manual.generation || videoId !== currentVideoId()) return;
            console.warn('[doctor] the source list could not be read:', error && error.message || 'unknown error');
            toast(t('doctor.sourceListUnavailable'), 5000);
        }).then(function () {
            clearTimeout(lookup);
            release();
        });
        return true;
    }

    function explainExhausted(videoId) {
        // Out of automatic attempts: when no tried torrent reached a single peer the network is the cause, and a direct link still plays
        Promise.all([rankedStreams(), currentStream()]).then(function (results) {
            var tried = (state.tried[videoId] || []).concat(results[1] ? [results[1]] : []).filter(function (s) { return s && s.infoHash; });
            return Promise.all(tried.map(function (s) {
                return fetchJson('/' + s.infoHash.toLowerCase() + '/' + (s.fileIdx || 0) + '/stats.json');
            })).then(function (stats) {
                var noPeers = tried.length >= 2 && stats.every(function (st) { return !st || !(st.peers > 0); });
                if (!noPeers) {
                    var lanOff = window.STREMIO_TWEAKS && window.STREMIO_TWEAKS.servers && window.STREMIO_TWEAKS.servers.useLan === false;
                    // Name the missing computer when the switch is on but no LAN server answers
                    var help = lanOff ? t('doctor.enableLanOrChoose') : state.lanFallback ? t('doctor.choose') : t('doctor.turnOnComputerOrChoose');
                    return toast(t('doctor.noFastSource') + ' ' + help + ' ' + t('doctor.anotherSource'), 9000);
                }
                var direct = (results[0] || []).filter(function (s) { return !s.infoHash && typeof s.url === 'string'; })[0];
                console.warn('[doctor] no tried torrent reached a peer', tried.length, direct ? 'playing a direct link' : 'no direct link');
                if (direct) return playStream(direct, t('doctor.noPeersDirect', { count: tried.length }));
                toast(t('doctor.noPeersNetwork', { count: tried.length }), 12000);
            });
        });
    }

    function heavyForTv(hash) {
        // A source whose bitrate the TV server measurably cannot sustain
        var bitrate = hash ? (window.__stremioStreamBitrate || {})[hash] : null;
        return !!bitrate && learned.n >= 60 && bitrate > learned.rate * 1.1;
    }

    function prepareOn(next, fraction) {
        // Warm a candidate on the server that would play it: the computer when the current video already uses it or the TV cannot keep up
        var hash = next.infoHash ? next.infoHash.toLowerCase() : null;
        var proxy = lastProxy;
        var currentOnLan = !!(proxy && lastHash && (proxy.routes || {})[lastHash]);
        var lan = !!(config.prewarmOnLan !== false && hash && proxy && proxy.fallback && !(proxy.routes || {})[hash] && (currentOnLan || heavyForTv(hash)));
        // The race then measures and later plays this source on the computer, where it was warmed
        if (lan) {
            prerouted[hash] = true;
            rerouted[hash] = true;
        }
        console.info('[doctor] preparing a source in the background', next.infoHash || next.url, Math.round(fraction * 100) + '%', lan ? 'on the LAN server' : '');
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
            race = { videoId: videoId, list: list };
            list.forEach(function (next) { prepareOn(next, fraction); });
            // Candidates first: the current file may not have delivered its header yet
            probeSubtitles(list.concat(results[1] ? [results[1]] : []));
            offerMirrors(results[0] || [], results[1], list);
        });
    }

    function offerMirrors(ranked, current, list) {
        // Torrents of the same release file download later parts in parallel; the service checks size and bytes before merging any
        var readAhead = (window.STREMIO_TWEAKS || {}).readAhead || {};
        var settings = readAhead.mirrors || {};
        if (readAhead.enabled === false || readAhead.mergeSources === false || !current || !current.infoHash) return;
        var entry = ranked.filter(function (s) { return sameStream(s, current); })[0] || current;
        var name = (entry.behaviorHints || {}).filename;
        var height = resolutionOf(entry);
        // Same file name first, then the race candidates of the same resolution, which are already starting anyway
        var twins = ranked.filter(function (s) { return s.infoHash && !sameStream(s, entry) && name && (s.behaviorHints || {}).filename === name; });
        var alike = list.filter(function (s) { return s.infoHash && height && resolutionOf(s) === height && twins.indexOf(s) === -1; });
        twins.concat(alike).slice(0, settings.max || 2).forEach(function (s) {
            console.info('[doctor] offering a mirror', s.infoHash);
            fetchJson('/__tweaks/mirror?hash=' + entry.infoHash.toLowerCase() + '&idx=' + (entry.fileIdx || 0) + '&with=' + s.infoHash.toLowerCase() + '&widx=' + (s.fileIdx || 0));
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
        var title = short || String(stream.description || stream.title || '').split('\n').filter(function (l) { return l && l.indexOf('⭐') !== 0 && l.indexOf('⚠') !== 0; })[0] || t('doctor.nextSource');
        // Say when the new source comes from the computer, as every other use of it is announced
        var viaComputer = stream.infoHash && prerouted[stream.infoHash.toLowerCase()] ? ' · ' + t('doctor.viaComputer') : '';
        if (viaComputer) announced[stream.infoHash.toLowerCase()] = true;
        toast(prefix + title.slice(0, 70) + viaComputer, 5000);
        stalledSince = null;
        loadingSince = null;
        delete state.blocked[currentVideoId()];
        // Retry timers and late replies of the old source must not touch the new one
        if (window.__stremioInvalidateRetryAttempt) window.__stremioInvalidateRetryAttempt();
        // The new source gets its own race once it is loading
        race = { videoId: null, list: [] };
        prepared[currentVideoId()] = false;
        // The new player opens at the saved library position; keep the one the viewer is at instead
        var video = document.querySelector('video');
        var at = video ? video.__lastTime || video.currentTime || 0 : 0;
        pendingResume = { ms: Math.round(at * 1000), until: Date.now() + 30000 };
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
        // Ask for the same URL again, served now by another server; before its metadata the position it opened with still applies
        if (video.readyState >= 1) video.__twkResumeMs = Math.round((video.__lastTime || video.currentTime || 0) * 1000);
        video.src = video.getAttribute('src');
        try { video.load(); } catch (_e) {}
        // The reload itself interrupts any earlier play request; only another refusal is worth a line
        var playing = video.play();
        if (playing && playing.catch) playing.catch(function (error) { if (error.name !== 'AbortError') console.warn('[doctor] play after the reload was refused:', error.name); });
    }

    function useRemoteServer(video, hash, proxy, reason) {
        // First remedy for a slow torrent on the TV: fetch this one video through the LAN server
        var local = !proxy.routes || !proxy.routes[hash];
        if (!hash || !proxy.fallback || !local || rerouted[hash] || /^https?:\/\/(?!127\.|localhost)/.test(proxy.upstream)) return false;
        rerouted[hash] = true;
        announced[hash] = true;
        console.warn('[doctor] rerouting', hash, 'to', proxy.fallback, reason);
        toast(t('doctor.computerFallback', { reason: reasonText(reason) }), 6000);
        fetchJson('/__tweaks/route?hash=' + hash + '&to=remote').then(function (route) {
            stalledSince = null;
            loadingSince = null;
            // The computer must prove it delivers this torrent; one that has not even found it yet would starve the player
            lanCheck = { hash: hash, at: Date.now(), time: video.currentTime };
            // The proxy moved the running download to the computer at the next byte; reload only when it could not
            if (!route || !route.seamless) reloadInPlace(video);
        });
        return true;
    }

    function lanDelivers(video, hash, stats) {
        // After the verify period, a routed video must have moved or its torrent must download on the computer
        if (lanCheck && lanCheck.hash !== hash) lanCheck = null;
        if (!lanCheck) return true;
        if (Date.now() - lanCheck.at < (config.lanVerifyMs || 15000)) return true;
        var check = lanCheck;
        lanCheck = null;
        return video.currentTime > check.time + 1 || !!(stats && stats.name && stats.downloadSpeed > 0);
    }

    function leaveLan(video, hash) {
        // Bring a video the computer could not deliver back to the TV; a video already watched goes on to the next source
        console.warn('[doctor] the LAN server delivered nothing, back to the TV', hash);
        toast(t('doctor.computerFailed'), 6000);
        var watched = !!state.started[currentVideoId()];
        fetchJson('/__tweaks/route?hash=' + hash + '&to=default').then(function (route) {
            if (!route || !route.seamless) reloadInPlace(video);
            if (watched) remedy(video, hash, null, 'computerNoData');
        });
    }

    function calmFor() {
        // Before the first picture nobody watches, so the calm period is short; during playback it stays patient
        return state.started[currentVideoId()] ? (config.graceMs || 60000) : (config.startGraceMs || 20000);
    }

    function remedy(video, hash, proxy, reason) {
        // Try the LAN server for this video first, then the next ranked source, then wait before judging again
        state.status = 'switching';
        state.reason = reason;
        calmUntil = Date.now() + calmFor();
        if (hintShown && window.__stremioSources && window.__stremioSources.hint) window.__stremioSources.hint(false);
        hintShown = false;
        if (proxy && useRemoteServer(video, hash, proxy, reason)) return;
        if (nextSource(reason, true)) return;
        // Nothing better to switch to: keep this source, say why, and look again after the calm period
        state.status = state.started[currentVideoId()] ? 'critical' : 'loading';
        state.reason = reason + '|' + (state.blocked[currentVideoId()] || 'noSwitch');
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
        // A video moved to the computer goes back to the TV when the computer stops answering; tell the viewer once
        var routedTo = hash && proxy && (proxy.routes || {})[hash];
        if (routedTo && (proxy.candidates || {})[routedTo] === false && !lanLost[hash]) {
            lanLost[hash] = true;
            toast(t('doctor.noComputer'), 6000);
        }
        // A source already warmed on the computer (heavy for the TV) starts there; say so once, as every use of it is announced
        if (routedTo && (proxy.candidates || {})[routedTo] !== false && !announced[hash]) {
            announced[hash] = true;
            toast(t('doctor.computerSource'), 5000);
        }
        if (!lanDelivers(video, hash, stats)) return leaveLan(video, hash);
        state.playerBufferS = shared.bufferAhead(video);
        state.ramBufferS = needed ? ramBytes / needed : 0;
        state.totalBufferS = state.playerBufferS + state.ramBufferS;
        state.speed = speed;
        state.needed = needed;
        var playing = !video.paused && !video.ended;
        // Once a picture has played, switches become rare: the viewer is watching
        if (video.currentTime > 1 && video.readyState >= 3) state.started[currentVideoId()] = true;
        var onTv = !!proxy && /^https?:\/\/(127\.|localhost)/.test(proxy.upstream) && !(proxy.routes || {})[hash];
        // Only a hungry player shows what its server can deliver: the TV for its own videos, the computer for routed ones
        var hungry = hash && playing && speed > 0 && state.playerBufferS < 20;
        if (config.learnTvSpeed !== false && onTv && hungry) learnRate(rates.tv, speed);
        if (config.learnLanSpeed !== false && !onTv && proxy && hungry) learnRate(rates.lan, speed);
        // A frozen picture: the viewer wants playback, the playhead does not move and the player waits for data
        var advancing = lastTime === null || video.currentTime > lastTime + 0.2;
        lastTime = video.currentTime;
        // A video that never showed a frame is still loading, whatever its ready state, which is not a freeze
        var loading = !state.started[currentVideoId()] && video.currentTime < 0.5;
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
            useRemoteServer(video, hash, proxy, 'heavyTv');
        } else if (loadingSince && (waitedMs > (config.startTimeoutMs || 60000) || (waitedMs > (config.quickStartMs || 20000) && race.videoId === currentVideoId() && choose(race.list, lastCurrent, false)))) {
            remedy(video, hash, proxy, 'waiting');
        } else if (frozenWithData(video, hash, proxy, stalledMs)) {
            // The data is on the server yet the picture does not move: the TV pipeline cannot decode this file, a conversion can
            converted[hash] = true;
            calmUntil = now + calmFor();
            state.status = 'switching';
            state.reason = 'frozenData';
            console.warn('[doctor] frozen with data on the server, converting', hash);
            window.__stremioConvert(video, t('retry.convertFrozen'));
        } else if (stalledMs > (config.stalledForMs || 45000) || choppy) {
            progress = [];
            remedy(video, hash, proxy, choppy ? 'choppy' : 'stalledLong');
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
            state.status = 'loading';
            state.reason = 'waiting';
        } else if (stalledSince) {
            state.status = 'critical';
            state.reason = 'stalled';
        } else if (slow && low) {
            state.status = 'attention';
            state.reason = 'slowLow';
        } else if (slow) {
            state.status = 'attention';
            state.reason = 'slowBuffer';
        } else {
            state.status = 'ok';
            state.reason = needed ? 'keepingUp' : torrent ? 'waitingTorrent' : 'waitingDirect';
        }
        // Keep telling why no automatic switch happens while the problem lasts
        var blocked = state.blocked[currentVideoId()];
        if (state.status !== 'ok' && blocked) state.reason += '|' + blocked;
    }

    function reasonText(reason) {
        // Reasons travel as stable English codes and read in the viewer's language only on screen
        var key = 'doctor.reason.' + reason;
        return t(key);
    }

    function sampleRace() {
        // Measure the sources prepared for this video every tick, so a switch is decided on what they really deliver
        if (!race.list.length || race.videoId !== currentVideoId()) return null;
        return Promise.all(race.list.map(window.__twkEvidence.sample));
    }

    function tick() {
        // Sample the player, the torrent and the proxy, then evaluate
        if (busy || !config.enabled || !onPlayer()) return;
        var video = document.querySelector('video');
        if (!video) return;
        var src = video.currentSrc || video.src || '';
        // An HLS conversion of a torrent keeps reporting that torrent: its swarm still feeds the picture
        var torrent = shared.sourceTorrent(src);
        // The playing torrent file is measured with the same evidence as the candidates it is compared with
        lastCurrent = torrent ? { infoHash: torrent[2].toLowerCase(), fileIdx: parseInt(torrent[3], 10) } : null;
        busy = true;
        Promise.all([
            torrent ? fetchJson(torrent[1] + '/' + torrent[2] + '/' + torrent[3] + '/stats.json') : null,
            fetchJson('/__tweaks/status'),
            sampleRace()
        ]).then(function (results) {
            busy = false;
            if (lastCurrent) window.__twkEvidence.note(lastCurrent, results[0]);
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
        toast(t('doctor.firstRun'), 9000);
    }

    function onRouteChange() {
        // Reset per-video state and show the hint the first time the player opens
        var active = onPlayer();
        var videoId = currentVideoId();
        // Opening the player anew starts a fresh budget for that video; a source switch replaces the entry without leaving it
        if (active && !playerActive) {
            state.tried[videoId] = [];
            state.switches[videoId] = 0;
            state.started[videoId] = false;
            delete state.exhausted[videoId];
            delete state.blocked[videoId];
        }
        // A pending manual switch belongs to the video it was asked on
        if (!active || videoId !== playerVideoId) {
            manual.generation++;
            manual.busy = false;
        }
        playerActive = active;
        playerVideoId = videoId;
        lastTime = null;
        stalledSince = null;
        loadingSince = null;
        struggleSince = null;
        progress = [];
        calmUntil = 0;
        setTimeout(showFirstRunHint, 4000);
    }

    // A switched source starts where the viewer was: the resume position is handed to the reload hook of the player
    document.addEventListener('loadstart', function (e) {
        if (!pendingResume || !(e.target instanceof HTMLMediaElement) || !onPlayer()) return;
        if (Date.now() < pendingResume.until) e.target.__twkResumeMs = pendingResume.ms;
        pendingResume = null;
    }, true);

    // The app router navigates with pushState and announces it as historyChange
    window.addEventListener('hashchange', onRouteChange);
    window.addEventListener('historyChange', onRouteChange);

    // The loop always runs and each tick checks the switch, so the setting applies without a reload
    setInterval(tick, config.checkEveryMs || 2000);

    window.__stremioDoctor = {
        nextSource: nextSource,
        playStream: playStream,
        openPlayer: openPlayer,
        navigate: navigate,
        currentStream: currentStream,
        sameStream: sameStream,
        heavyForTv: heavyForTv,
        state: state
    };
})();
