'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planApply, applyPlan } = require('../lib/surfaces/live-apply');

test('a page edit is immediate: there is no SYNC step', () => {
  const plan = planApply({
    usb: { slot: 'r4c6', from: 'COMPARE', to: 'Preset recall' },
    companionPages: [{ id: 'ptz.rcp.exposure', title: 'PTZ · RCP · Exposure' }],
    existingCompanionPages: [{ name: 'Opener' }],
  });
  assert.equal(plan.immediate, true);
  assert.equal(plan.sync, false);
  assert.equal(plan.deferPageChange, false);
  assert.equal(plan.companion.pages[1].tag, 'cc:ptz.rcp.exposure');
  const painted = [];
  const out = applyPlan(plan, {
    paintUsb: (usb) => { painted.push(usb); return 'usb-ok'; },
    writeCompanion: (c) => { painted.push(c.pages.length); return 'cc-ok'; },
  });
  assert.equal(out.usb, 'usb-ok');
  assert.equal(out.companion, 'cc-ok');
  assert.equal(out.deferred, false);
});

test('a mid-gesture apply does not change the page, and a live camera is only a warning', () => {
  const plan = planApply({ midGesture: true, onProgram: true, usb: { slot: 'k1' } });
  assert.equal(plan.immediate, true);
  assert.equal(plan.deferPageChange, true);
  assert.ok(plan.warnings.some((w) => w.code === 'ON_PROGRAM'));
  assert.ok(plan.warnings.some((w) => w.code === 'MID_GESTURE'));
  let usb = 0;
  const out = applyPlan(plan, {
    paintUsb: () => { usb += 1; },
    paintValues: () => { usb += 10; },
  });
  assert.equal(out.deferred, true);
  assert.equal(usb, 10, 'values still update; the page is not swapped');
});
