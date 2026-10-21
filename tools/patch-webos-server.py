"""Turn the HLS v2 converter of the webOS streaming server build back on.

The webOS build sets HLS_V2_DISABLED at start, so its /hlsv2 router is never mounted and
/hlsv2 requests fall into older routes ("Cannot parse path", 415). The TV app ships its own
small ffmpeg and needs that converter for DTS/TrueHD audio and pictures the TV cannot decode.

Usage: python3 tools/patch-webos-server.py path/to/server.js
"""

import sys

PATCHES = [
    (
        "process.env.NO_CORS=1,process.env.HLS_V2_DISABLED=1,process.env.UNITY_ENV&&",
        "process.env.NO_CORS=1,process.env.UNITY_ENV&&",
    ),
]


def patch(path: str) -> None:
    """Apply every patch exactly once, failing loudly on layout changes."""
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
    print(f"server.js patched: {len(PATCHES)} change")


if __name__ == "__main__":
    patch(sys.argv[1])
