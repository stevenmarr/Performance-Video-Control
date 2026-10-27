'use strict';
// The same Control Dark key and knob pictures the Elgato plugin used
// (lib/deck-image.js). Rasterized to the pixel size the USB deck expects.

const { THEME, dialFace } = require('../deck');
const { keySvg, knobSvg } = require('../deck-image');

const cache = new Map();

function keyModel(key) {
  const blank = { fill: THEME.panel, ink: THEME.text, dim: THEME.dim, title: '', value: '', caption: '' };
  if (!key || key.tone === 'blank' || (!key.label && !key.caption && key.nav !== 'home')) return blank;
  if (key.nav === 'home') return { ...blank, mark: true };
  if (key.tone === 'stop') {
    return { ...blank, fill: THEME.dangerBg, border: THEME.pgm, ink: THEME.dangerText, dim: THEME.dangerText, title: key.caption || '', value: key.label || '', caption: '' };
  }
  if (key.nav === 'page' || key.tone === 'nav') {
    return { ...blank, fill: THEME.accent, ink: '#FFFFFF', dim: '#E7F0FF', title: key.caption || 'PAGE', value: key.label || '', caption: '' };
  }
  if (key.nav === 'system' || key.tone === 'home') {
    return { ...blank, fill: THEME.accent, ink: '#FFFFFF', dim: '#E7F0FF', title: key.caption || 'DEVICE', value: key.label || '', caption: '' };
  }
  const on = !!key.on;
  return {
    ...blank,
    fill: on ? THEME.accent : THEME.panel,
    ink: on ? '#FFFFFF' : THEME.text,
    dim: on ? '#E7F0FF' : THEME.dim,
    ring: !!(key.ring || key.pressed),
    border: key.pressed ? THEME.active : null,
    title: key.caption || '',
    value: key.label || '',
    caption: '',
  };
}

function raster(svg, width, height) {
  const key = `${width}x${height}:${svg}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let Resvg;
  try { ({ Resvg } = require('@resvg/resvg-js')); } catch (e) {
    const err = new Error('Button art needs @resvg/resvg-js. Run npm install in this repo.');
    err.cause = e;
    throw err;
  }
  const rendered = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { loadSystemFonts: true, defaultFontFamily: 'Arial' },
    background: THEME.bg,
  }).render();
  const sw = rendered.width;
  const sh = rendered.height;
  const src = Buffer.from(rendered.pixels);
  const data = Buffer.alloc(width * height * 4);
  const [br, bg, bb] = hex(THEME.bg);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = br;
    data[i + 1] = bg;
    data[i + 2] = bb;
    data[i + 3] = 255;
  }
  const ox = Math.max(0, Math.floor((width - sw) / 2));
  const oy = Math.max(0, Math.floor((height - sh) / 2));
  for (let y = 0; y < sh && oy + y < height; y++) {
    for (let x = 0; x < sw && ox + x < width; x++) {
      const s = (y * sw + x) * 4;
      const d = ((oy + y) * width + (ox + x)) * 4;
      const a = src[s + 3] / 255;
      data[d] = Math.round(src[s] * a + data[d] * (1 - a));
      data[d + 1] = Math.round(src[s + 1] * a + data[d + 1] * (1 - a));
      data[d + 2] = Math.round(src[s + 2] * a + data[d + 2] * (1 - a));
      data[d + 3] = 255;
    }
  }
  const image = { data, width, height };
  cache.set(key, image);
  return image;
}

function hex(h) {
  const s = String(h).replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

function keyImage(key, width, height) {
  return raster(keySvg(keyModel(key)), width, height || width);
}

function dialSignature(dials, snap) {
  return (dials || []).map((dial) => {
    try {
      const face = dialFace(dial.widget, snap || {}, dial.stepIndex || 0);
      return `${dial.widget}:${(face.parts || []).map((part) => `${part.text}:${part.fraction}`).join('/')}`;
    } catch { return dial.widget || ''; }
  }).join('|');
}

function stripImage(width, height, dials, snap) {
  const data = Buffer.alloc(width * height * 4);
  const [br, bg, bb] = hex(THEME.bg);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = br;
    data[i + 1] = bg;
    data[i + 2] = bb;
    data[i + 3] = 255;
  }
  const list = dials && dials.length ? dials : [];
  if (!list.length) return { data, width, height };
  const slice = Math.floor(width / list.length);
  list.forEach((dial, i) => {
    let face;
    try { face = dialFace(dial.widget, snap || {}, dial.stepIndex || 0); } catch { return; }
    const img = raster(knobSvg(face), slice, height);
    blit(data, width, img, i * slice, 0);
  });
  return { data, width, height };
}

function blit(dst, dstW, src, dx, dy) {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const tx = dx + x;
      const ty = dy + y;
      if (tx < 0 || ty < 0 || tx >= dstW) continue;
      const s = (y * src.width + x) * 4;
      const d = (ty * dstW + tx) * 4;
      dst[d] = src.data[s];
      dst[d + 1] = src.data[s + 1];
      dst[d + 2] = src.data[s + 2];
      dst[d + 3] = 255;
    }
  }
}

module.exports = { keyModel, keyImage, stripImage, dialSignature, blit, keySvg, knobSvg };
