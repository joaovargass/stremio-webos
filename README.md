# Stremio for webOS

Custom Stremio app for LG webOS TVs with working default audio language selection.

The official Stremio app has a bug where it always plays the first audio track in the list, ignoring the user's preferred audio language setting. This build fixes that by reading tracks from the TV's native media pipeline and automatically selecting the track matching your configured language.

Built from [Stremio Theater v1.9.2](https://github.com/NoobyGains/stremio-vidaa-tv) with the official Stremio streaming server.

## Playback tweaks for webOS 25

This fork installs next to the official app (`com.joaovargass.stremiodbg`) and fixes the "Video is not supported / MEDIA_ELEMENT_ERROR: Format error" failures seen on webOS 25.

Everything works on the TV alone. A computer on the same network (`./mac/install.sh`) is optional: the TV finds it by itself, even after the router hands out new addresses, and uses it first for streaming, conversions and subtitle sync whenever it answers; when it stops answering, the open video continues on the TV at the next byte.

- **Netflix-like screens.** A left menu (Search, Home, Series, Movies, My List, Settings, App tweaks) replaces Stremio's discovery boards. Home opens on a billboard carousel with the title's trailer playing behind it, then rows: Continue Watching, Top 10, picks from your watch history (because you watched, genres, new releases, critically acclaimed, watch it again). Title details show Play or Resume (best source at once), My List, Start over, All sources, one row per season and More like this. Search has an on-screen keyboard, picks before typing and results ordered by name match, then taste. The Stremio library becomes My List.
- **Recommendations from your history.** Built on the TV from the library and watch progress (genres, people, franchises, decades, recency, completions and abandoned titles), with diversity inside each row and fatigue for titles shown often but never opened. When the computer runs a local model (Ollama), it adds daily and weekly themed rows picked only from the TV's own shortlist; the TV keeps them for a week without the computer.
- **Faster start.** The recommended source is started and its first megabytes fetched while the title page is open, and a RAM read-ahead window on the TV keeps data beyond the player's own buffer.
- **Simple mode.** The title page shows one Watch entry with the best source for the preferred quality (best up to 4K, 4K, 1080p or 720p) and a one-line summary; every source stays one press away on the green key.
- **Decisions on measured evidence.** Sources are measured over time on the file itself (bytes delivered, peers found and connected); a source is called dead only when another one proves the network works at the same moment. Before the first picture the app races the next sources and moves to one that really downloads faster; after it, a source is changed only for a frozen picture or a stuttering one, and never to a source known to lack the subtitle language that the current file carries. A starved torrent is reloaded at the same position instead of failing with "Format error". Every action is followed by a calm period, and every reload continues at the current position.
- **Conversions.** Files the TV plays silently (DTS, TrueHD) or cannot decode are converted to HLS with AAC audio, on the computer when one answers and on the TV's own ffmpeg otherwise; a picture that freezes although its data is already downloaded is converted after a few seconds. Playback never leaves Stremio.
- **Best stream first.** Streams are ranked by swarm health, resolution and compatibility, with warnings for DTS/TrueHD, remux, Dolby Vision without HDR, 3D, audio description and cinema copies (CAM, TS, telesync, screener), which drop below real releases. The app learns how fast the TV and the computer really download and moves sources heavier than that below lighter ones.
- **Subtitles.** The subtitle languages set in Stremio come first, then embedded tracks and the configured priority, avoiding SDH and forced tracks; the audio follows the Stremio audio language. External subtitles are ordered by how likely they match the release (OpenSubtitles hash, release group, source tags), shown in a Netflix-like style, and re-timed automatically: the TV measures the delay against the audio around the playback position and applies it only when two halves of the window agree; the computer's sync service answers only when the TV is unsure. "Sync subtitles now" in the source picker measures on request.
- **Player controls.** Source picker on the player bar and on the green key, also while a video is loading, with Convert this video and Sync subtitles now; the red key cycles subtitles; the blue key starts over (on the player, and on the title page where it also clears the saved progress), and every card menu has "Start over from the beginning"; a resumed video says where it resumed; the diagnostics panel (player bar) shows health, buffer, server, swarm, a map of the file's downloaded parts and the subtitle choice.
- **Settings on the TV.** The yellow key (or App tweaks in the menu) opens switches, choice rows and the full debug log; every change applies at once, without reloading the app or stopping the video. Holding yellow moves the on-screen log to the next corner.
- **Interface language.** The panels, screens and messages follow the Stremio profile's interface language; the start screen follows the TV language. English and Brazilian Portuguese are supported; other values fall back to English. Diagnostic log lines stay in English.

Defaults live in `service/tweaks.json`.

## Prerequisites

1. Install the [webOS TV CLI](https://www.npmjs.com/package/@webos-tools/cli): `npm i -g @webos-tools/cli` (run it with Node.js 20 or 22)
2. Either enable [Developer Mode](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app) on your TV, or have [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel) installed
3. Configure your TV as a device — `ares-setup-device`

> **Note:** Developer Mode expires after 1000 hours and any sideloaded apps will be uninstalled. Rooted TVs with Homebrew Channel do not have this limitation.

## Install via Homebrew Channel

If your TV is rooted with [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel):

1. Open Homebrew Channel on your TV
2. Go to settings and add this repository: `https://raw.githubusercontent.com/kieranbrown/stremio-webos/main/webosbrew/apps.json`
3. Find Stremio in the app list and install

## Install manually

```sh
make deploy
```

This downloads all dependencies, builds the app, packages the IPK, installs it on your TV, and launches it.

Replace the default device name if needed: `make deploy DEVICE=myTV`

### Other commands

```sh
make build     # Download dependencies + build (no install)
make package   # Build + create IPK
make restart   # Close + relaunch on TV
make clean     # Remove build artifacts
```

## Auto-start on input select

On rooted TVs, you can register Stremio as an input source so it appears in the TV's input list and can auto-launch:

```sh
luna-send-pub -n 1 'luna://com.webos.service.eim/addDevice' '{"appId":"io.strem.tv","pigImage":""}'
```

Run this via SSH on the TV.

## Credits

- [Stremio](https://www.stremio.com/)
- [NoobyGains/stremio-vidaa-tv](https://github.com/NoobyGains/stremio-vidaa-tv) — Theater frontend
- [webOS Homebrew Project](https://www.webosbrew.org/)
