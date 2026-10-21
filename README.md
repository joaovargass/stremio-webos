# Stremio for webOS

Custom Stremio app for LG webOS TVs with working default audio language selection.

The official Stremio app has a bug where it always plays the first audio track in the list, ignoring the user's preferred audio language setting. This build fixes that by reading tracks from the TV's native media pipeline and automatically selecting the track matching your configured language.

Built from [Stremio Theater v1.9.2](https://github.com/NoobyGains/stremio-vidaa-tv) with the official Stremio streaming server.

## Playback tweaks for webOS 25

This fork installs next to the official app (`com.joaovargass.stremiodbg`) and fixes the "Video is not supported / MEDIA_ELEMENT_ERROR: Format error" failures seen on webOS 25:

- **Starved torrents are recovered, not reported as unsupported.** The LG pipeline reports ~40 s without data as a format error; the player now reloads at the same position and shows the swarm state.
- **Everything plays inside Stremio.** No hand-off to the LG media player. Files the TV plays silently (DTS, TrueHD) or rejects are switched to an HLS remux with AAC audio, keeping 5.1.
- **Faster torrents.** Extra trackers on every torrent, and an optional Mac streaming server (`./mac/install.sh`) with the "Fast" profile and a disk cache. The app picks the first reachable server and falls back to the TV automatically.
- **Best stream first.** Streams are ranked by swarm health, resolution and compatibility, with warnings for DTS/TrueHD, remux, Dolby Vision without HDR and 3D.
- **Diagnostics button** in the player control bar: server, peers, speed against the needed bitrate, buffer and recoveries.

All settings live in `service/tweaks.json`.

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
