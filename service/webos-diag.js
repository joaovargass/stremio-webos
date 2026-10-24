// Live diagnostics panel toggled from the player control bar. It shows which
// streaming server is in use, the torrent swarm state, download speed against
// the bitrate the file needs, and the media element buffer. The DOM is built
// once and only text and bar scales change per tick; it polls only while open.
(function () {
    var config = (window.STREMIO_TWEAKS || {}).diagnostics || { refreshMs: 1000 };
    var doctorConfig = (window.STREMIO_TWEAKS || {}).doctor || {};
    var shared = window.__twkShared;
    var element = shared.element;
    var t = window.__twkI18n.t;
    var HLS_URL = /^(https?:\/\/[^/]+)\/hlsv2\//i;
    var LAYOUT = [
        { title: 'diag.health', rows: [['health', 'diag.health'], ['reason', 'diag.reason'], ['total', 'diag.totalBuffer'], ['totalBar'], ['player', 'diag.playerBuffer'], ['ram', 'diag.tvMemory']] },
        { title: 'diag.server', rows: [['server', 'diag.serverUse'], ['version', 'diag.version'], ['limit', 'diag.limitCache'], ['learned', 'diag.learnedSpeed'], ['transcoder', 'diag.hlsConversion'], ['candidates', 'diag.candidates']] },
        { title: 'diag.torrent', rows: [['peers', 'diag.peers'], ['sources', 'diag.sources'], ['speed', 'diag.speed'], ['speedBar'], ['needed', 'diag.needed'], ['transfer', 'diag.transferred'], ['progress', 'diag.file'], ['progressBar']] },
        { title: 'diag.playback', rows: [['video', 'diag.video'], ['position', 'diag.position'], ['buffer', 'diag.bufferAhead'], ['bufferBar'], ['frames', 'diag.droppedFrames'], ['recovery', 'diag.recoveries'], ['subtitle', 'diag.autoSubtitle'], ['error', 'diag.error']] },
        { title: 'diag.pieceMap', wide: true, rows: [['pieceMap', null, 'map']] }
    ];
    var LEGEND = [['done', 'diag.legend.downloaded'], ['many', 'diag.legend.manyPeers'], ['few', 'diag.legend.fewPeers'], ['none', 'diag.legend.noPeers'], ['fetching', 'diag.legend.fetching'], ['mark', 'diag.legend.position']];
    var BUFFER_TARGET_S = 30;
    var PIECE_PARTS = 160;
    var pieceColors = null;
    var pieceSignature = null;
    var view = null;
    var fields = {};
    var sections = {};
    var timer = null;
    var busy = false;
    var serverInfo = {};
    var labels = [];

    function createPanel() {
        // Build the shared frame, then sections, value cells and bars once; a wide section spans both columns
        view = shared.frame('diag', 'twk-panel-grid', close);
        LAYOUT.forEach(function (section) {
            var box = view.root.appendChild(element('div', 'twk-section' + (section.wide ? ' twk-section-wide' : '')));
            labels.push({ node: box.appendChild(element('div', 'twk-section-title', t(section.title))), key: section.title });
            sections[section.title] = box;
            section.rows.forEach(function (row) {
                if (row[2] === 'map') return createPieceMap(box);
                if (row.length === 1) {
                    var bar = box.appendChild(element('div', 'twk-bar'));
                    fields[row[0]] = bar.appendChild(element('div', 'twk-bar-fill'));
                    return;
                }
                var line = box.appendChild(element('div', 'twk-row'));
                labels.push({ node: line.appendChild(element('span', 'twk-label', t(row[1]))), key: row[1] });
                fields[row[0]] = line.appendChild(element('span', 'twk-value', '-'));
            });
        });
    }

    function label(parent, className, key) {
        // A text node that follows the interface language
        var node = parent.appendChild(element('span', className, t(key)));
        labels.push({ node: node, key: key });
        return node;
    }

    function createPieceMap(box) {
        // The whole file as a strip: lane names, the painted lanes with the playhead over them, a time axis and a colour legend
        var map = box.appendChild(element('div', 'twk-pieces'));
        var names = map.appendChild(element('div', 'twk-pieces-names'));
        label(names, 'twk-pieces-name', 'diag.pieceDownloaded');
        label(names, 'twk-pieces-name', 'diag.piecePeers');
        var track = map.appendChild(element('div', 'twk-pieces-track'));
        fields.pieceMap = track.appendChild(element('canvas', 'twk-pieces-canvas'));
        fields.pieceMarker = track.appendChild(element('div', 'twk-pieces-marker'));
        fields.pieceTime = fields.pieceMarker.appendChild(element('span', 'twk-pieces-time'));
        var axis = box.appendChild(element('div', 'twk-pieces-axis'));
        axis.appendChild(element('span', '', '0:00'));
        fields.pieceEnd = axis.appendChild(element('span', '', ''));
        var legend = box.appendChild(element('div', 'twk-pieces-legend'));
        LEGEND.forEach(function (entry) {
            var item = legend.appendChild(element('span', 'twk-legend-item'));
            item.appendChild(element('span', 'twk-swatch twk-swatch-' + entry[0]));
            label(item, '', entry[1]);
        });
    }

    function tokenColors() {
        // The strip paints with the design tokens, read once from the stylesheet
        var css = getComputedStyle(document.documentElement);
        var read = function (name) { return css.getPropertyValue(name).trim(); };
        return { done: read('--twk-accent'), many: read('--twk-good'), few: read('--twk-warn'), none: read('--twk-bad'), empty: read('--twk-line'), fetching: read('--twk-text-soft') };
    }

    function paintPieces(map) {
        // Upper lane: downloaded share of each part, from the bottom up; lower lane: peers holding it; a line under the parts fetched first
        var canvas = fields.pieceMap;
        var ratio = window.devicePixelRatio || 1;
        canvas.width = Math.round(canvas.clientWidth * ratio);
        canvas.height = Math.round(canvas.clientHeight * ratio);
        var ctx = canvas.getContext('2d');
        var colors = pieceColors = pieceColors || tokenColors();
        var gap = Math.max(2, Math.round(canvas.height * 0.06));
        var top = Math.round(canvas.height * 0.52);
        var line = gap;
        var bottom = canvas.height - top - gap - line - gap;
        var width = canvas.width / map.parts.length;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        map.parts.forEach(function (part, i) {
            var x = Math.floor(i * width);
            var w = Math.max(1, Math.ceil(width));
            ctx.fillStyle = colors.empty;
            ctx.fillRect(x, 0, w, top);
            ctx.fillStyle = colors.done;
            ctx.fillRect(x, top * (1 - part[0]), w, top * part[0]);
            ctx.fillStyle = part[1] >= 3 ? colors.many : part[1] >= 1 ? colors.few : colors.none;
            ctx.fillRect(x, top + gap, w, bottom);
        });
        ctx.fillStyle = colors.fetching;
        (map.selections || []).forEach(function (sel) {
            var from = sel[0] / map.pieces * canvas.width;
            ctx.fillRect(from, canvas.height - line, Math.max(ratio, (sel[1] - sel[0] + 1) / map.pieces * canvas.width), line);
        });
    }

    function renderPieces(map, video) {
        // Repaint the lanes only when the map changed; the playhead and the axis follow the video every tick
        var shown = !!(map && map.parts && map.parts.length);
        sections['diag.pieceMap'].style.display = shown ? '' : 'none';
        if (!shown) return;
        var signature = JSON.stringify([map.parts, map.selections]);
        if (signature !== pieceSignature) {
            pieceSignature = signature;
            paintPieces(map);
        }
        var at = video.duration ? video.currentTime / video.duration : 0;
        fields.pieceMarker.style.left = (at * 100).toFixed(2) + '%';
        fields.pieceTime.textContent = shared.duration(video.currentTime);
        fields.pieceEnd.textContent = video.duration ? shared.duration(video.duration) : '';
    }

    function refreshLabels() {
        // Labels follow a language changed in Stremio while the app runs
        labels.forEach(function (entry) { entry.node.textContent = t(entry.key); });
        view.label(t('diag.title'), view.tag.textContent || '…');
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

    function loadServerInfo(key, base) {
        // Fetch the server version once per upstream, through the same-origin base URL
        if (serverInfo[key]) return;
        serverInfo[key] = { version: '...' };
        fetch(base + '/settings').then(function (resp) { return resp.json(); }).then(function (data) {
            var values = data.values || {};
            serverInfo[key] = { version: values.serverVersion, limit: values.btDownloadSpeedHardLimit, cache: values.cacheSize };
        }).catch(function () { serverInfo[key] = { unavailable: true }; });
    }

    function learnedValue(key, present) {
        // A learned speed, how far the learning is while it gathers samples, or that no computer was found
        var rate = shared.learnedRate(key);
        if (rate) return mbps(rate);
        if (!present) return t('diag.noComputer');
        return t('diag.learningSamples', { count: Math.min(shared.savedRate(key).n, shared.learnedMinSamples), total: shared.learnedMinSamples });
    }

    function learnedText() {
        // The speeds the ranking compares sources with, so a lowered 4K is explained
        return t('diag.learnedPair', { tv: learnedValue('twk.tvRate', true), computer: learnedValue('twk.lanRate', window.__stremioLanAvailable === true) });
    }

    function renderServer(origin, proxy, src, hash) {
        // Fill the server section with the server this video really comes from: its own route, else the proxy upstream
        if (!origin) {
            setText('server', src.split('?')[0].replace(/^https?:\/\//, '').slice(0, 60));
            setText('version', '-');
            setText('limit', '-');
            return;
        }
        var routed = proxy && hash && (proxy.routes || {})[hash];
        var real = (routed || (proxy && proxy.upstream) || origin).replace(/\/$/, '');
        // A routed LAN server is asked directly (it allows any origin); the upstream is asked through the proxy
        loadServerInfo(real, routed ? real : origin);
        var info = serverInfo[real] || {};
        var local = /127\.0\.0\.1|localhost/.test(real);
        setText('server', real.replace(/^https?:\/\//, '') + ' ' + (local ? t('diag.server.tv') : routed ? t('diag.server.computerVideo') : t('diag.server.localNetwork')), local ? 'good' : 'warn');
        setText('version', info.unavailable ? t('diag.unavailable') : info.version || '?');
        // Until the server answers its settings every field shows the same loading mark
        var pending = info.version === '...' ? '...' : '?';
        var cache = info.cache === 0 ? t('diag.noCache') : info.cache ? megabytes(info.cache) : pending;
        setText('limit', (info.limit ? mbps(info.limit) : pending) + ' / ' + cache);
    }

    function renderServers(status) {
        // What every video can use, whatever plays now: learned speeds, the converter and the servers found
        setText('learned', learnedText());
        var transcoder = status && status.transcoder;
        // The TV converts with its own ffmpeg; a computer only takes over to go faster
        var tvConverts = transcoder && /127\.0\.0\.1|localhost/.test(transcoder);
        setText('transcoder', transcoder ? transcoder.replace(/^https?:\/\//, '').replace(/\/$/, '') + ' ' + t(tvConverts ? 'diag.server.tv' : 'diag.server.computer') : t('diag.unavailable'), transcoder ? 'good' : 'warn');
        var candidates = status && status.candidates ? Object.keys(status.candidates).map(function (key) {
            return key.replace(/^https?:\/\//, '').replace(/\/$/, '') + (status.candidates[key] ? ' ✓' : ' ✕');
        }).join('  ') : '-';
        setText('candidates', candidates);
    }

    function renderTorrent(stats, video) {
        // Fill the torrent section and compare speed with the needed bitrate
        if (!stats) {
            setText('peers', t('diag.noData'));
            return;
        }
        var needed = stats.streamLen && video.duration ? stats.streamLen / video.duration : 0;
        var margin = needed ? (stats.downloadSpeed || 0) / needed : 0;
        var tone = !needed ? null : margin >= 1.2 ? 'good' : margin >= 1 ? 'warn' : 'bad';
        // A file the server already holds needs no peers and no speed
        var complete = (stats.streamProgress || 0) >= 0.999;
        setText('peers', t('diag.connected', { peers: stats.peers, sending: stats.unchoked }), stats.unchoked || complete ? null : 'bad');
        setText('sources', t('diag.peerSearch', { sources: (stats.sources || []).length, found: window.__twkEvidence.peersFound(stats), attempts: stats.connectionTries || 0 }));
        if (complete) setText('speed', t('diag.fullFile'), 'good');
        else setText('speed', mbps(stats.downloadSpeed) + (needed ? '  (' + margin.toFixed(1) + '×)' : ''), tone);
        setBar('speedBar', complete ? 1 : needed ? margin / 2 : 0, complete ? 'good' : tone);
        // The bitrate needs the file size and the video length, the size needs the torrent metadata
        setText('needed', needed ? mbps(needed) : t(stats.streamLen ? 'diag.neededUnknown' : 'diag.waitingMetadata'));
        setText('transfer', megabytes(stats.downloaded) + ' / ' + megabytes(stats.uploaded));
        setText('progress', stats.streamLen ? t('diag.fileProgress', { percent: window.__twkI18n.number((stats.streamProgress || 0) * 100, 1), size: megabytes(stats.streamLen) }) : t('diag.waitingMetadata'));
        setBar('progressBar', stats.streamProgress || 0);
    }

    function renderPlayback(video) {
        // Fill the playback section from the media element
        var quality = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
        var retry = window.__stremioRetryState || {};
        var ahead = shared.bufferAhead(video);
        var tone = ahead >= 20 ? 'good' : ahead >= 8 ? 'warn' : 'bad';
        setText('video', video.videoWidth ? video.videoWidth + '×' + video.videoHeight : t('diag.loading'));
        setText('position', shared.duration(video.currentTime) + ' / ' + shared.duration(video.duration));
        setText('buffer', ahead.toFixed(0) + ' s', tone);
        setBar('bufferBar', ahead / BUFFER_TARGET_S, tone);
        setText('frames', quality && quality.totalVideoFrames ? quality.droppedVideoFrames + ' / ' + quality.totalVideoFrames : t('diag.framesNotReported'));
        setText('recovery', (retry.retries || 0) + (retry.hlsUrl ? ' · ' + t('diag.hls') : ''), retry.retries ? 'warn' : null);
        var pick = window.__stremioSubPick;
        var synced = window.__stremioSubSync;
        setText('subtitle', (pick ? t(pick.rule.indexOf('embedded') === 0 ? 'diag.embedded' : 'diag.external') + ' · ' + pick.lang + (pick.label ? ' · ' + pick.label : '') : t('diag.noSubtitle')) +
            (synced ? ' · ' + t('diag.synced', { offset: window.__twkI18n.number(synced.offsetMs / 1000, 1) }) : ''));
        setText('error', video.error ? video.error.code + ' · ' + video.error.message : t('diag.none'), video.error ? 'bad' : 'good');
    }

    function renderHealth(video, proxy) {
        // Show the doctor verdict and the buffer split between the player and the TV memory
        var doctor = (window.__stremioDoctor || {}).state || {};
        var ra = proxy && proxy.readAhead;
        var status = doctor.status || 'ok';
        var tone = status === 'ok' ? 'good' : status === 'attention' || status === 'loading' ? 'warn' : 'bad';
        var target = doctorConfig.targetBufferS || 120;
        var player = doctor.playerBufferS !== undefined ? doctor.playerBufferS : shared.bufferAhead(video);
        var total = doctor.totalBufferS !== undefined ? Math.max(doctor.totalBufferS, player) : player;
        setText('health', t('doctor.status.' + status), tone);
        var reasonParts = String(doctor.reason || '').split('|');
        // The first part is the symptom, the next ones say why nothing automatic happens about it
        var reason = reasonParts[0] ? reasonParts.map(function (part) { return t('doctor.reason.' + part); }).join(', ') : '-';
        setText('reason', reason || '-');
        setText('total', t('diag.secondsOf', { value: total.toFixed(0), target: target }), total >= 30 ? 'good' : total >= 10 ? 'warn' : 'bad');
        setBar('totalBar', total / target, total >= 30 ? 'good' : total >= 10 ? 'warn' : 'bad');
        setText('player', player.toFixed(0) + ' s');
        if (!ra || !ra.enabled) return setText('ram', t('diag.off'));
        var ramText = ra.active ? (doctor.ramBufferS || 0).toFixed(0) + ' s · ' + megabytes(ra.aheadBytes) : t('diag.idle');
        setText('ram', t('diag.memoryLimit', { value: ramText, limit: ra.budgetMb }));
    }

    function render() {
        // Skip a tick while the previous refresh is still waiting on the server
        if (busy) return;
        var video = document.querySelector('video');
        if (!video) {
            view.tag.textContent = t('diag.noVideo');
            return;
        }
        var src = video.currentSrc || video.src || '';
        var hls = HLS_URL.exec(src);
        // An HLS conversion of a torrent still reports that torrent swarm and server
        var torrent = shared.sourceTorrent(src);
        var origin = torrent ? torrent[1] : hls ? hls[1] : null;
        view.tag.textContent = hls ? (torrent ? t('diag.hlsTorrent') : t('diag.hls')) : torrent ? t('diag.torrent') : t('diag.directLink');
        sections['diag.torrent'].style.display = torrent ? '' : 'none';
        busy = true;
        Promise.all([
            torrent ? shared.fetchJson(torrent[1] + '/' + torrent[2] + '/' + torrent[3] + '/stats.json') : null,
            shared.fetchJson('/__tweaks/status'),
            torrent ? shared.fetchJson(torrent[1] + '/' + torrent[2] + '/' + torrent[3] + '/pieces.json?buckets=' + PIECE_PARTS) : null
        ]).then(function (results) {
            busy = false;
            renderHealth(video, results[1]);
            renderServer(origin, origin && origin.indexOf(location.host) !== -1 ? results[1] : null, src, torrent ? torrent[2].toLowerCase() : null);
            renderServers(results[1]);
            if (torrent) renderTorrent(results[0], video);
            renderPieces(torrent ? results[2] : null, video);
            renderPlayback(video);
        });
    }

    function open() {
        // Show the panel with its slide-in transition and start polling
        return window.__twkI18n.refresh().then(function () {
            if (!view) createPanel();
            refreshLabels();
            render();
            view.show();
            timer = setInterval(render, config.refreshMs);
        });
    }

    function close() {
        // Stop polling and slide the panel out
        if (timer) clearInterval(timer);
        timer = null;
        if (view) view.hide();
    }

    function onRouteChange() {
        // Leaving the player route closes the panel
        if ((location.hash || '').indexOf('#/player') !== 0) close();
    }

    // The app router navigates with pushState and announces it as historyChange
    window.addEventListener('hashchange', onRouteChange);
    window.addEventListener('historyChange', onRouteChange);

    window.__stremioDiag = {
        toggle: function () { return timer ? close() : open(); },
        close: close
    };
})();
