'use strict';
// Phase 2: dispatch for the rest of the desk, Videohub / HyperDeck / Mitti,
// the console profile inside a show, and the Companion satellite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { SystemManager } = require('../lib/systems');
const { createServer } = require('../lib/server');
const { MockE2 } = require('../lib/mocks/e2');
const { MockVideohub } = require('../lib/mocks/videohub');
const { MockHyperDeck } = require('../lib/mocks/hyperdeck');
const { MockMitti } = require('../lib/mocks/mitti');
const { showHash, parseShow } = require('../lib/shows');
const { setup, until } = require('./helpers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-p2-'));
function fakeEngine(dir) {
  const eng = new EventEmitter();
  eng.dataDir = dir;
  eng.settings = { host: '192.0.2.10', restPort: 80, awjPort: 10606, protocol: 'rest' };
  eng.presets = [];
  eng.destinations = [];
  eng.live = { inputs: {} };
  eng.log = () => {};
  eng.changed = () => {};
  eng.currentShow = { id: null, name: 'Desk' };
  eng.showStatus = () => ({ id: null, name: 'Desk', dirty: false });
  return eng;
}

test('E2 recall goes through dispatch and a timeout is recorded without dropping the driver', async () => {
  const dir = tmp();
  const e2 = new MockE2();
  const port = await e2.start(0);
  const sm = new SystemManager({ dataDir: dir, engine: fakeEngine(dir), autoStart: false, overrides: { e2: { host: '127.0.0.1', port } } });
  try {
    await sm.connect('e2');
    await sm.refresh('e2');
    const key = sm.cacheOf('e2').presets[0].key;
    sm.sess('e2').selection = ['S1'];
    const orig = sm.driver('e2').recall.bind(sm.driver('e2'));
    let calls = 0;
    sm.driver('e2').recall = async (...args) => { calls += 1; return orig(...args); };
    await sm.recall('e2', key, { autoTake: false });
    assert.equal(calls, 1);
    const row = sm.os.dispatch.recent().find((r) => r.module === 'e2' && r.action === 'recall');
    assert.ok(row && row.ok, 'recall was recorded on the dispatch path');
    sm.driver('e2').take = () => new Promise(() => {});
    sm.os.dispatch.run = sm.os.dispatch.run.bind(sm.os.dispatch);
    await assert.rejects(
      () => sm.os.dispatch.run({ module: 'e2', instance: 'e2', action: 'take', timeoutMs: 30, run: () => sm.driver('e2').take() }),
      /timed out/,
    );
    assert.equal(sm.driver('e2').status().connected, true);
  } finally {
    sm.close();
    await e2.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Videohub crosspoint, HyperDeck transport, and Mitti cue', async () => {
  const dir = tmp();
  const hub = new MockVideohub();
  const deck = new MockHyperDeck();
  const mitti = new MockMitti();
  const hubPort = await hub.start(0);
  const deckPort = await deck.start(0);
  const mittiPort = await mitti.start(0);
  const sm = new SystemManager({
    dataDir: dir,
    engine: fakeEngine(dir),
    autoStart: false,
    overrides: {
      videohub: { host: '127.0.0.1', port: hubPort },
      hyperdeck: { host: '127.0.0.1', port: deckPort },
      mitti: { host: '127.0.0.1', port: mittiPort },
    },
  });
  const server = createServer(sm.engine, sm);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return { status: r.status, json: await r.json() };
  };
  try {
    await sm.connect('videohub');
    await until(() => sm.driver('videohub').view().outputs.length === 4, 2000, 'videohub labels');
    const route = await post('/api/sys/videohub/cmd/crosspoint', { output: 0, input: 2 });
    assert.equal(route.status, 200, JSON.stringify(route.json));
    assert.equal(route.json.output, 0);
    assert.equal(route.json.input, 2);
    assert.equal(hub.routing[0], 2);
    const recorded = sm.os.dispatch.recent().find((r) => r.module === 'videohub' && r.action === 'crosspoint');
    assert.ok(recorded && recorded.ok);

    await sm.connect('hyperdeck');
    const rec = await post('/api/sys/hyperdeck/cmd/record', {});
    assert.equal(rec.status, 200, JSON.stringify(rec.json));
    assert.equal(sm.os.transports.get('hyperdeck:0').state, 'recording');
    await post('/api/sys/hyperdeck/cmd/stop', {});
    assert.equal(sm.os.transports.get('hyperdeck:0').state, 'stopped');

    await sm.connect('mitti');
    const cue = await post('/api/sys/mitti/cmd/cue', { value: 3 });
    assert.equal(cue.status, 200, JSON.stringify(cue.json));
    await until(() => mitti.messages.some((m) => m.address === '/mitti/cue'), 1000, 'mitti osc');
    const play = await post('/api/sys/mitti/cmd/play', {});
    assert.equal(play.status, 200);
    assert.equal(sm.os.transports.get('mitti:0').state, 'playing');
    assert.equal(sm.getState().systems.videohub.kind, 'router');
    assert.equal(sm.getState().systems.hyperdeck.short, 'HyperDeck');
  } finally {
    server.close();
    sm.close();
    await hub.stop();
    await deck.stop();
    await mitti.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a console profile is saved in the show, and an older show leaves the one already here', async () => {
  const ctx = await setup({});
  const sm = new SystemManager({ dataDir: ctx.dataDir, engine: ctx.engine, autoStart: false });
  try {
    const before = showHash(ctx.engine.buildShow());
    assert.equal(ctx.engine.buildShow().console, undefined, 'an empty profile is not part of the show');
    assert.equal(showHash(ctx.engine.buildShow()), before);
    sm.os.surfaces.bind({ surfaceId: 'deck-1', region: { row: [0, 0] }, owner: 'native', instanceId: 'atem' });
    sm.os.surfaces.saveAs('sat-show', 'Saturday');
    const built = ctx.engine.buildShow({ name: 'Saturday' });
    assert.equal(built.console.id, 'sat-show');
    assert.equal(built.console.name, 'Saturday');
    assert.equal(built.console.bindings[0].surfaceId, 'deck-1');
    const parsed = parseShow(JSON.stringify(built)).show;
    assert.equal(parsed.console.name, 'Saturday');
    const old = JSON.parse(JSON.stringify(built));
    delete old.console;
    const opened = parseShow(JSON.stringify(old)).show;
    assert.equal(opened.console, undefined, 'an older show has no console block');
    const reparsed = parseShow(JSON.stringify(opened)).show;
    assert.equal(showHash(reparsed), showHash(opened), 'reading an older show does not invent a console profile');
    sm.os.surfaces.activate('show');
    sm.applyShowPart(opened);
    assert.equal(sm.os.surfaces.profile().id, 'show', 'opening an older show does not wipe the profile on this machine');
    sm.applyShowPart(parsed);
    assert.equal(sm.os.surfaces.profile().name, 'Saturday');
    assert.equal(sm.os.surfaces.profile().bindings[0].instanceId, 'atem');
  } finally {
    sm.close();
    await ctx.teardown();
  }
});

test('a Companion satellite paints a reserved key and receives the press', async () => {
  const dir = tmp();
  const sm = new SystemManager({ dataDir: dir, engine: fakeEngine(dir), autoStart: false });
  const hits = [];
  const satellite = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { hits.push(JSON.parse(raw || '{}')); res.writeHead(204); res.end(); });
  });
  await new Promise((r) => satellite.listen(0, '127.0.0.1', r));
  const port = satellite.address().port;
  try {
    sm.os.surfaces.bind({ surfaceId: 'deck-9', region: { row: [1, 1], col: [2, 2] }, owner: 'companion' });
    sm.os.setSatellite({ url: `http://127.0.0.1:${port}/press` });
    sm.os.satelliteKeys({ surfaceId: 'deck-9', keys: [{ col: 2, row: 1, label: 'HUB', caption: 'IN 3' }] });
    const face = { id: 'home', system: null, keys: [{ col: 2, row: 1, label: 'TAKE', caption: 'PGM', action: { path: '/api/take' } }], dials: [] };
    const decks = { os: sm.os };
    const { DeckService } = require('../lib/decks/service');
    const svc = new DeckService({ dataDir: dir, systems: sm, engine: sm.engine });
    svc.os = sm.os;
    const stamped = svc.stamp({ id: 'deck-9' }, face);
    const key = stamped.keys.find((k) => k.col === 2 && k.row === 1);
    assert.equal(key.label, 'HUB');
    assert.equal(key.caption, 'IN 3');
    assert.equal(key.action, null);
    const pressed = await svc.press('deck-9', 2, 1);
    assert.equal(pressed.ok, true);
    assert.equal(hits[0].surfaceId, 'deck-9');
    assert.equal(hits[0].col, 2);
    assert.equal(hits[0].row, 1);
    void decks;
  } finally {
    sm.close();
    await new Promise((r) => satellite.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
