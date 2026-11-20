'use strict';
// 0.33.0: PV Companion's "Control Center pages" (live deck pages, PAGES library pages, user pages saved back), the
// USER PAGES store, and the COMPANION tab's deck-pages advice (why Companion shows only the older presets).
process.env.RS6_QUIET = '1';
process.env.CC_DECK_USB = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DeckService } = require('../lib/decks/service');
const { CompanionBridge } = require('../lib/companion/bridge');
const { UserPages } = require('../lib/companion/user-pages');
const { deckAdvice } = require('../public/companion-advice');
const { snapshot } = require('../lib/deck');
const { catalogFor } = require('../lib/drivers/ptz-commands');

function rig(fetch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cpages-'));
  const svc = new DeckService({ dataDir: dir, systems: null, usbEnv: { CC_DECK_USB: '0' } });
  const view = () => ({ rev: 1, selected: 'cam1', cameras: [{ id: 'cam1', name: 'CAM 1', connected: true, series: 'UE150', values: { rGain: 0, bGain: 0 } }] });
  svc.desk = () => ({ armed: ['ptz'], byKey: { ptz: { cameras: [{ id: 'cam1', name: 'CAM 1', host: '10.0.0.9', port: 80 }], selected: 'cam1' } } });
  svc.ptzSnap = () => snapshot(view(), catalogFor);
  svc.runAction = async () => ({ ok: true });
  const bridge = new CompanionBridge({ dataDir: dir, decks: svc, appVersion: '0.33.0', apiVersion: 9, fetch });
  return { dir, bridge };
}
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });
const page = (n = 2) => ({ name: 'Edited PTZ', controls: { 0: Object.fromEntries([...Array(n)].map((_, c) => [c, { type: 'button', style: { text: `K${c}` }, steps: {}, feedbacks: [] }])) }, gridSize: { minColumn: 0, maxColumn: 8, minRow: 0, maxRow: 5 }, surfaceLayout: 'streamdeck-plus-xl' });

test('the catalog lists the live deck pages per deck size, the library pages and the user pages', () => {
  const { dir, bridge } = rig();
  bridge.userPages.save({ name: 'My PTZ', page: page(), instances: { ccPvControlCenter: { label: 'cc', moduleId: 'pvllc-control-center' } }, origin: 'deck:plusxl:ptz.0', originTitle: 'PTZ paint · MSU' });
  const c = bridge.catalog();
  assert.equal(c.connection, 'ccPvControlCenter');
  assert.equal(c.moduleId, 'pvllc-control-center');
  const xl = c.deck.find((d) => d.surface === 'plusxl');
  assert.equal(xl.layout, 'streamdeck-plus-xl');
  assert.equal(xl.pages[0].id, 'deck:plusxl:');
  assert.ok(xl.pages.some((p) => p.id === 'deck:plusxl:ptz.0'));
  assert.ok(xl.pages.some((p) => p.id === 'deck:plusxl:home.0'));
  assert.deepEqual(c.library, []);
  assert.equal(c.user.length, 1);
  assert.match(c.user[0].id, /^user:u[0-9a-f]{10}$/);
  assert.equal(c.user[0].originTitle, 'PTZ paint · MSU');
  cleanup(dir);
});

test('every catalog page exports as a Companion page (version 6) for PV Companion to place as its own copy', () => {
  const { dir, bridge } = rig();
  const whole = bridge.catalogExport('deck:plusxl:').json;
  assert.equal(whole.version, 6);
  assert.equal(whole.type, 'page');
  assert.equal(whole.page.surfaceLayout, 'streamdeck-plus-xl');
  assert.ok(whole.instances.ccPvControlCenter);
  const ptz = bridge.catalogExport('deck:plusxl:ptz.0').json;
  assert.match(ptz.page.name, /^CC /);
  assert.ok(Object.keys(ptz.page.controls[4] || {}).length, 'the touch strip row is there');
  const u = bridge.userPages.save({ name: 'Mine', page: page(3), instances: {}, version: 17 });
  const ue = bridge.catalogExport(`user:${u.id}`).json;
  assert.equal(ue.version, 17, 'a page saved from PV Companion keeps its file version, so it is not upgraded twice');
  assert.equal(bridge.catalogExport(`user:${bridge.userPages.save({ name: 'Old', page: page(1) }).id}`).json.version, 6);
  assert.equal(ue.page.name, 'Mine');
  assert.equal(Object.keys(ue.page.controls[0]).length, 3);
  for (const bad of ['', 'nope', 'deck', 'library:x:y', 'user:../x']) assert.throws(() => bridge.catalogExport(bad), (e) => e.status === 400 || e.status === 404, bad);
  assert.throws(() => bridge.catalogExport('user:u0000000000'), (e) => e.status === 404);
  cleanup(dir);
});

test('user pages keep only connection labels and module ids: never a config or a secret', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-upages-'));
  const up = new UserPages({ dataDir: dir });
  const saved = up.save({ name: '  Paint  ', page: page(), instances: { ccPvControlCenter: { label: 'cc', moduleId: 'pvllc-control-center', config: { host: '10.0.0.2' }, secrets: { password: 'pw' }, lastUpgradeIndex: 0 }, 'bad id!': { moduleId: 'x' } } });
  assert.equal(saved.name, 'Paint');
  const onDisk = fs.readFileSync(path.join(dir, 'companion-user-pages.json'), 'utf8');
  assert.doesNotMatch(onDisk, /10\.0\.0\.2|"pw"|secrets|"config"/);
  assert.deepEqual(JSON.parse(onDisk).pages[0].instances, { ccPvControlCenter: { label: 'cc', moduleId: 'pvllc-control-center', lastUpgradeIndex: 0 } });
  // reload, update in place, rename, delete
  const again = new UserPages({ dataDir: dir });
  assert.equal(again.list().length, 1);
  const upd = again.save({ id: saved.id, name: 'Paint 2', page: page(5), instances: {} });
  assert.equal(upd.id, saved.id);
  assert.equal(upd.controls, 5);
  assert.equal(again.rename(saved.id, 'Paint 3').name, 'Paint 3');
  assert.throws(() => again.rename(saved.id, '  '), (e) => e.status === 400);
  assert.throws(() => again.save({ name: 'x', page: { name: 'no controls' } }), (e) => e.status === 400);
  assert.throws(() => again.save({ name: 'x', page: 'nope' }), (e) => e.status === 400);
  assert.deepEqual(again.remove(saved.id), { ok: true });
  assert.throws(() => again.remove(saved.id), (e) => e.status === 404);
  assert.equal(new UserPages({ dataDir: dir }).list().length, 0);
  cleanup(dir);
});

test('hello carries the deck pages a 0.13.0 module publishes; check() says which copy of the module runs', async () => {
  const list = [
    { id: 'c1', label: 'rs6presets', moduleId: 'pvllc-control-center', moduleVersionId: '0.11.0', enabled: true },
    { id: 'c2', label: 'cc2', moduleId: 'pvllc-control-center', moduleVersionId: 'builtin', enabled: true },
  ];
  const { dir, bridge } = rig(async () => ({ status: 200, headers: {}, body: JSON.stringify(list) }));
  const v = await bridge.check();
  assert.deepEqual(v.status.connections.map((c) => [c.versionId, c.oldImport]), [['0.11.0', true], ['builtin', false]]);
  bridge.hello({ moduleVersion: '0.13.0', label: 'rs6presets', rev: 'x', presets: 10, deckPresets: 872, deckSurfaces: ['plusxl', 'bogus'], deckState: 'ok', legacyPresets: 'show' });
  const view = bridge.view();
  assert.equal(view.module.deckPresets, 872);
  assert.deepEqual(view.module.deckSurfaces, ['plusxl']);
  assert.equal(view.module.deckReports, true);
  assert.equal(view.deckMinVersion, '0.12.0');
  bridge.hello({ moduleVersion: '0.12.0', presets: 10 });
  assert.equal(bridge.view().module.deckPresets, null);
  assert.equal(bridge.view().module.deckCapable, true);
  assert.equal(bridge.view().module.deckReports, false);
  cleanup(dir);
});

test('the COMPANION tab says why Companion shows only the older presets, and how to turn the deck pages on', () => {
  const base = { deckMinVersion: '0.12.0', deckReportVersion: '0.13.0', status: { connections: [] } };
  const text = (v) => deckAdvice({ ...base, ...v }).map((a) => `${a.cls}: ${a.text}`).join('\n');
  // Steven's case: an imported 0.11.0 next to the built-in, or a 0.12.0 module that does not say
  assert.match(text({ status: { connections: [{ label: 'rs6presets', versionId: '0.11.0', oldImport: true }] } }), /^off: Connection "rs6presets" runs an imported copy of the module \(v0\.11\.0\)/);
  assert.match(text({ module: { version: '0.11.1', label: 'cc' } }), /^off: Module 0\.11\.1 has no deck pages/);
  const t012 = text({ module: { version: '0.12.0', label: 'rs6presets', deckPresets: null } });
  assert.match(t012, /^warn: Module 0\.12\.0 has the deck pages but does not report them/);
  assert.match(t012, /Connections → rs6presets → its settings, set "Control Center deck pages for" to Stream Deck \+ XL/);
  // a 0.13.0 module
  assert.match(text({ module: { version: '0.13.0', deckPresets: 872, deckSurfaces: ['plusxl'], deckState: 'ok' } }), /^ok: Deck pages: 872 presets for Stream Deck \+ XL\. In Companion: Presets → Performance Video Control Center → "CC deck: …" \(listed first\)/);
  assert.match(text({ module: { version: '0.13.0', deckPresets: 0, deckSurfaces: ['plusxl'], deckState: 'error', deckError: 'HTTP 404', label: 'cc' } }), /^off: Deck pages: 0 presets\. The module cannot read them from this app \(HTTP 404\)\..*To turn them on/);
  assert.match(text({ module: { version: '0.13.0', deckPresets: 0, deckSurfaces: [], deckState: 'off' } }), /^off: Deck pages are off: "Control Center deck pages for" is empty/);
  assert.match(text({ module: { version: '0.13.0', deckPresets: 0, deckSurfaces: ['plusxl'], deckState: 'off' } }), /^off: Deck pages: 0 presets for Stream Deck \+ XL\. The module has not started them\. To turn them on/);
  assert.match(text({ module: { version: '0.13.0', deckPresets: 0, deckState: 'loading' } }), /^warn: Deck pages: loading/);
  assert.equal(text({}), '');
});

test('the COMPANION tab has USER PAGES and the advice, and the routes exist', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const tab = read('public/companion-tab.js');
  assert.match(tab, /<h3>USER PAGES<\/h3>/);
  assert.match(tab, /window\.CCAdvice\.deckAdvice\(v\)/);
  assert.match(read('public/index.html'), /<script src="\/companion-advice\.js"><\/script>\s*<script src="\/companion-tab\.js"><\/script>/);
  const server = read('lib/server.js');
  for (const r of ['companion\\/catalog$', 'companion\\/catalog\\/export$', 'companion\\/user-pages$', 'companion\\/user-pages\\/([\\w-]+)$', 'companion\\/user-pages\\/([\\w-]+)\\/companionconfig$']) assert.ok(server.includes(r), r);
  const features = require('../lib/engine').FEATURES || read('lib/engine.js');
  assert.match(String(features), /companionCatalog/);
  assert.match(String(features), /companionUserPages/);
});
