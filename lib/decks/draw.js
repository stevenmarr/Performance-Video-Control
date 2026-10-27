'use strict';
// Labels for Stream Deck keys and the + / + XL touch strip.
// The USB library takes a raw RGBA buffer at the key's pixel size. A JPEG
// is ignored, which is why a color-only fill showed no text.

const FONT = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '-': [0, 0, 0, 31, 0, 0, 0],
  '.': [0, 0, 0, 0, 0, 6, 6],
  '0': [14, 17, 19, 21, 25, 17, 14],
  '1': [4, 12, 4, 4, 4, 4, 14],
  '2': [14, 17, 1, 2, 4, 8, 31],
  '3': [14, 17, 1, 6, 1, 17, 14],
  '4': [2, 6, 10, 18, 31, 2, 2],
  '5': [31, 16, 30, 1, 1, 17, 14],
  '6': [6, 8, 16, 30, 17, 17, 14],
  '7': [31, 1, 2, 4, 8, 8, 8],
  '8': [14, 17, 17, 14, 17, 17, 14],
  '9': [14, 17, 17, 15, 1, 2, 12],
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 14],
  H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17],
  L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 25, 21, 19, 17, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13],
  R: [30, 17, 17, 30, 20, 18, 17],
  S: [14, 17, 16, 14, 1, 17, 14],
  T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 27, 17],
  X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31],
};

const TONE = {
  blank: [18, 20, 24],
  home: [28, 58, 110],
  nav: [36, 42, 52],
  go: [22, 72, 48],
  stop: [110, 32, 36],
  memory: [78, 58, 22],
  func: [42, 48, 62],
};

function toneOf(key) {
  return TONE[key && key.tone] || TONE.func;
}

function glyph(ch) {
  return FONT[ch] || FONT[' '];
}

function drawText(data, width, height, text, rgb, opt = {}) {
  const scale = opt.scale || 2;
  const line = String(text || '').toUpperCase().slice(0, opt.max || 8);
  const chars = line.split('');
  const textW = chars.length * 6 * scale - scale;
  const box = opt.box || width;
  const origin = opt.x || 0;
  let x0 = origin + Math.max(1, Math.floor((box - textW) / 2));
  const y0 = opt.y != null ? opt.y : Math.max(2, Math.floor((height - 7 * scale) / 2));
  for (const ch of chars) {
    const rows = glyph(ch);
    for (let ry = 0; ry < 7; ry++) {
      for (let rx = 0; rx < 5; rx++) {
        if (!(rows[ry] & (1 << (4 - rx)))) continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const x = x0 + rx * scale + sx;
            const y = y0 + ry * scale + sy;
            if (x < 0 || y < 0 || x >= width || y >= height) continue;
            const i = (y * width + x) * 4;
            data[i] = rgb[0];
            data[i + 1] = rgb[1];
            data[i + 2] = rgb[2];
            data[i + 3] = 255;
          }
        }
      }
    }
    x0 += 6 * scale;
  }
}

function keyImage(key, width, height) {
  const w = width || 72;
  const h = height || w;
  const data = Buffer.alloc(w * h * 4);
  const bg = toneOf(key);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = bg[0];
    data[i + 1] = bg[1];
    data[i + 2] = bg[2];
    data[i + 3] = 255;
  }
  const edge = bg.map((n) => Math.min(255, n + 50));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < 3 || y < 3 || x >= w - 3 || y >= h - 3) {
        const i = (y * w + x) * 4;
        data[i] = edge[0];
        data[i + 1] = edge[1];
        data[i + 2] = edge[2];
      }
    }
  }
  const caption = key && key.caption ? String(key.caption) : '';
  const label = key && key.label ? String(key.label) : '';
  if (caption) drawText(data, w, h, caption, [186, 196, 210], { scale: w >= 96 ? 2 : 1, y: Math.round(h * 0.16), max: 10 });
  if (label) drawText(data, w, h, label, [244, 246, 248], { scale: w >= 96 ? 4 : 3, y: Math.round(h * 0.48), max: 8 });
  else if (!caption) { /* blank key */ }
  return { rgb: bg, data, width: w, height: h };
}

function stripImage(width, height, slots) {
  const w = width;
  const h = height;
  const data = Buffer.alloc(w * h * 4, 0);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 12;
    data[i + 1] = 16;
    data[i + 2] = 22;
    data[i + 3] = 255;
  }
  for (const slot of slots || []) {
    const x0 = Math.max(0, Math.floor(slot.x));
    const x1 = Math.min(w, Math.ceil(slot.x + slot.w));
    for (let y = 0; y < h; y++) {
      const i = (y * w + x0) * 4;
      data[i] = 40;
      data[i + 1] = 78;
      data[i + 2] = 140;
    }
    if (x1 - 1 < w) {
      for (let y = 0; y < h; y++) {
        const i = (y * w + (x1 - 1)) * 4;
        data[i] = 40;
        data[i + 1] = 48;
        data[i + 2] = 60;
      }
    }
    const label = String(slot.label || '');
    if (!label) continue;
    drawText(data, w, h, label, [236, 240, 244], {
      scale: h >= 80 ? 3 : 2,
      y: Math.round(h * 0.28),
      x: x0,
      box: x1 - x0,
      max: 8,
    });
  }
  return { data, width: w, height: h };
}

module.exports = { keyImage, stripImage, toneOf };
