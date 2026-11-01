'use strict';
// Velocity curve for paint dials. A slow detent is one native step. A fast
// turn grows on the quadratic curve and stops at that parameter's cap.
const test = require('node:test');
const assert = require('node:assert/strict');
const accel = require('../lib/paint-accel');

test('the slowest turn is exactly one native step, including the first detent and a gap', () => {
  assert.equal(accel.stepsFor('rGain', 1, null), 1);
  assert.equal(accel.stepsFor('rGain', 1, undefined), 1);
  assert.equal(accel.stepsFor('iris', -1, accel.ACCEL.slowMs), -1);
  assert.equal(accel.stepsFor('masterDetail', 1, accel.ACCEL.windowMs), 1);
  assert.equal(accel.stepsFor('bPed', 3, 5000), 3, 'three slow detents bundled in one event stay 1:1');
});

test('the curve is quadratic between the slow and fast windows, then hits the cap', () => {
  const gain = accel.curveFor('rGain');
  const midMs = (gain.slowMs + gain.fastMs) / 2;
  const mid = accel.multiplier(midMs, 1, gain);
  const expected = Math.round(gain.baseStep + (0.5 ** gain.exponent) * (gain.maxMultiplier - gain.baseStep));
  assert.equal(mid, expected);
  assert.ok(mid > gain.baseStep && mid < gain.maxMultiplier);
  assert.equal(accel.stepsFor('rGain', 1, gain.fastMs), gain.maxMultiplier);
  assert.equal(accel.stepsFor('rGain', -1, 10), -gain.maxMultiplier);
});

test('one fast event cannot jump a whole range, and iris is capped below gain', () => {
  const iris = accel.curveFor('iris');
  const gain = accel.curveFor('rGain');
  const detail = accel.curveFor('masterDetail');
  assert.ok(iris.maxMultiplier < gain.maxMultiplier);
  assert.ok(detail.maxMultiplier < iris.maxMultiplier);
  const burst = accel.stepsFor('iris', 30, iris.fastMs);
  assert.equal(burst, iris.maxStepsPerEvent);
  assert.ok(burst < 30 * iris.maxMultiplier);
  assert.ok(accel.stepsFor('gain', 8, 10) <= accel.curveFor('gain').maxStepsPerEvent);
});

test('overrides live in one table and unknown parameters stay on the base curve', () => {
  assert.equal(accel.OVERRIDES.rGain.maxMultiplier, accel.curveFor('rGain').maxMultiplier);
  assert.equal(accel.curveFor('notAPaint').maxMultiplier, accel.ACCEL.maxMultiplier);
  assert.equal(accel.usesVelocity('rGain'), true);
  assert.equal(accel.usesVelocity('zoomPos'), true);
  assert.equal(accel.usesVelocity('nope'), false);
});

test('dial press: under 500 ms toggles the pair, at 500 ms resets', () => {
  assert.equal(accel.LONG_PRESS_MS, 500);
  assert.equal(accel.pressKind(0), 'toggle');
  assert.equal(accel.pressKind(499), 'toggle');
  assert.equal(accel.pressKind(500), 'reset');
  assert.equal(accel.pressKind(800, 700), 'reset');
  assert.equal(accel.pressKind(600, 700), 'toggle');
});
