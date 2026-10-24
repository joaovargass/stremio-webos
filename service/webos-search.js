// Netflix-like search screen for the layer: an on-screen keyboard on the left (letters, digits, space, delete) and a
// grid on the right with picks for the viewer before typing, then the results of movies and series, exact and
// starting matches first, the rest in the order of the viewer's taste.
(function () {
    var shared = window.__twkShared;
    var element = shared.element;
    var t = window.__twkI18n.t;
    var KEYS = { left: 37, up: 38, right: 39, down: 40, enter: 13, back: 461, escape: 27 };
    var LETTERS = 'abcdefghijklmnopqrstuvwxyz1234567890'.split('');
    var COLUMNS = 6;
    var GRID_COLUMNS = 4;
    var SEARCH_DELAY_MS = 400;

    function normalized(text) {
        // Lower case without accents, so "Amelie" finds "Amélie"
        return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    }

    function SearchScreen(container, shell) {
        this.shell = shell;
        this.query = '';
        this.zone = 'keys';
        this.key = 0;
        this.result = 0;
        this.items = [];
        this.alive = true;
        this.generation = 0;
        this.build(container);
        this.suggest();
    }

    SearchScreen.prototype.build = function (container) {
        // Keyboard, query line and the result grid, built once
        var self = this;
        this.root = container.appendChild(element('section', 'twk-nf-search'));
        var left = this.root.appendChild(element('div', 'twk-nf-keyboard'));
        this.queryLine = left.appendChild(element('div', 'twk-nf-query'));
        var keys = left.appendChild(element('div', 'twk-nf-keys'));
        this.keyNodes = LETTERS.concat(['space', 'delete']).map(function (letter, i) {
            var label = letter === 'space' ? t('netflix.space') : letter === 'delete' ? '⌫' : letter.toUpperCase();
            var node = keys.appendChild(element('div', 'twk-nf-key' + (letter.length > 1 ? ' twk-nf-key-wide' : ''), label));
            node.addEventListener('mouseenter', function () { self.zone = 'keys'; self.key = i; self.paint(); });
            node.addEventListener('click', function (e) { e.stopPropagation(); self.key = i; self.press(); });
            return node;
        });
        var right = this.root.appendChild(element('div', 'twk-nf-results'));
        this.heading = right.appendChild(element('div', 'twk-nf-row-title'));
        this.grid = right.appendChild(element('div', 'twk-nf-grid'));
        this.paint();
    };

    SearchScreen.prototype.suggest = function () {
        // Before any letter: the viewer's top picks, the popular titles while those are being built
        var self = this;
        var generation = ++this.generation;
        this.show(t('netflix.searchSuggestions'), []);
        window.__twkRecs.quickPage('home').then(function (page) {
            if (generation === self.generation && !self.items.length) self.show(t('netflix.searchSuggestions'), page.billboard.concat(page.rows.length ? page.rows[0].items.map(function (e) { return e.meta; }) : []));
        }).catch(function () {});
        window.__twkRecs.pageFor('home').then(function (page) {
            var picks = page.rows.filter(function (row) { return row.key === 'topPicks'; })[0];
            if (generation === self.generation && picks) self.show(t('netflix.searchSuggestions'), picks.items.map(function (e) { return e.meta; }));
        }).catch(function () {});
    };

    SearchScreen.prototype.search = function () {
        // Results of both types for the query, matches of the name first, then the viewer's taste
        var self = this;
        var query = this.query.trim();
        var generation = ++this.generation;
        clearTimeout(this.timer);
        if (!query) return this.suggest();
        this.show(t('netflix.searching', { query: query }), this.items);
        this.timer = setTimeout(function () {
            var recs = window.__twkRecs;
            Promise.all(['movie', 'series'].map(function (type) { return recs.catalog(type, 'top', 'search=' + encodeURIComponent(query)); })).then(function (lists) {
                var metas = [].concat.apply([], lists);
                return recs.rankResults(metas).then(function (ranked) {
                    var wanted = normalized(query);
                    var rank = function (meta) { var name = normalized(meta.name); return name === wanted ? 0 : name.indexOf(wanted) === 0 ? 1 : 2; };
                    return ranked.map(function (meta, i) { return { meta: meta, order: i }; }).sort(function (a, b) { return rank(a.meta) - rank(b.meta) || a.order - b.order; }).map(function (e) { return e.meta; });
                });
            }).then(function (results) {
                if (generation !== self.generation) return;
                self.show(results.length ? t('netflix.resultsFor', { query: query }) : t('netflix.noResults', { query: query }), results.slice(0, 40));
            }).catch(function () {
                if (generation === self.generation) self.show(t('netflix.loadFailed'), []);
            });
        }, SEARCH_DELAY_MS);
    };

    SearchScreen.prototype.show = function (heading, metas) {
        // Fill the grid with landscape tiles, images only for the first rows
        var self = this;
        this.heading.textContent = heading;
        this.items = metas.filter(function (meta) { return meta && meta.id; });
        this.result = Math.min(this.result, Math.max(0, this.items.length - 1));
        this.grid.textContent = '';
        this.tiles = this.items.map(function (meta, i) {
            var tile = self.grid.appendChild(element('div', 'twk-nf-tile'));
            var art = tile.appendChild(element('div', 'twk-nf-tile-art'));
            if (i < GRID_COLUMNS * 4 && (meta.background || meta.poster)) art.style.backgroundImage = 'url("' + (meta.background || meta.poster) + '")';
            tile.appendChild(element('div', 'twk-nf-tile-name', meta.name));
            tile.addEventListener('mouseenter', function () { self.zone = 'results'; self.result = i; self.paint(); });
            tile.addEventListener('click', function (e) { e.stopPropagation(); self.result = i; self.open(); });
            return tile;
        });
        if (!this.items.length && this.zone === 'results') this.zone = 'keys';
        this.paint();
    };

    SearchScreen.prototype.paint = function () {
        // The query, the focused key or tile, and the grid scrolled to the focused row
        var self = this;
        this.queryLine.textContent = this.query || t('netflix.searchPrompt');
        this.queryLine.classList.toggle('twk-faint', !this.query);
        this.keyNodes.forEach(function (node, i) { node.classList.toggle('twk-focus', self.active !== false && self.zone === 'keys' && i === self.key); });
        (this.tiles || []).forEach(function (tile, i) { tile.classList.toggle('twk-focus', self.active !== false && self.zone === 'results' && i === self.result); });
        var row = Math.floor(this.result / GRID_COLUMNS);
        this.grid.style.transform = 'translateY(calc(-' + Math.max(0, row - 1) + ' * var(--twk-nf-search-row)))';
    };

    SearchScreen.prototype.press = function () {
        // Type the focused key, delete a letter or add a space, then search again
        var letter = LETTERS.concat(['space', 'delete'])[this.key];
        if (letter === 'delete') this.query = this.query.slice(0, -1);
        else this.query += letter === 'space' ? ' ' : letter;
        this.paint();
        this.search();
    };

    SearchScreen.prototype.open = function () {
        // A result opens its title details
        var meta = this.items[this.result];
        if (!meta) return;
        window.__twkRecs.noteOpened(meta.id);
        window.__stremioDoctor.navigate('/detail/' + meta.type + '/' + encodeURIComponent(meta.id));
    };

    SearchScreen.prototype.onKey = function (code, repeat) {
        // The keyboard and the grid each move in their grid; Left from the keyboard edge opens the menu
        var keys = LETTERS.length + 2;
        if (code === KEYS.back || code === KEYS.escape) return this.query ? this.erase() : this.shell.openMenu();
        if (this.zone === 'keys') return this.keyboardKey(code, repeat, keys);
        var col = this.result % GRID_COLUMNS;
        if (code === KEYS.left) { if (col === 0) this.zone = 'keys'; else this.result--; }
        else if (code === KEYS.right && col < GRID_COLUMNS - 1 && this.result < this.items.length - 1) this.result++;
        else if (code === KEYS.up && this.result >= GRID_COLUMNS) this.result -= GRID_COLUMNS;
        else if (code === KEYS.down && this.result + GRID_COLUMNS < this.items.length) this.result += GRID_COLUMNS;
        else if (code === KEYS.enter && !repeat) return this.open();
        this.paint();
    };

    SearchScreen.prototype.keyboardKey = function (code, repeat, keys) {
        // Arrows walk the six-column keyboard; the wide Space and Delete keys share the last row
        var col = this.key < LETTERS.length ? this.key % COLUMNS : (this.key - LETTERS.length) * 3;
        if (code === KEYS.enter) return this.press();
        if (code === KEYS.left) { if (col === 0) return this.shell.openMenu(); this.key = this.key < LETTERS.length ? this.key - 1 : LETTERS.length; }
        else if (code === KEYS.right) { if (this.key === keys - 1 || (this.key < LETTERS.length && col === COLUMNS - 1)) { if (this.items.length) this.zone = 'results'; } else this.key++; }
        else if (code === KEYS.up) { if (this.key >= LETTERS.length) this.key = LETTERS.length - COLUMNS + col; else if (this.key >= COLUMNS) this.key -= COLUMNS; }
        else if (code === KEYS.down) { if (this.key < LETTERS.length - COLUMNS) this.key += COLUMNS; else if (this.key < LETTERS.length) this.key = LETTERS.length + (col < 3 ? 0 : 1); }
        this.paint();
    };

    SearchScreen.prototype.erase = function () {
        // Back removes the last letter while there is a query
        this.query = this.query.slice(0, -1);
        this.paint();
        this.search();
    };

    SearchScreen.prototype.focusChanged = function (active) {
        // The menu took or gave back the focus
        this.active = active;
        this.paint();
    };

    SearchScreen.prototype.destroy = function () {
        // Late answers of a closed screen are ignored
        this.alive = false;
        this.generation++;
        clearTimeout(this.timer);
    };

    window.__twkSearchScreen = function (container, shell) { return new SearchScreen(container, shell); };
})();
