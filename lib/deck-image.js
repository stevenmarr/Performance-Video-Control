'use strict';
// 0.20 Path C pictures: Control Dark keys and the circular paint knobs the + XL strip shows.
// The arc is the same 270° sweep as public/ptz.js (gap at the bottom). Red #C42020 is drawn
// only for a camera that is on program, or as the outline of a preset while that camera is live.
const zlib = require('zlib');
const { THEME, KEY_ROLES, PAGE_LABEL, dialFace, liveState, selectedTally } = require('./deck');

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

function tallyChrome(model, tally) {
  if (tally !== 'pgm' && tally !== 'pvw') return model;
  if (tally === 'pgm') {
    const on = model.fill === THEME.accent;
    return {
      ...model,
      fill: on ? '#8C1C22' : THEME.dangerBg,
      border: THEME.pgm,
      ink: '#FFFFFF',
      dim: '#FFD0D2',
      caption: model.caption && model.caption !== 'ON' && model.caption !== 'OFF' ? model.caption : 'PGM',
      tally: 'pgm',
    };
  }
  return {
    ...model,
    border: '#3DDC84',
    caption: model.caption && model.caption !== 'ON' && model.caption !== 'OFF' ? model.caption : 'PVW',
    tally: 'pvw',
  };
}

function knobSvg(face) {
  const parts = face.parts || [];
  const dual = parts.length > 1;
  const W = 200;
  const H = 100;
  const pgm = face.tally === 'pgm';
  const pvw = face.tally === 'pvw';
  const panel = pgm ? '#3A0D10' : (pvw ? '#10261A' : THEME.panel);
  const frame = pgm ? ` stroke="${THEME.pgm}" stroke-width="4"` : (pvw ? ' stroke="#3DDC84" stroke-width="3"' : '');
  const arcs = parts.map((part, i) => {
    const cx = dual ? (i === 0 ? 56 : 144) : 100;
    const cy = dual ? 40 : 42;
    const r = dual ? 26 : 30;
    const stroke = part.tint === 'r' ? THEME.r : part.tint === 'b' ? THEME.b : THEME.knob;
    const valueStroke = part.muted ? THEME.centre : stroke;
    const ring = part.active && dual ? `<circle cx="${cx}" cy="${cy}" r="${r + 5}" fill="none" stroke="${THEME.active}" stroke-width="2"/>` : '';
    const labelFill = part.active ? THEME.active : THEME.dim;
    const weight = part.active ? 800 : 700;
    return `${ring}
      <path d="${arcPath(cx, cy, r, 1)}" fill="none" stroke="${THEME.track}" stroke-width="5" stroke-linecap="round"/>
      <path d="${arcPath(cx, cy, r, part.fraction)}" fill="none" stroke="${valueStroke}" stroke-width="${part.active ? 6 : 4}" stroke-linecap="round"/>
      <text x="${cx}" y="${cy + 4}" text-anchor="middle" fill="${part.active ? THEME.text : THEME.dim}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="${dual ? 12 : 16}" font-weight="700">${xml(part.text)}</text>
      <text x="${cx}" y="${cy + r + 12}" text-anchor="middle" fill="${labelFill}" font-family="Arial, Helvetica, sans-serif" font-size="${part.active && dual ? 9 : 8}" font-weight="${weight}" letter-spacing="1.2">${xml(part.label)}</text>`;
  }).join('');
  const badge = !dual && face.badge ? `<text x="100" y="16" text-anchor="middle" fill="${THEME.dim}" font-family="Arial, Helvetica, sans-serif" font-size="8" font-weight="700" letter-spacing="1.4">${xml(face.badge)}</text>` : '';
  const flag = pgm ? 'PGM' : (pvw ? 'PVW' : '');
  const flagText = flag ? `<text x="12" y="14" fill="${pgm ? THEME.pgm : '#3DDC84'}" font-family="Arial, Helvetica, sans-serif" font-size="9" font-weight="800" letter-spacing="1">${flag}</text>` : '';
  const lineFill = face.kind === 'pair' ? THEME.active : THEME.dim;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" rx="14" fill="${panel}"${frame}/>
    ${flagText}${badge}${arcs}
    <text x="100" y="94" text-anchor="middle" fill="${lineFill}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="${face.kind === 'pair' ? 10 : 8}" font-weight="800" letter-spacing="1">${xml(face.stepLine || '')}</text>
  </svg>`;
}

function wrapLabel(text, limit) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  const push = (s) => { if (s) lines.push(s); };
  for (const word of words) {
    if (word.length > limit) {
      push(cur);
      cur = '';
      for (let i = 0; i < word.length; i += limit) lines.push(word.slice(i, i + limit));
      continue;
    }
    const next = cur ? `${cur} ${word}` : word;
    if (next.length > limit) { push(cur); cur = word; } else cur = next;
  }
  push(cur);
  return lines.slice(0, 3);
}

function valueText(value, ink) {
  const text = String(value || '');
  if (text.includes('\n')) {
    const lines = text.split('\n').slice(0, 3);
    const longest = lines.reduce((n, line) => Math.max(n, line.length), 0);
    const size = longest > 14 ? 12 : longest > 11 ? 14 : (lines.length > 2 ? 16 : 20);
    const y0 = lines.length > 2 ? 52 : 64;
    return lines.map((line, i) => `<text x="14" y="${y0 + i * (size + 4)}" fill="${ink}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="${size}" font-weight="700">${xml(line)}</text>`).join('');
  }
  if (text.length <= 9) {
    return `<text x="14" y="78" fill="${ink}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="28" font-weight="700">${xml(text)}</text>`;
  }
  const lines = wrapLabel(text, 12);
  const size = lines.length > 2 ? 16 : 18;
  const y0 = lines.length > 2 ? 52 : 58;
  return lines.map((line, i) => `<text x="14" y="${y0 + i * (size + 4)}" fill="${ink}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="${size}" font-weight="700">${xml(line)}</text>`).join('');
}

function houseSvg(ink, fill) {
  return `<path d="M32 74 L72 38 L112 74 V80 H96 V108 H48 V80 H32 Z" fill="${ink}"/>
    <rect x="66" y="84" width="12" height="24" fill="${fill}"/>
    <text x="72" y="128" text-anchor="middle" fill="${ink}" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="700" letter-spacing="1.4">HOME</text>`;
}

function layerSvg(layers, ink, dim) {
  const list = layers || [];
  const n = Math.max(1, list.length);
  const w = Math.min(36, Math.floor(128 / n));
  const x0 = Math.round((144 - n * w) / 2);
  return list.map((layer, i) => {
    const x = x0 + i * w;
    const cx = x + w / 2;
    const air = layer.air
      ? `<circle cx="${cx}" cy="102" r="3.2" fill="#ff2d2d"/>`
      : `<circle cx="${cx}" cy="102" r="3.2" fill="none" stroke="${dim}" stroke-width="1.4"/>`;
    const next = layer.next
      ? `<rect x="${x + 3}" y="112" width="${Math.max(4, w - 6)}" height="5" rx="1" fill="#E0B030"/>`
      : `<rect x="${x + 3}" y="113" width="${Math.max(4, w - 6)}" height="2" rx="1" fill="#3a414c"/>`;
    return `<text x="${cx}" y="90" text-anchor="middle" fill="${ink}" font-family="Arial, Helvetica, sans-serif" font-size="9" font-weight="700">${xml(layer.icon || layer.id || '')}</text>${air}${next}`;
  }).join('');
}

function tabText(value, ink) {
  // Every tab key uses the same size; tabLines() already broke long names.
  const lines = String(value || '').split('\n').slice(0, 2);
  const size = 20;
  const y0 = lines.length > 1 ? 72 : 84;
  return lines.map((line, i) => `<text x="14" y="${y0 + i * (size + 4)}" fill="${ink}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="${size}" font-weight="700">${xml(line)}</text>`).join('');
}

function bigTextSvg(text, ink) {
  // One or two centered lines, as large as the key allows.
  const lines = String(text || '').split('\n').slice(0, 2);
  const longest = lines.reduce((n, line) => Math.max(n, line.length), 1);
  const size = Math.min(lines.length > 1 ? 40 : 48, Math.floor(120 / (0.6 * longest)));
  const gap = Math.round(size * 0.18);
  const total = lines.length * size + (lines.length - 1) * gap;
  const top = 72 - total / 2;
  return lines.map((line, i) => `<text x="72" y="${Math.round(top + (i + 1) * size + i * gap - size * 0.14)}" text-anchor="middle" fill="${ink}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="${size}" font-weight="800">${xml(line)}</text>`).join('');
}

function keySvg(model) {
  const W = 144;
  const H = 144;
  const fill = model.fill || THEME.panel;
  const ink = model.ink || THEME.text;
  const dim = model.dim || THEME.dim;
  const border = model.border || '#2a313b';
  const bw = model.guard ? 4 : (model.border ? 4 : 1);
  const dash = model.guard ? ' stroke-dasharray="8 5"' : '';
  const bar = model.bar || '#5c6570';
  const title = model.title || '';
  const value = model.value || '';
  const caption = model.caption || '';
  const mark = model.mark ? markPaths(36, 28, 72, ink) : '';
  const house = model.house ? houseSvg(ink, fill) : '';
  const layers = !model.house && model.layers && model.layers.length ? layerSvg(model.layers, ink, dim) : '';
  const osFrame = model.os ? `<rect x="11" y="11" width="122" height="122" rx="12" fill="none" stroke="${border}" stroke-width="1.5"/>` : '';
  const strike = model.offline ? `<line x1="18" y1="78" x2="126" y2="78" stroke="${dim}" stroke-width="2"/>` : '';
  const ring = model.ring ? `<rect x="5" y="5" width="134" height="134" rx="16" fill="none" stroke="${THEME.text}" stroke-width="3"/>` : '';
  const chips = !house && model.bigText ? bigTextSvg(model.bigText, ink) : '';
  const arrow = model.arrow === 'left'
    ? `<path d="M12 116 L28 104 L28 111 L44 111 L44 121 L28 121 L28 128 Z" fill="${ink}"/>`
    : '';
  const captionX = arrow ? 50 : 14;
  const valueArt = house || chips ? '' : model.tab ? tabText(value, ink) : (layers
    ? `<text x="14" y="62" fill="${ink}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="26" font-weight="700">${xml(value)}</text>`
    : valueText(value, ink));
  const captionArt = house || layers ? '' : `<text x="${captionX}" y="122" fill="${dim}" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="700" letter-spacing="1.2">${xml(caption)}</text>`;
  const titleArt = house ? '' : `<text x="14" y="28" fill="${dim}" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="700" letter-spacing="1.4">${xml(title)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect x="${bw / 2}" y="${bw / 2}" width="${W - bw}" height="${H - bw}" rx="18" fill="${fill}" stroke="${border}" stroke-width="${bw}"${dash}/>
    <rect x="18" y="16" width="108" height="8" rx="3" fill="${bar}"/>
    ${ring}${osFrame}${mark}${house}${strike}
    ${titleArt}
    ${valueArt}
    ${layers}${chips}${arrow}
    ${captionArt}
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
    const tally = selectedTally(snap);
    return tallyChrome({
      ...base,
      title: `PRESET ${n}`,
      value: p ? p.name : `Preset ${n}`,
      caption: tally === 'pgm' ? 'HOLD' : '',
    }, tally);
  }
  if (role === 'page') {
    const page = settings.page || 'live';
    const on = deck.page === page;
    return { ...base, fill: on ? THEME.accent : THEME.panel, ink: on ? '#FFFFFF' : THEME.text, dim: on ? '#E7F0FF' : THEME.dim, title: 'PAGE', value: PAGE_LABEL[page] || page, caption: on ? 'ON' : '' };
  }
  const spec = KEY_ROLES[role];
  if (!spec) return { ...base, title: 'KEY', value: '—', caption: '' };
  if (spec.type === 'stopAll') return tallyChrome({ ...base, fill: THEME.dangerBg, border: THEME.pgm, ink: THEME.dangerText, dim: THEME.dangerText, title: '', value: 'ALL STOP', caption: 'HOLD' }, selectedTally(snap));
  if (spec.type === 'guard') {
    const mode = (snap.liveGuard && snap.liveGuard.mode) || 'hold';
    const on = mode !== 'off';
    return tallyChrome({ ...base, fill: on ? THEME.accent : THEME.panel, ink: '#FFFFFF', dim: on ? '#E7F0FF' : THEME.dim, title: spec.label, value: mode.toUpperCase(), caption: on ? 'ON' : '' }, selectedTally(snap));
  }
  const live = liveState(spec, snap);
  let model;
  if (live) {
    model = { ...base, fill: live.on ? THEME.accent : THEME.panel, ink: live.on ? '#FFFFFF' : THEME.text, dim: live.on ? '#E7F0FF' : THEME.dim, title: spec.label, value: live.value, caption: live.caption || '' };
  } else {
    model = { ...base, title: spec.label, value: spec.text || '', caption: '' };
  }
  if (role !== 'home' && role !== 'page' && role !== 'camera') model = tallyChrome(model, selectedTally(snap));
  return model;
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

function wipeIcon(pattern, W, H) {
  const w = 64;
  const h = 36;
  const x = (W - w) / 2;
  const y = H * 0.22;
  const ink = '#F4F7FB';
  const hole = '#14181e';
  const box = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${hole}" stroke="${ink}" stroke-width="2"/>`;
  const midX = x + w / 2;
  const midY = y + h / 2;
  const p = ((Number(pattern) || 0) % 18 + 18) % 18;
  const rect = (rx, ry, rw, rh) => `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="${ink}"/>`;
  let fill = '';
  if (p === 0) fill = rect(x, y, w / 2, h);
  else if (p === 1) fill = rect(midX, y, w / 2, h);
  else if (p === 2) fill = rect(x, y, w, h / 2);
  else if (p === 3) fill = rect(x, midY, w, h / 2);
  else if (p === 4) fill = `<polygon points="${x},${y} ${midX},${y} ${x},${midY}" fill="${ink}"/>`;
  else if (p === 5) fill = `<polygon points="${midX},${y} ${x + w},${y} ${x + w},${midY}" fill="${ink}"/>`;
  else if (p === 6) fill = `<polygon points="${x},${midY} ${midX},${y + h} ${x},${y + h}" fill="${ink}"/>`;
  else if (p === 7) fill = `<polygon points="${x + w},${midY} ${x + w},${y + h} ${midX},${y + h}" fill="${ink}"/>`;
  else if (p === 8) fill = `<circle cx="${midX}" cy="${midY}" r="12" fill="${ink}"/>`;
  else if (p === 9) fill = rect(midX - 10, midY - 8, 20, 16);
  else if (p === 10) fill = `<polygon points="${midX},${y + 4} ${x + w - 8},${midY} ${midX},${y + h - 4} ${x + 8},${midY}" fill="${ink}"/>`;
  else if (p === 11) fill = rect(midX - 4, y + 4, 8, h - 8) + rect(x + 8, midY - 4, w - 16, 8);
  else if (p === 12) fill = [0, 1, 2].map((i) => rect(x + 6 + i * 18, y + 4, 8, h - 8)).join('');
  else if (p === 13) fill = `<polygon points="${x},${y} ${x + w},${y} ${x},${y + h}" fill="${ink}"/>`;
  else if (p === 14) fill = `<path d="M ${midX} ${midY} L ${midX} ${y + 3} A 16 16 0 0 1 ${midX + 14} ${midY + 8} Z" fill="${ink}"/>`;
  else if (p === 15) fill = `<circle cx="${midX}" cy="${midY}" r="13" fill="none" stroke="${ink}" stroke-width="6"/>`;
  else if (p === 16) fill = `<rect x="${midX - 11}" y="${midY - 11}" width="22" height="22" fill="none" stroke="${ink}" stroke-width="4"/>`;
  else fill = rect(x + 3, y + 3, 14, 12);
  return box + fill;
}

function segmentSvg(strip, width, height) {
  const W = width || 200;
  const H = height || 100;
  const kind = strip.kind;
  const frame = strip.frame ? ` stroke="#E0B030" stroke-width="4"` : ' stroke="#2a313b" stroke-width="1"';
  const bg = strip.on ? '#1A3F86' : '#1a1e24';
  let body = '';
  if (kind === 'me') {
    body = `<text x="${W / 2}" y="${H * 0.42}" text-anchor="middle" fill="#8EA0B5" font-family="Arial" font-size="14" font-weight="700">M/E</text>
      <text x="${W / 2}" y="${H * 0.78}" text-anchor="middle" fill="#F4F7FB" font-family="Arial" font-size="36" font-weight="700">${xml(strip.text)}</text>`;
  } else if (kind === 'effect') {
    const modes = Array.isArray(strip.modes) && strip.modes.length ? strip.modes : ['MIX', 'DIP', 'WIPE', 'DVE', 'STING'];
    const rows = modes.length > 3 ? [modes.slice(0, 3), modes.slice(3)] : [modes];
    body = rows.map((row, r) => {
      const n = row.length;
      const gap = 6;
      const inner = W - 16;
      const pill = (inner - gap * (n - 1)) / n;
      const y = rows.length > 1 ? 10 + r * (H * 0.42) : H * 0.28;
      const h = rows.length > 1 ? H * 0.36 : H * 0.44;
      return row.map((mode, i) => {
        const on = strip.text === mode;
        const x = 8 + i * (pill + gap);
        return `<rect x="${x}" y="${y}" width="${pill}" height="${h}" rx="6" fill="${on ? '#3D6EA8' : '#14181e'}"/>
          <text x="${x + pill / 2}" y="${y + h * 0.66}" text-anchor="middle" fill="#F4F7FB" font-family="Arial" font-size="12" font-weight="700">${mode}</text>`;
      }).join('');
    }).join('');
  } else if (kind === 'wipe') {
    body = wipeIcon(Number(strip.pattern) || 0, W, H) + `<text x="${W / 2}" y="${H - 8}" text-anchor="middle" fill="#8EA0B5" font-family="Arial" font-size="12">${xml(strip.text || '')}</text>`;
  } else if (kind === 'time') {
    body = `<text x="${W / 2}" y="${H * 0.38}" text-anchor="middle" fill="#8EA0B5" font-family="Arial" font-size="14" font-weight="700">AUTO</text>
      <text x="${W / 2}" y="${H * 0.78}" text-anchor="middle" fill="#F4F7FB" font-family="Arial" font-size="32" font-weight="700">${xml(strip.text)}</text>`;
  } else if (kind === 'tbar') {
    const f = Math.max(0, Math.min(1, Number(strip.fraction) || 0));
    const trackX = W / 2 - 10;
    const trackY = 16;
    const trackH = H - 36;
    body = `<text x="16" y="20" fill="#8EA0B5" font-family="Arial" font-size="12" font-weight="700">T-BAR</text>
      <rect x="${trackX}" y="${trackY}" width="20" height="${trackH}" rx="6" fill="#14181e"/>
      <rect x="${trackX}" y="${trackY + trackH * (1 - f)}" width="20" height="${Math.max(4, trackH * f)}" rx="6" fill="#C42020"/>
      <text x="${W / 2}" y="${H - 6}" text-anchor="middle" fill="#F4F7FB" font-family="Arial" font-size="14">${xml(strip.text || '')}</text>`;
  } else if (kind === 'map') {
    body = strip.text
      ? `<text x="${W / 2}" y="${H * 0.35}" text-anchor="middle" fill="#8EA0B5" font-family="Arial" font-size="13" font-weight="700">MAP</text>
         <text x="${W / 2}" y="${H * 0.68}" text-anchor="middle" fill="#F4F7FB" font-family="Arial" font-size="18" font-weight="700">${xml(strip.text)}</text>`
      : `<text x="${W / 2}" y="${H * 0.55}" text-anchor="middle" fill="#5c6570" font-family="Arial" font-size="16"> </text>`;
  } else {
    body = `<text x="${W / 2}" y="${H * 0.58}" text-anchor="middle" fill="${strip.on ? '#F4F7FB' : '#8EA0B5'}" font-family="Arial" font-size="18" font-weight="700">${xml(strip.text || '')}</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" rx="12" fill="${bg}"${frame}/>${body}</svg>`;
}

module.exports = { arcPath, markPaths, knobSvg, keySvg, svgDataUrl, presentKey, presentDial, tallyChrome, encodePng, iconPng, canvas, segmentSvg };
