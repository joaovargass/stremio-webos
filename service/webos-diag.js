// Live diagnostics panel toggled from the player control bar. It shows which
// streaming server is in use, the torrent swarm state, download speed against
// the bitrate the file needs, and the media element buffer. The DOM is built
// once and only text and bar scales change per tick; it polls only while open.
(function () {
    var config = (window.STREMIO_TWEAKS || {}).diagnostics || { refreshMs: 1000 };
    var doctorConfig = (window.STREMIO_TWEAKS || {}).doctor || {};
    var HLS_URL = /^(https?:\/\/[^/]+)\/hlsv2\//i;
    var LAYOUT = [
        { title: 'Saúde', rows: [['health', 'Estado'], ['reason', 'Motivo'], ['total', 'Buffer total'], ['totalBar'], ['player', 'No player'], ['ram', 'Na memória da TV']] },
        { title: 'Servidor', rows: [['server', 'Em uso'], ['version', 'Versão'], ['limit', 'Limite / cache'], ['learned', 'Velocidade aprendida'], ['transcoder', 'Conversão HLS'], ['candidates', 'Candidatos']] },
        { title: 'Torrent', rows: [['peers', 'Peers'], ['sources', 'Fontes'], ['speed', 'Velocidade'], ['speedBar'], ['needed', 'Necessário'], ['transfer', 'Baixado / enviado'], ['progress', 'Arquivo'], ['progressBar']] },
        { title: 'Reprodução', rows: [['video', 'Vídeo'], ['position', 'Posição'], ['buffer', 'Buffer à frente'], ['bufferBar'], ['frames', 'Frames perdidos'], ['recovery', 'Recuperações'], ['subtitle', 'Legenda automática'], ['error', 'Erro']] }
    ];
    var BUFFER_TARGET_S = 30;
    var panel = null;
    var chip = null;
    var fields = {};
    var sections = {};
    var timer = null;
    var busy = false;
    var serverInfo = {};

    function element(tag, className, text) {
        // Small DOM helper used to build the panel once
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
    }

    function createPanel() {
        // Build header, sections, value cells and bars once
        panel = element('div', 'twk-diag twk-diag-grid');
        var header = element('div', 'twk-diag-header');
        header.appendChild(element('div', 'twk-diag-title', 'Diagnóstico'));
        chip = header.appendChild(element('div', 'twk-chip', '...'));
        // The Magic Remote pointer closes the panel with this button, the remote with Back
        header.appendChild(element('div', 'twk-close', '✕')).addEventListener('click', function (e) { e.stopPropagation(); close(); });
        panel.appendChild(header);
        LAYOUT.forEach(function (section) {
            var box = panel.appendChild(element('div', 'twk-section'));
            box.appendChild(element('div', 'twk-section-title', section.title));
            sections[section.title] = box;
            section.rows.forEach(function (row) {
                if (row.length === 1) {
                    var bar = box.appendChild(element('div', 'twk-bar'));
                    fields[row[0]] = bar.appendChild(element('div', 'twk-bar-fill'));
                    return;
                }
                var line = box.appendChild(element('div', 'twk-row'));
                line.appendChild(element('span', 'twk-label', row[1]));
                fields[row[0]] = line.appendChild(element('span', 'twk-value', '-'));
            });
        });
        document.body.appendChild(panel);
    }

    function setText(key, text, tone) {
        // Update one value cell and its colour tone
        var node = fields[key];
        node.textContent = text;
        // Sentences such as the doctor reason wrap instead of being cut
        node.className = 'twk-value' + (key === 'reason' ? ' twk-wrap' : '') + (tone ? ' twk-' + tone : '');
    }

    function setBar(key, ratio, tone) {
        // Scale a bar between 0 and 1 and colour it by tone
        var node = fields[key];
        node.style.transform = 'scaleX(' + Math.max(0, Math.min(1, ratio || 0)).toFixed(3) + ')';
        node.className = 'twk-bar-fill' + (tone ? ' twk-' + tone : '');
    }

    function mbps(bytesPerSecond) {
        // Format a byte rate as megabits per second
        return ((bytesPerSecond || 0) * 8 / 1e6).toFixed(1) + ' Mbps';
    }

    function megabytes(bytes) {
        // Format a byte count as megabytes or gigabytes
        var mb = (bytes || 0) / 1e6;
        return mb >= 1000 ? (mb / 1000).toFixed(1) + ' GB' : mb.toFixed(0) + ' MB';
    }

    function clock(seconds) {
        // Format seconds as h:mm:ss
        var s = Math.max(0, Math.floor(seconds || 0));
        var h = Math.floor(s / 3600);
        var m = Math.floor(s % 3600 / 60);
        return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + ((s % 60) < 10 ? '0' : '') + (s % 60);
    }

    function bufferAhead(video) {
        // Seconds of media buffered past the playhead
        for (var i = 0; i < video.buffered.length; i++) {
            if (video.buffered.start(i) <= video.currentTime && video.buffered.end(i) >= video.currentTime) {
                return video.buffered.end(i) - video.currentTime;
            }
        }
        return 0;
    }

    function loadServerInfo(key, base) {
        // Fetch the server version once per upstream, through the same-origin base URL
        if (serverInfo[key]) return;
        serverInfo[key] = { version: '...' };
        fetch(base + '/settings').then(function (resp) { return resp.json(); }).then(function (data) {
            var values = data.values || {};
            serverInfo[key] = { version: values.serverVersion, limit: values.btDownloadSpeedHardLimit, cache: values.cacheSize };
        }).catch(function () { serverInfo[key] = { version: 'indisponível' }; });
    }

    function fetchJson(target) {
        // Same time-limited fetch as the doctor, so a slow server never freezes the panel
        return window.__stremioDoctor.fetchJson(target);
    }

    function learnedRate(key) {
        // What the doctor learned one server delivers, or null while it is still learning
        try {
            var saved = JSON.parse(localStorage.getItem(key) || 'null');
            return saved && saved.n >= 30 ? saved.rate : null;
        } catch (_e) {
            return null;
        }
    }

    function learnedText() {
        // The speeds the ranking compares sources with, so a lowered 4K is explained
        var tv = learnedRate('twk.tvRate');
        var lan = learnedRate('twk.lanRate');
        return 'TV ' + (tv ? mbps(tv) : 'aprendendo') + ' · Mac ' + (lan ? mbps(lan) : 'aprendendo');
    }

    function renderServer(origin, proxy, src, hash) {
        // Fill the server section with the server this video really comes from: its own route, else the proxy upstream
        if (!origin) {
            setText('server', src.split('?')[0].replace(/^https?:\/\//, '').slice(0, 60));
            ['version', 'limit', 'learned', 'transcoder', 'candidates'].forEach(function (key) { setText(key, '-'); });
            return;
        }
        var routed = proxy && hash && (proxy.routes || {})[hash];
        var real = (routed || (proxy && proxy.upstream) || origin).replace(/\/$/, '');
        // A routed LAN server is asked directly (it allows any origin); the upstream is asked through the proxy
        loadServerInfo(real, routed ? real : origin);
        var info = serverInfo[real] || {};
        var local = /127\.0\.0\.1|localhost/.test(real);
        setText('server', real.replace(/^https?:\/\//, '') + (local ? ' (TV)' : routed ? ' (Mac, só este vídeo)' : ' (rede local)'), local ? 'good' : 'warn');
        setText('version', info.version || '?');
        var cache = info.cache === 0 ? 'sem cache' : info.cache ? megabytes(info.cache) : '?';
        setText('limit', (info.limit ? mbps(info.limit) : '?') + ' / ' + cache);
        setText('learned', learnedText());
        var transcoder = proxy && proxy.transcoder;
        setText('transcoder', transcoder ? transcoder.replace(/^https?:\/\//, '').replace(/\/$/, '') : 'indisponível (sem Mac)', transcoder ? 'good' : 'warn');
        var candidates = proxy && proxy.candidates ? Object.keys(proxy.candidates).map(function (key) {
            return key.replace(/^https?:\/\//, '').replace(/\/$/, '') + (proxy.candidates[key] ? ' ✓' : ' ✕');
        }).join('  ') : '-';
        setText('candidates', candidates);
    }

    function renderTorrent(stats, video) {
        // Fill the torrent section and compare speed with the needed bitrate
        if (!stats) {
            setText('peers', 'sem dados');
            return;
        }
        var needed = stats.streamLen && video.duration ? stats.streamLen / video.duration : 0;
        var margin = needed ? (stats.downloadSpeed || 0) / needed : 0;
        var tone = !needed ? null : margin >= 1.2 ? 'good' : margin >= 1 ? 'warn' : 'bad';
        // A file the server already holds needs no peers and no speed
        var complete = (stats.streamProgress || 0) >= 0.999;
        setText('peers', stats.peers + ' conectados · ' + stats.unchoked + ' enviando', stats.unchoked || complete ? null : 'bad');
        setText('sources', ((stats.sources || []).length || 'DHT') + ' · ' + (stats.connectionTries || 0) + ' tentativas');
        if (complete) setText('speed', 'arquivo completo no servidor', 'good');
        else setText('speed', mbps(stats.downloadSpeed) + (needed ? '  (' + margin.toFixed(1) + '×)' : ''), tone);
        setBar('speedBar', complete ? 1 : needed ? margin / 2 : 0, complete ? 'good' : tone);
        setText('needed', needed ? mbps(needed) : '?');
        setText('transfer', megabytes(stats.downloaded) + ' / ' + megabytes(stats.uploaded));
        setText('progress', ((stats.streamProgress || 0) * 100).toFixed(1) + '% de ' + megabytes(stats.streamLen));
        setBar('progressBar', stats.streamProgress || 0);
    }

    function renderPlayback(video) {
        // Fill the playback section from the media element
        var quality = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
        var retry = window.__stremioRetryState || {};
        var ahead = bufferAhead(video);
        var tone = ahead >= 20 ? 'good' : ahead >= 8 ? 'warn' : 'bad';
        setText('video', video.videoWidth ? video.videoWidth + '×' + video.videoHeight : 'carregando');
        setText('position', clock(video.currentTime) + ' / ' + clock(video.duration));
        setText('buffer', ahead.toFixed(0) + ' s', tone);
        setBar('bufferBar', ahead / BUFFER_TARGET_S, tone);
        setText('frames', quality && quality.totalVideoFrames ? quality.droppedVideoFrames + ' de ' + quality.totalVideoFrames : 'n/d (hardware)');
        setText('recovery', (retry.retries || 0) + (retry.hlsUrl ? ' · modo HLS' : ''), retry.retries ? 'warn' : null);
        var pick = window.__stremioSubPick;
        var synced = window.__stremioSubSync;
        setText('subtitle', (pick ? (pick.rule.indexOf('embedded') === 0 ? 'embutida · ' : 'externa · ') + pick.lang + (pick.label ? ' · ' + pick.label : '') : 'nenhuma') +
            (synced ? ' · sincronizada ' + (synced.offsetMs / 1000).toFixed(1) + ' s' : ''));
        setText('error', video.error ? video.error.code + ' · ' + video.error.message : 'nenhum', video.error ? 'bad' : 'good');
    }

    function renderHealth(video, proxy) {
        // Show the doctor verdict and the buffer split between the player and the TV memory
        var doctor = (window.__stremioDoctor || {}).state || {};
        var ra = proxy && proxy.readAhead;
        var status = doctor.status || 'ok';
        var tone = status === 'ok' ? 'good' : status === 'atenção' || status === 'carregando' ? 'warn' : 'bad';
        var target = doctorConfig.targetBufferS || 120;
        var player = doctor.playerBufferS !== undefined ? doctor.playerBufferS : bufferAhead(video);
        var total = doctor.totalBufferS !== undefined ? Math.max(doctor.totalBufferS, player) : player;
        setText('health', status, tone);
        setText('reason', doctor.reason || '-');
        setText('total', total.toFixed(0) + ' s de ' + target + ' s', total >= 30 ? 'good' : total >= 10 ? 'warn' : 'bad');
        setBar('totalBar', total / target, total >= 30 ? 'good' : total >= 10 ? 'warn' : 'bad');
        setText('player', player.toFixed(0) + ' s');
        if (!ra || !ra.enabled) return setText('ram', 'desligado');
        var ramText = ra.active ? (doctor.ramBufferS || 0).toFixed(0) + ' s · ' + megabytes(ra.aheadBytes) : 'ocioso';
        setText('ram', ramText + ' (limite ' + ra.budgetMb + ' MB)');
    }

    function render() {
        // Skip a tick while the previous refresh is still waiting on the server
        if (busy) return;
        var video = document.querySelector('video');
        if (!video) {
            chip.textContent = 'sem vídeo';
            return;
        }
        var src = video.currentSrc || video.src || '';
        var hls = HLS_URL.exec(src);
        // An HLS conversion of a torrent still reports that torrent swarm and server
        var torrent = window.__stremioDoctor.sourceTorrent(src);
        var origin = torrent ? torrent[1] : hls ? hls[1] : null;
        chip.textContent = hls ? (torrent ? 'HLS · torrent' : 'HLS') : torrent ? 'torrent' : 'link direto';
        sections.Torrent.style.display = torrent ? '' : 'none';
        busy = true;
        Promise.all([
            torrent ? fetchJson(torrent[1] + '/' + torrent[2] + '/' + torrent[3] + '/stats.json') : null,
            fetchJson('/__tweaks/status')
        ]).then(function (results) {
            busy = false;
            renderHealth(video, results[1]);
            renderServer(origin, origin && origin.indexOf(location.host) !== -1 ? results[1] : null, src, torrent ? torrent[2].toLowerCase() : null);
            if (torrent) renderTorrent(results[0], video);
            renderPlayback(video);
        });
    }

    function open() {
        // Show the panel with its slide-in transition and start polling
        if (!panel) createPanel();
        render();
        requestAnimationFrame(function () { panel.classList.add('twk-visible'); });
        timer = setInterval(render, config.refreshMs);
        window.__twkPanels.opened('diag');
    }

    function close() {
        // Stop polling and slide the panel out
        if (timer) clearInterval(timer);
        timer = null;
        if (panel) panel.classList.remove('twk-visible');
        window.__twkPanels.closed('diag');
    }

    function onRouteChange() {
        // Leaving the player route closes the panel
        if ((location.hash || '').indexOf('#/player') !== 0) close();
    }

    // The app router navigates with pushState and announces it as historyChange
    window.addEventListener('hashchange', onRouteChange);
    window.addEventListener('historyChange', onRouteChange);

    window.__twkPanels.add('diag', close);
    window.__stremioDiag = {
        toggle: function () { return timer ? close() : open(); },
        close: close
    };
})();
