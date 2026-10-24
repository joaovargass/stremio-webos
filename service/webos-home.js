// Screens of the Netflix-like layer: Home, Series and Movies (a billboard carousel with the trailer playing behind the
// title, then rows of titles with the focused title shown large above them) and My List. Rows come from the
// recommendation engine (webos-recs.js) and Continue Watching from the Stremio core. Parameters come from
// window.STREMIO_TWEAKS.netflix.
(function () {
    var config = (window.STREMIO_TWEAKS || {}).netflix || {};
    var shared = window.__twkShared;
    var element = shared.element;
    var t = window.__twkI18n.t;
    var KEYS = { left: 37, up: 38, right: 39, down: 40, enter: 13, back: 461, escape: 27 };
    var YOUTUBE = 'https://www.youtube-nocookie.com/embed/';

    function readJson(key) {
        // Page storage the core keeps, or nothing when it is unavailable
        try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_e) { return null; }
    }

    function continueRow(type) {
        // Titles the viewer is in the middle of, with their progress and the link that resumes them
        return window.core.getState('continue_watching_preview').then(function (state) {
            var items = ((state && state.items) || []).filter(function (item) { return /^tt\d+/.test(item._id) && (!type || item.type === type); });
            return Promise.all(items.slice(0, 20).map(function (item) {
                return window.__twkRecs.metaOf(item.type, item._id).then(function (meta) {
                    return meta && meta.genres.length ? { meta: meta, progress: item.progress, link: (item.deepLinks || {}).player || (item.deepLinks || {}).metaDetailsStreams } : null;
                });
            }));
        }).then(function (entries) {
            var items = entries.filter(Boolean);
            return items.length ? { key: 'continue', title: t('netflix.continue'), items: items } : null;
        }).catch(function () { return null; });
    }

    function myListRows() {
        // The Stremio library as rows of a grid, newest first
        var library = readJson('library_recent') || {};
        var items = Object.keys(library.items || {}).map(function (key) { return library.items[key]; }).filter(function (item) {
            return item && !item.removed && !item.temp && /^tt\d+/.test(item._id);
        }).sort(function (a, b) { return (Date.parse(b._mtime) || 0) - (Date.parse(a._mtime) || 0); });
        return Promise.all(items.map(function (item) { return window.__twkRecs.metaOf(item.type, item._id); })).then(function (metas) {
            var entries = metas.filter(Boolean).map(function (meta) { return { meta: meta }; });
            var rows = [];
            for (var i = 0; i < entries.length; i += 6) rows.push({ key: 'mylist:' + i, title: i ? '' : t('netflix.menu.mylist'), items: entries.slice(i, i + 6) });
            return { billboard: [], rows: rows };
        });
    }

    function loadPage(name, params, quick) {
        // The page of a screen: title details, My List from the library, the others from the engine with Continue Watching on top
        if (name === 'details') return window.__twkDetails.load(params.type, params.id);
        if (name === 'mylist') return myListRows();
        var type = name === 'home' ? null : name;
        var recs = window.__twkRecs;
        return Promise.all([quick ? recs.quickPage(type || 'home') : recs.pageFor(type || 'home'), continueRow(type)]).then(function (results) {
            var page = results[0];
            if (results[1]) page.rows.unshift(results[1]);
            return page;
        });
    }

    function metaLine(meta) {
        // Year, rating and genres in one short line, like the billboard of Netflix
        var parts = [meta.releaseInfo || meta.year, meta.rating ? 'IMDb ' + meta.rating : '', meta.genres.slice(0, 3).map(window.__twkRecs.genreName).join(' · ')];
        return parts.filter(Boolean).join('   ');
    }

    window.__twkScreens = {
        create: function (name, container, shell, params) {
            return new Screen(name, container, shell, params || {});
        }
    };

    function Screen(name, container, shell, params) {
        this.name = name;
        this.params = params;
        this.shell = shell;
        this.mode = 'billboard';
        this.button = 0;
        this.slide = 0;
        this.row = 0;
        this.cols = {};
        this.page = { billboard: [], rows: [] };
        this.timers = {};
        this.alive = true;
        this.build(container);
        var self = this;
        var complete = false;
        // Browsing screens show the popular rows at once; the personal page replaces them when it is ready
        if (name !== 'details' && name !== 'mylist') {
            loadPage(name, params, true).then(function (page) { if (self.alive && !complete) self.setPage(page); }).catch(function () {});
        }
        loadPage(name, params, false).then(function (page) {
            complete = true;
            if (self.alive) self.setPage(page);
        }).catch(function (error) {
            console.warn('[netflix] the', name, 'screen could not load its rows:', error && error.message || error);
            if (!self.page.rows.length) self.status.textContent = t('netflix.loadFailed');
        });
    }

    Screen.prototype.setPage = function (page) {
        // Draw a page, keeping the viewer's place when it replaces a quicker one
        var self = this;
        var first = !this.page.rows.length && !this.page.billboard.length;
        this.page = page;
        page.onButtons = function () { self.renderButtons(); self.paint(); };
        this.renderButtons();
        this.rowsBox.textContent = '';
        this.renderRows();
        // The rows changed, so positions inside them start over; the row the viewer was on stays
        this.cols = {};
        this.row = Math.min(this.row, Math.max(0, page.rows.length - 1));
        if (first || this.mode === 'billboard' || !page.rows.length) {
            this.mode = page.billboard.length ? 'billboard' : 'rows';
            this.showSlide(first ? 0 : Math.min(this.slide, page.billboard.length - 1));
        }
        this.paint();
    };

    Screen.prototype.build = function (container) {
        // The hero area (art, trailer, title, buttons) and the rows under it, built once per screen
        this.root = container.appendChild(element('section', 'twk-nf-screen'));
        var hero = this.hero = this.root.appendChild(element('div', 'twk-nf-hero'));
        this.art = hero.appendChild(element('div', 'twk-nf-art'));
        this.trailer = hero.appendChild(element('div', 'twk-nf-trailer'));
        hero.appendChild(element('div', 'twk-nf-shade'));
        var info = hero.appendChild(element('div', 'twk-nf-info'));
        this.logo = info.appendChild(element('img', 'twk-nf-logo'));
        this.titleText = info.appendChild(element('div', 'twk-nf-title'));
        this.line = info.appendChild(element('div', 'twk-nf-line'));
        this.synopsis = info.appendChild(element('div', 'twk-nf-synopsis'));
        this.buttonBox = info.appendChild(element('div', 'twk-nf-buttons'));
        this.buttonNodes = [];
        this.dots = info.appendChild(element('div', 'twk-nf-dots'));
        this.status = this.root.appendChild(element('div', 'twk-nf-status', t('netflix.loading')));
        this.rowsBox = this.root.appendChild(element('div', 'twk-nf-rows'));
        this.logo.addEventListener('error', function () { this.style.display = 'none'; });
    };

    Screen.prototype.renderButtons = function () {
        // The buttons of the billboard: Play and More info on browsing screens, the page's own on title details
        var self = this;
        this.actions = this.page.buttons || [
            { label: t('netflix.play'), run: function () { self.open(true); } },
            { label: t('netflix.moreInfo'), run: function () { self.open(false); } }
        ];
        this.buttonBox.textContent = '';
        this.buttonNodes = this.actions.map(function (action, i) {
            var node = self.buttonBox.appendChild(element('div', 'twk-nf-button', action.label));
            node.addEventListener('mouseenter', function () { self.mode = 'billboard'; self.setButton(i); });
            node.addEventListener('click', function (e) { e.stopPropagation(); action.run(); });
            return node;
        });
    };

    Screen.prototype.renderRows = function () {
        // Row titles and tiles; images are set later, only near the focus
        var self = this;
        this.status.textContent = this.page.rows.length ? '' : t(this.name === 'mylist' ? 'netflix.emptyList' : 'netflix.noRows');
        this.rowNodes = this.page.rows.map(function (row, r) {
            var box = self.rowsBox.appendChild(element('div', 'twk-nf-row' + (row.rank ? ' twk-nf-row-rank' : '')));
            box.appendChild(element('div', 'twk-nf-row-title', row.title));
            var track = box.appendChild(element('div', 'twk-nf-track'));
            var tiles = row.items.map(function (entry, c) {
                var tile = track.appendChild(element('div', 'twk-nf-tile'));
                if (row.rank) tile.appendChild(element('span', 'twk-nf-rank', String(c + 1)));
                tile.appendChild(element('div', 'twk-nf-tile-art'));
                tile.appendChild(element('div', 'twk-nf-tile-name', entry.meta.name));
                if (entry.progress) tile.appendChild(element('div', 'twk-nf-progress')).appendChild(element('div', 'twk-nf-progress-fill')).style.width = Math.min(100, entry.progress).toFixed(0) + '%';
                tile.addEventListener('mouseenter', function () { self.focusTile(r, c); });
                tile.addEventListener('click', function (e) { e.stopPropagation(); self.focusTile(r, c); self.open(); });
                return tile;
            });
            return { box: box, track: track, tiles: tiles, shown: false };
        });
    };

    Screen.prototype.showSlide = function (index) {
        // Put one billboard title on screen and plan its trailer
        var titles = this.page.billboard;
        if (!titles.length) return this.showMeta(null);
        this.slide = (index + titles.length) % titles.length;
        this.stopTrailer();
        this.showMeta(titles[this.slide]);
        this.dots.textContent = '';
        for (var i = 0; i < titles.length; i++) this.dots.appendChild(element('span', 'twk-nf-dot' + (i === this.slide ? ' twk-nf-dot-on' : '')));
        this.planSlide();
    };

    Screen.prototype.planSlide = function () {
        // While the billboard has the focus its trailer starts after a pause, and the carousel moves on later
        var self = this;
        clearTimeout(this.timers.trailer);
        clearTimeout(this.timers.next);
        if (this.mode !== 'billboard' || !this.page.billboard.length) return;
        var meta = this.page.billboard[this.slide];
        var withTrailer = config.trailers !== false && !!meta.trailer;
        if (withTrailer) this.timers.trailer = setTimeout(function () { self.playTrailer(meta.trailer); }, config.trailerDelayMs || 3000);
        if (this.page.billboard.length > 1) this.timers.next = setTimeout(function () { self.showSlide(self.slide + 1); }, withTrailer ? config.trailerMaxMs || 60000 : config.slideMs || 15000);
    };

    Screen.prototype.playTrailer = function (id) {
        // The trailer plays with sound over the art, fading in once it has had time to start
        var frame = document.createElement('iframe');
        frame.src = YOUTUBE + encodeURIComponent(id) + '?autoplay=1&controls=0&disablekb=1&fs=0&iv_load_policy=3&modestbranding=1&playsinline=1&rel=0&loop=1&playlist=' + encodeURIComponent(id) + (config.trailerSound === false ? '&mute=1' : '');
        frame.setAttribute('allow', 'autoplay; encrypted-media');
        frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
        frame.setAttribute('frameborder', '0');
        frame.setAttribute('tabindex', '-1');
        this.trailer.textContent = '';
        this.trailer.appendChild(frame);
        var trailer = this.trailer;
        this.timers.fade = setTimeout(function () { trailer.classList.add('twk-visible'); }, config.trailerFadeMs || 1500);
    };

    Screen.prototype.stopTrailer = function () {
        // Remove the trailer at once, so its sound never outlives the billboard
        clearTimeout(this.timers.fade);
        this.trailer.classList.remove('twk-visible');
        this.trailer.textContent = '';
    };

    Screen.prototype.showMeta = function (meta) {
        // The large title area: art, logo or name, one line of facts and the synopsis
        this.art.style.backgroundImage = meta && meta.background ? 'url("' + meta.background + '")' : '';
        this.logo.style.display = meta && meta.logo ? '' : 'none';
        if (meta && meta.logo) this.logo.src = meta.logo;
        this.titleText.textContent = meta && !meta.logo ? meta.name : '';
        this.line.textContent = meta ? metaLine(meta) : '';
        this.synopsis.textContent = meta ? meta.description : '';
    };

    Screen.prototype.focusTile = function (row, col) {
        // Move the focus to a tile and show its title above the rows after a short settle
        var self = this;
        if (!this.page.rows[row]) return;
        this.mode = 'rows';
        this.row = row;
        this.cols[row] = Math.max(0, Math.min(this.page.rows[row].items.length - 1, col));
        this.stopTrailer();
        clearTimeout(this.timers.trailer);
        clearTimeout(this.timers.next);
        clearTimeout(this.timers.meta);
        this.timers.meta = setTimeout(function () { self.showMeta(self.focused().meta); }, config.metaSettleMs || 200);
        this.paint();
    };

    Screen.prototype.focused = function () {
        // The entry under the focus in rows mode
        var row = this.page.rows[this.row];
        return row ? row.items[this.cols[this.row] || 0] : null;
    };

    Screen.prototype.paint = function () {
        // Mode, focus marks, row and track positions, and images near the focus
        var self = this;
        this.root.classList.toggle('twk-nf-browsing', this.mode === 'rows');
        this.buttonNodes.forEach(function (node, i) { node.classList.toggle('twk-focus', self.mode === 'billboard' && self.button === i && self.active !== false); });
        this.rowsBox.style.transform = 'translateY(calc(-' + (this.mode === 'rows' ? this.row : 0) + ' * var(--twk-nf-row-step)))';
        (this.rowNodes || []).forEach(function (node, r) {
            var col = self.cols[r] || 0;
            node.track.style.transform = 'translateX(calc(-' + col + ' * var(--twk-nf-tile-step)))';
            node.tiles.forEach(function (tile, c) {
                tile.classList.toggle('twk-focus', self.mode === 'rows' && r === self.row && c === col && self.active !== false);
                if (Math.abs(r - self.row) <= 2 && c >= col - 1 && c <= col + 7) self.loadArt(tile, self.page.rows[r].items[c].meta, self.page.rows[r].rank);
            });
            if (!node.shown && Math.abs(r - self.row) <= 1) {
                node.shown = true;
                window.__twkRecs.noteShown(self.page.rows[r].items.slice(0, 6).map(function (entry) { return entry.meta.id; }));
            }
        });
    };

    Screen.prototype.loadArt = function (tile, meta, portrait) {
        // Each tile asks for its image once, the poster in numbered rows and the landscape art elsewhere
        if (tile.__art) return;
        tile.__art = true;
        var url = portrait ? meta.poster : meta.background || meta.poster;
        if (url) tile.querySelector('.twk-nf-tile-art').style.backgroundImage = 'url("' + url + '")';
    };

    Screen.prototype.open = function (playNow) {
        // Open the focused title: its own action (an episode), resume a started one, else its details (or play it at once from the billboard)
        var entry = this.mode === 'billboard' ? { meta: this.page.billboard[this.slide] } : this.focused();
        if (!entry || !entry.meta) return;
        if (entry.run) return entry.run();
        window.__twkRecs.noteOpened(entry.meta.id);
        if (entry.link) return window.__stremioDoctor.navigate(entry.link.replace(/^#/, ''));
        window.__stremioDoctor.navigate('/detail/' + entry.meta.type + '/' + encodeURIComponent(entry.meta.id) + (playNow && entry.meta.type === 'movie' ? '/' + encodeURIComponent(entry.meta.id) : ''));
    };

    Screen.prototype.onKey = function (code, repeat) {
        // Billboard and rows each move the focus their own way; Back walks up towards the menu
        if (this.mode === 'billboard') return this.billboardKey(code, repeat);
        var rows = this.page.rows;
        var col = this.cols[this.row] || 0;
        if (code === KEYS.up) return this.row > 0 ? this.focusTile(this.row - 1, this.cols[this.row - 1] || 0) : this.toBillboard();
        if (code === KEYS.down) return this.row < rows.length - 1 ? this.focusTile(this.row + 1, this.cols[this.row + 1] || 0) : null;
        if (code === KEYS.left) return col > 0 ? this.focusTile(this.row, col - 1) : this.shell.openMenu();
        if (code === KEYS.right) return this.focusTile(this.row, col + 1);
        if (code === KEYS.enter && !repeat) return this.open(false);
        if (code === KEYS.back || code === KEYS.escape) return this.page.billboard.length ? this.toBillboard() : this.shell.openMenu();
    };

    Screen.prototype.billboardKey = function (code, repeat) {
        // Left and Right move between the buttons and through the carousel, Down goes to the rows
        if (code === KEYS.left) return this.button > 0 ? this.setButton(this.button - 1) : this.shell.openMenu();
        if (code === KEYS.right) return this.button < this.buttonNodes.length - 1 ? this.setButton(this.button + 1) : this.page.billboard.length > 1 ? this.showSlide(this.slide + 1) : null;
        if (code === KEYS.down && this.page.rows.length) return this.focusTile(0, this.cols[0] || 0);
        if (code === KEYS.enter && !repeat && this.actions[this.button]) return this.actions[this.button].run();
        if (code === KEYS.back || code === KEYS.escape) return this.page.back ? this.page.back() : this.shell.openMenu();
    };

    Screen.prototype.setButton = function (index) {
        // Move between Play and More info
        this.button = index;
        this.paint();
    };

    Screen.prototype.toBillboard = function () {
        // Back to the top: the current billboard title again, with its trailer plan
        if (!this.page.billboard.length) return;
        this.mode = 'billboard';
        clearTimeout(this.timers.meta);
        this.showSlide(this.slide);
        this.paint();
    };

    Screen.prototype.focusChanged = function (active) {
        // The menu took or gave back the focus: the trailer stops while the menu is open
        this.active = active;
        if (!active) {
            this.stopTrailer();
            clearTimeout(this.timers.trailer);
            clearTimeout(this.timers.next);
        } else if (this.mode === 'billboard') {
            this.planSlide();
        }
        this.paint();
    };

    Screen.prototype.destroy = function () {
        // Stop timers and the trailer; the layer removes the nodes
        var timers = this.timers;
        this.alive = false;
        Object.keys(timers).forEach(function (key) { clearTimeout(timers[key]); });
        this.stopTrailer();
    };
})();
