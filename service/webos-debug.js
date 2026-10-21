// On-screen debug log: the latest tweak log lines from the page and the service, the remote keys
// pressed and the screens opened, in a small corner box that never takes focus or clicks.
// Shown while "debug.overlay" is on (settings panel, Depuração).
(function () {
    var config = (window.STREMIO_TWEAKS || {}).debug || {};
    if (!config.overlay) return;
    var KEY_NAMES = { 13: 'OK', 37: '←', 38: '↑', 39: '→', 40: '↓', 461: 'Voltar', 27: 'Esc', 403: 'vermelho', 404: 'verde', 405: 'amarelo', 406: 'azul', 415: 'play', 19: 'pausa', 413: 'stop', 417: 'avançar', 412: 'voltar mídia' };
    var lines = [];
    var box = null;
    var serviceSeq = 0;
    var pending = false;

    function clock(at) {
        // Local time with seconds, enough to follow a test as it runs
        var d = new Date(at);
        return [d.getHours(), d.getMinutes(), d.getSeconds()].map(function (n) { return String(n).padStart(2, '0'); }).join(':');
    }

    function add(source, level, text, at) {
        // Keep the latest lines and repaint on the next frame
        lines.push({ source: source, level: level, text: String(text).slice(0, 220), at: at || Date.now() });
        if (lines.length > 200) lines.shift();
        if (pending) return;
        pending = true;
        requestAnimationFrame(paint);
    }

    function paint() {
        // Render the newest lines, oldest on top
        pending = false;
        if (!box) {
            if (!document.body) return;
            box = document.createElement('div');
            box.className = 'twk-debug';
            document.body.appendChild(box);
        }
        box.textContent = '';
        lines.slice(-(config.lines || 12)).forEach(function (line) {
            var row = box.appendChild(document.createElement('div'));
            row.className = 'twk-debug-line' + (line.level === 'error' ? ' twk-bad' : line.level === 'warn' ? ' twk-warn' : '');
            row.textContent = clock(line.at) + ' ' + line.source + ' ' + line.text;
        });
    }

    function describe(value) {
        // Objects read as their content, never as [object Object]; circular ones fall back to their type
        if (value instanceof Error) return value.name + ': ' + value.message;
        if (!value || typeof value !== 'object') return String(value);
        try { return JSON.stringify(value); } catch (_e) { return Object.prototype.toString.call(value); }
    }

    function wrapConsole() {
        // Tweak logs start with a [tag]; errors from anywhere are kept too
        ['info', 'log', 'warn', 'error'].forEach(function (level) {
            var original = console[level].bind(console);
            console[level] = function () {
                var text = Array.prototype.map.call(arguments, describe).join(' ');
                if (level === 'error' || text.charAt(0) === '[') add('TV', level, text);
                original.apply(null, arguments);
            };
        });
    }

    function pollService() {
        // Service lines arrive in order, numbered, so each is shown once
        fetch('/__tweaks/logs?since=' + serviceSeq).then(function (r) { return r.json(); }).then(function (body) {
            if (serviceSeq === 0) body.lines = body.lines.slice(-5);
            // The bundled streaming server logs every request; only its errors and the proxy lines are worth a viewer's eye
            var hide = new RegExp(config.hideService || '$^');
            body.lines.forEach(function (line) { if (!hide.test(line.text)) add('SVC', line.level, line.text, line.at); });
            serviceSeq = body.last;
        }).catch(function () {}).then(function () { setTimeout(pollService, config.pollMs || 1000); });
    }

    // Test scripts read the same lines the viewer sees
    window.__twkDebug = { lines: lines };
    wrapConsole();
    // Every remote key, so a viewer can follow what a test presses
    window.addEventListener('keydown', function (e) { add('KEY', 'info', KEY_NAMES[e.keyCode] || 'tecla ' + e.keyCode); }, true);
    window.addEventListener('historyChange', function () {
        // A route with a malformed escape is shown as it is
        var route = location.hash;
        try { route = decodeURIComponent(route); } catch (_e) {}
        add('NAV', 'info', route.slice(0, 120));
    });
    window.addEventListener('error', function (e) { add('TV', 'error', e.message + ' @ ' + String(e.filename || '').split('/').pop() + ':' + e.lineno); });
    add('TV', 'info', 'debug log on');
    pollService();
})();
