// Subtitle conversion for the player: reads SRT, WebVTT, ASS/SSA and MicroDVD files in any common
// encoding and writes clean WebVTT. The player renders cue text with vtt.js, which knows only a few
// HTML entities and treats any "<" as a tag, so every cue is decoded and re-escaped here.
var zlib = require('zlib');

var NAMED = {
    nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", hellip: '…', mdash: '—', ndash: '–',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', iexcl: '¡', iquest: '¿',
    copy: '©', reg: '®', trade: '™', deg: '°', euro: '€', pound: '£', cent: '¢', middot: '·', bull: '•',
    ordf: 'ª', ordm: 'º', sect: '§', para: '¶', times: '×', divide: '÷', shy: '', lrm: '', rlm: '',
    zwnj: '', zwj: '', thinsp: ' ', ensp: ' ', emsp: ' ', szlig: 'ß', aelig: 'æ', oslash: 'ø', aring: 'å'
};
var MARKS = { acute: '́', grave: '̀', circ: '̂', uml: '̈', tilde: '̃', cedil: '̧', ring: '̊' };
// Windows-1252 differs from Latin-1 only in 0x80-0x9F, where subtitle files keep quotes, dashes and the ellipsis
var CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
var ALLOWED_TAG = /<\/?(i|b|u)>/gi;

function decodeBytes(buffer) {
    // Text from UTF-8 or UTF-16 with a byte order mark, UTF-8 when valid, else Windows-1252
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.slice(2).toString('utf16le');
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
        var swapped = Buffer.from(buffer.slice(2));
        swapped.swap16();
        return swapped.toString('utf16le');
    }
    var text = buffer.toString('utf8');
    if (text.indexOf('�') === -1) return text.replace(/^﻿/, '');
    // Invalid UTF-8: a legacy single-byte file, as most Portuguese and Spanish subtitles are
    return buffer.toString('latin1').replace(/[\u0080-\u009f]/g, function(c) { return CP1252[c.charCodeAt(0) - 0x80]; });
}

function decodeEntity(match, body) {
    // One HTML entity as its character; unknown names stay as written
    if (body[0] === '#') {
        var code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return code > 0 && code < 0x110000 ? (code === 160 ? ' ' : String.fromCodePoint(code)) : match;
    }
    var name = NAMED[body] !== undefined ? body : body.toLowerCase();
    if (NAMED[name] !== undefined) return NAMED[name];
    // Accented letters such as &eacute; or &Atilde; compose from the letter and its mark
    var letter = /^([a-zA-Z])(acute|grave|circ|uml|tilde|cedil|ring)$/.exec(body);
    return letter ? (letter[1] + MARKS[letter[2]]).normalize('NFC') : match;
}

function decodeEntities(text) {
    // Decode until stable, since converters often escape an entity again (&amp;nbsp;)
    for (var i = 0; i < 4; i++) {
        var next = text.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});?/g, function(match, body) {
            // Without its semicolon only the short legacy names count, so "&nbspx" is not a word lost
            if (match[match.length - 1] !== ';' && !/^(nbsp|amp|lt|gt|quot|copy|reg|#\d+|#x[0-9a-f]+)$/i.test(body)) return match;
            return decodeEntity(match, body);
        });
        if (next === text) return next;
        text = next;
    }
    return text;
}

function escapeText(text) {
    // The characters vtt.js reads as markup
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function assToTags(text) {
    // ASS override blocks: italic, bold and underline become tags, line breaks become new lines, the rest goes away
    return text
        .replace(/\\N|\\n/g, '\n')
        .replace(/\\h/g, ' ')
        .replace(/\{([^}]*)\}/g, function(match, body) {
            if (body.indexOf('\\') === -1) return match;
            var tags = '';
            body.replace(/\\([ibu])([01])(?![0-9])/g, function(m, tag, on) { tags += on === '1' ? '<' + tag + '>' : '</' + tag + '>'; });
            return tags;
        });
}

function microDvdToTags(text) {
    // MicroDVD control codes: {y:i} italic for the cue, | a new line
    var italic = /\{[yY]:[^}]*i[^}]*\}/.test(text);
    var body = text.replace(/\{[a-zA-Z]:[^}]*\}/g, '').replace(/\|/g, '\n');
    return italic ? '<i>' + body + '</i>' : body;
}

function cleanText(raw) {
    // Cue text as safe WebVTT: only i, b and u tags kept, every entity decoded once and every literal character escaped
    var kept = [];
    // MicroDVD control codes also turn up inside SRT files made from them
    var text = assToTags(raw).replace(/<br\s*\/?>/gi, '\n').replace(/\{[a-zA-Z]:[^}]*\}/g, '');
    text = text.replace(ALLOWED_TAG, function(tag) {
        kept.push(tag.toLowerCase());
        return '\u0001' + (kept.length - 1) + '\u0002';
    });
    // Other markup (font, span, ruby from other tools) is dropped, its text kept; a loose "<" is not a tag
    text = text.replace(/<\/?[a-zA-Z][^<>]*>/g, '');
    text = escapeText(decodeEntities(text));
    text = text.replace(/\u0001(\d+)\u0002/g, function(m, i) { return kept[i]; });
    return text.split('\n').map(function(line) { return line.replace(/[ \t ]+/g, ' ').trim(); }).filter(Boolean).join('\n');
}

function parseClock(value) {
    // "H:MM:SS,mmm", "MM:SS.mmm" or the ASS "H:MM:SS.cc" as milliseconds, null when malformed
    var m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,:](\d{1,3}))?$/.exec(value.trim());
    if (!m) return null;
    var fraction = m[4] ? parseInt((m[4] + '00').slice(0, 3), 10) : 0;
    return ((parseInt(m[1] || '0', 10) * 60 + parseInt(m[2], 10)) * 60 + parseInt(m[3], 10)) * 1000 + fraction;
}

function parseTimed(text) {
    // SRT and WebVTT: blocks with a "start --> end" line followed by text lines
    var cues = [];
    text.split(/\n[ \t]*\n/).forEach(function(block) {
        var lines = block.split('\n');
        var at = lines.findIndex(function(line) { return line.indexOf('-->') !== -1; });
        if (at === -1) return;
        var times = lines[at].split('-->');
        var start = parseClock(times[0]);
        var end = parseClock(times[1].trim().split(/\s+/)[0]);
        if (start !== null && end !== null) cues.push({ start: start, end: end, text: lines.slice(at + 1).join('\n') });
    });
    return cues;
}

function parseAss(text) {
    // ASS/SSA: Dialogue lines in the order the [Events] Format line names; the text is everything after the last comma field
    var format = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
    var cues = [];
    text.split('\n').forEach(function(line) {
        var f = /^Format:\s*(.*)$/i.exec(line);
        if (f && /text/i.test(f[1])) format = f[1].split(',').map(function(x) { return x.trim().toLowerCase(); });
        var d = /^Dialogue:\s*(.*)$/i.exec(line);
        if (!d) return;
        var fields = d[1].split(',');
        var body = fields.slice(format.length - 1).join(',');
        // Vector drawings ({\p1}) are shapes, not words
        if (/\{[^}]*\\p[1-9]/.test(body)) return;
        var start = parseClock(fields[format.indexOf('start')] || '');
        var end = parseClock(fields[format.indexOf('end')] || '');
        if (start !== null && end !== null) cues.push({ start: start, end: end, text: body });
    });
    return cues;
}

function parseMicroDvd(text) {
    // MicroDVD counts frames; a first cue {1}{1}<rate> names the frame rate, else 23.976
    var fps = 23.976;
    var cues = [];
    text.split('\n').forEach(function(line) {
        var m = /^\{(\d+)\}\{(\d*)\}(.*)$/.exec(line.trim());
        if (!m) return;
        if (m[1] === '1' && m[2] === '1' && /^\d+(\.\d+)?$/.test(m[3].trim())) {
            fps = parseFloat(m[3]);
            return;
        }
        var start = Math.round(parseInt(m[1], 10) / fps * 1000);
        var end = m[2] ? Math.round(parseInt(m[2], 10) / fps * 1000) : start + 3000;
        cues.push({ start: start, end: end, text: microDvdToTags(m[3]) });
    });
    return cues;
}

function clock(ms) {
    // WebVTT timestamp
    var pad = function(n, w) { return String(n).padStart(w, '0'); };
    return pad(Math.floor(ms / 3600000), 2) + ':' + pad(Math.floor(ms / 60000) % 60, 2) + ':' + pad(Math.floor(ms / 1000) % 60, 2) + '.' + pad(ms % 1000, 3);
}

function toVtt(buffer) {
    // Convert a subtitle file to WebVTT; null when no cue could be read
    var raw = buffer[0] === 0x1f && buffer[1] === 0x8b ? zlib.gunzipSync(buffer) : buffer;
    var text = decodeBytes(raw).replace(/\r\n?/g, '\n');
    var cues = /^\s*\[Script Info\]|^Dialogue:/im.test(text) ? parseAss(text)
        : /^\s*\{\d+\}\{\d*\}/m.test(text) ? parseMicroDvd(text)
        : parseTimed(text);
    var out = cues
        .map(function(c) { return { start: c.start, end: c.end, text: cleanText(c.text) }; })
        .filter(function(c) { return c.text && c.end > c.start; })
        .sort(function(a, b) { return a.start - b.start; });
    if (!out.length) return null;
    return 'WEBVTT\n\n' + out.map(function(c) { return clock(c.start) + ' --> ' + clock(c.end) + '\n' + c.text; }).join('\n\n') + '\n';
}

module.exports = { toVtt: toVtt, cleanText: cleanText, decodeBytes: decodeBytes };
