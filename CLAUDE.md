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
  launch.js           # Entry point: serves www/ on :8080, proxies to the best reachable streaming server
  index.html          # Theater entry point (sets __STREMIO_SERVER_URL__ to :8080, loads tweaks.json)
  tweaks.json         # All playback tweak settings, shared by launch.js and the frontend
  webos-enhance.js    # Points the profile at the proxy, adds trackers, ranks streams
  webos-retry.js      # Stall recovery and in-player HLS fallback (no external player)
  webos-diag.js       # Diagnostics panel opened from the player control bar
  webos-ui.css        # Styles for the toast and the diagnostics panel
  package.json        # Service manifest (main: launch.js)
  services.json       # Luna service registration
  server.js           # [downloaded] Official Stremio streaming server
  www/                # [built] Vidaa frontend + patches applied

patches/              # Patches applied to Vidaa frontend files during build (alphabetical order)

mac/                  # Optional dedicated streaming server for a Mac on the same LAN
  install.sh          # Installs the patched server + launchd agents (idempotent)
  patch-server.py     # Makes server.js listen on STREMIO_PORT
  devmode-keepalive.sh # Resets the 1000 h Dev Mode session daily
```

## How it works

1. `make build` downloads the Vidaa frontend (pinned to a specific commit) and Stremio server, copies frontend files into `service/www/`, applies patches
2. `make deploy` packages the IPK via `ares-package` and installs via `ares-install`
3. On launch: `app/index.html` starts the server service via Luna, polls `:8080` with an `<img>` load, redirects when ready
4. `service/launch.js` serves the Theater frontend on `:8080` and proxies all non-static requests to the first reachable server in `tweaks.json` `servers.candidates` (probed in parallel every `recheckIntervalMs`, never switched while a video is being served). It starts the bundled `server.js` only when nothing already answers on `:11470` (the official app's service usually does), which saves RAM. `GET /__tweaks/status` reports the selected upstream.

The proxy exists because the app loads from `file://` which cannot XHR/fetch to `http://` origins (CORS restriction on webOS Chrome 68). Serving everything from `:8080` makes all requests same-origin. It also lets the app use a LAN server: the desktop streaming server only sends CORS headers to `*.strem.io`/`*.stremio.com` and `127.0.0.1:11470`, so the browser cannot call it directly, but the Node proxy can.

## Playback tweaks

Findings behind them (LG 55UR8750PSA, webOS 25 10.3.2): the native pipeline plays H.264/HEVC 8/10-bit/AV1, MP4/MKV, AAC/AC3/E-AC3 and 4K directly; a torrent that delivers no bytes for ~40 s is reported as `MEDIA_ELEMENT_ERROR: Format error`; DTS/TrueHD files play silently (`audioTracks.length === 0`); the official server defaults to a 3.5 MB/s torrent cap and a 45 MB memory buffer.

- `webos-enhance.js` sets `streamingServerUrl` to `servers.coreUrl` (local profile setting only, never synced), re-creates every torrent with `trackers` (`POST /<hash>/create`) and wraps `core.getState('meta_details')` to rank streams by swarm health, resolution and compatibility (`ranking`), adding a recommended badge and warnings.
- `webos-retry.js` is called from the WebOsVideo error handler: a starved torrent is reloaded at the last position (`stallRetry`), a rejected format or a stream without a playable audio track switches to `/hlsv2/.../master.m3u8` on the streaming server (`hlsFallback`). The server always re-encodes audio to AAC and keeps the channel count.
- `webos-diag.js` renders server, swarm, speed against the needed bitrate, buffer and recovery state; it polls only while open (`diagnostics.refreshMs`).

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

### webos-diagnostics-button.patch

Adds a `network` icon button to the player control bar that toggles the diagnostics panel.

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

Optional Mac streaming server (faster torrents, 10 GB disk cache, HLS/audio conversion): `./mac/install.sh`, then put `http://<mac-ip>:11480/` first in `servers.candidates`.
