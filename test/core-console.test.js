'use strict';
// Console actions, Companion regions, and the devices that sit on the core.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { SystemManager } = require('../lib/systems');
const { createServer } = require('../lib/server');
const { MockAtem } = require('../lib/mocks/atem');
const { MockPTZ } = require('../lib/mocks/ptz');
const { setup, until } = require('./helpers');
const { show } = require('../lib/decks/faces');
const { SURFACES } = require('../lib/decks/surfaces');
const { libraryFor } = require('../lib/decks/pages');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-os-'));
function fakeEngine() {
  const eng = new EventEmitter();
  eng.settings = { host: '192.0.2.10', restPort: 80, awjPort: 10606, protocol: 'rest' };
  eng.presets = [];
  eng.destinations = [];
  eng.live = { inputs: {} };
  eng.log = () => {};
  eng.changed = () => {};
  eng.currentShow = { id: null, name: 'Desk', savedHash: null };
  eng.showStatus = () => ({ id: null, name: 'Desk', dirty: false });
  return eng;
}

test('ATEM reaches connected, a split PTZ is degraded, cameras have their own machines', async () => {
  const dir = tmp();
  const atem = new MockAtem();
  const cam = new MockPTZ({ model: 'AW-UE150', title: 'CAM-1' });
  const atemPort = await atem.start(0);
  const camPort = await cam.start(0);
  const sm = new SystemManager({
    dataDir: dir,
    engine: fakeEngine(),
    pollMs: 80,
    refreshMs: 60000,
    overrides: {
      atem: { host: '127.0.0.1', port: atemPort, me: 1 },
      ptz: { cameras: [
        { id: 'cam1', name: 'Good', host: '127.0.0.1', port: camPort },
        { id: 'cam2', name: 'Dead', host: '127.0.0.1', port: 1 },
      ] },
    },
  });
  try {
    await until(() => sm.reportedFsm(sm.bag('atem')) === 'connected', 4000, 'atem connected');
    await until(() => sm.reportedFsm(sm.bag('ptz')) === 'degraded', 4000, 'ptz degraded');
    assert.equal(sm.linkOf(sm.bag('atem')), 'ok');
    assert.equal(sm.linkOf(sm.bag('ptz')), 'ok');
    assert.equal(sm.os.cameraState('ptz', 'cam1'), 'connected');
    assert.ok(['reconnecting', 'failed', 'connecting'].includes(sm.os.cameraState('ptz', 'cam2')));
    const card = sm.getState().systems.ptz;
    assert.equal(card.status.fsm, 'degraded');
    assert.equal(card.cameras.find((c) => c.id === 'cam1').fsm, 'connected');
    sm.disconnectInstance('atem');
    assert.equal(sm.bag('atem').link, 'offline');
    assert.equal(sm.reportedFsm(sm.bag('atem')), 'disconnected');
  } finally {
    sm.close();
    await atem.stop();
    await cam.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('console actions: focus, profile, show guard, health ack, services, lock, safe, power', async () => {
  const ctx = await setup({});
  const sm = new SystemManager({ dataDir: ctx.dataDir, engine: ctx.engine, autoStart: false });
  const server = createServer(ctx.engine, sm);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const json = await r.json();
    return { status: r.status, json };
  };
  try {
    await sm.setArmed('atem', true);
    const focus = await sm.os.command('focus', { instance: 'rs6' });
    assert.equal(focus.instance, 'rs6');
    assert.equal(sm.cfg.active, 'rs6');
    const next = await sm.os.command('focus.next', {});
    assert.equal(next.instance, 'atem');

    const saved = await sm.os.command('profile.save', { id: 'show-a', name: 'Saturday' });
    assert.equal(saved.active, 'show-a');
    sm.os.surfaces.activate('show');
    assert.equal(sm.os.surfaces.profile().id, 'show');
    await sm.os.command('profile.load', { id: 'show-a' });
    assert.equal(sm.os.surfaces.profile().name, 'Saturday');

    const show = await sm.os.command('show.save', { name: 'Saturday show' });
    const armed = await sm.os.command('show.load', { id: show.id });
    assert.equal(armed.pending, true);
    assert.equal(armed.word, 'LOAD');
    const loaded = await sm.os.command('show.load', { id: show.id, confirm: 'LOAD' });
    assert.equal(loaded.ok, true);

    sm.os.alerts.raise('conn:atem', { level: 'failed', source: 'atem', message: 'no answer' });
    assert.ok(sm.os.feedbacks().flat['health.alert'] >= 1);
    await sm.os.command('health.ack', { id: 'conn:atem' });
    assert.equal(sm.os.alerts.list().find((a) => a.id === 'conn:atem').acked, true);

    const services = await sm.os.command('service.refresh', {});
    assert.equal(services.speakerTimer.state, 'unconfigured');
    assert.equal(services.smb.state, 'unconfigured');
    assert.equal(services.companion.state, 'unconfigured');
    const smb = await sm.os.command('service.enable', { id: 'smb', on: false });
    assert.equal(smb.state, 'disabled');
    assert.equal(smb.control, 'recorded');

    await sm.os.command('panel.safe', { on: true });
    await assert.rejects(() => sm.os.command('host.shutdown', {}), /Safe mode/);
    await assert.rejects(() => sm.os.command('show.load', { id: show.id, confirm: 'LOAD' }), /Safe mode/);
    await sm.os.command('panel.safe', { on: false });

    await sm.os.command('panel.lock', {});
    await assert.rejects(() => sm.os.command('focus', { instance: 'atem' }), /locked/);
    const ack = await sm.os.command('health.ack', {});
    assert.equal(ack.ok, true);
    await sm.os.command('panel.unlock', {});
    assert.equal(sm.os.panel.locked, false);

    let ran = false;
    sm.os.host.setRunner(async () => { ran = true; });
    const pending = await sm.os.command('host.reboot', {});
    assert.equal(pending.pending, true);
    await assert.rejects(() => sm.os.command('host.reboot', { confirm: 'REBOOT' }), /not armed/);
    assert.equal(ran, false);
    process.env.CC_HOST_POWER = '1';
    try {
      await sm.os.command('host.shutdown', {});
      const done = await sm.os.command('host.shutdown', { confirm: pending.confirm === 'REBOOT' ? 'SHUTDOWN' : 'SHUTDOWN' });
      assert.equal(done.ok, true);
      assert.equal(ran, true);
    } finally { delete process.env.CC_HOST_POWER; }

    const health = await call('GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    assert.ok(Array.isArray(health.json.instances));
    const mods = await call('GET', '/api/core/modules');
    assert.ok(mods.json.modules.some((m) => m.id === 'atem' && m.status === 'ready'));
    assert.ok(mods.json.modules.some((m) => m.id === 'hyperdeck' && m.status === 'ready'));
    assert.ok(mods.json.modules.some((m) => m.id === 'console'));
    const actions = await call('GET', '/api/core/actions');
    assert.ok(actions.json.actions.some((a) => a.id === 'host.shutdown'));
    assert.ok(actions.json.feedbacks.some((f) => f.id === 'service.speakerTimer'));

    sm.os.store.modules.atem = false;
    sm.os.persist();
    await assert.rejects(() => sm.connect('atem'), /disabled/);
  } finally {
    delete process.env.CC_HOST_POWER;
    server.close();
    sm.close();
    await ctx.teardown();
  }
});

test('Companion can own a deck or a key region, and its feedback is in the snapshot', async () => {
  const dir = tmp();
  const sm = new SystemManager({ dataDir: dir, engine: fakeEngine(), autoStart: false });
  try {
    const whole = sm.os.surfaces.bind({ surfaceId: 'deck-a', owner: 'companion', companionId: 'hub' });
    assert.equal(sm.os.surfaces.deckOwner('deck-a'), 'companion');
    assert.equal(whole.owner, 'companion');
    sm.os.surfaces.bind({ surfaceId: 'deck-b', region: { row: [2, 3] }, owner: 'companion' });
    assert.equal(sm.os.surfaces.deckOwner('deck-b'), 'shared');
    assert.equal(sm.os.surfaces.keyOwner('deck-b', 1, 2), 'companion');
    assert.equal(sm.os.surfaces.keyOwner('deck-b', 1, 0), 'native');
    const conn = sm.os.addCompanion({ moduleId: 'videohub', label: 'Hub', host: '10.1.1.8', port: 9990 });
    sm.os.companionFeedback({ id: conn.id, variables: { dest1: 'Cam 3' }, buttons: [{ row: 0, col: 0, text: 'Cam 3' }] });
    const snap = sm.os.snapshot();
    assert.equal(snap.companion.connections[0].feedback.variables.dest1, 'Cam 3');
    assert.equal(snap.feedbacks.service.companion.state === 'unconfigured' || snap.feedbacks.service.companion.state === 'down' || snap.feedbacks.service.companion.state === 'up', true);
    const fresh = await sm.os.services.probe('companion', { companionFresh: true, companionConfigured: true });
    assert.equal(fresh.state, 'up');
    const kept = new SystemManager({ dataDir: dir, engine: fakeEngine(), autoStart: false });
    assert.equal(kept.os.surfaces.deckOwner('deck-a'), 'companion');
    assert.equal(kept.os.companionSnapshot().connections[0].label, 'Hub');
    kept.close();
  } finally {
    sm.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the console is a deck page and a home key, and it posts core actions', () => {
  const home = show(SURFACES.xl, { armed: ['rs6', 'atem'] }, {});
  const key = home.keys.find((k) => k.nav === 'console');
  assert.ok(key);
  assert.equal(key.label, 'CONSOLE');
  assert.deepEqual(home.keys.filter((k) => k.nav === 'system').map((k) => k.system), ['rs6', 'atem']);
  const face = show(SURFACES.xl, { armed: ['rs6'] }, { system: 'console', page: 0 });
  assert.equal(face.system, 'console');
  assert.equal(face.keys.find((k) => k.col === 0 && k.row === 0).nav, 'home');
  const save = face.keys.find((k) => k.role === 'show.save');
  assert.equal(save.action.path, '/api/core/cmd/show.save');
  let power = null;
  for (let p = 0; p < 6; p++) {
    const face = show(SURFACES.xl, { armed: [] }, { system: 'console', page: p });
    if ((face.keys || []).some((k) => k.role === 'host.shutdown')) power = face;
  }
  assert.ok(power, 'the power page is on the console deck');
  assert.equal(power.keys.find((k) => k.role === 'host.shutdown').action.path, '/api/core/cmd/host.shutdown');
  const lib = libraryFor({ armed: ['rs6'] }, SURFACES.xl);
  assert.ok(lib.some((p) => p.id === 'console'));
  assert.ok(lib.some((p) => p.id === 'console-power'));
});
