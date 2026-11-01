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
