// Shared building blocks of the webOS tweaks, loaded before every other tweak script: the panel stack that owns
// Back, the panel frame with its close button, the notice toast, and the helpers several modules need (time
// formats, time-limited JSON requests, torrent URLs, learned server speeds).
(function () {
    var tweaks = window.STREMIO_TWEAKS || {};
    var BACK_KEYS = [461, 27, 8];
    var TORRENT_URL = /^(https?:\/\/[^/]+)\/([0-9a-f]{40})\/(\d+)/i;
    var LEARNED_MIN_SAMPLES = 30;
    var closers = {};
    var stack = [];
    var notice = null;
    var noticeText = null;
    var noticeTimer = null;
    var noticeFrame = null;
    var noticeId = 0;

    function publish() {
        // The top panel is published on the page, so a panel left below a stacked one stops being drawn under it
        document.documentElement.setAttribute('data-twk-top', stack.length ? stack[stack.length - 1] : '');
    }

    var panels = {
        add: function (name, close) {
            // Each panel registers how it closes, so Back and a newly opened panel can close it
            closers[name] = close;
        },
        opened: function (name, stacked) {
            // A stacked panel sits above the current one; any other panel replaces every open panel
            if (!stacked) {
                stack.slice().reverse().forEach(function (active) {
                    if (active !== name && closers[active]) closers[active]();
                });
                stack = [];
            }
            stack = stack.filter(function (active) { return active !== name; });
            stack.push(name);
            publish();
        },
        closed: function (name) {
            // A closed panel leaves the stack wherever it was
            stack = stack.filter(function (active) { return active !== name; });
            publish();
        },
        current: function () {
            // The panel on top, the one Back closes
            return stack.length ? stack[stack.length - 1] : null;
        },
        closeCurrent: function () {
            // Close only the top panel
            var name = panels.current();
            if (name && closers[name]) closers[name]();
        }
    };

    function element(tag, className, text) {
        // DOM node with a class and a text, the way every tweak builds its interface
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function button(className, text, onPress) {
        // The one button of the tweaks: OK on the remote and a pointer click both press it
        var node = element('button', 'twk-button' + (className ? ' ' + className : ''), text);
        node.type = 'button';
        node.addEventListener('click', function (event) {
            event.stopPropagation();
            onPress(event);
        });
        return node;
    }

    function frame(name, className, onClose) {
        // A panel on the stack: header with title, key or state tag and close button; the body belongs to the caller
        var root = element('section', 'twk-panel' + (className ? ' ' + className : ''));
        root.setAttribute('role', 'dialog');
        var header = root.appendChild(element('header', 'twk-panel-header'));
        var title = header.appendChild(element('div', 'twk-panel-title'));
        var tag = header.appendChild(element('span', 'twk-tag'));
        var close = header.appendChild(button('twk-button-icon', '✕', onClose));
        document.body.appendChild(root);
        panels.add(name, onClose);
        return {
            root: root,
            header: header,
            tag: tag,
            close: close,
            label: function (titleText, tagText) {
                // Texts follow the current language every time the panel opens
                title.textContent = titleText;
                root.setAttribute('aria-label', titleText);
                tag.textContent = tagText || '';
                tag.hidden = !tagText;
                close.setAttribute('aria-label', window.__twkI18n.t('panel.close'));
            },
            show: function (stacked, onShown) {
                // Join the stack at once and slide in on the next frame, so a panel built in this frame still animates
                panels.opened(name, stacked);
                requestAnimationFrame(function () {
                    root.classList.add('twk-visible');
                    // Controls take the focus only once visible; an invisible control refuses it
                    if (onShown) onShown();
                });
            },
            hide: function () {
                // A hidden panel keeps no focus, so a later key never lands on a control nobody sees
                if (root.contains(document.activeElement)) document.activeElement.blur();
                root.classList.remove('twk-visible');
                panels.closed(name);
            }
        };
    }

    function hideNotice(id) {
        // Slide the toast out, only when the notice it shows is the one asked about; it stays built for the next notice
        if (id !== undefined && id !== noticeId) return;
        clearTimeout(noticeTimer);
        cancelAnimationFrame(noticeFrame);
        noticeTimer = null;
        if (notice) notice.classList.remove('twk-visible');
    }

    function notify(text, hideAfterMs) {
        // One notice at a time: a later one replaces the text and the timer, and without a time it stays until hidden
        if (!notice) {
            notice = element('div', 'twk-toast');
            notice.setAttribute('role', 'status');
            notice.appendChild(element('span', 'twk-pulse'));
            noticeText = notice.appendChild(element('span'));
            document.body.appendChild(notice);
        }
        noticeText.textContent = text;
        var id = ++noticeId;
        clearTimeout(noticeTimer);
        noticeTimer = hideAfterMs ? setTimeout(function () { hideNotice(id); }, hideAfterMs) : null;
        cancelAnimationFrame(noticeFrame);
        noticeFrame = requestAnimationFrame(function () { notice.classList.add('twk-visible'); });
        return id;
    }

    function pad(value) {
        // Two digits for clock fields
        return String(value).padStart(2, '0');
    }

    function timeOfDay(at) {
        // Local time with seconds, for log lines
        var date = new Date(at);
        return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
    }

    function duration(seconds) {
        // A playback position as h:mm:ss, or m:ss under an hour
        var total = Math.max(0, Math.floor(seconds || 0));
        var hours = Math.floor(total / 3600);
        var minutes = Math.floor(total % 3600 / 60);
        return (hours ? hours + ':' + pad(minutes) : minutes) + ':' + pad(total % 60);
    }

    function fetchJson(target, timeoutMs) {
        // JSON or null on any failure; a server holding the request (a torrent without metadata) must not freeze the caller
        var controller = new AbortController();
        var timer = setTimeout(function () { controller.abort(); }, timeoutMs || (tweaks.doctor || {}).requestTimeoutMs || 4000);
        return fetch(target, { signal: controller.signal })
            .then(function (response) { return response.json(); })
            .catch(function () { return null; })
            .then(function (body) {
                clearTimeout(timer);
                return body;
            });
    }

    function whenCoreReady(callback) {
        // The core bridge is created asynchronously by main.js
        if (window.core && typeof window.core.getState === 'function') return callback(window.core);
        setTimeout(function () { whenCoreReady(callback); }, 500);
    }

    function savedRate(key) {
        // Download rate the doctor learned for one server ('twk.tvRate', 'twk.lanRate'): bytes per second and sample count
        try {
            return JSON.parse(localStorage.getItem(key) || 'null') || { rate: 0, n: 0 };
        } catch (_e) {
            return { rate: 0, n: 0 };
        }
    }

    function learnedRate(key) {
        // The learned rate once enough samples exist, else null while the doctor is still learning
        var saved = savedRate(key);
        return saved.n >= LEARNED_MIN_SAMPLES ? saved.rate : null;
    }

    function onPlayer() {
        // Most tweaks act only on the player route
        return (location.hash || '').indexOf('#/player') === 0;
    }

    function torrentOf(url) {
        // A torrent file URL of a streaming server split into server, info hash and file index
        return TORRENT_URL.exec(url || '');
    }

    function sourceTorrent(src) {
        // The torrent behind a video, also while the TV plays an HLS conversion of it
        var direct = torrentOf(src);
        if (direct) return direct;
        var media = /[?&]mediaURL=([^&]+)/.exec(src || '');
        return media && /\/hlsv2\//.test(src) ? torrentOf(decodeURIComponent(media[1])) : null;
    }

    function bufferAhead(video) {
        // Seconds the media element holds past the playhead
        for (var i = 0; i < video.buffered.length; i++) {
            if (video.buffered.start(i) <= video.currentTime && video.buffered.end(i) >= video.currentTime) {
                return video.buffered.end(i) - video.currentTime;
            }
        }
        return 0;
    }

    function resolution(text) {
        // Vertical pixel count a release names, 0 when it names none
        var words = String(text || '').toLowerCase();
        if (/2160p|\b4k\b|\buhd\b/.test(words)) return 2160;
        if (/1080p|\bfhd\b/.test(words)) return 1080;
        if (/720p/.test(words)) return 720;
        if (/480p|\bsd\b/.test(words)) return 480;
        return 0;
    }

    // Back closes the top panel before the app sees the key, so it never leaves the screen behind the panel
    window.addEventListener('keydown', function (event) {
        if (!panels.current() || BACK_KEYS.indexOf(event.keyCode) === -1) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        panels.closeCurrent();
    }, true);

    window.__twkPanels = panels;
    window.__twkShared = {
        element: element,
        button: button,
        frame: frame,
        notify: notify,
        hideNotice: hideNotice,
        timeOfDay: timeOfDay,
        duration: duration,
        fetchJson: fetchJson,
        whenCoreReady: whenCoreReady,
        savedRate: savedRate,
        learnedRate: learnedRate,
        onPlayer: onPlayer,
        torrentOf: torrentOf,
        sourceTorrent: sourceTorrent,
        bufferAhead: bufferAhead,
        resolution: resolution
    };
})();
