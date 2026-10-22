'use strict';
// 0.6.0 multi-system: Barco Event Master (E2 / S3) and PixelHue drivers, the SystemManager, /api/sys routes and
// show format 2. Everything runs against the built-in mocks on 127.0.0.1; no test contacts a real device.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { setup } = require('./helpers');
const { createServer } = require('../lib/server');
const { E2Driver } = require('../lib/drivers/e2');
const { PixelHueDriver, makeToken, verifyToken } = require('../lib/drivers/pixelhue');
const { SystemManager } = require('../lib/systems');
const { MockE2 } = require('../lib/mocks/e2');
const { MockPixelHue, SN, START } = require('../lib/mocks/pixelhue');
const SH = require('../lib/shows');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rs6sys-'));
async function e2() { const m = new MockE2(); const port = await m.start(0); const d = new E2Driver({ host: '127.0.0.1', port }); return { m, d, port, stop: () => m.stop() }; }
async function ph() { const m = new MockPixelHue(); const port = await m.start(0); const d = new PixelHueDriver({ host: '127.0.0.1', port }); return { m, d, port, stop: () => m.stop() }; }

// ---------- E2 driver (R5919184/02 ch. 2.2) ----------
test('E2: connect reads getFrameSettings; destinations get aux names from listAuxContent', async () => {
  const { m, d, stop } = await e2();
  try {
    const info = await d.connect();
    assert.equal(info.model, 'E2-Gen2'); assert.equal(d.status().connected, true);
    const dests = await d.listDestinations();
    assert.deepEqual(dests.map((x) => x.key), ['S1', 'S2', 'S3', 'S4', 'A1', 'A2', 'A3']);
    assert.equal(dests.find((x) => x.key === 'A2').label, 'Record');
    assert.deepEqual(m.calls('listDestinations')[0].params, { type: 0 });
    assert.equal(m.calls('listAuxContent').length, 3, 'aux names come from listAuxContent when listDestinations has none');
    for (const h of m.history) assert.ok(h.method, 'every request carries a method');
  } finally { await stop(); }
});

test('E2: presets come with their destinations; recall = activatePreset type 0 / 1', async () => {
  const { m, d, stop } = await e2();
  try {
    const list = await d.listPresets();
    assert.deepEqual(m.calls('listPresets')[0].params, { ScreenDest: -1, AuxDest: -1 });
    assert.deepEqual(m.calls('listDestinationsForPreset')[0].params, { id: -1 });
    const walk = list.find((p) => p.name === 'Walk-in');
    assert.deepEqual(walk.dests, ['S1', 'S2', 'S3', 'S4', 'A1']); assert.equal(walk.number, 1);
    assert.equal(list.find((p) => p.name === 'Stream Program alt').sno, '12.01');
    await d.recall(walk);
    assert.deepEqual(m.calls('activatePreset')[0].params, { id: walk.id, type: 0 });
    assert.equal(m.screens[0].pvw, walk.id);
    await d.recall(walk, { target: 'program' });
    assert.deepEqual(m.calls('activatePreset')[1].params, { id: walk.id, type: 1 });
  } finally { await stop(); }
});

test('E2: TAKE arms exactly the selected destinations, then allTrans; CUT the same with cut', async () => {
  const { m, d, stop } = await e2();
  try {
    const all = ['S1', 'S2', 'S3', 'S4', 'A1', 'A2', 'A3'];
    m.screens.forEach((s) => (s.armed = true));
    await d.recall({ id: 0 });
    await d.take(['S1', 'A1'], { allKeys: all });
    const arm = m.calls('armUnarmDestination');
    assert.deepEqual(arm[0].params, { arm: 0, ScreenDestination: [{ id: 1 }, { id: 2 }, { id: 3 }], AuxDestination: [{ id: 1 }, { id: 2 }] });
    assert.deepEqual(arm[1].params, { arm: 1, ScreenDestination: [{ id: 0 }], AuxDestination: [{ id: 0 }] });
    assert.deepEqual(m.calls('allTrans')[0].params, {});
    assert.equal(m.screens[0].pgm, 0); assert.equal(m.screens[1].pgm, null, 'unarmed S2 did not transition');
    await d.take(['S2'], { allKeys: all, transTime: '40' });
    assert.deepEqual(m.calls('allTrans')[1].params, { transTime: 40 });
    await d.cut(['S3'], { allKeys: all });
    assert.deepEqual(m.calls('cut')[0].params, {});
    d.configure({ ...d.conn, operatorId: '1' });
    await d.cut(['S3'], { allKeys: all });
    assert.deepEqual(m.calls('cut')[1].params, { operatorId: 1 }, 'multi-operator mode');
  } finally { await stop(); }
});

test('E2: sources, freeze, aux routing, cues, stills and backups use the documented methods', async () => {
  const { m, d, stop } = await e2();
  try {
    const src = await d.listSources();
    assert.equal(src.filter((s) => s.kind === 'input').length, 10); assert.equal(src.filter((s) => s.kind === 'still').length, 3);
    assert.equal(src.find((s) => s.name === 'Zoom').status, 'no sync');
    await d.freeze('input', 2, true);
    assert.deepEqual(m.calls('freezeDestSource')[0].params, { type: 0, id: 2, screengroup: 0, mode: 1 });
    await d.freeze('aux', 1, false); assert.deepEqual(m.calls('freezeDestSource')[1].params, { type: 3, id: 1, screengroup: 0, mode: 0 });
    await d.routeAux('A2', 5);
    assert.deepEqual(m.calls('changeAuxContent')[0].params, { id: 1, PvwLastSrcIndex: 5 });
    const cues = await d.listCues(); assert.equal(cues.length, 4);
    await d.activateCue(2, 'pause'); assert.deepEqual(m.calls('activateCue')[0].params, { id: 2, type: 1 });
    const stills = await d.listStills(); assert.equal(stills[0].size, '3840×2160', 'listStill {$t} values unwrapped');
    await d.takeStill(1, 5); assert.deepEqual(m.calls('takeStill')[0].params, { type: 0, id: 1, file: 5 });
    await d.deleteStill(0); assert.deepEqual(m.calls('deleteStill')[0].params, { id: 0 });
    const bk = await d.listBackups(); assert.deepEqual(bk.map((x) => x.id), [3, 5]);
    await d.selectBackup(3, 1);
    assert.deepEqual(m.calls('activateSourceMainBackup')[0].params, { inputId: 3, BackUpState: 1, Backup1: { SrcType: 0, SourceId: 4 }, Backup2: { SrcType: 1, SourceId: 1 } }, 'existing backup config is sent back unchanged');
    await d.selectBackup(3, -1); assert.deepEqual(m.calls('resetSourceMainBackup')[0].params, { id: 3 });
  } finally { await stop(); }
});

test('E2: success != 0 and unknown methods are errors; no IP = no request', async () => {
  const { m, d, stop } = await e2();
  try {
    await assert.rejects(d.rpc('activatePreset', { id: 999 }), /error 1/);
    await assert.rejects(d.rpc('noSuchMethod', {}), /Method not found/);
    const none = new E2Driver({ host: '' });
    await assert.rejects(none.connect(), /no IP address/);
    assert.ok(m.history.length === 2);
  } finally { await stop(); }
});

// ---------- PixelHue driver (API User Guide V2.0.1) ----------
test('PixelHue: token is an HS256 JWT with SN, signed with startTime; the mock rejects a bad one', async () => {
  const t = makeToken(SN, START);
  assert.equal(verifyToken(t, START).SN, SN); assert.equal(verifyToken(t, 'other'), null);
  const { m, d, port, stop } = await ph();
  try {
    await d.connect();
    assert.equal(m.history[0].path, '/v1/node/open-detail'); assert.equal(m.history[0].auth, false, 'open-detail needs no token');
    assert.ok(m.history.slice(1).every((h) => h.auth), 'every other call carries Authorization');
    const r = await fetch(`http://127.0.0.1:${port}/pixelhue/v1/preset`, { headers: { Authorization: makeToken(SN, 'wrong') } });
    assert.equal(r.status, 401);
    const r2 = await fetch(`http://127.0.0.1:${port}/unico/v1/preset`); assert.equal(r2.status, 404, 'official /pixelhue prefix only');
  } finally { await stop(); }
});

test('PixelHue: screens / aux (MVR left out), presets with screens, recall PVW / PGM, TAKE / CUT name their screens', async () => {
  const { m, d, stop } = await ph();
  try {
    await d.connect();
    const dests = await d.listDestinations();
    assert.deepEqual(dests.map((x) => `${x.key}:${x.label}`), ['S1:LED Wall', 'S2:Left IMAG', 'S3:Right IMAG', 'A1:AUX Confidence']);
    const presets = await d.listPresets();
    const panel = presets.find((p) => p.name === 'Panel'); assert.deepEqual(panel.dests, ['S1', 'S2', 'S3', 'A1']);
    await d.recall(panel);
    assert.deepEqual(m.calls('POST', '/v1/preset/apply')[0].body, { presetId: 'preset-4-guid', serial: 4, targetRegion: 4 });
    await d.recall(panel, { target: 'program' }); assert.equal(m.calls('POST', '/v1/preset/apply')[1].body.targetRegion, 2);
    await d.take(['S1', 'A1']);
    assert.deepEqual(m.calls('PUT', '/v1/screen/take')[0].body, [
      { screenId: 1, screenGuid: 'scr-1-guid', direction: 0, effectSelect: 0, swapEnable: 1 },
      { screenId: 101, screenGuid: 'scr-101-guid', direction: 0, effectSelect: 0, swapEnable: 1 }]);
    await d.take(['S2'], { time: '800' });
    assert.deepEqual(m.calls('PUT', '/v1/screen/take')[1].body[0].switchEffect, { type: 1, time: 800 });
    d.configure({ ...d.conn, swap: false }); await d.connect();
    await d.cut(['S3']); assert.deepEqual(m.calls('PUT', '/v1/screen/cut')[0].body, [{ screenId: 3, direction: 0, swapEnable: 0 }]);
    await assert.rejects(d.take([]), /no screens selected/);
    const src = await d.listSources(); assert.equal(src.length, 8); assert.equal(src[7].status, 'no signal');
  } finally { await stop(); }
});

// ---------- SystemManager ----------
function fakeEngine(settings = {}) { return { settings: { host: '192.0.2.10', restPort: 80, awjPort: 10606, protocol: 'rest', ...settings }, presets: [], destinations: [], live: { inputs: {} }, log() {}, changed() {} }; }

test('first start migrates: systems.json records RS6 as the system and its connection; nothing else is contacted', () => {
  const dir = tmp();
  try {
    const sm = new SystemManager({ dataDir: dir, engine: fakeEngine(), autoStart: false });
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'systems.json'), 'utf8'));
    assert.equal(j.active, 'rs6'); assert.equal(j.migrated.rs6.host, '192.0.2.10');
    assert.equal(j.connections.e2.host, '', 'E2 has no IP until the user sets one'); assert.equal(j.connections.e2.port, 9999);
    assert.equal(j.connections.pixelhue.port, 8088); assert.equal(j.connections.pixelhue.prefix, '/pixelhue');
    const st = sm.getState(); assert.equal(st.active, 'rs6'); assert.equal(st.view, null); assert.equal(st.planned.length, 0, '0.7.0: ATEM and PTZ are real drivers now');
    sm.close();
    const again = new SystemManager({ dataDir: dir, engine: fakeEngine({ host: 'x' }), autoStart: false });
    assert.equal(again.migrated.rs6.host, '192.0.2.10', 'migration happens once'); again.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('manager: selection, recall, TAKE tally, dim filter, MOVE / swap, persistence', async () => {
  const dir = tmp(); const { m, port, stop } = await e2();
  try {
    const sm = new SystemManager({ dataDir: dir, engine: fakeEngine(), autoStart: false });
    sm.updateConnection('e2', { host: '127.0.0.1', port });
    await sm.setActive('e2');
    await sm.setSelection('e2', ['S2', 'S3']);
    assert.deepEqual(m.calls('armUnarmDestination').pop().params, { arm: 1, ScreenDestination: [{ id: 1 }, { id: 2 }], AuxDestination: [] });
    let v = sm.view('e2');
    assert.equal(v.presets.find((p) => p.name === 'Keynote Full').dim, true, 'S1-only preset is dimmed when S2/S3 are selected');
    assert.equal(v.presets.find((p) => p.name === 'IMAG Pair').dim, false);
    await sm.recall('e2', 'e2:2'); // IMAG Pair
    v = sm.view('e2');
    assert.equal(v.presets.find((p) => p.key === 'e2:2').tally.pvw, 'full');
    await sm.take('e2');
    v = sm.view('e2');
    const imag = v.presets.find((p) => p.key === 'e2:2');
    assert.equal(imag.tally.pgm, 'full'); assert.equal(v.destinations.find((x) => x.key === 'S2').pgmPreset.name, 'IMAG Pair');
    assert.equal(imag.tile, 3);
    sm.swapTiles('e2', 3, 30);
    assert.equal(sm.view('e2').presets.find((p) => p.key === 'e2:2').tile, 30);
    sm.close();
    const sm2 = new SystemManager({ dataDir: dir, engine: fakeEngine(), autoStart: false });
    assert.equal(sm2.cfg.active, 'e2'); assert.deepEqual(sm2.cfg.sessions.e2.selection, ['S2', 'S3']); assert.equal(sm2.cfg.sessions.e2.layout['e2:2'], 30);
    sm2.close();
    await assert.rejects(sm.take('pixelhue'), /no destinations selected/);
  } finally { await stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('mock overrides fix the connection; unconfigured systems are never contacted by the poller', async () => {
  const dir = tmp(); const { m, port, stop } = await e2();
  try {
    const sm = new SystemManager({ dataDir: dir, engine: fakeEngine(), overrides: { e2: { host: '127.0.0.1', port } }, pollMs: 40, refreshMs: 100 });
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(sm.getState().systems.e2.status.connected, true, 'a configured system shows live status on the dashboard');
    assert.equal(sm.getState().systems.pixelhue.status.connected, false);
    assert.throws(() => sm.updateConnection('e2', { host: '192.0.2.50' }), /Mock mode/);
    assert.ok(m.history.length > 0); sm.close();
  } finally { await stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- routes + show files ----------
test('/api/sys routes drive E2 and PixelHue; show format 2 records the system and loads v1 shows as RS6', async () => {
  const ctx = await setup({});
  const me = new MockE2(); const mp = new MockPixelHue();
  const overrides = { e2: { host: '127.0.0.1', port: await me.start(0) }, pixelhue: { host: '127.0.0.1', port: await mp.start(0) } };
  await ctx.engine.connect();
  const systems = new SystemManager({ dataDir: ctx.dataDir, engine: ctx.engine, overrides, autoStart: false });
  const server = createServer(ctx.engine, systems);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json() }; };
  try {
    let st = (await call('GET', '/api/sys')).json; assert.equal(st.active, 'rs6');
    st = (await call('POST', '/api/sys/active', { system: 'e2' })).json;
    assert.equal(st.active, 'e2'); assert.equal(st.view.status.connected, true); assert.equal(st.view.presets.length, 15);
    assert.deepEqual((await call('POST', '/api/sys/e2/destinations/S1/toggle')).json.selection, ['S1']);
    assert.equal((await call('POST', '/api/sys/e2/presets/e2%3A1/recall', {})).json.ok, true);
    assert.deepEqual((await call('POST', '/api/sys/e2/take')).json.done, ['S1']);
    assert.equal(me.calls('allTrans').length, 1);
    assert.equal((await call('POST', '/api/sys/e2/cues/0/play')).json.ok, true);
    assert.equal((await call('POST', '/api/sys/e2/connection', { host: '192.0.2.51' })).status, 409, 'mock connection is fixed');
    assert.equal((await call('POST', '/api/sys/pixelhue/presets/ph%3Apreset-1-guid/recall', {})).json.ok, true);
    assert.equal((await call('POST', '/api/sys/pixelhue/cues/0/play')).status, 409, 'PixelHue API has no cues');
    assert.equal((await call('GET', '/api/sys/rs6')).status, 400, 'RS6 keeps its own routes');
    // show file: v2 with system + sessions
    const saved = (await call('POST', '/api/shows/save', { name: 'E2 Gala' })).json;
    const j = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'shows', `${saved.id}.rs6show`), 'utf8'));
    assert.equal(j.version, 2); assert.equal(j.system, 'e2'); assert.deepEqual(j.systems.e2.selection, ['S1']);
    assert.equal(j.systems.e2.connection, undefined, 'no connection unless asked');
    // a 0.5.0 (v1) show opens as an RS6 show
    const v1 = { format: 'rs6-presets-show', version: 1, name: 'Old RS6 show', tileCount: 48, presets: [{ number: 2, name: 'A', destinations: ['S1'], memories: { S1: 3 } }] };
    const op = (await call('POST', '/api/shows/open', { content: JSON.stringify(v1) })).json; assert.equal(op.presets, 1);
    assert.equal((await call('GET', '/api/sys')).json.active, 'rs6');
    // and the v2 show brings E2 back with its selection
    await call('POST', '/api/shows/open', { id: saved.id });
    st = (await call('GET', '/api/sys')).json; assert.equal(st.active, 'e2'); assert.deepEqual(st.view.selection, ['S1']);
    const pv = (await call('POST', '/api/shows/preview', { id: saved.id })).json; assert.equal(pv.system, 'e2');
  } finally { server.closeClients(); await new Promise((r) => server.close(r)); systems.close(); await me.stop(); await mp.stop(); await ctx.teardown(); }
});

test('show parser: system defaults to rs6, bad sessions are cleaned, newer versions refused', () => {
  let r = SH.parseShow({ format: 'rs6-presets-show', version: 1, presets: [] }); assert.equal(r.show.system, 'rs6'); assert.equal(r.show.systems, null);
  r = SH.parseShow({ format: 'rs6-presets-show', version: 2, system: 'pixelhue', presets: [], systems: { pixelhue: { selection: ['S1', 'bad', 3], layout: { 'ph:x': 4, 'ph:y': -1, 'ph:z': 'q' }, tileCount: 50 } } });
  assert.equal(r.show.system, 'pixelhue'); assert.deepEqual(r.show.systems.pixelhue.selection, ['S1']); assert.deepEqual(r.show.systems.pixelhue.layout, { 'ph:x': 4 }); assert.equal(r.show.systems.pixelhue.tileCount, 48);
  assert.equal(SH.parseShow({ format: 'rs6-presets-show', version: 2, system: 'nope', presets: [] }).show.system, 'rs6');
  assert.throws(() => SH.parseShow({ format: 'rs6-presets-show', version: 3, presets: [] }), /newer/);
});

test('safety: E2 / PixelHue code, mocks and tests name no private-network device address; mocks bind loopback', () => {
  const root = path.join(__dirname, '..');
  const files = ['lib/systems.js', 'lib/drivers/common.js', 'lib/drivers/e2.js', 'lib/drivers/pixelhue.js', 'lib/drivers/rs6.js', 'lib/mocks/e2.js', 'lib/mocks/pixelhue.js', 'test/systems.test.js', 'test/ui-systems.test.js', 'public/sys.js',
    'lib/drivers/atem.js', 'lib/drivers/atem-proto.js', 'lib/drivers/ptz.js', 'lib/mocks/atem.js', 'lib/mocks/ptz.js', 'public/atem.js', 'public/ptz.js', 'test/atem.test.js', 'test/ptz.test.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(src, /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/, `${f} must not contain a LAN address`);
  }
  const srv = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(srv, /new MockE2\(\)[\s\S]*127\.0\.0\.1/);
  assert.match(srv, /new MockAtem\(\); sysOverrides\.atem = \{ host: '127\.0\.0\.1'/); assert.match(srv, /host: '127\.0\.0\.1', port: await m\.start\(0\)/);
  assert.match(fs.readFileSync(path.join(root, 'lib/mocks/atem.js'), 'utf8'), /start\(port = 0, host = '127\.0\.0\.1'\)/);
  assert.match(fs.readFileSync(path.join(root, 'lib/mocks/ptz.js'), 'utf8'), /start\(port = 0, host = '127\.0\.0\.1'\)/);
});
