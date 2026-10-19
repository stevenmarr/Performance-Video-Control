'use strict';
// 0.3.3 regression: "The presets in the gui (the ones dropped to the buttons) still don't display their preset
// names". Presets created by dropping memories on a tile, or saved without typing a name, were stored as
// "Preset <n>", so a tile only ever said its number twice. Now the name is derived from the device memory
// names the preset holds (live), a typed name always wins, and Companion's preset_N_name gets the same name.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setup, until } = require('./helpers');
const { createServer } = require('../lib/server');
const naming = require('../lib/naming');

const L = { screen: { 2: 'look 2', 5: 'gfx', 9: 'look 2' }, master: { 3: 'imag split' }, multiviewer: { 1: 'MV main' } };

test('derived names: one memory, Master, several, unknown labels, duplicates, sources, length', () => {
  const d = (p) => naming.derivedName(p, L);
  assert.equal(d({ memories: { S2: 2 } }), 'look 2');
  assert.equal(d({ master: { slot: 3, dests: [] } }), 'imag split');
  assert.equal(d({ memories: { S2: 2, A1: 5 } }), 'look 2 + gfx');
  assert.equal(d({ master: { slot: 3 }, memories: { S1: 5 }, mvMemories: { M1: 1 } }), 'imag split + gfx + MV main');
  assert.equal(d({ memories: { S2: 2, S3: 9 } }), 'look 2'); // same label twice
  assert.equal(naming.derivedName({ memories: { S2: 2 }, master: { slot: 7 } }, {}), 'Master 7 + S2:M2');
  assert.equal(d({ destinations: ['S1'], memories: {}, sources: { S1: { layers: [{ layer: 1 }] } } }), 'S1 snapshot');
  assert.equal(d({ memories: {} }), '');
  const long = naming.derivedName({ memories: Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((i) => [`S${i}`, i])) }, { screen: Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((i) => [i, `Long memory name ${i}`])) });
  assert.ok(long.length <= 64 && long.endsWith('+ …'), long);
});

test('generic names are automatic, typed names are kept', () => {
  for (const g of ['', '  ', 'Preset 4', 'preset 12', 'Preset', null, undefined]) assert.equal(naming.isGenericName(g), true, String(g));
  for (const t of ['Keynote', 'Preset 4 wide', 'Look 2']) assert.equal(naming.isGenericName(t), false, t);
  assert.equal(naming.displayName({ number: 4, name: 'Preset 4', memories: { S2: 2 } }, L), 'look 2');
  assert.equal(naming.displayName({ number: 4, name: 'Preset 9', memories: { S2: 2 } }, L), 'look 2'); // renumbered generic
  assert.equal(naming.displayName({ number: 4, name: 'Opener', memories: { S2: 2 } }, L), 'Opener');
  assert.equal(naming.displayName({ number: 4, name: '', memories: {} }, L), 'Preset 4'); // nothing to derive from
  const proposed = { memories: { S2: 2 } };
  assert.equal(naming.nameToStore('look 2', null, proposed, L), ''); // accepted default stays automatic
  assert.equal(naming.nameToStore('Preset 3', null, proposed, L), '');
  assert.equal(naming.nameToStore('  My look ', null, proposed, L), 'My look');
  assert.equal(naming.nameToStore(undefined, { name: 'Kept' }, proposed, L), 'Kept');
  assert.equal(naming.nameToStore(undefined, { name: 'Preset 3' }, proposed, L), '');
});

async function withApp(opts, fn) {
  const ctx = await setup(opts);
  await ctx.engine.connect(); await ctx.engine.memoriesReady; if (ctx.engine.liveReady) await ctx.engine.liveReady;
  const server = createServer(ctx.engine);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  try { await fn(call, ctx); } finally { server.closeClients(); await new Promise((r) => server.close(r)); await ctx.teardown(); }
}
const shown = async (call, n) => (await call('GET', '/api/state')).json.presets.find((p) => p.number === n);

test('drop memories onto empty tiles: the tile gets the device memory name, not "Preset N"', async () => {
  await withApp({}, async (call) => {
    let r = await call('POST', '/api/presets/12/assign', { target: 'S2', type: 'screen', slot: 1 });
    assert.equal(r.json.name, 'Walk-in L'); assert.equal(r.json.autoName, true); assert.equal(r.json.customName, '');
    assert.equal((await shown(call, 12)).name, 'Walk-in L');
    await call('POST', '/api/presets/12/assign', { target: 'S3', type: 'screen', slot: 10 });
    assert.equal((await shown(call, 12)).name, 'Walk-in L + Keynote');
    r = await call('POST', '/api/presets/13/assign', { target: 'master', type: 'master', slot: 1 });
    const mlabel = (await call('GET', '/api/memories')).json.master[1];
    assert.ok(mlabel); assert.equal(r.json.name, mlabel);
    r = await call('POST', '/api/presets/14/assign', { target: 'S1', type: 'screen', slot: 77 }); // no label on the device
    assert.equal(r.json.name, 'S1:M77');
    // the stored file keeps the name empty (automatic), so a later device rename is followed
  });
});

test('board save and selection save without a typed name, and with the prefilled default', async () => {
  await withApp({}, async (call) => {
    await call('POST', '/api/stage', { target: 'S1', type: 'screen', slot: 10 });
    await call('POST', '/api/stage', { target: 'A1', type: 'screen', slot: 30 });
    const st = (await call('GET', '/api/state')).json;
    assert.equal(st.staging.suggestedName, 'Keynote + Floor Logo');
    let r = await call('POST', '/api/stage/save', { number: 20 }); assert.equal(r.json.name, 'Keynote + Floor Logo');
    r = await call('POST', '/api/stage/save', { number: 21, name: st.staging.suggestedName }); assert.equal(r.json.autoName, true);
    r = await call('POST', '/api/stage/save', { number: 22, name: 'Preset 22' }); assert.equal(r.json.name, 'Keynote + Floor Logo');
    r = await call('POST', '/api/stage/save', { number: 23, name: 'Opening look' }); assert.equal(r.json.name, 'Opening look'); assert.equal(r.json.autoName, false);
    r = await call('POST', '/api/presets/suggest-name', { memories: { S2: 11 } }); assert.deepEqual(r.json, { name: 'IMAG L' });
    r = await call('POST', '/api/presets', { number: 30, destinations: ['S2'], memories: { S2: 11 } }); assert.equal(r.json.name, 'IMAG L');
    r = await call('POST', '/api/presets', { number: 31, name: '', destinations: ['S2'], memories: { S2: 12 } }); assert.equal(r.json.name, 'IMAG R');
  });
});

test('existing "Preset N" names show the derived name; typed names are never overwritten; rename/clear in EDIT', async () => {
  await withApp({}, async (call, { engine }) => {
    // as written by 0.3.0-0.3.2 (Steven's file: Master presets named "Preset 1", "Preset 2", ...)
    engine.presets.push({ number: 2, name: 'Preset 2', destinations: [], memories: {}, sources: {}, master: { slot: 3, dests: ['S1', 'S2'] }, mvMemories: {} });
    engine.presets.push({ number: 4, name: 'Preset 4', destinations: ['S1'], memories: { S1: 13 }, sources: {}, master: null, mvMemories: {} });
    engine.presets.push({ number: 5, name: 'My keynote', destinations: ['S1'], memories: { S1: 10 }, sources: {}, master: null, mvMemories: {} });
    engine.presets.sort((a, b) => a.number - b.number);
    const mlabel = (await call('GET', '/api/memories')).json.master[3];
    assert.equal((await shown(call, 2)).name, mlabel);
    assert.equal((await shown(call, 4)).name, 'IMAG Wide');
    assert.equal((await shown(call, 5)).name, 'My keynote');
    // re-dropping a memory onto a typed-name preset keeps the typed name
    await call('POST', '/api/presets/5/assign', { target: 'S2', type: 'screen', slot: 11 });
    assert.equal((await shown(call, 5)).name, 'My keynote');
    // rename, then clear back to automatic
    let r = await call('PUT', '/api/presets/4', { name: 'Wide shot' }); assert.equal(r.json.name, 'Wide shot');
    assert.equal(engine.getPreset(4).name, 'Wide shot');
    r = await call('PUT', '/api/presets/4', { name: '' }); assert.equal(r.json.name, 'IMAG Wide'); assert.equal(r.json.autoName, true);
    r = await call('GET', '/api/presets/4'); assert.equal(r.json.name, 'IMAG Wide'); assert.equal(r.json.derivedName, 'IMAG Wide');
    // other edits without a name keep it
    await call('PUT', '/api/presets/5', { newNumber: 6 }); assert.equal((await shown(call, 6)).name, 'My keynote');
    // duplicate: typed -> "copy", automatic -> stays automatic
    r = await call('POST', '/api/presets/6/duplicate', {}); assert.equal(r.json.name, 'My keynote copy');
    r = await call('POST', '/api/presets/4/duplicate', {}); assert.equal(r.json.name, 'IMAG Wide'); assert.equal(r.json.autoName, true);
    // lastRecalled (Companion's last_preset_name) uses the shown name
    await call('POST', '/api/presets/4/recall');
    assert.deepEqual((await call('GET', '/api/state')).json.lastRecalled, { number: 4, name: 'IMAG Wide' });
  });
});

test('automatic names follow a memory renamed on the device (live)', async () => {
  await withApp({ liveEnabled: true, protocol: 'awj' }, async (call, { mock }) => {
    await call('POST', '/api/presets/12/assign', { target: 'S1', type: 'screen', slot: 10 });
    await call('PUT', '/api/presets/12', {}); // no-op edit
    assert.equal((await shown(call, 12)).name, 'Keynote');
    mock.external.setMemoryLabel(10, 'Keynote v2');
    await until(async () => (await shown(call, 12)).name === 'Keynote v2', 3000, 'live label');
  });
});

test('Companion preset_N_name uses the same name as the tile', async () => {
  const logic = path.join(__dirname, '..', '..', 'companion-module-rs6-presets', 'src', 'logic.js');
  if (!fs.existsSync(logic)) return; // module repo not checked out next to the app
  const L2 = require(logic);
  await withApp({}, async (call) => {
    await call('POST', '/api/presets/7/assign', { target: 'S2', type: 'screen', slot: 2 });
    const st = (await call('GET', '/api/state')).json;
    assert.equal(L2.variableValues(st).preset_7_name, 'Walk-in R');
    assert.equal(st.presets.find((p) => p.number === 7).name, 'Walk-in R');
  });
});
