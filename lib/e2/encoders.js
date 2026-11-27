'use strict';
// Encoder math for Event Master layer programming.
//
// A Stream Deck + XL dial is one detent at a time. A slow turn has to move the
// layer by one pixel (or one tenth of a mask percent). A fast spin is the only
// thing that takes a coarse step. That is the same idea as the paint dials in
// lib/paint-accel.js, with two differences that matter on a screen: the numbers
// are pixels on a multi-thousand-pixel canvas, and a long press is 800 ms.
// Paint's 500 ms reset is left alone.

const LONG_PRESS_MS = 800;

const CURVE = Object.freeze({
  baseStep: 1,
  exponent: 3,
  maxMultiplier: 32,
  slowMs: 90,
  fastMs: 16,
  windowMs: 500,
  maxStepsPerEvent: 160,
});

const PERCENT = Object.freeze({ ...CURVE, maxMultiplier: 6, maxStepsPerEvent: 12 });
const ENUM = Object.freeze({ ...CURVE, maxMultiplier: 1, maxStepsPerEvent: 1 });

function curveFor(kind) {
  if (kind === 'percent') return PERCENT;
  if (kind === 'enum') return ENUM;
  return CURVE;
}

function multiplier(dtMs, ticks, cfg) {
  const abs = Math.max(1, Math.abs(Math.trunc(Number(ticks) || 1)));
  if (dtMs == null || dtMs === '') return cfg.baseStep;
  const dt = Number(dtMs);
  if (!Number.isFinite(dt) || dt < 0 || dt >= cfg.windowMs) return cfg.baseStep;
  const msPer = dt / abs;
  if (msPer >= cfg.slowMs) return cfg.baseStep;
  const span = Math.max(1, cfg.slowMs - cfg.fastMs);
  const t = Math.max(0, Math.min(1, (cfg.slowMs - msPer) / span));
  const shaped = t ** cfg.exponent;
  const mult = cfg.baseStep + shaped * (cfg.maxMultiplier - cfg.baseStep);
  return Math.max(cfg.baseStep, Math.min(cfg.maxMultiplier, Math.round(mult)));
}

function stepsFor(param, ticks, dtMs) {
  const n = Math.trunc(Number(ticks));
  if (!n) return 0;
  const fine = Number(param && param.fine) > 0 ? Number(param.fine) : 1;
  const curve = (param && param.curve) || CURVE;
  const sign = n < 0 ? -1 : 1;
  const abs = Math.abs(n);
  const mult = multiplier(dtMs, abs, curve);
  const raw = abs * mult * fine;
  const cap = (curve.maxStepsPerEvent || 160) * fine;
  const mag = Math.max(fine, Math.min(cap, raw));
  const snapped = Math.round(mag / fine) * fine;
  return sign * Number(snapped.toFixed(4));
}

function clamp(value, min, max) {
  let v = value;
  if (min != null && Number.isFinite(Number(min))) v = Math.max(Number(min), v);
  if (max != null && Number.isFinite(Number(max))) v = Math.min(Number(max), v);
  return v;
}

function applyTurn(param, ticks, dtMs) {
  const current = Number(param.value);
  const base = Number.isFinite(current) ? current : 0;
  const delta = stepsFor(param, ticks, dtMs);
  const value = clamp(base + delta, param.min, param.max);
  return { value: Number(value.toFixed(4)), delta };
}

function pressKind(heldMs, longPressMs = LONG_PRESS_MS) {
  const held = Number(heldMs);
  const limit = Number(longPressMs);
  if (!Number.isFinite(held) || held < 0) return 'toggle';
  return held >= (Number.isFinite(limit) ? limit : LONG_PRESS_MS) ? 'reset' : 'toggle';
}

function range(kind, dest) {
  const w = (dest && dest.h) || 3840;
  const h = (dest && dest.v) || 2160;
  const span = Math.max(w, h);
  if (kind === 'pos') return { min: -span * 2, max: span * 2, fine: 1, curve: CURVE, reset: 0 };
  if (kind === 'size') return { min: 0, max: span * 4, fine: 1, curve: CURVE, reset: null };
  if (kind === 'percent') return { min: 0, max: 100, fine: 0.1, curve: PERCENT, reset: 0 };
  if (kind === 'color') return { min: 0, max: 1023, fine: 1, curve: CURVE, reset: 0 };
  if (kind === 'unit') return { min: 0, max: 100, fine: 1, curve: CURVE, reset: 100 };
  if (kind === 'time') return { min: 0, max: 250, fine: 1, curve: CURVE, reset: 30 };
  if (kind === 'enum') return { min: 0, max: 16, fine: 1, curve: ENUM, reset: 0 };
  return { min: null, max: null, fine: 1, curve: CURVE, reset: 0 };
}

function param(id, label, kind, extra) {
  return { id, label, ...range(kind, extra && extra.dest), ...(extra || {}) };
}

function pair(id, a, b) {
  const items = [a, b].filter(Boolean);
  return { id, pair: items, label: items.map((p) => p.label).join(' / ') };
}

function single(id, p) {
  return { id, pair: [p], label: p.label };
}

// Banks follow the layer that is actually selected. A frame that did not send
// Border does not get a border dial. Mask (the layer's edge crop, L/R/T/B)
// stays on a different dial from Source (the crop into the input, X/Y/W/H).
function banksFor(layer, dest) {
  if (!layer || layer.role === 'background') return [];
  const f = layer.fields || {};
  const has = (id) => !!f[id];
  const d = dest && dest.size;
  const place = [];
  const edge = [];
  if (has('posH') || has('posV')) {
    place.push(pair('pos',
      has('posH') ? param('posH', 'POS H', 'pos', { dest: d }) : null,
      has('posV') ? param('posV', 'POS V', 'pos', { dest: d }) : null));
  }
  if (has('sizeH') || has('sizeV')) {
    place.push(pair('size',
      has('sizeH') ? param('sizeH', 'SIZE H', 'size', { dest: d }) : null,
      has('sizeV') ? param('sizeV', 'SIZE V', 'size', { dest: d }) : null));
  }
  if (has('maskL') || has('maskR')) {
    edge.push(pair('maskX',
      has('maskL') ? param('maskL', 'MASK L', 'percent') : null,
      has('maskR') ? param('maskR', 'MASK R', 'percent') : null));
  }
  if (has('maskT') || has('maskB')) {
    edge.push(pair('maskY',
      has('maskT') ? param('maskT', 'MASK T', 'percent') : null,
      has('maskB') ? param('maskB', 'MASK B', 'percent') : null));
  }
  if (has('cropH') || has('cropV')) {
    edge.push(pair('cropPos',
      has('cropH') ? param('cropH', 'CROP X', 'pos', { dest: d, group: 'source' }) : null,
      has('cropV') ? param('cropV', 'CROP Y', 'pos', { dest: d, group: 'source' }) : null));
  }
  if (has('cropW') || has('cropHsize')) {
    edge.push(pair('cropSize',
      has('cropW') ? param('cropW', 'CROP W', 'size', { dest: d, group: 'source' }) : null,
      has('cropHsize') ? param('cropHsize', 'CROP H', 'size', { dest: d, group: 'source' }) : null));
  }
  const banks = [];
  if (place.length && edge.length && place.length + edge.length > 6) {
    banks.push({ id: 'place', label: 'PLACE', encoders: place.slice(0, 6) });
    banks.push({ id: 'edge', label: 'CROP', encoders: edge.slice(0, 6) });
  } else if (place.length || edge.length) {
    banks.push({ id: 'place', label: edge.length && !place.length ? 'CROP' : 'PLACE', encoders: [...place, ...edge].slice(0, 6) });
  }
  const look = [];
  if (has('borderSize') || has('borderSoft')) {
    look.push(pair('border',
      has('borderSize') ? param('borderSize', 'BDR SIZE', 'unit', { reset: 0 }) : null,
      has('borderSoft') ? param('borderSoft', 'BDR SOFT', 'unit', { reset: 0 }) : null));
  }
  if (has('borderR') || has('borderG')) {
    look.push(pair('borderRG',
      has('borderR') ? param('borderR', 'BDR R', 'color') : null,
      has('borderG') ? param('borderG', 'BDR G', 'color') : null));
  }
  if (has('borderB') || has('borderOpacity')) {
    look.push(pair('borderB',
      has('borderB') ? param('borderB', 'BDR B', 'color') : null,
      has('borderOpacity') ? param('borderOpacity', 'BDR OP', 'unit', { reset: 100 }) : null));
  }
  if (has('shadowH') || has('shadowV')) {
    look.push(pair('shadowPos',
      has('shadowH') ? param('shadowH', 'SHDW H', 'pos', { dest: d, reset: 0 }) : null,
      has('shadowV') ? param('shadowV', 'SHDW V', 'pos', { dest: d, reset: 0 }) : null));
  }
  if (has('shadowSize') || has('shadowSoft') || has('shadowOpacity')) {
    look.push(pair('shadowSize',
      has('shadowSize') ? param('shadowSize', 'SHDW SIZE', 'unit', { reset: 0 }) : (has('shadowOpacity') ? param('shadowOpacity', 'SHDW OP', 'unit', { reset: 0 }) : null),
      has('shadowSoft') ? param('shadowSoft', 'SHDW SOFT', 'unit', { reset: 0 }) : null));
  }
  if (has('opacity')) {
    const word = layer.pvw && layer.pvw.opacityName === 'Transparency' ? 'TRANSP' : 'OPACITY';
    look.push(single('opacity', param('opacity', word, 'unit', { reset: 100 })));
  }
  if (look.length) banks.push({ id: 'look', label: 'LOOK', encoders: look.slice(0, 6) });
  const key = [];
  if (has('keyClip') || has('keyGain')) {
    key.push(pair('key',
      has('keyClip') ? param('keyClip', 'CLIP', 'unit', { reset: 0 }) : null,
      has('keyGain') ? param('keyGain', 'GAIN', 'unit', { reset: 0 }) : null));
  }
  if (has('transInType') || has('transInTime')) {
    key.push(pair('transIn',
      has('transInType') ? param('transInType', 'IN TYPE', 'enum') : null,
      has('transInTime') ? param('transInTime', 'IN TIME', 'time') : null));
  }
  if (has('transOutType') || has('transOutTime')) {
    key.push(pair('transOut',
      has('transOutType') ? param('transOutType', 'OUT TYPE', 'enum') : null,
      has('transOutTime') ? param('transOutTime', 'OUT TIME', 'time') : null));
  }
  if (has('effectType') || has('effectTime')) {
    key.push(pair('effect',
      has('effectType') ? param('effectType', 'FX TYPE', 'enum') : null,
      has('effectTime') ? param('effectTime', 'FX TIME', 'time') : null));
  }
  if (key.length) banks.push({ id: 'key', label: 'KEY', encoders: key.slice(0, 6) });
  return banks;
}

function valueOf(layer, id) {
  const s = layer && layer.pvw;
  if (!s) return null;
  const w = s.window || {};
  const c = s.crop || {};
  const m = s.mask || {};
  const b = s.border || {};
  const sh = s.shadow || {};
  const k = s.key || {};
  const t = s.transition || {};
  const e = s.effect || {};
  const map = {
    posH: w.hPos, posV: w.vPos, sizeH: w.hSize, sizeV: w.vSize,
    cropH: c.hPos, cropV: c.vPos, cropW: c.hSize, cropHsize: c.vSize,
    maskL: m.left, maskR: m.right, maskT: m.top, maskB: m.bottom,
    borderSize: b.size, borderSoft: b.softness, borderOpacity: b.opacity,
    borderR: b.color && b.color.r, borderG: b.color && b.color.g, borderB: b.color && b.color.b,
    shadowH: sh.h, shadowV: sh.v, shadowSize: sh.size, shadowSoft: sh.softness, shadowOpacity: sh.opacity,
    opacity: s.opacity,
    keyClip: k.clip, keyGain: k.gain,
    transInType: t.inType, transInTime: t.inTime, transOutType: t.outType, transOutTime: t.outTime,
    effectType: e.type, effectTime: e.time,
  };
  return map[id] == null ? null : map[id];
}

function writeValue(layer, id, value) {
  const s = layer.pvw;
  const ensure = (key) => { s[key] = s[key] || {}; return s[key]; };
  if (id === 'posH') ensure('window').hPos = value;
  else if (id === 'posV') ensure('window').vPos = value;
  else if (id === 'sizeH') ensure('window').hSize = value;
  else if (id === 'sizeV') ensure('window').vSize = value;
  else if (id === 'cropH') ensure('crop').hPos = value;
  else if (id === 'cropV') ensure('crop').vPos = value;
  else if (id === 'cropW') ensure('crop').hSize = value;
  else if (id === 'cropHsize') ensure('crop').vSize = value;
  else if (id === 'maskL') ensure('mask').left = value;
  else if (id === 'maskR') ensure('mask').right = value;
  else if (id === 'maskT') ensure('mask').top = value;
  else if (id === 'maskB') ensure('mask').bottom = value;
  else if (id === 'borderSize') ensure('border').size = value;
  else if (id === 'borderSoft') ensure('border').softness = value;
  else if (id === 'borderOpacity') ensure('border').opacity = value;
  else if (id === 'borderR' || id === 'borderG' || id === 'borderB') {
    const b = ensure('border');
    b.color = b.color || {};
    b.color[id === 'borderR' ? 'r' : id === 'borderG' ? 'g' : 'b'] = value;
  } else if (id === 'shadowH') ensure('shadow').h = value;
  else if (id === 'shadowV') ensure('shadow').v = value;
  else if (id === 'shadowSize') ensure('shadow').size = value;
  else if (id === 'shadowSoft') ensure('shadow').softness = value;
  else if (id === 'shadowOpacity') ensure('shadow').opacity = value;
  else if (id === 'opacity') s.opacity = value;
  else if (id === 'keyClip') ensure('key').clip = value;
  else if (id === 'keyGain') ensure('key').gain = value;
  else if (id === 'transInType') ensure('transition').inType = value;
  else if (id === 'transInTime') ensure('transition').inTime = value;
  else if (id === 'transOutType') ensure('transition').outType = value;
  else if (id === 'transOutTime') ensure('transition').outTime = value;
  else if (id === 'effectType') ensure('effect').type = value;
  else if (id === 'effectTime') ensure('effect').time = value;
}

function aspectRatio(layer, source) {
  const w = layer && layer.pvw && layer.pvw.window;
  if (source && source.size && source.size.h && source.size.v) return source.size.h / source.size.v;
  if (w && w.hSize && w.vSize) return w.hSize / w.vSize;
  return 16 / 9;
}

function lockSize(which, value, ratio) {
  const r = Number(ratio);
  if (!Number.isFinite(r) || r <= 0) return null;
  if (which === 'h') return { hSize: value, vSize: Math.max(1, Math.round(value / r)) };
  return { vSize: value, hSize: Math.max(1, Math.round(value * r)) };
}

function centerWindow(dest, win) {
  const dw = dest && dest.h ? dest.h : 0;
  const dh = dest && dest.v ? dest.v : 0;
  const w = win && win.hSize != null ? win.hSize : dw;
  const h = win && win.vSize != null ? win.vSize : dh;
  return {
    hPos: Math.round((dw - w) / 2),
    vPos: Math.round((dh - h) / 2),
    hSize: w,
    vSize: h,
  };
}

function fitWindow(dest, ratio, mode) {
  const dw = dest && dest.h ? dest.h : 1920;
  const dh = dest && dest.v ? dest.v : 1080;
  const r = Number(ratio) > 0 ? Number(ratio) : dw / dh;
  let w = dw;
  let h = dw / r;
  const cover = mode === 'fill';
  if (cover ? h < dh : h > dh) {
    h = dh;
    w = dh * r;
  }
  return centerWindow(dest && dest.h ? dest : { h: dw, v: dh }, { hSize: Math.round(w), vSize: Math.round(h) });
}

function zStep(z, dir, count) {
  const cur = Number.isFinite(Number(z)) ? Number(z) : 0;
  const max = Math.max(0, (Number(count) || 1) - 1);
  const next = cur + (dir < 0 ? -1 : 1);
  return Math.max(0, Math.min(max, next));
}

function formatValue(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (Math.abs(n - Math.round(n)) < 0.001) return String(Math.round(n));
  return String(Math.round(n * 10) / 10);
}

function fraction(value, min, max) {
  const a = Number(min);
  const b = Number(max);
  const v = Number(value);
  if (!Number.isFinite(v) || !Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return Math.max(0, Math.min(1, (v - a) / (b - a)));
}

module.exports = {
  LONG_PRESS_MS, CURVE, PERCENT, ENUM,
  multiplier, stepsFor, applyTurn, pressKind, banksFor, valueOf, writeValue,
  aspectRatio, lockSize, centerWindow, fitWindow, zStep, formatValue, fraction, clamp,
};
