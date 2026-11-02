'use strict';
// Several instances of one driver. The first ATEM kept from an older systems.json stays id "atem".
// A second ATEM gets its own id. Layout presets live on that id, so a new IP does not move them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SystemManager } = require('../lib/systems');
const { MockAtem } = require('../lib/mocks/atem');
const { createServer } = require('../lib/server');
const SH = require('../lib/shows');
const { EventEmitter } = require('events');
const { until } = require('./helpers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'inst-'));
function fakeEngine() {
  const eng = new EventEmitter();
  eng.settings = { host: '192.0.2.10', restPort: 80, awjPort: 10606, protocol: 'rest' };
  eng.presets = []; eng.destinations = []; eng.live = { inputs: {} };
  eng.log = () => {}; eng.changed = () => {}; eng.saveShow = () => ({ id: 'show', name: 'Desk' });
  return eng;
}

test('a single ATEM in systems.json migrates to one instance whose id is atem', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'systems.json'), JSON.stringify({
      version: 1, active: 'rs6', armed: ['rs6', 'atem'],
      connections: { atem: { host: '192.0.2.70', port: 9910, me: 1 } },
      sessions: { atem: { ssLayouts: [], layoutPresets: [{ id: 'keep', name: 'Old look', target: 'preview', layout: { version: 1 } }], mvSalvos: [] } },
    }));
    const sm = new SystemManager({ dataDir: dir, engine: fakeEngine(), autoStart: false });
    const atems = sm.getState().instances.filter((i) => i.type === 'atem');
    assert.equal(atems.length, 1);
    assert.equal(atems[0].id, 'atem');
    assert.equal(atems[0].connection.host, '192.0.2.70');
    assert.equal(sm.cfg.instanceMigration.ids.atem, 'atem');
    assert.equal(sm.cfg.instanceMigration.ids.rs6, 'rs6');
    assert.equal(sm.layoutPresets('atem').find((p) => p.id === 'keep').name, 'Old look');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'systems.json'), 'utf8'));
    assert.equal(saved.connections.atem.host, '192.0.2.70');
    assert.equal(saved.instanceMigration.ids.atem, 'atem');
    sm.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('two ATEMs: own address, own preset, stable id when the IP changes, duplicate IP flagged', async () => {
  const dir = tmp();
  const a = new MockAtem(); const b = new MockAtem();
  const pa = await a.start(0); const pb = await b.start(0);
  try {
    const eng = fakeEngine();
    eng.dataDir = dir;
    const sm = new SystemManager({ dataDir: dir, engine: eng, autoStart: false });
    await sm.setActive('atem');
    sm.updateConnection('atem', { host: '127.0.0.1', port: pa });
    const made = await sm.addInstance('atem', { name: 'ATEM B', connection: { host: '127.0.0.1', port: pb }, forceNew: true });
    const id = made.created;
    assert.match(id, /^atem-[a-z0-9]{4,12}$/);
    assert.notEqual(id, 'atem');
    await sm.connect('atem');
    await sm.connect(id);
    assert.equal(sm.getState().instances.some((i) => i.duplicateIp), false, 'same host, different port, is not a duplicate');
    await sm.atem('program', { source: 3, instance: 'atem' });
    await sm.atem('program', { source: 6, instance: id });
    await until(() => sm.view('atem').program === 3 && sm.view(id).program === 6, 2000, 'each ATEM program bus');
    assert.equal(sm.view('atem').program, 3);
    assert.equal(sm.view(id).program, 6);
    const layout = { version: 1, target: 'preview', supersource: { index: 0, art: {}, boxes: [] }, keys: [] };
    const saved = sm.saveLayoutPreset({ name: 'Side', instance: id, layout });
    sm.updateConnection(id, { host: '192.0.2.71', port: 9910 });
    assert.equal(sm.bag(id).id, id);
    assert.equal(sm.conn(id).host, '192.0.2.71');
    assert.equal(sm.layoutPresets(id).find((p) => p.id === saved.id).name, 'Side');
    assert.equal(sm.layoutPresets('atem').some((p) => p.name === 'Side'), false, 'the look stays on ATEM B');
    sm.renameInstance(id, 'ATEM C');
    assert.equal(sm.labelOf(id), 'ATEM C');
    sm.updateConnection('atem', { host: '192.0.2.71', port: 9910 });
    const dup = sm.getState().instances.filter((i) => i.duplicateIp).map((i) => i.id).sort();
    assert.deepEqual(dup, ['atem', id].sort());
    sm.disconnectInstance(id);
    assert.equal(sm.bag(id).hold, true);
    assert.equal(sm.bag(id).link, 'offline');
    const copy = await sm.duplicateInstance('atem');
    assert.match(copy.created, /^atem-/);
    assert.notEqual(copy.created, id);
    await sm.deleteInstance(id);
    assert.equal(sm.pool.has(id), false);
    assert.equal(sm.cfg.armed.includes(id), false);
    const server = createServer(eng, sm);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const other = copy.created;
    const res = await post(`/api/sys/${other}/connection`, { host: '192.0.2.80', port: 9910 });
    assert.equal(res.status, 200, 'an instance id in the path is that instance, not the original ATEM');
    assert.equal(sm.conn(other).host, '192.0.2.80');
    assert.notEqual(sm.conn('atem').host, '192.0.2.80');
    server.close();
    const parsed = SH.parseShow({ format: 'rs6-presets-show', version: 2, system: copy.created, armed: ['atem', copy.created, 'nope'], presets: [] }).show;
    assert.equal(parsed.system, copy.created);
    assert.deepEqual(parsed.armed, ['atem', copy.created]);
    sm.close();
  } finally { await a.stop(); await b.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('every family can be added twice; same host and port is the only duplicate', async () => {
  const dir = tmp();
  try {
    const eng = fakeEngine();
    const sm = new SystemManager({ dataDir: dir, engine: eng, autoStart: false });
    const ports = { e2: 9991, pixelhue: 9992, atem: 9993, pixera: 9994, millumin: 9995 };
    for (const type of ['e2', 'pixelhue', 'ptz', 'pixera', 'millumin', 'rs6', 'atem']) {
      await sm.setActive(type);
      const connection = type === 'ptz'
        ? { cameras: [{ name: 'Cam', host: '127.0.0.1', port: 9 }] }
        : { host: type === 'rs6' ? '' : '127.0.0.1', port: ports[type] || 9000, restPort: 81 };
      const made = await sm.addInstance(type, { name: `${type} B`, forceNew: true, connection });
      assert.match(made.created, new RegExp(`^${type}-[a-z0-9]{4,12}$`));
      assert.equal(sm.typeOf(made.created), type);
      assert.notEqual(sm.driver(type), sm.driver(made.created));
    }
    sm.updateConnection('e2', { host: '127.0.0.1', port: 9999 });
    const e2b = sm.getState().instances.find((i) => i.type === 'e2' && !i.primary);
    assert.equal(sm.instancePublic('e2').duplicateIp, false);
    assert.equal(sm.instancePublic(e2b.id).duplicateIp, false);
    sm.updateConnection(e2b.id, { host: '127.0.0.1', port: 9999 });
    assert.equal(sm.instancePublic('e2').duplicateIp, true);
    assert.equal(sm.instancePublic(e2b.id).duplicateIp, true);
    const ptzB = sm.getState().instances.find((i) => i.type === 'ptz' && !i.primary);
    sm.setCameras([{ id: 'cam1', name: 'Wide', host: '127.0.0.1', port: 81 }], 'ptz');
    assert.equal(sm.instancePublic('ptz').duplicateIp, false, 'port 81 and port 9 on one host are two cameras');
    sm.setCameras([{ id: 'cam1', name: 'Wide', host: '127.0.0.1', port: 9 }], 'ptz');
    assert.equal(sm.instancePublic('ptz').duplicateIp, true);
    assert.equal(sm.instancePublic(ptzB.id).duplicateIp, true);
    const added = await sm.addCamera({ name: 'Side', host: '127.0.0.1', port: 1 }, ptzB.id);
    assert.equal(sm.conn(ptzB.id).cameras.some((c) => c.id === added.id), true);
    assert.equal(sm.conn('ptz').cameras.some((c) => c.port === 1), false);
    const rs6Before = sm.engine.settings.host;
    await sm.simulate('rs6');
    assert.equal(sm.engine.settings.host, rs6Before, 'the original RS6 address is not replaced by the fixture');
    assert.equal(sm.instancePublic('rs6').connection.simulator, true);
    await sm.simulate('rs6', { on: false });
    assert.equal(sm.instancePublic('rs6').connection.simulator, false);
    const rs6b = sm.getState().instances.find((i) => i.type === 'rs6' && !i.primary);
    const sim = await sm.simulate(rs6b.id);
    assert.equal(sim.created, rs6b.id);
    await until(() => sm.driver(rs6b.id).status().connected, 4000, 'second RS6 simulator');
    assert.equal(sm.conn(rs6b.id).host, '127.0.0.1');
    assert.notEqual(sm.conn(rs6b.id).restPort, 81, 'the simulator port replaces the saved one only while it runs');
    await sm.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('two RS6s keep separate drivers; recall on the copy does not use the engine', async () => {
  const { MockAquilon } = require('../lib/mock');
  const dir = tmp();
  const a = new MockAquilon();
  const b = new MockAquilon();
  const pa = await a.startRest(0, '127.0.0.1');
  const pb = await b.startRest(0, '127.0.0.1');
  try {
    const eng = fakeEngine();
    eng.dataDir = dir;
    eng.settings = { host: '127.0.0.1', restPort: pa, awjPort: 9, protocol: 'rest' };
    eng.connected = true;
    eng.presets = [{ number: 1, name: 'Open', destinations: ['S1'], memories: { S1: 1 } }];
    eng.getPreset = (n) => eng.presets.find((p) => p.number === Number(n));
    eng.recall = async () => ({ via: 'engine' });
    eng.take = async () => ({ via: 'engine-take' });
    const sm = new SystemManager({ dataDir: dir, engine: eng, autoStart: false });
    await sm.setActive('rs6');
    const made = await sm.addInstance('rs6', { name: 'RS6 B', connection: { host: '127.0.0.1', restPort: pb, protocol: 'rest' }, forceNew: true });
    const id = made.created;
    assert.notEqual(sm.driver('rs6'), sm.driver(id));
    await sm.connect(id);
    assert.equal(sm.driver(id).status().connected, true);
    assert.equal(sm.driver(id).status().info.model, 'AQL RS6');
    assert.equal(sm.getState().instances.some((i) => i.duplicateIp), false);
    const recalled = await sm.recall(id, 'rs6:1');
    assert.equal(recalled.preset, 1);
    assert.deepEqual(recalled.done, ['S1']);
    assert.equal((await sm.recall('rs6', 1)).via, 'engine');
    sm.updateConnection(id, { host: '127.0.0.1', restPort: pa });
    const dup = sm.getState().instances.filter((i) => i.duplicateIp).map((i) => i.id).sort();
    assert.deepEqual(dup, ['rs6', id].sort());
    const server = createServer(eng, sm);
    try {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${server.address().port}`;
      const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      const blocked = await post('/api/sys/rs6/connection', { host: '192.0.2.9', restPort: 80 });
      assert.equal(blocked.status, 400);
      const moved = await post(`/api/sys/${id}/connection`, { host: '127.0.0.1', restPort: pb });
      assert.equal(moved.status, 200);
      assert.equal(sm.conn(id).restPort, pb);
      assert.equal(eng.settings.restPort, pa);
    } finally { server.close(); }
    await sm.close();
  } finally { await a.stop(); await b.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
