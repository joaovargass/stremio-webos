// On-screen debug log: what the tweaks, the service, the remote and the router did, one readable line each
// (time, level, area, sentence), in a corner box that never takes focus or clicks and steps aside while a panel
// is open. The detail setting picks how much shows: "essential" (warnings and errors), "detailed" (plus what the
// tweaks did) or "everything" (plus every server request, key press and the code behind each route change).
// The compact corner box follows "debug.overlay"; the full reader remains available from settings.
(function () {
    var config = (window.STREMIO_TWEAKS || {}).debug || {};
    var shared = window.__twkShared;
    var DETAIL = { essential: 0, detailed: 1, everything: 2 };
    var LEVEL_RANK = { error: 0, warn: 0, action: 0, info: 1, verbose: 2 };
    var LEVEL_LABEL = { error: 'ERROR', warn: 'WARN', action: 'ACTION', info: 'INFO', verbose: 'MORE' };
    var LEVEL_TONE = { error: 'twk-bad', warn: 'twk-warn', action: 'twk-good', info: '', verbose: 'twk-faint' };
    var KEY_NAMES = { 13: 'OK', 37: 'Left', 38: 'Up', 39: 'Right', 40: 'Down', 461: 'Back', 27: 'Esc', 403: 'Red', 404: 'Green', 405: 'Yellow', 406: 'Blue', 415: 'Play', 19: 'Pause', 413: 'Stop', 417: 'Forward', 412: 'Rewind' };
    var SCREENS = [[/^#\/player/, 'Player'], [/^#\/detail\/series\/[^/]+\/[^/]+/, 'Episode'], [/^#\/detail/, 'Title page'], [/^#\/discover/, 'Discover'], [/^#\/library/, 'Library'], [/^#\/search/, 'Search'], [/^#\/settings/, 'Stremio settings'], [/^#\/addons/, 'Addons'], [/^#\/login/, 'Login'], [/^#\/?(home)?$/, 'Home']];
    var SERVICE_AREAS = [[/^(-> |hls-converter - |hls executables|Using app path|EngineFS|Resizing cache)/, 'server', 'verbose'], [/^hls /, 'conversion', null], [/^subsync|^subtitles/, 'subtitles', null], [/^dev mode/, 'devmode', null], [/discover|LAN|network/i, 'network', null], [/torrent|warm|mirror|route/i, 'torrents', null]];
    var detailName = DETAIL[config.detail] !== undefined ? config.detail : 'detailed';
    var detail = DETAIL[detailName];
    var lines = [];
    var box = null;
    var serviceSeq = 0;
    var pendingActivation = null;
    var pending = false;

    function add(area, level, text, at) {
        // Keep every line for test scripts; repaint on the next frame only when this one is shown at the current detail
        var line = { source: area, level: level, text: safeText(text), at: at || Date.now() };
        lines.push(line);
        if (lines.length > 300) lines.shift();
        window.dispatchEvent(new CustomEvent('twk-debug-line', { detail: line }));
        if (!shows(line) || pending) return;
        pending = true;
        requestAnimationFrame(paint);
    }

    function safeText(text) {
        // Credentials and personal data never reach the log, the same rules the service applies to its own lines
        return String(text)
            .replace(/\b(https?:\/\/)([^/\s?#@]+(?::[^/@\s?#]*)?@)/gi, '$1[REDACTED]@')
            .replace(/([?&](?:access_token|token|key|auth|password|profile|sessionToken|from)=)[^&\s]+/gi, '$1[REDACTED]')
            .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
            .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]');
    }

    function controlLabel(node) {
        // The name of the control a key or click reached: its label, else its text, else its navigation id
        var current = node;
        while (current && current !== document.body) {
            if (current.matches && current.matches('button,a,[role="button"],[role="link"],input,select,[data-nav-id],[nav-id],.twk-item')) {
                var label = current.getAttribute('aria-label') || current.getAttribute('title') || current.getAttribute('data-testid') || current.id;
                if (!label && current.matches('button,a,[role="button"],[role="link"],.twk-item')) label = current.textContent;
                if (!label && current.hasAttribute('nav-id')) label = 'control ' + current.getAttribute('nav-id');
                label = safeText(label || current.tagName.toLowerCase()).replace(/\s+/g, ' ').trim();
                // Controls of a tweak panel name the panel too, since several panels share the same Close button
                var panel = current.closest && current.closest('.twk-panel');
                var panelName = panel && panel.getAttribute('aria-label');
                return (label.slice(0, 100) || current.tagName.toLowerCase()) + (panelName ? ' (' + panelName + ')' : '');
            }
            current = current.parentElement;
        }
        return '';
    }

    function shows(line, name) {
        // A line shows when its level ranks within the chosen detail; an unknown level counts as the most detailed
        var rank = LEVEL_RANK[line.level] === undefined ? DETAIL.everything : LEVEL_RANK[line.level];
        return rank <= (DETAIL[name] === undefined ? detail : DETAIL[name]);
    }

    function row(line) {
        // One log line in fixed columns: dim time, level tag in its tone, dim area, then the sentence
        var node = shared.element('div', 'twk-log-row');
        node.appendChild(shared.element('span', 'twk-log-time', shared.timeOfDay(line.at)));
        node.appendChild(shared.element('span', 'twk-tag twk-tag-s ' + (LEVEL_TONE[line.level] || LEVEL_TONE.verbose), LEVEL_LABEL[line.level] || String(line.level || LEVEL_LABEL.verbose)));
        node.appendChild(shared.element('span', 'twk-log-area', String(line.source || '')));
        node.appendChild(shared.element('span', 'twk-log-text', String(line.text || '')));
        return node;
    }

    function visibleLines() {
        // The newest lines allowed by the detail setting, in time order: service lines arrive a moment after they happened
        return lines.filter(function (line) { return shows(line); })
            .map(function (line, i) { return { line: line, i: i }; })
            .sort(function (a, b) { return a.line.at - b.line.at || a.i - b.i; })
            .slice(-(config.lines || 10))
            .map(function (entry) { return entry.line; });
    }

    function paint() {
        // Redraw the corner card with the newest visible lines; it fades out by itself while a panel is open
        pending = false;
        if (!config.overlay) return;
        if (!box) {
            if (!document.body) return;
            box = document.body.appendChild(shared.element('div', 'twk-debug'));
        }
        box.textContent = '';
        visibleLines().forEach(function (line) { box.appendChild(row(line)); });
    }

    function describe(value) {
        // Objects read as their content, never as [object Object]; circular ones fall back to their type
        if (value instanceof Error) return value.name + ': ' + value.message;
        if (!value || typeof value !== 'object') return String(value);
        try { return JSON.stringify(value); } catch (_e) { return Object.prototype.toString.call(value); }
    }

    function pageLine(level, text) {
        // Tweak lines start with their area in brackets; a deliberately cancelled request is routine, not an error
        var match = /^\[([a-z-]+)\]\s*/i.exec(text);
        var area = match ? match[1] : 'page';
        var body = match ? text.slice(match[0].length) : text;
        if (/AbortError|aborted a request/.test(body) && level === 'error') level = 'verbose';
        add(area, level === 'log' ? 'info' : level, body);
    }

    function wrapConsole() {
        // Tweak logs start with a [tag]; errors from anywhere are kept too
        ['info', 'log', 'warn', 'error'].forEach(function (level) {
            var original = console[level].bind(console);
            console[level] = function () {
                var text = Array.prototype.map.call(arguments, describe).join(' ');
                if (level === 'error' || text.charAt(0) === '[') pageLine(level, text);
                original.apply(null, arguments);
            };
        });
    }

    function serviceLine(line) {
        // Service lines get an area from their wording; request traces of the bundled server are detail-only
        var area = 'service';
        var level = line.level === 'log' ? 'info' : line.level || 'info';
        for (var i = 0; i < SERVICE_AREAS.length; i++) {
            if (!SERVICE_AREAS[i][0].test(line.text)) continue;
            area = SERVICE_AREAS[i][1];
            if (SERVICE_AREAS[i][2] && level === 'info') level = SERVICE_AREAS[i][2];
            break;
        }
        // The answer timing of every conversion request is useful only when looking for a slow start
        if (area === 'conversion' && level === 'info' && /answer .* ms, end/.test(line.text)) level = 'verbose';
        add(area, level, line.text, line.at);
    }

    function pollService() {
        // Request all levels to retain a complete client-side audit ring; the overlay filters its own view
        fetch('/__tweaks/logs?since=' + serviceSeq + '&detail=everything').then(function (r) { return r.json(); }).then(function (body) {
            body.lines.forEach(serviceLine);
            serviceSeq = body.last;
        }).catch(function () {}).then(function () { setTimeout(pollService, config.pollMs || 1000); });
    }

    function screenName(hash) {
        // The screen a route shows, in words
        for (var i = 0; i < SCREENS.length; i++) if (SCREENS[i][0].test(hash)) return SCREENS[i][1];
        return 'Other screen';
    }

    function safeRoute(hash) {
        // The route without the stream and title ids, which say what is being watched
        var route = hash.split('?')[0];
        if (/^#\/player\//.test(route)) return '#/player/[stream]';
        var detail = route.match(/^#\/detail\/(movie|series)\//);
        if (detail) return '#/detail/' + detail[1] + '/[id]';
        var section = route.match(/^#\/([a-z-]+)/i);
        return section ? '#/' + section[1] : '#/';
    }

    function onKeyDown(e) {
        // Every key is low-level evidence; OK and the colour and media keys also log what they activated, once settled
        var name = KEY_NAMES[e.keyCode] || 'key ' + e.keyCode;
        add('keys', 'verbose', name);
        if (e.repeat || [13, 403, 404, 405, 406, 415, 19, 413].indexOf(e.keyCode) === -1) return;
        var target = document.activeElement;
        // A control inside a closed panel keeps the browser focus but is not what the viewer pressed
        if (target && (target.offsetParent === null || (target.closest && target.closest('.twk-panel:not(.twk-visible)')))) target = null;
        var label = controlLabel(target);
        if (!label) {
            target = document.querySelector('.focused,.twk-panel.twk-visible .twk-focus,[aria-selected="true"],[aria-current="true"]');
            label = controlLabel(target);
        }
        // Settings rows log what they changed themselves
        if (target && target.closest && target.closest('.twk-setting')) return;
        var activation = { code: e.keyCode, label: label, route: location.hash.split('?')[0] };
        pendingActivation = activation;
        setTimeout(function () {
            // A click the key produced logs the activation itself; otherwise say whether the key opened another screen
            if (pendingActivation !== activation) return;
            pendingActivation = null;
            var currentRoute = location.hash.split('?')[0];
            var outcome = currentRoute !== activation.route ? ' opened ' + screenName(currentRoute) : ' pressed';
            add('actions', 'action', name + outcome + (activation.label ? ' on ' + activation.label : ''));
        }, 120);
    }

    function onClick(e) {
        // A click without a pointer position came from OK on the remote
        var label = controlLabel(e.target);
        if (!label || e.target.closest && e.target.closest('.twk-setting')) return;
        if (e.detail === 0) {
            if (pendingActivation) pendingActivation = null;
            add('actions', 'action', 'Activated ' + label + ' with remote');
            return;
        }
        add('actions', 'action', 'Activated ' + label + ' with pointer');
    }

    function onFocus(e) {
        // Focus moves are detail-only evidence of where the remote is
        var label = controlLabel(e.target);
        if (label) add('focus', 'verbose', 'Focused ' + label);
    }

    function onPageError(e) {
        // Uncaught page errors with the file and line that threw
        add('page', 'error', e.message + ' @ ' + String(e.filename || '').split('/').pop() + ':' + e.lineno);
    }

    // Test scripts read every line, whatever the detail setting shows; the log viewer draws them with the same row
    window.__twkDebug = { lines: lines, action: add, row: row, shows: shows, detail: function () { return detailName; } };
    wrapConsole();
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('focusin', onFocus, true);
    var navCause = 'link';
    ['pushState', 'replaceState'].forEach(function (name) {
        // Each route change remembers how it happened and the code that asked for it, so an unexpected one can be traced
        var original = history[name];
        history[name] = function () {
            var caller = (new Error().stack || '').split('\n').slice(2, 4).map(function (line) { return line.trim().replace(/^at /, '').replace(/https?:\/\/[^/]+\//, ''); }).join(' < ');
            navCause = (name === 'pushState' ? 'opened' : 'replaced') + ' by ' + caller;
            return original.apply(this, arguments);
        };
    });
    window.addEventListener('popstate', function () { navCause = 'Back'; });
    window.addEventListener('historyChange', function () {
        // The screen in words for everyone; the exact route and the code behind it only at the highest detail
        var route = safeRoute(location.hash);
        try { route = decodeURIComponent(route); } catch (_e) {}
        add('screens', 'info', screenName(location.hash) + (navCause === 'Back' ? ' (Back)' : ''));
        add('screens', 'verbose', route.slice(0, 80) + ' · ' + navCause.slice(0, 120));
        navCause = 'link';
    });
    window.addEventListener('error', onPageError);
    add('debug', 'info', 'debug log on, ' + { essential: 'essential', detailed: 'standard', everything: 'full' }[detailName] + ' detail');
    pollService();
})();
