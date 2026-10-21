// Full-screen reader for the bounded, sanitized debug log ring.
(function () {
    var RING_LIMIT = 300;
    var RANK = { error: 0, warn: 0, action: 0, info: 1, verbose: 2 };
    var LABEL = { error: 'ERROR', warn: 'WARN', action: 'ACTION', info: 'INFO', verbose: 'MORE' };
    var KEYS = { left: 37, up: 38, right: 39, down: 40, enter: 13 };
    var PASS_KEYS = [461, 27, 8];
    var panel;
    var titleNode;
    var closeButton;
    var list;
    var scroll;
    var counter;
    var level;
    var followButton;
    var rendered = [];
    var renderedDetail = null;
    var follow = true;
    var focusedControl = 0;
    var open = false;
    var opening = false;
    var updatePending = false;

    function t(key, params) {
        // Texts follow the Stremio interface language through the shared dictionary
        return window.__twkI18n && window.__twkI18n.t ? window.__twkI18n.t(key, params) : key;
    }

    function currentLevel() {
        // The detail setting decides which retained lines the reader lists
        var debug = (window.STREMIO_TWEAKS || {}).debug || {};
        return debug.detail === 'essential' || debug.detail === 'everything' ? debug.detail : 'detailed';
    }

    function lines() {
        // Every line the debug module retained, whatever the overlay shows
        var debug = window.__twkDebug;
        return debug && Array.isArray(debug.lines) ? debug.lines : [];
    }

    function clock(at) {
        // Local time with seconds, the same format as the corner log
        var date = new Date(at);
        return [date.getHours(), date.getMinutes(), date.getSeconds()].map(function (part) {
            return String(part).padStart(2, '0');
        }).join(':');
    }

    function make(tag, className, text) {
        // Small DOM helper for the reader
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function build() {
        // Create the panel once: title, detail chip, follow and close buttons, counter and the scrolling list
        if (panel || !document.body) return;
        panel = make('section', 'twk-diag twk-logview');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', t('logview.title'));
        panel.hidden = true;

        var header = make('header', 'twk-diag-header twk-logview-header');
        titleNode = make('div', 'twk-diag-title', t('logview.title'));
        header.appendChild(titleNode);
        level = make('span', 'twk-chip twk-logview-level');
        header.appendChild(level);

        var controls = make('div', 'twk-logview-controls');
        followButton = make('button', 'twk-logview-follow');
        followButton.type = 'button';
        followButton.addEventListener('click', toggleFollow);
        followButton.addEventListener('mouseenter', function () { focusControl(0); });
        controls.appendChild(followButton);
        closeButton = make('button', 'twk-close twk-logview-close', '×');
        closeButton.type = 'button';
        closeButton.addEventListener('click', close);
        closeButton.addEventListener('mouseenter', function () { focusControl(1); });
        controls.appendChild(closeButton);
        header.appendChild(controls);
        panel.appendChild(header);

        counter = make('div', 'twk-logview-counter');
        panel.appendChild(counter);
        scroll = make('div', 'twk-logview-scroll');
        scroll.tabIndex = 0;
        scroll.setAttribute('aria-label', t('logview.entries'));
        list = make('div', 'twk-logview-list');
        scroll.appendChild(list);
        panel.appendChild(scroll);
        // Any scroll the viewer starts pauses following, so the line being read stays put
        scroll.addEventListener('wheel', pauseFollowing);
        scroll.addEventListener('touchmove', pauseFollowing);
        scroll.addEventListener('pointerdown', function (event) {
            if (event.target === scroll || event.target === list) pauseFollowing();
        });
        scroll.addEventListener('scroll', function () {
            if (scroll.__twkProgrammaticScroll) return;
            pauseFollowing();
        });
        document.body.appendChild(panel);
        window.__twkPanels.add('logview', close);
        updateControls();
    }

    function toggleFollow() {
        // Following keeps the newest line in view; turning it back on jumps to the end
        follow = !follow;
        updateControls();
        if (follow) scrollToEnd();
    }

    function updateControls() {
        // Labels and pressed state follow the current language, detail and follow mode
        if (!panel) return;
        var detail = currentLevel();
        panel.setAttribute('aria-label', t('logview.title'));
        titleNode.textContent = t('logview.title');
        closeButton.setAttribute('aria-label', t('logview.close'));
        closeButton.title = t('logview.close');
        scroll.setAttribute('aria-label', t('logview.entries'));
        level.textContent = t('logview.detail.' + detail);
        followButton.textContent = follow ? t('logview.pauseFollow') : t('logview.follow');
        followButton.setAttribute('aria-pressed', follow ? 'true' : 'false');
        followButton.setAttribute('aria-label', follow ? t('logview.pauseFollow') : t('logview.follow'));
    }

    function focusControl(index) {
        // Left and Right move between the two header buttons
        focusedControl = index;
        (index === 0 ? followButton : closeButton).focus();
    }

    function pauseFollowing() {
        // Stop jumping to new lines while the viewer reads older ones
        if (!follow) return;
        follow = false;
        updateControls();
    }

    function scrollToEnd() {
        // Programmatic scrolls are marked so they do not count as the viewer scrolling
        if (!scroll) return;
        scroll.__twkProgrammaticScroll = true;
        scroll.scrollTop = scroll.scrollHeight;
        requestAnimationFrame(function () { if (scroll) scroll.__twkProgrammaticScroll = false; });
    }

    function visible(line, detail) {
        // A line shows when its level ranks within the chosen detail
        var rank = RANK[line.level];
        if (rank === undefined) rank = 2;
        return rank <= (detail === 'essential' ? 0 : detail === 'everything' ? 2 : 1);
    }

    function appendLine(line) {
        // One row per line: time, level, area and the full wrapped sentence
        var row = make('div', 'twk-debug-line twk-logview-row');
        row.appendChild(make('span', 'twk-debug-time', clock(line.at)));
        row.appendChild(make('span', 'twk-debug-level twk-debug-' + (RANK[line.level] === undefined ? 'verbose' : line.level), LABEL[line.level] || String(line.level || 'MORE')));
        row.appendChild(make('span', 'twk-debug-area', String(line.source || '')));
        row.appendChild(make('span', 'twk-debug-text twk-logview-text', String(line.text || '')));
        list.appendChild(row);
    }

    function updateEntries(shown, detail) {
        // Reuse the rows already drawn: drop the ones the ring evicted, append only the new ones
        if (detail !== renderedDetail) {
            list.textContent = '';
            rendered = [];
            renderedDetail = detail;
        }
        var overlap = Math.min(rendered.length, shown.length);
        while (overlap > 0) {
            var matches = true;
            for (var i = 0; i < overlap; i++) {
                if (rendered[rendered.length - overlap + i] !== shown[i]) {
                    matches = false;
                    break;
                }
            }
            if (matches) break;
            overlap--;
        }
        if (overlap === 0 && rendered.length && shown.length) {
            list.textContent = '';
            rendered = [];
        } else if (overlap < rendered.length) {
            for (var removeCount = rendered.length - overlap; removeCount > 0; removeCount--) list.removeChild(list.firstChild);
            rendered = overlap ? rendered.slice(-overlap) : [];
        }
        for (var index = overlap; index < shown.length; index++) {
            appendLine(shown[index]);
            rendered.push(shown[index]);
        }
    }

    function render() {
        // Redraw the list and the counter for the current detail
        updatePending = false;
        if (!panel || !open) return;
        var retained = lines();
        var detail = currentLevel();
        var shown = retained.filter(function (line) { return visible(line, detail); });
        updateEntries(shown, detail);
        counter.textContent = t('logview.count', { shown: shown.length, retained: retained.length, limit: RING_LIMIT });
        updateControls();
        if (follow) scrollToEnd();
    }

    function scheduleRender() {
        // New lines arrive in bursts; one redraw per frame is enough
        if (!open || updatePending) return;
        updatePending = true;
        requestAnimationFrame(render);
    }

    function showPanel() {
        // Show the reader once the language is known, following the newest line, focus on the first button
        if (!panel || !opening || window.__twkPanels.current() !== 'logview') return;
        opening = false;
        panel.hidden = false;
        panel.classList.add('twk-visible');
        follow = true;
        updateControls();
        render();
        focusControl(0);
    }

    function openPanel() {
        // Open on top of the panel stack; the panel below keeps its state for when the reader closes
        if (open || opening) return Promise.resolve();
        build();
        if (!panel) return Promise.resolve();
        open = true;
        opening = true;
        window.__twkPanels.opened('logview', true);
        window.dispatchEvent(new CustomEvent('twk-logview-opened'));
        var i18n = window.__twkI18n;
        if (!i18n || typeof i18n.refresh !== 'function') {
            showPanel();
            return Promise.resolve();
        }
        return Promise.resolve(i18n.refresh()).then(showPanel, showPanel);
    }

    function close() {
        // Hide the reader and release the focus it held, so a hidden button never receives or names later keys
        if (!panel || (!open && !opening)) return;
        open = false;
        opening = false;
        if (panel.contains(document.activeElement)) document.activeElement.blur();
        panel.classList.remove('twk-visible');
        panel.hidden = true;
        window.__twkPanels.closed('logview');
        window.dispatchEvent(new CustomEvent('twk-logview-closed'));
    }

    function onKey(event) {
        // While the reader is on top it owns the remote: arrows move or scroll, OK presses the focused button,
        // Back and Escape go to the panel stack, and every other key stops here so nothing underneath reacts
        if (!open || !window.__twkPanels || window.__twkPanels.current() !== 'logview') return;
        var code = event.keyCode;
        if (PASS_KEYS.indexOf(code) !== -1) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (code === KEYS.left || code === KEYS.right) return focusControl(code === KEYS.left ? 0 : 1);
        if (code === KEYS.enter) {
            if (!event.repeat) (focusedControl === 0 ? followButton : closeButton).click();
            return;
        }
        if (code !== KEYS.up && code !== KEYS.down) return;
        pauseFollowing();
        scroll.scrollTop += code === KEYS.up ? -Math.max(80, scroll.clientHeight * 0.75) : Math.max(80, scroll.clientHeight * 0.75);
    }

    window.addEventListener('twk-debug-line', scheduleRender);
    window.addEventListener('keydown', onKey, true);

    window.__twkLogView = { open: openPanel, close: close };
})();
