'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CueStack } = require('../lib/cues');
const { MasterCues, migrateTimes, clashMessage, moveAction, rowKey } = require('../lib/master-cues');
const { stampPage } = require('../lib/decks/pages');
const { AtemDesk } = require('../lib/atem-desk');
const { Engine } = require('../lib/engine');
const { libraryFor } = require('../lib/decks/pages');
const { SURFACES } = require('../lib/decks/surfaces');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('relative recall uses the named preset, not the next number', async () => {
  const calls = [];
  const engine = {
    recall: async (n, opts) => { calls.push(['abs', n, opts && opts.autoTake]); },
    recallLayers: async (n) => { calls.push(['rel', n]); },
  };
  const systems = { recall: async (sys, key, opts) => { calls.push([sys, key, opts]); } };
  const stack = new CueStack({ engine, systems });
  stack.setSystem('rs6');
  stack.save({
    name: 'Open',
    advance: 'go',
    steps: [
      { system: 'rs6', preset: '4', mode: 'absolute', lagMs: 0, atMs: 0 },
      { system: 'rs6', preset: '6', mode: 'relative', lagMs: 40, atMs: 0 },
      { system: 'e2', preset: 'e2:1', mode: 'absolute' },
      { system: 'atem', preset: '1', mode: 'absolute' },
      { system: 'rs6', preset: '+2', mode: 'relative' },
    ],
    bail: { system: 'rs6', preset: '9' },
    followUp: { preset: '8', delayMs: 100, mode: 'absolute' },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cues-'));
  const again = new CueStack({ dataDir: dir, engine, systems });
  again.save({ system: 'rs6' });
  again.save({
    name: 'Open',
    steps: [
      { system: 'rs6', preset: '4', mode: 'absolute', lagMs: 0 },
      { system: 'rs6', preset: '6', mode: 'relative', lagMs: 40 },
    ],
    bail: { preset: '9' },
  });
  const reloaded = new CueStack({ dataDir: dir, engine, systems });
  assert.equal(reloaded.status().cues[0].name, 'Open');
  assert.equal(reloaded.system, 'rs6');
  await reloaded.go();
  assert.deepEqual(calls.map((c) => [c[0], c[1]]), [['abs', 4], ['rel', 6]]);
  assert.equal(calls[0][2], false, 'GO does not auto-take');
  assert.equal(reloaded.pendingBail.preset, '9');
  assert.equal(reloaded.consumeBail('rs6').preset, '9');
  assert.equal(reloaded.pendingBail, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a relative step trails on lag and E2 recalls that exact preset to preview', async () => {
  const calls = [];
  const engine = { recall: async () => { throw new Error('rs6'); }, recallLayers: async () => { throw new Error('rs6'); } };
  const systems = { recall: async (sys, key, opts) => { calls.push([sys, key, opts.target, opts.autoTake, Date.now()]); } };
  const stack = new CueStack({ engine, systems });
  stack.setSystem('e2');
  stack.save({
    name: 'IMAG',
    steps: [
      { system: 'e2', preset: 'e2:4', mode: 'absolute', lagMs: 0 },
      { system: 'e2', preset: 'e2:4', mode: 'relative', lagMs: 40 },
    ],
  });
  const t0 = Date.now();
  await stack.go();
  assert.deepEqual(calls.map((c) => c.slice(0, 4)), [
    ['e2', 'e2:4', 'preview', false],
    ['e2', 'e2:4', 'preview', false],
  ]);
  assert.ok(calls[1][4] - t0 >= 30);
  assert.notEqual(calls[1][1], 'e2:5');
});

test('follow-up waits, and STOP or BACK cancels it', async () => {
  const calls = [];
  const engine = { recall: async (n) => { calls.push(n); } };
  const stack = new CueStack({ engine });
  stack.save({ name: 'DSM', steps: [{ system: 'rs6', preset: '4', mode: 'absolute' }], followUp: { preset: '7', delayMs: 200 } });
  const running = stack.go();
  await sleep(30);
  stack.stop();
  await running;
  assert.deepEqual(calls, [4]);
  calls.length = 0;
  const again = stack.go();
  await sleep(30);
  stack.back();
  await again;
  assert.deepEqual(calls, [4]);
  calls.length = 0;
  await stack.go();
  assert.deepEqual(calls, [4, 7]);
});

test('an invalid cue cannot GO, and a rename does not invalidate it', async () => {
  const presets = [{ number: 4, name: 'IMAG' }];
  const engine = {
    connected: true,
    getState: () => ({ connected: true, presets }),
    recall: async () => {},
  };
  const stack = new CueStack({ engine });
  stack.save({ name: 'Gone', steps: [{ system: 'rs6', preset: '4', mode: 'absolute' }] });
  presets[0].name = 'IMAG L';
  assert.equal(stack.status().cues[0].invalid, false);
  assert.match(stack.status().cues[0].steps[0].label, /IMAG L/);
  presets.length = 0;
  assert.equal(stack.status().cues[0].invalid, true);
  await assert.rejects(() => stack.go(), /invalid/);
  engine.connected = false;
  engine.getState = () => ({ connected: false, presets: [] });
  assert.equal(stack.status().cues[0].invalid, false);
});

test('auto-advance fires the next cue only when this one is set to auto', async () => {
  const calls = [];
  const engine = { recall: async (n) => { calls.push(n); } };
  const stack = new CueStack({ engine, systems: { recall: async () => {} } });
  stack.save({ name: 'A', advance: 'auto', steps: [{ system: 'rs6', preset: '1', mode: 'absolute' }] });
  stack.save({ name: 'B', advance: 'go', steps: [{ system: 'rs6', preset: '2', mode: 'absolute' }] });
  stack.save({ name: 'C', advance: 'auto', steps: [{ system: 'rs6', preset: '3', mode: 'absolute' }] });
  await stack.go();
  assert.deepEqual(calls, [1, 2]);
  assert.equal(stack.index, 1);
});

test('ATEM is refused as a hi-res cue step', () => {
  const stack = new CueStack({});
  const cue = stack.save({ name: 'No', steps: [{ system: 'atem', preset: '1', mode: 'absolute' }, { system: 'rs6', preset: '3', mode: 'absolute' }] });
  assert.deepEqual(cue.steps.map((s) => s.system), ['rs6']);
});

test('RS6 relative recall writes stored layers and does not take or load a screen memory', async () => {
  const calls = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-'));
  const engine = new Engine({ dataDir: dir });
  engine.device = {
    writeSources: async (d, snap, target) => { calls.push(['write', d, snap.layers.map((l) => l.layer), target]); },
    loadMemory: async () => { calls.push(['memory']); },
    loadMaster: async () => { calls.push(['master']); },
    take: async () => { calls.push(['take']); },
    close() {},
  };
  engine.presets = [{
    number: 4, name: 'IMAG', destinations: ['S1', 'S2'], memories: { S1: 3 },
    sources: { S1: { layers: [{ layer: 3, sourceType: 'input', sourceId: 8 }] } },
  }];
  engine.settings.autoTake = true;
  engine.selection = new Set(['S2']);
  const ok = await engine.recallLayers(4);
  assert.equal(ok.relative, true);
  assert.deepEqual(calls, [['write', 'S1', [3], 'preview']]);
  assert.ok(engine.selection.has('S2'));
  assert.ok(engine.selection.has('S1'));
  engine.presets[0].sources = {};
  await assert.rejects(() => engine.recallLayers(4), /layer snapshot/);
  engine.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cue bail replaces the switcher-page bail for that take and is not taken', async () => {
  const { setup, until } = require('./helpers');
  const ctx = await setup({});
  try {
    const e = ctx.engine;
    await e.connect();
    await e.savePreset({ number: 4, name: 'Look', destinations: ['S1'], memories: { S1: 1 } });
    await e.savePreset({ number: 2, name: 'Page bail', destinations: ['S1'], memories: { S1: 2 } });
    await e.savePreset({ number: 9, name: 'Cue bail', destinations: ['S1'], memories: { S1: 3 } });
    e.setFollowUpDefaults({ delayMs: 40 });
    e.setFollowUp(4, { target: 2 });
    let armed = { system: 'rs6', preset: '9' };
    e.cueBail = () => { const b = armed; armed = null; return b; };
    await e.recall(4);
    await e.take();
    await until(() => e.pvw.S1 === 9, 2000, 'cue bail on preview');
    assert.equal(e.pgm.S1, 4);
    assert.notEqual(e.pvw.S1, 2);
  } finally { await ctx.teardown(); }
});

test('the editor refuses to overwrite an ATEM macro it cannot read', () => {
  const desk = new AtemDesk({ systems: { drivers: { atem: { view() {
    return { macros: [{ index: 0, isUsed: true, name: 'Panel', description: '' }], macroRun: null, inputs: [], mes: [], topology: { superSources: 0, downstreamKeyers: 1 } };
  } } } } });
  desk.sync();
  const row = desk.view().macros.find((m) => m.index === 0);
  assert.equal(row.opaque, true);
  assert.throws(() => desk.saveMacro({ index: 0, name: 'Mine', steps: [{ op: 'cut', args: { me: 1 } }] }), /will not overwrite/);
  assert.throws(() => desk.commit(0), /will not overwrite/);
  const ss = desk.view().catalog.find((op) => op.op === 'ssBox');
  assert.equal(ss.disabled, true);
  assert.match(ss.reason, /SuperSource/);
  assert.equal(desk.view().showLock, false);
});

test('app-authored macros keep versions and a subset XML round trip', () => {
  const desk = new AtemDesk({});
  const row = desk.saveMacro({ index: 3, name: 'Walk', note: 'first', steps: [{ op: 'preview', args: { source: 4, me: 1 } }, { op: 'cut', args: { me: 1 } }] });
  assert.equal(row.versions.length, 1);
  assert.equal(row.versions[0].note, 'first');
  const xml = desk.toXml();
  assert.match(xml, /PreviewInput/);
  assert.match(xml, /MacroPool/);
  const other = new AtemDesk({});
  const back = other.fromXml(xml);
  assert.deepEqual(back.imported, [3]);
  assert.equal(other.view().macros.find((m) => m.index === 3).steps[0].op, 'preview');
  const commit = desk.commit(3);
  assert.equal(commit.uploaded, false);
  assert.equal(commit.backup, true);
  assert.match(commit.reason, /MPrp/);
});

test('a master cue mixes hi-res, ATEM and PTZ, and STOP cancels what is still waiting', async () => {
  const calls = [];
  const engine = { recall: async (n) => calls.push(['abs', n]), recallLayers: async (n) => calls.push(['rel', n]) };
  const systems = {
    atem: async (name, body) => { calls.push([name, body.macro]); },
    ptz: async (name, body) => { calls.push([name, body.cam, body.preset]); },
    view() { return { cameras: [{ id: 'cam1', name: 'Center' }] }; },
  };
  const stack = new CueStack({ engine, systems });
  const masters = new MasterCues({ cues: stack, systems });
  assert.equal(masters.status().cues.length, 8);
  assert.equal(masters.status().cues[0].id, 'mc1');
  masters.save({
    id: 'mc1',
    name: 'Open',
    actions: [
      { type: 'hires', system: 'rs6', preset: '4', mode: 'relative', offsetMs: 0 },
      { type: 'atem-macro', macro: 2, offsetMs: 0 },
      { type: 'ptz', camera: 'cam1', preset: 3, offsetMs: 400 },
    ],
  });
  const early = masters.go('mc1');
  masters.stop();
  await sleep(20);
  assert.ok(!calls.some((c) => c[0] === 'recall'));
  void early;
  calls.length = 0;
  masters.go('mc1');
  await sleep(80);
  assert.deepEqual(calls.filter((c) => c[0] !== 'recall').sort(), [['macroRun', 2], ['rel', 4]].sort());
  await sleep(450);
  assert.ok(calls.some((c) => c[0] === 'recall' && c[1] === 'cam1' && c[2] === 3));
  const pages = libraryFor({ armed: ['rs6'], byKey: { rs6: { host: '192.0.2.20', port: 80 } } }, SURFACES.xl);
  const cues = pages.find((p) => p.id === 'master-cues');
  assert.ok(cues);
  assert.ok(cues.keys.some((k) => k.action && k.action.path === '/api/master-cues/mc1/go'));
});

test('a second GO while a hi-res cue is running is locked and does not double-fire', async () => {
  const calls = [];
  const engine = { recall: async (n) => { calls.push(n); await sleep(40); } };
  const stack = new CueStack({ engine });
  stack.save({ name: 'A', steps: [{ system: 'rs6', preset: '4', mode: 'absolute' }], followUp: { preset: '5', delayMs: 0 } });
  const first = stack.go();
  const second = await stack.go();
  assert.equal(second.ignored, true);
  assert.equal(second.locked, true);
  assert.equal(second.runState, 'running');
  await first;
  assert.deepEqual(calls, [4, 5]);
  assert.equal(stack.machine.state, 'idle');
});

test('a new hi-res GO drops a bail the previous cue left behind', async () => {
  const engine = { recall: async () => {} };
  const stack = new CueStack({ engine });
  stack.save({ name: 'A', steps: [{ system: 'rs6', preset: '1', mode: 'absolute' }], bail: { preset: '9' } });
  stack.save({ name: 'B', steps: [{ system: 'rs6', preset: '2', mode: 'absolute' }] });
  await stack.go();
  assert.equal(stack.pendingBail.preset, '9');
  stack.select(1);
  await stack.go();
  assert.equal(stack.pendingBail, null);
  assert.equal(stack.lastPreset.rs6, '2');
});

test('an external take cancels a hi-res timeline that is still running', async () => {
  const calls = [];
  const engine = { recall: async (n) => { calls.push(n); } };
  const stack = new CueStack({ engine });
  stack.save({ name: 'A', steps: [{ system: 'rs6', preset: '4', mode: 'absolute' }], followUp: { preset: '7', delayMs: 200 }, bail: { preset: '9' } });
  const running = stack.go();
  await sleep(20);
  stack.externalTake('rs6');
  await running;
  assert.deepEqual(calls, [4]);
  assert.equal(stack.machine.state, 'idle');
  assert.equal(stack.pendingBail, null);
});

function masterFixture() {
  const calls = [];
  const engine = { recall: async (n) => calls.push(['abs', n]), recallLayers: async (n) => calls.push(['rel', n]) };
  const systems = {
    atem: async (name, body) => { calls.push([name, body.macro]); },
    ptz: async (name, body) => { calls.push([name, body.cam, body.preset]); },
    view() { return { cameras: [{ id: 'cam1', name: 'Center' }] }; },
  };
  const stack = new CueStack({ engine, systems });
  const masters = new MasterCues({ cues: stack, systems });
  return { calls, masters, stack };
}

test('RUN CUE locks, does not double-fire, and leaves running when the timeline ends', async () => {
  const { calls, masters } = masterFixture();
  masters.save({ id: 'mc1', name: 'Open', goMs: 0, actions: [{ type: 'atem-macro', macro: 2, offsetMs: 0 }] });
  masters.load('mc1');
  const first = masters.run();
  const second = masters.go('mc1');
  assert.equal(first.machine.state, 'running');
  assert.equal(first.machine.locked, true);
  assert.equal(second.ignored, true);
  assert.equal(second.locked, true);
  assert.equal(second.machine.generation, first.machine.generation);
  await sleep(40);
  assert.deepEqual(calls, [['macroRun', 2]]);
  assert.equal(masters.machine.state, 'idle');
  assert.equal(masters.status().running, null);
  assert.equal(masters.machine.cueId, null);
});

test('stacked cues load the next assigned cue, and off leaves nothing loaded', async () => {
  const { calls, masters } = masterFixture();
  masters.save({ id: 'mc1', name: 'A', goMs: 0, actions: [{ type: 'atem-macro', macro: 1, offsetMs: 0 }] });
  masters.save({ id: 'mc3', name: 'C', goMs: 0, actions: [{ type: 'atem-macro', macro: 3, offsetMs: 0 }] });
  masters.setStacked({ on: true });
  masters.go('mc1');
  await sleep(40);
  assert.deepEqual(calls, [['macroRun', 1]]);
  assert.equal(masters.machine.state, 'loaded');
  assert.equal(masters.machine.cueId, 'mc3');
  assert.equal(masters.machine.locked, false);
  masters.setStacked({ on: false });
  masters.run();
  await sleep(40);
  assert.deepEqual(calls, [['macroRun', 1], ['macroRun', 3]]);
  assert.equal(masters.machine.state, 'idle');
  assert.equal(masters.machine.cueId, null);
});

test('an external preset take unloads the cue and cancels the rest of the timeline', async () => {
  const { calls, masters } = masterFixture();
  masters.save({
    id: 'mc1', name: 'Open', goMs: 1000,
    actions: [
      { type: 'atem-macro', macro: 1, step: 0, section: 'take', offsetMs: 0 },
      { type: 'ptz', camera: 'cam1', preset: 3, step: 0, section: 'take', offsetMs: 400 },
    ],
  });
  masters.load('mc1');
  masters.go('mc1');
  await sleep(30);
  masters.externalTake('rs6');
  await sleep(50);
  assert.equal(masters.machine.state, 'idle');
  assert.equal(masters.machine.cueId, null);
  assert.equal(masters.status().running, null);
  assert.ok(calls.some((c) => c[0] === 'macroRun'));
  assert.ok(!calls.some((c) => c[0] === 'recall'));
  assert.equal(masters.cues.pendingBail, null);
});

test('a failed action fails the cue, skips the rest, and ack returns to loaded', async () => {
  const { calls, masters } = masterFixture();
  masters.systems.atem = async () => { throw new Error('macro missing'); };
  masters.save({
    id: 'mc1', name: 'Bad', goMs: 0,
    actions: [
      { type: 'atem-macro', macro: 1, offsetMs: 0 },
      { type: 'ptz', camera: 'cam1', preset: 2, offsetMs: 200 },
    ],
  });
  masters.go('mc1');
  await sleep(40);
  assert.equal(masters.machine.state, 'failed');
  assert.match(masters.machine.error, /macro missing/);
  assert.equal(masters.status().running, null);
  assert.ok(!calls.some((c) => c[0] === 'recall'));
  const again = masters.go('mc1');
  assert.equal(again.ignored, true);
  assert.equal(masters.machine.state, 'failed');
  const acked = masters.ack();
  assert.equal(acked.machine.state, 'loaded');
  assert.equal(acked.machine.cueId, 'mc1');
  assert.equal(acked.machine.error, null);
});

test('old master cue files load as TAKE actions and keep their offsets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-old-'));
  fs.writeFileSync(path.join(dir, 'master-cues.json'), JSON.stringify({
    cues: [{ id: 'mc1', name: 'Legacy', actions: [{ id: 'a1', type: 'atem-macro', macro: 4, offsetMs: 200 }] }],
  }));
  const masters = new MasterCues({ dataDir: dir });
  const cue = masters.status().cues[0];
  assert.equal(cue.name, 'Legacy');
  assert.equal(cue.actions[0].section, 'take');
  assert.equal(cue.actions[0].step, 0);
  assert.equal(cue.actions[0].atMs, 200);
  assert.equal(cue.actions[0].offsetMs, 0);
  assert.equal(masters.stacked, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('deck cue keys show the machine state and still GO that cue', () => {
  const { masters } = masterFixture();
  masters.save({ id: 'mc1', goMs: 0, actions: [{ type: 'atem-macro', macro: 1, offsetMs: 0 }] });
  masters.load('mc1');
  const page = stampPage({
    id: 'master-cues', system: 'cues', title: 'CUES', keys: [
      { label: 'C1', value: 'GO', action: { method: 'POST', path: '/api/master-cues/mc1/go', body: {} } },
      { label: 'C2', value: 'GO', action: { method: 'POST', path: '/api/master-cues/mc2/go', body: {} } },
    ],
  }, { cues: masters.feedback() });
  assert.equal(page.keys[0].cueState, 'loaded');
  assert.equal(page.keys[0].value, 'LOADED');
  assert.equal(page.keys[0].action.path, '/api/master-cues/mc1/go');
  assert.equal(page.keys[1].cueState, 'idle');
  assert.equal(page.keys[1].value, 'IDLE');
});

test('timeline steps stack across rows, reject a same-row clash, and keep an offset', () => {
  const rows = migrateTimes([
    { id: 'a', type: 'hires', system: 'rs6', preset: '1', section: 'take', atMs: 0 },
    { id: 'b', type: 'atem-macro', macro: 1, section: 'take', atMs: 40 },
    { id: 'c', type: 'hires', system: 'rs6', preset: '2', section: 'take', atMs: 40 },
    { id: 'd', type: 'ptz', camera: 'cam1', preset: 1, section: 'post', atMs: 0 },
  ]);
  assert.equal(rows.find((a) => a.id === 'a').step, 0);
  assert.equal(rows.find((a) => a.id === 'b').step, 0);
  assert.equal(rows.find((a) => a.id === 'b').offsetMs, 40);
  assert.equal(rows.find((a) => a.id === 'c').step, 1);
  assert.equal(rows.find((a) => a.id === 'd').section, 'post');
  assert.match(clashMessage([
    { id: 'a', type: 'hires', system: 'rs6', section: 'take', step: 0 },
    { id: 'c', type: 'hires', system: 'rs6', section: 'take', step: 0 },
  ]), /RS6/);
  assert.equal(clashMessage([
    { id: 'a', type: 'hires', system: 'rs6', section: 'take', step: 0 },
    { id: 'b', type: 'atem-macro', section: 'take', step: 0 },
  ]), '');
  const moved = moveAction(rows, 'c', { section: 'take', step: 2, insert: true });
  assert.equal(moved.error, null);
  assert.ok(moved.actions.every((a, i, list) => list.filter((b) => b.section === a.section).some((b) => b.step === 0)));
  const blocked = moveAction(rows, 'c', { section: 'take', step: 0 });
  assert.match(blocked.error, /RS6/);
  assert.equal(rowKey({ type: 'hires', system: 'rs6' }, { rs6: ['desk-1'] }), 'desk-1');
  assert.equal(rowKey({ type: 'hires', system: 'rs6', instance: 'desk-2' }, { rs6: ['desk-1', 'desk-2'] }), 'desk-2');
  assert.equal(rowKey({ type: 'atem-macro' }, {}), 'atem');
});

test('post-take waits until the take step has fired', async () => {
  const { calls, masters } = masterFixture();
  masters.save({
    id: 'mc1', name: 'Split', goMs: 0,
    actions: [
      { type: 'atem-macro', macro: 1, step: 0, section: 'take', offsetMs: 0 },
      { type: 'ptz', camera: 'cam1', preset: 4, step: 0, section: 'take', offsetMs: 80 },
      { type: 'atem-macro', macro: 2, step: 0, section: 'post', offsetMs: 0 },
    ],
  });
  masters.go('mc1');
  await sleep(30);
  assert.deepEqual(calls.map((c) => c[1]), [1]);
  await sleep(90);
  assert.equal(calls[0][1], 1);
  assert.equal(calls[1][0], 'recall');
  assert.equal(calls[1][2], 4);
  assert.equal(calls[2][1], 2);
  assert.notEqual(masters.machine.state, 'running');
});
