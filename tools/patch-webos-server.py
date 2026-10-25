"""Adapt the webOS streaming server build to the TV app.

The webOS build sets HLS_V2_DISABLED at start, so its /hlsv2 router is never mounted and
/hlsv2 requests fall into older routes ("Cannot parse path", 415). The TV app ships its own
small ffmpeg and needs that converter for DTS/TrueHD audio and pictures the TV cannot decode.
The mp4 track reader also prints every box it parses, Buffers included, on each track listing,
which costs TV CPU and buries the service log. Every new torrent starts a cache cleanup; when
several start together, two cleanups delete the same leftover file and the second one logged
the missing file as an error, although the file being gone is the goal. The player timeline
needs to show which parts of a file are downloaded and well seeded, which only the engine knows,
so a /<infohash>/<file>/pieces.json route returns that map, and the playback doctor reads from the same route how
much data follows the playhead without a gap.

Usage: python3 tools/patch-webos-server.py path/to/server.js
"""

import sys

# Per-file piece map for the player timeline: for each of N equal parts of the file, the share of pieces already
# downloaded, how many connected peers hold them on average (a wire keeps its peer's pieces as a plain array of
# booleans), and the ranges the engine is fetching first; with a byte position, also the downloaded bytes that
# follow it without a gap (buckets=0 skips the parts, for a cheap check of the data ahead of the playhead)
PIECE_MAP = (
    "function getPieceMap(e,idx,n,at){"
    "if(!e||!e.torrent||!e.bitfield||!e.torrent.files[idx])return null;"
    "var file=e.torrent.files[idx],size=e.torrent.pieceLength,"
    "start=file.offset/size|0,end=(file.offset+file.length-1)/size|0,total=end-start+1,"
    'count="0"===n?0:Math.max(1,Math.min(400,parseInt(n,10)||100,total)),wires=e.swarm.wires,parts=[],ahead=null;'
    'if(null!=at&&""!==at){var pos=file.offset+Math.max(0,Math.min(file.length-1,parseInt(at,10)||0)),p=pos/size|0;'
    "for(;p<=end&&e.bitfield.get(p);)p++;ahead=Math.max(0,Math.min(file.offset+file.length,p*size)-pos)}"
    "for(var b=0;b<count;b++){"
    "var from=start+Math.floor(b*total/count),to=start+Math.floor((b+1)*total/count)-1,have=0,held=0;"
    "for(var i=from;i<=to;i++){e.bitfield.get(i)&&have++;"
    "for(var w=0;w<wires.length;w++)wires[w].peerPieces[i]&&held++}"
    "var len=to-from+1;parts.push([Math.round(have/len*100)/100,Math.round(held/len*10)/10])}"
    "return{pieceLength:size,pieces:total,peers:wires.length,downloadSpeed:e.swarm.downloadSpeed(),ahead:ahead,"
    "parts:parts,selections:e.selection.map((function(s){return[Math.max(0,s.from-start),Math.min(total-1,s.to-start),s.priority]}))}}"
)

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
    (
        "function getStatistics(e,idx){",
        PIECE_MAP + "function getStatistics(e,idx){",
    ),
    (
        'router.get("/:infoHash/:idx/stats.json",(function(req,res){res.writeHead(200,jsonHead),'
        "res.end(JSON.stringify(getStatistics(engines[req.params.infoHash],req.params.idx)))})),",
        'router.get("/:infoHash/:idx/stats.json",(function(req,res){res.writeHead(200,jsonHead),'
        "res.end(JSON.stringify(getStatistics(engines[req.params.infoHash],req.params.idx)))})),"
        'router.get("/:infoHash/:idx/pieces.json",(function(req,res){res.writeHead(200,jsonHead),'
        "res.end(JSON.stringify(getPieceMap(engines[req.params.infoHash],req.params.idx,"
        "url.parse(req.url,!0).query.buckets,url.parse(req.url,!0).query.at)))})),",
    ),
]


def patch(path: str) -> None:
    """Apply every patch exactly once, skipping applied ones and failing loudly on layout changes."""
    # Read as surrogate-escaped text so the minified bundle round-trips unchanged
    with open(path, encoding="utf-8", errors="surrogateescape") as handle:
        source = handle.read()
    applied = 0
    for old, new in PATCHES:
        # A patch already in the file has its replacement in place; some replacements keep their anchor inside
        if source.count(new) == 1:
            continue
        found = source.count(old)
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
