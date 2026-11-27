'use strict';
// UHD crop geometry. Crop is only legal when the system format is a 2160 mode.
// Default: Crop(1080) on, window centered, even pixels. Ranges differ by model (UE150 IF p.48, UE150A p.55, UE160 p.71).

const MODE = Object.freeze({ off: 0, 1080: 1, 720: 2 });
const WINDOWS = Object.freeze(['yl', 'g', 'mg']);
const COLORS = Object.freeze({ yl: 'yellow', g: 'green', mg: 'magenta' });

// Frame is the UHD raster the crop window moves inside (not the crop size).
const RANGES = Object.freeze({
  'AW-UE150': { h: 2560, v: 1440, zoom: null },
  'AW-HE145': { h: 2560, v: 1440, zoom: null },
  'AW-UE150A': { h: 2742, v: 1543, zoom: { min: 120, max: 350 } },
  'AW-UE160': { h: 3072, v: 1728, zoom: { min: 120, max: 500 } },
  'AW-UE163': { h: 3072, v: 1728, zoom: { min: 120, max: 500 } },
});

const SIZE = Object.freeze({ 1080: { w: 1920, h: 1080 }, 720: { w: 1280, h: 720 } });

const even = (n) => Math.max(0, Math.floor(Number(n) / 2) * 2);

function rangeFor(model) {
  const key = String(model || '').toUpperCase();
  return RANGES[key] || RANGES[Object.keys(RANGES).find((k) => key.includes(k.replace('AW-', ''))) ] || RANGES['AW-UE150'];
}

function cropLegal(format) {
  return /2160/.test(String(format || ''));
}

function centered(model, mode = 1080) {
  const size = SIZE[mode];
  if (!size) throw new Error(`Unknown crop mode ${mode}`);
  const r = rangeFor(model);
  const x = even((r.h - size.w) / 2);
  const y = even((r.v - size.h) / 2);
  return { mode, x, y, w: size.w, h: size.h, frame: { w: r.h, h: r.v }, zoom: r.zoom };
}

function clampWindow(model, { x, y, mode = 1080 } = {}) {
  const size = SIZE[mode];
  const r = rangeFor(model);
  const maxX = even(Math.max(0, r.h - size.w));
  const maxY = even(Math.max(0, r.v - size.h));
  return { mode, x: Math.min(maxX, even(x)), y: Math.min(maxY, even(y)), w: size.w, h: size.h, frame: { w: r.h, h: r.v } };
}

// Command ids per window (YL / G / MG): H then V.
const POS = Object.freeze({ yl: ['OSJ:2F', 'OSJ:30'], g: ['OSJ:31', 'OSJ:32'], mg: ['OSJ:33', 'OSJ:34'] });

function hex3(n) { return even(n).toString(16).toUpperCase().padStart(3, '0'); }

function commands({ model, mode = 1080, window = 'yl', x, y, sdiOut = 'crop', ipOut = 'crop', live = false } = {}) {
  const pos = (x == null || y == null) ? centered(model, mode) : clampWindow(model, { x, y, mode });
  const [hCmd, vCmd] = POS[window] || POS.yl;
  const cmds = [];
  if (!live) {
    cmds.push({ path: 'cam', cmd: `OSJ:2E:${MODE[mode] ?? 1}` }); // UHD Crop on
    cmds.push({ path: 'cam', cmd: `OSI:16:${WINDOWS.indexOf(window) + 1}` }); // crop out
    cmds.push({ path: 'cam', cmd: `OSI:17:${WINDOWS.indexOf(window) + 1}` }); // crop adjust
    cmds.push({ path: 'cam', cmd: `OSI:32:${sdiOut === 'crop' ? 1 : 0}` });
    cmds.push({ path: 'cam', cmd: `OSI:33:${ipOut === 'crop' ? 1 : 0}` });
  }
  cmds.push({ path: 'cam', cmd: `${hCmd}:${hex3(pos.x)}` });
  cmds.push({ path: 'cam', cmd: `${vCmd}:${hex3(pos.y)}` });
  return { pos, cmds };
}

function parseMode(v) {
  const n = Number.parseInt(String(v), 16) || Number(v);
  if (n === 1) return 1080;
  if (n === 2) return 720;
  return 'off';
}

module.exports = { MODE, WINDOWS, COLORS, RANGES, SIZE, even, rangeFor, cropLegal, centered, clampWindow, POS, hex3, commands, parseMode };
