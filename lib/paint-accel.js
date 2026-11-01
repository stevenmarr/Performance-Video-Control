'use strict';
// Velocity curve for Stream Deck + / + XL paint dials.
// One detent at a slow turn is exactly one native camera step. A faster turn
// raises a step multiplier on a quadratic curve, capped so one flick cannot
// cross a whole paint range. Tune the numbers in this file.
//
// Speed is detents per unit time: `dtMs` is the gap since the previous
// dialRotate (or USB rotate) for that dial, and `ticks` is how many detents
// that event bundled. The first event, or a gap longer than `windowMs`, is a
// fresh slow turn.

const ACCEL = Object.freeze({
  baseStep: 1,
  exponent: 2,
  maxMultiplier: 12,
  slowMs: 160,
  fastMs: 28,
  windowMs: 450,
  maxStepsPerEvent: 48,
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
  zoomPos: { maxMultiplier: 10, maxStepsPerEvent: 30 },
  focusPos: { maxMultiplier: 10, maxStepsPerEvent: 30 },
  shutterStep: { maxMultiplier: 3, maxStepsPerEvent: 6 },
});

const VELOCITY_IDS = new Set(Object.keys(OVERRIDES));

// Long-press on a dial resets the active parameter. Short-press toggles the pair.
const LONG_PRESS_MS = 500;

// How long a paint command may wait so a burst becomes one Panasonic HTTP call.
const COALESCE_MS = 80;

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

function stepsFor(opId, ticks, dtMs) {
  const n = Math.trunc(Number(ticks));
  if (!n) return 0;
  const cfg = curveFor(opId);
  const sign = n < 0 ? -1 : 1;
  const abs = Math.abs(n);
  const mult = multiplier(dtMs, abs, cfg);
  const raw = abs * mult;
  return sign * Math.max(cfg.baseStep, Math.min(cfg.maxStepsPerEvent, raw));
}

function pressKind(heldMs, longPressMs = LONG_PRESS_MS) {
  const held = Number(heldMs);
  const limit = Number(longPressMs);
  if (!Number.isFinite(held) || held < 0) return 'toggle';
  return held >= (Number.isFinite(limit) ? limit : LONG_PRESS_MS) ? 'reset' : 'toggle';
}

module.exports = {
  ACCEL, OVERRIDES, VELOCITY_IDS, LONG_PRESS_MS, COALESCE_MS, RESETTABLE,
  curveFor, usesVelocity, multiplier, stepsFor, pressKind,
};
