# Stremio for webOS

Custom Stremio app for LG webOS TVs with working default audio language selection.

The official Stremio app has a bug where it always plays the first audio track in the list, ignoring the user's preferred audio language setting. This build fixes that by reading tracks from the TV's native media pipeline and automatically selecting the track matching your configured language.

Built from [Stremio Theater v1.9.2](https://github.com/NoobyGains/stremio-vidaa-tv) with the official Stremio streaming server.

## Playback tweaks for webOS 25

This fork installs next to the official app (`com.joaovargass.stremiodbg`) and fixes the "Video is not supported / MEDIA_ELEMENT_ERROR: Format error" failures seen on webOS 25:

Everything runs on the TV by default. A Mac on the same network is optional and only used for what the TV cannot do, always with an on-screen notice.

- **TV first.** The TV's own streaming server serves every video. When the TV swarm cannot keep up, only that video is fetched through the Mac; a source the TV is known to be too slow for is warmed on the Mac already on the title page, so the click to play starts there at once (`./mac/install.sh`), which the app finds by itself even after the router changes IP addresses.
- **Faster start.** The recommended source is started and its first megabyte fetched while the stream list is open, and a RAM read-ahead window on the TV keeps data beyond the player's own ~30 s buffer.
- **Simple mode.** The title page shows one "Assistir" entry with the best source for the preferred quality (best up to 4K, 4K, 1080p or 720p) and a one-line summary; every source stays one press away on the green key.
- **Quiet, patient automatic recovery.** Slowness alone is only reported. Moving a video to the Mac happens inside the TV proxy at the next byte, so the picture never reloads. While a video struggles or is slow to start, the next sources are started in the background at the same position, on the Mac when the video already uses it, so a switch lands on a source that is already warm where it will play. Every reload continues at the current position. A video that shows nothing after 5 s races the next sources in the background and, from 20 s on, moves to the one that is really downloading (up to 3 times before the first picture, 60 s at most when none is alive); a picture frozen for 45 s is first fetched through the Mac, then moved once to the next source; a Mac that has not started downloading the video within 15 s gives it back to the TV at once; every action is followed by a calm period. A starved torrent is reloaded at the same position instead of failing with "Format error"; a picture that freezes although its data is already downloaded (a damaged file the TV cannot decode) is converted on the Mac after 10 s instead of waiting for the TV to give up; files the TV plays silently (DTS, TrueHD) are converted to AAC on the Mac or skipped when no Mac is available. Playback never leaves Stremio.
- **Best stream first.** Streams are ranked by swarm health, resolution and compatibility, with warnings for DTS/TrueHD, remux, Dolby Vision without HDR, 3D and cinema copies (CAM, TS, telesync, screener), which drop below real releases. The app learns how fast the TV and the Mac really download, and moves sources heavier than that below lighter ones, so a fresh release with an unproven 4K swarm starts in 1080p.
- **Subtitles.** The subtitle languages set in Stremio come first, then embedded tracks, Brazilian Portuguese and the language being heard, avoiding SDH and forced tracks; the audio follows the Stremio audio language. External subtitles are ordered by how likely they match the release (OpenSubtitles hash, release group, source tags), shown in a Netflix-like style, and re-timed automatically with the Mac sync service (ffsubsync on a window of audio around the playback position, framerate drift included, applied through the player delay only when two independent halves of the window agree). Shifts of a few seconds are corrected reliably, also on continuous speech; a framerate drift that has grown to tens of seconds is not reliably detected in one window.
- **Player controls.** Source picker on the player bar and on the green remote key, also while a video is loading; the red key cycles subtitles (best embedded, other embedded, external, off); the blue key restarts from the beginning (on the player, and on the title page where it also clears the saved progress) and every card menu has "Recomeçar do início"; a resumed video says where it resumed; diagnostics panel on the player bar (health, buffer, server, swarm, subtitle choice).
- **Settings on the TV.** The yellow remote key opens switches, choice rows for quality and debug detail, and an action to open the full debug log. Choices are saved on the TV; changes apply after the panel closes and the app reloads.
- **Interface language.** The helper panels and messages follow the Stremio profile's interface language. English (`en-US`/`eng`) and Brazilian Portuguese (`pt-BR`/`pob`) are supported; missing or other values fall back to English. This covers the tweaks' settings, source picker, diagnostics, subtitle/recovery messages and stream labels, while diagnostic log entries remain English. The surrounding Stremio interface continues to use Stremio's own language behavior.

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
