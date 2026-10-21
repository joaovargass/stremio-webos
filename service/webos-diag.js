// Live diagnostics panel toggled from the player control bar. It shows which
// streaming server is in use, the torrent swarm state, download speed against
// the bitrate the file needs, and the media element buffer. The DOM is built
// once and only text and bar scales change per tick; it polls only while open.
(function () {
    var config = (window.STREMIO_TWEAKS || {}).diagnostics || { refreshMs: 1000 };
    var TORRENT_URL = /^(https?:\/\/[^/]+)\/([0-9a-f]{40})\/(\d+)/i;
    var HLS_URL = /^(https?:\/\/[^/]+)\/hlsv2\//i;
    var LAYOUT = [
        { title: 'Servidor', rows: [['server', 'Em uso'], ['version', 'Versão'], ['limit', 'Limite / cache'], ['candidates', 'Candidatos']] },
        { title: 'Torrent', rows: [['peers', 'Peers'], ['sources', 'Fontes'], ['speed', 'Velocidade'], ['speedBar'], ['needed', 'Necessário'], ['transfer', 'Baixado / enviado'], ['progress', 'Arquivo'], ['progressBar']] },
        { title: 'Reprodução', rows: [['video', 'Vídeo'], ['position', 'Posição'], ['buffer', 'Buffer à frente'], ['bufferBar'], ['frames', 'Frames perdidos'], ['recovery', 'Recuperações'], ['error', 'Erro']] }
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
        panel = element('div', 'twk-diag');
        var header = element('div', 'twk-diag-header');
        header.appendChild(element('div', 'twk-diag-title', 'Diagnóstico'));
        chip = header.appendChild(element('div', 'twk-chip', '...'));
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
        node.className = 'twk-value' + (tone ? ' twk-' + tone : '');
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
        // Fetch JSON and resolve null on any failure
        return fetch(target).then(function (resp) { return resp.json(); }).catch(function () { return null; });
    }

    function renderServer(origin, proxy, src) {
        // Fill the server section, resolving the proxy upstream
        if (!origin) {
            setText('server', src.split('?')[0].replace(/^https?:\/\//, '').slice(0, 60));
            ['version', 'limit', 'candidates'].forEach(function (key) { setText(key, '-'); });
            return;
        }
        var real = proxy && proxy.upstream ? proxy.upstream.replace(/\/$/, '') : origin;
        loadServerInfo(real, origin);
        var info = serverInfo[real] || {};
        var local = /127\.0\.0\.1|localhost/.test(real);
        setText('server', real.replace(/^https?:\/\//, '') + (local ? ' (TV)' : ' (rede local)'), local ? 'warn' : 'good');
        setText('version', info.version || '?');
        var cache = info.cache === 0 ? 'sem cache' : info.cache ? megabytes(info.cache) : '?';
        setText('limit', (info.limit ? mbps(info.limit) : '?') + ' / ' + cache);
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
        setText('peers', stats.peers + ' conectados · ' + stats.unchoked + ' enviando', stats.unchoked ? null : 'bad');
        setText('sources', ((stats.sources || []).length || 'DHT') + ' · ' + (stats.connectionTries || 0) + ' tentativas');
        setText('speed', mbps(stats.downloadSpeed) + (needed ? '  (' + margin.toFixed(1) + '×)' : ''), tone);
        setBar('speedBar', needed ? margin / 2 : 0, tone);
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
        setText('error', video.error ? video.error.code + ' · ' + video.error.message : 'nenhum', video.error ? 'bad' : 'good');
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
        var torrent = TORRENT_URL.exec(src);
        var hls = HLS_URL.exec(src);
        var origin = torrent ? torrent[1] : hls ? hls[1] : null;
        chip.textContent = torrent ? 'torrent' : hls ? 'HLS' : 'link direto';
        sections.Torrent.style.display = torrent ? '' : 'none';
        busy = true;
        Promise.all([
            torrent ? fetchJson(torrent[1] + '/' + torrent[2] + '/' + torrent[3] + '/stats.json') : null,
            origin && origin.indexOf(location.host) !== -1 ? fetchJson('/__tweaks/status') : null
        ]).then(function (results) {
            busy = false;
            renderServer(origin, results[1], src);
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
    }

    function close() {
        // Stop polling and slide the panel out
        if (timer) clearInterval(timer);
        timer = null;
        if (panel) panel.classList.remove('twk-visible');
    }

    // Leaving the player route closes the panel
    window.addEventListener('hashchange', function () {
        if ((location.hash || '').indexOf('#/player') !== 0) close();
    });

    window.__stremioDiag = {
        toggle: function () { return timer ? close() : open(); }
    };
})();
