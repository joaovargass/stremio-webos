// Core-level tweaks: points the profile at the local proxy (which picks the
// fastest streaming server and adds peer sources to torrents), ranks streams so
// the most compatible and healthy one is listed first and asks the service to
// warm it. All parameters come from window.STREMIO_TWEAKS, loaded from tweaks.json.
(function () {
    var config = window.STREMIO_TWEAKS || {};
    var shared = window.__twkShared;
    var t = window.__twkI18n.t;
    var prewarmed = {};
    var lastRanking = null;
    var live = { forId: null, candidates: [], classes: {}, version: 0, generation: 0, timer: null, started: 0 };
    var NOTICE = /reinstall|re-install|configure (this|the) addon|install the addon|not configured|expired|invalid (api )?key|update (this|the) addon/i;
    var rules = compileRules(config.ranking);

    function compileRules(rank) {
        // Build every ranking regex once so scoring stays cheap on the TV CPU
        if (!rank) return null;
        var penalties = [
            ['enhance.warn.unsupportedAudio', rank.unsupportedAudio],
            ['enhance.warn.remux', rank.remux],
            ['enhance.warn.threeD', rank.threeD],
            ['enhance.warn.cinemaCopy', rank.cinemaCopy],
            ['enhance.warn.audioDescription', rank.audioDescription]
        ].map(function (entry) {
            return { regex: new RegExp(entry[1].pattern), penalty: entry[1].penalty, labelKey: entry[0] };
        });
        return {
            goodAudio: new RegExp(rank.goodAudio.pattern),
            surround: new RegExp(rank.surround.pattern),
            penalties: penalties,
            dolbyVision: new RegExp(rank.dolbyVisionOnly.pattern),
            hdr: new RegExp(rank.dolbyVisionOnly.hdrPattern)
        };
    }

    function syncServer(core) {
        // Point the profile at the local proxy, which picks the fastest upstream server
        var target = config.servers && config.servers.coreUrl;
        if (!target) return;
        core.getState('ctx')
            .then(function (ctx) {
                var settings = ctx && ctx.profile && ctx.profile.settings;
                if (!settings || settings.streamingServerUrl === target) return;
                console.info('[tweaks] streaming server', settings.streamingServerUrl, '->', target);
                var next = Object.assign({}, settings, { streamingServerUrl: target });
                return core.dispatch({ action: 'Ctx', args: { action: 'UpdateSettings', args: next } }, 'ctx');
            })
            .catch(function (err) { console.warn('[tweaks] server selection failed', err); });
    }

    function prewarm(stream, fraction, onLan) {
        // Start a torrent and fetch its bytes at a position (the start by default) so a later play begins at once; onLan warms it on the computer
        var settings = config.prewarm || {};
        var key = stream && stream.infoHash + '@' + Math.round((fraction || 0) * 100);
        if (settings.enabled === false || !stream || !stream.infoHash || prewarmed[key]) return;
        prewarmed[key] = true;
        var query = 'hash=' + stream.infoHash.toLowerCase() + '&idx=' + (stream.fileIdx || 0) + '&at=' + (fraction || 0) + (onLan ? '&lan=1' : '');
        // The service answers at once and does the slow reads itself, so the page keeps its few connections for the player
        fetch('/__tweaks/warm?' + query).then(function (resp) {
            console.info('[tweaks] prewarm started', stream.infoHash, 'at', Math.round((fraction || 0) * 100) + '%', resp.status);
        }).catch(function (err) { console.warn('[tweaks] prewarm failed', err); });
    }

    function liveKey(stream) {
        // A torrent file as the streaming server names it
        return window.__twkEvidence.key(stream);
    }

    function testSources(rankedFor, ranked, force) {
        // Start the best few torrents of the open title in the background and measure them, so the recommended source is one that downloads now
        var settings = config.liveTest || {};
        var wanted = ranked.filter(function (s) { return s.infoHash; }).slice(0, settings.candidates || 3);
        if (settings.enabled === false || !rankedFor || !wanted.length) return;
        // Addons answer one by one: sources that arrive later join the test of the same title
        if (!force && live.forId === rankedFor) return addCandidates(wanted);
        stopTesting();
        live.forId = rankedFor;
        // Only a reset of earlier measurements changes the ranking; a first test starts from the same order
        if (Object.keys(live.classes).length) live.version++;
        live.classes = {};
        live.candidates = [];
        addCandidates(wanted);
    }

    function addCandidates(wanted) {
        // Warm and measure the wanted sources not tested yet: when the best ones fail the next ones take their place, up to a total per title
        var settings = config.liveTest || {};
        var known = live.candidates.map(liveKey);
        var fresh = wanted.filter(function (s) { return known.indexOf(liveKey(s)) === -1; }).slice(0, Math.max(0, (settings.maxTested || 6) - live.candidates.length));
        if (!fresh.length) return;
        live.candidates = live.candidates.concat(fresh);
        console.info('[tweaks] testing sources', fresh.map(function (s) { return summary(s, true) || s.infoHash; }).join(' | '));
        fresh.forEach(function (s) { prewarm(s, 0, startsOnLan(s)); });
        // The test lasts a full window after the newest candidate joined, so every one gets a sustained measurement
        live.started = Date.now();
        if (!live.timer) live.timer = setInterval(measure, settings.everyMs || 2000);
    }

    function releaseCandidates() {
        // Once the test is over only the recommended source stays started; proven dead ones were dropped already
        var keep = liveKey((window.__stremioRankedStreams || [])[0]);
        live.candidates.forEach(function (s) {
            if (liveKey(s) !== keep && live.classes[liveKey(s)] !== 'dead') fetch('/__tweaks/forget?hash=' + s.infoHash.toLowerCase()).catch(function () {});
        });
    }

    function stopTesting() {
        // End the measuring loop; replies still on their way belong to the ended test and are ignored
        if (live.timer) clearInterval(live.timer);
        live.timer = null;
        live.generation++;
    }

    function verdictText(result) {
        // One readable line of what a source delivered: verdict, sustained speed against its bitrate, peers
        var entry = result.entry || {};
        var how = result.delivered ? ' while reading its test bytes' : ' sustained';
        var speed = result.speed !== undefined ? ', ' + (result.speed / 1048576).toFixed(2) + ' MB/s' + how + ' (' + result.ratio.toFixed(1) + 'x its bitrate)' : '';
        return result.verdict + speed + ', ' + (entry.peers || 0) + ' peers connected, ' + (entry.found || 0) + ' found';
    }

    function measure() {
        // Sample every candidate; a changed verdict re-ranks the title and a proven dead source stops dialing at once
        var settings = config.liveTest || {};
        if (Date.now() - live.started > (settings.windowMs || 90000)) {
            console.info('[tweaks] source test done', live.candidates.map(function (s) { return (summary(s, true) || s.infoHash) + ': ' + (live.classes[liveKey(s)] || 'searching'); }).join(' | '));
            // On the player the doctor uses the prepared sources as fallbacks, so they stay started
            if (!shared.onPlayer()) releaseCandidates();
            return stopTesting();
        }
        var generation = live.generation;
        live.candidates.forEach(function (s) {
            window.__twkEvidence.sample(s).then(function () {
                if (generation !== live.generation) return;
                var result = window.__twkEvidence.assess(s);
                var key = liveKey(s);
                var cls = result.verdict === 'unknown' ? 'searching' : result.verdict;
                if (cls === live.classes[key]) return;
                live.classes[key] = cls;
                live.version++;
                if (cls === 'dead') fetch('/__tweaks/forget?hash=' + s.infoHash.toLowerCase()).catch(function () {});
                console.info('[tweaks] source', (summary(s, true) || key) + ':', verdictText(result));
            });
        });
    }

    function liveLabel(stream) {
        // Short line with what the background test measured for a source
        var cls = live.classes[liveKey(stream)];
        if (!cls) return '';
        if (cls === 'dead') return t('enhance.live.none');
        var result = window.__twkEvidence.assess(stream);
        var peers = result.entry ? result.entry.peers : 0;
        if (cls === 'searching') return t('enhance.live.searching');
        if (result.speed === undefined) return t('enhance.live.starting', { peers: peers });
        return t('enhance.live.tested', { speed: window.__twkI18n.number(result.speed / 1048576, 1) + ' MB/s', peers: peers });
    }

    function streamText(stream) {
        // Concatenate every human readable field the addon provides
        var hints = stream.behaviorHints || {};
        return [stream.name, stream.title, stream.description, hints.filename].filter(Boolean).join(' ').toLowerCase();
    }

    function parseSeeds(text) {
        // Torrentio and similar addons report seeders as "👤 N"
        var match = /👤\s*(\d+)/.exec(text);
        return match ? parseInt(match[1], 10) : null;
    }

    function runtimeSeconds(runtime) {
        // Parse "68 min", "1h 30min" or "2h" into seconds
        var text = String(runtime || '');
        var h = /(\d+)\s*h/i.exec(text);
        var m = /(\d+)\s*m/i.exec(text);
        var total = (h ? parseInt(h[1], 10) * 3600 : 0) + (m ? parseInt(m[1], 10) * 60 : 0);
        return total || null;
    }

    function sizeBytes(text) {
        // Torrentio-like descriptions carry the file size as "💾 4.01 GB"
        var match = /💾\s*([\d.]+)\s*(tb|gb|mb)/i.exec(text);
        if (!match) return null;
        var unit = { tb: 1e12, gb: 1e9, mb: 1e6 }[match[2].toLowerCase()];
        return parseFloat(match[1]) * unit;
    }

    function refreshLan() {
        // Remember whether a LAN server can take over, so ranking knows if the TV is on its own
        fetch('/__tweaks/status').then(function (r) { return r.json(); }).then(function (s) {
            window.__stremioLanAvailable = !!s.fallback;
        }).catch(function () {});
    }

    function isNotice(stream) {
        // Addons publish messages as fake streams (reinstall, configure, expired key); a real direct link points at a file, not at a home page
        if (stream.infoHash) return false;
        var text = String(stream.name || '') + ' ' + String(stream.title || '') + ' ' + String(stream.description || '');
        var url = typeof stream.url === 'string' ? stream.url : '';
        return !/^https?:\/\/[^/]+\/[^?#]/.test(url) || NOTICE.test(text);
    }

    function scoreStream(stream, context) {
        // Combine swarm health, resolution, audio quality, compatibility and what the TV can sustain
        var rank = config.ranking;
        var ctx = context || {};
        var text = streamText(stream);
        var warnings = [];
        var playable = !isNotice(stream) && (typeof stream.url === 'string' || typeof stream.infoHash === 'string');
        if (!playable) return { score: -1000, warnings: warnings };
        var resolution = shared.resolution(text);
        var seeds = parseSeeds(text);
        var direct = typeof stream.url === 'string' && !stream.infoHash;
        var needed = rank.minSeedsByResolution[resolution] || 2;
        var health = direct ? 1 : (seeds === null ? 0.3 : Math.min(1, seeds / needed));
        var score = health * rank.healthWeight + health * (resolution / 360) * rank.resolutionWeight;
        if (seeds !== null) score += Math.log(seeds + 1) / Math.LN2 * rank.seedLogWeight;
        if (direct) score += rank.directLinkBonus;
        if (rules.goodAudio.test(text)) score += rank.goodAudio.bonus;
        if (rules.surround.test(text)) score += rank.surround.bonus;
        rules.penalties.forEach(function (rule) {
            if (rule.regex.test(text)) {
                score -= rule.penalty;
                warnings.push(t(rule.labelKey));
            }
        });
        if (rules.dolbyVision.test(text) && !rules.hdr.test(text)) {
            score -= rank.dolbyVisionOnly.penalty;
            warnings.push(t('enhance.warn.dolbyVision'));
        }
        // What the background test measured moves a source up or down within its quality
        var tested = live.classes[liveKey(stream)];
        var testScores = (config.liveTest || {}).scores || {};
        if (tested && testScores[tested]) score += testScores[tested];
        if (tested === 'dead' || tested === 'tooSlow') warnings.push(tested === 'dead' ? t('enhance.live.none') : t('enhance.live.slow'));
        // Bitrate from file size and runtime, kept for the doctor to start heavy sources on the LAN server
        var size = sizeBytes(text);
        var bitrate = size && ctx.runtimeS ? size / ctx.runtimeS : null;
        if (bitrate && stream.infoHash) window.__stremioStreamBitrate[stream.infoHash] = bitrate;
        // Preferred quality: a cap above which sources lose, and a bonus for the exact target
        if (ctx.targetRes && resolution > ctx.targetRes) score -= 150;
        if (ctx.targetRes && resolution === ctx.targetRes) score += 15;
        // Heavier than what the server that would play it delivers: the computer when available, else the TV
        var over = ctx.lan ? rank.overLanSpeed : rank.overTvSpeed;
        var limit = ctx.lan ? ctx.lanRate : ctx.tvRate;
        if (over && bitrate && limit && bitrate > limit * over.margin) {
            score -= over.penalty;
            warnings.push(t(ctx.lan ? 'enhance.warn.overComputer' : 'enhance.warn.overTv'));
        }
        return { score: score, warnings: warnings };
    }

    function startsOnLan(stream) {
        // A heavy source starts on the computer when one answers and the doctor learned the TV cannot sustain it
        var doctor = window.__stremioDoctor;
        return !!(stream && stream.infoHash && doctor && (config.doctor || {}).startOnLanWhenHeavy !== false &&
            (config.servers || {}).useLan !== false && window.__stremioLanAvailable === true && doctor.heavyForTv(stream.infoHash.toLowerCase()));
    }

    function rankMetaDetails(state) {
        // Sort streams inside each addon group, then groups by their best stream
        var rank = config.ranking;
        if (!rules || !rank.enabled || !state || !Array.isArray(state.streams)) return state;
        // What the TV can sustain on its own decides how heavy sources are scored
        var meta = state.metaItem && state.metaItem.content && state.metaItem.content.content;
        var simple = config.simple || {};
        var context = {
            targetRes: simple.quality && simple.quality !== 'best' ? parseInt(simple.quality, 10) : null,
            runtimeS: runtimeSeconds(meta && meta.runtime),
            tvRate: shared.learnedRate('twk.tvRate'),
            lanRate: shared.learnedRate('twk.lanRate'),
            lan: (config.servers || {}).useLan !== false && window.__stremioLanAvailable === true
        };
        // The title page polls the core many times a second; the same sources in the same context reuse the last ranking
        var selected = state.selected || {};
        var signature = JSON.stringify(context) + '|' + live.version + '|' + (selected.streamPath ? selected.streamPath.id : '') + '|' + state.streams.map(function (group) {
            var content = group.content || {};
            var list = content.type === 'Ready' && Array.isArray(content.content) ? content.content.map(function (s) { return s.infoHash || s.url || ''; }).join(',') : '';
            return (group.addon && group.addon.transportUrl || '') + ':' + content.type + ':' + list;
        }).join('|');
        if (lastRanking && lastRanking.signature === signature) return finishRanking(state, lastRanking);
        var groups = state.streams.map(function (group) {
            var ready = group.content && group.content.type === 'Ready' && Array.isArray(group.content.content);
            if (!ready) return { group: group, best: -Infinity };
            var scored = group.content.content.map(function (stream) {
                return { stream: stream, result: scoreStream(stream, context) };
            }).sort(function (a, b) { return b.result.score - a.result.score; });
            var streams = scored.map(function (item) {
                if (!item.result.warnings.length) return item.stream;
                var note = t('enhance.warningPrefix') + item.result.warnings.join(', ');
                return Object.assign({}, item.stream, { description: note + '\n' + (item.stream.description || '') });
            });
            var content = Object.assign({}, group.content, { content: streams });
            return { group: Object.assign({}, group, { content: content }), best: scored.length ? scored[0].result.score : -Infinity };
        }).sort(function (a, b) { return b.best - a.best; });
        // Remember the playable streams in ranked order, and their video, for the source picker and the doctor
        var rankedFor = selected.streamPath ? selected.streamPath.id : null;
        // Several addon instances list the same torrent; keep its best-ranked copy so a switch always changes the source
        var seen = {};
        var rankedStreams = groups.reduce(function (list, item) {
            var content = item.group.content && item.group.content.content;
            return Array.isArray(content) ? list.concat(content.filter(function (s) {
                var key = s.infoHash ? s.infoHash.toLowerCase() + '/' + (s.fileIdx || 0) : s.url;
                if (!s.deepLinks || !s.deepLinks.player || !key || seen[key] || isNotice(s)) return false;
                seen[key] = true;
                return true;
            })) : list;
        }, []);
        var top = groups[0];
        if (top && top.best > 0) {
            var first = top.group.content.content[0];
            top.group.content.content[0] = Object.assign({}, first, { description: t('enhance.recommended') + '\n' + (first.description || '') });
        }
        lastRanking = { signature: signature, groups: groups.map(function (item) { return item.group; }), rankedFor: rankedFor, rankedStreams: rankedStreams };
        return finishRanking(state, lastRanking);
    }

    function finishRanking(state, ranking) {
        // Publish the ranked list for the picker and the doctor, warm the recommended source and build the state for the UI
        window.__stremioRankedFor = ranking.rankedFor;
        window.__stremioRankedStreams = ranking.rankedStreams;
        // Warm the recommended torrent only on the title page, where the click to play happens, on the computer when the TV cannot sustain it
        var recommended = ranking.rankedStreams[0];
        if ((location.hash || '').indexOf('#/detail') === 0) {
            prewarm(recommended, 0, startsOnLan(recommended));
            testSources(ranking.rankedFor, ranking.rankedStreams, false);
        }
        var ranked = Object.assign({}, state, { streams: ranking.groups });
        return (config.simple || {}).enabled ? simplify(ranked) : ranked;
    }

    function summary(stream, compact) {
        // One clean line: resolution, audio, size and, unless compact, seeders
        var text = streamText(stream);
        var resolution = shared.resolution(text);
        var audio = /atmos/.test(text) ? 'Atmos' : /truehd/.test(text) ? 'TrueHD' : /dts/.test(text) ? 'DTS' : /ddp|dd\+|eac3|e-ac-3/.test(text) ? 'Dolby Digital Plus' : /\bac3\b|\bdd\b|dd5/.test(text) ? 'Dolby Digital' : /aac/.test(text) ? 'AAC' : '';
        var channels = /7\.1/.test(text) ? '7.1' : /5\.1|6ch/.test(text) ? '5.1' : '';
        var size = /💾\s*([\d.]+\s*[tgm]b)/i.exec(text);
        var seeds = parseSeeds(text);
        return [resolution === 2160 ? '4K' : resolution ? resolution + 'p' : '', [audio, channels].filter(Boolean).join(' '), size ? size[1].toUpperCase() : '', seeds !== null && !compact ? t('enhance.seeds', { count: seeds }) : '']
            .filter(Boolean).join(' · ');
    }

    function simplify(state) {
        // Simple mode: one "Watch" entry with the best source; the full list stays on the green key
        var best = (window.__stremioRankedStreams || [])[0];
        var simple = config.simple || {};
        if (!best) {
            // While no playable source arrived, keep only the addons still loading, so links to other services do not flash first
            var loading = state.streams.filter(function (group) { return group.content && group.content.type === 'Loading'; });
            return loading.length ? Object.assign({}, state, { streams: loading }) : state;
        }
        var home = state.streams.filter(function (group) {
            return group.content && group.content.type === 'Ready' && group.content.content.some(function (s) { return s.deepLinks === best.deepLinks; });
        })[0];
        if (!home) return state;
        var entry = Object.assign({}, best, {
            name: t('simple.watch'),
            // The stream card has room for one short line; the full summary goes to the details panel
            title: [summary(best, true), liveLabel(best)].filter(Boolean).join(' · '),
            description: summary(best) + (liveLabel(best) ? '\n' + liveLabel(best) : '') + '\n' + t('simple.moreHint')
        });
        return Object.assign({}, state, { streams: [Object.assign({}, home, { content: Object.assign({}, home.content, { content: [entry] }) })] });
    }

    function wrapGetState(core) {
        // Rank meta_details results on their way to the UI
        if (core.__tweaksWrapped) return;
        core.__tweaksWrapped = true;
        var original = core.getState;
        core.getState = function (model) {
            return original.apply(core, arguments).then(function (state) {
                return model === 'meta_details' ? rankMetaDetails(state) : state;
            });
        };
    }

    window.__stremioStreamBitrate = window.__stremioStreamBitrate || {};
    refreshLan();
    setInterval(refreshLan, 30000);

    shared.whenCoreReady(function (core) {
        window.__twkI18n.refresh().then(function () {
            wrapGetState(core);
            syncServer(core);
        });
    });

    window.__stremioTweaks = {
        scoreStream: scoreStream,
        rankMetaDetails: rankMetaDetails,
        summary: summary,
        prewarm: prewarm,
        liveLabel: liveLabel,
        // Measure the current title's sources again, for the refresh row of the picker
        retest: function () { testSources(window.__stremioRankedFor, window.__stremioRankedStreams || [], true); }
    };
})();
