'use strict';
// One test per v0.4 acceptance criterion. The name starts with the story id.
// Implemented behavior is asserted. Unimplemented criteria are skipped with a note
// so they stay on the checklist and do not fail CI.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CueStack } = require('../lib/cues');
const { MasterCues } = require('../lib/master-cues');
const { AtemDesk } = require('../lib/atem-desk');
const { SystemManager } = require('../lib/systems');
const { libraryFor } = require('../lib/decks/pages');
const { SURFACES } = require('../lib/decks/surfaces');
const { setup, until } = require('./helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-story-'));

function stackWith(presets, { connected = true } = {}) {
  const engine = {
    connected,
    getState: () => ({ connected, presets }),
    recall: async (n, opts) => { engine.calls.push(['abs', n, opts && opts.autoTake]); },
    recallLayers: async (n) => { engine.calls.push(['rel', n]); },
    calls: [],
  };
  return { engine, stack: new CueStack({ engine }) };
}

test('A1 the Presets page shows connection status and a connect control', () => {
  const html = read('public/index.html');
  const js = read('public/looks.js');
  assert.match(html, /id="pane-looks"/);
  assert.match(js, /id="cueConnect"/);
  assert.match(js, /RECONNECT/);
  assert.match(js, /link\.state/);
  const off = new CueStack({}).link();
  assert.equal(off.connected, false);
  assert.equal(off.state, 'offline');
  const { stack } = stackWith([], { connected: true });
  assert.equal(stack.link().state, 'connected');
});

test('A1 the Systems tab and the Presets page share one connection state', async () => {
  const ctx = await setup({});
  try {
    const stack = new CueStack({ engine: ctx.engine });
    assert.equal(stack.link().connected, ctx.engine.getState().connected);
    assert.equal(stack.link().state, 'offline');
    await ctx.engine.connect();
    assert.equal(ctx.engine.getState().connected, true);
    assert.equal(stack.link().connected, true);
    assert.equal(stack.link().state, 'connected');
    assert.match(read('public/looks.js'), /\/api\/connect/);
    assert.match(read('public/sys.js'), /\/api\/connect|\/api\/sys\//);
  } finally { await ctx.teardown(); }
});

test('A1 ATEM is never a switcher choice on the Presets page', () => {
  const js = read('public/looks.js');
  assert.match(js, /\['rs6', 'RS6'\], \['e2', 'E2'\], \['pixelhue', 'PIXELHUE'\]/);
  assert.doesNotMatch(js, /\['atem'/);
  const stack = new CueStack({});
  assert.throws(() => stack.setSystem('atem'), /RS6, E2 or PixelHue/);
  const cue = stack.save({ name: 'No ATEM', steps: [{ system: 'atem', preset: '1' }, { system: 'rs6', preset: '3' }] });
  assert.deepEqual(cue.steps.map((s) => s.system), ['rs6']);
});

test('A2 connecting fills the cue editor pick list with preset names and operator numbers', async () => {
  const ctx = await setup({});
  try {
    await ctx.engine.connect();
    await ctx.engine.savePreset({ number: 4, name: 'IMAG', destinations: ['S1'], memories: { S1: 1 } });
    const stack = new CueStack({ engine: ctx.engine });
    const row = stack.catalog().rs6.find((p) => p.number === 4);
    assert.ok(row, 'preset 4 is in the catalog');
    assert.equal(row.label, '4 IMAG');
    assert.equal(row.id, '4');
  } finally { await ctx.teardown(); }
});

test('A2 pick lists show the operator-facing number and name, not an internal id', async () => {
  const ctx = await setup({});
  const systems = new SystemManager({ dataDir: ctx.dataDir, engine: ctx.engine });
  try {
    await systems.simulate('e2');
    const stack = new CueStack({ engine: { getState: () => ({ presets: [], connected: false }) }, systems });
    stack.setSystem('e2');
    const row = stack.catalog().e2.find((p) => p.name === 'Walk-in');
    assert.ok(row);
    assert.equal(row.label, `${row.number} ${row.name}`);
    assert.match(String(row.number), /^1(\.00)?$/);
    assert.equal(row.name, 'Walk-in');
    assert.notEqual(row.label, row.id);
    assert.match(String(row.id), /^e2:/);
    assert.doesNotMatch(row.label, /^e2:/);
  } finally { await systems.close(); await ctx.teardown(); }
});

test('A2 with no switcher and no simulator the editor says so instead of an empty dropdown', () => {
  const stack = new CueStack({});
  assert.equal(stack.link().connected, false);
  assert.equal(stack.catalog().e2.length, 0);
  const js = read('public/looks.js');
  assert.match(js, /No switcher connected\./);
  assert.match(js, /!connected && !rows\(\)\.length/);
});

test('A3 creating a stack requires choosing its switcher', { skip: 'The stack defaults to RS6. ADD CUE does not require an explicit switcher choice before the first cue is saved.' }, () => {});

test('A3 cues in a stack can only use presets from that stack\'s switcher', () => {
  const stack = new CueStack({});
  stack.setSystem('e2');
  const cue = stack.save({
    name: 'One switcher',
    steps: [
      { system: 'rs6', preset: '4' },
      { system: 'pixelhue', preset: 'ph:1' },
      { system: 'e2', preset: 'e2:1' },
    ],
  });
  assert.deepEqual(cue.steps.map((s) => [s.system, s.preset]), [['e2', 'e2:1']]);
  const dir = tmp();
  const again = new CueStack({ dataDir: dir });
  again.setSystem('pixelhue');
  again.save({ name: 'PH', steps: [{ system: 'pixelhue', preset: 'ph:2', mode: 'absolute' }] });
  const loaded = new CueStack({ dataDir: dir });
  assert.equal(loaded.system, 'pixelhue');
  assert.deepEqual(loaded.status().cues[0].steps.map((s) => s.system), ['pixelhue']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('A4 each cue is marked absolute or relative', () => {
  const { stack } = stackWith([]);
  const cue = stack.save({
    name: 'Marks',
    steps: [
      { system: 'rs6', preset: '4', mode: 'absolute' },
      { system: 'rs6', preset: '6', mode: 'relative' },
    ],
  });
  assert.deepEqual(cue.steps.map((s) => s.mode), ['absolute', 'relative']);
  assert.match(read('public/looks.js'), /ABSOLUTE/);
  assert.match(read('public/looks.js'), /RELATIVE/);
});

test('A4 a relative recall changes only the layers stored in that preset', async () => {
  const calls = [];
  const ctx = await setup({});
  try {
    await ctx.engine.connect();
    ctx.engine.presets = [{
      number: 6, name: 'IMAG on', destinations: ['S1', 'S2'], memories: { S1: 3, S2: 4 },
      sources: { S1: { layers: [{ layer: 2, sourceType: 'input', sourceId: 8 }] } },
    }];
    ctx.engine.device.writeSources = async (dest, snap, target) => { calls.push(['write', dest, snap.layers.map((l) => l.layer), target]); };
    ctx.engine.device.loadMemory = async () => { calls.push(['memory']); };
    ctx.engine.device.loadMaster = async () => { calls.push(['master']); };
    ctx.engine.device.take = async () => { calls.push(['take']); };
    ctx.engine.settings.autoTake = true;
    ctx.engine.selection = new Set(['S2']);
    const ok = await ctx.engine.recallLayers(6);
    assert.equal(ok.relative, true);
    assert.deepEqual(calls, [['write', 'S1', [2], 'preview']]);
    assert.ok(ctx.engine.selection.has('S2'), 'screens that are not in the relative preset stay selected');
    assert.ok(ctx.engine.selection.has('S1'));
  } finally { await ctx.teardown(); }
});

test('A4 relative never means step to the next preset number', async () => {
  const { engine, stack } = stackWith([{ number: 6, name: 'IMAG' }]);
  const cue = stack.save({
    name: 'Not next',
    steps: [
      { system: 'rs6', preset: '+2', mode: 'relative' },
      { system: 'rs6', preset: '6', mode: 'relative' },
    ],
  });
  assert.deepEqual(cue.steps.map((s) => s.preset), ['6']);
  await stack.go();
  assert.deepEqual(engine.calls, [['rel', 6]]);
  assert.ok(!engine.calls.some((c) => c[1] === 7 || c[1] === 8));
});

test('A5 every cue has an optional follow-up preset and a delay', () => {
  const dir = tmp();
  const stack = new CueStack({ dataDir: dir });
  const cue = stack.save({
    name: 'DSM',
    steps: [{ system: 'rs6', preset: '4', mode: 'relative' }],
    followUp: { preset: '8', delayMs: 500, mode: 'absolute' },
  });
  assert.equal(cue.followUp.preset, '8');
  assert.equal(cue.followUp.delayMs, 500);
  const none = stack.save({ id: cue.id, name: 'DSM', steps: cue.steps, followUp: null });
  assert.equal(none.followUp, null);
  const loaded = new CueStack({ dataDir: dir });
  assert.equal(loaded.status().cues.find((c) => c.id === cue.id).followUp, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('A5 the follow-up delay can be set in tenths of a second', () => {
  const stack = new CueStack({});
  const cue = stack.save({
    name: 'Tenths',
    steps: [{ system: 'rs6', preset: '4', mode: 'absolute' }],
    followUp: { preset: '8', delayMs: 1500 },
  });
  assert.equal(cue.followUp.delayMs, 1500);
  const rounded = stack.save({ id: cue.id, followUp: { preset: '8', delayMs: 250 } });
  assert.equal(rounded.followUp.delayMs, 300);
});

test('A5 STOP or BACK cancels a pending follow-up', async () => {
  const { engine, stack } = stackWith([], { connected: false });
  stack.save({ name: 'DSM', steps: [{ system: 'rs6', preset: '4', mode: 'absolute' }], followUp: { preset: '7', delayMs: 200 } });
  const running = stack.go();
  await sleep(30);
  stack.stop();
  await running;
  assert.deepEqual(engine.calls.map((c) => c[1]), [4]);
  engine.calls.length = 0;
  const again = stack.go();
  await sleep(30);
  stack.back();
  await again;
  assert.deepEqual(engine.calls.map((c) => c[1]), [4]);
});

test('A6 every cue has an optional bail look', () => {
  const stack = new CueStack({});
  const cue = stack.save({
    name: 'Safe',
    steps: [{ system: 'rs6', preset: '4', mode: 'relative' }],
    bail: { preset: '9' },
  });
  assert.equal(cue.bail.preset, '9');
  assert.equal(cue.bail.system, 'rs6');
  const cleared = stack.save({ id: cue.id, bail: null });
  assert.equal(cleared.bail, null);
});

test('A6 after the look is on program the bail loads to preview and is not taken', async () => {
  const ctx = await setup({});
  try {
    const e = ctx.engine;
    await e.connect();
    await e.savePreset({ number: 4, name: 'Look', destinations: ['S1'], memories: { S1: 1 } });
    await e.savePreset({ number: 9, name: 'Bail', destinations: ['S1'], memories: { S1: 3 } });
    e.setFollowUpDefaults({ delayMs: 40 });
    const stack = new CueStack({ dataDir: ctx.dataDir, engine: e });
    stack.save({ name: 'Go', steps: [{ system: 'rs6', preset: '4', mode: 'absolute' }], bail: { preset: '9' } });
    e.cueBail = (sys) => stack.consumeBail(sys);
    await stack.go();
    assert.equal(e.pvw.S1, 4);
    assert.notEqual(e.pgm.S1, 4);
    await e.take();
    await until(() => e.pvw.S1 === 9, 2000, 'bail on preview');
    assert.equal(e.pgm.S1, 4, 'bail is not taken');
  } finally { await ctx.teardown(); }
});

test('A6 the next TAKE puts the bail look on program', async () => {
  const ctx = await setup({});
  try {
    const e = ctx.engine;
    await e.connect();
    await e.savePreset({ number: 4, name: 'Look', destinations: ['S1'], memories: { S1: 1 } });
    await e.savePreset({ number: 9, name: 'Bail', destinations: ['S1'], memories: { S1: 3 } });
    e.setFollowUpDefaults({ delayMs: 40 });
    const stack = new CueStack({ dataDir: ctx.dataDir, engine: e });
    stack.save({ name: 'Go', steps: [{ system: 'rs6', preset: '4', mode: 'absolute' }], bail: { preset: '9' } });
    e.cueBail = (sys) => stack.consumeBail(sys);
    await stack.go();
    await e.take();
    await until(() => e.pvw.S1 === 9, 2000, 'bail waiting in preview');
    await e.take();
    assert.equal(e.pgm.S1, 9);
  } finally { await ctx.teardown(); }
});

test('A6 the cue bail replaces the separate switcher-page bail so there is only one bail setting', { skip: 'The switcher pages still have their own bail: #bailBadge, #btnFollowUp and #xBail. Cue bail overrides that path for one take, but the second setting is still on the page.' }, () => {});

test('A7 GO loads the cue look into preview', async () => {
  const ctx = await setup({});
  try {
    const e = ctx.engine;
    await e.connect();
    await e.savePreset({ number: 4, name: 'Look', destinations: ['S1'], memories: { S1: 1 } });
    const stack = new CueStack({ dataDir: ctx.dataDir, engine: e });
    stack.save({ name: 'Go', steps: [{ system: 'rs6', preset: '4', mode: 'absolute' }] });
    await stack.go();
    assert.equal(e.pvw.S1, 4);
    assert.notEqual(e.pgm.S1, 4);
  } finally { await ctx.teardown(); }
});

test('A7 the operator TAKE puts that look on program', async () => {
  const ctx = await setup({});
  try {
    const e = ctx.engine;
    await e.connect();
    await e.savePreset({ number: 4, name: 'Look', destinations: ['S1'], memories: { S1: 1 } });
    const stack = new CueStack({ dataDir: ctx.dataDir, engine: e });
    stack.save({ name: 'Go', steps: [{ system: 'rs6', preset: '4', mode: 'absolute' }] });
    await stack.go();
    await e.take();
    assert.equal(e.pgm.S1, 4);
  } finally { await ctx.teardown(); }
});

test('A7 auto-advance moves the stack and never takes to program by itself', async () => {
  const ctx = await setup({});
  try {
    const e = ctx.engine;
    await e.connect();
    await e.savePreset({ number: 1, name: 'A', destinations: ['S1'], memories: { S1: 1 } });
    await e.savePreset({ number: 2, name: 'B', destinations: ['S1'], memories: { S1: 2 } });
    const before = ctx.mock.history.length;
    const stack = new CueStack({ dataDir: ctx.dataDir, engine: e });
    stack.save({ name: 'A', advance: 'auto', steps: [{ system: 'rs6', preset: '1', mode: 'absolute' }] });
    stack.save({ name: 'B', advance: 'go', steps: [{ system: 'rs6', preset: '2', mode: 'absolute' }] });
    await stack.go();
    assert.equal(stack.index, 1);
    assert.equal(e.pvw.S1, 2);
    const takes = ctx.mock.history.slice(before).filter((h) => h.op === 'take' || (h.proto === 'state' && h.op === 'take'));
    assert.equal(takes.length, 0);
    assert.notEqual(e.pgm.S1, 2);
  } finally { await ctx.teardown(); }
});

test('A8 a cue whose preset is gone is flagged after refresh', () => {
  const presets = [{ number: 4, name: 'IMAG' }];
  const { stack } = stackWith(presets);
  stack.save({ name: 'Gone', steps: [{ system: 'rs6', preset: '4', mode: 'absolute' }] });
  assert.equal(stack.status().cues[0].invalid, false);
  presets.length = 0;
  const view = stack.status().cues[0];
  assert.equal(view.invalid, true);
  assert.equal(view.steps[0].invalid, true);
});

test('A8 GO is disabled for an invalid cue until the preset is picked again', async () => {
  const presets = [{ number: 4, name: 'IMAG' }];
  const { stack } = stackWith(presets);
  stack.save({ name: 'Gone', steps: [{ system: 'rs6', preset: '4', mode: 'absolute' }] });
  presets.length = 0;
  await assert.rejects(() => stack.go(), /invalid/);
  presets.push({ number: 4, name: 'IMAG' });
  await stack.go();
  assert.match(read('public/looks.js'), /go\.disabled = !!\(cue\(\) && cue\(\)\.invalid\)/);
});

test('A8 renaming a preset updates the cue label and does not invalidate it', () => {
  const presets = [{ number: 4, name: 'IMAG' }];
  const { stack } = stackWith(presets);
  stack.save({ name: 'Keep', steps: [{ system: 'rs6', preset: '4', mode: 'absolute' }] });
  presets[0].name = 'IMAG L';
  const view = stack.status().cues[0];
  assert.equal(view.invalid, false);
  assert.match(view.steps[0].label, /IMAG L/);
});

test('A9 an E2 or PixelHue simulator runs a cue stack end to end', async () => {
  const ctx = await setup({});
  const systems = new SystemManager({ dataDir: ctx.dataDir, engine: ctx.engine });
  try {
    await systems.simulate('e2');
    await systems.simulate('pixelhue');
    const stack = new CueStack({ engine: { getState: () => ({ presets: [], connected: false }), recall: async () => { throw new Error('rs6'); } }, systems });
    for (const sys of ['e2', 'pixelhue']) {
      stack.setSystem(sys);
      assert.equal(stack.link().connected, true);
      assert.equal(stack.link().simulator, true);
      const row = stack.catalog()[sys][0];
      assert.ok(row, `${sys} catalog is filled by the simulator`);
      stack.cues = [];
      stack.index = 0;
      stack.save({ name: 'Run', steps: [{ system: sys, preset: row.id, mode: 'absolute' }] });
      await stack.go();
      assert.equal(systems.tally[sys].last, row.id, `${sys} recalled the cue preset`);
      const onProgram = Object.values(systems.tally[sys].pgm || {});
      assert.ok(!onProgram.includes(row.id), `${sys} GO does not take the preset to program`);
    }
  } finally { await systems.close(); await ctx.teardown(); }
});

test('A9 RS6 has no simulator and the app says so', async () => {
  const dir = tmp();
  const systems = new SystemManager({ dataDir: dir, engine: { on() {}, log() {}, settings: {} } });
  try {
    await assert.rejects(() => systems.simulate('rs6'), /RS6 stays on its live connection/);
    const stack = new CueStack({});
    assert.equal(stack.link().rs6Simulator, false);
    assert.match(stack.link().note, /RS6 has no simulator/);
    assert.match(read('public/looks.js'), /RS6 has no simulator/);
  } finally { await systems.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('B1 each ATEM model family is tested on a real switcher before it is marked supported', { skip: 'Not implemented: catalogOps() sets tested:false on every action. Nothing in the app records a real-switcher test per model family.' }, () => {});

test('B1 a feature the model does not support is greyed out with a reason', () => {
  const desk = new AtemDesk({ systems: { drivers: { atem: { view() {
    return { macros: [], inputs: [], mes: [], topology: { superSources: 0, downstreamKeyers: 0 } };
  } } } } });
  const ops = desk.view().catalog;
  const ss = ops.find((op) => op.op === 'ssBox');
  const dsk = ops.find((op) => op.op === 'dskOnAir');
  assert.equal(ss.disabled, true);
  assert.match(ss.reason, /SuperSource/);
  assert.equal(dsk.disabled, true);
  assert.match(dsk.reason, /downstream key/);
  assert.match(read('public/atem-macros.js'), /op\.disabled \? 'disabled'/);
});

test('B2 connecting lists ATEM macro slots with their names', () => {
  const desk = new AtemDesk({ systems: { drivers: { atem: { view() {
    return { macros: [{ index: 2, isUsed: true, name: 'Opener roll', description: 'Walk' }], inputs: [], mes: [] };
  } } } } });
  desk.sync();
  const row = desk.view().macros.find((m) => m.index === 2);
  assert.equal(row.name, 'Opener roll');
  assert.equal(row.description, 'Walk');
  assert.equal(row.used, true);
});

test('B2 editing and saving writes the macro to its slot and reads it back', { skip: 'Not implemented: commit() returns uploaded:false and does not write the slot. The note in atem-desk.js says the protocol exposes names only (MPrp).' }, () => {});

test('B2 a backup of the slot is kept before every write', () => {
  const desk = new AtemDesk({});
  desk.saveMacro({ index: 1, name: 'First', note: 'save', steps: [{ op: 'cut', args: { me: 1 } }] });
  const commit = desk.commit(1);
  assert.equal(commit.backup, true);
  const row = desk.view().macros.find((m) => m.index === 1);
  assert.ok(row.backup);
  assert.equal(row.backup.name, 'First');
  assert.equal(row.backup.steps[0].op, 'cut');
});

test('B2 the app refuses to overwrite a macro it cannot read', () => {
  const desk = new AtemDesk({ systems: { drivers: { atem: { view() {
    return { macros: [{ index: 0, isUsed: true, name: 'Panel', description: '' }], inputs: [], mes: [] };
  } } } } });
  desk.sync();
  assert.equal(desk.view().macros[0].opaque, true);
  assert.throws(() => desk.saveMacro({ index: 0, name: 'Mine', steps: [{ op: 'cut', args: { me: 1 } }] }), /will not overwrite/);
  assert.throws(() => desk.commit(0), /will not overwrite/);
});

test('B3 the action list matches Blackmagic\'s groups', { skip: 'Not implemented: OPS in lib/atem-desk.js is a short subset (Mix Effects, Keys, Router, Super Source, Wait), not Blackmagic\'s full macro action groups.' }, () => {});

test('B3 steps show real source names from the connected switcher', () => {
  const desk = new AtemDesk({ systems: { drivers: { atem: { view() {
    return { macros: [], inputs: [{ id: 4, longName: 'Cam 2 Tight' }], mes: [] };
  } } } } });
  const input = desk.view().switcher.inputs.find((i) => i.id === 4);
  assert.equal(input.long, 'Cam 2 Tight');
  assert.match(read('public/atem-macros.js'), /sourceName\(s\.args\.source\)/);
});

test('B3 the simulator previews program and preview as the steps run', () => {
  const desk = new AtemDesk({});
  desk.saveMacro({ index: 3, name: 'Walk', steps: [{ op: 'preview', args: { source: 4, me: 1 } }, { op: 'cut', args: { me: 1 } }] });
  const sim = desk.simulate(3, 1);
  assert.equal(sim.mes[0].program, 4);
  assert.ok(sim.mes[0].preview !== undefined);
});

test('B4 a saved macro exists in Control Center and in its ATEM slot', { skip: 'The macro is stored in Control Center (atem-desk.json). commit() does not upload it into the ATEM macro slot.' }, () => {});

test('B4 memories are saved and recalled only from Control Center', async () => {
  const calls = [];
  const desk = new AtemDesk({ systems: { drivers: { atem: { view() {
    return { mes: [{ index: 0, program: 3, preview: 4, keyers: [] }], dsk: [], aux: [], superSources: [], macros: [], inputs: [] };
  } } }, atem: async (name, body) => { calls.push([name, body]); } } });
  const mem = desk.capture('Wide');
  assert.equal(desk.view().memories[0].name, 'Wide');
  assert.equal(desk.view().memories[0].id, mem.id);
  assert.doesNotMatch(desk.toXml(), /Wide/);
  await desk.recallMemory(mem.id);
  assert.ok(calls.some((c) => c[0] === 'program' && c[1].source === 3));
  assert.ok(!calls.some((c) => /macro/i.test(c[0])));
});

test('B5 each save creates a version with a time and a note', () => {
  const desk = new AtemDesk({});
  const row = desk.saveMacro({ index: 3, name: 'Walk', note: 'rehearsal', steps: [{ op: 'cut', args: { me: 1 } }] });
  assert.equal(row.versions.length, 1);
  assert.equal(row.versions[0].note, 'rehearsal');
  assert.ok(row.versions[0].at);
  assert.equal(row.versions[0].steps[0].op, 'cut');
});

test('B5 on connect a mismatched slot offers keep-switcher, keep-app, or merge side by side', { skip: 'sync() records a name conflict and the editor shows the two names with three choices. There is no side-by-side of the macro steps.' }, () => {});

test('B5 an earlier version can be restored and written to the switcher', { skip: 'restore() puts an older version back in Control Center. commit() still does not write that version to the ATEM slot.' }, () => {});

test('B6 import a Software Control XML into the library', () => {
  const desk = new AtemDesk({});
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Profile><MacroPool>
  <Macro index="4" name="Walk" description="in">
    <Op id="PreviewInput" mixEffectIndex="0" input="4"/>
    <Op id="CutTransition" mixEffectIndex="0"/>
  </Macro>
</MacroPool></Profile>`;
  const back = desk.fromXml(xml);
  assert.deepEqual(back.imported, [4]);
  const row = desk.view().macros.find((m) => m.index === 4);
  assert.equal(row.name, 'Walk');
  assert.equal(row.steps[0].op, 'preview');
  assert.equal(row.steps[0].args.source, 4);
  assert.equal(row.steps[1].op, 'cut');
});

test('B6 export a macros-only XML that Software Control can restore', { skip: 'toXml() writes a Control Center subset. GET /api/atem-desk/xml says it is not verified as an ATEM Software Control file.' }, () => {});

test('B7 no show-lock blocks writing a macro', () => {
  const desk = new AtemDesk({});
  desk.saveMacro({ index: 1, name: 'Live', steps: [{ op: 'cut', args: { me: 1 } }] });
  const commit = desk.commit(1);
  assert.equal(commit.showLock, false);
  assert.equal(desk.view().showLock, false);
});

test('B7 version history records every write', () => {
  const desk = new AtemDesk({});
  desk.saveMacro({ index: 1, name: 'Live', note: 'save', steps: [{ op: 'preview', args: { source: 2, me: 1 } }] });
  desk.commit(1);
  const notes = desk.view().macros.find((m) => m.index === 1).versions.map((v) => v.note);
  assert.deepEqual(notes, ['save', 'write']);
});

test('B8 start and stop recording on the switcher, then load that macro into the editor', { skip: 'macroRecord arms a slot and macroStopRecord disarms it. The recorded steps are not downloaded from the switcher into the editor.' }, () => {});

test('B8 record from the app into a new macro', () => {
  const desk = new AtemDesk({});
  const row = desk.addMacro({ name: 'From the app' });
  desk.arm(row.index);
  const noted = desk.note('preview', { source: 5, me: 1 });
  assert.equal(noted.op, 'preview');
  desk.disarm();
  const saved = desk.view().macros.find((m) => m.index === row.index);
  assert.equal(saved.steps.at(-1).op, 'preview');
  assert.equal(saved.steps.at(-1).args.source, 5);
  assert.equal(desk.view().recording, null);
});

test('F1 a shot macro stores camera, presets, move and the switcher input', { skip: 'Backlog. No shot-macro model is stored yet.' }, () => {});

test('F1 firing a shot macro snaps, moves, and takes the camera', { skip: 'Backlog. Nothing fires a PTZ move and a switcher take as one shot macro.' }, () => {});

test('C1 a Cues tab is always in the top navigation', () => {
  const html = read('public/index.html');
  assert.match(html, /data-tab="cues"[^>]*>CUES/);
  assert.match(html, /id="pane-cues"/);
  assert.match(html, /id="tabsTop"/);
});

test('C1 the first run seeds blank numbered cues', () => {
  const dir = tmp();
  const masters = new MasterCues({ dataDir: dir });
  const cues = masters.status().cues;
  assert.equal(cues.length, 8);
  assert.deepEqual(cues.map((c) => c.id), ['mc1', 'mc2', 'mc3', 'mc4', 'mc5', 'mc6', 'mc7', 'mc8']);
  assert.ok(cues.every((c) => c.actions.length === 0));
  assert.match(cues[0].name, /Cue 1/);
  const again = new MasterCues({ dataDir: dir });
  assert.equal(again.status().cues.length, 8);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('C1 a cue can be renamed, reordered, duplicated and cleared', () => {
  const masters = new MasterCues({});
  masters.save({ id: 'mc1', name: 'Open', actions: [{ type: 'atem-macro', macro: 1, offsetMs: 0 }] });
  assert.equal(masters.status().cues[0].name, 'Open');
  const copy = masters.duplicate('mc1');
  assert.match(copy.name, /copy/);
  assert.equal(copy.actions.length, 1);
  masters.reorder(['mc2', 'mc1']);
  assert.equal(masters.status().cues[0].id, 'mc2');
  const cleared = masters.clear('mc1');
  assert.deepEqual(cleared.actions, []);
});

test('C2 a cue holds ordered actions with time offsets', () => {
  const masters = new MasterCues({});
  masters.save({
    id: 'mc1',
    actions: [
      { type: 'hires', system: 'rs6', preset: '4', offsetMs: 0 },
      { type: 'atem-macro', macro: 2, offsetMs: 500 },
      { type: 'ptz', camera: 'cam1', preset: 3, offsetMs: 1200 },
    ],
  });
  const actions = masters.status().cues[0].actions;
  assert.deepEqual(actions.map((a) => a.offsetMs), [0, 500, 1200]);
  assert.deepEqual(actions.map((a) => a.type), ['hires', 'atem-macro', 'ptz']);
});

test('C2 firing runs actions on schedule and STOP cancels what has not fired', async () => {
  const calls = [];
  const masters = new MasterCues({ systems: { atem: async (name, body) => { calls.push([name, body.macro, Date.now()]); } } });
  masters.save({
    id: 'mc1',
    actions: [
      { type: 'atem-macro', macro: 1, offsetMs: 0 },
      { type: 'atem-macro', macro: 2, offsetMs: 400 },
    ],
  });
  masters.go('mc1');
  await sleep(40);
  masters.stop();
  await sleep(40);
  assert.deepEqual(calls.map((c) => c[1]), [1]);
});

test('C2 the running cue shows each action as pending, fired or failed', async () => {
  const masters = new MasterCues({
    systems: {
      atem: async () => { throw new Error('slot missing'); },
      ptz: async () => {},
    },
  });
  masters.save({
    id: 'mc1',
    actions: [
      { type: 'atem-macro', macro: 1, offsetMs: 0 },
      { type: 'ptz', camera: 'cam1', preset: 2, offsetMs: 400 },
    ],
  });
  masters.go('mc1');
  await sleep(40);
  let actions = masters.status().cues[0].actions;
  assert.equal(actions[0].state, 'failed');
  assert.equal(actions[1].state, 'pending');
  await sleep(450);
  actions = masters.status().cues[0].actions;
  assert.equal(actions[1].state, 'fired');
});

test('C3 each action names its device and the saved item', () => {
  const masters = new MasterCues({});
  masters.save({
    id: 'mc1',
    actions: [
      { type: 'hires', system: 'e2', preset: 'e2:4', offsetMs: 0 },
      { type: 'atem-macro', macro: 6, offsetMs: 0 },
      { type: 'ptz', camera: 'cam2', preset: 8, offsetMs: 0 },
    ],
  });
  const [hi, atem, ptz] = masters.status().cues[0].actions;
  assert.equal(hi.system, 'e2');
  assert.equal(hi.preset, 'e2:4');
  assert.equal(atem.macro, 6);
  assert.equal(ptz.camera, 'cam2');
  assert.equal(ptz.preset, 8);
});

test('C3 hi-res actions keep preview, relative, follow-up and bail behavior', async () => {
  const calls = [];
  const cues = { firePreset: async (body) => { calls.push(body); }, connected: () => false, known: () => true, catalog: () => ({ rs6: [], e2: [], pixelhue: [] }) };
  const masters = new MasterCues({ cues });
  masters.save({
    id: 'mc1',
    actions: [{
      type: 'hires', system: 'rs6', preset: '4', mode: 'relative', offsetMs: 0,
      followUp: { preset: '8', delayMs: 500 },
      bail: { preset: '9' },
    }],
  });
  masters.go('mc1');
  await sleep(30);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, 'relative');
  assert.equal(calls[0].preset, '4');
  assert.equal(calls[0].followUp.preset, '8');
  assert.equal(calls[0].followUp.delayMs, 500);
  assert.equal(calls[0].bail.preset, '9');
});

test('C3 a new action type can be added without redesigning the page', { skip: 'cleanAction() drops any type other than hires, atem-macro and ptz, so a new type does not survive a save.' }, () => {});

test('C3 one master cue can mix presets from more than one switcher', () => {
  const masters = new MasterCues({});
  masters.save({
    id: 'mc1',
    actions: [
      { type: 'hires', system: 'rs6', preset: '4', offsetMs: 0 },
      { type: 'hires', system: 'e2', preset: 'e2:2', offsetMs: 100 },
    ],
  });
  const systems = masters.status().cues[0].actions.map((a) => a.system);
  assert.deepEqual(systems, ['rs6', 'e2']);
});

test('C4 the palette is grouped by device and shows operator numbers and names', () => {
  const engine = { connected: true, getState: () => ({ connected: true, presets: [{ number: 4, name: 'IMAG' }] }) };
  const cues = new CueStack({ engine });
  const masters = new MasterCues({
    cues,
    atemDesk: { view: () => ({ macros: [{ index: 0, name: 'Opener' }] }) },
    systems: { view: () => ({ cameras: [{ id: 'cam1', name: 'Center' }] }) },
  });
  const groups = masters.palette();
  assert.deepEqual(groups.map((g) => g.device), ['rs6', 'e2', 'pixelhue', 'atem', 'ptz']);
  assert.equal(groups[0].items[0].label, '4 IMAG');
  assert.equal(groups[3].items[0].label, '1 Opener');
  assert.match(groups[4].items[0].label, /Center 1/);
  assert.match(read('public/cues-tab.js'), /mcSearch/);
});

test('C4 a dropped item becomes an action and the offset snaps to a tenth', () => {
  const masters = new MasterCues({});
  masters.save({ id: 'mc1', actions: [{ type: 'atem-macro', macro: 1, offsetMs: 250 }] });
  assert.equal(masters.status().cues[0].actions[0].offsetMs, 300);
  assert.match(read('public/cues-tab.js'), /\/ 100\) \* 100/);
  assert.match(read('public/cues-tab.js'), /dragover/);
});

test('C4 an action can be retimed, removed and edited', () => {
  const masters = new MasterCues({});
  masters.save({
    id: 'mc1',
    actions: [
      { id: 'a1', type: 'hires', system: 'rs6', preset: '4', mode: 'absolute', offsetMs: 0 },
      { id: 'a2', type: 'ptz', camera: 'cam1', preset: 1, offsetMs: 1000 },
    ],
  });
  masters.save({
    id: 'mc1',
    actions: [
      { id: 'a2', type: 'ptz', camera: 'cam1', preset: 1, offsetMs: 200 },
      { id: 'a1', type: 'hires', system: 'rs6', preset: '4', mode: 'relative', offsetMs: 0, followUp: { preset: '8', delayMs: 500 } },
    ],
  });
  const actions = masters.status().cues[0].actions;
  assert.deepEqual(actions.map((a) => a.id), ['a2', 'a1']);
  assert.equal(actions[1].mode, 'relative');
  assert.equal(actions[1].followUp.preset, '8');
  masters.save({ id: 'mc1', actions: actions.filter((a) => a.id !== 'a2').map(({ state, invalid, ...a }) => a) });
  assert.deepEqual(masters.status().cues[0].actions.map((a) => a.id), ['a1']);
});

test('C4 a missing item is invalid and the cue will not fire', async () => {
  const presets = [{ number: 4, name: 'IMAG' }];
  const engine = { connected: true, getState: () => ({ connected: true, presets }) };
  const cues = new CueStack({ engine });
  const masters = new MasterCues({ cues });
  masters.save({ id: 'mc1', actions: [{ type: 'hires', system: 'rs6', preset: '4', offsetMs: 0 }] });
  assert.equal(masters.status().cues[0].invalid, false);
  presets.length = 0;
  assert.equal(masters.status().cues[0].invalid, true);
  assert.equal(masters.status().cues[0].actions[0].invalid, true);
  assert.throws(() => masters.go('mc1'), /invalid/);
});

test('C5 master cues show up in the Stream Deck page library', () => {
  const pages = libraryFor({ armed: ['rs6'], byKey: { rs6: { host: '192.0.2.20', port: 80 } } }, SURFACES.xl);
  const cues = pages.find((p) => p.id === 'master-cues');
  assert.ok(cues);
  assert.ok(cues.keys.some((k) => k.action && k.action.path === '/api/master-cues/mc1/go'));
  assert.match(read('public/decks.js'), /decks|DECK|Control Devices|master-cues/);
});

test('C5 Steven confirms master cues on Stream Deck', { skip: 'Proposed. The story says Steven still has to confirm this surface.' }, () => {});
