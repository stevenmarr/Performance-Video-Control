'use strict';
// 0.4.0 regressions (Steven): "in the inputs, backup and audio pane we don't need screen destinations or the take
// commands or presets to show up. Remove the layer preset option. make an option to move presets (swap button
// locations) what is the point of save between recall and edit? Group backups should reference the label assigned
// and there are old backup lists that have been deleted already showing up in the backups pane. Would it be possible
// to have the Web RCS show up in a pane in the application". Browser-side checks are in ui.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setup, until, restCalls, awjCalls } = require('./helpers');
const { createServer } = require('../lib/server');
const { framingVerdict } = require('../lib/engine');
const { P } = require('../lib/paths');
const L = require('../lib/live');

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
  try { await fn(call, { ...ctx, base }); } finally { server.closeClients(); await new Promise((r) => server.close(r)); await ctx.teardown(); }
}
const names = (st) => Object.fromEntries(st.presets.map((p) => [p.number, p.name]));

// ---------- 3. move / swap presets ----------
test('swap: two tiles trade numbers; move: a preset goes to an empty tile; persisted', async () => {
  await withApp({}, async (call, { engine, dataDir }) => {
    await engine.savePreset({ number: 1, name: 'A', destinations: ['S1'], memories: { S1: 7 } });
    await engine.savePreset({ number: 2, name: 'B', destinations: ['S2'], memories: { S2: 3 } });
    let r = await call('POST', '/api/presets/swap', { a: 1, b: 2 });
    assert.equal(r.status, 200); assert.equal(r.json.swapped, true);
    let st = (await call('GET', '/api/state')).json;
    assert.deepEqual(names(st), { 1: 'B', 2: 'A' });
    assert.deepEqual(st.presets.find((p) => p.number === 1).destinations, ['S2'], 'contents travel with the preset');
    r = await call('POST', '/api/presets/swap', { from: 2, to: 13 }); // empty target -> move
    assert.equal(r.json.moved, true);
    st = (await call('GET', '/api/state')).json;
    assert.deepEqual(names(st), { 1: 'B', 13: 'A' });
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, fs.readdirSync(dataDir).find((f) => /preset/i.test(f) && f.endsWith('.json'))), 'utf8'));
    assert.ok(JSON.stringify(onDisk).includes('"number":13'), 'saved to disk');
    // moving from an empty tile onto a used one also works (drag direction does not matter)
    r = await call('POST', '/api/presets/swap', { a: 5, b: 1 });
    assert.deepEqual(names((await call('GET', '/api/state')).json), { 5: 'B', 13: 'A' });
  });
});

test('swap errors: same tile, both empty, out of range; no device traffic', async () => {
  await withApp({}, async (call, { engine, mock }) => {
    await engine.savePreset({ number: 1, name: 'A', destinations: ['S1'], memories: { S1: 7 } });
    mock.history.length = 0;
    assert.equal((await call('POST', '/api/presets/swap', { a: 1, b: 1 })).status, 400);
    assert.equal((await call('POST', '/api/presets/swap', { a: 3, b: 4 })).status, 400);
    assert.equal((await call('POST', '/api/presets/swap', { a: 0, b: 1 })).status, 400);
    assert.equal((await call('POST', '/api/presets/swap', { a: 1, b: 'x' })).status, 400);
    await call('POST', '/api/presets/swap', { a: 1, b: 2 });
    const writes = (h) => (h.proto === 'rest' && h.op !== 'GET') || (h.proto === 'awj' && h.op !== 'get' && h.path !== 'Subscriptions') || h.proto === 'state';
    assert.deepEqual(mock.history.filter(writes), [], 'rearranging never writes to the device');
    await call('POST', '/api/presets/2/recall'); // control: a recall IS seen as device traffic by the filter
    assert.ok(mock.history.filter(writes).length > 0);
  });
});

test('swap keeps PVW/PGM tally and last-recalled with the preset (Companion follows the tile)', async () => {
  await withApp({}, async (call, { engine }) => {
    await engine.savePreset({ number: 1, name: 'A', destinations: ['S1'], memories: { S1: 7 } });
    await engine.savePreset({ number: 2, name: 'B', destinations: ['S2'], memories: { S2: 3 } });
    await call('POST', '/api/presets/1/recall');
    const before = (await call('GET', '/api/state')).json;
    assert.equal(before.lastRecalled.number, 1);
    await call('POST', '/api/presets/swap', { a: 1, b: 2 });
    const st = (await call('GET', '/api/state')).json;
    assert.equal(st.lastRecalled.number, 2, 'A is now tile 2 and is still the one on preview');
    assert.equal(st.lastRecalled.name, 'A');
    assert.notEqual(st.presets.find((p) => p.number === 2).tally.pvw, 'none');
    assert.equal(st.presets.find((p) => p.number === 1).tally.pvw, 'none');
  });
});

// ---------- 2. Layer memories removed ----------
test('Layer memories are gone: no layer bank reads, no layer type, stale setting dropped', async () => {
  await withApp({ liveEnabled: true, extra: { layerMemories: true } }, async (call, { engine, mock }) => {
    const all = mock.history.map((h) => h.path || '').join('\n');
    assert.doesNotMatch(all, /layerBank|layerMemory|\$layerMemory/i);
    assert.equal(engine.settings.layerMemories, undefined);
    const cat = (await call('GET', '/api/memories/catalog')).json;
    assert.deepEqual(Object.keys(cat.items).sort(), ['master', 'multiviewer', 'screen']);
    const r = await call('POST', '/api/memories/load', { type: 'layer', slot: 1, dest: 'S1' });
    assert.equal(r.status, 400);
    assert.doesNotMatch(JSON.stringify((await call('GET', '/api/settings')).json || {}), /layerMemories/);
  });
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  assert.doesNotMatch(html + js, /layerMemories|dlgLayer|LAYER MEM/i);
  assert.equal(typeof P.layerMemoryLabel, 'undefined');
});

// ---------- 5. backups: only what exists, group labels, live updates ----------
test('backups pane lists only enabled backups and existing groups, with the device label', async () => {
  await withApp({ liveEnabled: true }, async (call) => {
    const b = (await call('GET', '/api/backup')).json;
    assert.deepEqual(b.inputs.map((i) => i.number), [4, 5]);
    assert.ok(!b.inputs.some((i) => i.number === 9), 'IN 9 was deleted on the device (stale xSelectSlot) and stays hidden');
    assert.deepEqual(b.groups.map((g) => g.group), [1], 'disabled group 2 "OLD SET" and never-created groups are hidden');
    const g = b.groups[0];
    assert.equal(g.label, 'MEDIA BU'); assert.equal(g.customLabel, 'MEDIA BU');
    assert.deepEqual(g.members.map((m) => `${m.kind}:${m.id}`).sort(), ['bg:S1/1', 'input:5']);
    assert.equal(b.inputs.find((i) => i.number === 5).groupLabel, 'MEDIA BU');
    assert.deepEqual(b.backgrounds.map((x) => `${x.screen}/${x.set}`), ['S1/1']);
  });
});

test('deleting / adding / renaming on the device updates the pane live (push), nothing stale', async () => {
  await withApp({ liveEnabled: true }, async (call, { engine, mock }) => {
    const view = () => engine.live.backupView();
    mock.deleteInputBackup(4);
    await until(() => !view().inputs.some((i) => i.number === 4), 3000, 'IN 4 gone');
    mock.deleteBgBackup('S1', 1);
    await until(() => view().backgrounds.length === 0, 3000, 'S1/1 gone');
    mock.renameGroup(1, 'MAIN BU');
    await until(() => view().groups[0] && view().groups[0].label === 'MAIN BU', 3000, 'rename');
    mock.deleteGroup(1);
    await until(() => view().groups.length === 0, 3000, 'group 1 gone');
    assert.equal(view().inputs.find((i) => i.number === 5).group, null, 'members fall back to no group');
    mock.addInputBackup(7, 'LIVE_8');
    mock.createGroup(3, 'NEW GRP', { inputs: [7] });
    await until(() => view().inputs.some((i) => i.number === 7) && view().groups.some((g) => g.group === 3), 3000, 'new set + group');
    const g3 = view().groups.find((g) => g.group === 3);
    assert.equal(g3.label, 'NEW GRP'); assert.deepEqual(g3.members.map((m) => m.id), [7]);
    // the HTTP view agrees, and writes to deleted items are refused (no write is sent)
    const b = (await call('GET', '/api/backup')).json;
    assert.deepEqual(b.groups.map((g) => g.group), [3]);
    mock.history.length = 0;
    assert.equal((await call('POST', '/api/groups/1/backup', { slot: '1' })).status, 404);
    assert.equal((await call('POST', '/api/inputs/4/backup', { slot: '1' })).status, 404);
    assert.equal((await call('POST', '/api/backgrounds/S1/1/backup/mode', { auto: true })).status, 404);
    assert.deepEqual(awjCalls(mock, /xSelectSlot|enableAutoSelect/).filter((h) => h.op !== 'get'), [], 'no write sent');
    assert.deepEqual(restCalls(mock, /backup/).filter((h) => h.op !== 'GET'), []);
  });
});

test('active slot comes from status/activeSlot, not the xSelectSlot request', async () => {
  await withApp({ liveEnabled: true }, async (call, { engine, mock }) => {
    const in5 = () => engine.live.backupView().inputs.find((i) => i.number === 5);
    assert.equal(in5().active, false);
    mock.set(P.inputBackupSelect(5), '2'); // a request on its own...
    mock.set(P.inputBackupActive(5), 'NONE'); // ...that the device did not apply
    await until(() => engine.live.backupView().inputs.find((i) => i.number === 5).requested === '2', 3000, 'request seen');
    assert.equal(in5().active, false, 'activeSlot NONE wins');
    mock.set(P.inputBackupActive(5), '1');
    await until(() => in5().active === true, 3000, 'active');
    assert.equal(String(in5().selected), '1');
    // a select through the app sets the device's active slot and the view follows
    await call('POST', '/api/groups/1/backup', { slot: '2' });
    await until(() => engine.live.backupView().groups[0].active === true, 3000, 'group active');
    assert.equal(mock.get(P.groupActive(1)), '2');
  });
});

// ---------- 6. Web RCS pane ----------
test('framingVerdict', () => {
  assert.equal(framingVerdict(200, {}).framable, true); // the real RS6 6.2.73 sends neither header
  assert.equal(framingVerdict(200, { 'x-frame-options': 'DENY' }).framable, false);
  assert.equal(framingVerdict(200, { 'x-frame-options': 'SAMEORIGIN' }).framable, false);
  assert.equal(framingVerdict(200, { 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }).framable, false);
  assert.equal(framingVerdict(200, { 'content-security-policy': "default-src 'self'" }).framable, true);
  assert.equal(framingVerdict(200, { 'content-security-policy': 'frame-ancestors *' }).framable, true);
  assert.deepEqual(framingVerdict(200, { 'x-frame-options': 'DENY' }).blockedBy, ['X-Frame-Options: DENY']);
});

test('GET /api/webrcs checks the device root headers (read-only) and reports framable', async () => {
  await withApp({}, async (call, { mock, restPort, base }) => {
    let r = (await call('GET', '/api/webrcs')).json;
    assert.equal(r.url, `http://127.0.0.1:${restPort}/`);
    assert.equal(r.reachable, true); assert.equal(r.framable, true); assert.equal(r.status, 200);
    const page = await (await fetch(r.url)).text();
    assert.match(page, /Web RCS/);
    mock.webRcsHeaders = { 'X-Frame-Options': 'DENY' };
    r = (await call('GET', '/api/webrcs')).json;
    assert.equal(r.framable, false); assert.deepEqual(r.blockedBy, ['X-Frame-Options: DENY']);
    mock.webRcsHeaders = { 'Content-Security-Policy': "frame-ancestors 'self'" };
    assert.equal((await call('GET', '/api/webrcs')).json.framable, false);
    assert.deepEqual(restCalls(mock, /^\/api\/.*(load|take|cut)/i).length, 0);
    void base;
  });
});

test('GET /api/webrcs when the device is unreachable', async () => {
  await withApp({}, async (call, { engine }) => {
    engine.settings.host = '127.0.0.1'; engine.settings.restPort = 1; // nothing listens there
    const r = (await call('GET', '/api/webrcs')).json;
    assert.equal(r.reachable, false); assert.equal(r.framable, null);
  });
});

test('webRcsUrl omits default ports and honours https', async () => {
  await withApp({}, async (_call, { engine }) => {
    Object.assign(engine.settings, { host: '10.0.0.50', restPort: 80, https: false });
    assert.equal(engine.webRcsUrl(), 'http://10.0.0.50/');
    Object.assign(engine.settings, { restPort: 8080 });
    assert.equal(engine.webRcsUrl(), 'http://10.0.0.50:8080/');
    Object.assign(engine.settings, { restPort: 443, https: true });
    assert.equal(engine.webRcsUrl(), 'https://10.0.0.50/');
  });
});

// ---------- 4. SAVE is labelled for what it does ----------
test('SAVE / board-save labels say what they store', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, /SAVE PVW → TILE/);
  assert.match(html, /SAVE BOARD AS PRESET/);
  assert.match(html, /data-mode="move"/);
  for (const m of ['recall', 'edit', 'move', 'save']) assert.match(html, new RegExp(`data-mode="${m}"[^>]*title="[^"]{20,}"`), `${m} has a tooltip`);
  void L;
});
