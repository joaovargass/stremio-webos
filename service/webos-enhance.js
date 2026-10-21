// Core-level tweaks: points the profile at the local proxy (which picks the
// fastest streaming server), adds peer sources to torrents and ranks streams so
// the most compatible and healthy one is listed first. All parameters come from
// window.STREMIO_TWEAKS, loaded from tweaks.json.
(function () {
    var config = window.STREMIO_TWEAKS || {};
    var TORRENT_URL = /^(https?:\/\/[^/]+)\/([0-9a-f]{40})\/(\d+)/i;
    var boostedHashes = {};
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

    function boostTorrent(url) {
        // Re-create the torrent engine with extra trackers once per info hash
        var match = TORRENT_URL.exec(url || '');
        if (!match || boostedHashes[match[2]] || !config.trackers) return;
        boostedHashes[match[2]] = true;
        var sources = config.trackers.map(function (t) { return 'tracker:' + t; }).concat(['dht:' + match[2]]);
        var body = { torrent: { infoHash: match[2] }, peerSearch: Object.assign({ sources: sources }, config.peerSearch) };
        fetch(match[1] + '/' + match[2] + '/create', {
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

    function scoreStream(stream) {
        // Combine swarm health, resolution, audio quality and compatibility penalties
        var rank = config.ranking;
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
        return { score: score, warnings: warnings };
    }

    function rankMetaDetails(state) {
        // Sort streams inside each addon group, then groups by their best stream
        var rank = config.ranking;
        if (!rules || !rank.enabled || !state || !Array.isArray(state.streams)) return state;
        var groups = state.streams.map(function (group) {
            var ready = group.content && group.content.type === 'Ready' && Array.isArray(group.content.content);
            if (!ready) return { group: group, best: -Infinity };
            var scored = group.content.content.map(function (stream) {
                return { stream: stream, result: scoreStream(stream) };
            }).sort(function (a, b) { return b.result.score - a.result.score; });
            var streams = scored.map(function (item) {
                if (!item.result.warnings.length) return item.stream;
                var note = rank.warnPrefix + item.result.warnings.join(', ');
                return Object.assign({}, item.stream, { description: note + '\n' + (item.stream.description || '') });
            });
            var content = Object.assign({}, group.content, { content: streams });
            return { group: Object.assign({}, group, { content: content }), best: scored.length ? scored[0].result.score : -Infinity };
        }).sort(function (a, b) { return b.best - a.best; });
        var top = groups[0];
        if (top && top.best > 0) {
            var first = top.group.content.content[0];
            top.group.content.content[0] = Object.assign({}, first, { description: rank.badge + '\n' + (first.description || '') });
        }
        return Object.assign({}, state, { streams: groups.map(function (item) { return item.group; }) });
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

    whenCoreReady(function (core) {
        wrapGetState(core);
        syncServer(core);
    });

    window.__stremioTweaks = { scoreStream: scoreStream, rankMetaDetails: rankMetaDetails };
})();
