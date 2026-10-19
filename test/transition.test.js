'use strict';
// 0.3.1: TAKE / CUT / transition targets, against a mock that answers like the LivePremier Simulator
// 6.2.79 did on 2026-10-19 (see lib/mock.js take()). Regression tests for:
//  1. "the transition doesn't seem to work": the take reached the device, but the app's tally and memory
//     indicators said otherwise, because the device does not update presetId on the new Preview side and
//     does not move Master lastUsed to PROGRAM on a TAKE.
//  2. "screen selection doesn't update the transition screens": TAKE/CUT must act on exactly the selected
//     destinations, whatever the protocol, and the state must say which destinations will transition.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { setup, restCalls, awjCalls, until } = require('./helpers');
const { P } = require('../lib/paths');

async function live(opts = {}) {
  const ctx = await setup({ liveEnabled: true, ...opts });
  await ctx.engine.connect(); await ctx.engine.liveReady;
  return ctx;
}
const dest = (st, k) => st.destinations.find((d) => d.key === k);
const preset = (st, n) => st.presets.find((p) => p.number === n);
const sides = (mock) => Object.fromEntries(mock.destKeys.map((k) => [k, mock.get(P.transition(k))]));
const flipped = (before, after) => Object.keys(before).filter((k) => before[k] !== after[k]).sort();

// raw REST helper (to check the mock answers like the simulator)
function rest(port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...headers }; if (data) { h['Content-Length'] = data.length; if (!('Content-Type' in h)) h['Content-Type'] = 'application/json'; } else h['Content-Length'] = 0;
    for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
    const req = http.request({ host: '127.0.0.1', port, method, path: '/api/tpp/v1' + path, headers: h }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

test('mock /take answers like the 6.2.79 simulator (missing list = all, empty list = none, 400s)', async () => {
  const { mock, restPort, teardown } = await setup();
  try {
    const t = async (body, headers) => { const b = sides(mock); const r = await rest(restPort, 'POST', '/take', body, headers); return { status: r.status, body: r.body, flipped: flipped(b, sides(mock)) }; };
    assert.deepEqual((await t({ screenIds: [1], auxiliaryScreenIds: [] })).flipped, ['S1']);
    assert.deepEqual((await t({ screenIds: [], auxiliaryScreenIds: [2] })).flipped, ['A2']);
    assert.deepEqual((await t({ screenIds: [1] })).flipped, ['A1', 'A2', 'S1']);             // no aux key -> every aux
    assert.deepEqual((await t({ 'auxiliaryScreenIds ': [1] })).flipped, ['A1', 'A2', 'S1', 'S2', 'S3', 'S4']); // the guide's raw example key (trailing space) is ignored
    assert.deepEqual((await t('{"screenIds":[2]}', { 'Content-Type': null })).flipped, ['A1', 'A2', 'S1', 'S2', 'S3', 'S4']); // no Content-Type: body ignored
    const bad = await t({ screenIds: 2 }); assert.equal(bad.status, 400); assert.match(bad.body, /Expected an Array of Integers between 1 and 24/); assert.deepEqual(bad.flipped, []);
    const oor = await t({ screenIds: [0] }); assert.equal(oor.status, 400); assert.match(oor.body, /out of range/);
    const s0 = await rest(restPort, 'POST', '/screens/0/take'); assert.equal(s0.status, 400);
    const s25 = await rest(restPort, 'POST', '/screens/25/take'); assert.equal(s25.status, 400);
  } finally { await teardown(); }
});

test('TAKE sends the documented commands byte for byte (REST §3.11 body, AWJ §3.2 frame)', async () => {
  const { mock, engine, teardown } = await setup();
  try {
    await engine.connect();
    engine.setSelection(['S1', 'S3', 'A2']); await engine.take();
    const r = restCalls(mock, /^\/api\/tpp\/v1\/take$/).pop();
    assert.equal(JSON.stringify(r.body), '{"screenIds":[1,3],"auxiliaryScreenIds":[2]}');
  } finally { await teardown(); }
  const a = await setup({ protocol: 'awj' });
  try {
    await a.engine.connect();
    const frames = []; const orig = a.engine.device.awj.replace.bind(a.engine.device.awj);
    a.engine.device.awj.replace = (path, value, ...rest) => { frames.push(JSON.stringify({ op: 'replace', path, value })); return orig(path, value, ...rest); };
    a.engine.setSelection(['S1', 'A1']); await a.engine.take();
    // AWJ guide §3.2 p.9 prints: {"op":"replace","path":"DeviceObject/$screenAuxGroup/@items/S1/control/@props/xTake","value":true}
    assert.deepEqual(frames, ['{"op":"replace","path":"DeviceObject/$screenAuxGroup/@items/S1/control/@props/xTake","value":true}',
      '{"op":"replace","path":"DeviceObject/$screenAuxGroup/@items/A1/control/@props/xTake","value":true}']);
  } finally { await a.teardown(); }
});

for (const protocol of ['rest', 'awj']) {
  test(`[${protocol}] TAKE and CUT act on exactly the selected destinations after the selection changes`, async () => {
    const { mock, engine, teardown } = await live({ protocol });
    try {
      await engine.savePreset({ number: 1, name: 'Wide', destinations: ['S1', 'S2', 'A1'], memories: { S1: 10, S2: 11, A1: 42 } });
      await engine.recall(1);
      assert.deepEqual(engine.getState().selection, ['S1', 'S2', 'A1']);
      engine.toggleDest('S2'); engine.toggleDest('A2');                         // operator changes the selection
      const st = engine.getState();
      assert.deepEqual(st.transitionTargets, ['S1', 'A1', 'A2']);
      assert.deepEqual(st.destinations.filter((d) => d.willTransition).map((d) => d.key), ['S1', 'A1', 'A2']);
      let b = sides(mock); await engine.take();
      assert.deepEqual(flipped(b, sides(mock)), ['A1', 'A2', 'S1']);            // S2 stays, nothing else moves
      engine.setSelection(['S2']);
      b = sides(mock); await engine.cut();
      assert.deepEqual(flipped(b, sides(mock)), []);                             // CUT = program load, no TBAR move
      assert.equal(mock.side('S2', 'program').presetId, 11);                     // ...on S2 only
      assert.equal(mock.side('S1', 'program').presetId, 10);
    } finally { await teardown(); }
  });
}

test('after a TAKE the app shows the preset on Program and the copied look on Preview (device keeps stale presetId)', async () => {
  const { mock, engine, teardown } = await live();
  try {
    await engine.savePreset({ number: 1, name: 'Keynote', destinations: ['S1'], memories: { S1: 10 } });
    await engine.savePreset({ number: 2, name: 'IMAG', destinations: ['S1'], memories: { S1: 11 } });
    await engine.recall(1); await engine.take();
    await until(() => preset(engine.getState(), 1).tally.pgm === 'full', 2000, 'preset 1 on PGM');
    await engine.recall(2);
    await until(() => preset(engine.getState(), 2).tally.pvw === 'full', 2000, 'preset 2 on PVW');
    await engine.take();
    await until(() => preset(engine.getState(), 2).tally.pgm === 'full', 2000, 'preset 2 on PGM');
    const st = engine.getState();
    // Preset Toggle off: the device copies Program back to Preview, so Preview now shows memory 11 too,
    // even though the device still reports presetId 10 for that side.
    assert.equal(mock.side('S1', 'preview').presetId, 10);
    assert.deepEqual(dest(st, 'S1').previewMemory && dest(st, 'S1').previewMemory.id, 11);
    assert.equal(preset(st, 1).tally.pvw, 'none', 'preset 1 must not come back on Preview after the take');
    assert.equal(dest(st, 'S1').pgmPreset, 2);
  } finally { await teardown(); }
});

for (const [name, opts] of [['app setting', { presetToggle: true }], ['device copyMode read (memoryProbe)', { extra: { memoryProbe: true } }]]) test(`Preset Toggle on (${name}): Program and Preview swap`, async () => {
  const { mock, engine, teardown } = await live(opts);
  try {
    await engine.savePreset({ number: 1, name: 'A', destinations: ['S1'], memories: { S1: 10 } });
    await engine.savePreset({ number: 2, name: 'B', destinations: ['S1'], memories: { S1: 11 } });
    for (const k of mock.destKeys) mock.external.setPresetToggle(k, true);
    await engine.recall(1); await engine.take(); await engine.recall(2); await engine.take();
    await until(() => preset(engine.getState(), 2).tally.pgm === 'full' && preset(engine.getState(), 1).tally.pvw === 'full', 2000, 'swap');
  } finally { await teardown(); }
});

test('the periodic full re-read does not bring the stale Preview id back', async () => {
  const { engine, teardown } = await live();
  try {
    await engine.savePreset({ number: 1, name: 'A', destinations: ['S1'], memories: { S1: 10 } });
    await engine.savePreset({ number: 2, name: 'B', destinations: ['S1'], memories: { S1: 11 } });
    await engine.recall(1); await engine.take(); await engine.recall(2); await engine.take();
    await until(() => preset(engine.getState(), 2).tally.pgm === 'full', 2000, 'B on PGM');
    await engine.live.readAll(engine.live.gen);
    const st = engine.getState();
    assert.equal(preset(st, 1).tally.pvw, 'none'); assert.equal(dest(st, 'S1').previewMemory.id, 11);
  } finally { await teardown(); }
});

test('Master preset: TAKE puts the Master on Program (device lastUsed PROGRAM does not move)', async () => {
  const { mock, engine, teardown } = await live();
  try {
    engine.assignToPreset(5, { target: 'master', type: 'master', slot: 2, dests: ['S1', 'S2', 'S3'] });
    await engine.recall(5);
    assert.deepEqual(engine.getState().selection, ['S1', 'S2', 'S3']);          // only the Master's screens
    await until(() => preset(engine.getState(), 5).tally.pvw === 'full', 2000, 'master on PVW');
    const b = sides(mock); await engine.take();
    assert.deepEqual(flipped(b, sides(mock)), ['S1', 'S2', 'S3']);
    await until(() => preset(engine.getState(), 5).tally.pgm === 'full', 2000, 'master on PGM');
    assert.equal(mock.get(P.lastMasterMemory('program')), 0);                   // the device never said so
    assert.equal(engine.getState().master.program, 2);
    assert.equal(engine.getState().live.lastMaster.program.id, 2);
  } finally { await teardown(); }
});

test('external TAKE (RC400T / Web RCS) with a real Take duration is followed', async () => {
  const { mock, engine, teardown } = await live();
  try {
    mock.takeDelayMs = 150;
    await engine.savePreset({ number: 1, name: 'A', destinations: ['S2'], memories: { S2: 20 } });
    await engine.recall(1);
    mock.external.take('S2');
    assert.equal(preset(engine.getState(), 1).tally.pgm, 'none');               // still transitioning
    await until(() => preset(engine.getState(), 1).tally.pgm === 'full', 2000, 'after the duration');
    assert.equal(dest(engine.getState(), 'S2').previewMemory.id, 20);
  } finally { await teardown(); }
});

test('a TAKE of a screen whose Preview holds a Screen memory does not move the Master on Preview', async () => {
  const { mock, engine, teardown } = await live();
  try {
    mock.external.loadMaster(3, 'preview');                                     // someone else loaded Master 3
    await until(() => engine.getState().master.preview === 3, 2000, 'master pvw');
    await engine.savePreset({ number: 1, name: 'S4 only', destinations: ['S4'], memories: { S4: 30 } });
    await engine.recall(1); await engine.take();
    await until(() => preset(engine.getState(), 1).tally.pgm === 'full', 2000, 'S4 taken');
    assert.equal(engine.getState().master.program, null);
  } finally { await teardown(); }
});
