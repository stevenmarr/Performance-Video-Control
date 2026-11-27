'use strict';
// Playout on the desk: HTTP routes, a second instance that reloads, and the button catalog.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { SystemManager } = require('../lib/systems');
const { MockPlayout } = require('../lib/mocks/playout');
const { createServer } = require('../lib/server');
const { setup } = require('./helpers');
const { isInstanceId, isAddedInstance, familyOf } = require('../lib/instance-ids');
const { get } = require('../lib/modules/catalog');
const { actionToRequest, parseSysCmd } = require('../lib/decks/page-push');

const call = async (base, method, p, body) => {
  const r = await fetch(base + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
};

test('playout-xxxx is an instance id and survives a reload', async () => {
  assert.equal(isInstanceId('playout'), true);
  assert.equal(isInstanceId('playout-ab12cd'), true);
  assert.equal(familyOf('playout-ab12cd'), 'playout');
  assert.equal(isAddedInstance('playout-ab12cd'), true);
  assert.equal(isInstanceId('playout-no'), false);

  const ctx = await setup({});
  const eng = ctx.engine;
  const sm = new SystemManager({ dataDir: ctx.dataDir, engine: eng, autoStart: false });
  try {
    await sm.addInstance('playout', { name: 'Main' });
    const st = await sm.addInstance('playout', { forceNew: true, name: 'Backup', focus: false });
    const id = st.created;
    assert.match(id, /^playout-[a-z0-9]{4,12}$/);
    await sm.updateConnection(id, { host: '192.0.2.51', port: 8080 });
    assert.equal(sm.conn(id).host, '192.0.2.51');
    assert.equal(sm.conn(id).port, 8080);
    await sm.close();
    const again = new SystemManager({ dataDir: ctx.dataDir, engine: eng, autoStart: false });
    try {
      assert.equal(again.typeOf(id), 'playout');
      assert.equal(again.conn(id).host, '192.0.2.51');
      assert.ok(again.cfg.armed.includes(id));
      assert.ok(again.listInstances().some((row) => row.id === id && row.name === 'Backup'));
    } finally {
      await again.close();
    }
  } finally {
    await sm.close().catch(() => {});
    await ctx.teardown();
  }
});

test('/api/sys/playout connects, simulates, and runs commands without firing on connect', async () => {
  const ctx = await setup({});
  const mock = new MockPlayout();
  const port = await mock.start(0);
  const systems = new SystemManager({
    dataDir: ctx.dataDir,
    engine: ctx.engine,
    overrides: { playout: { host: '127.0.0.1', port } },
    autoStart: false,
  });
  const server = createServer(ctx.engine, systems);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const early = await call(base, 'POST', '/api/sys/playout/cmd/play', {});
    assert.equal(early.status, 409);
    assert.deepEqual(mock.posts(), []);
    const connected = await call(base, 'POST', '/api/sys/playout/connect', {});
    assert.equal(connected.status, 200);
    assert.equal(connected.json.clip, 'Open');
    assert.equal(connected.json.remaining, '00:01:26:00');
    assert.equal(connected.json.standby, 'Keynote');
    assert.deepEqual(connected.json.playlist.map((c) => c.name), ['Open', 'Keynote', 'Walk out']);
    assert.deepEqual(mock.posts(), []);
    const play = await call(base, 'POST', '/api/sys/playout/cmd/play', {});
    assert.equal(play.status, 200);
    assert.equal(play.json.transport, 'playing');
    assert.equal(mock.transport, 'playing');
    assert.deepEqual(mock.posts().map((r) => r.path), ['/transport/play']);
    const cue = await call(base, 'POST', '/api/sys/playout/cmd/cue', { value: 'Walk out' });
    assert.equal(cue.json.clip, 'Walk out');
    const state = await call(base, 'GET', '/api/sys');
    const card = state.json.instances.find((row) => row.id === 'playout');
    assert.equal(card.counts.clip, 'Walk out');
    assert.equal(card.counts.remaining, '00:01:26:00');
    assert.ok(card.counts.clips.includes('Open'));
    assert.equal(card.kind, 'playout');
  } finally {
    server.closeClients();
    await new Promise((r) => server.close(r));
    await systems.close();
    await mock.stop();
    await ctx.teardown();
  }
});

test('the simulator route answers, and a second Playout command uses its own id', async () => {
  const ctx = await setup({});
  const systems = new SystemManager({ dataDir: ctx.dataDir, engine: ctx.engine, autoStart: false });
  const server = createServer(ctx.engine, systems);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const sim = await call(base, 'POST', '/api/sys/playout/simulate', {});
    assert.equal(sim.status, 200);
    assert.equal(sim.json.systems.playout.status.connected, true);
    assert.equal(sim.json.view.clip, 'Open');
    assert.equal(sim.json.view.remaining, '00:01:26:00');
    const play = await call(base, 'POST', '/api/sys/playout/cmd/pause', {});
    assert.equal(play.status, 200);
    const added = await call(base, 'POST', '/api/sys/instances', { type: 'playout', forceNew: true, name: 'Backup' });
    assert.equal(added.status, 200);
    assert.match(added.json.created, /^playout-[a-z0-9]{4,12}$/);
    const missing = await call(base, 'POST', `/api/sys/${added.json.created}/cmd/play`, {});
    assert.equal(missing.status, 409);
  } finally {
    server.closeClients();
    await new Promise((r) => server.close(r));
    await systems.close();
    await ctx.teardown();
  }
});

test('the button catalog lists play, pause, stop, cue and next', () => {
  const system = get('playout');
  assert.equal(system.nativeId, 'playout');
  assert.deepEqual(system.actions.map((a) => a.id), ['play', 'pause', 'stop', 'cue', 'next']);
  assert.deepEqual(system.variables.map((v) => v.id), ['connected', 'transport', 'clip', 'playlist', 'elapsed', 'remaining', 'standby', 'cued']);
  assert.ok(system.feedbacks.some((f) => f.id === 'remaining'));
  assert.equal(actionToRequest({ action: 'playout.play' }).path, '/api/sys/playout/cmd/play');
  assert.equal(actionToRequest({ action: 'playout.cue', options: { value: 'Open' } }).body.value, 'Open');
  assert.equal(actionToRequest({ action: 'playout.next', instance: 'playout-ab12cd' }).path, '/api/sys/playout-ab12cd/cmd/next');
  assert.deepEqual(parseSysCmd('/api/sys/playout-ab12cd/cmd/pause'), { instance: 'playout-ab12cd', type: 'playout', name: 'pause' });
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'sys.js'), 'utf8');
  assert.match(ui, /playout: 8080/);
  assert.match(ui, /data-playout-card/);
  assert.match(ui, /cmd\('play', 'PLAY'\)/);
  assert.match(ui, /REMAINING/);
  assert.match(ui, /s\.kind === 'playout' \? \[\['CLIP'/);
});
