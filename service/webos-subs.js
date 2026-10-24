// Centralized subtitles: cleans the addon results, adds OpenSubtitles v3 matches
// found by video hash, file size and file name, orders tracks by language
// preference and picks one automatically (the Stremio profile subtitle languages
// first, then the configured priority: embedded, Brazilian Portuguese, the
// language being heard). Parameters come from window.STREMIO_TWEAKS.subtitles.
(function () {
    var config = (window.STREMIO_TWEAKS || {}).subtitles || {};
    var simple = (window.STREMIO_TWEAKS || {}).simple || {};
    var shared = window.__twkShared;
    var t = window.__twkI18n.t;
    var NOTICE_MS = 2500;
    var KEPT_LOOKUPS = 10;
    var LANG_GROUPS = {
        'pt-br': ['pob', 'pt-br', 'pt_br', 'ptbr', 'pb', 'brazilian', 'portuguese (brazil)', 'português (brasil)'],
        pt: ['por', 'pt', 'pt-pt', 'portuguese', 'português']
    };
    var RELEASE_TAGS = ['web', 'webdl', 'webrip', 'bluray', 'brrip', 'bdrip', 'hdtv', 'dvdrip', 'remux', '720p', '1080p', '2160p', 'amzn', 'nf', 'dsnp', 'hmax', 'atvp', 'hulu', 'ip'];
    var extraCache = {};
    var pending = {};
    var firstPickAt = {};
    var lastAudio = [];
    var syncScores = {};
    var external = { key: null, langs: [] };
    var ordered = { key: null, signature: null, subtitles: [] };
    var profile = { audio: null, subs: [], autoSelect: true };

    function baseLang(lang) {
        // Reduce any language tag to "pt-br", "pt" or a two-letter code
        var value = String(lang || '').toLowerCase().trim();
        if (LANG_GROUPS['pt-br'].indexOf(value) !== -1) return 'pt-br';
        if (LANG_GROUPS.pt.indexOf(value) !== -1) return 'pt';
        return shared.languageCode(value);
    }

    function isError(track) {
        // Addons sometimes publish their own failures as fake subtitle tracks
        return /^!|error/i.test(track.lang || '') || /error-subtitle/i.test(track.url || '');
    }

    function isSdh(track) {
        // Hearing-impaired tracks carry sound descriptions the viewer rarely wants
        return /\bsdh\b|\bcc\b|hearing/i.test((track.label || '') + ' ' + (track.lang || ''));
    }

    function isForced(track) {
        // Forced tracks only translate the few lines spoken in another language
        return /forced|forçad/i.test((track.label || '') + ' ' + (track.lang || ''));
    }

    function nativeLang(audioTracks) {
        // The language that will be heard: the Stremio audio language when the file has it, else the first track
        var langs = (audioTracks || []).filter(function (track) { return track && track.lang; }).map(function (track) { return baseLang(track.lang); });
        if (profile.audio && langs.indexOf(profile.audio) !== -1) return profile.audio;
        return langs[0] || null;
    }

    function loadProfile(core) {
        // Language choices of the Stremio profile come first in every subtitle decision
        core.getState('ctx').then(function (ctx) {
            var settings = (ctx && ctx.profile && ctx.profile.settings) || {};
            profile = {
                audio: settings.audioLanguage ? baseLang(settings.audioLanguage) : null,
                subs: [settings.subtitlesLanguage, settings.secondarySubtitlesLanguage].filter(Boolean).map(baseLang),
                autoSelect: settings.subtitlesAutoSelect !== false
            };
        }).catch(function () {});
    }

    function rank(lang, native) {
        // Lower is better: the Stremio subtitle languages, then pt-BR, pt, original language, then everything else
        var base = baseLang(lang);
        var chosen = profile.subs.indexOf(base);
        if (chosen !== -1) return chosen - profile.subs.length;
        if (base === 'pt-br') return 0;
        if (base === 'pt') return 1;
        if (native && base === native) return 2;
        return 3;
    }

    function languageName(lang) {
        // A language name in the viewer's language, the raw code when the dictionary has none
        var base = baseLang(lang);
        var key = 'subtitle.name.' + (base === 'pt-br' ? 'ptBR' : base);
        var name = t(key);
        return name === key ? lang : name;
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
        var common = RELEASE_TAGS.filter(function (tag) { return video.indexOf(tag) !== -1 && subtitle.indexOf(tag) !== -1; }).length;
        score += Math.min(20, common * 5);
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
        var name = languageName(track.lang);
        var synced = track.m === 'h' ? ' · ' + t('subtitle.label.synced') : '';
        return Object.assign({}, track, { label: name + ' · ' + (track.origin || t('subtitle.origin.addon')) + synced });
    }

    function throughConverter(track) {
        // Every external subtitle is read by the TV converter, which also serves videos that play without the streaming server
        if (config.convert === false || /\/subtitles\.vtt\?/.test(track.url)) return track;
        return Object.assign({}, track, { url: location.origin + '/subtitles.vtt?from=' + encodeURIComponent(track.url) });
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
        var fetchJson = shared.fetchJson;
        // The hash needs file data, which a cold torrent may not have for minutes; past the limit the filename alone is used
        var hashPromise = media ? fetchJson(server + '/opensubHash?videoUrl=' + encodeURIComponent(media), config.lookupTimeoutMs) : Promise.resolve(null);
        hashPromise.then(function (hash) {
            var extras = [];
            if (hash && hash.result) {
                extras.push('videoHash=' + hash.result.hash);
                extras.push('videoSize=' + hash.result.size);
            }
            if (hints.filename) extras.push('filename=' + encodeURIComponent(hints.filename));
            var target = config.openSubtitlesUrl.replace(/\/$/, '') + '/subtitles/' + path.type + '/' + encodeURIComponent(path.id) +
                (extras.length ? '/' + extras.join('&') : '') + '.json';
            return fetchJson(target, config.lookupTimeoutMs);
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
        if (key !== ordered.key) forgetVideo(key);
        var native = window.__stremioNativeLang || null;
        // The player reads its state many times a second; the same tracks in the same context reuse the last order
        var stream = (state.selected && state.selected.stream) || {};
        var signature = [key, (stream.behaviorHints || {}).filename, simple.enabled, native, profile.subs.join(','), t('subtitle.label.synced'), extraCache[key] ? extraCache[key].length : 'pending', state.subtitles.map(function (track) { return track && track.url; }).join(',')].join('|');
        if (signature !== ordered.signature) ordered = { key: key, signature: signature, subtitles: orderTracks(state, key, native) };
        var selected = state.selected;
        // Subtitles that come with the stream itself go through the converter as well
        if (selected && selected.stream && Array.isArray(selected.stream.subtitles)) {
            selected = Object.assign({}, selected, { stream: Object.assign({}, selected.stream, { subtitles: selected.stream.subtitles.map(throughConverter) }) });
        }
        return Object.assign({}, state, { selected: selected, subtitles: ordered.subtitles });
    }

    function orderTracks(state, key, native) {
        // Merge the addon and OpenSubtitles tracks, drop errors and duplicates, and order them by language then sync likelihood
        var seen = {};
        var merged = state.subtitles.concat(extraCache[key] || []).filter(function (track) {
            if (!track || !track.url || isError(track) || seen[track.url]) return false;
            seen[track.url] = true;
            return true;
        });
        // Languages addons and OpenSubtitles offer for this video, once the OpenSubtitles lookup has answered
        if (extraCache[key]) external = { key: key, langs: merged.map(function (track) { return baseLang(track.lang); }) };
        var hints = (state.selected && state.selected.stream && state.selected.stream.behaviorHints) || {};
        merged.forEach(function (track, i) {
            track.__order = i;
            syncScores[track.id] = syncScores[track.url] = syncScore(track, hints.filename);
        });
        // Language first, then sync likelihood; the index keeps the sort stable on the TV engine
        merged.sort(function (a, b) {
            return rank(a.lang, native) - rank(b.lang, native) || scoreOf(b) - scoreOf(a) || a.__order - b.__order;
        });
        return (simple.enabled ? bestPerLanguage(merged) : merged).map(prettify).map(throughConverter);
    }

    function forgetVideo(key) {
        // A new video starts with fresh scores; lookups of the last few videos stay for a quick return to them
        syncScores = {};
        var keys = Object.keys(extraCache).filter(function (other) { return other !== key; });
        keys.slice(0, Math.max(0, keys.length - KEPT_LOOKUPS)).forEach(function (old) {
            delete extraCache[old];
            delete pending[old];
        });
    }

    function onlyInFile(videoId) {
        // Subtitle languages of the profile no addon offers for this video (all of them until the lookups answered), null when the profile wants none
        if (!config.enabled || !profile.autoSelect || !profile.subs.length) return null;
        var known = external.key && external.key.split('/').pop() === videoId ? external.langs : [];
        var missing = profile.subs.filter(function (lang) { return known.indexOf(lang) === -1; });
        return missing.length === profile.subs.length ? missing : null;
    }

    function textLanguages(tracks) {
        // Languages of the subtitle tracks in a streaming server track list
        return (tracks || []).filter(function (track) { return track.type === 'text' && track.lang; }).map(function (track) { return baseLang(track.lang); });
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
        // Plain Portuguese also accepts the Brazilian variant; Brazilian Portuguese stays exact
        var target = baseLang(wanted);
        return base === target || (target === 'pt' && base === 'pt-br');
    }

    function choose(tracks, wanted, native) {
        // Prefer non-SDH tracks, then the ones most likely timed for this release
        var hits = tracks.filter(function (track) { return matches(track, wanted, native); });
        hits.forEach(function (track, i) { track.__pickOrder = i; });
        hits.sort(function (a, b) {
            return isForced(a) - isForced(b) || (config.avoidSdh ? isSdh(a) - isSdh(b) : 0) || scoreOf(b) - scoreOf(a) || a.__pickOrder - b.__pickOrder;
        });
        return hits[0] || null;
    }

    window.__stremioPickSubtitles = function (embedded, extra, audioTracks) {
        // Walk the configured priority list and return the first available track
        if (!config.enabled || !config.autoPick || !profile.autoSelect) return null;
        var native = nativeLang(audioTracks);
        window.__stremioNativeLang = native;
        lastAudio = audioTracks || lastAudio;
        // The subtitle languages set in Stremio first (embedded, then external), then the configured order
        var priority = profile.subs.reduce(function (list, lang) { return list.concat(['embedded:' + lang, 'external:' + lang]); }, []).concat(config.priority || []);
        // Embedded tracks arrive late; external ones may only win once the wait window is over
        var stream = location.hash;
        if (!firstPickAt[stream]) {
            firstPickAt[stream] = Date.now();
            pickLate(stream);
        }
        var embeddedOnly = Date.now() - firstPickAt[stream] < (config.embeddedWaitMs || 0);
        for (var i = 0; i < priority.length; i++) {
            var parts = priority[i].split(':');
            if (parts[0] !== 'embedded' && embeddedOnly) continue;
            var pool = parts[0] === 'embedded' ? embedded || [] : extra || [];
            var pick = choose(pool, parts[1], native);
            if (pick) {
                console.info('[subs] auto-selected', priority[i], pick.lang, pick.id);
                // Keep the last automatic choice for the diagnostics panel
                window.__stremioSubPick = { rule: priority[i], lang: pick.lang, label: pick.label || '', at: Date.now() };
                return parts[0] === 'embedded' ? { embedded: pick.id } : { extra: pick.id };
            }
        }
        return null;
    };

    function pickLate(stream) {
        // The player asks again only when its track lists change, so an external track gets its turn when the embedded wait ends
        setTimeout(function () {
            if (location.hash !== stream || window.__stremioSubPick || !window.__stremioPlayerVideo || !window.core) return;
            window.core.getState('player').then(function (state) {
                // A choice the viewer saved for this stream is never overridden
                if (!state || (state.streamState && state.streamState.subtitleTrack) || location.hash !== stream || window.__stremioSubPick) return;
                var pick = window.__stremioPickSubtitles([], state.subtitles || [], lastAudio);
                if (pick && pick.extra) window.__stremioPlayerVideo.selectExtraSubtitlesTrack(pick.extra);
            }).catch(function () {});
        }, (config.embeddedWaitMs || 0) + 500);
    }

    shared.whenCoreReady(function (core) {
        window.__twkI18n.refresh().then(function () {
            loadProfile(core);
            window.addEventListener('historyChange', function () { loadProfile(core); });
            // Post-process player state on its way to the UI, chaining any earlier wrapper
            var original = core.getState;
            core.getState = function (model) {
                return original.apply(core, arguments).then(function (state) {
                    return model === 'player' ? enhancePlayer(state) : state;
                });
            };
        });
    });

    function onRouteChange() {
        // A new video starts without an automatic choice
        window.__stremioSubPick = null;
    }

    function cycleChoices(state) {
        // Embedded tracks first (non-SDH, preferred languages first), then the external list, then off
        var native = window.__stremioNativeLang || null;
        var embedded = (state.subtitlesTracks || []).slice().sort(function (a, b) {
            return isForced(a) - isForced(b) || isSdh(a) - isSdh(b) || rank(a.lang, native) - rank(b.lang, native);
        }).map(function (track) {
            return { id: track.id, kind: 'embedded', label: languageName(track.lang) + ' · ' + t('subtitle.label.embedded') + (isSdh(track) ? t('subtitle.label.sdh') : '') };
        });
        // The player lists addon and OpenSubtitles copies side by side; simple mode keeps one external track per language
        var langs = {};
        var extra = (state.extraSubtitlesTracks || []).filter(function (track) {
            var lang = baseLang(track.lang);
            if (simple.enabled && langs[lang]) return false;
            langs[lang] = true;
            return true;
        }).map(function (track) {
            return { id: track.id, kind: 'extra', label: languageName(track.lang) + ' · ' + t('subtitle.label.external') };
        });
        return embedded.concat(extra).concat([{ id: null, kind: 'off', label: t('subtitle.off') }]);
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
        shared.notify(t('subtitle.toast', { label: next.label }), NOTICE_MS);
    }

    // The configured remote key cycles subtitles on the player
    window.addEventListener('keydown', function (e) {
        if (!config.enabled || e.keyCode !== config.cycleKey || !shared.onPlayer()) return;
        e.preventDefault();
        e.stopPropagation();
        cycleSubtitles();
    }, true);

    // The app router navigates with pushState and announces it as historyChange
    window.addEventListener('hashchange', onRouteChange);
    window.addEventListener('historyChange', onRouteChange);

    function applyStyle() {
        // The Netflix-like look is a stylesheet switch on the root element, flipped again whenever its settings change
        document.documentElement.classList.toggle('twk-netflix-subs', !!config.enabled && config.netflixStyle !== false);
    }

    applyStyle();
    window.addEventListener('twk-setting-changed', function (e) {
        if (/^subtitles\.(enabled|netflixStyle)$/.test(e.detail.key)) applyStyle();
    });

    window.__stremioSubs = { enhancePlayer: enhancePlayer, baseLang: baseLang, scoreOf: scoreOf, cycle: cycleSubtitles, cache: extraCache, onlyInFile: onlyInFile, textLanguages: textLanguages };
})();
