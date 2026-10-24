# Stremio webOS

Custom Stremio app for LG webOS TVs. Uses Stremio Theater v1.9.2 frontend (from [Vidaa project](https://github.com/NoobyGains/stremio-vidaa-tv)) with the official Stremio streaming server.

## Important: Build artifacts

Several files are **downloaded/generated at build time** and will not exist in a fresh clone:

- `service/server.js` — downloaded from `dl.strem.io` (Stremio streaming server, webOS build)
- `service/www/` — built from Vidaa frontend tarball + patches

Run `make build` to generate these before inspecting or modifying them.

## Structure

```
app/                  # webOS app shell — starts service, redirects to http://127.0.0.1:8080
  appinfo.json        # webOS app manifest (id: com.joaovargass.stremiodbg, installs next to the official io.strem.tv)
  index.html          # Starts server via Luna, polls :8080, redirects when ready
  services.json       # Links to server service
  icon.png

service/              # webOS service
  launch.js           # Entry point: serves www/ on :8080, proxies to the TV server, LAN fallback per video, HLS and sync routing
  readahead.js        # RAM read-ahead window for torrent files, budget adapted to free memory
  answercache.js      # Short-lived RAM copies of repeated server answers (subtitle hash, track list, HLS start)
  servicelog.js       # Service log rings per level (debug.ring), streaming server requests as sentences with the raw line kept
  index.html          # Theater entry point (sets __STREMIO_SERVER_URL__ to :8080, loads tweaks.json + saved on/off choices)
  tweaks.json         # Defaults for every tweak, shared by launch.js and the frontend
  webos-shared.js     # Loaded first: panel stack (Back closes the top panel), panel frame and button, notice toast, shared helpers
  webos-i18n.js       # Translation dictionary; texts follow the Stremio interface language (English, Brazilian Portuguese)
  webos-recs.js       # Recommendation engine: taste profile from the watch history, Cinemeta candidates, scoring, Netflix-like row pages
  webos-enhance.js    # Points the profile at the proxy, adds trackers, ranks streams, prewarms the recommended one
  webos-retry.js      # Stall recovery and in-player HLS fallback (no external player)
  webos-subs.js       # Subtitle list cleanup, OpenSubtitles lookup, sync-likelihood ranking, automatic choice, Netflix style
  webos-subsync.js    # Automatic subtitle delay, measured on the TV (the Mac sync service only when the TV is unsure)
  subsync.js          # TV subtitle sync: TV ffmpeg audio cut, speech energy, FFT alignment on a worker thread
  webos-doctor.js     # Playback health, per-video LAN fallback, automatic next source, router-safe navigation
  webos-sources.js    # Source picker (player button and green key)
  webos-settings.js   # On/off switches for every tweak (yellow key)
  webos-diag.js       # Diagnostics panel opened from the player control bar
  webos-ui.css        # Styles for every tweak UI: every value is a :root token; one panel, button, item, tag and log-row component
  webos-debug.js      # On-screen log: time, level, area, sentence; detail setting debug.detail (essential, detailed, everything)
  webos-logview.js    # Full-screen log reader opened from settings, stacked above them
  package.json        # Service manifest (main: launch.js)
  services.json       # Luna service registration
  server.js           # [downloaded] Official Stremio streaming server
  www/                # [built] Vidaa frontend + patches applied

patches/              # Patches applied to Vidaa frontend files during build (alphabetical order)

mac/                  # Optional dedicated streaming server for a Mac on the same LAN
  install.sh          # Installs the patched server, the sync service and launchd agents (idempotent, restarts only changed agents)
  patch-server.py     # Makes server.js listen on STREMIO_PORT
  subsync.js          # Subtitle sync service (ffmpeg audio window + ffsubsync), port 11481
  discovery.js        # Answers the TV discovery query (UDP 11479, IPv4 broadcast + IPv6 group ff02::114) with ports and addresses
  devmode-keepalive.sh # Resets the 1000 h Dev Mode session daily
```

## How it works

1. `make build` downloads the Vidaa frontend (pinned to a specific commit) and Stremio server, copies frontend files into `service/www/`, applies patches
2. `make deploy` packages the IPK via `ares-package` and installs via `ares-install`
3. On launch: `app/index.html` starts the server service via Luna, polls `:8080` with an `<img>` load, redirects when ready
4. `service/launch.js` serves the Theater frontend on `servers.coreUrl` (127.0.0.1:8080, loopback only: its routes change settings and read logs, so no other host of the network reaches them) and proxies all non-static requests to the first reachable server: a computer found on the network first, since it streams and converts much faster, and the TV's own `127.0.0.1:11470` (`servers.candidates`) as the fallback, so everything also works with no computer (probed in parallel on `probePath` every `recheckIntervalMs`; a playing video keeps its server, unless that server stops answering, when the open read-ahead window continues on the next one at the next byte; a server counts as down only after `downAfterFailures` missed probes in a row, so a busy LAN server keeps its videos). Conversions also run on the computer when one answers, on the TV's own ffmpeg otherwise. It starts the bundled `server.js` only when nothing already answers on `:11470` (the official app's service usually does), which saves RAM. Every torrent the proxy serves, warms or seeds is removed from its server (`/<hash>/remove`) once nothing read it for `servers.idleTorrentMinutes` and no video response is open: forgotten torrents keep dialing peers, and through the carrier NAT that starves every new connection in the home. LAN servers are found, not configured: while none answers (at start, after the TV joins another network or gets new addresses, and every `discover.everyMs`) the service sends one UDP query per address family (`discover.query` to `discover.queryPort`, an IPv4 broadcast and the IPv6 group `discover.group6` on every interface), merges the answers of each server, probes every address the server announced and adopts the first one that answers, so it works on a home router, after the router hands out new addresses and on an IPv6-only phone hotspot; a server without the responder is still found on an IPv4 network by scanning the /24 subnet for `discover.port`, at most every `discover.scanEveryMs`. Servers found on a previous network must answer again before they get a request, and ones that stopped answering leave the list with their routes. IPv6 addresses are bracketed in every URL built for a server. The first request of a torrent on each server is preceded by `POST /<hash>/create` with `trackers` and DHT (`peerBoost`, waiting at most `peerBoost.waitMs`): the server only applies peer sources when it creates a torrent, and they replace its own default list, so `trackers` includes that list. Routes:
   - `GET /__tweaks/status`: upstream, candidates, transcoder, sync server, LAN fallback, per-video routes, read-ahead state.
   - `GET /__tweaks/route?hash=<infohash>&to=remote|default`: serve one torrent from the LAN fallback server (used by the doctor when the TV swarm is too slow).
   - `GET /__tweaks/warm?hash=&idx=&at=<0..1>&lan=1`: answers 202 at once, then the service creates the torrent with its peer sources (on the LAN fallback server when `lan=1`, routing it there) and reads `prewarm.warmBytes` at that position of the file, limited to `prewarm.timeoutMs`; the page keeps its few connections (six per origin on webOS Chrome) for the player.
   - `POST /__tweaks/overrides`: on/off choices that live in the service (`servers.useLan`, `readAhead.enabled`, `peerBoost.enabled`, `readAhead.mergeSources`, `subtitles.convert`, `subtitles.allowHttp`, `devMode.keepAlive`).
   - `GET /__tweaks/subsync?media=&sub=&at=`: measured on the TV first (`subsync.js`, `subtitles.syncOnTv`, settings in `subtitles.tvSync`): the TV ffmpeg cuts the audio window from the server holding the video, the cues come from the TV subtitle converter, jobs run one at a time and each subtitle and audio slot is measured once. The sync service on the transcoder host answers only when the TV result is below `syncMinConfidence`, the TV measurement fails, or TV sync is switched off.
   - `/hlsv2/*`: sent to a server listed in `servers.transcoders` (ffmpeg), answered 503 at once when none is reachable.
   Media URLs inside requests (`http://127.0.0.1:8080/...`) are rewritten to an address the target server can read (its loopback, the TV address of the same family as that server, or the source host). An HLS session stays on the server that started it only while that server still answers and may be used.
   Answers the TV asks for more than once are fetched once (`answerCache`, `answercache.js`): the core and the tweaks both ask for `/opensubHash` and `/tracks/` of the playing video, and the TV media pipeline reads the init and first `answerCache.hlsStart.segments` segments of a conversion twice (probe, then play), which made the converter cancel its running job and encode segment 1 again. Identical requests in flight wait for the first answer, later ones get a RAM copy for `ttlMs`, keyed by URL and Range; only complete 200/206 answers are kept, a failed one sends each waiter to fetch its own, the HLS copies belong to the newest conversion only and stay under `maxBytes`.
   The service also renews the Developer Mode session from the TV itself (`devMode`: it reads the session token the TV keeps in `devMode.tokenPath`, calls `devMode.resetUrl` a minute after start and every `devMode.everyHours`, tries every address of the LG host in turn, since some never accept a connection from a home network (`devMode.connectTimeoutMs` to connect, `devMode.answerTimeoutMs` for the answer), retries a failed renewal every `devMode.retryMs` up to `devMode.retries` times, and logs only the outcome), so the app survives without a computer running the Mac keepalive.
   At start the service gives the TV server on `:11470`, its own or the official app's, the torrent profile in `torrentProfile` (connections, speed limits, timeouts measured best on the TV), posting only the values that differ; the server keeps them in its own settings file.

The proxy exists because the app loads from `file://` which cannot XHR/fetch to `http://` origins (CORS restriction on webOS Chrome 68). Serving everything from `:8080` makes all requests same-origin. It also lets the app use a LAN server: the desktop streaming server only sends CORS headers to `*.strem.io`/`*.stremio.com` and `127.0.0.1:11470`, so the browser cannot call it directly, but the Node proxy can.

## Playback tweaks

Findings behind them (LG 55UR8750PSA, webOS 25 10.3.2): the native pipeline plays H.264/HEVC 8/10-bit/AV1, MP4/MKV, AAC/AC3/E-AC3 and 4K directly; a torrent that delivers no bytes for ~40 s is reported as `MEDIA_ELEMENT_ERROR: Format error`; DTS/TrueHD files play silently (`audioTracks.length === 0`); the official server defaults to a 3.5 MB/s torrent cap and a 45 MB memory buffer.

- `webos-enhance.js` sets `streamingServerUrl` to `servers.coreUrl` (local profile setting only, never synced), warms the recommended source through `/__tweaks/warm` and wraps `core.getState('meta_details')` to rank streams by swarm health, resolution and compatibility (`ranking`), adding a recommended badge and warnings. The ranking is reused while the sources and the context (quality, learned rates, Mac availability) stay the same, since the title page asks the core for `meta_details` many times a second.
- `webos-retry.js` is called from the WebOsVideo error handler: a starved torrent (no data yet, or a source that already played and then stopped; a decode error is not starvation) is reloaded at the last position (`stallRetry`), a rejected format or a stream without a playable audio track (checked with the server ffprobe, limited to `hlsFallback.probeTimeoutMs`) switches to `/hlsv2/.../master.m3u8` on the streaming server (`hlsFallback`). The server always re-encodes audio to AAC and keeps the channel count.
- `webos-diag.js` renders health (doctor verdict, player + RAM buffer), server, swarm, speed against the needed bitrate, playback, recovery and the automatic subtitle choice; it polls only while open (`diagnostics.refreshMs`). Its file map paints the whole torrent file in equal parts: the downloaded share of each part, how many connected peers hold it (green 3+, yellow 1-2, red none), the ranges the engine fetches first and the playhead, from `/<infohash>/<file>/pieces.json?buckets=N` (a route `tools/patch-webos-server.py` adds to the bundled server).
- `webos-doctor.js` samples the player, the torrent and the proxy every `doctor.checkEveryMs` (each request limited to `requestTimeoutMs`, so a server holding a request for a torrent without metadata cannot freeze the loop; the diagnostics panel reuses the same `fetchJson`) and acts only on symptoms the viewer sees: a video that does not start in `startTimeoutMs` or a frozen picture (not seeking) for `stalledForMs`. Remedies: the LAN server for that video (once; the proxy moves the running read-ahead download to it at the next byte, `seamless` in the route answer, so the player does not reload; when after `lanVerifyMs` the video has not moved and the LAN server has not even started downloading the torrent, the video goes back to the TV and, once watched, on to the next source), then the next source (`maxStartSwitches` before the first picture, `maxAutoSwitches` after), each followed by `graceMs` without new actions. A start that shows nothing after `raceAfterMs` (or playback that struggles for `prewarmAfterMs`) starts the next `raceCandidates` (one of them the best source of a lower resolution when the current one is higher, since a thin swarm often hits a whole resolution) sources in the background at the playback position (`prewarmNext`), on the LAN server when the current video already uses it or the TV cannot sustain the candidate (`prewarmOnLan`), so the race measures and later plays each source on the same server; after `quickStartMs` the doctor switches to the prepared source with the best download-speed-to-bitrate ratio, provided it downloads at least `raceMinRatio` of its bitrate (else it waits up to `startTimeoutMs`), and before the first picture the calm period is `startGraceMs`; a freeze longer than 10 s shows the green-key hint. Slowness alone only changes the status, and data the server already holds ahead counts as buffer. A picture frozen for `convertFrozenMs` while the server already holds `convertMinServerAheadS` past the playhead is a decoding problem, not a network one: with a converter available the doctor asks `window.__stremioConvert` (webos-retry.js) for an HLS remux at once (`convertFrozen`), once per source. It learns the download rate of each server while the player is hungry, the TV for its own videos (`learnTvSpeed`, `localStorage["twk.tvRate"]`) and the LAN server for routed ones (`learnLanSpeed`, `localStorage["twk.lanRate"]`), and starts sources the TV clearly cannot sustain on the LAN server (`startOnLanWhenHeavy`): the title page already routes such a recommended source to the LAN server before warming it, and the first time a source plays from the Mac the viewer is told once. Ranking penalizes sources heavier than the learned rate of the server that would play them (`ranking.overLanSpeed` when a LAN server answers, `ranking.overTvSpeed` otherwise). All navigation goes through the app router (`window.__stremioHistory`) so Back keeps working; a source switch replaces the player entry and hands the viewer position to the next player load (`__twkResumeMs`), so the new source does not open at the saved library position. When the automatic attempts run out and no tried torrent reached a single peer, the doctor names the network as the cause and plays a direct (HTTP) link when the list has one.
- `simple` (`webos-enhance.js`): ranking honours `simple.quality` (cap and bonus) and, when `simple.enabled`, the title page gets a single Watch entry (its text from the translation dictionary, `webos-i18n.js`) with a one-line summary; the full ranked list stays in `window.__stremioRankedStreams` for the picker and the doctor. Subtitles keep the best track per language (`simple.subtitleChoices`) and `subtitles.cycleKey` (red, 403) cycles tracks.
- `webos-subs.js` drops addon error entries and duplicates, adds OpenSubtitles v3 results by hash, size and filename (each lookup limited to `lookupTimeoutMs`; a hash a cold torrent cannot give in time is skipped and the filename alone is used), orders by language then sync likelihood (hash match, release group, source tags, CD split penalty) and picks a track before the player's own auto-select: the profile subtitle languages first (embedded, then external; nothing when the profile turns automatic subtitles off), then `subtitles.priority`, with embedded tracks only during `embeddedWaitMs`; forced and SDH tracks go last. `subtitles.netflixStyle` restyles external subtitles.
- `webos-subsync.js` asks `/__tweaks/subsync` once per `syncEverySlotS` while an external subtitle shows, and applies the delay when `confidence >= syncMinConfidence` and the shift is at least `syncMinOffsetMs`. Hash-matched subtitles and a delay set by hand are left alone. The media sent is the torrent file itself, also while the TV plays an HLS conversion of it (`__stremioDoctor.sourceTorrent`), so the proxy finds the server holding the torrent; a failed slot is retried once after a minute, and a request that never ends is dropped after `syncTimeoutMs`. On the TV (`subsync.js`) the window is cut as 8 kHz mono WAV on a pipe at a lower CPU priority, every 10 ms frame becomes high-passed log energy, the cues of each common framerate ratio are slid over it by FFT cross-correlation within `maxOffsetS`, and the second half of the window must land on the same delay within `agreeS`, so an unrelated subtitle is rejected; the compute runs on a worker thread so the proxy keeps serving video. The Mac service runs one job at a time, so it limits the subtitle download (`SUBSYNC_FETCH_TIMEOUT_MS`) and, when the TV subtitle converter (`/subtitles.vtt?from=`) fails, reads the original file it wraps.
- `webos-sources.js` lists the ranked streams of the playing title (loading them through the core when the player was opened from the library) and plays the chosen one; `webos-settings.js` stores on/off overrides in `localStorage["twk.overrides"]`, applied by `index.html` before any tweak script runs; a change applies at once without reloading the app: it is written into the live `STREMIO_TWEAKS` section every module reads when it acts, the service gets its switches again (`window.__twkSendServiceOverrides`), and modules with something on screen redraw on the `twk-setting-changed` event.
- Remote keys: green (`sources.hotkey`, 404) source picker, yellow (`settings.hotkey`, 405) settings on a short press, and while the on-screen log shows, a hold of `settings.holdMs` moves the log to the next corner (`debug.position`; `debug.width` sets its width), red (`subtitles.cycleKey`, 403) subtitle cycle, blue (`restart.hotkey`, 406) restart from the beginning (`webos-sources.js`: player seek to 0 and `Ctx/RewindLibraryItem` so a later reload does not jump back; title page `Ctx/RewindLibraryItem` then the best source; `restart.resumeHint` tells where a video resumed).

Test helpers live outside the repo; reproduce on the TV with `ares-inspect` and the Chrome DevTools Protocol (the LG video layer shows as white or black in screenshots).

## Patches

Patches in `patches/` are applied to Vidaa frontend files during `make build`. They are unified diffs against the pinned Vidaa commit.

### audio-track-selection.patch

Adds an `addtrack` event handler to the WebOsVideo player's `<video>` element. This:

1. **Builds the audio track list from the native `audioTracks` API**: the native API returns tracks in Luna's internal order, so `selectTrack` indices match correctly (the original code used `getTracksData` from the streaming server which returns tracks in ffprobe order, a different order)
2. **Enriches track labels** from the streaming server's `/tracks/` endpoint when available
3. **Auto-selects the preferred audio language** from the user's Stremio profile settings (`profile.settings.audioLanguage`)

### torrent-stall-retry.patch

One-line hook in the WebOsVideo `onerror` handler that lets `window.__stremioStallRetry` (from `webos-retry.js`) take over before the error is shown.

### webos-no-external-player.patch

Removes the automatic hand-off to the LG media player (`com.webos.app.photovideo`) on decode/format errors, so playback always stays inside Stremio.

### webos-player-buttons.patch

Adds two buttons to the player control bar: `skip-forward` opens the source picker, `network` toggles the diagnostics panel.

### webos-expose-history.patch

Exposes the router history as `window.__stremioHistory`. The router keeps its own entry stack and treats a single entry as "quit the app" on Back, so tweak scripts must navigate with it instead of `location.hash`.

### webos-expose-subtitles-delay.patch

Exposes the player video controller as `window.__stremioPlayerVideo` and its external subtitle delay setter as `window.__stremioSetSubtitlesDelay`, used by the automatic subtitle sync.

### webos-restart-option.patch

Adds "Recomeçar do início" to the card menu (home, discover, library, search) under "Continue watching": it clears the saved progress (`rewindLibraryItem`) and opens the player from the start.

### webos-subtitle-class.patch

Gives the external subtitles container the `twk-subs` class so the Netflix-like style can target it.

### webos-subtitles-pick.patch

Lets `window.__stremioPickSubtitles` choose the subtitle track before the player's own auto-select, unless a manual choice is saved for the stream.

### webos-resume-position.patch

The WebOsVideo `loadedmetadata` handler seeks to the position the player opened with. A reload by the tweaks (stall retry, HLS conversion, LAN reroute) sets `A.__twkResumeMs` first, so the player resumes where playback was instead of jumping back to an old library position.

### webos-sync-user-args.patch

The start-up sync (`syncUser`, then add-ons, library and notifications) dispatched `PullUserFromAPI` without arguments; the bundled core rejects that action without an arguments object ("missing field `args`"), so the start-up promise failed ("Uncaught (in promise)") and the add-on, library and notification syncs after it never ran. The patch sends an empty arguments object.

### webos-tracks-retry.patch

Longer timeout and retries for the streaming server `/tracks/` call, which lists embedded subtitles and can take 20+ s on a cold torrent.

## Deploy

Requires `@webos-tools/cli` (`npm i -g @webos-tools/cli`, run it with Node 20 or 22). The TV must be configured as device `tv` (`ares-setup-device`, then `ares-novacom --device tv --getkey`).

```sh
make deploy    # build + package + install + launch
make build     # download dependencies + build service/www/
make package   # build + create IPK
make restart   # close + relaunch on TV
make clean     # remove all build artifacts
make ffmpeg    # optional: bundle static ffmpeg (needs ~100 MB free on the TV app partition)
```

Optional Mac services (faster torrents for videos the TV cannot keep up with, 10 GB disk cache, HLS/audio conversion, subtitle sync): `./mac/install.sh` (running it again restarts only the agents whose files changed, so a video being served keeps playing). The TV finds the Mac on port 11480 by itself; `servers.candidates` and `servers.transcoders` only seed the first try. A DHCP reservation for the Mac avoids the subnet scan.
