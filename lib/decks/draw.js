'use strict';
// Tiny labels for Stream Deck keys. jpeg-js is optional; without it the deck
// still gets a solid color.

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

function drawText(data, width, height, text, rgb) {
  const lines = String(text || '').toUpperCase().split('\n').slice(0, 3);
  const scale = width >= 96 ? 3 : 2;
  const lineH = 8 * scale;
  let y0 = Math.max(2, Math.floor((height - lines.length * lineH) / 2));
  for (const line of lines) {
    const chars = line.slice(0, 8).split('');
    const w = chars.length * 6 * scale - scale;
    let x0 = Math.max(1, Math.floor((width - w) / 2));
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
    y0 += lineH;
  }
}

function keyImage(key, size) {
  const width = size || 72;
  const height = size || 72;
  const data = Buffer.alloc(width * height * 4);
  const bg = toneOf(key);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = bg[0];
    data[i + 1] = bg[1];
    data[i + 2] = bg[2];
    data[i + 3] = 255;
  }
  const caption = key && key.caption ? String(key.caption) : '';
  const label = key && key.label ? String(key.label) : '';
  const text = caption && label ? `${caption}\n${label}` : (label || caption);
  if (text.trim()) drawText(data, width, height, text, [236, 240, 244]);
  let jpeg = null;
  try {
    jpeg = require('jpeg-js').encode({ data, width, height }, 70).data;
  } catch { jpeg = null; }
  return { rgb: bg, jpeg, width, height };
}

module.exports = { keyImage, toneOf };
