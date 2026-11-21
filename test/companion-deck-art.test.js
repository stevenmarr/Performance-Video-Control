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

test('a picture is a PNG at the advertised size; unknown and malformed ids are null', async () => {
  const art = new DeckArt();
  const k = art.key({ label: 'IRIS', caption: 'AUTO', on: true });
  const png = await art.png(k);
  assert.ok(isPng(png));
  assert.deepEqual(pngSize(png), ART_SIZES.key);
  assert.equal(await art.png(k), png, 'rendered once, then cached');
  const d = art.widget('gainRb', {}, 0);
  assert.deepEqual(pngSize(await art.png(d)), ART_SIZES.strip);
  assert.equal(await art.png('0'.repeat(20)), null);
  assert.equal(await art.png('../../etc/passwd'), null);
  assert.equal(await art.png(''), null);
});

test('the store is bounded (oldest pictures dropped first)', async () => {
  const art = new DeckArt({ maxSvgs: 5, maxPngs: 2 });
  const ids = [];
  for (let i = 0; i < 8; i++) ids.push(art.key({ label: `K${i}` }));
  assert.equal(art.svgs.size, 5);
  assert.equal(art.has(ids[0]), false);
  assert.equal(art.has(ids[7]), true);
  for (const id of ids.slice(-3)) await art.png(id);
  assert.equal(art.pngs.size, 2);
});

test('strip art follows the USB strip: segment for ATEM strips, readout knob, PTZ widget knob', () => {
  assert.match(dialSvg({ strip: { kind: 'time', text: '30f' }, label: 'AUTO' }), /AUTO[\s\S]*30f/);
  assert.match(dialSvg({ label: 'IRIS', readout: '34', fraction: 0.4 }), />34<[\s\S]*>IRIS</);
  assert.match(dialSvg({ widget: 'gainRb', stepIndex: 0 }, {}), /R GAIN/);
  assert.equal(dialSvg(null), null);
  assert.equal(dialSvg({ widget: 'nope' }, {}), null);
});

test('the deck model gives every key, strip cell, knob and PTZ dial a picture id', async () => {
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
    for (const k of ptz.keys) assert.ok(isPng(await bridge.art.png(k.img)));
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

test('deckArt answers a PNG for a model id, cached for good; 404 for an unknown id', async () => {
  const { bridge, cleanup } = rig();
  try {
    const m = bridge.deckModel({ surfaces: 'plusxl' });
    const out = await bridge.deckArt(m.surfaces[0].live.keys[0].img);
    assert.equal(out.__binary.type, 'image/png');
    assert.match(out.__binary.cache, /immutable/);
    assert.ok(isPng(out.__binary.body));
    await assert.rejects(bridge.deckArt('f'.repeat(20)), (e) => e.status === 404);
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
  assert.equal(fontOptions({}, () => false, () => null).loadSystemFonts, true, 'nothing found anywhere: every system font');
  assert.deepEqual(fontOptions({ CC_ART_FONTS: '/a.ttf:/b.ttf' }, (f) => f === '/b.ttf').fontFiles, ['/b.ttf']);
  assert.ok(FONT_CANDIDATES.mono.length && FONT_CANDIDATES.sans.length);
  const svg = '<text font-family="ui-monospace, Menlo, Consolas, monospace">1</text><text font-family="Arial, Helvetica, sans-serif">A</text>';
  assert.equal(withFamilies(svg, { monospaceFamily: 'Menlo', sansSerifFamily: 'Arial' }), svg, 'a Mac: unchanged');
  assert.match(withFamilies(svg, { monospaceFamily: 'DejaVu Sans Mono', sansSerifFamily: 'DejaVu Sans' }), /Consolas, DejaVu Sans Mono, monospace"[\s\S]*Helvetica, DejaVu Sans, sans-serif"/);
});

// ---------- 0.35.1: drawn off the main thread; fonts found when the usual ones are missing ----------

test('0.35.1 the main thread keeps running while a picture is drawn (resvg renderAsync)', async () => {
  const art = new DeckArt({ font: { loadSystemFonts: true, defaultFontFamily: 'Arial', monospaceFamily: 'Menlo' } });
  const ids = Array.from({ length: 4 }, (_, i) => art.key({ label: `SLOW ${i}`, caption: 'CAM' }));
  let ticks = 0; let maxGap = 0; let last = Date.now();
  const iv = setInterval(() => { const now = Date.now(); maxGap = Math.max(maxGap, now - last); last = now; ticks++; }, 5);
  let early = false; setImmediate(() => { early = true; });
  const t0 = Date.now();
  const pngs = await Promise.all(ids.map((id) => art.png(id)));
  const took = Date.now() - t0;
  clearInterval(iv);
  assert.ok(early, 'the event loop turned before the first picture was done (a synchronous render would block it)');
  for (const p of pngs) assert.ok(isPng(p));
  // with every system font loaded each picture costs tens to hundreds of ms of CPU; none of it lands on this thread
  if (took > 100) assert.ok(ticks >= 3, `timers kept firing during ${took} ms of drawing (${ticks} ticks, biggest gap ${maxGap} ms)`);
});

test('0.35.1 one render per id however many ask, and at most `renders` at a time', async () => {
  let running = 0; let peak = 0; let calls = 0;
  const fake = async () => { calls++; running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 10)); running--; return { asPng: () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }; };
  const art = new DeckArt({ renders: 2, renderAsync: fake, font: { loadSystemFonts: false } });
  const ids = Array.from({ length: 6 }, (_, i) => art.key({ label: `K${i}` }));
  const out = await Promise.all([...ids, ...ids].map((id) => art.png(id)));
  assert.equal(calls, 6, 'each id drawn once');
  assert.equal(peak, 2);
  assert.ok(out.every(isPng));
  assert.equal(art.pending.size, 0);
});

test('0.35.1 fonts: reads family names from font files and picks a sans and a mono family when the usual files are missing', () => {
  const { fontOptions, fontFamily, discoverFonts } = require('../lib/companion/deck-art');
  // a minimal sfnt with a name table: nameID 1 = "Test Sans" (Windows, UTF-16BE)
  const sfnt = (fam) => {
    const str = Buffer.from(fam, 'utf16le').swap16();
    const name = Buffer.alloc(6 + 12 + str.length);
    name.writeUInt16BE(0, 0); name.writeUInt16BE(1, 2); name.writeUInt16BE(18, 4);
    name.writeUInt16BE(3, 6); name.writeUInt16BE(1, 8); name.writeUInt16BE(0x409, 10); name.writeUInt16BE(1, 12); name.writeUInt16BE(str.length, 14); name.writeUInt16BE(0, 16);
    str.copy(name, 18);
    const head = Buffer.alloc(12 + 16);
    head.writeUInt32BE(0x00010000, 0); head.writeUInt16BE(1, 4);
    head.write('name', 12, 'latin1'); head.writeUInt32BE(28, 20); head.writeUInt32BE(name.length, 24);
    return Buffer.concat([head, name]);
  };
  const files = { '/f/TestSans-Regular.ttf': 'Test Sans', '/f/TestSans-Bold.ttf': 'Test Sans', '/f/TestSans-Italic.ttf': 'Test Sans', '/f/TestMono-Regular.ttf': 'Test Mono', '/f/Fancy-Serif.ttf': 'Fancy' };
  const read = (f) => sfnt(files[f]);
  assert.equal(fontFamily('/f/TestSans-Regular.ttf', read), 'Test Sans');
  assert.equal(fontFamily('/x.ttc', () => Buffer.from('ttcf0000000000000000')), null);
  const found = discoverFonts(Object.keys(files), (f) => fontFamily(f, read));
  assert.deepEqual(found.sans, { family: 'Test Sans', files: ['/f/TestSans-Regular.ttf', '/f/TestSans-Bold.ttf'] });
  assert.deepEqual(found.mono, { family: 'Test Mono', files: ['/f/TestMono-Regular.ttf'] });
  const o = fontOptions({}, () => false, () => found);
  assert.equal(o.loadSystemFonts, false);
  assert.equal(o.sansSerifFamily, 'Test Sans');
  assert.equal(o.monospaceFamily, 'Test Mono');
  assert.deepEqual(o.fontFiles, ['/f/TestSans-Regular.ttf', '/f/TestSans-Bold.ttf', '/f/TestMono-Regular.ttf']);
  assert.equal(fontOptions({ CC_ART_FONTS: '/none.ttf' }, () => false, () => found).loadSystemFonts, true, 'CC_ART_FONTS set: no searching');
});

test('0.35.1 responsiveness: the app answers within 300 ms while it draws a whole page set with every system font', { timeout: 120000 }, async (t) => {
  const { spawn } = require('child_process');
  // a port from the OS (a random one could be another test's mock, which then answered or never answered)
  const port = await new Promise((resolve) => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-art-live-'));
  // CC_ART_FONTS pointing at nothing = the slow path (every system font, ~150 ms a picture), the worst case
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--port', String(port), '--host', '127.0.0.1', '--data', data], { stdio: 'ignore', env: { ...process.env, RS6_QUIET: '1', CC_DECK_USB: '0', CC_ART_FONTS: '/nonexistent.ttf' } });
  const exited = new Promise((r) => app.once('exit', r)); // made now, so an app that already died is not awaited forever
  t.after(async () => { app.kill(); await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]); fs.rmSync(data, { recursive: true, force: true, maxRetries: 5 }); });
  const base = `http://127.0.0.1:${port}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // every request has a deadline, so nothing can leave the file waiting forever
  const get = (p, ms = 10000) => fetch(`${base}${p}`, { signal: AbortSignal.timeout(ms) });
  let up = false;
  for (let i = 0; i < 300 && !up && app.exitCode === null; i++) { try { up = (await get('/api/version', 2000)).ok; } catch { await sleep(100); } }
  assert.ok(up && app.exitCode === null, `app up (exit code ${app.exitCode})`);
  const m = await (await get('/api/companion/deck?surface=plusxl')).json();
  const ids = new Set();
  const walk = (o) => { if (!o || typeof o !== 'object') return; for (const [k, v] of Object.entries(o)) { if ((k === 'img' || k === 'knobImg' || k === 'blank') && typeof v === 'string') ids.add(v); else walk(v); } };
  walk(m);
  const list = [...ids].slice(0, 40);
  assert.ok(list.length >= 20, `pictures in the model (${list.length})`);
  let stop = false; let worst = 0; let samples = 0;
  const probe = (async () => { while (!stop) { const t0 = Date.now(); await get('/api/version'); worst = Math.max(worst, Date.now() - t0); samples++; await sleep(25); } })();
  const t0 = Date.now(); let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => { while (next < list.length) { const id = list[next++]; const r = await get(`/api/companion/deck/art/${id}.png`, 30000); assert.equal(r.status, 200); assert.ok(isPng(Buffer.from(await r.arrayBuffer()))); } }));
  const took = Date.now() - t0;
  stop = true; await probe;
  // measured: 0.35.0 (drawing on the main thread) ~710 ms worst here, 2130 ms for a whole page set; 0.35.1 10-30 ms
  assert.ok(worst < 300, `GET /api/version answered within 300 ms while ${list.length} pictures took ${took} ms (worst ${worst} ms over ${samples} samples)`);
});
