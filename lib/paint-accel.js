'use strict';
// Velocity curve for Stream Deck dials and for pan/tilt/zoom/focus keys.
// One detent at a slow or moderate turn is exactly one native camera step.
// Only a clearly fast turn leaves that fine zone, and it climbs an ease-in
// (exponent > 1) so the jump into coarse steps is gentle. A flick is still
// capped. Tune ACCEL, OVERRIDES, and HOLD in this file. Pass a cfg object
// into multiplier, stepsFor, holdGain, or velocityFor to try another curve
// without editing the defaults.

// Speed is detents per unit time: `dtMs` is the gap since the previous
// dialRotate (or USB rotate) for that dial, and `ticks` is how many detents
// that event bundled. The first event, or a gap longer than `windowMs`, is a
// fresh slow turn.
//
// `slowMs` is the fastest gap that still counts as one step. A smaller
// slowMs widens the fine zone (you can turn faster and stay at one step).

const ACCEL = Object.freeze({
  baseStep: 1,
  exponent: 3,
  maxMultiplier: 6,
  slowMs: 72,
  fastMs: 18,
  windowMs: 450,
  maxStepsPerEvent: 24,
});

// Caps follow the camera range. Gain is ±200. Iris is 1..99. Detail is ±31.
// List controls (gain dB, shutter) stay small so a flick cannot skip the table.
const OVERRIDES = Object.freeze({
  iris: { maxMultiplier: 8, maxStepsPerEvent: 24 },
  gain: { maxMultiplier: 3, maxStepsPerEvent: 6 },
  rGain: { maxMultiplier: 16, maxStepsPerEvent: 48 },
  bGain: { maxMultiplier: 16, maxStepsPerEvent: 48 },
  masterPed: { maxMultiplier: 16, maxStepsPerEvent: 48 },
  pedestal: { maxMultiplier: 8, maxStepsPerEvent: 16 },
  rPed: { maxMultiplier: 12, maxStepsPerEvent: 36 },
  gPed: { maxMultiplier: 12, maxStepsPerEvent: 36 },
  bPed: { maxMultiplier: 12, maxStepsPerEvent: 36 },
  masterDetail: { maxMultiplier: 4, maxStepsPerEvent: 12 },
  gamma: { maxMultiplier: 6, maxStepsPerEvent: 16 },
  chromaLevel: { maxMultiplier: 8, maxStepsPerEvent: 24 },
  kneePoint: { maxMultiplier: 6, maxStepsPerEvent: 16 },
  pictureLevel: { maxMultiplier: 6, maxStepsPerEvent: 16 },
  zoomPos: { maxMultiplier: 4, maxStepsPerEvent: 12 },
  focusPos: { maxMultiplier: 4, maxStepsPerEvent: 12 },
  shutterStep: { maxMultiplier: 3, maxStepsPerEvent: 6 },
});

const VELOCITY_IDS = new Set(Object.keys(OVERRIDES));

// Long-press on a dial resets the active parameter. Short-press toggles the pair.
const LONG_PRESS_MS = 500;

// How long a paint command may wait so a burst becomes one Panasonic HTTP call.
const COALESCE_MS = 80;

// Hold-to-run pan, tilt, zoom, and focus. The first instant is a small
// fraction of the session speed, and that fine zone lasts `fineMs`. After
// that the speed eases in (exponent) and reaches the full session speed at
// `fullMs`. `tickMs` is how often a held key sends the new speed.
const HOLD = Object.freeze({
  startGain: 0.08,
  fineGain: 0.22,
  fineMs: 450,
  fullMs: 1600,
  exponent: 3,
  tickMs: 90,
});

// Parameters a long press may restore. Zoom and focus are not in this set:
// a midpoint jump in the middle of a shot is not a paint reset.
const RESETTABLE = new Set([
  'iris', 'gain', 'rGain', 'bGain', 'masterPed', 'pedestal', 'rPed', 'gPed', 'bPed',
  'masterDetail', 'gamma', 'chromaLevel', 'kneePoint', 'pictureLevel', 'shutterStep',
]);

function curveFor(opId) {
  return { ...ACCEL, ...(OVERRIDES[opId] || {}) };
}

function usesVelocity(opId) {
  return VELOCITY_IDS.has(String(opId || ''));
}

function multiplier(dtMs, ticks, cfg) {
  const abs = Math.max(1, Math.abs(Math.trunc(Number(ticks) || 1)));
  // null / undefined is a fresh detent with no clock yet: always one step.
  // A numeric 0 is two events in the same millisecond, which is a fast turn.
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

function stepsFor(opId, ticks, dtMs, cfg) {
  const n = Math.trunc(Number(ticks));
  if (!n) return 0;
  const curve = cfg || curveFor(opId);
  const sign = n < 0 ? -1 : 1;
  const abs = Math.abs(n);
  const mult = multiplier(dtMs, abs, curve);
  const raw = abs * mult;
  return sign * Math.max(curve.baseStep, Math.min(curve.maxStepsPerEvent, raw));
}

// 0 at the press, climbing to 1. Stays between startGain and fineGain for
// the whole fine zone, then ease-in to 1.
function holdGain(heldMs, cfg = HOLD) {
  const t = Number(heldMs);
  const ms = Number.isFinite(t) && t > 0 ? t : 0;
  const fineMs = Math.max(0, Number(cfg.fineMs) || 0);
  const start = Number(cfg.startGain);
  const fine = Number(cfg.fineGain);
  const full = Number(cfg.fullMs);
  const exponent = Number(cfg.exponent) || 1;
  if (ms <= fineMs) {
    const u = fineMs <= 0 ? 1 : ms / fineMs;
    return start + u * (fine - start);
  }
  const span = Math.max(1, (Number.isFinite(full) ? full : fineMs) - fineMs);
  const u = Math.max(0, Math.min(1, (ms - fineMs) / span));
  return fine + (u ** exponent) * (1 - fine);
}

// Signed camera speed (-49..49) for one axis. `dir` is -1, 0, or 1.
// The result is at least 1 whenever dir is not 0, and never above the
// session speed.
function velocityFor(dir, sessionSpeed, heldMs, cfg = HOLD) {
  const sign = Math.sign(Number(dir) || 0);
  if (!sign) return 0;
  const full = Math.max(1, Math.min(49, Math.round(Number(sessionSpeed) || 1)));
  const gain = Math.max(0, Math.min(1, holdGain(heldMs, cfg)));
  const mag = Math.max(1, Math.min(full, Math.round(full * gain)));
  return sign * mag;
}

function pressKind(heldMs, longPressMs = LONG_PRESS_MS) {
  const held = Number(heldMs);
  const limit = Number(longPressMs);
  if (!Number.isFinite(held) || held < 0) return 'toggle';
  return held >= (Number.isFinite(limit) ? limit : LONG_PRESS_MS) ? 'reset' : 'toggle';
}

module.exports = {
  ACCEL, OVERRIDES, HOLD, VELOCITY_IDS, LONG_PRESS_MS, COALESCE_MS, RESETTABLE,
  curveFor, usesVelocity, multiplier, stepsFor, holdGain, velocityFor, pressKind,
};
