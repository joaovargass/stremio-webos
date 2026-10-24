// Netflix-like shell over the Stremio screens it replaces: a slim left menu that expands when focused (Search, Home,
// Series, Movies, My List, Settings) and a content area where webos-home.js draws Home, Series, Movies or My List.
// The Stremio routes stay the same (#/, #/home, #/discover/series, #/discover/movie, #/library), so the router and
// Back keep working; while the layer shows, it owns the arrows, OK and Back, and the Stremio screen under it is hidden.
(function () {
    var config = (window.STREMIO_TWEAKS || {}).netflix || {};
    var shared = window.__twkShared;
    var element = shared.element;
    var t = window.__twkI18n.t;
    var KEYS = { left: 37, up: 38, right: 39, down: 40, enter: 13, back: 461, escape: 27 };
    var ICONS = {
        search: 'M10.5 3a7.5 7.5 0 0 1 5.9 12.1l4.7 4.7-1.4 1.4-4.7-4.7A7.5 7.5 0 1 1 10.5 3zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z',
        home: 'M12 3l9 8h-3v9h-5v-6h-2v6H6v-9H3z',
        series: 'M3 6h18v11H3zm2 2v7h14V8zm3 11h8v2H8z',
        movie: 'M4 4h2l2 3h3L9 4h2l2 3h3l-2-3h2l2 3h2V4h2v16H2V4zm0 5v9h16V9z',
        mylist: 'M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z',
        settings: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm8.6 3l1.4-1-2-3.5-1.7.6a7 7 0 0 0-1.6-.9L16.5 4h-4l-.3 1.8a7 7 0 0 0-1.6.9l-1.7-.6-2 3.5 1.4 1a7 7 0 0 0 0 1.8l-1.4 1 2 3.5 1.7-.6a7 7 0 0 0 1.6.9l.3 1.8h4l.3-1.8a7 7 0 0 0 1.6-.9l1.7.6 2-3.5-1.4-1a7 7 0 0 0 0-1.8z'
    };
    var MENU = [
        { id: 'search', route: '/search' },
        { id: 'home', route: '/home' },
        { id: 'series', route: '/discover/series' },
        { id: 'movie', route: '/discover/movie' },
        { id: 'mylist', route: '/library' },
        { id: 'settings', route: '/settings' }
    ];
    var root = null;
    var menu = null;
    var content = null;
    var screen = null;
    var menuFocus = 1;
    var menuOpen = false;

    function screenOf(hash) {
        // Which of the replaced screens a route shows, or null for a Stremio screen the layer leaves alone
        var route = String(hash || '').split('?')[0];
        if (/^#\/?(home)?$/.test(route)) return 'home';
        if (/^#\/discover\/series/.test(route)) return 'series';
        if (/^#\/discover\/movie/.test(route)) return 'movie';
        if (/^#\/library/.test(route)) return 'mylist';
        return null;
    }

    function enabled() {
        // The layer follows its switch in Settings at once
        return config.enabled !== false;
    }

    function icon(path) {
        // One menu icon drawn from its path, in the text colour
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('class', 'twk-nf-icon');
        var shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        shape.setAttribute('d', path);
        svg.appendChild(shape);
        return svg;
    }

    function build() {
        // The layer, its menu and the content area, built once
        root = document.body.appendChild(element('div', 'twk-nf'));
        menu = root.appendChild(element('nav', 'twk-nf-menu'));
        MENU.forEach(function (item, i) {
            var entry = menu.appendChild(element('div', 'twk-nf-menu-item'));
            entry.appendChild(icon(ICONS[item.id]));
            item.label = entry.appendChild(element('span', 'twk-nf-menu-label'));
            item.node = entry;
            entry.addEventListener('mouseenter', function () { setMenuFocus(i, true); });
            entry.addEventListener('click', function (e) { e.stopPropagation(); choose(i); });
        });
        content = root.appendChild(element('main', 'twk-nf-content'));
        content.addEventListener('mouseenter', function () { setMenuOpen(false); });
    }

    function paintMenu() {
        // Labels in the interface language, the focused item and the item of the current screen
        var current = screen && screen.name;
        MENU.forEach(function (item, i) {
            item.label.textContent = t('netflix.menu.' + item.id);
            item.node.classList.toggle('twk-focus', menuOpen && i === menuFocus);
            item.node.classList.toggle('twk-nf-current', item.id === current);
        });
        root.classList.toggle('twk-nf-menu-open', menuOpen);
    }

    function setMenuOpen(open) {
        // The menu expands while it has the focus; the content keeps its own focus for when it comes back
        menuOpen = open;
        if (open) MENU.forEach(function (item, i) { if (screen && item.id === screen.name) menuFocus = i; });
        if (screen && screen.focusChanged) screen.focusChanged(!open);
        paintMenu();
    }

    function setMenuFocus(index, open) {
        // Move the menu focus, opening the menu when the pointer reaches it
        menuFocus = Math.max(0, Math.min(MENU.length - 1, index));
        if (open && !menuOpen) return setMenuOpen(true);
        paintMenu();
    }

    function choose(index) {
        // Go to the screen of a menu item through the app router, so Back keeps working
        var item = MENU[index];
        setMenuOpen(false);
        if (screen && item.id === screen.name) return;
        window.__stremioDoctor.navigate(item.route);
    }

    function show(name) {
        // Draw a screen in the content area and hide the Stremio screen under the layer
        if (!root) build();
        document.documentElement.setAttribute('data-twk-netflix', 'on');
        if (!screen || screen.name !== name) {
            if (screen && screen.destroy) screen.destroy();
            content.textContent = '';
            screen = window.__twkScreens.create(name, content, { openMenu: function () { setMenuOpen(true); } });
            screen.name = name;
        }
        setMenuOpen(false);
    }

    function hide() {
        // Give the screen back to Stremio and stop whatever the layer was playing
        document.documentElement.removeAttribute('data-twk-netflix');
        if (screen && screen.destroy) screen.destroy();
        screen = null;
        if (content) content.textContent = '';
    }

    function onRoute() {
        // Each route change decides whether the layer shows and which screen it draws
        var name = enabled() ? screenOf(location.hash) : null;
        if (name) show(name);
        else if (screen) hide();
    }

    function onKey(e) {
        // While the layer shows and no panel is open, it owns the arrows, OK and Back; colour keys go to their tweaks
        if (!screen || window.__twkPanels.current()) return;
        var code = e.keyCode;
        if ([KEYS.left, KEYS.up, KEYS.right, KEYS.down, KEYS.enter, KEYS.back, KEYS.escape].indexOf(code) === -1) return;
        if (menuOpen && (code === KEYS.back || code === KEYS.escape)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (menuOpen) return menuKey(code, e.repeat);
        screen.onKey(code, e.repeat);
    }

    function menuKey(code, repeat) {
        // Up and Down walk the menu, OK opens a screen, Right goes back to the content
        if (code === KEYS.up) return setMenuFocus(menuFocus - 1);
        if (code === KEYS.down) return setMenuFocus(menuFocus + 1);
        if (code === KEYS.right) return setMenuOpen(false);
        if (code === KEYS.enter && !repeat) choose(menuFocus);
    }

    shared.whenCoreReady(function () {
        window.__twkI18n.refresh().then(function () {
            window.addEventListener('keydown', onKey, true);
            window.addEventListener('historyChange', onRoute);
            window.addEventListener('hashchange', onRoute);
            window.addEventListener('twk-setting-changed', function (e) { if (e.detail.key === 'netflix.enabled') onRoute(); });
            onRoute();
        });
    });

    window.__twkLayer = { screenOf: screenOf, refresh: onRoute };
})();
