'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setup, restCalls, awjCalls } = require('./helpers');
const { Engine } = require('../lib/engine');

test('connect lists enabled screens and aux from the device', async () => {
  const { engine, teardown } = await setup();
  try {
    assert.equal(await engine.connect(), true);
    assert.deepEqual(engine.destinations.map((d) => d.key), ['S1', 'S2', 'S3', 'S4', 'A1', 'A2']);
    assert.equal(engine.destinations[0].label, 'Center LED');
    assert.match(String(engine.system.type), /RS6/);
  } finally { await teardown(); }
});

test('save captures only selected destinations: Screen memory slot via AWJ readback + source snapshot', async () => {
  const { mock, engine, teardown } = await setup();
  try {
    await engine.connect();
    mock.loadMemory('S1', 33, 'preview'); mock.loadMemory('S2', 34, 'preview'); mock.loadMemory('S3', 99, 'preview');
    engine.setSelection(['S1', 'S2']);
    const p = await engine.savePreset({ number: 5, name: 'Keynote' });
    assert.deepEqual(p.destinations, ['S1', 'S2']);
    assert.deepEqual(p.memories, { S1: 33, S2: 34 });
    assert.equal(p.sources.S1.layers[0].sourceType, 'input');
    assert.equal(p.sources.S1.background.sourceType, 'background-set');
    assert.equal(p.sources.S3, undefined);
    const onDisk = JSON.parse(fs.readFileSync(engine.presetsFile, 'utf8'));
    assert.equal(onDisk.presets[0].number, 5);
  } finally { await teardown(); }
});

test('readback respects TBAR side: after a TAKE the Preview is preset A (AWJ p.13)', async () => {
  const { mock, engine, teardown } = await setup();
  try {
    await engine.connect();
    mock.loadMemory('S1', 10, 'preview'); mock.take('S1'); // now AT_UP, PVW = A
    mock.loadMemory('S1', 12, 'preview');
    assert.equal(mock.dests.S1.transition, 'AT_UP');
    assert.equal(await engine.device.readPreviewMemoryId('S1'), 12);
  } finally { await teardown(); }
});

test('recall loads to Preview on the preset destinations only, and sets the selection to match', async () => {
  const { mock, engine, teardown } = await setup();
  try {
    await engine.connect();
    await engine.savePreset({ number: 1, name: 'A', destinations: ['S1', 'A1'], memories: { S1: 7, A1: 8 } });
    engine.setSelection(['S2', 'S3', 'S4']); // operator has other things lit (the RC400T problem)
    mock.history.length = 0;
    await engine.recall(1);
    const loads = restCalls(mock, /load-memory$/);
    assert.deepEqual(loads.map((h) => [h.path, h.body]), [
      ['/api/tpp/v1/screens/1/load-memory', { memoryId: 7, target: 'preview' }],
      ['/api/tpp/v1/auxiliary-screens/1/load-memory', { memoryId: 8, target: 'preview' }],
    ]);
    assert.deepEqual([...engine.selection].sort(), ['A1', 'S1']);
    assert.equal(mock.dests.S2.B.presetId, 0); // untouched
    const st = engine.getState();
    assert.equal(st.lastRecalled.number, 1);
    assert.equal(st.presets[0].onPreview, true); assert.equal(st.presets[0].onProgram, false);
  } finally { await teardown(); }
});

test('take transitions only the selected destinations via global TAKE (REST p.20) and updates tally', async () => {
  const { mock, engine, teardown } = await setup();
  try {
    await engine.connect();
    await engine.savePreset({ number: 1, name: 'A', destinations: ['S1', 'A2'], memories: { S1: 7, A2: 9 } });
    await engine.savePreset({ number: 2, name: 'B', destinations: ['S2'], memories: { S2: 3 } });
    await engine.recall(1);
    mock.history.length = 0;
    await engine.take();
    const t = restCalls(mock, /\/take$/);
    assert.equal(t.length, 1);
    assert.deepEqual(t[0].body, { screenIds: [1], auxiliaryScreenIds: [2] });
    assert.equal(mock.dests.S1.transition, 'AT_UP'); assert.equal(mock.dests.A2.transition, 'AT_UP');
    assert.equal(mock.dests.S2.transition, 'AT_DOWN');
    assert.equal(mock.side('S1', 'program').presetId, 7);
    const st = engine.getState();
    const p1 = st.presets.find((p) => p.number === 1);
    assert.equal(p1.onProgram, true); assert.deepEqual(st.programPresets, [1]);
    // with preset toggle OFF, PVW still holds the same preset
    assert.equal(p1.onPreview, true);
  } finally { await teardown(); }
});

test('global TAKE failure falls back to per-destination TAKE (REST p.19/p.26)', async () => {
  const { mock, engine, teardown } = await setup();
  try {
    await engine.connect();
    const orig = engine.device.rest.post.bind(engine.device.rest);
    engine.device.rest.post = (p, b) => (p.endsWith('/v1/take') ? Promise.reject(new Error('HTTP 400')) : orig(p, b));
    engine.setSelection(['S3', 'A1']);
    mock.history.length = 0;
    await engine.take();
    assert.deepEqual(restCalls(mock, /take$/).map((h) => h.path), ['/api/tpp/v1/screens/3/take', '/api/tpp/v1/auxiliary-screens/1/take']);
  } finally { await teardown(); }
});

test('cut loads the Preview preset straight to Program on the selected destinations only', async () => {
  const { mock, engine, teardown } = await setup();
  try {
    await engine.connect();
    await engine.savePreset({ number: 4, name: 'Cut me', destinations: ['S2', 'S3'], memories: { S2: 21, S3: 22 } });
    await engine.recall(4);
    mock.history.length = 0;
    const r = await engine.cut();
    assert.deepEqual(r.done, ['S2', 'S3']);
    assert.deepEqual(restCalls(mock, /load-memory$/).map((h) => h.body.target), ['program', 'program']);
    assert.equal(mock.side('S2', 'program').presetId, 21);
    assert.equal(mock.side('S1', 'program').presetId, 0);
    assert.equal(engine.getState().presets[0].onProgram, true);
  } finally { await teardown(); }
});

test('auto take on recall', async () => {
  const { mock, engine, teardown } = await setup({ autoTake: true });
  try {
    await engine.connect();
    await engine.savePreset({ number: 1, name: 'A', destinations: ['S4'], memories: { S4: 5 } });
    await engine.recall(1);
    assert.equal(mock.side('S4', 'program').presetId, 5);
    assert.equal(engine.getState().presets[0].onProgram, true);
    assert.equal(engine.setAutoTake(), false);
  } finally { await teardown(); }
});

test('preset toggle setting swaps PVW tally after take', async () => {
  const { engine, teardown } = await setup({ presetToggle: true });
  try {
    await engine.connect();
    await engine.savePreset({ number: 1, name: 'A', destinations: ['S1'], memories: { S1: 1 } });
    await engine.savePreset({ number: 2, name: 'B', destinations: ['S1'], memories: { S1: 2 } });
    await engine.recall(1); await engine.take();
    await engine.recall(2); await engine.take();
    assert.equal(engine.pgm.S1, 2); assert.equal(engine.pvw.S1, 1);
  } finally { await teardown(); }
});

test('source-snapshot preset (no memory slot) writes layer + background sources to Preview', async () => {
  const { mock, engine, teardown } = await setup({ awjReadback: false });
  try {
    await engine.connect();
    mock.loadMemory('S1', 6, 'preview'); // gives S1 a recognisable look
    engine.setSelection(['S1']);
    const p = await engine.savePreset({ number: 9, name: 'Sources' });
    assert.deepEqual(p.memories, {});
    assert.ok(p.sources.S1.layers.length >= 2);
    mock.loadMemory('S1', 1, 'preview'); // change the look
    mock.history.length = 0;
    await engine.recall(9);
    const writes = restCalls(mock, /\/source$/);
    assert.ok(writes.some((h) => h.path === '/api/tpp/v1/screens/1/layers/1/presets/preview/source' && h.body.sourceType === 'input' && h.body.sourceId === 6));
    assert.ok(writes.some((h) => h.path === '/api/tpp/v1/screens/1/background-layer/presets/preview/source'));
    assert.equal(mock.side('S1', 'preview').layers[1].sourceId, 6);
  } finally { await teardown(); }
});

test('AWJ protocol mode: recall and take use documented AWJ paths (AWJ p.9)', async () => {
  const { mock, engine, teardown } = await setup({ protocol: 'awj' });
  try {
    await engine.connect();
    await engine.savePreset({ number: 1, name: 'A', destinations: ['S2', 'A1'], memories: { S2: 33, A1: 8 } });
    mock.history.length = 0;
    await engine.recall(1); await engine.take();
    const paths = awjCalls(mock, /xRequest|xTake/).map((h) => h.path);
    assert.deepEqual(paths, [
      'DeviceObject/presetBank/control/load/$slot/@items/33/$screen/@items/S2/$preset/@items/PREVIEW/@props/xRequest',
      'DeviceObject/presetBank/control/load/$slot/@items/8/$auxiliary/@items/A1/$preset/@items/PREVIEW/@props/xRequest',
      'DeviceObject/$screenAuxGroup/@items/S2/control/@props/xTake',
      'DeviceObject/$screenAuxGroup/@items/A1/control/@props/xTake',
    ]);
    assert.equal(restCalls(mock, /load-memory|take/).length, 0);
    assert.equal(mock.side('S2', 'program').presetId, 33);
  } finally { await teardown(); }
});

test('CRUD: rename, renumber, duplicate, delete, update, persistence', async () => {
  const { mock, engine, dataDir, teardown } = await setup();
  try {
    await engine.connect();
    await engine.savePreset({ number: 1, name: 'One', destinations: ['S1'], memories: { S1: 11 } });
    await engine.recall(1);
    engine.editPreset(1, { name: 'Opener', newNumber: 3, memories: { S1: 12, S9: 5 } });
    assert.equal(engine.getPreset(3).name, 'Opener'); assert.deepEqual(engine.getPreset(3).memories, { S1: 12 });
    assert.equal(engine.lastRecalled, 3); assert.equal(engine.pvw.S1, 3);
    const d = engine.duplicatePreset(3); assert.equal(d.number, 4); assert.equal(d.name, 'Opener copy');
    assert.throws(() => engine.duplicatePreset(3, 4), /exists/);
    // update re-captures from the device (operator recalled memory 77 on S1 preview)
    mock.loadMemory('S1', 77, 'preview');
    const u = await engine.updatePreset(4); assert.equal(u.memories.S1, 77);
    // overwrite with current selection changes the destination set
    engine.setSelection(['S2']); mock.loadMemory('S2', 78, 'preview');
    const o = await engine.updatePreset(4, { useSelection: true }); assert.deepEqual(o.destinations, ['S2']); assert.deepEqual(o.memories, { S2: 78 });
    engine.deletePreset(3); assert.equal(engine.getPreset(3), undefined); assert.equal(engine.lastRecalled, null);
    engine.setSelection([]);
    await assert.rejects(engine.savePreset({ number: 2 }), /Select at least one/);
    const reloaded = new Engine({ dataDir, settingsOverride: { host: '127.0.0.1' } });
    assert.deepEqual(reloaded.presets.map((p) => [p.number, p.name, p.destinations]), [[4, 'Opener copy', ['S2']]]);
    reloaded.device.close();
  } finally { await teardown(); }
});

test('recall on a destination with nothing stored is reported, others still load', async () => {
  const { engine, teardown } = await setup({ awjReadback: false });
  try {
    await engine.connect();
    engine.presets.push({ number: 7, name: 'Broken', destinations: ['S1', 'S2'], memories: { S1: 4 }, sources: {} });
    const r = await engine.recall(7);
    assert.deepEqual(r.done, ['S1']); assert.deepEqual(r.failed, ['S2']);
    assert.ok(engine.logs.some((l) => l.level === 'error' && /S2/.test(l.msg)));
  } finally { await teardown(); }
});
