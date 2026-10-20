'use strict';
// 0.3.0: memory import, the drag-assign (board / preset assign) API, recall targeting, migration.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setup, restCalls, awjCalls, until } = require('./helpers');
const { createServer } = require('../lib/server');
const { Engine } = require('../lib/engine');

const slots = (cat, type) => cat.items[type].map((i) => i.slot);
const item = (cat, type, slot) => cat.items[type].find((i) => i.slot === slot);

async function withApp(opts, fn) {
  const ctx = await setup(opts);
  await ctx.engine.connect(); await ctx.engine.memoriesReady;
  const server = createServer(ctx.engine);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  try { await fn(call, ctx); } finally { server.closeClients(); await new Promise((r) => server.close(r)); await ctx.teardown(); }
}

// ---------------- import ----------------
test('import on connect (labels only, documented §3.7): named Screen + Master slots, no inferred paths sent', async () => {
  const { mock, engine, teardown } = await setup();
  try {
    await engine.connect(); await engine.memoriesReady;
    const cat = engine.memoryCatalog();
    assert.deepEqual(slots(cat, 'screen').slice(0, 6), [1, 2, 10, 11, 12, 13]);
    assert.ok(!slots(cat, 'screen').includes(3) && !slots(cat, 'screen').includes(60)); // unnamed slots are not claimed valid
    assert.deepEqual(item(cat, 'screen', 10), { type: 'screen', slot: 10, label: 'Keynote', status: 'valid', evidence: 'label', seenOn: [], onProgram: [], onPreview: [] });
    assert.deepEqual(slots(cat, 'master'), [1, 2, 3, 4, 5]);
    // 0.3.4: unknown slots are listed only with all (the palette checkbox), for Multiviewer too (MV labels not documented)
    assert.equal(cat.items.multiviewer.length, 0);
    assert.equal(cat.types.find((t) => t.type === 'layer').supported, false);
    assert.ok(cat.import.at); assert.equal(cat.import.probe, false);
    assert.equal(awjCalls(mock, /isValid|monitoringBank\/\$bank/).length, 0);
    assert.equal(awjCalls(mock, /^DeviceObject\/presetBank\/\$bank\/@items\/\d+\/control\/@props\/label$/).length, 1000);
    // unknown/empty slots only with all
    const all = engine.memoryCatalog({ all: true });
    assert.equal(all.items.screen.length, 1000); assert.equal(item(all, 'screen', 3).status, 'unknown');
    assert.equal(all.items.multiviewer.length, 50); assert.ok(all.items.multiviewer.every((i) => i.status === 'unknown' && !i.label));
    assert.equal(awjCalls(mock, /layerBank/).length, 0); // layer memories off by default
    assert.deepEqual(engine.getState().multiviewers.map((m) => m.key), ['M1', 'M2']); // REST §5.1
  } finally { await teardown(); }
});

test('import with the INFERRED isValid probe: unnamed valid slots, empty slots, Multiviewer bank', async () => {
  const { mock, engine, teardown } = await setup({ extra: { memoryProbe: true } });
  try {
    await engine.connect(); await engine.memoriesReady;
    const cat = engine.memoryCatalog();
    assert.ok(slots(cat, 'screen').includes(60) && slots(cat, 'screen').includes(61));
    assert.equal(item(cat, 'screen', 60).evidence, 'device'); assert.equal(item(cat, 'screen', 60).label, '');
    assert.ok(slots(cat, 'master').includes(7));
    assert.deepEqual(cat.items.multiviewer.map((i) => [i.slot, i.label]), [[1, 'Show MV'], [2, 'Rehearsal MV'], [3, 'Tech Full'], [10, 'Record Check']]);
    assert.equal(item(engine.memoryCatalog({ all: true }), 'screen', 3).status, 'empty');
    assert.ok(awjCalls(mock, /presetBank\/\$bank\/@items\/60\/status\/@props\/isValid$/).length >= 1);
  } finally { await teardown(); }
});

test('import stays current through the AWJ subscription (rename, save, delete, loaded-but-unnamed)', async () => {
  const { mock, engine, teardown } = await setup({ liveEnabled: true, extra: { memoryProbe: true } });
  try {
    await engine.connect(); await engine.liveReady;
    assert.equal(engine.live.mode, 'push');
    mock.external.saveScreenMemory(70, 'Late Add');
    await until(() => item(engine.memoryCatalog(), 'screen', 70), 2000, 'new memory');
    mock.external.setMemoryLabel(10, 'Keynote v2');
    await until(() => item(engine.memoryCatalog(), 'screen', 10).label === 'Keynote v2', 2000, 'rename');
    mock.external.deleteScreenMemory(12);
    await until(() => !item(engine.memoryCatalog(), 'screen', 12), 2000, 'delete');
    assert.equal(item(engine.memoryCatalog({ all: true }), 'screen', 12).status, 'empty');
    mock.external.setMasterLabel(4, 'Encore');
    await until(() => item(engine.memoryCatalog(), 'master', 4).label === 'Encore', 2000, 'master label');
    // live tally on the palette item (§3.11)
    mock.external.loadMemory('S2', 11, 'preview');
    await until(() => item(engine.memoryCatalog(), 'screen', 11).onPreview.includes('S2'), 2000, 'onPreview');
    assert.deepEqual(item(engine.memoryCatalog(), 'screen', 11).seenOn, ['S2']);
  } finally { await teardown(); }
});

test('a slot the device reports as loaded counts as valid even without a label (labels-only mode)', async () => {
  const { mock, engine, teardown } = await setup({ liveEnabled: true });
  try {
    await engine.connect(); await engine.liveReady;
    mock.external.loadMemory('A1', 77, 'program');
    await until(() => item(engine.memoryCatalog(), 'screen', 77), 2000, 'seen');
    assert.equal(item(engine.memoryCatalog(), 'screen', 77).evidence, 'loaded');
    assert.deepEqual(item(engine.memoryCatalog(), 'screen', 77).onProgram, ['A1']);
  } finally { await teardown(); }
});

test('manual refresh: POST /api/memories/refresh re-reads the banks; GET /api/memories carries the catalog', async () => {
  await withApp({}, async (call, { mock }) => {
    mock.v.set('DeviceObject/presetBank/$bank/@items/3/control/@props/label', 'Quiet change'); // no notification
    let r = await call('GET', '/api/memories'); assert.equal(r.json.screen[3], undefined); assert.ok(r.json.catalog.items.screen.length);
    r = await call('POST', '/api/memories/refresh'); assert.equal(r.status, 200);
    assert.equal(item(r.json, 'screen', 3).label, 'Quiet change');
    r = await call('GET', '/api/memories/catalog?all=1'); assert.equal(r.json.items.screen.length, 1000);
    r = await call('GET', '/api/state'); assert.ok(r.json.memories.items.master.find((i) => i.label === 'Break'));
  });
});

test('refresh with AWJ unreachable reports a clear error (REST has no memory read)', async () => {
  const { engine, teardown } = await setup({ extra: { awjPort: 1 } });
  try {
    await engine.connect(); await engine.memoriesReady;
    await assert.rejects(engine.refreshMemories(), (e) => e.status === 409);
    assert.match(engine.memoryCatalog().import.error, /AWJ only/);
  } finally { await teardown(); }
});

// ---------------- drag-assign API ----------------
test('board (stage) API: mix memories per screen, validate type/target, save as a combined preset', async () => {
  await withApp({}, async (call) => {
    let r = await call('POST', '/api/stage', { target: 'S1', type: 'screen', slot: 3 });
    assert.equal(r.status, 200); assert.deepEqual(r.json.memories, { S1: 3 });
    await call('POST', '/api/stage', { target: 'S2', type: 'screen', slot: 7 });
    await call('POST', '/api/stage', { target: 'A1', type: 'screen', slot: 40 });
    await call('POST', '/api/stage', { target: 'M1', type: 'multiviewer', slot: 2 });
    r = await call('POST', '/api/stage', { target: 'master', type: 'master', slot: 4, dests: ['S3', 'S4'] });
    assert.deepEqual(r.json.master, { slot: 4, dests: ['S3', 'S4'] });
    for (const bad of [
      { target: 'S1', type: 'master', slot: 1 }, { target: 'master', type: 'screen', slot: 1 }, { target: 'M1', type: 'screen', slot: 1 },
      { target: 'S1', type: 'screen', slot: 1001 }, { target: 'S9', type: 'screen', slot: 1 }, { target: 'M5', type: 'multiviewer', slot: 1 },
      { target: 'X1', type: 'screen', slot: 1 }, { target: 'M1', type: 'multiviewer', slot: 51 },
    ]) { r = await call('POST', '/api/stage', bad); assert.equal(r.status, 400, JSON.stringify(bad)); }
    r = await call('POST', '/api/stage', { target: 'A1', type: 'screen', slot: null }); assert.deepEqual(r.json.memories, { S1: 3, S2: 7 });
    r = await call('GET', '/api/state'); assert.deepEqual(r.json.staging.targets, ['S1', 'S2', 'S3', 'S4']);
    r = await call('POST', '/api/stage/save', { number: 20, name: 'Mix' });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.destinations, r.json.memories, r.json.master, r.json.mvMemories], [['S1', 'S2'], { S1: 3, S2: 7 }, { slot: 4, dests: ['S3', 'S4'] }, { M1: 2 }]);
    r = await call('GET', '/api/state'); const p = r.json.presets.find((x) => x.number === 20);
    assert.deepEqual(p.targets, ['S1', 'S2', 'S3', 'S4']); assert.equal(r.json.staging.editing, 20);
    r = await call('DELETE', '/api/stage'); assert.deepEqual(r.json.memories, {});
    r = await call('POST', '/api/stage/save', {}); assert.equal(r.status, 400); // empty board
    r = await call('POST', '/api/stage/from/20'); assert.deepEqual(r.json.memories, { S1: 3, S2: 7 }); assert.equal(r.json.editing, 20);
  });
});

test('preset assign API: drop memories onto a preset (creates it), replace, remove', async () => {
  await withApp({}, async (call, { engine }) => {
    let r = await call('POST', '/api/presets/12/assign', { target: 'S1', type: 'screen', slot: 3, name: 'Built' });
    assert.equal(r.status, 200); assert.equal(r.json.name, 'Built'); assert.deepEqual(r.json.destinations, ['S1']);
    await call('POST', '/api/presets/12/assign', { target: 'S2', type: 'screen', slot: 7 });
    await call('POST', '/api/presets/12/assign', { target: 'master', type: 'master', slot: 2 });
    r = await call('POST', '/api/presets/12/assign', { target: 'M2', type: 'multiviewer', slot: 3 });
    assert.deepEqual(r.json.master, { slot: 2, dests: ['S1', 'S2', 'S3', 'S4', 'A1', 'A2'] }); // default: every destination
    r = await call('POST', '/api/presets/12/assign', { target: 'S1', type: 'screen', slot: 9 }); assert.deepEqual(r.json.memories, { S1: 9, S2: 7 });
    r = await call('POST', '/api/presets/12/assign', { target: 'S2', type: 'screen', slot: 0 }); assert.deepEqual(r.json.destinations, ['S1']);
    r = await call('POST', '/api/presets/12/assign', { target: 'S1', type: 'multiviewer', slot: 1 }); assert.equal(r.status, 400);
    r = await call('PUT', '/api/presets/12', { master: { slot: 5, dests: ['S1'] }, mvMemories: { M1: 4 } });
    assert.deepEqual([r.json.master, r.json.mvMemories], [{ slot: 5, dests: ['S1'] }, { M1: 4 }]);
    const onDisk = JSON.parse(fs.readFileSync(engine.presetsFile, 'utf8'));
    assert.equal(onDisk.version, 2); assert.deepEqual(onDisk.presets[0].master, { slot: 5, dests: ['S1'] });
  });
});

// ---------------- recall targeting ----------------
test('recall (REST): each Screen memory goes ONLY to its own screen; Master as a Master memory, first; MV per output', async () => {
  const { mock, engine, teardown } = await setup();
  try {
    await engine.connect();
    engine.assignToPreset(30, { target: 'S1', type: 'screen', slot: 3 });
    engine.assignToPreset(30, { target: 'S2', type: 'screen', slot: 7 });
    engine.assignToPreset(30, { target: 'master', type: 'master', slot: 4, dests: ['S3'] });
    engine.assignToPreset(30, { target: 'M1', type: 'multiviewer', slot: 2 });
    engine.setSelection(['S4', 'A1', 'A2']); // lit on the RC400T-style selection: must not matter
    mock.history.length = 0;
    const r = await engine.recall(30);
    assert.deepEqual(r.done, ['master', 'S1', 'S2', 'M1']);
    assert.deepEqual(mock.history.filter((h) => h.proto === 'rest' && h.op === 'POST').map((h) => [h.path, h.body]), [
      ['/api/tpp/v1/load-master-memory', { memoryId: 4, target: 'preview' }],
      ['/api/tpp/v1/screens/1/load-memory', { memoryId: 3, target: 'preview' }],
      ['/api/tpp/v1/screens/2/load-memory', { memoryId: 7, target: 'preview' }],
      ['/api/tpp/v1/multiviewers/1/load-memory', { memoryId: 2 }],
    ]);
    assert.equal(mock.side('S1', 'preview').presetId, 3); assert.equal(mock.side('S2', 'preview').presetId, 7);
    assert.equal(mock.side('S4', 'preview').presetId, 0); assert.equal(mock.side('A1', 'preview').presetId, 0);
    assert.equal(mock.mv[1], 2);
    assert.deepEqual([...engine.selection], ['S1', 'S2', 'S3']); // targets incl. the Master's screens
    const st = engine.getState(); const p = st.presets.find((x) => x.number === 30);
    assert.equal(p.onPreview, true); assert.deepEqual(st.master, { preview: 4, program: null });
    await engine.take();
    assert.equal(engine.getState().presets.find((x) => x.number === 30).onProgram, true);
  } finally { await teardown(); }
});

test('recall (AWJ): documented per-destination paths §3.3, Master §3.4, Multiviewer §4.2', async () => {
  const { mock, engine, teardown } = await setup({ protocol: 'awj' });
  try {
    await engine.connect(); await engine.memoriesReady;
    engine.assignToPreset(31, { target: 'A2', type: 'screen', slot: 41 });
    engine.assignToPreset(31, { target: 'S3', type: 'screen', slot: 12 });
    engine.assignToPreset(31, { target: 'master', type: 'master', slot: 15 });
    engine.assignToPreset(31, { target: 'M2', type: 'multiviewer', slot: 10 });
    mock.history.length = 0;
    await engine.recall(31);
    assert.deepEqual(awjCalls(mock, /xRequest$/).map((h) => h.path), [
      'DeviceObject/masterPresetBank/control/load/$slot/@items/15/$preset/@items/PREVIEW/@props/xRequest',
      'DeviceObject/presetBank/control/load/$slot/@items/12/$screen/@items/S3/$preset/@items/PREVIEW/@props/xRequest',
      'DeviceObject/presetBank/control/load/$slot/@items/41/$auxiliary/@items/A2/$preset/@items/PREVIEW/@props/xRequest',
      'DeviceObject/monitoringBank/control/load/$slot/@items/10/$output/@items/2/@props/xRequest',
    ]);
    assert.equal(restCalls(mock, /load/).length, 0);
  } finally { await teardown(); }
});

test('board load and single-memory load target only the named destinations', async () => {
  await withApp({}, async (call, { mock }) => {
    await call('POST', '/api/stage', { target: 'S3', type: 'screen', slot: 21 });
    await call('POST', '/api/stage', { target: 'A2', type: 'screen', slot: 43 });
    mock.history.length = 0;
    let r = await call('POST', '/api/stage/load', {}); assert.deepEqual(r.json.done, ['S3', 'A2']);
    assert.deepEqual(restCalls(mock, /load-memory$/).map((h) => h.path), ['/api/tpp/v1/screens/3/load-memory', '/api/tpp/v1/auxiliary-screens/2/load-memory']);
    r = await call('GET', '/api/state'); assert.deepEqual(r.json.selection, ['S3', 'A2']);
    mock.history.length = 0;
    r = await call('POST', '/api/memories/load', { type: 'screen', slot: 11, dest: 'S2', target: 'program' }); assert.equal(r.status, 200);
    r = await call('POST', '/api/memories/load', { type: 'master', slot: 2 }); assert.equal(r.status, 200);
    r = await call('POST', '/api/memories/load', { type: 'multiviewer', slot: 3, dest: 'M2' }); assert.equal(r.status, 200);
    assert.deepEqual(mock.history.filter((h) => h.proto === 'rest' && h.op === 'POST').map((h) => [h.path, h.body]), [
      ['/api/tpp/v1/screens/2/load-memory', { memoryId: 11, target: 'program' }],
      ['/api/tpp/v1/load-master-memory', { memoryId: 2, target: 'preview' }],
      ['/api/tpp/v1/multiviewers/2/load-memory', { memoryId: 3 }],
    ]);
  });
});

test('CUT on a preset with a Master memory loads the Master to Program once, then its own screen memories', async () => {
  const { mock, engine, teardown } = await setup();
  try {
    await engine.connect();
    engine.assignToPreset(5, { target: 'master', type: 'master', slot: 3, dests: ['S1', 'S2'] });
    engine.assignToPreset(5, { target: 'S2', type: 'screen', slot: 7 });
    await engine.recall(5);
    mock.history.length = 0;
    const r = await engine.cut();
    assert.deepEqual(r.done.sort(), ['S1', 'S2']);
    assert.deepEqual(mock.history.filter((h) => h.proto === 'rest' && h.op === 'POST').map((h) => h.path), ['/api/tpp/v1/load-master-memory', '/api/tpp/v1/screens/2/load-memory']);
    assert.equal(engine.masterOn().program, 3);
  } finally { await teardown(); }
});

// ---------------- migration ----------------
test('v0.2.0 presets.json migrates to file version 2 without losing anything, with a backup', async () => {
  const { mock, engine, dataDir, teardown } = await setup();
  try {
    engine.close();
    const v1 = { version: 1, presets: [
      { number: 1, name: 'Walk-in', destinations: ['S1', 'S2'], memories: { S1: 1, S2: 2 }, sources: { S1: { layers: [{ layer: 1, sourceType: 'input', sourceId: 1 }], background: null } }, color: '#f00', createdAt: 'x', updatedAt: 'y' },
      { number: 6, name: 'Snapshot only', destinations: ['A1'], memories: {}, sources: { A1: { layers: [{ layer: 1, sourceType: 'input', sourceId: 4 }], background: null } } },
    ] };
    const file = path.join(dataDir, 'presets.json');
    fs.writeFileSync(file, JSON.stringify(v1));
    const e2 = new Engine({ dataDir, settingsOverride: { ...engine.settings } });
    try {
      const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(disk.version, 2);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'presets.v1.bak.json'), 'utf8')), v1);
      for (const [i, p] of v1.presets.entries()) {
        const q = disk.presets[i];
        for (const k of Object.keys(p)) assert.deepEqual(q[k], p[k], `${p.number}.${k}`);
        assert.equal(q.master, null); assert.deepEqual(q.mvMemories, {});
      }
      await e2.connect();
      mock.history.length = 0;
      assert.deepEqual((await e2.recall(1)).done, ['S1', 'S2']);
      assert.deepEqual((await e2.recall(6)).done, ['A1']); // source snapshot still recalls
      assert.ok(e2.logs.some((l) => /Migrated 2 presets/.test(l.msg)));
      // second load: already v2, backup untouched, no re-migration
      const e3 = new Engine({ dataDir, settingsOverride: { ...engine.settings } });
      assert.ok(!e3.logs.some((l) => /Migrated/.test(l.msg))); assert.equal(e3.presets.length, 2); e3.close();
    } finally { e2.close(); }
  } finally { await teardown(); }
});

test('UI ships the palette/board and the cropped logo + favicon (no contact details)', async () => {
  const ctx = await setup(); await ctx.engine.connect();
  const server = createServer(ctx.engine); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(b + '/')).text();
    assert.match(html, /id="palette"/); assert.match(html, /id="board"/); assert.match(html, /pv-logo\.png/); assert.match(html, /rel="icon"/);
    for (const f of ['/pv-logo.png', '/favicon.png', '/favicon.ico', '/apple-touch-icon.png']) {
      const r = await fetch(b + f); assert.equal(r.status, 200, f); assert.match(r.headers.get('content-type'), /image/);
    }
    const all = ['index.html', 'app.js', 'style.css'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8')).join('\n');
    assert.doesNotMatch(all, /@performance-video|\(303\)|386-2425/);
  } finally { server.closeClients(); await new Promise((r) => server.close(r)); await ctx.teardown(); }
});
