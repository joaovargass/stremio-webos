// Source picker for the player: lists the ranked streams of the playing title and
// switches to the chosen one. Opens from the player button or a remote colour key,
// also while the video is still loading, and loads the stream list itself when the
// player was opened straight from the library. Parameters come from STREMIO_TWEAKS.sources.
(function () {
    var config = (window.STREMIO_TWEAKS || {}).sources || {};
    var shared = window.__twkShared;
    var element = shared.element;
    var onPlayer = shared.onPlayer;
    var t = window.__twkI18n.t;
    var KEYS = { up: 38, down: 40, enter: 13, back: 461, escape: 27 };
    var NOTICE_MS = 6000;
    var view = null;
    var list = null;
    var hint = null;
    var items = [];
    var playing = null;
    var focus = 0;
    var open = false;
    var loadingTimer = null;
    var liveTimer = null;
    var REFRESH = { refresh: true };

    function onTitle() {
        // A title page lists its sources too: a movie, or an episode chosen in a series
        return /^#\/detail\/[^/]+\/[^/]+/.test(location.hash || '');
    }

    function routeIds() {
        // The player hash ends with type, meta id and video id; a title page has type and meta id, and the video id for an episode
        var parts = (location.hash || '').split('/');
        if (parts[1] === 'detail' && parts.length >= 4) {
            return { type: decodeURIComponent(parts[2]), metaId: decodeURIComponent(parts[3]), videoId: decodeURIComponent(parts[4] || parts[3]) };
        }
        if (parts.length < 4) return null;
        return {
            type: decodeURIComponent(parts[parts.length - 3]),
            metaId: decodeURIComponent(parts[parts.length - 2]),
            videoId: decodeURIComponent(parts[parts.length - 1])
        };
    }

    function ensureStreams() {
        // Ask the core for the title's streams when the ranked list is missing or belongs to another video
        var ids = routeIds();
        if (!window.core || !ids) return Promise.resolve(window.__stremioRankedStreams || []);
        if (window.__stremioRankedFor === ids.videoId && (window.__stremioRankedStreams || []).length) {
            return Promise.resolve(window.__stremioRankedStreams);
        }
        var args = {
            metaPath: { resource: 'meta', id: ids.metaId, type: ids.type, extra: [] },
            streamPath: { resource: 'stream', type: ids.type, id: ids.videoId, extra: [] },
            guessStream: false
        };
        return Promise.resolve(window.core.dispatch({ action: 'Load', args: { model: 'MetaDetails', args: args } }, 'meta_details')).then(function () {
            return waitForStreams(ids.videoId, Date.now());
        });
    }

    function waitForStreams(videoId, started) {
        // Poll the ranked state until the addons answered or the wait runs out
        return window.core.getState('meta_details').then(function () {
            var ready = (window.__stremioRankedStreams || []).length && window.__stremioRankedFor === videoId;
            if (ready || Date.now() - started > (config.loadWaitMs || 8000)) {
                if (!ready) window.__stremioRankedStreams = window.__stremioRankedStreams || [];
                return window.__stremioRankedStreams;
            }
            return new Promise(function (resolve) { setTimeout(resolve, 500); }).then(function () { return waitForStreams(videoId, started); });
        });
    }

    function streamKey(stream) {
        // Sources compare by torrent file or address: every new ranking builds new objects for the same sources
        return stream.infoHash ? stream.infoHash.toLowerCase() + '/' + (stream.fileIdx || 0) : stream.url;
    }

    function describe(stream) {
        // Two short lines per source: addon and quality, then the release details
        var name = String(stream.name || t('doctor.nextSource')).replace(/\n/g, ' · ');
        var lines = String(stream.description || stream.title || '').split('\n').filter(function (l) { return l; });
        var badge = lines.filter(function (l) { return l.indexOf('⭐') === 0 || l.indexOf('⚠') === 0; })[0] || '';
        var details = lines.filter(function (l) { return l.indexOf('⭐') !== 0 && l.indexOf('⚠') !== 0; }).join(' ');
        // What the background test measured comes first, since it says whether the source works now
        var tested = window.__stremioTweaks && window.__stremioTweaks.liveLabel ? window.__stremioTweaks.liveLabel(stream) : '';
        // Cut by whole characters so a flag emoji is never split in half
        return { title: name + (badge ? '  ' + badge : ''), details: Array.from((tested ? tested + ' · ' : '') + details).slice(0, 140).join('') };
    }

    function createPanel() {
        // Build the picker on the shared frame once; rows are rebuilt on every open
        view = shared.frame('sources', 'twk-sources', hide);
        list = view.root.appendChild(element('div', 'twk-sources-list'));
    }

    function render(current) {
        // Fill the rows, mark the playing source and move the focus to it
        list.textContent = '';
        if (!items.length) {
            list.appendChild(element('div', 'twk-empty', t('sources.none')));
            return;
        }
        items.forEach(function (stream, i) {
            var row = list.appendChild(element('div', 'twk-item'));
            // The pointer focuses a row by hovering and plays it with a click
            row.addEventListener('mouseenter', function () { focus = i; moveFocus(0); });
            row.addEventListener('click', function (e) { e.stopPropagation(); focus = i; choose(); });
            if (stream === REFRESH) {
                row.appendChild(element('div', 'twk-item-title', t('sources.refresh')));
                row.appendChild(element('div', 'twk-item-details', t('sources.refreshDetails')));
                return;
            }
            var info = describe(stream);
            row.appendChild(element('div', 'twk-item-title', (stream === current ? '▶ ' : '') + info.title));
            row.appendChild(element('div', 'twk-item-details', info.details));
        });
        focus = Math.max(0, items.indexOf(current));
        moveFocus(0);
    }

    function moveFocus(delta) {
        // Highlight one row and keep it visible
        focus = Math.max(0, Math.min(items.length - 1, focus + delta));
        Array.prototype.forEach.call(list.children, function (row, i) {
            row.classList.toggle('twk-focus', i === focus);
            if (i === focus && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
        });
    }

    function show() {
        // Open the picker with a loading line, then the ranked sources
        open = true;
        return window.__twkI18n.refresh().then(function () {
            if (!open) return;
            if (!view) createPanel();
            view.label(t('sources.title'), t('sources.keys'));
            list.textContent = '';
            list.appendChild(element('div', 'twk-empty', t('sources.loading')));
            view.show();
            return Promise.all([ensureStreams(), window.__stremioDoctor && onPlayer() ? window.__stremioDoctor.currentStream() : null]).then(function (results) {
                if (!open) return;
                playing = results[1];
                fill(null);
                // The background test keeps measuring: its numbers update in place while the order and the focus stay put
                liveTimer = setInterval(refreshDetails, 2000);
            });
        });
    }

    function fill(keep) {
        // Rows in the current ranked order, the refresh row first; focus stays on the same source when the order changes
        var streams = (window.__stremioRankedStreams || []).slice(0, config.maxItems || 10);
        items = streams.length ? [REFRESH].concat(streams) : [];
        var current = items.filter(function (s) { return s !== REFRESH && window.__stremioDoctor && window.__stremioDoctor.sameStream(s, playing); })[0] || null;
        var keepIndex = keep === REFRESH ? 0 : keep ? items.map(function (s) { return s === REFRESH ? null : streamKey(s); }).indexOf(streamKey(keep)) : -1;
        render(current);
        if (keepIndex !== -1) {
            focus = keepIndex;
            moveFocus(0);
        } else if (!current && items.length > 1) {
            focus = 1;
            moveFocus(0);
        }
    }

    function refreshDetails() {
        // Rewrite only the measured line of a row whose text changed, so the rows and the focus stay as they are
        var latest = {};
        (window.__stremioRankedStreams || []).forEach(function (s) { latest[streamKey(s)] = s; });
        items.forEach(function (stream, i) {
            var row = list.children[i];
            if (stream === REFRESH || !row) return;
            var details = describe(latest[streamKey(stream)] || stream).details;
            if (row.lastChild.textContent !== details) row.lastChild.textContent = details;
        });
    }

    function hide() {
        // Close the picker and give the keys back to the player
        open = false;
        if (liveTimer) clearInterval(liveTimer);
        liveTimer = null;
        if (view) view.hide();
    }

    function choose() {
        // Play the focused source: on the player through the doctor so every switch behaves the same, on a title page as a new entry so Back returns to it
        var stream = items[focus];
        if (stream === REFRESH) {
            if (window.__stremioTweaks && window.__stremioTweaks.retest) window.__stremioTweaks.retest();
            notice(t('sources.retrying'));
            // Refresh is the one moment the order may change; the focus stays on the refresh row
            fill(REFRESH);
            return;
        }
        hide();
        if (!stream) return;
        if (onPlayer() && window.__stremioDoctor) return window.__stremioDoctor.playStream(stream, t('doctor.switch'));
        if (stream.deepLinks && stream.deepLinks.player && window.__stremioHistory) window.__stremioHistory.navigate(stream.deepLinks.player.replace(/^#/, ''));
    }

    function onKey(e) {
        // While open the picker owns the arrows, OK and Back; the colour key toggles it on the player
        var code = e.keyCode;
        if (!open) {
            if (code === config.hotkey && (onPlayer() || onTitle())) {
                e.preventDefault();
                e.stopPropagation();
                show();
            }
            return;
        }
        if ([KEYS.up, KEYS.down, KEYS.enter, KEYS.back, KEYS.escape, config.hotkey].indexOf(code) === -1) return;
        e.preventDefault();
        e.stopPropagation();
        if (code === KEYS.up) moveFocus(-1);
        else if (code === KEYS.down) moveFocus(1);
        else if (code === KEYS.enter) choose();
        else hide();
    }

    function showHint(visible) {
        // Small reminder shown while a video takes long to start
        if (!hint) {
            hint = element('div', 'twk-hint', t('sources.loadingHint'));
            document.body.appendChild(hint);
        }
        hint.classList.toggle('twk-visible', visible);
    }

    function watchLoading() {
        // Offer the picker when the first frame does not arrive in time
        if (loadingTimer) clearTimeout(loadingTimer);
        showHint(false);
        // Any route change closes the picker; it belongs to the screen it was opened on
        hide();
        if (!onPlayer()) return;
        if (config.loadingHint === false) return;
        loadingTimer = setTimeout(function () {
            var video = document.querySelector('video');
            if (onPlayer() && (!video || video.readyState < 2)) showHint(true);
        }, config.loadingHintAfterMs || 6000);
    }

    var restart = (window.STREMIO_TWEAKS || {}).restart || {};
    var resumeShown = {};

    function notice(text) {
        // Notices of the picker, restart and title hints stay long enough to read the key they mention
        shared.notify(text, NOTICE_MS);
    }

    function restartFromStart() {
        // On the player jump to the start; on the title page clear the saved progress and play the best source from the start
        var hash = location.hash || '';
        if (hash.indexOf('#/player') === 0) {
            var video = document.querySelector('video');
            if (!video) return;
            video.currentTime = 0;
            // The saved progress must start over too, or the next reload or source switch jumps back to it
            var parts = hash.split('/');
            var playerMeta = decodeURIComponent(parts[parts.length - 2] || '');
            if (playerMeta && window.core) Promise.resolve(window.core.dispatch({ action: 'Ctx', args: { action: 'RewindLibraryItem', args: playerMeta } }, 'ctx')).catch(function () {});
            notice(t('restart.startingOver'));
            return;
        }
        var best = (window.__stremioRankedStreams || [])[0];
        var metaId = decodeURIComponent(hash.split('/')[3] || '');
        if (hash.indexOf('#/detail') !== 0 || !best || !metaId || !window.core) return;
        notice(t('restart.startingOver'));
        Promise.resolve(window.core.dispatch({ action: 'Ctx', args: { action: 'RewindLibraryItem', args: metaId } }, 'ctx')).catch(function () {}).then(function () {
            if (window.__stremioDoctor) window.__stremioDoctor.navigate(best.deepLinks.player.replace(/^#/, ''));
        });
    }

    function onResume(e) {
        // A video that resumes far from its start tells once how to start over
        var video = e.target;
        if (!(video instanceof HTMLMediaElement) || !onPlayer() || restart.resumeHint === false) return;
        var key = video.getAttribute('src');
        if (resumeShown[key]) return;
        resumeShown[key] = true;
        if (video.currentTime > 30) notice(t('restart.resumeHint', { position: shared.duration(video.currentTime) }));
    }

    var simple = (window.STREMIO_TWEAKS || {}).simple || {};
    var press = { down: false, at: 0, held: 0 };
    var HOLD_MS = simple.holdMs || 500;

    function cardPress(onShort) {
        // A short OK opens the title at once; an OK held for HOLD_MS keeps the card menu open
        if (simple.directOpen === false) return;
        if (!press.down) {
            if (press.held < HOLD_MS) openTitle(onShort);
            return;
        }
        var watch = setInterval(function () {
            if (press.down && Date.now() - press.at < HOLD_MS) return;
            clearInterval(watch);
            if (!press.down) openTitle(onShort);
        }, 30);
    }

    function openTitle(navigateTo) {
        // Navigate to the title and say once how to reach the card options
        navigateTo();
        try {
            if (localStorage.getItem('twk.hint.cards')) return;
            localStorage.setItem('twk.hint.cards', '1');
        } catch (_e) {
            return;
        }
        setTimeout(function () { notice(t('restart.cardHint')); }, 1200);
    }

    function trackOk(e) {
        // Measure how long OK stays down, so a card can tell a press from a hold
        if (e.keyCode !== KEYS.enter) return;
        // A keyup lost to a reload must not block OK: a press older than 10 s counts as released
        if (e.type === 'keydown' && press.down && Date.now() - press.at < 10000) {
            // A held OK repeats keydown; only the first press counts, or the repeats would activate the menu it opened
            e.preventDefault();
            e.stopImmediatePropagation();
        } else if (e.type === 'keydown') {
            press.down = true;
            press.at = Date.now();
        } else if (e.type === 'keyup') {
            press.down = false;
            press.held = Date.now() - press.at;
        }
    }

    function autoPlayEpisode() {
        // An episode chosen in the episode list plays its best source at once; Back then returns to the episode list
        if (!simple.enabled || simple.autoPlayEpisodes === false || !window.__stremioHistory) return;
        var entries = window.__stremioHistory.entries();
        var current = entries[entries.length - 1] || '';
        var previous = entries[entries.length - 2] || '';
        var match = /^#\/detail\/series\/([^/?]+)\/([^/?]+)/.exec(current);
        if (!match || previous.split('?')[0] !== '#/detail/series/' + match[1]) return;
        var videoId = decodeURIComponent(match[2]);
        var started = Date.now();
        var wait = setInterval(function () {
            // The ranked list of this episode arrives once the addons answered
            if (location.hash !== current && location.hash.split('?')[0] !== current.split('?')[0]) return clearInterval(wait);
            var best = window.__stremioRankedFor === videoId ? (window.__stremioRankedStreams || [])[0] : null;
            if (!best && Date.now() - started < (simple.autoPlayWaitMs || 15000)) return;
            clearInterval(wait);
            if (!best) return;
            var short = window.__stremioTweaks && window.__stremioTweaks.summary ? window.__stremioTweaks.summary(best) : '';
            notice(t('simple.playingBest', { summary: short || t('doctor.nextSource') }));
            if (window.__stremioDoctor) window.__stremioDoctor.navigate(best.deepLinks.player.replace(/^#/, ''), true);
        }, 300);
    }

    window.__twkCardPress = cardPress;
    window.addEventListener('keydown', trackOk, true);
    window.addEventListener('keyup', trackOk, true);
    window.addEventListener('historyChange', autoPlayEpisode);

    if (restart.enabled !== false) {
        window.addEventListener('keydown', function (e) {
            if (e.keyCode !== restart.hotkey || open) return;
            e.preventDefault();
            e.stopPropagation();
            restartFromStart();
        }, true);
        document.addEventListener('playing', onResume, true);
    }

    if (!config.enabled) {
        window.__stremioSources = { toggle: function () { if (window.__stremioDoctor) window.__stremioDoctor.nextSource('manual', false); }, hint: function () {} };
        return;
    }

    window.addEventListener('keydown', onKey, true);
    // The app router navigates with pushState and announces it as historyChange
    window.addEventListener('hashchange', watchLoading);
    window.addEventListener('historyChange', watchLoading);
    document.addEventListener('playing', function () { showHint(false); }, true);

    window.__stremioSources = {
        toggle: function () { return open ? hide() : show(); },
        ensure: ensureStreams,
        hint: function (visible) { if (config.loadingHint !== false) showHint(visible); }
    };
})();
