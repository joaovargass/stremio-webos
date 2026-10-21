#!/usr/bin/env bash
#
# Installs a dedicated Stremio streaming server on macOS for the webOS app:
# official server.js patched to listen on STREMIO_PORT, Homebrew ffmpeg for HLS,
# disk cache, the "Fast" torrent profile, kept alive by launchd and caffeinate.
# Also installs the subtitle sync service (ffsubsync in its own Python venv, on
# SUBSYNC_PORT) and the daily Dev Mode keepalive. Safe to run again: an agent is
# restarted only when its files changed or it is not loaded, so a video being
# served is not interrupted.
#
# Requires: Homebrew node@22 and ffmpeg, curl, python3.
# Usage: ./mac/install.sh   (env: SERVER_VERSION, STREMIO_PORT, SUBSYNC_PORT, CACHE_BYTES)
#
set -euo pipefail

SERVER_VERSION="${SERVER_VERSION:-4.20.17}"
STREMIO_PORT="${STREMIO_PORT:-11480}"
SUBSYNC_PORT="${SUBSYNC_PORT:-11481}"
CACHE_BYTES="${CACHE_BYTES:-10737418240}"
NODE_BIN="${NODE_BIN:-/opt/homebrew/opt/node@22/bin/node}"
FFMPEG_DIR="${FFMPEG_DIR:-/opt/homebrew/bin}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/stremio-lan-server"
AGENTS="$HOME/Library/LaunchAgents"
SERVER_LABEL="com.joaovargass.stremio-lan-server"
KEEPALIVE_LABEL="com.joaovargass.webos-devmode-keepalive"
SUBSYNC_LABEL="com.joaovargass.stremio-subsync"
VENV="$HOME/.local/share/stremio-subsync/venv"

for bin in "$NODE_BIN" "$FFMPEG_DIR/ffmpeg" "$FFMPEG_DIR/ffprobe"; do
    [ -x "$bin" ] || { echo "ERROR: $bin not found"; exit 1; }
done

mkdir -p "$DEST/data" "$AGENTS"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Copy a staged file into place and print 1 when its content changed, 0 when it was already there
install_file() {
    if cmp -s "$1" "$2"; then
        echo 0
    else
        cp "$1" "$2"
        echo 1
    fi
}

echo "==> Downloading Stremio server v$SERVER_VERSION (desktop build)"
curl -fsSL -o "$STAGE/server.js" "https://dl.strem.io/server/v$SERVER_VERSION/desktop/server.js"
python3 "$HERE/patch-server.py" "$STAGE/server.js"
SERVER_CHANGED=$(install_file "$STAGE/server.js" "$DEST/server.js")
SUBSYNC_CHANGED=$(install_file "$HERE/subsync.js" "$DEST/subsync.js")
install_file "$HERE/devmode-keepalive.sh" "$DEST/devmode-keepalive.sh" >/dev/null

echo "==> Installing ffsubsync into $VENV"
[ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip ffsubsync

echo "==> Writing launchd agents"
cat > "$STAGE/$SERVER_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$SERVER_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/caffeinate</string><string>-i</string>
        <string>$NODE_BIN</string><string>$DEST/server.js</string>
    </array>
    <key>WorkingDirectory</key><string>$DEST</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>STREMIO_PORT</key><string>$STREMIO_PORT</string>
        <key>NO_HTTPS_SERVER</key><string>1</string>
        <key>CASTING_DISABLED</key><string>1</string>
        <key>NO_CORS</key><string>1</string>
        <key>APP_PATH</key><string>$DEST/data</string>
        <key>FFMPEG_BIN</key><string>$FFMPEG_DIR/ffmpeg</string>
        <key>FFPROBE_BIN</key><string>$FFMPEG_DIR/ffprobe</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ProcessType</key><string>Background</string>
    <key>StandardOutPath</key><string>$DEST/server.log</string>
    <key>StandardErrorPath</key><string>$DEST/server.log</string>
</dict>
</plist>
EOF
cat > "$STAGE/$SUBSYNC_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$SUBSYNC_LABEL</string>
    <key>ProgramArguments</key>
    <array><string>$NODE_BIN</string><string>$DEST/subsync.js</string></array>
    <key>WorkingDirectory</key><string>$DEST</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>SUBSYNC_PORT</key><string>$SUBSYNC_PORT</string>
        <key>FFMPEG_BIN</key><string>$FFMPEG_DIR/ffmpeg</string>
        <key>FFS_BIN</key><string>$VENV/bin/ffs</string>
        <key>PATH</key><string>$FFMPEG_DIR:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ProcessType</key><string>Background</string>
    <key>StandardOutPath</key><string>$DEST/subsync.log</string>
    <key>StandardErrorPath</key><string>$DEST/subsync.log</string>
</dict>
</plist>
EOF
cat > "$STAGE/$KEEPALIVE_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$KEEPALIVE_LABEL</string>
    <key>ProgramArguments</key>
    <array><string>/bin/bash</string><string>$DEST/devmode-keepalive.sh</string></array>
    <key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>
    <key>StandardOutPath</key><string>$DEST/devmode.log</string>
    <key>StandardErrorPath</key><string>$DEST/devmode.log</string>
</dict>
</plist>
EOF

echo "==> (Re)loading agents whose files changed"
SERVER_RESTARTED=0
for label in "$SERVER_LABEL" "$SUBSYNC_LABEL" "$KEEPALIVE_LABEL"; do
    changed=$(install_file "$STAGE/$label.plist" "$AGENTS/$label.plist")
    [ "$label" = "$SERVER_LABEL" ] && [ "$SERVER_CHANGED" = 1 ] && changed=1
    [ "$label" = "$SUBSYNC_LABEL" ] && [ "$SUBSYNC_CHANGED" = 1 ] && changed=1
    if [ "$changed" = 0 ] && launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
        echo "    $label unchanged, kept running"
        continue
    fi
    echo "    $label (re)starting"
    [ "$label" = "$SERVER_LABEL" ] && SERVER_RESTARTED=1
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    # bootout is asynchronous; bootstrapping before the old job is gone fails with EIO
    for _ in $(seq 1 20); do
        launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 || break
        sleep 0.5
    done
    launchctl bootstrap "gui/$(id -u)" "$AGENTS/$label.plist"
done

if [ "$SERVER_RESTARTED" = 1 ]; then
    echo "==> Waiting for the server on :$STREMIO_PORT"
    for _ in $(seq 1 30); do
        curl -fs -o /dev/null "http://127.0.0.1:$STREMIO_PORT/settings" && break
        sleep 1
    done

    echo "==> Applying the Fast torrent profile (soft limit = hard limit, so the cache fills ahead) and disk cache"
    curl -fsS -X POST -H 'Content-Type: application/json' \
        -d "{\"btDownloadSpeedHardLimit\":39321600,\"btDownloadSpeedSoftLimit\":39321600,\"btHandshakeTimeout\":20000,\"btMaxConnections\":200,\"btMinPeersForStable\":10,\"btRequestTimeout\":4000,\"cacheSize\":$CACHE_BYTES}" \
        "http://127.0.0.1:$STREMIO_PORT/settings"
    echo
fi
echo "Done: http://$(ipconfig getifaddr en0 2>/dev/null || echo '<mac-ip>'):$STREMIO_PORT/ (the TV finds it on port $STREMIO_PORT by itself)"
