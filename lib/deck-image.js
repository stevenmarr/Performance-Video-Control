'use strict';
// 0.20 Path C pictures: Control Dark keys and the circular paint knobs the + XL strip shows.
// The arc is the same 270° sweep as public/ptz.js (gap at the bottom). Red #C42020 is drawn
// only for a camera that is on program, or as the outline of a preset while that camera is live.
const zlib = require('zlib');
const { THEME, KEY_ROLES, PAGE_LABEL, dialFace } = require('./deck');

const xml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 135° start, clockwise on a screen (SVG +y down), matching public/ptz.js ARC().
function arcPath(cx, cy, r, fraction) {
  const f = Math.max(0, Math.min(1, Number(fraction) || 0));
  const a0 = (135 * Math.PI) / 180;
  const sweep = ((270 * Math.PI) / 180) * Math.max(f, 0.001);
  const p = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a0 + sweep);
  const large = sweep > Math.PI ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function markPaths(x, y, s, color) {
  const r = Math.max(2, s * 0.18);
  const t = s * 0.32;
  const tx = x + s * 0.18;
  const ty = y + s * 0.16;
  const lines = [
    [x + s * 0.18, y + s * 0.66, s * 0.62],
    [x + s * 0.18, y + s * 0.80, s * 0.44],
  ];
  const sw = Math.max(1.25, s * 0.075);
  return `<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${r}" fill="none" stroke="${color}" stroke-width="${sw}"/>
    <path d="M ${tx} ${ty} L ${tx} ${ty + t} L ${tx + t * 0.86} ${ty + t / 2} Z" fill="${color}"/>
    ${lines.map(([lx, ly, w]) => `<rect x="${lx}" y="${ly}" width="${w}" height="${sw}" rx="${sw / 2}" fill="${color}"/>`).join('')}`;
}

function knobSvg(face) {
  const parts = face.parts || [];
  const dual = parts.length > 1;
  const W = 200;
  const H = 100;
  const arcs = parts.map((part, i) => {
    const cx = dual ? (i === 0 ? 56 : 144) : 100;
    const cy = dual ? 40 : 42;
    const r = dual ? 26 : 30;
    const stroke = part.tint === 'r' ? THEME.r : part.tint === 'b' ? THEME.b : THEME.knob;
    const valueStroke = part.muted ? THEME.centre : stroke;
    const ring = part.active && dual ? `<circle cx="${cx}" cy="${cy}" r="${r + 5}" fill="none" stroke="${THEME.active}" stroke-width="1.25"/>` : '';
    return `${ring}
      <path d="${arcPath(cx, cy, r, 1)}" fill="none" stroke="${THEME.track}" stroke-width="5" stroke-linecap="round"/>
      <path d="${arcPath(cx, cy, r, part.fraction)}" fill="none" stroke="${valueStroke}" stroke-width="5" stroke-linecap="round"/>
      <text x="${cx}" y="${cy + 4}" text-anchor="middle" fill="${THEME.text}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="${dual ? 12 : 16}" font-weight="700">${xml(part.text)}</text>
      <text x="${cx}" y="${cy + r + 12}" text-anchor="middle" fill="${THEME.dim}" font-family="Arial, Helvetica, sans-serif" font-size="8" font-weight="700" letter-spacing="1.2">${xml(part.label)}</text>`;
  }).join('');
  const badge = !dual && face.badge ? `<text x="100" y="16" text-anchor="middle" fill="${THEME.dim}" font-family="Arial, Helvetica, sans-serif" font-size="8" font-weight="700" letter-spacing="1.4">${xml(face.badge)}</text>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" rx="14" fill="${THEME.panel}"/>
    ${badge}${arcs}
    <text x="100" y="94" text-anchor="middle" fill="${String(face.step || '').includes('·') && face.kind === 'pair' ? THEME.active : THEME.dim}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="8" font-weight="700" letter-spacing="1">${xml(face.stepLine || '')}</text>
  </svg>`;
}

function keySvg(model) {
  const W = 144;
  const H = 144;
  const fill = model.fill || THEME.panel;
  const ink = model.ink || THEME.text;
  const dim = model.dim || THEME.dim;
  const border = model.border || 'none';
  const bw = model.border ? 4 : 0;
  const title = model.title || '';
  const value = model.value || '';
  const caption = model.caption || '';
  const mark = model.mark ? markPaths(36, 28, 72, ink) : '';
  const strike = model.offline ? `<line x1="18" y1="78" x2="126" y2="78" stroke="${dim}" stroke-width="2"/>` : '';
  const ring = model.ring ? `<rect x="5" y="5" width="134" height="134" rx="16" fill="none" stroke="${THEME.text}" stroke-width="3"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect x="${bw / 2}" y="${bw / 2}" width="${W - bw}" height="${H - bw}" rx="18" fill="${fill}" stroke="${border}" stroke-width="${bw}"/>
    ${ring}${mark}${strike}
    <text x="14" y="28" fill="${dim}" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="700" letter-spacing="1.4">${xml(title)}</text>
    <text x="14" y="78" fill="${ink}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="28" font-weight="700">${xml(value)}</text>
    <text x="14" y="122" fill="${dim}" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="700" letter-spacing="1.2">${xml(caption)}</text>
  </svg>`;
}

function svgDataUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

function presentKey(settings = {}, snap = {}, deck = {}) {
  const role = settings.role;
  const base = { fill: THEME.panel, ink: THEME.text, dim: THEME.dim, border: null, ring: false, mark: false, offline: false, title: '', value: '', caption: '' };
  if (role === 'home' || settings.kind === 'home') {
    return { ...base, mark: true, title: '', value: '', caption: '' };
  }
  if (role === 'camera') {
    const cams = snap.cameras || [];
    const slot = Number(settings.slot) || 1;
    if (slot === 8 && cams.length > 8) {
      const i = cams.findIndex((c) => c.selected);
      const next = cams[(Math.max(0, i) + 1) % cams.length];
      return { ...base, title: 'CAM', value: '▸', caption: next ? next.name : '' };
    }
    const cam = cams[slot - 1];
    if (!cam) return { ...base, title: `CAM ${slot}`, value: '—', caption: '' };
    const live = !!cam.tally;
    return {
      ...base,
      fill: live ? THEME.pgm : THEME.panel,
      ink: live ? '#FFFFFF' : (cam.connected ? THEME.text : THEME.dim),
      dim: live ? '#FFD5D6' : THEME.dim,
      ring: !!cam.selected,
      offline: !cam.connected,
      title: `CAM ${slot}`,
      value: cam.name,
      caption: live ? 'PGM' : (cam.selected ? 'SELECTED' : (cam.connected ? '' : 'OFFLINE')),
    };
  }
  if (role === 'preset') {
    const n = Number(settings.preset) || 1;
    const p = (snap.presets || []).find((x) => x.n === n);
    const cam = (snap.cameras || []).find((c) => c.selected);
    const live = !!(cam && cam.tally);
    return {
      ...base,
      border: live ? THEME.pgm : null,
      title: `PRESET ${n}`,
      value: p ? p.name : `Preset ${n}`,
      caption: live ? 'HOLD' : '',
    };
  }
  if (role === 'page') {
    const page = settings.page || 'live';
    const on = deck.page === page;
    return { ...base, fill: on ? THEME.accent : THEME.panel, ink: on ? '#FFFFFF' : THEME.text, dim: on ? '#E7F0FF' : THEME.dim, title: 'PAGE', value: PAGE_LABEL[page] || page, caption: on ? 'ON' : '' };
  }
  const spec = KEY_ROLES[role];
  if (!spec) return { ...base, title: 'KEY', value: '—', caption: '' };
  if (spec.type === 'stopAll') return { ...base, fill: THEME.dangerBg, border: THEME.pgm, ink: THEME.dangerText, dim: THEME.dangerText, title: '', value: 'ALL STOP', caption: 'HOLD' };
  if (spec.type === 'guard') {
    const mode = (snap.liveGuard && snap.liveGuard.mode) || 'hold';
    const on = mode !== 'off';
    return { ...base, fill: on ? THEME.accent : THEME.panel, ink: '#FFFFFF', dim: on ? '#E7F0FF' : THEME.dim, title: spec.label, value: mode.toUpperCase(), caption: on ? 'ON' : '' };
  }
  if (spec.type === 'toggle') {
    const ro = snap.readouts && snap.readouts[spec.op];
    const on = !!(ro && ro.on);
    const text = on ? (spec.on || 'ON') : (spec.off || 'OFF');
    return { ...base, fill: on ? THEME.accent : THEME.panel, ink: on ? '#FFFFFF' : THEME.text, dim: on ? '#E7F0FF' : THEME.dim, title: spec.label, value: text, caption: on ? 'ON' : '' };
  }
  if (spec.type === 'cycle') {
    const ro = snap.readouts && snap.readouts[spec.op];
    const on = !!(ro && ro.value !== undefined && ro.value !== null && String(ro.value) !== '0' && ro.text !== 'OFF');
    return { ...base, fill: on ? THEME.accent : THEME.panel, ink: on ? '#FFFFFF' : THEME.text, dim: on ? '#E7F0FF' : THEME.dim, title: spec.label, value: ro && ro.text && ro.text !== '—' ? ro.text : '—', caption: on ? 'ON' : '' };
  }
  return { ...base, title: spec.label, value: spec.text || '', caption: '' };
}

function presentDial(settings = {}, snap = {}) {
  return dialFace(settings.widget || 'iris', snap, settings.stepIndex || 0);
}

// --- tiny PNG writer for the manifest icons (white mark on transparent, two sizes) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function canvas(w, h) {
  const px = Buffer.alloc(w * h * 4);
  const set = (x, y, r, g, b, a) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= w || y >= h || a <= 0) return;
    const i = (y * w + x) * 4;
    const sa = a / 255;
    const da = px[i + 3] / 255;
    const out = sa + da * (1 - sa);
    if (out <= 0) return;
    px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / out);
    px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / out);
    px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / out);
    px[i + 3] = Math.round(out * 255);
  };
  const parse = (hex) => {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255];
  };
  return {
    px, w, h,
    dot(x, y, rgba) { set(x, y, rgba[0], rgba[1], rgba[2], rgba[3]); },
    fill(hex) { const c = parse(hex); for (let i = 0; i < px.length; i += 4) { px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = c[3]; } },
    rect(x, y, rw, rh, hex) {
      const c = parse(hex);
      for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) set(xx, yy, c[0], c[1], c[2], c[3]);
    },
    png() { return encodePng(w, h, px); },
  };
}

function drawMark(img, color) {
  const c = color;
  const m = Math.round(img.w * 0.16);
  const s = img.w - m * 2;
  const sw = Math.max(1, Math.round(img.w / 16));
  // rounded-rect stroke by filling a frame and punching is overkill; draw four bars and corners as rects
  img.rect(m + sw, m, s - sw * 2, sw, c);
  img.rect(m + sw, m + s - sw, s - sw * 2, sw, c);
  img.rect(m, m + sw, sw, s - sw * 2, c);
  img.rect(m + s - sw, m + sw, sw, s - sw * 2, c);
  const t = s * 0.30;
  const tx = m + s * 0.20;
  const ty = m + s * 0.18;
  // triangle as a stack of spans
  const steps = Math.max(2, Math.round(t));
  for (let i = 0; i < steps; i++) {
    const y = ty + (t * i) / steps;
    const mid = ty + t / 2;
    const span = (t * 0.86) * (1 - Math.abs(y - mid) / (t / 2));
    img.rect(tx, y, Math.max(1, span), Math.max(1, t / steps + 0.6), c);
  }
  img.rect(m + s * 0.20, m + s * 0.66, s * 0.58, sw, c);
  img.rect(m + s * 0.20, m + s * 0.80, s * 0.40, sw, c);
}

function iconPng(size, { bg = null, color = '#FFFFFF' } = {}) {
  const img = canvas(size, size);
  if (bg) img.fill(bg);
  drawMark(img, color);
  return img.png();
}

module.exports = { arcPath, markPaths, knobSvg, keySvg, svgDataUrl, presentKey, presentDial, encodePng, iconPng, canvas };
