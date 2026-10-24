// Title details for the Netflix-like layer: the title large with its trailer, Play or Resume (the best source starts
// at once), My List, Start over and All sources, one row of episodes per season and a More like this row. The page is
// drawn by the screens of webos-home.js; this module builds it from Cinemeta and the watch state Stremio keeps.
(function () {
    var shared = window.__twkShared;
    var t = window.__twkI18n.t;
    var config = (window.STREMIO_TWEAKS || {}).recommendations || {};
    var metas = {};

    function fullMeta(type, id) {
        // The whole meta with its episodes, kept in memory while the app runs
        if (!metas[id]) {
            metas[id] = shared.fetchJson(config.cinemetaUrl.replace(/\/$/, '') + '/meta/' + type + '/' + encodeURIComponent(id) + '.json', config.requestTimeoutMs || 8000).then(function (body) {
                if (!body || !body.meta) delete metas[id];
                return body && body.meta;
            });
        }
        return metas[id];
    }

    function libraryItem(id) {
        // The library entry of the title with its watch state, when the viewer has one
        try {
            var library = JSON.parse(localStorage.getItem('library_recent') || '{}');
            return (library.items || {})[id] || null;
        } catch (_e) {
            return null;
        }
    }

    function navigate(route) {
        // Every move goes through the app router, so Back keeps working
        window.__stremioDoctor.navigate(route);
    }

    function streamsRoute(type, id, videoId) {
        // The Stremio source list of a movie or an episode
        return '/detail/' + type + '/' + encodeURIComponent(id) + '/' + encodeURIComponent(videoId || id);
    }

    function episodeLabel(videoId) {
        // "S8:E8" from an episode id such as tt9780442:8:8
        var parts = String(videoId || '').split(':');
        return parts.length === 3 ? 'S' + parts[1] + ':E' + parts[2] : '';
    }

    function playButton(meta, item) {
        // Resume where the viewer stopped, else start the movie or the first episode; the best source plays at once
        var state = item && item.state;
        var started = state && state.timeOffset > 0 && (!state.duration || state.timeOffset < state.duration * 0.95);
        var firstEpisode = (meta.videos || []).filter(function (v) { return v.season > 0; }).sort(function (a, b) { return a.season - b.season || (a.episode || a.number) - (b.episode || b.number); })[0];
        var videoId = meta.type === 'series' ? (state && state.video_id) || (firstEpisode && firstEpisode.id) : meta.id;
        var label = started || (meta.type === 'series' && state && state.video_id) ? t('netflix.resume', { episode: episodeLabel(videoId) }).trim() : t('netflix.play');
        return { label: label, videoId: videoId, run: function () { navigate(streamsRoute(meta.type, meta.id, videoId)); } };
    }

    function myListButton(meta, item, refresh) {
        // Add to or remove from the Stremio library, which is My List
        var listed = !!(item && !item.removed && !item.temp);
        return {
            label: t(listed ? 'netflix.myListRemove' : 'netflix.myListAdd'),
            run: function () {
                var action = listed ? { action: 'RemoveFromLibrary', args: meta.id } : { action: 'AddToLibrary', args: { id: meta.id, type: meta.type, name: meta.name, poster: meta.poster, posterShape: 'poster' } };
                window.core.dispatch({ action: 'Ctx', args: action }, 'ctx').then(function () {
                    shared.notify(t(listed ? 'netflix.removedFromList' : 'netflix.addedToList', { title: meta.name }), 2500);
                    // The core writes the library a moment later; the buttons follow it then
                    setTimeout(refresh, 800);
                }).catch(function (error) { console.warn('[netflix] My List change failed:', error && error.message || error); });
            }
        };
    }

    function buttons(meta, refresh) {
        // Play or Resume, My List, Start over when there is progress, All sources
        var item = libraryItem(meta.id);
        var play = playButton(meta, item);
        var list = [play, myListButton(meta, item, refresh)];
        if (item && item.state && item.state.timeOffset > 0) {
            list.push({ label: t('netflix.startOver'), run: function () {
                window.core.dispatch({ action: 'Ctx', args: { action: 'RewindLibraryItem', args: meta.id } }, 'ctx').then(play.run);
            } });
        }
        list.push({ label: t('netflix.allSources'), run: function () {
            // The viewer wants to choose the source, so the automatic play stays out of the way once
            window.__twkNoAutoPlay = true;
            navigate(streamsRoute(meta.type, meta.id, play.videoId));
        } });
        return list;
    }

    function episodeRows(meta, compact) {
        // One row per season, specials last, each episode with its thumbnail and synopsis
        var seasons = {};
        (meta.videos || []).forEach(function (video) { (seasons[video.season] = seasons[video.season] || []).push(video); });
        return Object.keys(seasons).map(Number).sort(function (a, b) { return (a === 0) - (b === 0) || a - b; }).map(function (season) {
            var episodes = seasons[season].sort(function (a, b) { return (a.episode || a.number) - (b.episode || b.number); });
            return {
                key: 'season:' + season,
                title: season ? t('netflix.season', { number: season }) : t('netflix.specials'),
                items: episodes.map(function (video) {
                    var number = video.episode || video.number;
                    return {
                        meta: { id: video.id, type: 'series', name: t('netflix.episode', { number: number, name: video.name || video.title || '' }), description: video.overview || video.description || '', background: video.thumbnail || compact.background, logo: compact.logo, releaseInfo: String(video.released || video.firstAired || '').slice(0, 10), genres: [] },
                        run: function () { navigate(streamsRoute('series', meta.id, video.id)); }
                    };
                })
            };
        });
    }

    function moreLikeThis(compact) {
        // Titles closest to this one among the popular titles of its genres
        var recs = window.__twkRecs;
        return Promise.all(compact.genres.slice(0, 2).map(function (genre) { return recs.catalog(compact.type, 'top', 'genre=' + encodeURIComponent(genre)); })).then(function (lists) {
            var seen = {};
            var pool = [].concat.apply([], lists).filter(function (other) {
                if (other.id === compact.id || seen[other.id]) return false;
                seen[other.id] = true;
                return true;
            });
            var items = pool.map(function (other) { return { meta: other, value: recs.similarity(other, compact) }; }).sort(function (a, b) { return b.value - a.value; }).slice(0, 20);
            return items.length ? { key: 'more', title: t('netflix.moreLikeThis'), items: items } : null;
        });
    }

    function load(type, id) {
        // The page of one title: itself as the billboard, its buttons, then seasons and similar titles
        return fullMeta(type, id).then(function (meta) {
            if (!meta) throw new Error('no meta for ' + id);
            var compact = window.__twkRecs.compact(meta);
            return moreLikeThis(compact).then(function (more) {
                var page = { billboard: [compact], rows: (type === 'series' ? episodeRows(meta, compact) : []).concat(more ? [more] : []), back: function () { history.back(); } };
                function refresh() {
                    // A changed library rebuilds the buttons, and the screen draws them again
                    page.buttons = buttons(meta, refresh);
                    if (page.onButtons) page.onButtons();
                }
                page.buttons = buttons(meta, refresh);
                return page;
            });
        });
    }

    window.__twkDetails = { load: load };
})();
