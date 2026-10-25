// Recommendation engine for the Netflix-like screens: a taste profile from the watch history (engagement weighted,
// decaying with time), candidates from the Cinemeta catalogs (popular, new, acclaimed, per genre), one scoring
// function with diversity, impression fatigue and a little daily exploration, and page assembly that picks rows
// greedily so the page stays varied. Parameters come from window.STREMIO_TWEAKS.recommendations.
(function () {
    var config = (window.STREMIO_TWEAKS || {}).recommendations || {};
    var weights = config.weights || {};
    var t = window.__twkI18n.t;
    var DAY_MS = 86400000;
    var MAX_SIMILARITY = 2.2;
    var META_KEY = 'twk.recs.meta';
    var SEEN_KEY = 'twk.recs.seen';
    var AI_KEY = 'twk.recs.ai';
    var catalogCache = {};
    var metaCache = readJson(META_KEY, {});
    var seen = readJson(SEEN_KEY, {});
    var profileCache = null;

    function readJson(key, fallback) {
        // Page storage can be full or unavailable; the engine then starts empty
        try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; } catch (_e) { return fallback; }
    }

    function writeJson(key, value) {
        // A full page storage only costs the cache, never the screen
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (_e) {}
    }

    function compact(meta) {
        // The fields the profile, the scoring and the screens use, so the cache stays small
        return {
            id: meta.id, type: meta.type, name: meta.name, genres: meta.genres || meta.genre || [],
            cast: (meta.cast || []).slice(0, 3), people: (meta.director || []).concat(meta.writer || []).slice(0, 4),
            year: parseInt(String(meta.year || meta.releaseInfo || ''), 10) || null, rating: parseFloat(meta.imdbRating) || null,
            popularity: ((meta.popularities || {}).moviedb || 0) + ((meta.popularities || {}).trakt || 0) / 10,
            runtime: parseInt(String(meta.runtime || ''), 10) || null, country: String(meta.country || '').split(',')[0].trim(),
            poster: meta.poster, background: meta.background, logo: meta.logo, description: meta.description || '',
            trailer: ((meta.trailerStreams || [])[0] || {}).ytId || ((meta.trailers || [])[0] || {}).source || null,
            releaseInfo: meta.releaseInfo || ''
        };
    }

    function fetchJson(target) {
        // Addon answers through the shared time-limited request
        return window.__twkShared.fetchJson(target, config.requestTimeoutMs || 8000);
    }

    function catalog(type, id, extra) {
        // One page of a Cinemeta catalog, kept in memory for a few hours
        var path = type + '/' + id + (extra ? '/' + extra : '');
        var cached = catalogCache[path];
        if (cached && Date.now() - cached.at < (config.catalogTtlMs || 21600000)) return cached.promise;
        var promise = fetchJson(config.cinemetaUrl.replace(/\/$/, '') + '/catalog/' + path + '.json').then(function (body) {
            return ((body && body.metas) || []).map(compact);
        });
        catalogCache[path] = { at: Date.now(), promise: promise };
        return promise;
    }

    function metaOf(type, id) {
        // The compact meta of one history title, fetched once and kept in page storage
        if (metaCache[id]) return Promise.resolve(metaCache[id]);
        return fetchJson(config.cinemetaUrl.replace(/\/$/, '') + '/meta/' + type + '/' + encodeURIComponent(id) + '.json').then(function (body) {
            if (!body || !body.meta) return null;
            metaCache[id] = compact(body.meta);
            writeJson(META_KEY, metaCache);
            return metaCache[id];
        });
    }

    function historyItems() {
        // Watched titles from the library Stremio keeps on the TV, removed ones included since their history stays
        var library = readJson('library_recent', {});
        return Object.keys(library.items || {}).map(function (key) { return library.items[key]; }).filter(function (item) {
            return item && /^tt\d+/.test(item._id) && item.state && (item.state.overallTimeWatched > 0 || item.state.flaggedWatched);
        });
    }

    function engagement(item) {
        // How much of a title was watched, 0 to 1; a series counts as fully watched after a few episodes' worth
        var state = item.state;
        if (state.flaggedWatched) return 1;
        if (item.type === 'series') return Math.min(1, state.overallTimeWatched / (config.seriesFullMs || 10800000));
        return state.duration ? Math.min(1, state.timeWatched / state.duration) : 0;
    }

    function evidence(item, now) {
        // Implicit feedback: finished titles count fully, rewatches more, a title left almost at once counts against
        var share = engagement(item);
        var last = Date.parse(item.state.lastWatched) || now;
        var decay = Math.pow(0.5, (now - last) / ((config.halfLifeDays || 60) * DAY_MS));
        var abandoned = share < 0.1 && now - last > 2 * DAY_MS;
        var weight = abandoned ? -(weights.abandoned || 0.3) : share + (weights.rewatch || 0.5) * Math.max(0, (item.state.timesWatched || 0) - 1);
        return { id: item._id, type: item.type, name: item.name, share: share, last: last, weight: weight * decay };
    }

    function addAffinity(map, keys, weight) {
        // Spread one title's weight over its genres, people or other attributes
        (keys || []).forEach(function (key) { if (key) map[key] = (map[key] || 0) + weight; });
    }

    function normalize(map, total) {
        // Shares of the positive evidence, smoothed so a single title does not decide a whole taste
        var smooth = config.smoothing || 2;
        Object.keys(map).forEach(function (key) { map[key] = map[key] / (total + smooth); });
        return map;
    }

    function buildProfile(events, metas) {
        // Affinities per genre, person, type, decade and country from the weighted history
        var profile = { genres: {}, people: {}, types: {}, decades: {}, countries: {}, franchises: {}, watched: {}, recent: [] };
        var total = 0;
        events.forEach(function (event, i) {
            var meta = metas[i];
            // Titles without genres are not catalog titles (test files, local videos) and say nothing about taste
            if (!meta || !meta.genres.length) return;
            profile.watched[event.id] = true;
            total += Math.max(0, event.weight);
            addAffinity(profile.genres, meta.genres, event.weight);
            addAffinity(profile.people, meta.cast.concat(meta.people), event.weight);
            addAffinity(profile.types, [meta.type], event.weight);
            addAffinity(profile.decades, meta.year ? [Math.floor(meta.year / 10) * 10] : [], event.weight);
            addAffinity(profile.countries, [meta.country], event.weight);
            addAffinity(profile.franchises, [franchise(meta.name).toLowerCase()], event.weight);
        });
        ['genres', 'people', 'types', 'decades', 'countries', 'franchises'].forEach(function (key) { normalize(profile[key], total); });
        // The most recent well-watched titles seed the "Because you watched" rows
        profile.recent = events.map(function (event, i) { return { event: event, meta: metas[i] }; }).filter(function (entry) {
            return entry.meta && entry.meta.genres.length && entry.event.share >= 0.3;
        }).sort(function (a, b) { return b.event.last - a.event.last; }).slice(0, Math.max(config.becauseRows || 3, config.franchiseSeeds || 5));
        profile.evidence = total;
        return profile;
    }

    function sum(map, keys) {
        // Total affinity of a title's attributes
        return (keys || []).reduce(function (acc, key) { return acc + (map[key] || 0); }, 0);
    }

    function dailyNoise(id) {
        // A small exploration term that changes once a day, so the page is not frozen yet stable within the day
        var seed = id + ':' + Math.floor(Date.now() / DAY_MS);
        var hash = 0;
        for (var i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
        return ((hash >>> 0) % 1000) / 1000;
    }

    function score(meta, profile) {
        // One weighted sum of taste, quality, popularity, freshness and exploration, minus impression fatigue
        var genres = sum(profile.genres, meta.genres) / Math.max(1, meta.genres.length);
        var people = sum(profile.people, meta.cast.concat(meta.people));
        var type = profile.types[meta.type] || 0;
        var decade = meta.year ? profile.decades[Math.floor(meta.year / 10) * 10] || 0 : 0;
        var rating = meta.rating ? (meta.rating - 6) / 4 : 0;
        var popularity = Math.log(1 + meta.popularity) / 5;
        var fresh = meta.year && meta.year >= new Date().getFullYear() - 1 ? 1 : 0;
        var fatigue = Math.max(0, (seen[meta.id] || 0) - (config.fatigueAfter || 6));
        // Another title of a franchise the viewer followed is the strongest sign there is
        var sameFranchise = (profile.franchises[franchise(meta.name).toLowerCase()] || 0) > 0 ? 1 : 0;
        return (weights.franchise || 2) * sameFranchise + (weights.genre || 3) * genres + (weights.people || 1.5) * people + (weights.type || 0.5) * type + (weights.decade || 0.3) * decade +
            (weights.rating || 0.6) * rating + (weights.popularity || 0.4) * popularity + (weights.fresh || 0.3) * fresh +
            (weights.explore || 0.15) * dailyNoise(meta.id) - (weights.fatigue || 0.1) * fatigue;
    }

    function similarity(a, b) {
        // How close two titles are: shared genres, then shared cast and crew, then the same type
        var genres = a.genres.filter(function (g) { return b.genres.indexOf(g) !== -1; }).length / Math.max(1, Math.max(a.genres.length, b.genres.length));
        var peopleA = a.cast.concat(a.people);
        var people = b.cast.concat(b.people).filter(function (p) { return peopleA.indexOf(p) !== -1; }).length;
        return genres + 0.5 * Math.min(2, people) + (a.type === b.type ? 0.2 : 0);
    }

    function rankRow(items, value, excluded) {
        // Order a row by its own value, drop excluded and duplicate titles, then interleave for variety (MMR)
        var unique = {};
        var pool = items.filter(function (meta) {
            if (!meta || !meta.id || excluded[meta.id] || unique[meta.id]) return false;
            unique[meta.id] = true;
            return true;
        }).map(function (meta) { return { meta: meta, value: value(meta) }; });
        var lambda = config.mmrLambda || 0.7;
        var picked = [];
        var perFranchise = {};
        // Several shows can share one name (country versions); a row holds only a few of any one franchise
        pool = pool.filter(function (entry) {
            var key = franchise(entry.meta.name).toLowerCase();
            perFranchise[key] = (perFranchise[key] || 0) + 1;
            return perFranchise[key] <= (config.maxPerFranchise || 2);
        });
        while (pool.length && picked.length < (config.rowLength || 20)) {
            var best = 0;
            var bestValue = -Infinity;
            pool.forEach(function (entry, i) {
                var overlap = picked.reduce(function (max, other) { return Math.max(max, similarity(entry.meta, other.meta) / MAX_SIMILARITY); }, 0);
                var mmr = lambda * entry.value - (1 - lambda) * overlap;
                if (mmr > bestValue) { bestValue = mmr; best = i; }
            });
            picked.push(pool.splice(best, 1)[0]);
        }
        return picked;
    }

    function inBatches(list, size, work) {
        // Run the requests a few at a time, so the player and the screens keep their connections
        var results = [];
        var next = 0;
        function step() {
            if (next >= list.length) return Promise.resolve();
            var batch = list.slice(next, next + size);
            next += size;
            return Promise.all(batch.map(work)).then(function (done) { results = results.concat(done); return step(); });
        }
        return step().then(function () { return results; });
    }

    function loadProfile() {
        // The profile is rebuilt only when the history changed or after a while, since every screen asks for it
        var signature = (localStorage.getItem('library_recent') || '').length;
        if (profileCache && profileCache.signature === signature && Date.now() - profileCache.at < (config.profileTtlMs || 600000)) return profileCache.promise;
        profileCache = { signature: signature, at: Date.now(), promise: buildFromHistory() };
        return profileCache.promise;
    }

    function buildFromHistory() {
        // The history with the meta of each title, then the profile built from both
        var now = Date.now();
        var items = historyItems().sort(function (a, b) { return (Date.parse(b.state.lastWatched) || 0) - (Date.parse(a.state.lastWatched) || 0); }).slice(0, config.historyLimit || 120);
        return inBatches(items, 4, function (item) { return metaOf(item.type, item._id); }).then(function (metas) {
            var profile = buildProfile(items.map(function (item) { return evidence(item, now); }), metas);
            profile.history = items.map(function (item, i) { return { item: item, meta: metas[i] }; });
            return profile;
        });
    }

    function topGenres(profile) {
        // The genres the viewer likes most, with at least one supporting title
        return Object.keys(profile.genres).filter(function (genre) { return profile.genres[genre] > 0; }).sort(function (a, b) {
            return profile.genres[b] - profile.genres[a];
        }).slice(0, config.genreRows || 5);
    }

    function franchise(name) {
        // The main name of a title, before a subtitle or a season, to find the other titles of the same franchise
        return String(name || '').split(/[:\-(–]/)[0].replace(/\b(season|part|vol(ume)?)\b.*$/i, '').trim();
    }

    function candidatePool(profile, types) {
        // Popular, new and acclaimed titles of each type, popular and acclaimed ones of the favourite genres, and the franchises of recent titles
        var year = new Date().getFullYear();
        var requests = [];
        types.forEach(function (type) {
            requests.push([type, 'top', ''], [type, 'year', 'genre=' + year], [type, 'imdbRating', '']);
            topGenres(profile).forEach(function (genre) {
                requests.push([type, 'top', 'genre=' + encodeURIComponent(genre)], [type, 'imdbRating', 'genre=' + encodeURIComponent(genre)]);
            });
            profile.recent.slice(0, config.franchiseSeeds || 5).forEach(function (seed) {
                var name = franchise(seed.meta.name);
                if (name.length >= 3) requests.push([type, 'top', 'search=' + encodeURIComponent(name)]);
            });
        });
        return inBatches(requests, 3, function (r) { return catalog(r[0], r[1], r[2]); }).then(function (lists) {
            var pool = {};
            lists.forEach(function (list) { list.forEach(function (meta) { if (meta.id && meta.type) pool[meta.id] = meta; }); });
            return Object.keys(pool).map(function (id) { return pool[id]; });
        });
    }

    function genreName(genre) {
        // A genre in the interface language, the Cinemeta name when the dictionary has none
        var key = 'genre.' + genre;
        var name = t(key);
        return name === key ? genre : name;
    }

    function candidateRows(profile, pool, top10) {
        // Every row this page could show, each with the evidence it stands on and its own order of titles; titles already started or seen are left to Continue Watching and Watch it again
        var excluded = profile.watched;
        var value = function (meta) { return score(meta, profile); };
        var rows = [{ key: 'topPicks', title: t('recs.topPicks'), items: rankRow(pool, value, excluded) }];
        profile.recent.slice(0, config.becauseRows || 3).forEach(function (seed) {
            var near = pool.filter(function (meta) { return meta.id !== seed.meta.id && similarity(meta, seed.meta) >= 0.5; });
            rows.push({ key: 'because:' + seed.meta.id, title: t('recs.because', { title: seed.meta.name }), items: rankRow(near, function (meta) { return 2 * similarity(meta, seed.meta) + 0.3 * value(meta); }, excluded) });
        });
        topGenres(profile).forEach(function (genre) {
            rows.push({ key: 'genre:' + genre, title: t('recs.genre', { genre: genreName(genre) }), items: rankRow(pool.filter(function (meta) { return meta.genres.indexOf(genre) !== -1; }), value, excluded) });
        });
        var year = new Date().getFullYear();
        rows.push({ key: 'new', title: t('recs.newReleases'), items: rankRow(pool.filter(function (meta) { return meta.year >= year - 1; }), value, excluded) });
        rows.push({ key: 'acclaimed', title: t('recs.acclaimed'), items: rankRow(pool.filter(function (meta) { return meta.rating >= 8; }), value, excluded) });
        // Series still being followed belong to Continue Watching, so only finished titles come back here
        var again = profile.history.filter(function (entry) {
            return entry.meta && entry.meta.genres.length && (entry.item.state.flaggedWatched || (entry.item.type === 'movie' && engagement(entry.item) >= 0.9));
        }).map(function (entry) { return entry.meta; });
        rows.push({ key: 'watchAgain', title: t('recs.watchAgain'), items: rankRow(again, value, {}) });
        Object.keys(top10).forEach(function (type) {
            rows.push({ key: 'top10:' + type, title: t('recs.top10.' + type), rank: true, items: top10[type].slice(0, 10).map(function (meta, i) { return { meta: meta, value: 1 - i / 10 }; }) });
        });
        // Rows order their titles each in their own way; the page compares them on the one taste score
        rows.forEach(function (row) { row.items.forEach(function (entry) { entry.base = value(entry.meta); }); });
        return rows.filter(function (row) { return row.items.length >= (config.minRowItems || 4); });
    }

    function rowValue(row, placed) {
        // A row is worth the mean value of its first titles, less what the page already shows
        var head = row.items.slice(0, 10);
        var mean = head.reduce(function (acc, entry) { return acc + entry.base; }, 0) / Math.max(1, head.length);
        var repeated = head.filter(function (entry) { return placed[entry.meta.id]; }).length / Math.max(1, head.length);
        // Some kinds of rows matter less than their titles' scores say, such as titles the viewer already saw
        var weight = (config.rowWeights || {})[row.key.split(':')[0]];
        return (weight === undefined ? 1 : weight) * mean - (config.rowOverlapPenalty || 1) * repeated + (row.rank ? config.top10Boost || 0.2 : 0);
    }

    function assemble(rows) {
        // Stage-wise greedy page: each next row is the best one given the rows already chosen; titles appear once
        var page = [];
        var placed = {};
        var left = rows.slice();
        while (left.length && page.length < (config.maxRows || 10)) {
            var bestIndex = 0;
            left.forEach(function (row, i) { if (rowValue(row, placed) > rowValue(left[bestIndex], placed)) bestIndex = i; });
            var row = left.splice(bestIndex, 1)[0];
            // Top 10 rows keep their numbering; every other row drops titles already on the page
            if (!row.rank) row.items = row.items.filter(function (entry) { return !placed[entry.meta.id]; });
            if (row.items.length < (config.minRowItems || 4)) continue;
            row.items.forEach(function (entry) { placed[entry.meta.id] = true; });
            page.push(row);
        }
        return page;
    }

    function pageFor(screen) {
        // The rows of Home, Movies or Series, with the billboard titles taken from the best row
        var types = screen === 'movie' || screen === 'series' ? [screen] : ['movie', 'series'];
        return loadProfile().then(function (profile) {
            return Promise.all([candidatePool(profile, types)].concat(types.map(function (type) { return catalog(type, 'top', ''); }))).then(function (lists) {
                var top10 = {};
                types.forEach(function (type, i) { top10[type] = lists[i + 1]; });
                // The computer's picks join as rows of their own, for this screen's types and without titles already watched
                var picked = aiRows().map(function (row) {
                    row.items = row.items.filter(function (entry) { return types.indexOf(entry.meta.type) !== -1 && !profile.watched[entry.meta.id]; });
                    row.items.forEach(function (entry) { entry.base = score(entry.meta, profile); });
                    return row;
                }).filter(function (row) { return row.items.length >= (config.minRowItems || 4); });
                var candidates = candidateRows(profile, lists[0], top10).concat(picked);
                refreshAi(profile, lists[0]);
                // The billboard shows the best titles overall, those with a trailer first, before the rows take their share
                var picks = (candidates.filter(function (row) { return row.key === 'topPicks'; })[0] || candidates[0] || { items: [] }).items.map(function (entry) { return entry.meta; }).filter(function (meta) { return meta.background; });
                var billboard = picks.filter(function (meta) { return meta.trailer; }).concat(picks.filter(function (meta) { return !meta.trailer; })).slice(0, config.billboardTitles || 6);
                var rows = assemble(candidates);
                return { screen: screen, billboard: billboard, rows: rows, profile: profile };
            });
        });
    }

    function aiSlots() {
        // The current day and week, so each period asks the computer once
        return { daily: Math.floor(Date.now() / DAY_MS), weekly: Math.floor(Date.now() / (7 * DAY_MS)) };
    }

    function aiRequest(period, profile, pool) {
        // The history summary and a personal shortlist the computer's model picks from; nothing outside the list can come back
        var shortlist = pool.filter(function (meta) { return !profile.watched[meta.id]; }).map(function (meta) { return { meta: meta, value: score(meta, profile) }; })
            .sort(function (a, b) { return b.value - a.value; }).slice(0, config.aiCandidates || 150).map(function (entry) {
                var m = entry.meta;
                return { id: m.id, name: m.name, type: m.type, year: m.year, genres: m.genres, rating: m.rating };
            });
        var history = profile.history.filter(function (entry) { return entry.meta && entry.meta.genres.length; }).slice(0, 40).map(function (entry) {
            return { name: entry.meta.name, type: entry.meta.type, year: entry.meta.year, genres: entry.meta.genres, engagement: engagement(entry.item) };
        });
        return JSON.stringify({ period: period, language: window.__twkI18n.language(), model: config.aiModel, history: history, candidates: shortlist });
    }

    function refreshAi(profile, pool) {
        // Once per day and per week, ask the computer in the background and take its answer on a later visit
        if (config.ai === false) return;
        var cache = readJson(AI_KEY, {});
        var slots = aiSlots();
        ['daily', 'weekly'].forEach(function (period) {
            var entry = cache[period] || {};
            if (entry.slot === slots[period]) return;
            fetchJson('/__tweaks/ai?period=' + period).then(function (state) {
                if (!state || state.status === 'noComputer' || state.status === 'working') return;
                if (state.status === 'ready' && entry.requested === slots[period]) return keepAi(period, slots[period], state.answer, pool);
                // A failed job, a restarted service that lost it, or an answer of an earlier period: ask again
                cache[period] = Object.assign({}, entry, { requested: slots[period] });
                writeJson(AI_KEY, cache);
                return fetch('/__tweaks/ai?period=' + period, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: aiRequest(period, profile, pool) });
            }).catch(function () {});
        });
    }

    function keepAi(period, slot, answer, pool) {
        // Store the rows with the titles themselves, so they still show when the catalogs change or the computer is off
        var byId = {};
        pool.forEach(function (meta) { byId[meta.id] = meta; });
        var cache = readJson(AI_KEY, {});
        var rows = (answer.rows || []).map(function (row) {
            return { title: row.title, reason: row.reason, items: row.ids.map(function (id) { return byId[id]; }).filter(Boolean) };
        }).filter(function (row) { return row.items.length >= (config.minRowItems || 4); });
        cache[period] = { slot: slot, requested: slot, at: Date.now(), model: answer.model, rows: rows };
        writeJson(AI_KEY, cache);
    }

    function aiRows() {
        // The computer's picks of the last day and week, kept for a week when no computer answers
        var cache = readJson(AI_KEY, {});
        var rows = [];
        ['daily', 'weekly'].forEach(function (period) {
            var entry = cache[period];
            if (!entry || !entry.rows || Date.now() - entry.at > 7 * DAY_MS) return;
            entry.rows.forEach(function (row, i) {
                rows.push({ key: 'ai:' + period + ':' + i, title: row.title, items: row.items.map(function (meta, j) { return { meta: meta, value: 1 - j / Math.max(1, row.items.length) }; }) });
            });
        });
        return rows;
    }

    function quickPage(screen) {
        // A page from the popular catalogs alone, shown at once while the personal page is being built
        var types = screen === 'movie' || screen === 'series' ? [screen] : ['movie', 'series'];
        return Promise.all(types.map(function (type) { return catalog(type, 'top', ''); })).then(function (lists) {
            var entry = function (meta, i) { return { meta: meta, value: 1 - i / 10, base: 0 }; };
            var rows = types.map(function (type, i) { return { key: 'top10:' + type, title: t('recs.top10.' + type), rank: true, items: lists[i].slice(0, 10).map(entry) }; });
            var popular = [].concat.apply([], lists.map(function (list) { return list.slice(10, 30); }));
            if (popular.length) rows.push({ key: 'popular', title: t('recs.popular'), items: popular.slice(0, config.rowLength || 20).map(entry) });
            var billboard = [].concat.apply([], lists.map(function (list) { return list.slice(0, 6); })).filter(function (meta) { return meta.background && meta.trailer; }).slice(0, config.billboardTitles || 6);
            return { billboard: billboard, rows: rows };
        });
    }

    function noteShown(ids) {
        // Count how often titles were shown, so ones never opened slowly give their place to others
        ids.forEach(function (id) { seen[id] = (seen[id] || 0) + 1; });
        writeJson(SEEN_KEY, seen);
    }

    function noteOpened(id) {
        // Opening a title resets its fatigue
        delete seen[id];
        writeJson(SEEN_KEY, seen);
    }

    function rankResults(metas) {
        // Catalog titles (already compact) in the order of the viewer's taste
        return loadProfile().then(function (profile) {
            return metas.slice().sort(function (a, b) { return score(b, profile) - score(a, profile); });
        });
    }

    window.__twkRecs = { pageFor: pageFor, quickPage: quickPage, rankResults: rankResults, noteShown: noteShown, noteOpened: noteOpened, metaOf: metaOf, catalog: catalog, genreName: genreName, similarity: similarity, compact: compact };
})();
