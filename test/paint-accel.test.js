'use strict';
// Velocity curve for paint dials and pan/tilt/zoom/focus holds. A slow or
// moderate detent is one native step. A fast turn eases in and stops at
// that parameter's cap.
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

test('the curve eases in between the slow and fast windows, then hits the cap', () => {
  const gain = accel.curveFor('rGain');
  const midMs = (gain.slowMs + gain.fastMs) / 2;
  const mid = accel.multiplier(midMs, 1, gain);
  const expected = Math.round(gain.baseStep + (0.5 ** gain.exponent) * (gain.maxMultiplier - gain.baseStep));
  assert.equal(mid, expected);
  assert.equal(gain.exponent, 3, 'ease-in, not a straight line');
  assert.ok(mid > gain.baseStep && mid < gain.maxMultiplier / 2, 'the middle of the rate range is still in the fine half');
  assert.equal(accel.stepsFor('rGain', 1, gain.fastMs), gain.maxMultiplier);
  assert.equal(accel.stepsFor('rGain', -1, 10), -gain.maxMultiplier);
  assert.equal(accel.stepsFor('rGain', 1, 100), 1, 'a moderate turn stays at one step');
  const moderate = accel.multiplier(40, 1, gain);
  assert.ok(moderate < gain.maxMultiplier / 2, 'a fairly fast turn has not jumped to the coarse cap');
});

test('the fine zone and the ease-in can be replaced with another curve', () => {
  const zoom = accel.curveFor('zoomPos');
  const wider = { ...zoom, slowMs: 200 };
  assert.equal(accel.multiplier(120, 1, wider), wider.baseStep, '120 ms per detent is still fine on the wider curve');
  assert.ok(accel.multiplier(40, 1, zoom) > accel.multiplier(40, 1, { ...zoom, exponent: 5 }));
});

test('a held pan, tilt, zoom, or focus starts slow and eases up to the session speed', () => {
  const hold = accel.HOLD;
  assert.ok(accel.holdGain(0) < 0.15);
  assert.ok(accel.holdGain(hold.fineMs / 2) < hold.fineGain);
  assert.ok(accel.holdGain(hold.fineMs) <= hold.fineGain + 0.001);
  assert.ok(accel.holdGain(hold.fullMs) > 0.99);
  const early = accel.velocityFor(1, 25, 0);
  const mid = accel.velocityFor(1, 25, hold.fineMs);
  const late = accel.velocityFor(1, 25, hold.fullMs);
  assert.ok(early >= 1 && early <= 4, `first instant is a fine speed, got ${early}`);
  assert.ok(early < mid && mid < late);
  assert.equal(late, 25);
  const back = accel.velocityFor(-1, 15, 0);
  assert.ok(back <= -1 && back > -15);
  const custom = { ...hold, startGain: 0.5, fineGain: 0.5, fineMs: 10, fullMs: 10, exponent: 1 };
  assert.equal(accel.velocityFor(1, 20, 0, custom), 10);
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
