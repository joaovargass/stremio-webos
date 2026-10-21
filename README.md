# Stremio for webOS

Custom Stremio app for LG webOS TVs with working default audio language selection.

The official Stremio app has a bug where it always plays the first audio track in the list, ignoring the user's preferred audio language setting. This build fixes that by reading tracks from the TV's native media pipeline and automatically selecting the track matching your configured language.

Built from [Stremio Theater v1.9.2](https://github.com/NoobyGains/stremio-vidaa-tv) with the official Stremio streaming server.

## Playback tweaks for webOS 25

This fork installs next to the official app (`com.joaovargass.stremiodbg`) and fixes the "Video is not supported / MEDIA_ELEMENT_ERROR: Format error" failures seen on webOS 25:

Everything runs on the TV by default. A Mac on the same network is optional and only used for what the TV cannot do, always with an on-screen notice.

- **TV first.** The TV's own streaming server serves every video. When the TV swarm cannot keep up, only that video is fetched through the Mac (`./mac/install.sh`), which the app finds by itself even after the router changes IP addresses.
- **Faster start.** The recommended source is started and its first megabyte fetched while the stream list is open, and a RAM read-ahead window on the TV keeps data beyond the player's own ~30 s buffer.
- **Automatic recovery.** A starved torrent is reloaded at the same position instead of failing with "Format error"; a source that stays too slow switches to the next ranked one; files the TV plays silently (DTS, TrueHD) are converted to AAC on the Mac or skipped when no Mac is available. Playback never leaves Stremio.
- **Best stream first.** Streams are ranked by swarm health, resolution and compatibility, with warnings for DTS/TrueHD, remux, Dolby Vision without HDR and 3D.
- **Subtitles.** Embedded tracks first, then Brazilian Portuguese, then the original language, avoiding SDH. External subtitles are ordered by how likely they match the release (OpenSubtitles hash, release group, source tags), shown in a Netflix-like style, and re-timed automatically with the Mac sync service (ffsubsync on a window of audio around the playback position, framerate drift included, applied through the player delay only when confident).
- **Player controls.** Source picker on the player bar and on the green remote key, also while a video is loading; diagnostics panel on the player bar (health, buffer, server, swarm, subtitle choice).
- **Settings on the TV.** The yellow remote key opens an on/off switch for every tweak; choices are saved on the TV.

Defaults live in `service/tweaks.json`.

## Prerequisites

1. Install the [webOS ares CLI](https://www.npmjs.com/package/@webosose/ares-cli) — `npm i -g @webosose/ares-cli` (requires Node.js 20 for SSH compatibility)
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
