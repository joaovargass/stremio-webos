// Centralized subtitles: cleans the addon results, adds OpenSubtitles v3 matches
// found by video hash, file size and file name, orders tracks by language
// preference and picks one automatically (embedded first, then pt-BR, then the
// video's original language). Parameters come from window.STREMIO_TWEAKS.subtitles.
(function () {
    var config = (window.STREMIO_TWEAKS || {}).subtitles || {};
    var simple = (window.STREMIO_TWEAKS || {}).simple || {};
    var LANG_GROUPS = {
        'pt-br': ['pob', 'pt-br', 'pt_br', 'ptbr', 'pb', 'brazilian', 'portuguese (brazil)', 'português (brasil)'],
        pt: ['por', 'pt', 'pt-pt', 'portuguese', 'português']
    };
    var ISO3_TO_2 = { eng: 'en', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh', rus: 'ru', ara: 'ar', hin: 'hi', tur: 'tr', pol: 'pl', dut: 'nl', nld: 'nl', swe: 'sv' };
    var LABELS = { 'pt-br': 'Português (BR)', pt: 'Português', en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch', it: 'Italiano', ja: '日本語', ko: '한국어' };
    var RELEASE_TAGS = ['web', 'webdl', 'webrip', 'bluray', 'brrip', 'bdrip', 'hdtv', 'dvdrip', 'remux', '720p', '1080p', '2160p', 'amzn', 'nf', 'dsnp', 'hmax', 'atvp', 'hulu', 'ip'];
    var extraCache = {};
    var pending = {};
    var firstPickAt = {};
    var syncScores = {};

    function baseLang(lang) {
        // Reduce any language tag to "pt-br", "pt" or a two-letter code
        var value = String(lang || '').toLowerCase().trim();
        if (LANG_GROUPS['pt-br'].indexOf(value) !== -1) return 'pt-br';
        if (LANG_GROUPS.pt.indexOf(value) !== -1) return 'pt';
        var head = value.split(/[-_ ]/)[0];
        return ISO3_TO_2[head] || head;
    }

    function isError(track) {
        // Addons sometimes publish their own failures as fake subtitle tracks
        return /^!|error/i.test(track.lang || '') || /error-subtitle/i.test(track.url || '');
    }

    function isSdh(track) {
        // Hearing-impaired tracks carry sound descriptions the viewer rarely wants
        return /\bsdh\b|\bcc\b|hearing/i.test((track.label || '') + ' ' + (track.lang || ''));
    }

    function nativeLang(audioTracks) {
        // The first audio track language is the best guess for the original language
        var first = (audioTracks || []).filter(function (t) { return t && t.lang; })[0];
        return first ? baseLang(first.lang) : null;
    }

    function rank(lang, native) {
        // Lower is better: pt-BR, pt, original language, then everything else
        var base = baseLang(lang);
        if (base === 'pt-br') return 0;
        if (base === 'pt') return 1;
        if (native && base === native) return 2;
        return 3;
    }

    function tokens(text) {
        // Lowercase release words, joining WEB-DL style tags into one token
        return String(text || '').toLowerCase().replace(/web[-. ]?dl/g, 'webdl').split(/[^a-z0-9]+/).filter(Boolean);
    }

    function syncScore(track, filename) {
        // Likelihood that a subtitle was timed for this exact release
        var score = 0;
        var video = tokens(filename);
        var subtitle = tokens(track.subtitleFileName);
        if (track.m === 'h') score += 100;
        if (track.releaseGroup && video.indexOf(String(track.releaseGroup).toLowerCase()) !== -1) score += 30;
        var shared = RELEASE_TAGS.filter(function (tag) { return video.indexOf(tag) !== -1 && subtitle.indexOf(tag) !== -1; }).length;
        score += Math.min(20, shared * 5);
        // Split CD1/CD2 subtitles never match a single-file release
        if (/\bcd ?\d\b/i.test(track.subtitleFileName || '')) score -= 40;
        return score;
    }

    function scoreOf(track) {
        // Score saved while merging, looked up by id or URL because the player rebuilds track objects
        var value = syncScores[track.id];
        return value !== undefined ? value : syncScores[track.url] || 0;
    }

    function prettify(track) {
        // Human readable label shown in the player menu, flagging release-matched subtitles
        var base = baseLang(track.lang);
        var name = LABELS[base] || track.lang;
        var synced = track.m === 'h' ? ' · sincronizada' : '';
        return Object.assign({}, track, { label: name + ' · ' + (track.origin || 'Addon') + synced });
    }

    function videoKey(player) {
        // Identify the playing video so lookups are cached per item
        var path = player && player.selected && player.selected.subtitlesPath;
        return path ? path.type + '/' + path.id : null;
    }

    function fetchOpenSubtitles(player, key) {
        // Query OpenSubtitles v3 with hash, size and filename for release-matched results
        if (config.openSubtitles === false || !config.openSubtitlesUrl || pending[key] || extraCache[key]) return;
        pending[key] = true;
        var path = player.selected.subtitlesPath;
        var stream = player.selected.stream || {};
        var hints = stream.behaviorHints || {};
        var server = (window.__STREMIO_SERVER_URL__ || 'http://127.0.0.1:11470').replace(/\/$/, '');
        var media = stream.infoHash ? server + '/' + stream.infoHash + '/' + (stream.fileIdx || 0) : stream.url;
        var hashPromise = media ?
            fetch(server + '/opensubHash?videoUrl=' + encodeURIComponent(media)).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }) :
            Promise.resolve(null);
        hashPromise.then(function (hash) {
            var extras = [];
            if (hash && hash.result) {
                extras.push('videoHash=' + hash.result.hash);
                extras.push('videoSize=' + hash.result.size);
            }
            if (hints.filename) extras.push('filename=' + encodeURIComponent(hints.filename));
            var target = config.openSubtitlesUrl.replace(/\/$/, '') + '/subtitles/' + path.type + '/' + encodeURIComponent(path.id) +
                (extras.length ? '/' + extras.join('&') : '') + '.json';
            return fetch(target).then(function (r) { return r.json(); });
        }).then(function (data) {
            extraCache[key] = ((data && data.subtitles) || []).map(function (s) {
                return { id: 'tweaks-os-' + s.id, url: s.url, lang: s.lang, origin: 'OpenSubtitles', m: s.m, releaseGroup: s.releaseGroup, subtitleFileName: s.subtitleFileName, fpsMilli: s.fpsMilli };
            });
            console.info('[subs] OpenSubtitles v3 returned', extraCache[key].length, 'tracks for', key);
        }).catch(function (err) {
            console.warn('[subs] OpenSubtitles v3 lookup failed', err);
            extraCache[key] = [];
        });
    }

    function enhancePlayer(state) {
        // Merge, clean and order the subtitles list the player shows
        if (!config.enabled || !state || !Array.isArray(state.subtitles)) return state;
        var key = videoKey(state);
        if (key) fetchOpenSubtitles(state, key);
        var seen = {};
        var merged = state.subtitles.concat(extraCache[key] || []).filter(function (track) {
            if (!track || !track.url || isError(track) || seen[track.url]) return false;
            seen[track.url] = true;
            return true;
        });
        var native = window.__stremioNativeLang || null;
        var hints = (state.selected && state.selected.stream && state.selected.stream.behaviorHints) || {};
        merged.forEach(function (track, i) {
            track.__order = i;
            syncScores[track.id] = syncScores[track.url] = syncScore(track, hints.filename);
        });
        // Language first, then sync likelihood; the index keeps the sort stable on the TV engine
        merged.sort(function (a, b) {
            return rank(a.lang, native) - rank(b.lang, native) || scoreOf(b) - scoreOf(a) || a.__order - b.__order;
        });
        return Object.assign({}, state, { subtitles: (simple.enabled ? bestPerLanguage(merged) : merged).map(prettify) });
    }

    function bestPerLanguage(tracks) {
        // Simple mode keeps the best track of each language, in preference order, up to the configured count
        var seen = {};
        return tracks.filter(function (track) {
            var lang = baseLang(track.lang);
            if (seen[lang] || Object.keys(seen).length >= (simple.subtitleChoices || 3)) return false;
            seen[lang] = true;
            return true;
        });
    }

    function matches(track, wanted, native) {
        // Check one track against a "pt-br" / "pt" / "native" / "any" preference
        var base = baseLang(track.lang);
        if (wanted === 'any') return true;
        if (wanted === 'native') return !!native && base === native;
        return base === wanted;
    }

    function choose(tracks, wanted, native) {
        // Prefer non-SDH tracks, then the ones most likely timed for this release
        var hits = tracks.filter(function (t) { return matches(t, wanted, native); });
        hits.forEach(function (t, i) { t.__pickOrder = i; });
        hits.sort(function (a, b) {
            return (config.avoidSdh ? isSdh(a) - isSdh(b) : 0) || scoreOf(b) - scoreOf(a) || a.__pickOrder - b.__pickOrder;
        });
        return hits[0] || null;
    }

    window.__stremioPickSubtitles = function (embedded, extra, audioTracks) {
        // Walk the configured priority list and return the first available track
        if (!config.enabled || !config.autoPick) return null;
        var native = nativeLang(audioTracks);
        window.__stremioNativeLang = native;
        var priority = config.priority || [];
        // Embedded tracks arrive late; external ones may only win once the wait window is over
        var stream = location.hash;
        firstPickAt[stream] = firstPickAt[stream] || Date.now();
        var embeddedOnly = Date.now() - firstPickAt[stream] < (config.embeddedWaitMs || 0);
        for (var i = 0; i < priority.length; i++) {
            var parts = priority[i].split(':');
            if (parts[0] !== 'embedded' && embeddedOnly) continue;
            var pool = parts[0] === 'embedded' ? embedded || [] : extra || [];
            var pick = choose(pool, parts[1], native);
            if (pick) {
                console.info('[subs] auto-selected', priority[i], pick.lang, pick.label || '', pick.id);
                // Keep the last automatic choice for the diagnostics panel
                window.__stremioSubPick = { rule: priority[i], lang: pick.lang, label: pick.label || '', at: Date.now() };
                return parts[0] === 'embedded' ? { embedded: pick.id } : { extra: pick.id };
            }
        }
        return null;
    };

    function whenCoreReady(callback) {
        // The core bridge is created asynchronously by main.js
        if (window.core && typeof window.core.getState === 'function') return callback(window.core);
        setTimeout(function () { whenCoreReady(callback); }, 500);
    }

    whenCoreReady(function (core) {
        // Post-process player state on its way to the UI, chaining any earlier wrapper
        var original = core.getState;
        core.getState = function (model) {
            return original.apply(core, arguments).then(function (state) {
                return model === 'player' ? enhancePlayer(state) : state;
            });
        };
    });

    function onRouteChange() {
        // A new video starts without an automatic choice
        window.__stremioSubPick = null;
    }

    function toast(text) {
        // Short notice in the shared toast
        if (!window.__stremioToast) return;
        window.__stremioToast.show(text);
        clearTimeout(toast.timer);
        toast.timer = setTimeout(window.__stremioToast.hide, 2500);
    }

    function cycleChoices(state) {
        // Embedded tracks first (non-SDH, preferred languages first), then the external list, then off
        var native = window.__stremioNativeLang || null;
        var embedded = (state.subtitlesTracks || []).slice().sort(function (a, b) {
            return isSdh(a) - isSdh(b) || rank(a.lang, native) - rank(b.lang, native);
        }).map(function (t) { return { id: t.id, kind: 'embedded', label: (LABELS[baseLang(t.lang)] || t.lang) + ' · embutida' + (isSdh(t) ? ' (SDH)' : '') }; });
        var extra = (state.extraSubtitlesTracks || []).map(function (t) { return { id: t.id, kind: 'extra', label: t.label || t.lang }; });
        return embedded.concat(extra).concat([{ id: null, kind: 'off', label: 'desligada' }]);
    }

    function cycleSubtitles() {
        // Move to the next subtitle choice and say which one is on
        var video = window.__stremioPlayerVideo;
        if (!video || !video.state) return;
        var state = typeof video.state === 'function' ? video.state() : video.state;
        var choices = cycleChoices(state);
        var current = state.selectedSubtitlesTrackId || state.selectedExtraSubtitlesTrackId || null;
        var index = -1;
        choices.forEach(function (c, i) { if (index === -1 && c.id === current) index = i; });
        var next = choices[(index + 1) % choices.length];
        if (next.kind === 'embedded') video.selectSubtitlesTrack(next.id);
        else if (next.kind === 'extra') video.selectExtraSubtitlesTrack(next.id);
        else video.disableSubtitlesTracks();
        toast('Legenda: ' + next.label);
    }

    // The configured remote key cycles subtitles on the player
    window.addEventListener('keydown', function (e) {
        if (!config.enabled || e.keyCode !== config.cycleKey || (location.hash || '').indexOf('#/player') !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        cycleSubtitles();
    }, true);

    // The app router navigates with pushState and announces it as historyChange
    window.addEventListener('hashchange', onRouteChange);
    window.addEventListener('historyChange', onRouteChange);

    // The Netflix-like look is a stylesheet switch on the root element
    if (config.enabled && config.netflixStyle !== false) document.documentElement.classList.add('twk-netflix-subs');

    window.__stremioSubs = { enhancePlayer: enhancePlayer, baseLang: baseLang, scoreOf: scoreOf, cycle: cycleSubtitles, cache: extraCache };
})();
