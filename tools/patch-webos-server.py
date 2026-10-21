"""Adapt the webOS streaming server build to the TV app.

The webOS build sets HLS_V2_DISABLED at start, so its /hlsv2 router is never mounted and
/hlsv2 requests fall into older routes ("Cannot parse path", 415). The TV app ships its own
small ffmpeg and needs that converter for DTS/TrueHD audio and pictures the TV cannot decode.
The mp4 track reader also prints every box it parses, Buffers included, on each track listing,
which costs TV CPU and buries the service log. Every new torrent starts a cache cleanup; when
several start together, two cleanups delete the same leftover file and the second one logged
the missing file as an error, although the file being gone is the goal.

Usage: python3 tools/patch-webos-server.py path/to/server.js
"""

import sys

PATCHES = [
    (
        "process.env.NO_CORS=1,process.env.HLS_V2_DISABLED=1,process.env.UNITY_ENV&&",
        "process.env.NO_CORS=1,process.env.UNITY_ENV&&",
    ),
    (
        "return console.log(a),!u&&i?",
        "return!u&&i?",
    ),
    (
        "deleted++,fs.unlink(f.path,(function(e){e&&console.error(e)}))",
        'deleted++,fs.unlink(f.path,(function(e){e&&"ENOENT"!==e.code&&console.error(e)}))',
    ),
]


def patch(path: str) -> None:
    """Apply every patch exactly once, skipping applied ones and failing loudly on layout changes."""
    # Read as surrogate-escaped text so the minified bundle round-trips unchanged
    with open(path, encoding="utf-8", errors="surrogateescape") as handle:
        source = handle.read()
    applied = 0
    for old, new in PATCHES:
        # A patch already in the file leaves its anchor gone and its replacement in place once
        found = source.count(old)
        if found == 0 and source.count(new) == 1:
            continue
        # Each anchor must appear exactly once or the upstream bundle changed
        if found != 1:
            sys.exit(f"ERROR: expected 1 occurrence of {old[:50]!r}, found {found}")
        source = source.replace(old, new)
        applied += 1
    with open(path, "w", encoding="utf-8", errors="surrogateescape") as handle:
        handle.write(source)
    print(f"server.js patched: {applied} of {len(PATCHES)} changes applied now")


if __name__ == "__main__":
    patch(sys.argv[1])
