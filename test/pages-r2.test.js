'use strict';
// 0.36.0: Control Center pages round 2. The PTZ camera row shows only the cameras that exist (no sample CAM 2 green /
// CAM 3 red), page titles name the system when two of a kind are on the desk, pinned pages' navigation keys say
// which page they open, a page can be exported without the deck look (to restyle in Companion), and every catalog
// page has a small picture for PV Companion's list.
process.env.RS6_QUIET = '1';
process.env.CC_DECK_USB = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DeckService } = require('../lib/decks/service');
const { CompanionBridge } = require('../lib/companion/bridge');
const { navTarget } = require('../lib/companion/deck-mirror');
const { snapshot } = require('../lib/deck');
const { catalogFor } = require('../lib/drivers/ptz-commands');

function rig({ cams = 1, systems = ['ptz'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-r2-'));
  const svc = new DeckService({ dataDir: dir, systems: null, usbEnv: { CC_DECK_USB: '0' } });
  const list = Array.from({ length: cams }, (_, i) => ({ id: `cam${i + 1}`, name: i === 0 ? 'PULPIT' : `CAM${i + 1}`, host: '10.0.0.9', port: 80 }));
  const view = () => ({ rev: 1, selected: 'cam1', cameras: list.map((c) => ({ id: c.id, name: c.name, connected: true, series: 'UE150', values: {} })) });
  const byKey = {};
  systems.forEach((key, i) => { byKey[key] = { key, type: 'ptz', label: `PTZ ${i + 1}`, short: `PTZ ${i + 1}`, cameras: list, selected: 'cam1' }; });
  svc.desk = () => ({ armed: systems.slice(), byKey });
  svc.ptzSnap = () => snapshot(view(), catalogFor);
  svc.runAction = async () => ({ ok: true });
  const bridge = new CompanionBridge({ dataDir: dir, decks: svc, appVersion: '0.36.0', apiVersion: 9 });
  return { dir, svc, bridge };
}
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });
const ptzPages = (svc, surface = 'plusxl') => svc.companionFaces(surface).pages.filter((p) => p.type === 'ptz' || /^ptz/.test(p.system));
const row = (face, r) => (face.keys || []).filter((k) => k && k.row === r).sort((a, b) => a.col - b.col);

test('one camera: the PTZ camera row has that camera only, no sample green / red CAM 2 / CAM 3', () => {
  const { dir, svc } = rig({ cams: 1 });
  const pages = ptzPages(svc);
  assert.ok(pages.length > 3);
  for (const p of pages) {
    const keys = p.face.keys.filter(Boolean);
    const camKeys = keys.filter((k) => k.cam);
    assert.ok(camKeys.every((k) => k.cam === 'cam1'), `${p.title}: only the one camera`);
    assert.ok(!keys.some((k) => /^CAM ?[2-8]$/.test(String(k.label))), `${p.title}: no CAM 2..8 keys`);
    assert.ok(!keys.some((k) => k.tone === 'pvw' || (k.tone === 'stop' && !k.cam && /CAM/.test(String(k.label)))), `${p.title}: no fixed preview / program tone`);
    assert.ok(!keys.some((k) => k.label === '◂ CAM' || k.label === 'CAM ▸'), `${p.title}: no camera stepping with one camera`);
    const cams = keys.filter((k) => k.label === 'CAMS');
    assert.ok(cams.every((k) => k.nav === 'page'), `${p.title}: CAMS is a page jump, not a 7–12 camera bank`);
  }
  const msu = pages[0];
  const r0 = row(msu.face, 0);
  assert.equal(r0[1].label, 'PULPIT');
  assert.equal(r0[1].caption, 'ON');
  assert.ok(r0.slice(2).every((k) => k.tone === 'blank'), 'the rest of the camera row is empty');
  cleanup(dir);
});

test('three cameras: three named camera keys, no sample tones, stepping keys back', () => {
  const { dir, svc } = rig({ cams: 3 });
  const msu = ptzPages(svc)[0];
  const r0 = row(msu.face, 0);
  assert.deepEqual(r0.slice(1, 4).map((k) => k.label), ['PULPIT', 'CAM2', 'CAM3']);
  assert.deepEqual(r0.slice(1, 4).map((k) => k.tone), ['go', 'func', 'func']);
  assert.ok(r0.slice(4).every((k) => k.tone === 'blank'));
  const rcp = ptzPages(svc).find((p) => /RCP/.test(p.title));
  assert.ok(rcp.face.keys.some((k) => k && k.label === 'CAM ▸' && k.action));
  cleanup(dir);
});

test('two PTZ systems: every PTZ page title starts with its own system name', () => {
  const { dir, svc, bridge } = rig({ cams: 1, systems: ['ptz', 'ptz-b'] });
  const pages = svc.companionFaces('plusxl').pages;
  const one = pages.filter((p) => p.system === 'ptz');
  const two = pages.filter((p) => p.system === 'ptz-b');
  assert.ok(one.length && two.length);
  assert.ok(one.every((p) => p.title.startsWith('PTZ 1 · ')), one.map((p) => p.title).join());
  assert.ok(two.every((p) => p.title.startsWith('PTZ 2 · ')));
  const xl = bridge.catalog().deck.find((d) => d.surface === 'plusxl');
  assert.ok(xl.pages.some((p) => p.instance === 'PTZ 2' && p.system === 'ptz-b'));
  assert.equal(xl.pages[0].whole, true);
  cleanup(dir);
});

test('one PTZ system: titles stay as they were', () => {
  const { dir, svc } = rig({ cams: 1 });
  assert.ok(svc.companionFaces('plusxl').pages.filter((p) => p.system === 'ptz').every((p) => !p.title.includes(' · PTZ')));
  cleanup(dir);
});

test('pinned pages: HOME, page and system keys say which page they open ("go")', () => {
  assert.equal(navTarget({ nav: 'home' }, 'ptz'), 'home.0');
  assert.equal(navTarget({ nav: 'system', system: 'atem' }, null), 'atem.0');
  assert.equal(navTarget({ nav: 'page', page: 3 }, 'ptz'), 'ptz.3');
  assert.equal(navTarget({ nav: 'console' }, null), 'console.0');
  assert.equal(navTarget({ nav: 'page', page: 1, pick: 'out1' }, 'atem'), '');
  assert.equal(navTarget({ action: {} }, 'ptz'), '');
  const { dir, bridge } = rig({ cams: 1 });
  const gos = (id) => {
    const out = [];
    const { controls } = bridge.catalogExport(id).json.page;
    for (const byCol of Object.values(controls)) for (const c of Object.values(byCol)) {
      const a = c.steps[0].action_sets.down[0];
      if (a && a.options.go) out.push(a.options.go);
    }
    return out;
  };
  assert.ok(gos('deck:plusxl:home.0').includes('ptz.0'));
  assert.ok(gos('deck:plusxl:ptz.0').includes('home.0'));
  assert.deepEqual(gos('deck:plusxl:'), [], 'the whole deck follows Control Center, no jumps');
  cleanup(dir);
});

test('look: false exports the page without the deck look feedbacks (restyle in Companion), keys still run CC', () => {
  const { dir, bridge } = rig({ cams: 1 });
  const all = (j) => Object.values(j.page.controls).flatMap((r) => Object.values(r));
  const plain = all(bridge.catalogExport('deck:plusxl:ptz.0', { look: false }).json);
  assert.ok(plain.every((c) => c.feedbacks.length === 0));
  assert.ok(plain.some((c) => c.steps[0].action_sets.down.some((a) => a.action === 'cc_deck_key')));
  assert.ok(all(bridge.catalogExport('deck:plusxl:ptz.0').json).some((c) => c.feedbacks.some((f) => f.type === 'cc_deck_look')));
  cleanup(dir);
});

test('every catalog page has a small picture (PNG)', async (t) => {
  try { require.resolve('@resvg/resvg-js'); } catch { t.skip('needs @resvg/resvg-js'); return; }
  const { dir, bridge } = rig({ cams: 2 });
  bridge.userPages.save({ name: 'Mine', page: { name: 'Mine', controls: { 0: { 0: { type: 'button', style: { text: 'GO\nnow', color: 0xffffff, bgcolor: 0x003300 }, steps: {}, feedbacks: [] } } }, gridSize: { minColumn: 0, maxColumn: 8, minRow: 0, maxRow: 5 } }, instances: {}, version: 6 });
  const ids = ['deck:plusxl:', 'deck:plusxl:ptz.0', 'deck:mk2:home.0', `user:${bridge.userPages.list()[0].id}`];
  for (const id of ids) {
    const out = await bridge.catalogPreview(id);
    const png = out.__binary.body;
    assert.equal(out.__binary.type, 'image/png');
    assert.equal(png.subarray(1, 4).toString(), 'PNG', id);
    assert.ok(png.readUInt32BE(16) > 100 && png.readUInt32BE(16) < 800, `${id}: small (${png.readUInt32BE(16)} px wide)`);
  }
  await assert.rejects(bridge.catalogPreview('nope'), /id is/);
  await assert.rejects(bridge.catalogPreview('deck:plusxl:ptz.99'), /No page/);
  cleanup(dir);
});
