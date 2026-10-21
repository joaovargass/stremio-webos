// Core-level tweaks: points the profile at the local proxy (which picks the
// fastest streaming server and adds peer sources to torrents), ranks streams so
// the most compatible and healthy one is listed first and asks the service to
// warm it. All parameters come from window.STREMIO_TWEAKS, loaded from tweaks.json.
(function () {
    var config = window.STREMIO_TWEAKS || {};
    var prewarmed = {};
    var lastRanking = null;
    var live = { forId: null, candidates: [], since: {}, stats: {}, classes: {}, busy: {}, version: 0, timer: null, started: 0 };
    var NOTICE = /reinstall|re-install|configure (this|the) addon|install the addon|not configured|expired|invalid (api )?key|update (this|the) addon/i;
    var rules = compileRules(config.ranking);

    function compileRules(rank) {
        // Build every ranking regex once so scoring stays cheap on the TV CPU
        if (!rank) return null;
        var penalties = [rank.unsupportedAudio, rank.remux, rank.threeD, rank.cinemaCopy].map(function (rule) {
            return { regex: new RegExp(rule.pattern), penalty: rule.penalty, label: rule.label };
        });
        return {
            goodAudio: new RegExp(rank.goodAudio.pattern),
            surround: new RegExp(rank.surround.pattern),
            penalties: penalties,
            dolbyVision: new RegExp(rank.dolbyVisionOnly.pattern),
            hdr: new RegExp(rank.dolbyVisionOnly.hdrPattern)
        };
    }

    function whenCoreReady(callback) {
        // The core bridge is created asynchronously by main.js
        if (window.core && typeof window.core.getState === 'function') return callback(window.core);
        setTimeout(function () { whenCoreReady(callback); }, 500);
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
        // Start a torrent and fetch its bytes at a position (the start by default) so a later play begins at once; onLan warms it on the Mac
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
        return stream && stream.infoHash ? stream.infoHash.toLowerCase() + '/' + (stream.fileIdx || 0) : null;
    }

    function liveClass(entry, key) {
        // Turn a measurement into a class, so the ranking changes only when a source really moves up or down
        var settings = config.liveTest || {};
        var elapsed = Date.now() - (live.since[key] || live.started);
        if (!entry.peers) return elapsed > (settings.deadAfterMs || 12000) ? 'dead' : 'waiting';
        if (elapsed < (settings.judgeAfterMs || 6000)) return 'waiting';
        return entry.ratio >= 1.5 ? 'fast' : entry.ratio >= 1 ? 'ok' : entry.ratio >= 0.5 ? 'slow' : 'tooSlow';
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
        live.started = Date.now();
        // Only a reset of earlier measurements changes the ranking; a first test starts from the same order
        if (Object.keys(live.classes).length) live.version++;
        live.stats = {};
        live.classes = {};
        live.since = {};
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
        fresh.forEach(function (s) { live.since[liveKey(s)] = Date.now(); });
        console.info('[tweaks] testing sources', fresh.map(function (s) { return summary(s, true) || s.infoHash; }).join(' | '));
        fresh.forEach(function (s) { prewarm(s, 0, startsOnLan(s)); });
        // Each new source gets a full window to be judged
        live.started = Date.now();
        if (!live.timer) live.timer = setInterval(measure, settings.everyMs || 2000);
    }

    function stopTesting() {
        // End the measuring loop; the last numbers stay for the ranking and the picker
        if (live.timer) clearInterval(live.timer);
        live.timer = null;
    }

    function measure() {
        // Read peers and speed of each candidate against its bitrate, one request per source at a time
        var settings = config.liveTest || {};
        var doctor = window.__stremioDoctor;
        if (Date.now() - live.started > (settings.windowMs || 30000)) {
            console.info('[tweaks] source test done', JSON.stringify(live.classes));
            return stopTesting();
        }
        if (!doctor) return;
        live.candidates.forEach(function (s) {
            var key = liveKey(s);
            if (live.busy[key]) return;
            live.busy[key] = true;
            doctor.fetchJson('/' + key + '/stats.json').then(function (st) {
                live.busy[key] = false;
                if (!st) return;
                var needed = window.__stremioStreamBitrate[s.infoHash] || 1048576;
                var entry = { speed: st.downloadSpeed || 0, peers: st.peers || 0, ratio: (st.downloadSpeed || 0) / needed };
                live.stats[key] = entry;
                var cls = liveClass(entry, key);
                if (cls === live.classes[key]) return;
                live.classes[key] = cls;
                live.version++;
                // A source without peers is dropped at once, so dead torrents do not keep dialing through the home connection
                if (cls === 'dead') fetch('/__tweaks/forget?hash=' + s.infoHash.toLowerCase()).catch(function () {});
                console.info('[tweaks] source', summary(s, true) || key, cls, Math.round(entry.speed / 1024) + ' KB/s,', entry.peers, 'peers');
            });
        });
    }

    function liveLabel(stream) {
        // Short pt-BR line with what the background test measured for a source
        var key = liveKey(stream);
        var entry = live.stats[key];
        var cls = live.classes[key];
        if (!entry || !cls) return '';
        if (cls === 'dead') return 'sem conexão no teste';
        var speed = (entry.speed / 1048576).toFixed(1).replace('.', ',') + ' MB/s';
        return cls === 'waiting' ? 'testando · ' + speed : 'testada · ' + speed + ' · ' + entry.peers + ' peers';
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

    function parseResolution(text) {
        // Map resolution keywords to a vertical pixel count
        if (/2160p|\b4k\b|\buhd\b/.test(text)) return 2160;
        if (/1080p|\bfhd\b/.test(text)) return 1080;
        if (/720p/.test(text)) return 720;
        if (/480p|\bsd\b/.test(text)) return 480;
        return 0;
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

    function learnedRate(key) {
        // Download rate the doctor learned for one server ('twk.tvRate', 'twk.lanRate'), in bytes per second, once enough samples exist
        try {
            var saved = JSON.parse(localStorage.getItem(key) || 'null');
            return saved && saved.n >= 30 ? saved.rate : null;
        } catch (_e) {
            return null;
        }
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
        var resolution = parseResolution(text);
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
                warnings.push(rule.label);
            }
        });
        if (rules.dolbyVision.test(text) && !rules.hdr.test(text)) {
            score -= rank.dolbyVisionOnly.penalty;
            warnings.push(rank.dolbyVisionOnly.label);
        }
        // What the background test measured moves a source up or down within its quality
        var tested = live.classes[liveKey(stream)];
        var testScores = (config.liveTest || {}).scores || {};
        if (tested && testScores[tested]) score += testScores[tested];
        if (tested === 'dead' || tested === 'tooSlow') warnings.push(tested === 'dead' ? 'sem conexão no teste' : 'lenta no teste');
        // Bitrate from file size and runtime, kept for the doctor to start heavy sources on the LAN server
        var size = sizeBytes(text);
        var bitrate = size && ctx.runtimeS ? size / ctx.runtimeS : null;
        if (bitrate && stream.infoHash) window.__stremioStreamBitrate[stream.infoHash] = bitrate;
        // Preferred quality: a cap above which sources lose, and a bonus for the exact target
        if (ctx.targetRes && resolution > ctx.targetRes) score -= 150;
        if (ctx.targetRes && resolution === ctx.targetRes) score += 15;
        // Heavier than what the server that would play it delivers: the Mac when available, else the TV
        var over = ctx.lan ? rank.overLanSpeed : rank.overTvSpeed;
        var limit = ctx.lan ? ctx.lanRate : ctx.tvRate;
        if (over && bitrate && limit && bitrate > limit * over.margin) {
            score -= over.penalty;
            warnings.push(over.label);
        }
        return { score: score, warnings: warnings };
    }

    function startsOnLan(stream) {
        // A heavy source starts on the Mac when one answers and the doctor learned the TV cannot sustain it
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
            tvRate: learnedRate('twk.tvRate'),
            lanRate: learnedRate('twk.lanRate'),
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
                var note = rank.warnPrefix + item.result.warnings.join(', ');
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
            top.group.content.content[0] = Object.assign({}, first, { description: rank.badge + '\n' + (first.description || '') });
        }
        lastRanking = { signature: signature, groups: groups.map(function (item) { return item.group; }), rankedFor: rankedFor, rankedStreams: rankedStreams };
        return finishRanking(state, lastRanking);
    }

    function finishRanking(state, ranking) {
        // Publish the ranked list for the picker and the doctor, warm the recommended source and build the state for the UI
        window.__stremioRankedFor = ranking.rankedFor;
        window.__stremioRankedStreams = ranking.rankedStreams;
        // Warm the recommended torrent only on the title page, where the click to play happens, on the Mac when the TV cannot sustain it
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
        var resolution = parseResolution(text);
        var audio = /atmos/.test(text) ? 'Atmos' : /truehd/.test(text) ? 'TrueHD' : /dts/.test(text) ? 'DTS' : /ddp|dd\+|eac3|e-ac-3/.test(text) ? 'Dolby Digital Plus' : /\bac3\b|\bdd\b|dd5/.test(text) ? 'Dolby Digital' : /aac/.test(text) ? 'AAC' : '';
        var channels = /7\.1/.test(text) ? '7.1' : /5\.1|6ch/.test(text) ? '5.1' : '';
        var size = /💾\s*([\d.]+\s*[tgm]b)/i.exec(text);
        var seeds = parseSeeds(text);
        return [resolution === 2160 ? '4K' : resolution ? resolution + 'p' : '', [audio, channels].filter(Boolean).join(' '), size ? size[1].toUpperCase() : '', seeds !== null && !compact ? seeds + ' seeds' : '']
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
            name: simple.playLabel || 'Assistir',
            // The stream card has room for one short line; the full summary goes to the details panel
            title: [summary(best, true), liveLabel(best)].filter(Boolean).join(' · '),
            description: summary(best) + (liveLabel(best) ? '\n' + liveLabel(best) : '') + (simple.moreHint ? '\n' + simple.moreHint : '')
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

    whenCoreReady(function (core) {
        wrapGetState(core);
        syncServer(core);
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
