// Full-screen reader for the bounded, sanitized debug log ring, stacked above the settings panel.
(function () {
    var shared = window.__twkShared;
    var t = window.__twkI18n.t;
    var KEYS = { left: 37, up: 38, right: 39, down: 40, enter: 13 };
    var PASS_KEYS = [461, 27, 8];
    var view = null;
    var list;
    var scroll;
    var counter;
    var followButton;
    var rendered = [];
    var renderedDetail = null;
    var follow = true;
    var focusedControl = 0;
    var open = false;
    var updatePending = false;

    function build() {
        // Create the panel once: shared frame with the follow button, then the counter and the scrolling list
        view = shared.frame('logview', 'twk-logview', close);
        followButton = shared.button('', '', toggleFollow);
        followButton.addEventListener('mouseenter', function () { focusControl(0); });
        view.header.insertBefore(followButton, view.close);
        view.close.addEventListener('mouseenter', function () { focusControl(1); });
        counter = view.root.appendChild(shared.element('div', 'twk-logview-counter'));
        scroll = view.root.appendChild(shared.element('div', 'twk-logview-scroll'));
        list = scroll.appendChild(shared.element('div'));
        // Any scroll the viewer starts pauses following, so the line being read stays put
        scroll.addEventListener('wheel', pauseFollowing);
        scroll.addEventListener('touchmove', pauseFollowing);
        scroll.addEventListener('scroll', function () {
            if (!scroll.__twkProgrammaticScroll) pauseFollowing();
        });
    }

    function toggleFollow() {
        // Following keeps the newest line in view; turning it back on jumps to the end
        follow = !follow;
        updateControls();
        if (follow) scrollToEnd();
    }

    function updateControls() {
        // Labels and pressed state follow the current language, detail and follow mode
        view.label(t('logview.title'), t('logview.detail.' + window.__twkDebug.detail()));
        scroll.setAttribute('aria-label', t('logview.entries'));
        followButton.textContent = follow ? t('logview.pauseFollow') : t('logview.follow');
        followButton.setAttribute('aria-pressed', follow ? 'true' : 'false');
    }

    function focusControl(index) {
        // Left and Right move between the two header buttons
        focusedControl = index;
        (index === 0 ? followButton : view.close).focus();
    }

    function pauseFollowing() {
        // Stop jumping to new lines while the viewer reads older ones
        if (!follow) return;
        follow = false;
        updateControls();
    }

    function scrollToEnd() {
        // Programmatic scrolls are marked so they do not count as the viewer scrolling
        scroll.__twkProgrammaticScroll = true;
        scroll.scrollTop = scroll.scrollHeight;
        requestAnimationFrame(function () { scroll.__twkProgrammaticScroll = false; });
    }

    function updateEntries(shown, detail) {
        // Reuse the rows already drawn: drop the ones whose line left the ring (each level leaves from its own share), append only the new ones
        if (detail !== renderedDetail) {
            list.textContent = '';
            rendered = [];
            renderedDetail = detail;
        }
        var kept = new Set(shown);
        rendered = rendered.filter(function (entry) {
            if (kept.has(entry.line)) return true;
            list.removeChild(entry.node);
            return false;
        });
        var drawn = new Set(rendered.map(function (entry) { return entry.line; }));
        // New lines are always appended at the end of the ring
        shown.forEach(function (line) {
            if (drawn.has(line)) return;
            rendered.push({ line: line, node: list.appendChild(window.__twkDebug.row(line, true)) });
        });
    }

    function render() {
        // Redraw the list and the counter for the current detail
        updatePending = false;
        if (!open || !view) return;
        var debug = window.__twkDebug;
        var detail = debug.detail();
        var shown = debug.lines.filter(function (line) { return debug.shows(line, detail); });
        updateEntries(shown, detail);
        counter.textContent = t('logview.count', { shown: shown.length, retained: debug.lines.length, limit: debug.limit });
        if (follow) scrollToEnd();
    }

    function scheduleRender() {
        // New lines arrive in bursts; one redraw per frame is enough
        if (!open || updatePending) return;
        updatePending = true;
        requestAnimationFrame(render);
    }

    function openPanel() {
        // Open on top of the panel stack once the language is known; the panel below keeps its state for when the reader closes
        if (open) return Promise.resolve();
        open = true;
        return window.__twkI18n.refresh().then(function () {
            if (!open) return;
            if (!view) build();
            follow = true;
            updateControls();
            view.show(true, function () { focusControl(0); });
            render();
        });
    }

    function close() {
        // Hide the reader; the shared frame releases the focus it held
        if (!open) return;
        open = false;
        if (view) view.hide();
    }

    function onKey(event) {
        // While the reader is on top it owns the remote: arrows move or scroll, OK presses the focused button, Back goes to the stack
        if (!open || window.__twkPanels.current() !== 'logview') return;
        var code = event.keyCode;
        if (PASS_KEYS.indexOf(code) !== -1) return;
        // Every other key stops here, so nothing underneath reacts
        event.preventDefault();
        event.stopImmediatePropagation();
        if (code === KEYS.left || code === KEYS.right) return focusControl(code === KEYS.left ? 0 : 1);
        if (code === KEYS.enter) {
            if (!event.repeat) (focusedControl === 0 ? followButton : view.close).click();
            return;
        }
        if (code !== KEYS.up && code !== KEYS.down) return;
        pauseFollowing();
        var step = Math.max(80, scroll.clientHeight * 0.75);
        scroll.scrollTop += code === KEYS.up ? -step : step;
    }

    window.addEventListener('twk-debug-line', scheduleRender);
    window.addEventListener('keydown', onKey, true);

    window.__twkLogView = { open: openPanel, close: close };
})();
