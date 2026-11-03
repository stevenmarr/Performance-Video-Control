'use strict';
// The same Control Dark key and knob pictures the Elgato plugin used
// (lib/deck-image.js). Rasterized to the pixel size the USB deck expects.

const { THEME, dialFace } = require('../deck');
const { keySvg, knobSvg, tallyChrome, segmentSvg } = require('../deck-image');

const cache = new Map();

function keyModel(key) {
  // Color bar and frames follow the console surface design (human-factors key
  // style): gray normal, blue selected, green preview, red on air, amber
  // guarded. Red fill stays only for an on-air / program key.
  // Control Center OS keys (home, console, shows, power) use a slate fill
  // and a light bar, not the blue of a selected device key.
  const blank = { fill: THEME.panel, ink: THEME.text, dim: THEME.dim, title: '', value: '', caption: '', bar: '#5c6570' };
  const os = {
    ...blank,
    fill: '#243044',
    ink: '#F4F7FB',
    dim: '#C5D0DC',
    border: '#8EA0B5',
    bar: '#C5D0DC',
    os: true,
  };
  if (key && key.faceStyle) {
    return {
      ...blank,
      fill: key.faceStyle.fill || blank.fill,
      ink: key.faceStyle.ink || blank.ink,
      dim: key.faceStyle.dim || key.faceStyle.ink || blank.dim,
      bar: key.faceStyle.bar || key.faceStyle.fill || blank.bar,
      border: key.faceStyle.border || null,
      os: !!key.faceStyle.os,
      house: !!key.faceStyle.house,
      layers: key.faceStyle.layers || null,
      tab: !!key.faceStyle.tab,
      arrow: key.faceStyle.arrow || null,
      bigText: key.faceStyle.bigText || null,
      title: key.faceStyle.title || '',
      value: key.faceStyle.value || '',
      caption: key.faceStyle.caption || '',
    };
  }
  if (!key || key.tone === 'blank' || (!key.label && !key.caption && key.nav !== 'home')) return blank;
  if (key.nav === 'home') {
    const cam = key.caption && key.caption !== 'BACK' && key.caption !== 'DECK' ? key.caption : '';
    return { ...os, title: cam || 'PAGE', value: 'HOME', caption: '' };
  }
  if (key.tone === 'os' || key.nav === 'console') {
    return { ...os, title: key.caption || 'OS', value: key.label || '', caption: '' };
  }
  const guarded = key.tone === 'guard' || key.hold === true || /^(ALL STOP|FTB|SHUTDN|REBOOT)$/.test(String(key.label || ''));
  if (guarded) {
    return { ...blank, bar: '#E0B030', guard: true, border: '#E0B030', title: key.caption || 'HOLD', value: key.label || '', caption: '' };
  }
  if (key.tone === 'stop') {
    return { ...blank, fill: THEME.dangerBg, border: THEME.pgm, bar: THEME.pgm, ink: THEME.dangerText, dim: THEME.dangerText, title: key.caption || '', value: key.label || '', caption: key.ring ? 'ALSO PVW' : '' };
  }
  if (key.tone === 'pvw') {
    return { ...blank, fill: THEME.panel, border: '#3DDC84', bar: '#3DDC84', ink: THEME.text, dim: '#9BE7B5', title: key.caption || 'PVW', value: key.label || '', caption: '' };
  }
  if (key.tone === 'go') {
    return { ...blank, bar: THEME.accent, border: THEME.accent, title: key.caption || '', value: key.label || '', caption: '' };
  }
  if (key.nav === 'page' || key.tone === 'nav') {
    const on = !!key.on;
    return { ...blank, fill: on ? '#1A3F86' : THEME.panel, ink: '#FFFFFF', dim: '#E7F0FF', border: on ? THEME.accent : null, bar: THEME.accent, title: key.caption || 'PAGE', value: key.label || '', caption: '' };
  }
  if (key.nav === 'system' || key.tone === 'home') {
    return { ...blank, fill: THEME.accent, ink: '#FFFFFF', dim: '#E7F0FF', bar: THEME.accent, title: key.caption || 'DEVICE', value: key.label || '', caption: '' };
  }
  const on = !!key.on;
  const live = !!key.live;
  const model = {
    ...blank,
    fill: on ? THEME.accent : THEME.panel,
    ink: on ? '#FFFFFF' : THEME.text,
    dim: on ? '#E7F0FF' : THEME.dim,
    ring: !!(key.ring || key.pressed),
    border: key.pressed ? THEME.active : null,
    bar: on ? THEME.accent : (key.tone === 'memory' ? '#C9A227' : '#5c6570'),
    title: live ? (key.label || '') : (key.caption || ''),
    value: live ? (key.caption || key.label || '') : (key.label || ''),
    caption: live ? (on ? 'ON' : '') : '',
  };
  return key.tally ? tallyChrome(model, key.tally) : model;
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

function cameraName(snap) {
  const cams = (snap && snap.cameras) || [];
  if (!cams.length) return '';
  const sel = snap && snap.selected;
  const cam = cams.find((c) => c.id === sel) || cams.find((c) => c.selected) || cams[0];
  return cam ? String(cam.name || cam.id || '').slice(0, 12) : '';
}

function dialSignature(dials, snap) {
  const name = cameraName(snap);
  return `${name}|` + (dials || []).map((dial) => {
    const strip = dial && dial.strip ? `${dial.strip.kind}:${dial.strip.text || ''}:${dial.strip.on ? 1 : 0}:${dial.strip.pattern ?? ''}:${dial.strip.fraction ?? ''}` : '';
    if (dial && dial.readout) return `${dial.label}:${dial.readout}:${dial.fraction || 0}:${strip}`;
    try {
      const face = dialFace(dial.widget, snap || {}, dial.stepIndex || 0);
      return `${dial.widget}:${dial.stepIndex || 0}:${face.tally || ''}:${face.step || ''}:${(face.parts || []).map((part) => `${part.label}:${part.text}:${part.fraction}:${part.active ? 1 : 0}`).join('/')}`;
    } catch { return dial.widget || ''; }
  }).join('|');
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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
  const custom = list.some((dial) => dial && dial.strip);
  const name = custom ? '' : cameraName(snap);
  const labelW = name ? Math.min(160, Math.max(88, Math.round(width * 0.16))) : 0;
  if (name && labelW > 0) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${labelW}" height="${height}" viewBox="0 0 ${labelW} ${height}">
      <rect width="${labelW}" height="${height}" fill="${THEME.bg}"/>
      <text x="10" y="${Math.round(height * 0.42)}" fill="#8EA0B5" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="700" letter-spacing="1.4">CAM</text>
      <text x="10" y="${Math.round(height * 0.72)}" fill="#F4F7FB" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="700">${esc(name)}</text>
    </svg>`;
    blit(data, width, raster(svg, labelW, height), 0, 0);
  }
  const rest = Math.max(1, width - labelW);
  const slice = Math.floor(rest / list.length);
  list.forEach((dial, i) => {
    let face;
    if (dial && dial.strip) {
      const img = raster(segmentSvg(dial.strip, slice, height), slice, height);
      blit(data, width, img, labelW + i * slice, 0);
      return;
    }
    if (dial && dial.readout) {
      face = { kind: 'single', stepLine: dial.label || '', parts: [{ label: dial.label || '', text: dial.readout, fraction: dial.fraction || 0, tint: 'knob', active: true }] };
    } else {
      try { face = dialFace(dial.widget, snap || {}, dial.stepIndex || 0); } catch { return; }
    }
    const img = raster(knobSvg(face), slice, height);
    blit(data, width, img, labelW + i * slice, 0);
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
