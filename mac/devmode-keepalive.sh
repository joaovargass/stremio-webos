#!/usr/bin/env bash
#
# Resets the webOS Dev Mode session timer back to 1000 hours so the TV never
# uninstalls sideloaded apps. Adapted from n0n3333/stremio-webos26.
#
# Usage: ./devmode-keepalive.sh   (token read from ~/.config/webos/devmode_token)
# Get the token once: ares-novacom --device tv --run "cat /var/luna/preferences/devmode_enabled"
#
set -euo pipefail

TOKEN_FILE="${DEVMODE_TOKEN_FILE:-$HOME/.config/webos/devmode_token}"
API="https://developer.lge.com/secure"

[ -f "$TOKEN_FILE" ] || { echo "ERROR: token file $TOKEN_FILE missing" >&2; exit 1; }
TOKEN="$(tr -d '\r\n ' < "$TOKEN_FILE")"

reset=$(curl -fsS --max-time 30 "$API/ResetDevModeSession.dev?sessionToken=$TOKEN")
remaining=$(curl -fsS --max-time 30 "$API/CheckDevModeSession.dev?sessionToken=$TOKEN")
left=$(printf '%s' "$remaining" | sed -n 's/.*"errorMsg":"\([^"]*\)".*/\1/p')

case "$reset" in
    *'"result":"success"'*) echo "$(date '+%F %T') dev mode session reset, ${left:-unknown} left" ;;
    *) echo "$(date '+%F %T') reset FAILED: $reset" >&2; exit 1 ;;
esac
