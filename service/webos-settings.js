// Settings panel with an on/off switch for every tweak added on top of the original
// app. Choices are saved on the TV (localStorage "twk.overrides"), applied over
// tweaks.json by index.html at start and shared with the service. Opens with a
// remote colour key; closing after a change reloads the app to apply it.
(function () {
    var config = (window.STREMIO_TWEAKS || {}).settings || {};
    var STORAGE_KEY = 'twk.overrides';
    var KEYS = { up: 38, down: 40, left: 37, right: 39, enter: 13, back: 461, escape: 27 };
    var GROUPS = [
        { title: 'Fontes', column: 0, items: [
            ['ranking.enabled', 'Ordenar fontes e marcar a recomendada'],
            ['prewarm.enabled', 'Pré-carregar a fonte recomendada'],
            ['peerBoost.enabled', 'Trackers extras nos torrents'],
            ['sources.enabled', 'Seletor de fontes (botão verde)']
        ] },
        { title: 'Correção automática', column: 1, items: [
            ['doctor.enabled', 'Monitorar a reprodução'],
            ['doctor.autoSwitch', 'Trocar de fonte sozinho quando falha'],
            ['stallRetry.enabled', 'Retomar quando o torrent trava'],
            ['hlsFallback.enabled', 'Converter áudio ou vídeo incompatível (Mac)']
        ] },
        { title: 'Legendas', column: 0, items: [
            ['subtitles.enabled', 'Central de legendas'],
            ['subtitles.autoPick', 'Escolher legenda automaticamente'],
            ['subtitles.openSubtitles', 'Buscar no OpenSubtitles'],
            ['subtitles.avoidSdh', 'Evitar legendas para surdos (SDH)'],
            ['subtitles.netflixStyle', 'Legendas no estilo Netflix'],
            ['subtitles.autoSync', 'Sincronizar legendas externas']
        ] },
        { title: 'TV e rede', column: 1, items: [
            ['readAhead.enabled', 'Buffer extra na memória da TV'],
            ['servers.useLan', 'Usar o servidor do Mac quando a TV não der conta'],
            ['doctor.startOnLanWhenHeavy', 'Começar pelo Mac se a fonte for pesada para a TV']
        ] },
        { title: 'Avisos', column: 1, items: [
            ['sources.loadingHint', 'Dica "Demorando?" ao carregar'],
            ['hints.firstRunToast', 'Aviso de novidades']
        ] }
    ];
    var panel = null;
    var rows = [];
    var focus = 0;
    var open = false;
    var changed = false;

    function element(tag, className, text) {
        // Small DOM helper for the panel
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
    }

    function readOverrides() {
        // Saved choices, empty when storage is unavailable
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (_e) { return {}; }
    }

    function current(key) {
        // Effective value: tweaks.json with the saved choices already applied by index.html
        var parts = key.split('.');
        var section = (window.STREMIO_TWEAKS || {})[parts[0]] || {};
        return section[parts[1]] !== false;
    }

    function createPanel() {
        // Build the switch list once from GROUPS
        panel = element('div', 'twk-diag twk-diag-grid twk-settings');
        var header = panel.appendChild(element('div', 'twk-diag-header'));
        header.appendChild(element('div', 'twk-diag-title', 'Ajustes'));
        header.appendChild(element('div', 'twk-chip', '↑↓ ←→ OK'));
        // Two real columns so Up and Down follow what the viewer sees, Left and Right switch columns
        [0, 1].forEach(function (column) {
            var holder = panel.appendChild(element('div', 'twk-set-column'));
            GROUPS.filter(function (group) { return group.column === column; }).forEach(function (group) {
                var box = holder.appendChild(element('div', 'twk-section'));
                box.appendChild(element('div', 'twk-section-title', group.title));
                group.items.forEach(function (item) {
                    var row = box.appendChild(element('div', 'twk-set-row'));
                    row.appendChild(element('span', 'twk-set-label', item[1]));
                    var value = row.appendChild(element('span', 'twk-set-switch'));
                    rows.push({ key: item[0], row: row, value: value, on: current(item[0]), column: column });
                });
            });
        });
        document.body.appendChild(panel);
    }

    function paint() {
        // Show each switch state and the focused row
        rows.forEach(function (entry, i) {
            entry.value.textContent = entry.on ? 'Ligado' : 'Desligado';
            entry.value.className = 'twk-set-switch ' + (entry.on ? 'twk-good' : 'twk-bad');
            entry.row.classList.toggle('twk-src-focus', i === focus);
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
        // Flip the focused switch and save it on the TV
        var entry = rows[focus];
        entry.on = !entry.on;
        var overrides = readOverrides();
        overrides[entry.key] = entry.on;
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides)); } catch (_e) {}
        changed = true;
        paint();
    }

    function show() {
        // Open the panel on top of any screen
        if (!panel) createPanel();
        open = true;
        changed = false;
        paint();
        requestAnimationFrame(function () { panel.classList.add('twk-visible'); });
    }

    function hide() {
        // Close the panel and reload once so every module starts with the new choices
        open = false;
        panel.classList.remove('twk-visible');
        if (!changed) return;
        if (window.__stremioToast) window.__stremioToast.show('Ajustes salvos, aplicando...');
        setTimeout(function () { location.reload(); }, 800);
    }

    function onKey(e) {
        // The colour key opens the panel; while open it owns the arrows, OK and Back
        var code = e.keyCode;
        if (!open) {
            if (code === config.hotkey) {
                e.preventDefault();
                e.stopPropagation();
                show();
            }
            return;
        }
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

    window.__stremioSettings = {
        toggle: function () { return open ? hide() : show(); }
    };
})();
