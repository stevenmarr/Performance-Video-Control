'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { setup, until } = require('./helpers');
const { createServer } = require('../lib/server');
const { P } = require('../lib/paths');
const { Live } = require('../lib/live');
const { memoryContent } = require('../lib/mock');

async function liveSetup(opts = {}) {
  const ctx = await setup({ liveEnabled: true, ...opts });
  await ctx.engine.connect();
  await ctx.engine.liveReady;
  return ctx;
}
const inputOf = (memId, layer = 1) => Number(/LIVE_(\d+)/.exec(memoryContent(memId, 'screen')[layer])[1]);

test('push mode: subscribes with derived 4.0+ paths (no $screenGroup)', async () => {
  const { mock, engine, teardown } = await liveSetup();
  try {
    assert.equal(engine.live.mode, 'push');
    const subs = [...mock.clients].map((c) => c.subs).find((s) => s.length);
    assert.ok(subs.includes(P.transition('S1')));
    assert.ok(subs.includes('DeviceObject/$screen/@items/S1/$preset/@items/A/$layer/@items/1/source'));
    assert.ok(subs.includes('DeviceObject/$auxiliary/@items/A1/$preset/@items/B/$layer/@items/NATIVE/source'));
    assert.ok(subs.includes('DeviceObject/presetBank/status/presetId'));
    assert.ok(!subs.some((s) => s.includes('$screenGroup')));
    assert.deepEqual(engine.live.raw.S1.layers, [1, 2, 3, 4]); // §3.5 capability probe
    assert.deepEqual(engine.live.raw.A1.layers, [1, 2]);
  } finally { await teardown(); }
});

test('external RC400T memory load + take update tally and last memory with no app polling', async () => {
  const { mock, engine, teardown } = await liveSetup();
  try {
    mock.history.length = 0;
    mock.external.loadMemory('S2', 11, 'preview'); // "IMAG L" loaded from the RC400T
    await until(() => engine.getState().live.tally.preview.includes(inputOf(11)), 2000, 'preview tally');
    let st = engine.getState();
    const d = st.destinations.find((x) => x.key === 'S2');
    assert.deepEqual(d.previewMemory, { id: 11, label: 'IMAG L' });
    assert.equal(st.live.tally.program.includes(inputOf(11)), false);
    assert.deepEqual(st.live.tally.inputs[inputOf(11)].preview, ['S2']);
    // nothing was requested by the app: the update arrived as a push notification
    assert.equal(mock.history.filter((h) => h.proto === 'awj' || h.proto === 'rest').length, 0);

    mock.external.take('S2');
    await until(() => engine.getState().live.tally.program.includes(inputOf(11)), 2000, 'program tally');
    st = engine.getState();
    assert.equal(st.live.destinations.S2.transition, 'AT_UP');
    assert.deepEqual(st.destinations.find((x) => x.key === 'S2').programMemory, { id: 11, label: 'IMAG L' });
    assert.equal(st.destinations.find((x) => x.key === 'S2').programLayer1, `Cam ${inputOf(11)}`.startsWith('Cam') ? st.live.inputs.find((i) => i.number === inputOf(11)).label : '');
    // TBAR now AT_UP: preview is side A (§3.8 table); an external source change on preview is tracked on A
    mock.external.setSource('S2', 'preview', 1, 'LIVE_12');
    await until(() => engine.live.raw.S2.A[1] === 'LIVE_12', 2000, 'side A update');
    assert.ok(engine.getState().live.tally.preview.includes(12));
  } finally { await teardown(); }
});

test('app preset tally follows the device (memory loaded outside the app)', async () => {
  const { mock, engine, teardown } = await liveSetup();
  try {
    await engine.savePreset({ number: 1, name: 'Keynote', destinations: ['S1'], memories: { S1: 10 } });
    await engine.savePreset({ number: 2, name: 'Floor', destinations: ['S4'], memories: { S4: 30 } });
    mock.external.loadMemory('S1', 10, 'preview');
    await until(() => engine.getState().presets.find((p) => p.number === 1).onPreview, 2000, 'preset 1 on PVW');
    assert.equal(engine.getState().tally.source, 'device-memory');
    mock.external.take('S1');
    await until(() => engine.getState().presets.find((p) => p.number === 1).onProgram, 2000, 'preset 1 on PGM');
    assert.deepEqual(engine.getState().programPresets, [1]);
    // operator loads something else on S1 preview from the Web RCS: preset 1 leaves PVW but stays on PGM
    mock.external.loadMemory('S1', 99, 'preview');
    await until(() => !engine.getState().presets.find((p) => p.number === 1).onPreview, 2000, 'preset 1 off PVW');
    assert.equal(engine.getState().presets.find((p) => p.number === 1).onProgram, true);
    // CUT uses the device's view of Preview: nothing of ours is on S1 PVW now
    engine.setSelection(['S1']);
    const r = await engine.cut();
    assert.deepEqual(r.skipped, ['S1']);
  } finally { await teardown(); }
});

test('Master memory: last loaded (§3.12) and labels (§3.7)', async () => {
  const { mock, engine, teardown } = await liveSetup();
  try {
    mock.external.loadMaster(2, 'preview');
    await until(() => engine.getState().live.lastMaster.preview, 2000, 'master preview');
    assert.deepEqual(engine.getState().live.lastMaster.preview, { id: 2, label: 'Keynote' });
    const mem = engine.live.memoriesView();
    assert.equal(mem.screen[10], 'Keynote'); assert.equal(mem.master[5], 'Awards'); assert.equal(mem.screen[3], undefined);
    // A Master load does not change the screens' presetBank/status/presetId (observed on the 6.2.79 simulator), so
    // S1's raw Preview id stays unset; the Master itself is reported through lastUsed (§3.12).
    assert.equal(mem.destinations.S1.preview, null);
    mock.external.setMemoryLabel(3, 'New Look');
    await until(() => engine.live.memoriesView().screen[3] === 'New Look', 2000, 'label push');
  } finally { await teardown(); }
});

test('inputs (§6.1): label, enabled, available, capability, scope, freeze toggle (inferred write)', async () => {
  const { mock, engine, teardown } = await liveSetup();
  try {
    const ins = engine.live.inputsView();
    const i1 = ins.find((i) => i.number === 1);
    assert.deepEqual([i1.label, i1.isEnabled, i1.isAvailable, i1.capability, i1.scope, i1.device, i1.freeze], ['Cam 1 Wide', true, true, '4K', 'GLOBAL', '1', false]);
    assert.equal(ins.find((i) => i.number === 8).isEnabled, false);
    assert.equal(ins.find((i) => i.number === 6).isAvailable, false);
    mock.history.length = 0;
    await engine.live.setFreeze(3);
    assert.equal(mock.get(P.input.freeze(3)), true);
    assert.ok(mock.history.some((h) => h.op === 'replace' && h.path === 'DeviceObject/$input/@items/IN_3/control/@props/freeze' && h.value === true));
    assert.equal(engine.live.inputsView().find((i) => i.number === 3).freeze, true);
    await engine.live.setFreeze(3, false); assert.equal(mock.get(P.input.freeze(3)), false);
    mock.external.setAvailable(2, false);
    await until(() => engine.live.inputsView().find((i) => i.number === 2).isAvailable === false, 2000, 'signal loss push');
    mock.external.setInputLabel(1, 'Cam 1 Wide (L)');
    await until(() => engine.live.inputsView()[0].label === 'Cam 1 Wide (L)', 2000, 'input label push');
  } finally { await teardown(); }
});

test('backups (§6.4-6.11): sources, trigger, mode, active state', async () => {
  const { mock, engine, teardown } = await liveSetup();
  try {
    let b = engine.live.backupView();
    const i4 = b.inputs.find((i) => i.number === 4);
    assert.deepEqual(i4.slots, { 1: 'LIVE_9', 2: 'STILL_1' }); assert.equal(i4.active, false);
    await engine.live.inputBackupSelect(4, '1');
    assert.equal(mock.get(P.inputBackupSelect(4)), '1');
    assert.equal(engine.live.backupView().inputs.find((i) => i.number === 4).active, true);
    await engine.live.inputBackupMode(4, true); assert.equal(mock.get(P.inputBackupAuto(4)), true);
    await engine.live.inputBackupSelect(4, 'NONE');
    assert.equal(engine.live.backupView().inputs.find((i) => i.number === 4).active, false);
    b = engine.live.backupView();
    assert.equal(b.backgrounds.find((x) => x.screen === 'S1' && x.set === 1).slots[1], 'NATIVE_2');
    await engine.live.bgBackupSelect('S1', 1, '1'); assert.equal(mock.get(P.bgBackupSelect('S1', 1)), '1');
    await engine.live.bgBackupMode('S1', 1, true); assert.equal(mock.get(P.bgBackupAuto('S1', 1)), true);
    // 0.4.0: only groups that exist (status/isEnabled); group 2 was deleted on the device
    assert.deepEqual(engine.live.backupView().groups.map((g) => g.group), [1]);
    await engine.live.groupBackupSelect(1, '2'); assert.equal(mock.get(P.groupBackupSelect(1)), '2');
    await engine.live.groupBackupMode(1, true); assert.equal(mock.get(P.groupBackupAuto(1)), true);
    assert.equal(engine.live.backupView().groups.find((g) => g.group === 1).active, true);
    assert.throws(() => engine.live.groupBackupSelect(2, '1'), /doesn't exist/);
    assert.throws(() => engine.live.bgBackupMode('S2', 3, true), /no backup on the device/);
    assert.throws(() => engine.live.groupBackupSelect(1, '3'), /NONE, 1 or 2/);
  } finally { await teardown(); }
});

test('audio mutes (§5.1-5.2): read, toggle, external change', async () => {
  const { mock, engine, teardown } = await liveSetup();
  try {
    const a = engine.live.audioView();
    assert.equal(a.inputs.length, 4); assert.equal(a.inputs[0].channels.length, 8); assert.equal(a.outputs.length, 4);
    await engine.live.audioMute('in', 2, 3);
    assert.equal(mock.get(P.audioInMute(2, 3)), true);
    await engine.live.audioMute('out', 4, 3, true);
    assert.equal(mock.get('DeviceObject/audio/control/$device/@items/1/$tx/@items/OUTPUT_4/$channel/@items/3/control/@props/mute'), true);
    mock.external.setMute('out', 1, 1, true);
    await until(() => engine.live.audioView().outputs[0].channels[0].mute === true, 2000, 'mute push');
  } finally { await teardown(); }
});

test('fallback: subscription rejected -> AWJ polling picks up external changes', async () => {
  const ctx = await setup({ liveEnabled: true, pollMs: 80 });
  ctx.mock.subscriptionsSupported = false;
  try {
    await ctx.engine.connect(); await ctx.engine.liveReady;
    assert.equal(ctx.engine.live.mode, 'poll-awj');
    ctx.mock.external.loadMemory('S3', 12, 'preview');
    await until(() => (ctx.engine.getState().destinations.find((d) => d.key === 'S3').previewMemory || {}).id === 12, 2000, 'polled memory');
  } finally { await ctx.teardown(); }
});

test('fallback: AWJ unreachable -> REST layer-status polling (tally only); AWJ-only controls refuse', async () => {
  const blocker = net.createServer(); await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const deadPort = blocker.address().port; await new Promise((r) => blocker.close(r));
  const ctx = await setup({ liveEnabled: true, pollMs: 80, extra: { awjPort: deadPort, awjRetryMs: 100000 } });
  try {
    await ctx.engine.connect(); await ctx.engine.liveReady;
    assert.equal(ctx.engine.live.mode, 'poll-rest');
    ctx.mock.external.loadMemory('S1', 5, 'preview');
    await until(() => ctx.engine.getState().live.tally.preview.includes(inputOf(5)), 2000, 'REST polled tally');
    await until(() => ctx.engine.getState().live.inputs.find((i) => i.number === 1), 2000, 'REST inputs');
    const st = ctx.engine.getState();
    assert.equal(st.live.hasMemoryInfo, false);
    assert.equal(st.live.inputs.find((i) => i.number === 1).label, 'Cam 1 Wide'); // REST p.66
    await assert.rejects(ctx.engine.live.setFreeze(1), /needs the AWJ connection/);
  } finally { await ctx.teardown(); }
});

test('AWJ drop -> REST polling, then reconnect -> push again', async () => {
  const ctx = await setup({ liveEnabled: true, pollMs: 80, extra: { awjRetryMs: 150 } });
  try {
    await ctx.engine.connect(); await ctx.engine.liveReady;
    assert.equal(ctx.engine.live.mode, 'push');
    ctx.mock.dropAwjClients();
    await until(() => ctx.engine.live.mode === 'poll-rest', 2000, 'fallback after drop');
    await until(() => ctx.engine.live.mode === 'push', 4000, 'back to push');
    ctx.mock.external.loadMemory('A1', 7, 'preview');
    await until(() => (ctx.engine.getState().destinations.find((d) => d.key === 'A1').previewMemory || {}).id === 7, 2000, 'push after reconnect');
  } finally { await ctx.teardown(); }
});

test('ingest flattens object-level notifications', () => {
  const L = new Live({ device: { awj: {}, rest: {} }, settings: {}, log: () => {} });
  L.raw.S1 = { transition: null, layers: [1], A: {}, B: {}, mem: {} };
  L.dests = ['S1'];
  assert.equal(L.ingest('DeviceObject/$screen/@items/S1/$preset/@items/B', { $layer: { '@items': { 1: { source: { '@props': { inputNum: 'LIVE_7' } } } } } }), true);
  assert.equal(L.raw.S1.B[1], 'LIVE_7');
  assert.equal(L.ingest('DeviceObject/somethingElse', 1), false);
});

test('HTTP: live endpoints, POST controls and long-poll', async () => {
  const ctx = await liveSetup();
  const server = createServer(ctx.engine);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json() }; };
  try {
    assert.equal((await call('GET', '/api/live')).json.mode, 'push');
    assert.ok((await call('GET', '/api/inputs')).json.length >= 12);
    assert.ok((await call('GET', '/api/memories')).json.screen[10]);
    assert.ok((await call('GET', '/api/backup')).json.groups.length);
    assert.equal((await call('GET', '/api/audio')).json.inputs.length, 4);
    assert.ok((await call('GET', '/api/tally')).json.destinations.S1);
    assert.equal((await call('POST', '/api/inputs/5/freeze', {})).json.ok, true); assert.equal(ctx.mock.get(P.input.freeze(5)), true);
    await call('POST', '/api/inputs/4/backup', { slot: '2' }); assert.equal(ctx.mock.get(P.inputBackupSelect(4)), '2');
    await call('POST', '/api/inputs/4/backup/mode', { auto: true }); assert.equal(ctx.mock.get(P.inputBackupAuto(4)), true);
    await call('POST', '/api/backgrounds/S1/1/backup', { slot: '1' }); assert.equal(ctx.mock.get(P.bgBackupSelect('S1', 1)), '1');
    await call('POST', '/api/backgrounds/S1/1/backup/mode', { auto: true }); assert.equal(ctx.mock.get(P.bgBackupAuto('S1', 1)), true);
    await call('POST', '/api/groups/1/backup', { slot: '1' }); assert.equal(ctx.mock.get(P.groupBackupSelect(1)), '1');
    await call('POST', '/api/groups/1/backup/mode', { auto: true }); assert.equal(ctx.mock.get(P.groupBackupAuto(1)), true);
    assert.equal((await call('POST', '/api/groups/3/backup', { slot: '1' })).status, 404); // no such group on the device
    assert.equal((await call('POST', '/api/backgrounds/S2/1/backup', { slot: '1' })).status, 404); // no backup there
    await call('POST', '/api/audio/inputs/1/channels/2/mute', {}); assert.equal(ctx.mock.get(P.audioInMute(1, 2)), true);
    await call('POST', '/api/audio/outputs/2/channels/1/mute', { value: true }); assert.equal(ctx.mock.get(P.audioOutMute(2, 1)), true);
    assert.equal((await call('POST', '/api/groups/1/backup', { slot: 'X' })).status, 409);

    // long-poll: wait for the next change, triggered from "the RC400T"
    const rev = (await call('GET', '/api/state')).json.rev;
    const t0 = Date.now();
    const pending = call('GET', `/api/state?since=${rev}&timeout=5000`);
    setTimeout(() => ctx.mock.external.loadMemory('S4', 30, 'preview'), 100);
    const lp = await pending;
    assert.ok(lp.json.rev > rev); assert.ok(Date.now() - t0 < 2000);
    await until(async () => ((await call('GET', '/api/state')).json.destinations.find((d) => d.key === 'S4').previewMemory || {}).id === 30, 2000, 'S4 memory');
    // long-poll timeout path
    const cur = (await call('GET', '/api/state')).json.rev;
    const t1 = Date.now(); const idle = await call('GET', `/api/state?since=${cur + 1000}&timeout=150`);
    assert.ok(Date.now() - t1 >= 140); assert.equal(idle.status, 200);
  } finally { server.closeClients(); await new Promise((r) => server.close(r)); await ctx.teardown(); }
});
