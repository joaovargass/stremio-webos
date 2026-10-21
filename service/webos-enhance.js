// Core-level tweaks: points the profile at the local proxy (which picks the
// fastest streaming server), adds peer sources to torrents and ranks streams so
// the most compatible and healthy one is listed first. All parameters come from
// window.STREMIO_TWEAKS, loaded from tweaks.json.
(function () {
    var config = window.STREMIO_TWEAKS || {};
    var TORRENT_URL = /^(https?:\/\/[^/]+)\/([0-9a-f]{40})\/(\d+)/i;
    var boostedHashes = {};
    var prewarmed = {};
    var rules = compileRules(config.ranking);

    function compileRules(rank) {
        // Build every ranking regex once so scoring stays cheap on the TV CPU
        if (!rank) return null;
        var penalties = [rank.unsupportedAudio, rank.remux, rank.threeD].map(function (rule) {
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

    function prewarm(stream) {
        // Start the recommended torrent and fetch its first bytes while the viewer reads the list
        var settings = config.prewarm || {};
        var base = config.servers && config.servers.coreUrl;
        if (settings.enabled === false || !base || !stream || !stream.infoHash || prewarmed[stream.infoHash]) return;
        prewarmed[stream.infoHash] = true;
        var url = base.replace(/\/$/, '') + '/' + stream.infoHash + '/' + (stream.fileIdx || 0);
        boostTorrent(url).then(function () {
            return fetch(url, { headers: { Range: 'bytes=0-' + ((settings.warmBytes || 1048576) - 1) } });
        }).then(function (resp) {
            console.info('[tweaks] prewarmed', stream.infoHash, resp.status);
            return resp.arrayBuffer();
        }).catch(function (err) { console.warn('[tweaks] prewarm failed', err); });
    }

    function boostTorrent(url) {
        // Re-create the torrent engine with extra trackers once per info hash
        var match = TORRENT_URL.exec(url || '');
        if (!match || boostedHashes[match[2]] || !config.trackers || (config.peerBoost || {}).enabled === false) return Promise.resolve();
        boostedHashes[match[2]] = true;
        var sources = config.trackers.map(function (t) { return 'tracker:' + t; }).concat(['dht:' + match[2]]);
        var body = { torrent: { infoHash: match[2] }, peerSearch: Object.assign({ sources: sources }, config.peerSearch) };
        return fetch(match[1] + '/' + match[2] + '/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).then(function (resp) {
            console.info('[tweaks] peer sources added', match[2], resp.status);
        }).catch(function (err) { console.warn('[tweaks] peer sources failed', err); });
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

    function tvRate() {
        // Learned download rate of the TV's own server, in bytes per second, once enough samples exist
        try {
            var saved = JSON.parse(localStorage.getItem('twk.tvRate') || 'null');
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

    function scoreStream(stream, context) {
        // Combine swarm health, resolution, audio quality, compatibility and what the TV can sustain
        var rank = config.ranking;
        var ctx = context || {};
        var text = streamText(stream);
        var warnings = [];
        var playable = typeof stream.url === 'string' || typeof stream.infoHash === 'string';
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
        // Bitrate from file size and runtime, kept for the doctor to start heavy sources on the LAN server
        var size = sizeBytes(text);
        var bitrate = size && ctx.runtimeS ? size / ctx.runtimeS : null;
        if (bitrate && stream.infoHash) window.__stremioStreamBitrate[stream.infoHash] = bitrate;
        // Preferred quality: a cap above which sources lose, and a bonus for the exact target
        if (ctx.targetRes && resolution > ctx.targetRes) score -= 150;
        if (ctx.targetRes && resolution === ctx.targetRes) score += 15;
        var over = rank.overTvSpeed;
        if (over && bitrate && ctx.tvRate && !ctx.lan && bitrate > ctx.tvRate * over.margin) {
            score -= over.penalty;
            warnings.push(over.label);
        }
        return { score: score, warnings: warnings };
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
            tvRate: tvRate(),
            lan: (config.servers || {}).useLan !== false && window.__stremioLanAvailable === true
        };
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
        var selected = state.selected || {};
        window.__stremioRankedFor = selected.streamPath ? selected.streamPath.id : null;
        window.__stremioRankedStreams = groups.reduce(function (list, item) {
            var content = item.group.content && item.group.content.content;
            return Array.isArray(content) ? list.concat(content.filter(function (s) {
                return s.deepLinks && s.deepLinks.player && (s.infoHash || s.url);
            })) : list;
        }, []);
        // Warm the recommended torrent only on the title page, where the click to play happens
        if ((location.hash || '').indexOf('#/detail') === 0) prewarm(window.__stremioRankedStreams[0]);
        var top = groups[0];
        if (top && top.best > 0) {
            var first = top.group.content.content[0];
            top.group.content.content[0] = Object.assign({}, first, { description: rank.badge + '\n' + (first.description || '') });
        }
        var ranked = Object.assign({}, state, { streams: groups.map(function (item) { return item.group; }) });
        return simple.enabled ? simplify(ranked) : ranked;
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
        if (!best) return state;
        var home = state.streams.filter(function (group) {
            return group.content && group.content.type === 'Ready' && group.content.content.some(function (s) { return s.deepLinks === best.deepLinks; });
        })[0];
        if (!home) return state;
        var entry = Object.assign({}, best, {
            name: simple.playLabel || 'Assistir',
            // The stream card has room for one short line; the full summary goes to the details panel
            title: summary(best, true),
            description: summary(best) + (simple.moreHint ? '\n' + simple.moreHint : '')
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

    // Boost every torrent the media element starts loading
    document.addEventListener('loadstart', function (e) {
        if (e.target instanceof HTMLMediaElement) boostTorrent(e.target.currentSrc || e.target.src);
    }, true);

    window.__stremioStreamBitrate = window.__stremioStreamBitrate || {};
    refreshLan();
    setInterval(refreshLan, 30000);

    whenCoreReady(function (core) {
        wrapGetState(core);
        syncServer(core);
    });

    window.__stremioTweaks = { scoreStream: scoreStream, rankMetaDetails: rankMetaDetails, summary: summary };
})();
