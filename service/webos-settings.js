// Settings panel with an on/off switch for every tweak added on top of the original
// app, plus choice rows (OK cycles the values). Choices are saved on the TV
// (localStorage "twk.overrides"), applied over tweaks.json by index.html at start
// and shared with the service. Opens with a remote colour key; every change applies
// at once, without reloading the app, so a playing video keeps playing.
(function () {
    var config = (window.STREMIO_TWEAKS || {}).settings || {};
    var shared = window.__twkShared;
    var element = shared.element;
    var t = window.__twkI18n.t;
    var STORAGE_KEY = 'twk.overrides';
    var KEYS = { up: 38, down: 40, left: 37, right: 39, enter: 13, back: 461, escape: 27 };
    var QUALITY = ['best', '2160p', '1080p', '720p'];
    var DETAIL = ['essential', 'detailed', 'everything'];
    var WIDTHS = ['narrow', 'wide', 'full'];
    var POSITIONS = ['bottomLeft', 'topLeft', 'topRight', 'bottomRight'];
    var GROUPS = [
        { title: 'settings.netflix', column: 0, items: [
            ['netflix.enabled'],
            ['netflix.trailers'],
            ['netflix.trailerSound'],
            ['recommendations.ai']
        ] },
        { title: 'settings.simple', column: 0, items: [
            ['simple.enabled'],
            ['simple.quality', QUALITY, 'quality'],
            ['restart.enabled'],
            ['simple.directOpen'],
            ['simple.autoPlayEpisodes']
        ] },
        { title: 'settings.sources', column: 0, items: [
            ['ranking.enabled'],
            ['prewarm.enabled'],
            ['liveTest.enabled'],
            ['peerBoost.enabled'],
            ['readAhead.mergeSources'],
            ['sources.enabled']
        ] },
        { title: 'settings.doctor', column: 1, items: [
            ['doctor.enabled'],
            ['doctor.autoSwitch'],
            ['stallRetry.enabled'],
            ['hlsFallback.enabled'],
            ['doctor.prewarmNext'],
            ['doctor.prewarmOnLan'],
            ['doctor.convertFrozen']
        ] },
        { title: 'settings.subtitles', column: 1, items: [
            ['subtitles.enabled'],
            ['subtitles.autoPick'],
            ['subtitles.openSubtitles'],
            ['subtitles.avoidSdh'],
            ['subtitles.netflixStyle'],
            ['subtitles.autoSync'],
            ['subtitles.syncOnTv'],
            ['subtitles.convert'],
            ['subtitles.allowHttp']
        ] },
        { title: 'settings.network', column: 0, items: [
            ['readAhead.enabled'],
            ['answerCache.enabled'],
            ['servers.useLan'],
            ['doctor.startOnLanWhenHeavy'],
            ['devMode.keepAlive']
        ] },
        { title: 'settings.hints', column: 0, items: [
            ['sources.loadingHint'],
            ['restart.resumeHint'],
            ['hints.firstRunToast']
        ] },
        { title: 'settings.debug', column: 1, items: [
            ['debug.overlay'],
            ['debug.detail', DETAIL, 'detail'],
            ['debug.width', WIDTHS, 'width'],
            ['debug.position', POSITIONS, 'position'],
            ['debug.openLog', null, null, 'action']
        ] }
    ];
    var view = null;
    var rows = [];
    var groupTitles = [];
    var focus = 0;
    var open = false;
    var holdTimer = null;

    function readOverrides() {
        // Saved choices, empty when storage is unavailable
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (_e) { return {}; }
    }

    function current(key, options) {
        // Effective value: tweaks.json with the saved choices already applied by index.html
        var parts = key.split('.');
        var section = (window.STREMIO_TWEAKS || {})[parts[0]] || {};
        if (options) return options.indexOf(section[parts[1]]) !== -1 ? section[parts[1]] : options[0];
        return section[parts[1]] !== false;
    }

    function createPanel() {
        // Build the shared frame and the rows once from GROUPS, in two real columns so Up and Down follow what the viewer sees
        view = shared.frame('settings', 'twk-panel-grid twk-settings', hide);
        [0, 1].forEach(function (column) {
            var holder = view.root.appendChild(element('div'));
            GROUPS.filter(function (group) { return group.column === column; }).forEach(function (group) {
                var box = holder.appendChild(element('div', 'twk-section'));
                groupTitles.push({ node: box.appendChild(element('div', 'twk-section-title')), key: group.title });
                group.items.forEach(function (item) { addRow(box, item, column); });
            });
        });
    }

    function addRow(box, item, column) {
        // One row per setting: a switch, a choice cycled by OK, or an action
        var row = box.appendChild(element('div', 'twk-item twk-item-row twk-setting'));
        var entry = {
            key: item[0],
            row: row,
            label: row.appendChild(element('span', 'twk-item-label')),
            value: row.appendChild(element('span', 'twk-item-value')),
            options: item[1] || null,
            choices: item[2] || null,
            action: item[3] === 'action',
            column: column
        };
        entry.on = entry.action ? false : current(entry.key, entry.options);
        rows.push(entry);
        // The pointer focuses a row by hovering and switches it with a click
        var index = rows.length - 1;
        row.addEventListener('mouseenter', function () { focus = index; paint(); });
        row.addEventListener('click', function (e) { e.stopPropagation(); focus = index; toggleFocused(); });
    }

    function paint() {
        // Show each switch state in the current language and mark the focused row
        view.label(t('settings.title'), t('settings.keys'));
        groupTitles.forEach(function (entry) { entry.node.textContent = t(entry.key); });
        rows.forEach(function (entry, i) {
            entry.label.textContent = t('settings.' + entry.key);
            if (entry.action || entry.options) {
                entry.value.textContent = entry.action ? t('settings.open') : t('choice.' + entry.choices + '.' + entry.on);
                entry.value.className = 'twk-item-value twk-good';
            } else {
                entry.value.textContent = t(entry.on ? 'choice.on' : 'choice.off');
                entry.value.className = 'twk-item-value ' + (entry.on ? 'twk-good' : 'twk-bad');
            }
            entry.row.classList.toggle('twk-focus', i === focus);
        });
    }

    function otherColumn(column) {
        // Keep the same position inside the target column, clamped to its length
        var current = rows[focus];
        if (current.column === column) return focus;
        var from = rows.filter(function (r) { return r.column === current.column; }).indexOf(current);
        var target = rows.filter(function (r) { return r.column === column; });
        return rows.indexOf(target[Math.min(from, target.length - 1)]);
    }

    function toggleFocused() {
        // Flip the focused switch, or move a choice row to its next value, and save it on the TV
        var entry = rows[focus];
        if (entry.action) {
            if (!window.__twkLogView) return;
            if (window.__twkDebug && window.__twkDebug.action) window.__twkDebug.action('settings', 'action', 'Opened debug log viewer');
            window.__twkLogView.open();
            return;
        }
        set(entry.key, entry.options ? entry.options[(entry.options.indexOf(entry.on) + 1) % entry.options.length] : !entry.on);
    }

    function set(key, value) {
        // Save one choice on the TV, apply it at once and show it on its row
        var overrides = readOverrides();
        overrides[key] = value;
        var saved = true;
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides)); } catch (_e) { saved = false; }
        rows.forEach(function (entry) { if (entry.key === key) entry.on = value; });
        apply(key, value);
        if (view) paint();
        if (window.__twkDebug) {
            var shown = typeof value === 'boolean' ? (value ? 'enabled' : 'disabled') : value;
            var message = (saved ? 'Saved setting ' : 'Could not save setting ') + key;
            window.__twkDebug.action('settings', saved ? 'action' : 'warn', saved ? message + ' as ' + shown : message);
        }
    }

    function moveLog() {
        // Holding the settings key moves the on-screen log to the next corner, clockwise
        var debug = (window.STREMIO_TWEAKS || {}).debug || {};
        var next = POSITIONS[(Math.max(0, POSITIONS.indexOf(debug.position)) + 1) % POSITIONS.length];
        set('debug.position', next);
        shared.notify(t('settings.logMoved', { position: t('choice.position.' + next) }), 2000);
    }

    function apply(key, value) {
        // Every module reads its section of the live settings when it acts, so writing there applies the choice at once
        var parts = key.split('.');
        var tweaks = window.STREMIO_TWEAKS = window.STREMIO_TWEAKS || {};
        tweaks[parts[0]] = tweaks[parts[0]] || {};
        tweaks[parts[0]][parts[1]] = value;
        // The service keeps its own copy of the switches it uses
        if (window.__twkSendServiceOverrides) window.__twkSendServiceOverrides();
        // Modules with something already on screen redraw it for the new value
        window.dispatchEvent(new CustomEvent('twk-setting-changed', { detail: { key: key, value: value } }));
    }

    function show() {
        // Open the panel on top of any screen
        return window.__twkI18n.refresh().then(function () {
            if (!view) createPanel();
            open = true;
            paint();
            view.show();
        });
    }

    function hide() {
        // Close the panel; the choices already apply
        if (!open) return;
        open = false;
        view.hide();
    }

    function onKey(e) {
        // The colour key opens the panel; while open it owns the arrows, OK and Back
        var code = e.keyCode;
        if (!open) {
            if (code !== config.hotkey) return;
            e.preventDefault();
            e.stopPropagation();
            // A short press opens the panel when the key comes up; a hold moves the on-screen log instead
            if (e.type === 'keyup') {
                if (holdTimer) show();
                clearTimeout(holdTimer);
                holdTimer = null;
            } else if (!e.repeat && !holdTimer) {
                holdTimer = setTimeout(function () {
                    holdTimer = null;
                    if (((window.STREMIO_TWEAKS || {}).debug || {}).overlay) moveLog();
                    else show();
                }, config.holdMs || 600);
            }
            return;
        }
        if (e.type === 'keyup') return;
        if (window.__twkPanels.current() !== 'settings') return;
        if ([KEYS.up, KEYS.down, KEYS.left, KEYS.right, KEYS.enter, KEYS.back, KEYS.escape, config.hotkey].indexOf(code) === -1) return;
        e.preventDefault();
        e.stopPropagation();
        if (code === KEYS.up) focus = Math.max(0, focus - 1);
        else if (code === KEYS.down) focus = Math.min(rows.length - 1, focus + 1);
        else if (code === KEYS.left || code === KEYS.right) focus = otherColumn(code === KEYS.right ? 1 : 0);
        else if (code === KEYS.enter) return toggleFocused();
        else return hide();
        paint();
        rows[focus].row.scrollIntoView({ block: 'nearest' });
    }

    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);

    window.__stremioSettings = {
        toggle: function () { return open ? hide() : show(); }
    };
})();
