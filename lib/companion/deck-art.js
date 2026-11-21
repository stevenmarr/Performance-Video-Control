'use strict';
// 0.35.0: Companion buttons for Control Center deck keys look exactly like Control Center's.
// Until 0.34.0 the deck model sent Companion only text lines and two colors per key, so the
// module drew plain Companion text buttons: no color bar, no small header over a big label,
// no PVW / PGM frame, no dashed guard border, no HOME house, no round knob art on the strip.
// Now every key, strip cell and knob in GET /api/companion/deck carries an "img" id. The id
// is content addressed (a hash of the very SVG Control Center draws for that slot, the same
// keySvg(keyModel(key)) its Control Devices page and a USB deck use, and the same knob /
// segment art as the USB touch strip), so a new value or tally is a new id and an unchanged
// key keeps its id. The module fetches GET /api/companion/deck/art/<id>.png once per id.

const crypto = require('crypto');
const { THEME, dialFace } = require('../deck');
const { keySvg, knobSvg, segmentSvg } = require('../deck-image');
const { keyModel } = require('../decks/look');

const KEY_PX = 144; // keySvg is drawn on a 144 x 144 box; Companion scales it to the key
const STRIP_W = 200; // one touch-strip segment, as the USB + / + XL strip draws it (lib/decks/look.js stripImage)
const STRIP_H = 100;
const STRIP_SCALE = 2;
const MAX_SVGS = 4000;
const MAX_PNGS = 1200;
const ID_RE = /^[0-9a-f]{20}$/;

// Loading every system font costs ~150 ms per picture (a Mac has hundreds), so a page of 36 keys took
// seconds. The pictures use only a sans (Arial / Helvetica) and a mono (Menlo / ui-monospace): load just
// those files, found once. CC_ART_FONTS (paths joined by ":") overrides; none found = system fonts.
const FONT_CANDIDATES = {
  sans: [
    '/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/Library/Fonts/Arial.ttf', '/Library/Fonts/Arial Bold.ttf', '/System/Library/Fonts/Helvetica.ttc',
    '/usr/share/fonts/truetype/msttcorefonts/Arial.ttf', '/usr/share/fonts/truetype/msttcorefonts/Arial_Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  ],
  mono: [
    '/System/Library/Fonts/Menlo.ttc', '/System/Library/Fonts/SFNSMono.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf', '/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf',
  ],
};
let fontCache = null;
// Font folders searched when none of FONT_CANDIDATES exist (0.35.1). Each found file is read for its family name.
const FONT_DIRS = ['/usr/share/fonts', '/usr/local/share/fonts', '/Library/Fonts', '/System/Library/Fonts', '/System/Library/Fonts/Supplemental'];

// Family name (name table, nameID 1) of a .ttf / .otf file; null when it is not a plain sfnt font.
function fontFamily(file, read = (f) => require('fs').readFileSync(f)) {
  let b;
  try { b = read(file); } catch { return null; }
  if (!b || b.length < 12) return null;
  const tag = b.readUInt32BE(0);
  if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return null; // TrueType, 'OTTO', 'true'
  const n = b.readUInt16BE(4);
  for (let i = 0; i < n; i++) {
    const r = 12 + i * 16;
    if (r + 16 > b.length) return null;
    if (b.toString('latin1', r, r + 4) !== 'name') continue;
    const o = b.readUInt32BE(r + 8);
    if (o + 6 > b.length) return null;
    const count = b.readUInt16BE(o + 2); const strings = o + b.readUInt16BE(o + 4);
    let mac = null;
    for (let j = 0; j < count; j++) {
      const e = o + 6 + j * 12;
      if (e + 12 > b.length) break;
      const platform = b.readUInt16BE(e); const nameId = b.readUInt16BE(e + 6);
      const len = b.readUInt16BE(e + 8); const off = strings + b.readUInt16BE(e + 10);
      if (nameId !== 1 || off + len > b.length) continue;
      if (platform === 3 || platform === 0) { const u = Buffer.from(b.subarray(off, off + len)); u.swap16(); return u.toString('utf16le').trim() || null; }
      if (platform === 1 && mac == null) mac = b.toString('latin1', off, off + len).trim();
    }
    return mac || null;
  }
  return null;
}

// Every .ttf / .otf under the font folders (bounded walk).
function listFontFiles(dirs = FONT_DIRS, { max = 4000, depth = 5 } = {}) {
  const fs = require('fs'); const path = require('path'); const out = [];
  const walk = (d, left) => {
    if (left < 0 || out.length >= max) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= max) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, left - 1);
      else if (/\.(ttf|otf)$/i.test(e.name)) out.push(p);
    }
  };
  for (const d of dirs) walk(d, depth);
  return out;
}

// 0.35.1: when the usual fonts are missing, pick one sans (regular + bold) and one mono family from the font folders,
// so resvg loads two or four files instead of every system font (~3 ms instead of ~150 ms a picture).
function discoverFonts(files = listFontFiles(), family = fontFamily) {
  const plain = (f) => !/(italic|oblique|light|thin|black|condensed|narrow|semi|extra|medium|cond)/i.test(f);
  const pick = (re, avoid) => {
    const cands = files.filter((f) => re.test(require('path').basename(f)) && !avoid.test(require('path').basename(f)) && plain(require('path').basename(f)));
    cands.sort((a, b) => (/bold/i.test(a) - /bold/i.test(b)) || a.length - b.length);
    for (const f of cands) {
      if (/bold/i.test(require('path').basename(f))) continue;
      const fam = family(f);
      if (!fam) continue;
      const bold = cands.find((g) => g !== f && /bold/i.test(require('path').basename(g)) && family(g) === fam);
      return { family: fam, files: bold ? [f, bold] : [f] };
    }
    return null;
  };
  const sans = pick(/(sans|arial|helvetica|roboto|ubuntu|cantarell|inter|lato|open)/i, /(mono|serif(?!.*sans)|code)/i);
  const mono = pick(/(mono|code|menlo|courier)/i, /(?!)/);
  return sans ? { sans, mono } : null;
}

function fontOptions(env = process.env, exists = (f) => { try { return require('fs').statSync(f).isFile(); } catch { return false; } }, discover = discoverFonts) {
  if (fontCache && env === process.env) return fontCache;
  let files;
  if (env.CC_ART_FONTS) files = String(env.CC_ART_FONTS).split(':').filter(exists);
  else files = [...FONT_CANDIDATES.sans, ...FONT_CANDIDATES.mono].filter(exists);
  const has = (re) => files.some((f) => re.test(f));
  const sans = has(/Arial/) ? 'Arial' : has(/Helvetica/) ? 'Helvetica' : has(/LiberationSans-/) ? 'Liberation Sans' : has(/DejaVuSans(-Bold)?\.ttf$/) ? 'DejaVu Sans' : 'Arial';
  const mono = has(/Menlo/) ? 'Menlo' : has(/SFNSMono/) ? 'SF Mono' : has(/LiberationMono/) ? 'Liberation Mono' : has(/DejaVuSansMono/) ? 'DejaVu Sans Mono' : 'Menlo';
  let out;
  if (files.length) out = { fontFiles: files, loadSystemFonts: false, defaultFontFamily: sans, sansSerifFamily: sans, monospaceFamily: mono };
  else {
    // none of the usual files: find a sans and a mono family in the font folders; last resort, every system font
    // (slow, but drawing runs off the main thread since 0.35.1)
    let found = null;
    if (!env.CC_ART_FONTS) { try { found = discover(); } catch { found = null; } }
    if (found) {
      const m = found.mono || found.sans;
      out = { fontFiles: [...found.sans.files, ...(found.mono ? found.mono.files : [])], loadSystemFonts: false, defaultFontFamily: found.sans.family, sansSerifFamily: found.sans.family, monospaceFamily: m.family };
    } else out = { loadSystemFonts: true, defaultFontFamily: 'Arial', monospaceFamily: 'Menlo' };
  }
  if (env === process.env) fontCache = out;
  return out;
}

// resvg does not map the generic "monospace" to monospaceFamily, so name the loaded families in each list
// (on a Mac, Menlo / Arial are already named in the lists and nothing changes).
function withFamilies(svg, font) {
  return String(svg).replace(/font-family="([^"]*)"/g, (m, list) => {
    const generic = /\bmonospace\s*$/.test(list) ? font.monospaceFamily : /\bsans-serif\s*$/.test(list) ? font.sansSerifFamily : '';
    if (!generic || list.includes(generic)) return m;
    return `font-family="${list.replace(/(monospace|sans-serif)\s*$/, `${generic}, $1`)}"`;
  });
}

const xml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The strip segment for one dial, the same three cases as stripImage() for a USB deck:
// an ATEM-style segment (dial.strip), a readout knob (dial.readout), or a PTZ widget knob.
function dialSvg(dial, snap) {
  if (!dial) return null;
  if (dial.strip) return segmentSvg(dial.strip, STRIP_W, STRIP_H);
  if (dial.readout != null && dial.readout !== '') {
    return knobSvg({ kind: 'single', stepLine: dial.label || '', parts: [{ label: dial.label || '', text: String(dial.readout), fraction: dial.fraction || 0, tint: 'knob', active: true }] });
  }
  if (!dial.widget) return null;
  try { return knobSvg(dialFace(dial.widget, snap || {}, dial.stepIndex || 0)); } catch { return null; }
}

// A knob (encoder) has no display on the deck; in Companion's grid it is a cell of its own.
function encoderSvg(label) {
  const text = String(label || '').slice(0, 12);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${KEY_PX}" height="${KEY_PX}" viewBox="0 0 ${KEY_PX} ${KEY_PX}">
    <rect width="${KEY_PX}" height="${KEY_PX}" rx="18" fill="${THEME.bg}"/>
    <circle cx="72" cy="62" r="40" fill="#1a1e24" stroke="${THEME.line}" stroke-width="3"/>
    <circle cx="72" cy="62" r="30" fill="${THEME.panel}" stroke="#3a414c" stroke-width="2"/>
    <rect x="70" y="26" width="4" height="16" rx="2" fill="${THEME.dim}"/>
    <text x="72" y="126" text-anchor="middle" fill="${THEME.text}" font-family="Arial, Helvetica, sans-serif" font-size="15" font-weight="700" letter-spacing="1.2">${xml(text)}</text>
  </svg>`;
}

class DeckArt {
  // 0.35.1: pictures are drawn off the main thread (resvg renderAsync, libuv pool), at most `renders` at a time so the
  // pool stays free for file work; `font` overrides fontOptions() (tests).
  constructor({ maxSvgs = MAX_SVGS, maxPngs = MAX_PNGS, renders = 2, font = null, renderAsync = null } = {}) {
    this.maxSvgs = maxSvgs;
    this.maxPngs = maxPngs;
    this.renders = Math.max(1, renders);
    this.font = font;
    this._renderAsync = renderAsync;
    this.active = 0;
    this.waiting = [];
    this.pending = new Map(); // id -> Promise<Buffer> (one render per id, however many ask)
    this.svgs = new Map(); // id -> { svg, w, h }
    this.ids = new Map(); // `${w}x${h}:${svg}` -> id (skips re-hashing an unchanged key)
    this.pngs = new Map(); // id -> Buffer
  }

  _put(svg, w, h) {
    if (!svg) return null;
    const memo = `${w}x${h}:${svg}`;
    let id = this.ids.get(memo);
    if (!id) {
      id = crypto.createHash('sha1').update(memo).digest('hex').slice(0, 20);
      this.ids.set(memo, id);
      if (this.ids.size > this.maxSvgs) this.ids.delete(this.ids.keys().next().value);
    }
    // most recently used last, so the oldest is dropped first
    this.svgs.delete(id);
    this.svgs.set(id, { svg, w, h });
    if (this.svgs.size > this.maxSvgs) this.svgs.delete(this.svgs.keys().next().value);
    return id;
  }

  key(key) { return this._put(keySvg(keyModel(key || null)), KEY_PX, KEY_PX); }
  blank() { return this.key(null); }
  dial(dial, snap) { return this._put(dialSvg(dial, snap), STRIP_W * STRIP_SCALE, STRIP_H * STRIP_SCALE); }
  widget(widget, snap, stepIndex) { return this.dial({ widget, stepIndex }, snap); }
  encoder(label) { return this._put(encoderSvg(label), KEY_PX, KEY_PX); }

  has(id) { return this.svgs.has(String(id)); }

  // PNG bytes for an id (a Promise), or null when the id is unknown (never made, or long since dropped). 0.35.1: drawn
  // off the main thread, so Control Center keeps answering camera and switcher requests while pictures are drawn.
  async png(id) {
    const key = String(id || '');
    if (!ID_RE.test(key)) return null;
    const hit = this.pngs.get(key);
    if (hit) return hit;
    const art = this.svgs.get(key);
    if (!art) return null;
    if (this.pending.has(key)) return this.pending.get(key);
    let render = this._renderAsync;
    if (!render) {
      try { ({ renderAsync: render } = require('@resvg/resvg-js')); } catch (e) {
        const err = new Error('Button art needs @resvg/resvg-js. Run npm install in Control Center.');
        err.status = 503;
        throw err;
      }
    }
    const p = (async () => {
      await this._slot();
      try {
        const font = this.font || fontOptions();
        const img = await render(withFamilies(art.svg, font), { fitTo: { mode: 'width', value: art.w }, font, background: THEME.bg });
        const buf = Buffer.from(img.asPng());
        this.pngs.set(key, buf);
        if (this.pngs.size > this.maxPngs) this.pngs.delete(this.pngs.keys().next().value);
        return buf;
      } finally { this._done(); this.pending.delete(key); }
    })();
    this.pending.set(key, p);
    return p;
  }

  _slot() {
    if (this.active < this.renders) { this.active++; return Promise.resolve(); }
    return new Promise((r) => this.waiting.push(r));
  }

  _done() {
    const next = this.waiting.shift();
    if (next) next(); else this.active--;
  }
}

const ART_SIZES = { key: [KEY_PX, KEY_PX], strip: [STRIP_W * STRIP_SCALE, STRIP_H * STRIP_SCALE], knob: [KEY_PX, KEY_PX] };

module.exports = { DeckArt, dialSvg, encoderSvg, fontOptions, withFamilies, fontFamily, listFontFiles, discoverFonts, ART_SIZES, ID_RE, FONT_CANDIDATES, FONT_DIRS };
