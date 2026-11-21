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
function fontOptions(env = process.env, exists = (f) => { try { return require('fs').statSync(f).isFile(); } catch { return false; } }) {
  if (fontCache && env === process.env) return fontCache;
  let files;
  if (env.CC_ART_FONTS) files = String(env.CC_ART_FONTS).split(':').filter(exists);
  else files = [...FONT_CANDIDATES.sans, ...FONT_CANDIDATES.mono].filter(exists);
  const has = (re) => files.some((f) => re.test(f));
  const sans = has(/Arial/) ? 'Arial' : has(/Helvetica/) ? 'Helvetica' : has(/LiberationSans-/) ? 'Liberation Sans' : has(/DejaVuSans(-Bold)?\.ttf$/) ? 'DejaVu Sans' : 'Arial';
  const mono = has(/Menlo/) ? 'Menlo' : has(/SFNSMono/) ? 'SF Mono' : has(/LiberationMono/) ? 'Liberation Mono' : has(/DejaVuSansMono/) ? 'DejaVu Sans Mono' : 'Menlo';
  const out = files.length
    ? { fontFiles: files, loadSystemFonts: false, defaultFontFamily: sans, sansSerifFamily: sans, monospaceFamily: mono }
    : { loadSystemFonts: true, defaultFontFamily: 'Arial', monospaceFamily: 'Menlo' };
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
  constructor({ maxSvgs = MAX_SVGS, maxPngs = MAX_PNGS } = {}) {
    this.maxSvgs = maxSvgs;
    this.maxPngs = maxPngs;
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

  // PNG bytes for an id, or null when the id is unknown (never made, or long since dropped).
  png(id) {
    const key = String(id || '');
    if (!ID_RE.test(key)) return null;
    const hit = this.pngs.get(key);
    if (hit) return hit;
    const art = this.svgs.get(key);
    if (!art) return null;
    let Resvg;
    try { ({ Resvg } = require('@resvg/resvg-js')); } catch (e) {
      const err = new Error('Button art needs @resvg/resvg-js. Run npm install in Control Center.');
      err.status = 503;
      throw err;
    }
    const font = fontOptions();
    const png = new Resvg(withFamilies(art.svg, font), {
      fitTo: { mode: 'width', value: art.w },
      font,
      background: THEME.bg,
    }).render().asPng();
    const buf = Buffer.from(png);
    this.pngs.set(key, buf);
    if (this.pngs.size > this.maxPngs) this.pngs.delete(this.pngs.keys().next().value);
    return buf;
  }
}

const ART_SIZES = { key: [KEY_PX, KEY_PX], strip: [STRIP_W * STRIP_SCALE, STRIP_H * STRIP_SCALE], knob: [KEY_PX, KEY_PX] };

module.exports = { DeckArt, dialSvg, encoderSvg, fontOptions, withFamilies, ART_SIZES, ID_RE, FONT_CANDIDATES };
