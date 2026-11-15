'use strict';
// E2 program tally is one preset (the last taken, or recalled straight to program), and a preview recall arms
// that preset's own destinations (listPresets / listDestinationsForPreset ScreenDest + AuxDest) in the
// destination row and on the Stream Deck until the next recall or TAKE. Mock E2 only; no device is contacted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SystemManager } = require('../lib/systems');
const { MockE2 } = require('../lib/mocks/e2');
const { show, applySwitcherDestinations } = require('../lib/decks/faces');
const { SURFACES } = require('../lib/decks/surfaces');

function fakeEngine() {
  return { settings: { host: '192.0.2.10', restPort: 80, awjPort: 10600, protocol: 'rest' }, presets: [], destinations: [], live: { inputs: {} }, log() {}, changed() {} };
}
async function liveE2() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2pa-'));
  const mock = new MockE2(); const port = await mock.start(0);
  const sm = new SystemManager({ dataDir: dir, engine: fakeEngine(), overrides: { e2: { host: '127.0.0.1', port } }, autoStart: false });
  await sm.setActive('e2'); await sm.connect('e2');
  return { mock, sm, async stop() { await sm.close(); await mock.stop(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const onPgm = (v) => v.presets.filter((p) => p.tally.pgm !== 'none').map((p) => p.key);
const onPvw = (v) => v.presets.filter((p) => p.tally.pvw !== 'none').map((p) => p.key);
const armed = (v) => v.destinations.filter((d) => d.armed).map((d) => d.key);
const desk = (view) => ({ armed: ['e2'], byKey: { e2: { short: 'E2', view } } });
const tone = (face, n) => { const k = face.keys.find((x) => x.absolute && x.action && String(x.action.path).endsWith(`/presets/${n}/recall`)); return k && k.tone; };

test('E2 program: exactly one preset is on program, the one most recently taken', async () => {
  const ctx = await liveE2();
  try {
    // Walk-in (e2:0) uses S1-S4 + A1; Keynote Full (e2:1) only S1. Before the fix Walk-in kept S2-S4 + A1
    // in the per-destination program map after Keynote was taken, so both showed PGM.
    await ctx.sm.recall('e2', 'e2:0'); await ctx.sm.take('e2');
    let v = ctx.sm.view('e2');
    assert.deepEqual(onPgm(v), ['e2:0']);
    assert.equal(v.programPreset.key, 'e2:0');
    await ctx.sm.recall('e2', 'e2:1'); await ctx.sm.take('e2');
    v = ctx.sm.view('e2');
    assert.deepEqual(onPgm(v), ['e2:1'], 'the old program preset clears');
    assert.equal(v.presets.find((p) => p.key === 'e2:1').tally.pgm, 'full');
    assert.equal(v.programPreset.key, 'e2:1');
    assert.deepEqual(onPvw(v), []);
    assert.deepEqual(v.destinations.filter((d) => d.pgmPreset).map((d) => [d.key, d.pgmPreset.key]), [['S1', 'e2:1']], 'destination chips show one program preset');
    // CUT behaves the same
    await ctx.sm.recall('e2', 'e2:2'); await ctx.sm.cut('e2');
    v = ctx.sm.view('e2');
    assert.deepEqual(onPgm(v), ['e2:2']);
    // Stream Deck: one red key
    const face = show(SURFACES.plusxl, desk(v), { system: 'e2', page: 0 });
    const red = v.presets.filter((p) => tone(face, p.number) === 'stop').map((p) => p.key);
    assert.deepEqual(red, ['e2:2']);
    // a recall straight to program replaces it too
    await ctx.sm.recall('e2', 'e2:4', { target: 'program' });
    v = ctx.sm.view('e2');
    assert.deepEqual(onPgm(v), ['e2:4']);
    assert.equal(v.programPreset.key, 'e2:4');
  } finally { await ctx.stop(); }
});

test('E2 recall arms the preset\'s own destinations; the next recall replaces them; TAKE clears them', async () => {
  const ctx = await liveE2();
  try {
    let v = ctx.sm.view('e2');
    assert.deepEqual(armed(v), []);
    await ctx.sm.recall('e2', 'e2:2'); // IMAG Pair: S2 + S3
    v = ctx.sm.view('e2');
    assert.deepEqual(armed(v), ['S2', 'S3']);
    assert.deepEqual(v.takeTargets, ['S2', 'S3'], 'what is lit is what TAKE runs on');
    assert.deepEqual(v.selection, [], 'a recall does not change the hand selection');
    // Stream Deck destination keys light the same dests
    const keys = [{ destSlot: true }, { destSlot: true }, { destSlot: true }, { destSlot: true }];
    const lit = applySwitcherDestinations(keys, v, 'e2').filter((k) => k.on).map((k) => k.caption);
    assert.deepEqual(lit, ['S2', 'S3']);
    await ctx.sm.recall('e2', 'e2:9'); // Q&A: S1-S3 + A1, A2
    v = ctx.sm.view('e2');
    assert.deepEqual(armed(v), ['S1', 'S2', 'S3', 'A1', 'A2'], 'replaced, not added');
    const r = await ctx.sm.take('e2');
    assert.deepEqual(r.done, ['S1', 'S2', 'S3', 'A1', 'A2']);
    v = ctx.sm.view('e2');
    assert.deepEqual(armed(v), [], 'TAKE clears the recall arming');
    await assert.rejects(ctx.sm.take('e2'), /Nothing armed/, 'a second TAKE needs a new recall or a selection');
    // a hand selection wins over the recall arming and shows as armed
    await ctx.sm.recall('e2', 'e2:2');
    await ctx.sm.setSelection('e2', ['S4']);
    v = ctx.sm.view('e2');
    assert.deepEqual(armed(v), ['S4']);
    assert.deepEqual(v.destinations.filter((d) => d.selected).map((d) => d.key), ['S4']);
    // a program recall clears the recall arming (nothing to take)
    await ctx.sm.setSelection('e2', []);
    await ctx.sm.recall('e2', 'e2:4', { target: 'program' });
    assert.deepEqual(armed(ctx.sm.view('e2')), []);
  } finally { await ctx.stop(); }
});

test('E2 UI: an armed destination is drawn like a selected one', () => {
  const ui = fs.readFileSync(path.join(__dirname, '../public/sys.js'), 'utf8');
  assert.match(ui, /d\.selected \|\| d\.armed \? 'on' : ''/);
  assert.match(ui, /armed by the last recall/);
});
