// Settings panel with an on/off switch for every tweak added on top of the original
// app, plus choice rows (OK cycles the values). Choices are saved on the TV
// (localStorage "twk.overrides"), applied over tweaks.json by index.html at start
// and shared with the service. Opens with a remote colour key; closing after a
// change reloads the app to apply it.
(function () {
    var config = (window.STREMIO_TWEAKS || {}).settings || {};
    var STORAGE_KEY = 'twk.overrides';
    var KEYS = { up: 38, down: 40, left: 37, right: 39, enter: 13, back: 461, escape: 27 };
    var QUALITY_LABELS = { best: 'Melhor (até 4K)', '2160p': '4K', '1080p': '1080p', '720p': '720p' };
    var DETAIL_LABELS = { essential: 'Essencial', detailed: 'Padrão', everything: 'Tudo' };
    var GROUPS = [
        { title: 'Modo simples', titleKey: 'settings.simple', column: 0, items: [
            ['simple.enabled', 'Um botão Assistir, sem lista de addons'],
            ['simple.quality', 'Qualidade preferida', ['best', '2160p', '1080p', '720p'], QUALITY_LABELS],
            ['restart.enabled', 'Botão azul recomeça do início'],
            ['simple.directOpen', 'OK no cartão abre o título (segure para opções)'],
            ['simple.autoPlayEpisodes', 'Episódio toca direto, sem lista de fontes']
        ] },
        { title: 'Fontes', titleKey: 'settings.sources', column: 0, items: [
            ['ranking.enabled', 'Ordenar fontes e marcar a recomendada'],
            ['prewarm.enabled', 'Pré-carregar a fonte recomendada'],
            ['liveTest.enabled', 'Testar as melhores fontes antes de recomendar'],
            ['peerBoost.enabled', 'Trackers extras nos torrents'],
            ['readAhead.mergeSources', 'Somar torrents do mesmo arquivo para baixar mais rápido'],
            ['sources.enabled', 'Seletor de fontes (botão verde)']
        ] },
        { title: 'Correção automática', titleKey: 'settings.doctor', column: 1, items: [
            ['doctor.enabled', 'Monitorar a reprodução'],
            ['doctor.autoSwitch', 'Trocar de fonte sozinho quando falha'],
            ['stallRetry.enabled', 'Retomar quando o torrent trava'],
            ['hlsFallback.enabled', 'Converter áudio ou vídeo incompatível'],
            ['doctor.prewarmNext', 'Preparar a próxima fonte em segundo plano'],
            ['doctor.prewarmOnLan', 'Preparar no Mac quando ele já estiver em uso'],
            ['doctor.convertFrozen', 'Converter quando a imagem trava com dados prontos']
        ] },
        { title: 'Legendas', titleKey: 'settings.subtitles', column: 1, items: [
            ['subtitles.enabled', 'Central de legendas'],
            ['subtitles.autoPick', 'Escolher legenda automaticamente'],
            ['subtitles.openSubtitles', 'Buscar no OpenSubtitles'],
            ['subtitles.avoidSdh', 'Evitar legendas para surdos (SDH)'],
            ['subtitles.netflixStyle', 'Legendas no estilo Netflix'],
            ['subtitles.autoSync', 'Sincronizar legendas externas'],
            ['subtitles.syncOnTv', 'Sincronizar na própria TV (o Mac só ajuda)'],
            ['subtitles.convert', 'Corrigir a formatação das legendas na TV'],
            ['subtitles.allowHttp', 'Aceitar legendas sem conexão segura (HTTPS)']
        ] },
        { title: 'TV e rede', titleKey: 'settings.network', column: 0, items: [
            ['readAhead.enabled', 'Buffer extra na memória da TV'],
            ['answerCache.enabled', 'Guardar na memória o começo das conversões e as listas de faixas'],
            ['servers.useLan', 'Usar o servidor do Mac quando a TV não der conta'],
            ['doctor.startOnLanWhenHeavy', 'Começar pelo Mac se a fonte for pesada para a TV'],
            ['devMode.keepAlive', 'Renovar o modo desenvolvedor sozinho']
        ] },
        { title: 'Avisos', titleKey: 'settings.hints', column: 0, items: [
            ['sources.loadingHint', 'Dica "Demorando?" ao carregar'],
            ['restart.resumeHint', 'Aviso "Retomando de..."'],
            ['hints.firstRunToast', 'Aviso de novidades']
        ] },
        { title: 'Depuração', titleKey: 'settings.debug', column: 1, items: [
            ['debug.overlay', 'Mostrar o registro de depuração na tela'],
            ['debug.detail', 'Detalhe do registro', ['essential', 'detailed', 'everything'], DETAIL_LABELS],
            ['debug.logs', 'Abrir registro de depuração', null, null, 'action']
        ] }
    ];
    var panel = null;
    var panelTitle;
    var keysHint;
    var rows = [];
    var groupTitles = [];
    var focus = 0;
    var open = false;
    var changed = false;
    var reloadAfterLogView = false;
    var reloadTimer = null;

    function translated(key, fallback) {
        return window.__twkI18n && window.__twkI18n.t ? window.__twkI18n.t(key) : fallback;
    }

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

    function current(key, options) {
        // Effective value: tweaks.json with the saved choices already applied by index.html
        var parts = key.split('.');
        var section = (window.STREMIO_TWEAKS || {})[parts[0]] || {};
        if (options) return options.indexOf(section[parts[1]]) !== -1 ? section[parts[1]] : options[0];
        return section[parts[1]] !== false;
    }

    function createPanel() {
        // Build the switch list once from GROUPS
        panel = element('div', 'twk-diag twk-diag-grid twk-settings');
        var header = panel.appendChild(element('div', 'twk-diag-header'));
        panelTitle = header.appendChild(element('div', 'twk-diag-title'));
        keysHint = header.appendChild(element('div', 'twk-chip'));
        // The Magic Remote pointer closes the panel with this button, the remote with Back
        header.appendChild(element('div', 'twk-close', '✕')).addEventListener('click', function (e) { e.stopPropagation(); hide(); });
        // Two real columns so Up and Down follow what the viewer sees, Left and Right switch columns
        [0, 1].forEach(function (column) {
            var holder = panel.appendChild(element('div', 'twk-set-column'));
            GROUPS.filter(function (group) { return group.column === column; }).forEach(function (group) {
                var box = holder.appendChild(element('div', 'twk-section'));
                groupTitles.push({ node: box.appendChild(element('div', 'twk-section-title')), key: group.titleKey, fallback: group.title });
                group.items.forEach(function (item) {
                    var row = box.appendChild(element('div', 'twk-set-row'));
                    var label = row.appendChild(element('span', 'twk-set-label'));
                    var value = row.appendChild(element('span', 'twk-set-switch'));
                    var labelKey = item[4] === 'action' ? 'settings.debug.openLog' : item[0] === 'restart.enabled' ? 'settings.restart.enabled' : 'settings.' + item[0];
                    rows.push({ key: item[0], row: row, label: label, labelKey: labelKey, labelFallback: item[1], value: value, on: item[4] === 'action' ? false : current(item[0], item[2]), options: item[2], labels: item[3], action: item[4] === 'action', column: column });
                    // The pointer focuses a row by hovering and switches it with a click
                    var index = rows.length - 1;
                    row.addEventListener('mouseenter', function () { focus = index; paint(); });
                    row.addEventListener('click', function (e) { e.stopPropagation(); focus = index; toggleFocused(); });
                });
            });
        });
        document.body.appendChild(panel);
    }

    function paint() {
        // Show each switch state and the focused row
        panelTitle.textContent = translated('settings.title', 'Ajustes');
        keysHint.textContent = translated('settings.keys', '↑↓ ←→ OK');
        groupTitles.forEach(function (entry) { entry.node.textContent = translated(entry.key, entry.fallback); });
        rows.forEach(function (entry, i) {
            entry.label.textContent = translated(entry.labelKey, entry.labelFallback);
            if (entry.action) {
                entry.value.textContent = translated('settings.open', 'Abrir');
                entry.value.className = 'twk-set-switch twk-good';
            } else if (entry.options) {
                var optionGroup = entry.key === 'simple.quality' ? 'quality' : entry.key === 'debug.detail' ? 'detail' : null;
                entry.value.textContent = optionGroup ? translated('choice.' + optionGroup + '.' + entry.on, entry.labels[entry.on] || entry.on) : entry.labels[entry.on] || entry.on;
                entry.value.className = 'twk-set-switch twk-good';
            } else {
                entry.value.textContent = translated(entry.on ? 'choice.on' : 'choice.off', entry.on ? 'Ligado' : 'Desligado');
                entry.value.className = 'twk-set-switch ' + (entry.on ? 'twk-good' : 'twk-bad');
            }
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
        // Flip the focused switch, or move a choice row to its next value, and save it on the TV
        var entry = rows[focus];
        if (entry.action) {
            if (!window.__twkLogView) return;
            reloadAfterLogView = reloadAfterLogView || changed;
            changed = false;
            if (window.__twkDebug && window.__twkDebug.action) window.__twkDebug.action('settings', 'action', 'Opened debug log viewer');
            window.__twkLogView.open();
            return;
        }
        entry.on = entry.options ? entry.options[(entry.options.indexOf(entry.on) + 1) % entry.options.length] : !entry.on;
        var overrides = readOverrides();
        overrides[entry.key] = entry.on;
        var saved = true;
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides)); } catch (_e) { saved = false; }
        changed = true;
        paint();
        if (window.__twkDebug) {
            var value = entry.options ? entry.on : entry.on ? 'enabled' : 'disabled';
            var message = (saved ? 'Saved setting ' : 'Could not save setting ') + entry.key;
            window.__twkDebug.action('settings', saved ? 'action' : 'warn', saved ? message + ' as ' + value : message);
        }
    }

    function show() {
        // Open the panel on top of any screen
        return Promise.resolve(window.__twkI18n && window.__twkI18n.refresh ? window.__twkI18n.refresh() : null).then(function () {
            if (!panel) createPanel();
            open = true;
            changed = false;
            paint();
            requestAnimationFrame(function () { panel.classList.add('twk-visible'); });
            window.__twkPanels.opened('settings');
        });
    }

    function hide() {
        // Close the panel and reload once so every module starts with the new choices
        open = false;
        panel.classList.remove('twk-visible');
        window.__twkPanels.closed('settings');
        if (!changed) return;
        if (window.__stremioToast) window.__stremioToast.show(translated('settings.applied', 'Ajustes salvos, aplicando…'));
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

    window.__twkPanels.add('settings', function () { if (open) hide(); });
    window.addEventListener('twk-logview-opened', function () {
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = null;
    });
    window.addEventListener('twk-logview-closed', function () {
        if (!reloadAfterLogView) return;
        if (window.__stremioToast) window.__stremioToast.show(translated('settings.applied', 'Ajustes salvos, aplicando…'));
        reloadTimer = setTimeout(function () {
            reloadTimer = null;
            reloadAfterLogView = false;
            location.reload();
        }, 800);
    });
    window.addEventListener('keydown', onKey, true);

    window.__stremioSettings = {
        toggle: function () { return open ? hide() : show(); }
    };
})();
