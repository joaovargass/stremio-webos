"""Make the official Stremio streaming server listen on a configurable port.

The desktop build hardcodes port 11470 for its HTTP listener and for a few
requests it sends to itself. Each reference is replaced by STREMIO_PORT (default
11470) so a dedicated LAN server can run next to the Stremio desktop app.

Usage: python3 patch-server.py path/to/server.js
"""

import sys

PORT_EXPR = 'parseInt(process.env.STREMIO_PORT || "11470", 10)'
PORT_STR = '(process.env.STREMIO_PORT || "11470")'
PATCHES = [
    (
        "enginefs._server = http.createServer(app)), port = 11470;",
        f"enginefs._server = http.createServer(app)), port = {PORT_EXPR};",
    ),
    (
        'fetch("http://127.0.0.1:11470/subtitles.srt?from="',
        f'fetch("http://127.0.0.1:" + {PORT_STR} + "/subtitles.srt?from="',
    ),
    (
        'let engineUrl = "http://127.0.0.1:11470";',
        f'let engineUrl = "http://127.0.0.1:" + {PORT_STR};',
    ),
    (
        'let ip = "127.0.0.1", port = 11470;',
        f'let ip = "127.0.0.1", port = {PORT_EXPR};',
    ),
    (
        "serverPort = serverPort || 11470;",
        f"serverPort = serverPort || {PORT_EXPR};",
    ),
]


def patch(path: str) -> None:
    """Apply every port patch exactly once, failing loudly on layout changes."""
    # Read as surrogate-escaped text so the minified bundle round-trips unchanged
    with open(path, encoding="utf-8", errors="surrogateescape") as handle:
        source = handle.read()
    for old, new in PATCHES:
        # Each anchor must appear exactly once or the upstream bundle changed
        found = source.count(old)
        if found != 1:
            sys.exit(f"ERROR: expected 1 occurrence of {old[:50]!r}, found {found}")
        source = source.replace(old, new)
    with open(path, "w", encoding="utf-8", errors="surrogateescape") as handle:
        handle.write(source)
    print(f"server.js patched: {len(PATCHES)} port references")


if __name__ == "__main__":
    patch(sys.argv[1])
