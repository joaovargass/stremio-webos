// Source picker for the player: lists the ranked streams of the playing title and
// switches to the chosen one. Opens from the player button or a remote colour key,
// also while the video is still loading, and loads the stream list itself when the
// player was opened straight from the library. Parameters come from STREMIO_TWEAKS.sources.
(function () {
    var config = (window.STREMIO_TWEAKS || {}).sources || {};
    var KEYS = { up: 38, down: 40, enter: 13, back: 461, escape: 27 };
    var panel = null;
    var list = null;
    var hint = null;
    var items = [];
    var focus = 0;
    var open = false;
    var loadingTimer = null;

    function element(tag, className, text) {
        // Small DOM helper for the picker
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
    }

    function onPlayer() {
        // The picker only makes sense on the player route
        return (location.hash || '').indexOf('#/player') === 0;
    }

    function routeIds() {
        // The player hash ends with type, meta id and video id
        var parts = (location.hash || '').split('/');
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

    function describe(stream) {
        // Two short lines per source: addon and quality, then the release details
        var name = String(stream.name || 'Fonte').replace(/\n/g, ' · ');
        var lines = String(stream.description || stream.title || '').split('\n').filter(function (l) { return l; });
        var badge = lines.filter(function (l) { return l.indexOf('⭐') === 0 || l.indexOf('⚠') === 0; })[0] || '';
        var details = lines.filter(function (l) { return l.indexOf('⭐') !== 0 && l.indexOf('⚠') !== 0; }).join(' ');
        // Cut by whole characters so a flag emoji is never split in half
        return { title: name + (badge ? '  ' + badge : ''), details: Array.from(details).slice(0, 140).join('') };
    }

    function createPanel() {
        // Build the picker frame once; rows are rebuilt on every open
        panel = element('div', 'twk-diag twk-sources');
        var header = panel.appendChild(element('div', 'twk-diag-header'));
        header.appendChild(element('div', 'twk-diag-title', 'Trocar fonte'));
        header.appendChild(element('div', 'twk-chip', '↑↓ OK'));
        list = panel.appendChild(element('div', 'twk-src-list'));
        document.body.appendChild(panel);
    }

    function render(current) {
        // Fill the rows, mark the playing source and move the focus to it
        list.textContent = '';
        if (!items.length) {
            list.appendChild(element('div', 'twk-src-empty', 'Nenhuma fonte encontrada para este título'));
            return;
        }
        items.forEach(function (stream, i) {
            var info = describe(stream);
            var row = list.appendChild(element('div', 'twk-src-row'));
            row.appendChild(element('div', 'twk-src-title', (stream === current ? '▶ ' : '') + info.title));
            row.appendChild(element('div', 'twk-src-details', info.details));
        });
        focus = Math.max(0, items.indexOf(current));
        moveFocus(0);
    }

    function moveFocus(delta) {
        // Highlight one row and keep it visible
        focus = Math.max(0, Math.min(items.length - 1, focus + delta));
        Array.prototype.forEach.call(list.children, function (row, i) {
            row.classList.toggle('twk-src-focus', i === focus);
            if (i === focus && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
        });
    }

    function show() {
        // Open the picker with a loading line, then the ranked sources
        if (!panel) createPanel();
        open = true;
        list.textContent = '';
        list.appendChild(element('div', 'twk-src-empty', 'Buscando fontes...'));
        requestAnimationFrame(function () { panel.classList.add('twk-visible'); });
        window.__twkPanels.opened('sources');
        Promise.all([ensureStreams(), window.__stremioDoctor ? window.__stremioDoctor.currentStream() : null]).then(function (results) {
            if (!open) return;
            items = results[0].slice(0, config.maxItems || 10);
            var current = items.filter(function (s) { return window.__stremioDoctor && window.__stremioDoctor.sameStream(s, results[1]); })[0] || null;
            render(current);
        });
    }

    function hide() {
        // Close the picker and give the keys back to the player
        open = false;
        if (panel) panel.classList.remove('twk-visible');
        window.__twkPanels.closed('sources');
    }

    function choose() {
        // Play the focused source through the doctor so every switch behaves the same
        var stream = items[focus];
        hide();
        if (stream && window.__stremioDoctor) window.__stremioDoctor.playStream(stream, 'Trocando para: ');
    }

    function onKey(e) {
        // While open the picker owns the arrows, OK and Back; the colour key toggles it on the player
        var code = e.keyCode;
        if (!open) {
            if (code === config.hotkey && onPlayer()) {
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
            hint = element('div', 'twk-hint', config.hintText || 'Demorando? Botão verde: trocar fonte');
            document.body.appendChild(hint);
        }
        hint.classList.toggle('twk-visible', visible);
    }

    function watchLoading() {
        // Offer the picker when the first frame does not arrive in time
        if (loadingTimer) clearTimeout(loadingTimer);
        showHint(false);
        if (!onPlayer()) return hide();
        if (config.loadingHint === false) return;
        loadingTimer = setTimeout(function () {
            var video = document.querySelector('video');
            if (onPlayer() && (!video || video.readyState < 2)) showHint(true);
        }, config.loadingHintAfterMs || 6000);
    }

    var restart = (window.STREMIO_TWEAKS || {}).restart || {};
    var resumeShown = {};

    function notice(text) {
        // Short notice in the shared toast
        if (!window.__stremioToast) return;
        window.__stremioToast.show(text);
        clearTimeout(notice.timer);
        notice.timer = setTimeout(window.__stremioToast.hide, 6000);
    }

    function clock(seconds) {
        // Format seconds as h:mm:ss or m:ss
        var s = Math.floor(seconds);
        var h = Math.floor(s / 3600);
        var m = Math.floor(s % 3600 / 60);
        return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
    }

    function restartFromStart() {
        // On the player jump to the start; on the title page clear the saved progress and play the best source from the start
        var hash = location.hash || '';
        if (hash.indexOf('#/player') === 0) {
            var video = document.querySelector('video');
            if (!video) return;
            video.currentTime = 0;
            notice('Recomeçando do início');
            return;
        }
        var best = (window.__stremioRankedStreams || [])[0];
        var metaId = decodeURIComponent(hash.split('/')[3] || '');
        if (hash.indexOf('#/detail') !== 0 || !best || !metaId || !window.core) return;
        notice('Recomeçando do início');
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
        if (video.currentTime > 30) notice('Retomando de ' + clock(video.currentTime) + ' · botão azul: recomeçar');
    }

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

    window.__twkPanels.add('sources', hide);
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
