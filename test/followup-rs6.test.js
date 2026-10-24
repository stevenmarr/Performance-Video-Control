'use strict';
// 0.11.0 RS6 auto recall / bail-out against the RS6 mock. Precedence: the preset's own setting, then its group, then
// the show default — all gated by the universal switch. After TAKE / CUT the bail target is recalled to Preview once
// the wait is over; it never takes; no self-loop; a manual recall cancels a pending one; kept in show files.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, until } = require('./helpers');
const FU = require('../lib/followup');
const shows = require('../lib/shows'); const { normalizePreset } = require('../lib/engine');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('followup.resolve: preset > group > default, universal switch, self-loop / missing = none', () => {
  const ex = () => true; const g = (o) => ({ id: 'g', name: 'Side', enabled: true, target: 0, presets: [], dests: [], ...o });
  const R = (cfg, p, own) => FU.resolve({ enabled: true, default: 0, groups: [], ...cfg }, p, own, ex);
  assert.deepEqual(R({ default: 9 }, { id: 1 }, null), { target: 9, source: 'default', group: null, reason: '' });
  assert.equal(R({ default: 9, groups: [g({ presets: [1], target: 5 })] }, { id: 1 }, null).target, 5, 'group beats default');
  assert.equal(R({ default: 9, groups: [g({ presets: [1], target: 5 })] }, { id: 1 }, { target: 7 }).target, 7, 'preset beats group');
  assert.equal(R({ default: 9, groups: [g({ dests: ['S2'], target: 5 })] }, { id: 1, dests: ['S2'] }, null).source, 'group', 'destination groups');
  assert.equal(R({ default: 9, groups: [g({ presets: [1], enabled: false, target: 5 })] }, { id: 1 }, null).target, 0, 'group off');
  assert.equal(R({ default: 9, groups: [g({ presets: [1], enabled: false })] }, { id: 1 }, { enabled: true }).target, 9, 'preset ON overrides an OFF group (falls through to default)');
  assert.equal(R({ default: 9 }, { id: 1 }, { enabled: false }).target, 0, 'preset off');
  assert.equal(R({ enabled: false, default: 9 }, { id: 1 }, { target: 3 }).target, 0, 'universal off gates everything');
  assert.equal(R({ default: 1 }, { id: 1 }, null).target, 0, 'no self-loop');
  assert.equal(FU.resolve({ enabled: true, default: 4, groups: [] }, { id: 1 }, null, () => false).target, 0, 'missing target');
  assert.deepEqual(FU.cleanOwn(0, true), { enabled: false }); assert.deepEqual(FU.cleanOwn(5, true), { target: 5 }); assert.equal(FU.cleanOwn({}, true), null);
});

test('RS6 auto recall: TAKE / CUT, preset / group / default precedence, switch, cancel, show round trip', async () => {
  const ctx = await setup({});
  const e = ctx.engine;
  try {
    await e.connect(); const S1 = 'S1';
    for (const n of [1, 2, 3, 4, 5]) await e.savePreset({ number: n, name: `P${n}`, destinations: [S1], memories: { [S1]: n } });
    e.setFollowUpDefaults({ delayMs: 60 });
    e.setFollowUp(1, { target: 2 });
    assert.throws(() => e.setFollowUp(3, { target: 3 }), /cannot follow itself/);
    assert.deepEqual(e.presetView(e.getPreset(1)).bail, { target: 2, source: 'preset', group: null, reason: '' });
    await e.recall(1); await e.take();
    assert.equal(e.pgm[S1], 1); assert.deepEqual(e.getState().followUp.pending.to, [2], 'pending while the transition runs');
    await until(() => e.pvw[S1] === 2, 2000, 'bail target 2 on Preview');
    assert.equal(e.pgm[S1], 1, 'auto recall never takes');
    // show default for presets with nothing of their own
    e.setFollowUpDefaults({ default: 4 });
    await e.take(); await until(() => e.pvw[S1] === 4, 2000, 'preset 2 → default 4');
    // group beats the default
    e.setFollowUpDefaults({ groups: [{ name: 'Walk', presets: [4], target: 5 }] });
    assert.equal(e.presetView(e.getPreset(4)).bail.source, 'group');
    await e.take(); await until(() => e.pvw[S1] === 5, 2000, 'preset 4 → its group target 5');
    // preset OFF overrides group / default
    e.setFollowUp(5, { enabled: false }); await e.take(); await sleep(150);
    assert.equal(e.pgm[S1], 5); assert.equal(e.getState().followUp.pending, null);
    // universal switch off: nothing at all
    e.setFollowUpDefaults({ enabled: false }); await e.recall(1); await e.take(); assert.equal(e.getState().followUp.pending, null, 'switch off');
    assert.equal(e.presetView(e.getPreset(1)).bail.reason, 'auto recall is off');
    e.setFollowUpDefaults({ enabled: true });
    // CUT also schedules; a manual recall during the wait cancels it
    await e.recall(1); await e.cut(); assert.ok(e.getState().followUp.pending);
    await e.recall(3); assert.equal(e.getState().followUp.pending, null, 'manual recall cancels');
    await sleep(150); assert.equal(e.pvw[S1], 3);
    // show files keep it; presets without one stay without the field
    const show = e.buildShow();
    assert.deepEqual(show.presets.find((p) => p.number === 1).followUp, { target: 2 });
    assert.equal(show.presets.find((p) => p.number === 2).followUp, undefined);
    assert.equal(show.settings.followUpDefault, 4); assert.equal(show.settings.followUpEnabled, true); assert.equal(show.settings.followUpGroups[0].target, 5);
    const back = shows.parseShow(JSON.stringify(show), { normalizePreset }).show;
    assert.deepEqual(back.presets.find((p) => p.number === 5).followUp, { enabled: false }); assert.deepEqual(back.settings.followUpGroups[0].presets, [4]);
    const old = JSON.parse(JSON.stringify(show)); for (const p of old.presets) delete p.followUp; for (const k of ['followUpDefault', 'followUpDelayMs', 'followUpEnabled', 'followUpGroups']) delete old.settings[k];
    const o = shows.parseShow(JSON.stringify(old), { normalizePreset }).show; assert.equal(o.presets[0].followUp, undefined, 'an older show opens without auto recall');
    // renumber keeps references (preset target, default, group members / target)
    e.editPreset(4, { newNumber: 44 }); assert.equal(e.settings.followUpDefault, 44); assert.deepEqual(e.followUpCfg().groups[0].presets, [44]);
    e.editPreset(2, { newNumber: 22 }); assert.equal(e.getPreset(1).followUp.target, 22);
  } finally { await ctx.teardown(); }
});
