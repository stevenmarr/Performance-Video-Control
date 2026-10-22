'use strict';
// 0.7.0 Panasonic PTZ driver: the CGI commands of bitfocus/companion-module-panasonic-ptz against mock cameras on
// 127.0.0.1, hold-to-run with the deadman stop, camdata.html parsing, many cameras under one system, the mock-mode
// loopback lock, show files and the /api/sys/ptz routes. No test contacts a real camera.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PTZDriver, parseCamdata, positions, speedCode, GAINS } = require('../lib/drivers/ptz');
const PC = require('../lib/drivers/ptz-commands');
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

test('PTZ: speed codes are 01..99 around 50 = stop; camdata.html parses like the Companion module (+ raw fields)', () => {
  assert.equal(speedCode(0), '50'); assert.equal(speedCode(25), '75'); assert.equal(speedCode(-25), '25'); assert.equal(speedCode(400), '99'); assert.equal(speedCode(-400), '01');
  const d = parseCamdata('OID:AW-UE150\r\nTITLE:Stage: left\r\nqSV3V1.20\r\nrER00\r\np0\r\ndA1\r\nTLG:1\r\nOAF:0\r\nd31\r\nOGU:0x80\r\nOSJ:03:0x2\r\nOSI:20:0x015E0:0\r\naPC80008000\r\naxzFFF\r\n');
  const { raw, ...rest } = d;
  assert.deepEqual(rest, { model: 'AW-UE150', title: 'Stage: left', version: 'V1.20', error: null, power: 'standby', tally: true, tallyGreen: true, autoFocus: false, autoIris: true, gain: '80' });
  assert.equal(raw['OSJ:03'], '2'); assert.equal(raw['OSI:20'], '015E0:0'); assert.equal(raw.OGU, '80'); assert.equal(raw.aPC, '80008000'); assert.equal(raw.axz, 'FFF');
  assert.equal(positions(raw).zoom, 100); assert.equal(positions(raw).pan, 0);
  assert.equal(parseCamdata('rER03').error, 'rER03');
  assert.equal(GAINS[0][0], '80'); assert.equal(GAINS.find((g) => g[1] === '0 dB')[0], '08');
});

test('PTZ catalog: every Companion module action maps to an app command; series gating like the module; spec extras on UE150 only', () => {
  const ids = new Set([...PC.COMMANDS.map((c) => c.id), ...PC.MOTION.map((m) => m.id)]);
  for (const [a, op] of Object.entries(PC.MODULE_ACTIONS)) assert.ok(ids.has(op), `${a} -> ${op}`);
  const src = path.join(__dirname, '..', '..', 'ptz', 'companion-module-panasonic-ptz', 'src', 'actions.js');
  if (fs.existsSync(src)) {
    const found = [...fs.readFileSync(src, 'utf8').matchAll(/actions\.(\w+) = \{/g)].map((m) => m[1]);
    assert.ok(found.length > 70);
    for (const a of found) assert.ok(PC.MODULE_ACTIONS[a], `module action ${a} is covered`);
  }
  assert.equal(PC.seriesFor('AW-UE150'), 'UE150'); assert.equal(PC.seriesFor('AW-UE100'), 'UE150'); assert.equal(PC.seriesFor('AW-HE130'), 'AW-HE130');
  assert.equal(PC.seriesFor('AW-UE150W'), 'UE150', 'suffixes match the longest model id'); assert.equal(PC.seriesFor('NOT-A-CAM'), 'Other'); assert.equal(PC.seriesFor('AW-UE150', 'AW-HE130'), 'AW-HE130', 'manual override');
  const ue = new Set(PC.catalogFor('UE150').ops.map((o) => o.id)); const he = new Set(PC.catalogFor('AW-HE130').ops.map((o) => o.id));
  for (const k of ['rGain', 'bGain', 'rPed', 'bPed', 'masterPed', 'awb', 'abb', 'menu', 'menuUp', 'gamma', 'kneePoint', 'matrixType', 'chromaLevel', 'skinDetail', 'shutterMode', 'synchro', 'scene', 'wbMode', 'tallyGreen', 'thumbnail']) assert.ok(ue.has(k), `UE150 ${k}`);
  assert.ok(!ue.has('shutter'), 'the module has no OSH shutter for UE150 (shutterMode / step / synchro from the spec instead)');
  for (const k of ['shutter', 'pedestal', 'colorTemp', 'colorBarsSetup']) assert.ok(he.has(k), `HE130 ${k}`);
  for (const k of ['rGain', 'menu', 'awb', 'tallyGreen', 'scene']) assert.ok(!he.has(k), `HE130 has no ${k}`);
  // encodings from the spec tables
  const cmd = (op, v, sr = 'UE150') => PC.build(sr, op, v).cmd;
  assert.equal(cmd('rGain', -200), 'OSG:39:738'); assert.equal(cmd('rGain', 0), 'OSG:39:800'); assert.equal(cmd('bGain', 200), 'OSG:3A:8C8');
  assert.equal(cmd('rPed', -100), 'ORP:032'); assert.equal(cmd('bPed', 0), 'OBP:096'); assert.equal(cmd('masterPed', 200), 'OSJ:0F:8C8');
  assert.equal(cmd('varTemp', 2000), 'OSI:20:007D0'); assert.equal(cmd('varTemp', 15000), 'OSI:20:03A98');
  assert.equal(cmd('gamma', 30), 'OSA:6A:67'); assert.equal(cmd('gamma', 75), 'OSA:6A:94'); assert.equal(cmd('kneePoint', 80), 'OSA:20:4A'); assert.equal(cmd('kneePoint', 107), 'OSA:20:B6');
  assert.equal(cmd('chromaLevel', -100), 'OSD:B0:00'); assert.equal(cmd('chromaLevel', -99), 'OSD:B0:1D'); assert.equal(cmd('chromaPhase', 31), 'OSJ:0B:9F');
  assert.equal(cmd('synchro', 60), 'OSJ:09:00258'); assert.equal(cmd('shutterStep', '100'), 'OSJ:06:0064'); assert.equal(cmd('irisMode', true), 'D31');
  assert.equal(cmd('tallyRed', true), 'TLR:1'); assert.equal(cmd('tallyRed', true, 'AW-HE130'), 'DA1', 'no tally2 -> DA1 like the module');
  assert.equal(cmd('colorBarsTone', '2'), 'OSJ:27:2'); assert.equal(cmd('presetSpeed', '999'), 'UPVS999'); assert.equal(cmd('menuCancel'), 'DPG');
  assert.throws(() => PC.build('UE150', 'rGain', 201), (e) => e.status === 400);
  assert.throws(() => PC.build('UE150', 'gain', 'FF'), (e) => e.status === 400);
  assert.throws(() => PC.build('AW-HE130', 'menu', true), (e) => e.status === 409);
  assert.throws(() => PC.build('UE150', 'nope'), (e) => e.status === 404);
});

test('PTZ: every command is the module\'s / spec\'s CGI: aw_ptz cmd=%23... and aw_cam cmd=...; res=1', async () => {
  const { mocks: [m, he], list, stop } = await cams(2);
  const d = new PTZDriver({ cameras: list });
  try {
    await d.connect(); assert.equal(d.status().online, 2);
    const c = d.cameraList()[0]; assert.equal(c.model, 'AW-UE150'); assert.equal(c.title, 'CAM-1'); assert.equal(c.power, 'on'); assert.equal(c.series, 'UE150');
    await d.move('cam1', { pan: 20, tilt: -10 }); await d.stop('cam1');
    await d.zoom('cam1', { speed: 30 }); await d.focus('cam1', { speed: -15 });
    await d.home('cam1'); await d.recall('cam1', 1); await d.store('cam1', 100);
    await d.power('cam1', false); await d.power('cam1', true);
    await d.tally('cam1', true); await d.tally('cam1', true, 'green');
    await d.autoFocus('cam1', false); await d.oneTouchAF('cam1');
    await d.iris('cam1', 42); await d.autoIris('cam1', true);
    await d.gain('cam1', '80'); await d.whiteBalance('cam1', '2');
    assert.deepEqual(cmds(m), ['aw_ptz:PTS7040', 'aw_ptz:PTS5050', 'aw_ptz:Z50', 'aw_ptz:F50', 'aw_ptz:Z80', 'aw_ptz:F35', 'aw_ptz:APC7FFF7FFF', 'aw_ptz:R00', 'aw_ptz:M99',
      'aw_ptz:O0', 'aw_ptz:O1', 'aw_cam:TLR:1', 'aw_cam:TLG:1', 'aw_ptz:D10', 'aw_cam:OSE:69:1', 'aw_ptz:I42', 'aw_ptz:D31', 'aw_cam:OGU:80', 'aw_cam:OAW:2']);
    assert.equal(m.s.wb, '2'); assert.equal(m.s.tallyGreen, 1); assert.ok(m.presets.has(99));
    await d.shutter('cam2', 'A'); await d.tally('cam2', true); assert.equal(he.s.shutter, 'A'); assert.deepEqual(cmds(he), ['aw_cam:OSH:A', 'aw_ptz:DA1']);
    await d.poll('cam1'); const v = d.cameraList()[0]; assert.equal(v.tally, true); assert.equal(v.autoFocus, false); assert.equal(v.gain, '80');
    // paint / RCP / menu commands from the spec, and their read-back through camdata.html
    for (const [op, val] of [['rGain', -12], ['bGain', 30], ['rPed', 5], ['bPed', -5], ['masterPed', 10], ['wbMode', '9'], ['varTemp', 4300], ['awb'], ['abb'], ['shutterMode', '1'], ['shutterStep', '250'],
      ['detail', false], ['masterDetail', 7], ['gammaMode', '7'], ['gamma', 45], ['kneeMode', '1'], ['kneePoint', 90], ['kneeSlope', 20], ['matrixType', '3'], ['matrixRG', -3], ['chromaLevel', 12], ['chromaPhase', -4],
      ['skinDetail', true], ['skinEffect', 9], ['superGain', true], ['ndFilter', '2'], ['scene', '3'], ['presetScope', '2'], ['presetSpeedMode', '1'], ['presetTime', '010'], ['menu', true], ['menuDown'], ['menuEnter'], ['menu', false]]) {
      const r = await d.op('cam1', op, val); assert.equal(r.ok, true, op);
    }
    assert.deepEqual(m.s.menuMoves, ['DDW', 'DIT']);
    assert.equal(m.raw['OSG:39'], '7F4'); assert.equal(m.raw.OBP, '091'); assert.equal(m.raw['OSA:20'], '72'); assert.equal(m.raw.OSF, '2'); assert.equal(m.raw['OSI:20'], '010CC:0');
    await d.poll('cam1');
    const vals = d.cameraList()[0].values;
    for (const [k, want] of Object.entries({ rGain: -12, bGain: 30, rPed: 5, bPed: -5, masterPed: 10, wbMode: '9', varTemp: 4300, shutterMode: '1', shutterStep: '250', detail: false, masterDetail: 7, gammaMode: '7', gamma: 45,
      kneeMode: '1', kneePoint: 90, kneeSlope: 20, matrixType: '3', matrixRG: -3, chromaLevel: 12, chromaPhase: -4, skinDetail: true, skinEffect: 9, superGain: true, ndFilter: '2', scene: '3', presetScope: '2', menu: false })) assert.deepEqual(vals[k], want, `read back ${k}`);
    await assert.rejects(d.op('cam2', 'rGain', 0), (e) => e.status === 409, 'HE130: paint is UE150-spec only');
  } finally { d.close(); await stop(); }
});

test('PTZ: validation (preset 1..100, value lists / ranges) and camera refusals (spec eR / ER replies) are errors', async () => {
  const { mocks: [m], list, stop } = await cams(1);
  const d = new PTZDriver({ cameras: list });
  try {
    for (const f of [() => d.recall('cam1', 0), () => d.store('cam1', 101), () => d.recall('cam1', 1.5), () => d.gain('cam1', 'FF'), () => d.whiteBalance('cam1', '7'), () => d.op('cam1', 'rGain', 999), () => d.op('cam1', 'kneePoint', 60)]) {
      await assert.rejects(f(), (e) => e.status === 400);
    }
    assert.equal(cmds(m).length, 0, 'nothing sent');
    await assert.rejects(d.shutter('cam1', 'A'), (e) => e.status === 409, 'UE150: no module shutter');
    await assert.rejects(d.move('nope', {}), (e) => e.status === 404);
    await d.power('cam1', false);
    await assert.rejects(d.recall('cam1', 3), (e) => e.status === 409 && /eR2/.test(e.message) && /standby/.test(e.message), 'standby camera refuses a recall');
    await assert.rejects(d.op('cam1', 'rGain', 0), (e) => e.status === 409 && /ER2/.test(e.message));
    await d.power('cam1', true);
    await assert.rejects(d.camCmd('cam1', 'OSJ:06'), (e) => e.status === 409 && /ER1/.test(e.message));
    await assert.rejects(d.ptz('cam1', 'XYZ'), /eR1/);
    await assert.rejects(d.op('cam1', 'menuUp'), (e) => e.status === 409 && /ER2/.test(e.message), 'menu navigation with the menu closed');
    assert.ok(d.cameraList()[0].lastError.reply.startsWith('ER2'));
  } finally { d.close(); await stop(); }
});

test('PTZ: proportional moves are sent only on change, coalesced (latest wins) and spaced >= 40 ms; keep-alive sends nothing', async () => {
  const { mocks: [m], list, stop } = await cams(1);
  const d = new PTZDriver({ cameras: list }); d.deadmanMs = 400;
  try {
    await d.poll('cam1'); m.history.length = 0;
    const p = []; for (let i = 1; i <= 10; i++) p.push(d.move('cam1', { pan: i * 4, tilt: -i * 2 }));
    await Promise.all(p);
    const pts = m.calls('PTS');
    assert.ok(pts.length < 10, `coalesced (${pts.length} sent of 10)`); assert.equal(pts.at(-1).cmd, 'PTS9030', 'the latest speed wins');
    for (let i = 1; i < pts.length; i++) assert.ok(pts[i].at - pts[i - 1].at >= 38, 'pan-tilt head commands >= 40 ms apart');
    const n = m.history.length;
    await d.move('cam1', { pan: 40, tilt: -20 }); d.keepalive('cam1'); d.keepalive('cam1');
    assert.equal(m.history.length, n, 'same speed again / keep-alive: nothing sent to the camera');
    // a stop replaces a move that is still waiting in the queue
    const a = d.move('cam1', { pan: -30, tilt: 0 }); const b = d.move('cam1', { pan: -31, tilt: 0 }); const s = d.stop('cam1', ['pt']);
    await Promise.all([a, b, s]); assert.equal(m.s.pt, '5050'); assert.equal(m.calls('PTS1950').length, 0, 'the pending -31 move never went out');
    // zoom / focus are their own axes: stopping pan-tilt does not stop a held zoom
    await d.zoom('cam1', { speed: 20 }); await d.stop('cam1', ['pt']); assert.equal(m.s.z, '70');
    await d.stop('cam1'); assert.equal(m.s.z, '50');
    // the mock integrates speed into position; camdata.html reports it
    await d.move('cam1', { pan: 49, tilt: 0 }); await new Promise((r) => setTimeout(r, 150)); await d.stop('cam1'); await d.poll('cam1');
    assert.ok(d.cameraList()[0].pos.pan > 0, 'panned right');
  } finally { d.close(); await stop(); }
});

test('PTZ: preset thumbnails (spec web CGI) are proxied as images only; preset names go to UE150-series cameras (OSJ:35)', async () => {
  const { mocks: [m, he], list, stop } = await cams(2);
  const d = new PTZDriver({ cameras: list });
  try {
    await d.connect();
    const t = await d.thumbnail('cam1', 2); assert.match(t.type, /^image\/svg\+xml/); assert.match(t.body.toString(), /P002/);
    await assert.rejects(d.thumbnail('cam1', 50), /HTTP 404/, 'empty preset: no thumbnail');
    await assert.rejects(d.thumbnail('cam2', 1), /HTTP 404/, 'HE130: no thumbnail CGI');
    assert.deepEqual(await d.presetName('cam1', 5, 'Lectern: wide ü'), { sent: true }); assert.equal(m.names[4], 'Lectern  wide ');
    assert.deepEqual(await d.presetName('cam2', 5, 'x'), { sent: false }); assert.equal(he.calls('OSJ:35').length, 0);
  } finally { d.close(); await stop(); }
});

test('PTZ: hold-to-run: no keep-alive within the deadman time stops the camera by itself; repeats keep it moving', async () => {
  const { mocks: [m], list, stop } = await cams(1);
  const d = new PTZDriver({ cameras: list }); d.deadmanMs = 150;
  try {
    await d.move('cam1', { pan: -10 }); assert.equal(m.s.pt, '4050'); assert.equal(d.cameraList()[0].moving, true);
    for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 80)); if (i % 2) d.keepalive('cam1'); else await d.move('cam1', { pan: -10 }); }
    assert.equal(m.calls('PTS5050').length, 0, 'still held'); assert.equal(m.calls('PTS4050').length, 1, 'an unchanged speed is not re-sent');
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

test('0.8.0 API: /api/sys long-poll + views=all, PTZ catalog / status / thumbnail / op / keepalive routes', async () => {
  const ctx = await setup({});
  const { mocks, list, stop } = await cams(2);
  const systems = new SystemManager({ dataDir: ctx.dataDir, engine: ctx.engine, overrides: { ptz: { cameras: list } }, autoStart: false });
  const server = createServer(ctx.engine, systems);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: r.headers.get('content-type').includes('json') ? await r.json() : null, r }; };
  try {
    await systems.connect('ptz');
    const st = (await call('GET', '/api/sys')).json;
    // long-poll answers when something changes, with every configured system's view
    const t0 = Date.now(); const waiting = call('GET', `/api/sys?since=${st.rev}&timeout=5000&views=all`);
    await new Promise((r) => setTimeout(r, 100)); await call('POST', '/api/sys/ptz/cmd/tally', { cam: 'cam1', on: true });
    const lp = (await waiting).json; assert.ok(lp.rev > st.rev); assert.ok(Date.now() - t0 < 3000); assert.ok(lp.views.ptz.cameras.length === 2); assert.equal(lp.views.e2, undefined, 'only configured systems');
    const idle = await call('GET', `/api/sys?since=${lp.rev + 1000}&timeout=150`); assert.equal(idle.status, 200, 'timeout answers with the current state');
    assert.ok((await call('GET', '/api/sys/views')).json.views.ptz);
    const cat = (await call('GET', '/api/sys/ptz/cameras/cam1/catalog')).json; assert.equal(cat.series, 'UE150'); assert.ok(cat.ops.find((o) => o.id === 'rGain').range); assert.match(cat.sources.spec, /UE150/);
    assert.equal((await call('GET', '/api/sys/ptz/cameras/cam2/catalog')).json.series, 'AW-HE130');
    assert.equal((await call('POST', '/api/sys/ptz/cmd/op', { cam: 'cam1', op: 'bGain', value: 17 })).json.cmd, 'OSG:3A:811');
    assert.equal((await call('POST', '/api/sys/ptz/cmd/op', { cam: 'cam2', op: 'bGain', value: 17 })).status, 409);
    assert.equal((await call('POST', '/api/sys/ptz/cmd/op', { cam: 'cam1', op: 'bGain', value: 900 })).status, 400);
    const sx = (await call('GET', '/api/sys/ptz/cameras/cam1/status')).json; assert.equal(sx.values.bGain, 17); assert.ok(sx.pos && 'pan' in sx.pos);
    // proportional move with explicit speeds, keep-alive, axis stop
    await call('POST', '/api/sys/ptz/cmd/move', { cam: 'cam1', pan: 7, tilt: -3, speed: true }); assert.equal(mocks[0].s.pt, '5747');
    const n = mocks[0].history.length; assert.equal((await call('POST', '/api/sys/ptz/cmd/keepalive', { cam: 'cam1' })).json.moving, true); assert.equal(mocks[0].history.length, n, 'keep-alive: no camera traffic');
    await call('POST', '/api/sys/ptz/cmd/zoom', { cam: 'cam1', value: 12, speed: true }); assert.equal(mocks[0].s.z, '62');
    await call('POST', '/api/sys/ptz/cmd/stop', { cam: 'cam1', axes: ['pt'] }); assert.equal(mocks[0].s.pt, '5050'); assert.equal(mocks[0].s.z, '62');
    await call('POST', '/api/sys/ptz/cmd/stop', { cam: 'cam1' }); assert.equal(mocks[0].s.z, '50');
    // recall with a preset speed (UPVS first), store pushes the name to the camera (UE150 series)
    await call('POST', '/api/sys/ptz/cmd/recall', { cam: 'cam1', preset: 3, speed: '750' }); assert.deepEqual(mocks[0].history.filter((h) => /^UPVS|^R/.test(h.cmd)).map((h) => h.cmd).slice(-2), ['UPVS750', 'R02']);
    await call('POST', '/api/sys/ptz/cmd/store', { cam: 'cam1', preset: 7, name: 'Choir' }); assert.equal(mocks[0].names[6], 'Choir');
    const th = await call('GET', '/api/sys/ptz/cameras/cam1/thumbnail/7'); assert.equal(th.status, 200); assert.match(th.r.headers.get('content-type'), /image\/svg/); assert.match(th.r.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal((await call('GET', '/api/sys/ptz/cameras/cam1/thumbnail/60')).status, 404);
    assert.ok(!ctx.engine.logs.some((l) => /thumbnail/.test(l.msg || l.message || '')), 'missing thumbnails are not logged as errors');
    // a per-camera series override changes the command set
    await call('POST', '/api/sys/ptz/cameras/cam1', { series: 'AW-HE130' });
    assert.equal((await call('GET', '/api/sys/ptz/cameras/cam1/catalog')).json.series, 'AW-HE130');
    await call('POST', '/api/sys/ptz/cameras/cam1', { series: '' }); assert.equal((await call('GET', '/api/sys/ptz/cameras/cam1/catalog')).json.series, 'UE150');
  } finally { server.closeClients(); await new Promise((r) => server.close(r)); systems.close(); await stop(); await ctx.teardown(); }
});

test('0.9.1: absolute zoom / focus, D.EXT, OIS, pan / tilt limits, tally setup, tracking out: encodings, mock replies, readback', async () => {
  const cmd = (op, v, sr = 'UE150') => PC.build(sr, op, v).cmd;
  assert.equal(cmd('zoomPos', 0), 'AXZ555'); assert.equal(cmd('zoomPos', 50), 'AXZAAA'); assert.equal(cmd('zoomPos', 100), 'AXZFFF'); assert.equal(cmd('focusPos', 100), 'AXFFFF');
  assert.equal(cmd('limitLeft', true), 'LC31'); assert.equal(cmd('limitDown', false), 'LC20'); assert.equal(cmd('tallyEnable', false), 'TAE0');
  assert.equal(cmd('tallyBright', '2'), 'OSA:D3:2'); assert.equal(cmd('dExtender', '1'), 'OSJ:4E:1'); assert.equal(cmd('ois', true), 'OIS:1');
  const he = new Set(PC.catalogFor('AW-HE130').ops.map((o) => o.id));
  for (const k of ['zoomPos', 'focusPos', 'limitUp', 'dExtender', 'ois', 'tallyBright', 'trackIP', 'snapshot', 'streamInfo']) assert.ok(!he.has(k), `HE130 has no ${k}`);
  const { list, mocks, stop } = await cams(2);
  const d = new PTZDriver(); d.configure({ cameras: list });
  try {
    await d.poll('cam1'); await d.poll('cam2');
    assert.equal((await d.op('cam1', 'zoomPos', 50)).cmd, 'AXZAAA'); assert.equal(mocks[0].history.at(-1).path, 'aw_ptz');
    await assert.rejects(d.op('cam1', 'focusPos', 40), /eR2|auto focus|refus/i, 'absolute focus needs manual focus');
    await d.op('cam1', 'focusMode', false); await d.op('cam1', 'focusPos', 40);
    await d.op('cam1', 'limitUp', true); await d.op('cam1', 'limitRight', true); await d.op('cam1', 'tallyEnable', false); await d.op('cam1', 'tallyBright', '2'); await d.op('cam1', 'trackIP', true);
    await d.poll('cam1'); const v = d.values(d.cam('cam1'));
    assert.equal(v.limitUp, true); assert.equal(v.limitRight, true); assert.equal(v.limitLeft, false); assert.equal(v.tallyEnable, false); assert.equal(v.trackIP, true);
    assert.ok(Math.abs(v.zoomPos - 50) < 0.2, `zoom readback ${v.zoomPos}`);
    await assert.rejects(d.op('cam2', 'zoomPos', 10), /not|series|support/i);
    // preview frame and stream info: UE150 series only, image types only
    const sn = await d.snapshot('cam1'); assert.match(sn.type, /^image\//); assert.ok(sn.body.length > 200);
    await assert.rejects(d.snapshot('cam2'), (e) => e.status === 404);
    const si = await d.streamInfo('cam1'); assert.equal(si.rtspPort, 554); assert.ok(si.streams.length >= 2); assert.match(si.streams[0].url, /^rtsp:\/\/127\.0\.0\.1\//);
    assert.match((await d.streamInfo('cam2')).note, /no stream/);
  } finally { d.close && d.close(); await stop(); }
});

test('0.9.1: notes, paint lock (also for Companion: 423), paint memories save / load, snapshot + info routes, show file', async () => {
  const ctx = await setup({});
  const { mocks, list, stop } = await cams(2);
  const systems = new SystemManager({ dataDir: ctx.dataDir, engine: ctx.engine, overrides: { ptz: { cameras: list } }, autoStart: false });
  const server = createServer(ctx.engine, systems);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: (r.headers.get('content-type') || '').includes('json') ? await r.json() : null, r }; };
  const cam = async (id = 'cam1') => (await call('GET', '/api/sys/ptz')).json.cameras.find((c) => c.id === id);
  try {
    await systems.connect('ptz');
    const ver = (await call('GET', '/api/version')).json; assert.equal(ver.apiVersion, 8, 'still API 8: module 0.6 / 0.7 stay compatible'); const feats = ver.features;
    for (const f of ['ptzSnapshot', 'ptzPaintLock', 'ptzPaintMemory', 'ptzNotes']) assert.ok(feats.includes(f), `feature ${f}`);
    // notes
    await call('POST', '/api/sys/ptz/cmd/notes', { cam: 'cam1', text: 'Long lens, riser' }); assert.equal((await cam()).notes, 'Long lens, riser');
    // paint memory: save, change, load back
    await call('POST', '/api/sys/ptz/cmd/op', { cam: 'cam1', op: 'rGain', value: -20 }); await call('POST', '/api/sys/ptz/cmd/op', { cam: 'cam1', op: 'gammaMode', value: '3' });
    const sv = await call('POST', '/api/sys/ptz/cmd/paintSave', { cam: 'cam1', slot: 2, name: 'Warm' }); assert.equal(sv.status, 200); assert.ok(sv.json.count > 10);
    assert.equal((await cam()).paintMem[2].name, 'Warm');
    await call('POST', '/api/sys/ptz/cmd/op', { cam: 'cam1', op: 'rGain', value: 30 }); await call('POST', '/api/sys/ptz/cmd/op', { cam: 'cam1', op: 'gammaMode', value: '0' });
    const ld = await call('POST', '/api/sys/ptz/cmd/paintLoad', { cam: 'cam1', slot: 2 }); assert.equal(ld.status, 200); assert.deepEqual(ld.json.failed, []);
    const sx = (await call('GET', '/api/sys/ptz/cameras/cam1/status')).json; assert.equal(sx.values.rGain, -20); assert.equal(sx.values.gammaMode, '3');
    assert.equal((await call('POST', '/api/sys/ptz/cmd/paintLoad', { cam: 'cam1', slot: 4 })).status, 404);
    assert.equal((await call('POST', '/api/sys/ptz/cmd/paintSave', { cam: 'cam1', slot: 9 })).status, 400);
    // lock: paint groups refused (the Companion module uses the same route), exposure / lens / motion stay live
    await call('POST', '/api/sys/ptz/cmd/lock', { cam: 'cam1', on: true }); assert.equal((await cam()).locked, true);
    const n = mocks[0].history.length;
    const catOps = new Map((await call('GET', '/api/sys/ptz/cameras/cam1/catalog')).json.ops.map((o) => [o.id, o]));
    for (const op of ['rGain', 'detail', 'gamma', 'matrixRG', 'chromaLevel', 'wbMode', 'scene']) { const o = catOps.get(op); const val = o.type === 'range' ? (o.range.centre ?? o.range.min) : o.type === 'toggle' ? true : o.options[0][0]; assert.equal((await call('POST', '/api/sys/ptz/cmd/op', { cam: 'cam1', op, value: val })).status, 423, op); }
    assert.equal(mocks[0].history.length, n, 'nothing reached the camera');
    assert.equal((await call('POST', '/api/sys/ptz/cmd/paintLoad', { cam: 'cam1', slot: 2 })).status, 423);
    assert.equal((await call('POST', '/api/sys/ptz/cmd/op', { cam: 'cam1', op: 'iris', value: 40 })).status, 200, 'iris is not paint');
    assert.equal((await call('POST', '/api/sys/ptz/cmd/op', { cam: 'cam2', op: 'iris', value: 40 })).status, 200, 'other cameras unaffected');
    // show file keeps notes, locks and memories
    const sp = systems.showPart(); const show = (sp.systems || sp).ptz;
    assert.equal(show.notes.cam1, 'Long lens, riser'); assert.equal(show.locks.cam1, true); assert.ok(show.paintMem.cam1[2].values.rGain === -20);
    await call('POST', '/api/sys/ptz/cmd/lock', { cam: 'cam1', on: false }); assert.equal((await call('POST', '/api/sys/ptz/cmd/op', { cam: 'cam1', op: 'rGain', value: 0 })).status, 200);
    // preview frame + stream info routes
    const sn = await call('GET', '/api/sys/ptz/cameras/cam1/snapshot'); assert.equal(sn.status, 200); assert.match(sn.r.headers.get('content-type'), /^image\//); assert.equal(sn.r.headers.get('cache-control'), 'no-store'); assert.match(sn.r.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal((await call('GET', '/api/sys/ptz/cameras/cam2/snapshot')).status, 404);
    const inf = (await call('GET', '/api/sys/ptz/cameras/cam1/info')).json; assert.equal(inf.host, '127.0.0.1'); assert.ok(inf.streams.length >= 2);
    assert.ok(!ctx.engine.logs.some((l) => /snapshot/i.test(l.msg || l.message || '')), 'missing preview frames are not logged as errors');
  } finally { server.closeClients(); await new Promise((r) => server.close(r)); systems.close(); await stop(); await ctx.teardown(); }
});
