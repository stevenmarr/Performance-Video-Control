'use strict';
// PixelHue preset-kind commands (freeze, aux route, still recall, backup restore, arm) against the mock.
// The mock speaks the published OpenAPI paths. Nothing here contacts a switcher.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PixelHueDriver } = require('../lib/drivers/pixelhue');
const { MockPixelHue } = require('../lib/mocks/pixelhue');
const { SystemManager } = require('../lib/systems');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rs6ph-'));
function fakeEngine() { return { settings: { host: '192.0.2.10', restPort: 80, awjPort: 10606, protocol: 'rest' }, presets: [], destinations: [], live: { inputs: {} }, log() {}, changed() {} }; }
async function ph() { const m = new MockPixelHue(); const port = await m.start(0); const d = new PixelHueDriver({ host: '127.0.0.1', port }); return { m, d, port, stop: () => m.stop() }; }
const writes = (m) => m.history.filter((h) => h.method !== 'GET');

test('PixelHue connect only reads, and arming a destination does not transmit', async () => {
  const { m, d, stop } = await ph();
  try {
    await d.connect();
    assert.deepEqual(m.history.map((h) => h.method + ' ' + h.path), ['GET /v1/node/open-detail', 'GET /v1/screen/list-detail']);
    assert.equal(d.capabilities.freeze, true);
    assert.equal(d.capabilities.auxRoute, true);
    assert.equal(d.capabilities.stills, true);
    assert.equal(d.capabilities.backups, true);
    assert.equal(d.capabilities.armDestinations, true);
    assert.equal(d.capabilities.cues, false, 'playlist transport is not in the published guide');
    assert.deepEqual(await d.select(['S1', 'A1'], ['S1', 'S2', 'S3', 'A1']), ['S1', 'A1']);
    assert.deepEqual(writes(m), [], 'select() records the arm and does not send');
  } finally { await stop(); }
});

test('PixelHue freeze is PUT /v1/screen/freeze for a screen, an aux, or the program screen showing an input', async () => {
  const { m, d, stop } = await ph();
  try {
    await d.connect();
    await d.freeze('screen', 'S2', true);
    assert.deepEqual(m.calls('PUT', '/v1/screen/freeze')[0].body, [{ screenId: 2, screenGuid: 'scr-2-guid', freeze: 1 }]);
    await d.freeze('aux', 'A1', false);
    assert.equal(m.calls('PUT', '/v1/screen/freeze')[1].body[0].freeze, 0);
    assert.equal(m.calls('PUT', '/v1/screen/freeze')[1].body[0].screenId, 101);
    await d.freeze('input', 1, true);
    assert.deepEqual(m.calls('PUT', '/v1/screen/freeze')[2].body, [{ screenId: 1, screenGuid: 'scr-1-guid', freeze: 1 }]);
    const src = await d.listSources();
    assert.equal(src.length, 8, 'gallery rows stay off the input list the existing driver test counts');
    assert.equal(src.find((s) => s.id === 1).frozen, true);
    assert.equal(src.find((s) => s.id === 8).status, 'no signal');
    const n = m.history.length;
    await assert.rejects(d.freeze('input', 4, true), /no program screen is showing input 4/);
    assert.equal(m.history.length, n + 1, 'the miss reads layers and does not freeze');
    assert.equal(m.history[m.history.length - 1].method, 'GET');
  } finally { await stop(); }
});

test('PixelHue aux route sets the aux layer source; still recall uses BKG source type 5', async () => {
  const { m, d, stop } = await ph();
  try {
    await d.connect();
    await d.routeAux('A1', 3, 'preview');
    assert.deepEqual(m.calls('PUT', '/v1/layers/source')[0].body, [{ layerId: 101, source: { general: { sourceId: 3, sourceType: 2, relationId: 0 } } }]);
    await d.routeAux('A1', 6, 'program');
    assert.equal(m.calls('PUT', '/v1/layers/source')[1].body[0].layerId, 102);
    await assert.rejects(d.routeAux('S1', 1), /Not an aux destination/);
    const stills = await d.listStills();
    assert.deepEqual(stills.map((s) => s.name), ['Hold Logo', 'Sponsor']);
    assert.equal(stills[0].id, 0, 'slot id is the gallery sequence, so the shared pane shows Still 1');
    assert.equal(stills[0].size, '1920×1080');
    const n = writes(m).length;
    await assert.rejects(d.recallStill(1, { dest: 'S1', target: 'program' }), /confirm: true/);
    assert.equal(writes(m).length, n, 'program recall without confirm sends nothing');
    await d.recallStill(1, { dest: 'S1', target: 'preview' });
    assert.deepEqual(m.calls('PUT', '/v1/layers/source').at(-1).body, [{ layerId: 12, source: { general: { sourceId: 1, sourceType: 5, relationId: 0 } } }]);
    await d.recallStill(0, { dest: 'S1', target: 'program', confirm: true });
    assert.equal(m.calls('PUT', '/v1/layers/source').at(-1).body[0].layerId, 11);
    const before = m.history.length;
    await assert.rejects(d.takeStill(1, 0), /still overwrite needs confirm: true/);
    await assert.rejects(d.takeStill(1, 0, { confirm: true }), /not in the published OpenAPI/);
    await assert.rejects(d.takeStill(1, 9), /not in the published OpenAPI/);
    await assert.rejects(d.deleteStill(0), /still delete needs confirm: true/);
    await assert.rejects(d.deleteStill(0, { confirm: true }), /not in the published OpenAPI/);
    assert.ok(m.history.slice(before).every((h) => h.method === 'GET'), 'capture and delete never write');
  } finally { await stop(); }
});

test('PixelHue backup restore needs confirm; choosing the live backup does not', async () => {
  const { m, d, stop } = await ph();
  try {
    await d.connect();
    const rows = await d.listBackups();
    const cam2 = rows.find((r) => r.id === 2);
    assert.equal(cam2.name, 'Cam 2');
    assert.equal(cam2.active, 0);
    assert.deepEqual(cam2.backups.map((b) => b.inputId), [8]);
    const n = writes(m).length;
    await assert.rejects(d.selectBackup(2, -1), /backup restore needs confirm: true/);
    assert.equal(writes(m).length, n);
    await d.selectBackup(2, 0);
    assert.deepEqual(m.calls('PUT', '/v1/layers/source').at(-1).body, [{ layerId: 21, source: { general: { sourceId: 8, sourceType: 2, relationId: 0 } } }]);
    await d.selectBackup(2, -1, { confirm: true });
    assert.equal(m.calls('PUT', '/v1/layers/source').at(-1).body[0].source.general.sourceId, 2);
    const cues = await d.listCues();
    assert.deepEqual(cues.map((c) => ({ id: c.id, screens: c.screens })), [{ id: 2, screens: ['S1'] }]);
    await assert.rejects(d.activateCue(2, 'play'), /no play, pause, or stop write/);
    assert.ok(writes(m).every((h) => h.path === '/v1/layers/source'));
  } finally { await stop(); }
});

test('PixelHue systems refresh lists the new reads and does not fire a write on connect', async () => {
  const dir = tmp();
  const { m, port, stop } = await ph();
  try {
    const sm = new SystemManager({ dataDir: dir, engine: fakeEngine(), autoStart: false });
    sm.updateConnection('pixelhue', { host: '127.0.0.1', port });
    await sm.setActive('pixelhue');
    assert.deepEqual(writes(m), []);
    const v = sm.view('pixelhue');
    assert.equal(v.capabilities.freeze, true);
    assert.equal(v.capabilities.auxRoute, true);
    assert.equal(v.stills.length, 2);
    assert.ok(v.backups.some((b) => b.id === 2 && b.active === 0));
    assert.equal(v.sources.find((s) => s.id === 1).frozen, false);
    await sm.setSelection('pixelhue', ['S1', 'A1']);
    assert.deepEqual(writes(m), [], 'arming through the desk sends nothing');
    await sm.freeze('pixelhue', 'screen', 'S3', true);
    assert.equal(m.calls('PUT', '/v1/screen/freeze').at(-1).body[0].screenId, 3);
    await sm.routeAux('pixelhue', 'A1', 4, 'preview');
    assert.equal(m.calls('PUT', '/v1/layers/source').at(-1).body[0].source.general.sourceId, 4);
    await assert.rejects(sm.backup('pixelhue', 2, -1), /backup restore needs confirm: true/);
    await assert.rejects(sm.cue('pixelhue', 2, 'play'), /no cues in its API/);
    sm.close();
  } finally { await stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
