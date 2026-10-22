'use strict';
// 0.7.0 Panasonic PTZ driver: the CGI commands of bitfocus/companion-module-panasonic-ptz against mock cameras on
// 127.0.0.1, hold-to-run with the deadman stop, camdata.html parsing, many cameras under one system, the mock-mode
// loopback lock, show files and the /api/sys/ptz routes. No test contacts a real camera.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PTZDriver, parseCamdata, speedCode, GAINS } = require('../lib/drivers/ptz');
const { MockPTZ } = require('../lib/mocks/ptz');
const { SystemManager } = require('../lib/systems');
const { createServer } = require('../lib/server');
const { setup } = require('./helpers');

const until = async (fn, ms = 3000, what = 'condition') => { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 15)); } };
async function cams(n = 2) {
  const mocks = []; const list = [];
  for (let i = 0; i < n; i++) { const m = new MockPTZ({ model: i ? 'AW-HE130' : 'AW-UE150', title: `CAM-${i + 1}` }); list.push({ id: `cam${i + 1}`, name: `Cam ${i + 1}`, host: '127.0.0.1', port: await m.start(0) }); mocks.push(m); }
  return { mocks, list, stop: () => Promise.all(mocks.map((m) => m.stop())) };
}
const cmds = (m) => m.history.filter((h) => h.path !== 'camdata').map((h) => `${h.path}:${h.cmd}`);

test('PTZ: speed codes are 01..99 around 50 = stop; camdata.html parses like the Companion module', () => {
  assert.equal(speedCode(0), '50'); assert.equal(speedCode(25), '75'); assert.equal(speedCode(-25), '25'); assert.equal(speedCode(400), '99'); assert.equal(speedCode(-400), '01');
  const d = parseCamdata('OID:AW-UE150\r\nTITLE:Stage: left\r\nqSV3V1.20\r\nrER00\r\np0\r\ndA1\r\nTLG:1\r\nOAF:0\r\nd31\r\nOGU:0x80\r\n');
  assert.deepEqual(d, { model: 'AW-UE150', title: 'Stage: left', version: 'V1.20', error: null, power: 'standby', tally: true, tallyGreen: true, autoFocus: false, autoIris: true, gain: '80' });
  assert.equal(parseCamdata('rER03').error, 'rER03');
  assert.equal(GAINS[0][0], '80'); assert.equal(GAINS.find((g) => g[1] === '0 dB')[0], '08');
});

test('PTZ: every command is the module\'s CGI: aw_ptz cmd=%23... and aw_cam cmd=...; res=1', async () => {
  const { mocks: [m], list, stop } = await cams(1);
  const d = new PTZDriver({ cameras: list });
  try {
    await d.connect(); assert.equal(d.status().online, 1);
    const c = d.cameraList()[0]; assert.equal(c.model, 'AW-UE150'); assert.equal(c.title, 'CAM-1'); assert.equal(c.power, 'on');
    await d.move('cam1', { pan: 20, tilt: -10 }); await d.stop('cam1');
    await d.zoom('cam1', { speed: 30 }); await d.focus('cam1', { speed: -15 });
    await d.home('cam1'); await d.recall('cam1', 1); await d.store('cam1', 100);
    await d.power('cam1', false); await d.power('cam1', true);
    await d.tally('cam1', true); await d.tally('cam1', true, 'green');
    await d.autoFocus('cam1', false); await d.oneTouchAF('cam1');
    await d.iris('cam1', 42); await d.autoIris('cam1', true);
    await d.gain('cam1', '80'); await d.shutter('cam1', 'A'); await d.whiteBalance('cam1', '2');
    assert.deepEqual(cmds(m), ['aw_ptz:PTS7040', 'aw_ptz:PTS5050', 'aw_ptz:Z50', 'aw_ptz:F50', 'aw_ptz:Z80', 'aw_ptz:F35', 'aw_ptz:APC7FFF7FFF', 'aw_ptz:R00', 'aw_ptz:M99',
      'aw_ptz:O0', 'aw_ptz:O1', 'aw_ptz:DA1', 'aw_cam:TLG:1', 'aw_ptz:D10', 'aw_cam:OSE:69:1', 'aw_ptz:I42', 'aw_ptz:D31', 'aw_cam:OGU:80', 'aw_cam:OSH:A', 'aw_cam:OAW:2']);
    assert.equal(m.s.shutter, 'A'); assert.equal(m.s.wb, '2'); assert.equal(m.s.tallyGreen, 1); assert.ok(m.presets.has(99));
    await d.poll('cam1'); const v = d.cameraList()[0]; assert.equal(v.tally, true); assert.equal(v.autoFocus, false); assert.equal(v.gain, '80');
  } finally { d.close(); await stop(); }
});

test('PTZ: validation (preset 1..100, gain / shutter / WB tables) and camera refusals (E2 / ER1) are errors', async () => {
  const { mocks: [m], list, stop } = await cams(1);
  const d = new PTZDriver({ cameras: list });
  try {
    for (const f of [() => d.recall('cam1', 0), () => d.store('cam1', 101), () => d.recall('cam1', 1.5), () => d.gain('cam1', 'FF'), () => d.shutter('cam1', 'Z'), () => d.whiteBalance('cam1', '7')]) {
      await assert.rejects(f(), (e) => e.status === 400);
    }
    assert.equal(cmds(m).length, 0, 'nothing sent');
    await assert.rejects(d.move('nope', {}), (e) => e.status === 404);
    await d.power('cam1', false);
    await assert.rejects(d.recall('cam1', 3), (e) => e.status === 409 && /E2/.test(e.message), 'standby camera refuses a recall');
    await assert.rejects(d.camCmd('cam1', 'OSJ:06'), (e) => e.status === 409 && /ER1/.test(e.message));
    await assert.rejects(d.ptz('cam1', 'XYZ'), /E1/);
  } finally { d.close(); await stop(); }
});

test('PTZ: hold-to-run: no keep-alive within the deadman time stops the camera by itself; repeats keep it moving', async () => {
  const { mocks: [m], list, stop } = await cams(1);
  const d = new PTZDriver({ cameras: list }); d.deadmanMs = 150;
  try {
    await d.move('cam1', { pan: -10 }); assert.equal(m.s.pt, '4050'); assert.equal(d.cameraList()[0].moving, true);
    for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 80)); await d.move('cam1', { pan: -10 }); }
    assert.equal(m.calls('PTS5050').length, 0, 'still held');
    await until(() => m.s.pt === '5050' && m.s.z === '50' && m.s.f === '50', 1000, 'deadman stop');
    assert.equal(d.cameraList()[0].moving, false);
    await d.zoom('cam1', { speed: 10 }); await d.stopAll(); assert.equal(m.s.z, '50');
  } finally { d.close(); await stop(); }
});

test('PTZ: many cameras: status counts online ones; an offline camera does not block the rest', async () => {
  const { mocks, list, stop } = await cams(2);
  const d = new PTZDriver({ cameras: [...list, { id: 'cam3', name: 'Gone', host: '127.0.0.1', port: 1 }], timeout: 500 });
  try {
    await d.connect();
    const s = d.status(); assert.equal(s.connected, true); assert.equal(s.online, 2); assert.equal(s.total, 3); assert.equal(s.info.model, '2/3 cameras');
    assert.equal(d.cameraList().find((c) => c.id === 'cam3').connected, false);
    await d.recall('cam2', 3); assert.equal(mocks[1].lastRecall, 2); assert.equal(mocks[0].lastRecall, null);
    d.configure({ cameras: [list[1]] }); assert.deepEqual(d.cameraList().map((c) => c.id), ['cam2']);
    await assert.rejects(new PTZDriver({ cameras: [] }).connect(), /no cameras added/);
  } finally { d.close(); await stop(); }
});

test('PTZ in the SystemManager: add / edit / remove cameras, session speeds, preset names in the show file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6ptz-'));
  const { mocks: [m], list, stop } = await cams(1);
  const eng = { settings: { host: '192.0.2.10' }, presets: [], destinations: [], live: { inputs: {} }, log() {}, changed() {} };
  const sm = new SystemManager({ dataDir: dir, engine: eng, autoStart: false });
  try {
    assert.equal(sm.configured('ptz'), false);
    await assert.rejects(async () => sm.addCamera({ name: 'x' }), /IP address is required/);
    const cam = sm.addCamera({ name: 'Wide', host: '127.0.0.1', port: list[0].port }); assert.equal(cam.id, 'cam1');
    const cam2 = sm.addCamera({ host: '127.0.0.1', port: 1 }); assert.equal(cam2.id, 'cam2'); assert.equal(cam2.name, 'Camera 2');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'systems.json'), 'utf8')).connections.ptz.cameras.length, 2, 'saved');
    sm.removeCamera('cam2'); assert.deepEqual(sm.conn('ptz').cameras.map((c) => c.id), ['cam1']);
    sm.updateCamera('cam1', { name: 'Wide Shot' }); assert.equal(sm.conn('ptz').cameras[0].name, 'Wide Shot');
    await sm.ptz('speeds', { pt: 10, zoom: 99 }); assert.deepEqual(sm.ptzSess().speeds, { pt: 10, zoom: 49, focus: 15 });
    await sm.ptz('move', { pan: 1, tilt: -1 }); assert.equal(m.s.pt, '6040', 'direction x session speed');
    await sm.ptz('stop');
    await sm.ptz('store', { preset: 4, name: 'Podium' }); assert.equal(m.calls('M03').length, 1);
    await sm.ptz('recall', { preset: 4 }); assert.equal(m.lastRecall, 3);
    assert.equal(sm.view('ptz').cameras[0].presetNames[4], 'Podium'); assert.equal(sm.view('ptz').cameras[0].lastPreset, 4);
    await assert.rejects(sm.ptz('selfDestruct'), (e) => e.status === 404);
    const part = sm.showPart(); assert.deepEqual(part.systems.ptz.presetNames, { cam1: { 4: 'Podium' } }); assert.equal(part.systems.ptz.cameras, undefined, 'camera IPs only when asked');
    assert.equal(sm.showPart({ includeConnection: true }).systems.ptz.cameras[0].name, 'Wide Shot');
    await sm.ptz('rename', { preset: 4, name: '' }); assert.deepEqual(sm.ptzSess().presetNames.cam1, {});
    sm.applyShowPart({ system: 'ptz', systems: part.systems }); assert.equal(sm.ptzSess().presetNames.cam1[4], 'Podium'); assert.equal(sm.cfg.active, 'ptz');
    const st = sm.getState(); assert.equal(st.systems.ptz.cameras[0].name, 'Wide Shot'); assert.ok(st.groups.some((g) => g.name === 'Cameras' && g.systems.includes('ptz')));
  } finally { sm.close(); await stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('/api/sys/ptz: mock mode refuses non-loopback cameras before any contact; cmd routes drive the cameras', async () => {
  const ctx = await setup({});
  const { mocks, list, stop } = await cams(2);
  const systems = new SystemManager({ dataDir: ctx.dataDir, engine: ctx.engine, overrides: { ptz: { cameras: list } }, autoStart: false });
  const server = createServer(ctx.engine, systems);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json() }; };
  try {
    let st = (await call('POST', '/api/sys/active', { system: 'ptz' })).json;
    assert.equal(st.active, 'ptz'); assert.equal(st.view.cameras.length, 2); assert.equal(st.view.selected, 'cam1');
    assert.equal((await call('POST', '/api/sys/ptz/cameras', { name: 'LAN cam', host: '192.0.2.99' })).status, 409, 'mock mode: loopback only');
    assert.equal((await call('POST', '/api/sys/ptz/cmd/select', { cam: 'cam2' })).json.ok, true);
    assert.equal((await call('POST', '/api/sys/ptz/cmd/move', { pan: -1 })).json.ok, true); assert.equal(mocks[1].s.pt, '2550');
    assert.equal((await call('POST', '/api/sys/ptz/cmd/stop')).json.ok, true); assert.equal(mocks[1].s.pt, '5050');
    assert.equal((await call('POST', '/api/sys/ptz/cmd/recall', { cam: 'cam1', preset: 2 })).json.ok, true); assert.equal(mocks[0].lastRecall, 1);
    assert.equal((await call('POST', '/api/sys/ptz/cmd/gain', { value: 'ZZ' })).status, 400);
    assert.equal((await call('POST', '/api/sys/ptz/cmd/tally', { cam: 'cam1', on: true })).json.ok, true);
    st = (await call('GET', '/api/sys')).json; assert.equal(st.systems.ptz.cameras.find((c) => c.id === 'cam1').tally, true);
    const added = (await call('POST', '/api/sys/ptz/cameras', { name: 'Spare', host: '127.0.0.1', port: list[0].port })).json; assert.equal(added.id, 'cam3');
    assert.equal((await call('DELETE', '/api/sys/ptz/cameras/cam3')).json.ok, true);
    assert.equal((await call('DELETE', '/api/sys/ptz/cameras/cam9')).status, 404);
    assert.equal((await call('POST', '/api/sys/ptz/cmd/launch')).status, 404);
  } finally { server.closeClients(); await new Promise((r) => server.close(r)); systems.close(); await stop(); await ctx.teardown(); }
});
