'use strict';
// 0.35.0: Companion buttons for Control Center deck keys draw Control Center's own pictures.
// Every key / strip cell / knob in GET /api/companion/deck has an "img" id (a hash of the SVG
// Control Center draws for it); GET /api/companion/deck/art/<id>.png is that picture.
process.env.RS6_QUIET = '1';
process.env.CC_DECK_USB = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DeckService } = require('../lib/decks/service');
const { CompanionBridge } = require('../lib/companion/bridge');
const { DeckArt, dialSvg, ART_SIZES } = require('../lib/companion/deck-art');
const { keyModel } = require('../lib/decks/look');
const { keySvg } = require('../lib/deck-image');
const { snapshot } = require('../lib/deck');
const { catalogFor } = require('../lib/drivers/ptz-commands');

const isPng = (buf) => Buffer.isBuffer(buf) && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const pngSize = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)];

function rig(values = { rGain: 0, bGain: 0, iris: 26 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-art-'));
  const svc = new DeckService({ dataDir: dir, systems: null, usbEnv: { CC_DECK_USB: '0' } });
  const view = () => ({ rev: 1, selected: 'cam1', cameras: [{ id: 'cam1', name: 'CAM 1', connected: true, series: 'UE150', values }] });
  svc.desk = () => ({ armed: ['ptz'], byKey: { ptz: { cameras: [{ id: 'cam1', name: 'CAM 1', host: '10.0.0.9', port: 80 }], selected: 'cam1' } } });
  svc.ptzSnap = () => snapshot(view(), catalogFor);
  svc.runAction = async (a) => { if (a.path === '/api/sys/ptz/cmd/step' && a.body && a.body.op in values) values[a.body.op] += a.body.steps; return { ok: true }; };
  const bridge = new CompanionBridge({ dataDir: dir, decks: svc, appVersion: '0.35.0', apiVersion: 9 });
  return { dir, svc, bridge, values, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('art ids are content addressed: same key same id, a new tally or value a new id', () => {
  const art = new DeckArt();
  const a = art.key({ label: 'CAM 2', caption: 'CAM', tally: 'pvw' });
  assert.match(a, /^[0-9a-f]{20}$/);
  assert.equal(art.key({ label: 'CAM 2', caption: 'CAM', tally: 'pvw' }), a);
  assert.notEqual(art.key({ label: 'CAM 2', caption: 'CAM', tally: 'pgm' }), a);
  assert.notEqual(art.key({ label: 'CAM 3', caption: 'CAM', tally: 'pvw' }), a);
  assert.equal(art.svgs.get(a).svg, keySvg(keyModel({ label: 'CAM 2', caption: 'CAM', tally: 'pvw' })), 'the very SVG the Control Devices page and a USB deck draw');
});

test('a picture is a PNG at the advertised size; unknown and malformed ids are null', () => {
  const art = new DeckArt();
  const k = art.key({ label: 'IRIS', caption: 'AUTO', on: true });
  const png = art.png(k);
  assert.ok(isPng(png));
  assert.deepEqual(pngSize(png), ART_SIZES.key);
  assert.equal(art.png(k), png, 'rendered once, then cached');
  const d = art.widget('gainRb', {}, 0);
  assert.deepEqual(pngSize(art.png(d)), ART_SIZES.strip);
  assert.equal(art.png('0'.repeat(20)), null);
  assert.equal(art.png('../../etc/passwd'), null);
  assert.equal(art.png(''), null);
});

test('the store is bounded (oldest pictures dropped first)', () => {
  const art = new DeckArt({ maxSvgs: 5, maxPngs: 2 });
  const ids = [];
  for (let i = 0; i < 8; i++) ids.push(art.key({ label: `K${i}` }));
  assert.equal(art.svgs.size, 5);
  assert.equal(art.has(ids[0]), false);
  assert.equal(art.has(ids[7]), true);
  for (const id of ids.slice(-3)) art.png(id);
  assert.equal(art.pngs.size, 2);
});

test('strip art follows the USB strip: segment for ATEM strips, readout knob, PTZ widget knob', () => {
  assert.match(dialSvg({ strip: { kind: 'time', text: '30f' }, label: 'AUTO' }), /AUTO[\s\S]*30f/);
  assert.match(dialSvg({ label: 'IRIS', readout: '34', fraction: 0.4 }), />34<[\s\S]*>IRIS</);
  assert.match(dialSvg({ widget: 'gainRb', stepIndex: 0 }, {}), /R GAIN/);
  assert.equal(dialSvg(null), null);
  assert.equal(dialSvg({ widget: 'nope' }, {}), null);
});

test('the deck model gives every key, strip cell, knob and PTZ dial a picture id', () => {
  const { bridge, cleanup } = rig();
  try {
    const m = bridge.deckModel({ surfaces: 'plusxl' });
    assert.equal(m.art.url, '/api/companion/deck/art/');
    assert.equal(m.art.ext, '.png');
    assert.match(m.art.blank, /^[0-9a-f]{20}$/);
    const s = m.surfaces[0];
    const ptz = s.pages.find((p) => p.system === 'ptz');
    assert.ok(ptz.keys.length > 0);
    for (const k of [...s.live.keys, ...ptz.keys]) assert.match(k.img, /^[0-9a-f]{20}$/, `key ${k.row}/${k.col}`);
    assert.ok(ptz.dials.length > 0);
    for (const d of ptz.dials) { assert.match(d.img, /^[0-9a-f]{20}$/); assert.match(d.knobImg, /^[0-9a-f]{20}$/); }
    for (const w of Object.values(m.widgets)) assert.match(w.img, /^[0-9a-f]{20}$/);
    for (const k of ptz.keys) assert.ok(isPng(bridge.art.png(k.img)));
    // a key's picture is the stamped key Control Center draws on a USB deck of that size
    const face = bridge.decks.companionFaces('plusxl').pages.find((p) => p.system === 'ptz').face;
    const k0 = face.keys.filter(Boolean)[0];
    const slot = ptz.keys.find((k) => k.row === k0.row && k.col === k0.col);
    assert.equal(bridge.art.svgs.get(slot.img).svg, keySvg(keyModel(k0)));
  } finally { cleanup(); }
});

test('a new camera value changes the strip picture id and the rev, not the layout', async () => {
  const { bridge, values, cleanup } = rig();
  try {
    const a = bridge.deckModel({ surfaces: 'plusxl' });
    values.rGain = 12; values.bGain = -7;
    const b = bridge.deckModel({ surfaces: 'plusxl' });
    assert.notEqual(a.widgets.gainRb.img, b.widgets.gainRb.img);
    assert.notEqual(a.rev, b.rev);
    assert.equal(a.layoutRev, b.layoutRev);
  } finally { cleanup(); }
});

test('deckArt answers a PNG for a model id, cached for good; 404 for an unknown id', () => {
  const { bridge, cleanup } = rig();
  try {
    const m = bridge.deckModel({ surfaces: 'plusxl' });
    const out = bridge.deckArt(m.surfaces[0].live.keys[0].img);
    assert.equal(out.__binary.type, 'image/png');
    assert.match(out.__binary.cache, /immutable/);
    assert.ok(isPng(out.__binary.body));
    assert.throws(() => bridge.deckArt('f'.repeat(20)), (e) => e.status === 404);
  } finally { cleanup(); }
});

test('a pinned page export has every key cell, blank ones too, so the placed page matches tile for tile', () => {
  const { bridge, cleanup } = rig();
  try {
    const j = bridge.deckCompanionConfig('plusxl', 'ptz.0').json;
    for (let row = 0; row < 4; row++) assert.equal(Object.keys(j.page.controls[row]).length, 9, `row ${row}`);
    assert.equal(j.page.controls[3][8].feedbacks[0].type, 'cc_deck_look');
  } finally { cleanup(); }
});

test('HTTP: the art route is served and the feature is announced', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server.js'), 'utf8');
  assert.ok(server.includes("companion\\/deck\\/art\\/([0-9a-f]{20})\\.png$"));
  const { FEATURES } = require('../lib/engine');
  if (FEATURES) assert.ok(FEATURES.includes('companionDeckArt'));
  else assert.match(fs.readFileSync(path.join(__dirname, '..', 'lib', 'engine.js'), 'utf8'), /'companionDeckArt'/);
});

test('fonts: only the sans and mono files are loaded (fast), with system fonts as the fallback', () => {
  const { fontOptions, withFamilies, FONT_CANDIDATES } = require('../lib/companion/deck-art');
  const mac = new Set(['/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Menlo.ttc']);
  const m = fontOptions({}, (f) => mac.has(f));
  assert.deepEqual(m.fontFiles, [...mac]);
  assert.equal(m.loadSystemFonts, false);
  assert.equal(m.monospaceFamily, 'Menlo');
  assert.equal(m.sansSerifFamily, 'Arial');
  const pi = new Set(['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf']);
  const p = fontOptions({}, (f) => pi.has(f));
  assert.equal(p.monospaceFamily, 'DejaVu Sans Mono');
  assert.equal(p.sansSerifFamily, 'DejaVu Sans');
  assert.equal(fontOptions({}, () => false).loadSystemFonts, true);
  assert.deepEqual(fontOptions({ CC_ART_FONTS: '/a.ttf:/b.ttf' }, (f) => f === '/b.ttf').fontFiles, ['/b.ttf']);
  assert.ok(FONT_CANDIDATES.mono.length && FONT_CANDIDATES.sans.length);
  const svg = '<text font-family="ui-monospace, Menlo, Consolas, monospace">1</text><text font-family="Arial, Helvetica, sans-serif">A</text>';
  assert.equal(withFamilies(svg, { monospaceFamily: 'Menlo', sansSerifFamily: 'Arial' }), svg, 'a Mac: unchanged');
  assert.match(withFamilies(svg, { monospaceFamily: 'DejaVu Sans Mono', sansSerifFamily: 'DejaVu Sans' }), /Consolas, DejaVu Sans Mono, monospace"[\s\S]*Helvetica, DejaVu Sans, sans-serif"/);
});
