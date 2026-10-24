'use strict';
// 0.12.0 Stream Deck camera surface: the UE150 functions the deck pages need (DRS OSE:33, Day/Night #D6, Freeze During
// Preset #PRF, spec v2.94) and the live recall guard for deck recalls on a camera with its red tally on.
// Mock cameras on 127.0.0.1 only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PC = require('../lib/drivers/ptz-commands');
const { parseCamdata } = require('../lib/drivers/ptz');
const { MockPTZ } = require('../lib/mocks/ptz');
const { SystemManager } = require('../lib/systems');
const { createServer } = require('../lib/server');
const { setup } = require('./helpers');

const b = (op, v, sr = 'UE150') => PC.build(sr, op, v);

test('UE150 deck functions: DRS, night mode, freeze during preset (codes, gating, read back)', () => {
  assert.deepEqual([b('drs', '0').cmd, b('drs', '3').cmd, b('drs', '1').path], ['OSE:33:0', 'OSE:33:3', 'cam']);
  assert.throws(() => b('drs', '4'), (e) => e.status === 400);
  assert.deepEqual([b('dayNight', true).cmd, b('dayNight', false).cmd, b('dayNight', true).path], ['D61', 'D60', 'ptz']);
  assert.deepEqual([b('freezePreset', true).cmd, b('freezePreset', false).cmd, b('freezePreset', true).path], ['PRF1', 'PRF0', 'ptz']);
  for (const id of ['drs', 'dayNight', 'freezePreset']) assert.throws(() => b(id, true, 'AW-HE130'), (e) => e.status === 409, `${id} is UE150-series only`);
  const raw = parseCamdata('OID:AW-UE150\r\nd61\r\npRF1\r\nOSE:33:0x2\r\n').raw;
  assert.deepEqual([raw.d6, raw.pRF, raw['OSE:33']], ['1', '1', '2']);
  const rb = PC.readback('UE150', raw); assert.equal(rb.dayNight, true); assert.equal(rb.freezePreset, true); assert.equal(rb.drs, '2');
  // every function the deck pages use exists on the UE150
  const ids = new Set(PC.catalogFor('UE150').ops.map((o) => o.id));
  for (const id of ['tallyRed', 'power', 'focusMode', 'oneTouchAF', 'ois', 'colorBars', 'dExtender', 'freezePreset', 'presetSpeed', 'irisMode', 'drs', 'dayNight',
    'iris', 'gain', 'shutterStepUp', 'ndFilter', 'wbMode', 'awb', 'rGain', 'bGain', 'rPed', 'bPed', 'masterPed', 'detail', 'masterDetail', 'gammaMode', 'gamma', 'kneeMode', 'kneePoint', 'matrixType', 'chromaLevel']) assert.ok(ids.has(id), id);
});

test('mock UE150: night mode refuses AWB (spec), freeze during preset and DRS read back from camdata', () => {
  const m = new MockPTZ({ model: 'AW-UE150' });
  assert.equal(m.ptz('D61'), 'd61'); assert.match(m.cam('OWS'), /^ER3/, 'AWB is unavailable at night');
  assert.equal(m.ptz('D60'), 'd60'); assert.equal(m.cam('OWS'), 'OWS');
  assert.equal(m.ptz('PRF1'), 'pRF1'); assert.equal(m.cam('OSE:33:3'), 'OSE:33:3'); assert.match(m.cam('OSE:33:4'), /^ER3/);
  const raw = parseCamdata(m.camdata()).raw; assert.equal(raw.pRF, '1'); assert.equal(raw.d6, '0'); assert.equal(raw['OSE:33'], '3');
  const he = new MockPTZ({ model: 'AW-HE130' }); assert.match(he.ptz('D61'), /^eR1/); assert.match(he.ptz('PRF1'), /^eR1/);
});

test('live recall guard: deck recalls on a red-tally camera need a hold (HOLD) or are refused (LOCK); HTTP routes; saved in shows', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6deck-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const m = new MockPTZ({ model: 'AW-UE150', title: 'CAM-1' }); const port = await m.start(0); t.after(() => m.stop());
  const ctx = await setup({}); t.after(() => ctx.teardown()); const eng = ctx.engine;
  const sm = new SystemManager({ dataDir: dir, engine: eng, overrides: { ptz: { cameras: [{ id: 'cam1', name: 'Wide', host: '127.0.0.1', port }] } }, autoStart: false });
  const server = createServer(eng, sm); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeClients && server.closeClients(); server.close(); await sm.close(); });
  const B = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body) => { const r = await fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  await sm.drivers.ptz.poll('cam1');
  assert.deepEqual(sm.view('ptz').liveGuard, { mode: 'hold', holdMs: 600 }, 'default: hold 600 ms');
  // not live: a guarded recall goes straight through
  assert.equal((await post('/api/sys/ptz/cmd/recall', { cam: 'cam1', preset: 2, guarded: true })).status, 200); assert.equal(m.lastRecall, 1);
  // live (red tally on)
  await sm.ptz('tally', { cam: 'cam1', on: true }); await sm.drivers.ptz.poll('cam1'); assert.equal(sm.view('ptz').cameras[0].tally, true);
  let r = await post('/api/sys/ptz/cmd/recall', { cam: 'cam1', preset: 3, guarded: true }); assert.equal(r.status, 423); assert.match(r.json.error, /hold the preset key 600 ms/); assert.equal(m.lastRecall, 1, 'nothing sent');
  assert.equal((await post('/api/sys/ptz/cmd/recall', { cam: 'cam1', preset: 3, guarded: true, confirmed: true })).status, 200); assert.equal(m.lastRecall, 2, 'held: recalled');
  assert.equal((await post('/api/sys/ptz/cmd/recall', { cam: 'cam1', preset: 4 })).status, 200, 'the app\'s own recall is not guarded'); assert.equal(m.lastRecall, 3);
  // LOCK, cycle, holdMs, bad mode
  r = await post('/api/sys/ptz/cmd/guard', { mode: 'cycle' }); assert.deepEqual(r.json.liveGuard, { mode: 'lock', holdMs: 600 });
  r = await post('/api/sys/ptz/cmd/recall', { cam: 'cam1', preset: 5, guarded: true, confirmed: true }); assert.equal(r.status, 423); assert.match(r.json.error, /locked/);
  r = await post('/api/sys/ptz/cmd/guard', { mode: 'cycle' }); assert.equal(r.json.liveGuard.mode, 'off');
  assert.equal((await post('/api/sys/ptz/cmd/recall', { cam: 'cam1', preset: 5, guarded: true })).status, 200); assert.equal(m.lastRecall, 4);
  r = await post('/api/sys/ptz/cmd/guard', { mode: 'hold', holdMs: 99999 }); assert.deepEqual(r.json.liveGuard, { mode: 'hold', holdMs: 3000 }, 'holdMs clamped to 200..3000');
  assert.equal((await post('/api/sys/ptz/cmd/guard', { mode: 'maybe' })).status, 400);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'systems.json'), 'utf8')).sessions.ptz.liveGuard, { mode: 'hold', holdMs: 3000 }, 'saved');
  // shows: written only when changed from the default, applied back
  assert.deepEqual(sm.showPart().systems.ptz.liveGuard, { mode: 'hold', holdMs: 3000 });
  sm.applyShowPart({ systems: { ptz: { presetNames: {}, speeds: {}, liveGuard: { mode: 'lock', holdMs: 800 } } } }); assert.deepEqual(sm.view('ptz').liveGuard, { mode: 'lock', holdMs: 800 });
  sm.applyShowPart({ systems: { ptz: { presetNames: {}, speeds: {} } } }); assert.deepEqual(sm.view('ptz').liveGuard, { mode: 'hold', holdMs: 600 }, 'an older show: the default');
  assert.equal(sm.showPart().systems.ptz.liveGuard, undefined, 'the default is not written, so older shows hash the same');
  // the new functions through the API, read back in the view
  for (const [op, value] of [['drs', '2'], ['dayNight', true], ['freezePreset', true]]) assert.equal((await post('/api/sys/ptz/cmd/op', { cam: 'cam1', op, value })).status, 200, op);
  await sm.drivers.ptz.poll('cam1'); const v = sm.view('ptz').cameras[0].values;
  assert.equal(v.drs, '2'); assert.equal(v.dayNight, true); assert.equal(v.freezePreset, true);
  assert.ok(m.history.some((h) => h.path === 'aw_ptz' && h.cmd === 'PRF1') && m.history.some((h) => h.path === 'aw_cam' && h.cmd === 'OSE:33:2'));
  const ver = await (await fetch(`${B}/api/version`)).json(); for (const f of ['ptzLiveGuard', 'ptzDeckFunctions', 'scopes']) assert.ok(ver.features.includes(f), f);
});
