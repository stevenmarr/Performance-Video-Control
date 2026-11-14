'use strict';
// E2 CUT / TAKE: official Event Master JSON-RPC (R5919184/02 p.29-30: allTrans is
// TAKE, cut is CUT; they run on armed destinations, so armUnarmDestination is
// sent first) through the HTTP routes, SystemManager, the USB Stream Deck path,
// and a mock E2 JSON-RPC server. No test contacts a real device.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { setup } = require('./helpers');
const { createServer } = require('../lib/server');
const { SystemManager } = require('../lib/systems');
const { MockE2 } = require('../lib/mocks/e2');
const { DeckService } = require('../lib/decks/service');
const { actionToRequest } = require('../lib/decks/page-push');
const { show, applySwitcherDestinations } = require('../lib/decks/faces');
const { SURFACES } = require('../lib/decks/surfaces');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2ct-'));
function fakeEngine() {
  return { settings: { host: '192.0.2.10', restPort: 80, awjPort: 10600, protocol: 'rest' }, presets: [], destinations: [], live: { inputs: {} }, log() {}, changed() {} };
}

async function liveE2(extra = {}) {
  const dir = tmp();
  const mock = new MockE2();
  const port = await mock.start(0);
  const sm = new SystemManager({ dataDir: dir, engine: fakeEngine(), overrides: { e2: { host: '127.0.0.1', port } }, autoStart: false, ...extra });
  await sm.setActive('e2');
  await sm.connect('e2');
  return {
    dir, mock, sm, port,
    async stop() { await sm.close(); await mock.stop(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('E2 TAKE/CUT refuse when nothing is selected and no preset was recalled', async () => {
  const ctx = await liveE2();
  try {
    assert.deepEqual(ctx.sm.sess('e2').selection, [], 'session starts with no dests picked');
    const v = ctx.sm.view('e2');
    assert.deepEqual(v.takeTargets, []);
    assert.equal(v.takeWarning, 'Nothing armed: select destinations or recall a preset first');
    await assert.rejects(ctx.sm.take('e2'), /Nothing armed: select destinations or recall a preset first/);
    await assert.rejects(ctx.sm.cut('e2'), /Nothing armed: select destinations or recall a preset first/);
    assert.equal(ctx.mock.calls('allTrans').length, 0, 'TAKE must not call allTrans');
    assert.equal(ctx.mock.calls('cut').length, 0, 'CUT must not be sent');
  } finally { await ctx.stop(); }
});

test('E2 recall then TAKE with empty selection arms that preset\'s dests and sends allTrans', async () => {
  const ctx = await liveE2();
  try {
    // IMAG Pair is screens 1 and 2 (S2, S3) in the mock catalog
    await ctx.sm.recall('e2', 'e2:2');
    assert.deepEqual(ctx.sm.sess('e2').selection, []);
    const r = await ctx.sm.take('e2');
    assert.deepEqual(r.done, ['S2', 'S3']);
    const on = ctx.mock.calls('armUnarmDestination').filter((c) => c.params.arm === 1).pop();
    assert.deepEqual(on.params, { arm: 1, ScreenDestination: [{ id: 1 }, { id: 2 }], AuxDestination: [] });
    assert.deepEqual(ctx.mock.calls('allTrans').pop().params, {});
    assert.equal(ctx.mock.screens[1].pgm, 2);
    assert.equal(ctx.mock.screens[0].pgm, null, 'unarmed S1 did not take');
  } finally { await ctx.stop(); }
});

test('E2 CUT with a selection sends official cut (empty params) after arming those dest ids', async () => {
  const ctx = await liveE2();
  try {
    await ctx.sm.setSelection('e2', ['S1', 'A1']);
    const r = await ctx.sm.cut('e2');
    assert.deepEqual(r.done, ['S1', 'A1']);
    const on = ctx.mock.calls('armUnarmDestination').filter((c) => c.params.arm === 1).pop();
    assert.deepEqual(on.params, { arm: 1, ScreenDestination: [{ id: 0 }], AuxDestination: [{ id: 0 }] });
    assert.deepEqual(ctx.mock.calls('cut').pop().params, {});
    assert.equal(ctx.mock.calls('allTrans').length, 0, 'CUT must not call allTrans');
  } finally { await ctx.stop(); }
});

test('HTTP POST /api/sys/e2/take and /cut reach the mock E2 JSON-RPC server', async () => {
  const dir = tmp();
  const mock = new MockE2();
  const port = await mock.start(0);
  const ctx = await setup({});
  await ctx.engine.connect();
  const systems = new SystemManager({ dataDir: dir, engine: ctx.engine, overrides: { e2: { host: '127.0.0.1', port } }, autoStart: false });
  const server = createServer(ctx.engine, systems);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
  try {
    await call('POST', '/api/sys/active', { system: 'e2' });
    const refused = await call('POST', '/api/sys/e2/take');
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, /Nothing armed: select destinations or recall a preset first/);
    assert.equal(mock.calls('allTrans').length, 0, 'refused TAKE must not call allTrans');

    assert.deepEqual((await call('POST', '/api/sys/e2/selection', { destinations: ['S4'] })).json.selection, ['S4']);
    const take = await call('POST', '/api/sys/e2/take');
    assert.equal(take.status, 200);
    assert.deepEqual(take.json.done, ['S4']);
    assert.deepEqual(mock.calls('allTrans').pop().params, {});
    const cut = await call('POST', '/api/sys/e2/cut');
    assert.equal(cut.status, 200);
    assert.deepEqual(cut.json.done, ['S4']);
    assert.deepEqual(mock.calls('cut').pop().params, {});
  } finally {
    await new Promise((r) => server.close(r));
    await systems.close();
    await mock.stop();
    await ctx.teardown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP POST /api/sys/<instance>/take drives a second E2, not the family key', async () => {
  const dir = tmp();
  const a = new MockE2(); const b = new MockE2();
  const pa = await a.start(0); const pb = await b.start(0);
  const sm = new SystemManager({ dataDir: dir, engine: fakeEngine(), autoStart: false });
  sm.updateConnection('e2', { host: '127.0.0.1', port: pa });
  await sm.setActive('e2');
  await sm.connect('e2');
  const st = await sm.addInstance('e2', { forceNew: true, name: 'E2 B', connection: { host: '127.0.0.1', port: pb } });
  const id = st.created;
  assert.match(id, /^e2-[a-z0-9]{4,12}$/);
  await sm.connect(id);
  await sm.setSelection(id, ['S2']);
  const ctx = await setup({});
  await ctx.engine.connect();
  // Reuse this sm with a server. setup() made another engine; attach sm to a server with ctx.engine?
  // Simpler: call sm.take directly AND hit HTTP via a server bound to this sm.
  const server = createServer(ctx.engine, sm);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/sys/${id}/take`, { method: 'POST' });
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(json.done, ['S2']);
    assert.equal(b.calls('allTrans').length, 1, 'TAKE went to the second processor');
    assert.equal(a.calls('allTrans').length, 0, 'the primary E2 was not taken');
  } finally {
    await new Promise((r) => server.close(r));
    await sm.close();
    await a.stop(); await b.stop();
    await ctx.teardown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('USB runAction fires take/cut on e2 and on an e2-<id> instance', async () => {
  const dir = tmp();
  const calls = [];
  const systems = {
    take(id) { calls.push({ op: 'take', id }); return { done: [id] }; },
    cut(id) { calls.push({ op: 'cut', id }); return { done: [id] }; },
    recall(id, key) { calls.push({ op: 'recall', id, key }); return { ok: true }; },
    setSelection(id, dests) { calls.push({ op: 'selection', id, dests }); return dests; },
    toggleDest(id, key) { calls.push({ op: 'toggle', id, key }); return [key]; },
  };
  const svc = new DeckService({ dataDir: dir, systems, engine: { settings: {}, log() {} }, usbEnv: { CC_DECK_USB: '0' } });
  try {
    assert.deepEqual(await svc.runAction({ method: 'POST', path: '/api/sys/e2/take', body: {} }), { done: ['e2'] });
    assert.deepEqual(await svc.runAction({ method: 'POST', path: '/api/sys/e2-k3f2a1/cut', body: {} }), { done: ['e2-k3f2a1'] });
    await svc.runAction({ method: 'POST', path: '/api/sys/e2-k3f2a1/presets/e2%3A2/recall', body: { target: 'preview' } });
    await svc.runAction({ method: 'POST', path: '/api/sys/e2-k3f2a1/selection', body: { destinations: ['S1', 'S2'] } });
    await svc.runAction({ method: 'POST', path: '/api/sys/e2-k3f2a1/destinations/S3/toggle', body: {} });
    assert.deepEqual(calls, [
      { op: 'take', id: 'e2' },
      { op: 'cut', id: 'e2-k3f2a1' },
      { op: 'recall', id: 'e2-k3f2a1', key: 'e2:2' },
      { op: 'selection', id: 'e2-k3f2a1', dests: ['S1', 'S2'] },
      { op: 'toggle', id: 'e2-k3f2a1', key: 'S3' },
    ]);
    assert.equal(actionToRequest({ action: 'e2.take', instance: 'e2-k3f2a1' }).path, '/api/sys/e2-k3f2a1/take');
    assert.equal(actionToRequest({ action: 'e2.cut' }).path, '/api/sys/e2/cut');
  } finally {
    svc.stopUsb();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Stream Deck E2 panel CUT/TAKE post the system path; dest keys toggle live destinations', async () => {
  const dests = [
    { key: 'S1', label: 'Main LED', selected: true },
    { key: 'S2', label: 'IMAG Left', selected: false },
    { key: 'A1', label: 'Confidence', selected: false },
  ];
  const desk = {
    armed: ['e2'],
    byKey: { e2: { short: 'E2', view: { destinations: dests, selection: ['S1'], presets: [] } } },
  };
  const face = show(SURFACES.plusxl, desk, { system: 'e2', page: 0 });
  const take = face.keys.find((k) => k.label === 'TAKE');
  const cut = face.keys.find((k) => k.label === 'CUT');
  assert.equal(take && take.action && take.action.path, '/api/sys/e2/take');
  assert.equal(cut && cut.action && cut.action.path, '/api/sys/e2/cut');
  const main = face.keys.find((k) => k.action && k.action.path === '/api/sys/e2/destinations/S1/toggle');
  const imag = face.keys.find((k) => k.action && k.action.path === '/api/sys/e2/destinations/S2/toggle');
  const aux = face.keys.find((k) => k.action && k.action.path === '/api/sys/e2/destinations/A1/toggle');
  assert.ok(main, 'first live dest is bound');
  assert.equal(main.label, 'Main LED');
  assert.equal(main.on, true);
  assert.equal(imag.label, 'IMAG Left');
  assert.equal(aux.caption, 'A1');
  const all = face.keys.find((k) => k.destAll);
  assert.ok(all && all.action);
  assert.equal(all.action.path, '/api/sys/e2/selection');
  assert.deepEqual(all.action.body.destinations, ['S1', 'S2', 'A1']);

  const inst = applySwitcherDestinations(
    [{ destAll: true, label: 'ALL' }, { destSlot: true }, { destSlot: true }],
    { destinations: dests, selection: ['S1'] },
    'e2-ab12cd',
  );
  assert.equal(inst[0].action.path, '/api/sys/e2-ab12cd/selection');
  assert.equal(inst[1].action.path, '/api/sys/e2-ab12cd/destinations/S1/toggle');
});

test('view.takeTargets follows last recall when the operator has not picked dests', async () => {
  const ctx = await liveE2();
  try {
    assert.deepEqual(ctx.sm.view('e2').takeTargets, []);
    assert.equal(ctx.sm.view('e2').takeWarning, 'Nothing armed: select destinations or recall a preset first');
    await ctx.sm.recall('e2', 'e2:2');
    const v = ctx.sm.view('e2');
    assert.deepEqual(v.selection, []);
    assert.deepEqual(v.takeTargets, ['S2', 'S3']);
    assert.equal(v.takeWarning, null);
  } finally { await ctx.stop(); }
});

test('E2 preview recall replaces PVW (one green preset); TAKE moves it to PGM and clears PVW', async () => {
  const ctx = await liveE2();
  try {
    // Keynote Full is S1 only; IMAG Pair is S2+S3. The old tally wrote per dest and never
    // cleared the previous PVW, so both stayed green after the second recall.
    await ctx.sm.recall('e2', 'e2:1');
    let v = ctx.sm.view('e2');
    const keynote = () => v.presets.find((p) => p.key === 'e2:1');
    const imag = () => v.presets.find((p) => p.key === 'e2:2');
    const others = () => v.presets.filter((p) => p.key !== 'e2:1' && p.key !== 'e2:2');
    assert.equal(keynote().tally.pvw, 'full');
    assert.equal(keynote().tally.pgm, 'none');
    assert.equal(imag().tally.pvw, 'none');

    await ctx.sm.recall('e2', 'e2:2');
    v = ctx.sm.view('e2');
    assert.equal(imag().tally.pvw, 'full', 'the preset just recalled is in preview');
    assert.equal(imag().tally.pgm, 'none');
    assert.equal(keynote().tally.pvw, 'none', 'the previous preview preset is no longer green');
    assert.equal(keynote().tally.pgm, 'none');
    for (const p of others()) {
      assert.equal(p.tally.pvw, 'none', `${p.name} must not stay in preview`);
      assert.equal(p.tally.pgm, 'none');
    }

    const desk = (view) => ({ armed: ['e2'], byKey: { e2: { short: 'E2', view } } });
    const tone = (face, n) => {
      const k = face.keys.find((x) => x.absolute && x.action && String(x.action.path).endsWith(`/presets/${n}/recall`));
      return k && k.tone;
    };
    let face = show(SURFACES.plusxl, desk(v), { system: 'e2', page: 0 });
    assert.equal(tone(face, keynote().number), 'memory', 'old PVW key is redrawn without green');
    assert.equal(tone(face, imag().number), 'pvw', 'current PVW key is green');

    await ctx.sm.take('e2');
    v = ctx.sm.view('e2');
    assert.equal(imag().tally.pgm, 'full', 'TAKE moves the preview preset to program');
    assert.equal(imag().tally.pvw, 'none', 'TAKE clears preview as Event Master does');
    assert.equal(keynote().tally.pvw, 'none');
    assert.equal(keynote().tally.pgm, 'none');
    for (const p of others()) {
      assert.equal(p.tally.pvw, 'none', `${p.name} must not be green after TAKE`);
    }
    const green = v.presets.filter((p) => p.tally.pvw !== 'none');
    assert.deepEqual(green.map((p) => p.key), [], 'nothing is green after TAKE');

    face = show(SURFACES.plusxl, desk(v), { system: 'e2', page: 0 });
    assert.equal(tone(face, imag().number), 'stop', 'taken preset is red');
    assert.equal(tone(face, keynote().number), 'memory');
  } finally { await ctx.stop(); }
});
