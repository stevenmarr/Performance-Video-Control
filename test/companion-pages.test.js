'use strict';
// 0.9.0 Companion pages: Stream Deck page sets (XL, MK.2, +, + XL) as .companionconfig files for the Companion fork.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const C = require('../lib/companion');
const S = require('../lib/companion/surfaces');
const PS = require('../lib/companion/pageset');
const M = require('../lib/companion/model');

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'companion-input.json'), 'utf8'));
const gen = (o = {}) => C.generate(FIX.state, FIX.views, { seed: 1, now: new Date(2026, 9, 21), connection: { host: '127.0.0.1', port: 8080 }, ...o });
const each = (file, fn) => { for (const [n, p] of Object.entries(file.pages)) for (const [r, row] of Object.entries(p.controls)) for (const [c, ctl] of Object.entries(row)) fn(ctl, Number(r), Number(c), p, Number(n)); };
const entities = (ctl) => [...(ctl.feedbacks || []), ...Object.values(ctl.steps || {}).flatMap((s) => Object.values(s.action_sets).flat())];

// the cells each layout of the fork has (shared-lib/lib/PageSurfaceLayout.ts)
function layoutCells(id) {
  const out = new Set(); const keys = (rows, cols) => { for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.add(`${r}/${c}`); };
  if (id === 'streamdeck-xl') keys(4, 8);
  else if (id === 'streamdeck') keys(3, 5);
  else if (id === 'streamdeck-plus') { keys(2, 4); for (const c of [0, 1, 2, 3]) out.add(`2/${c}`).add(`3/${c}`); }
  else if (id === 'streamdeck-plus-xl') { keys(4, 9); for (const c of [0, 2, 3, 5, 6, 8]) out.add(`4/${c}`).add(`5/${c}`); }
  return out;
}

test('surfaces: the four Stream Deck profiles and their names', () => {
  assert.deepEqual(S.ORDER, ['xl', 'mk2', 'plus', 'plusxl']);
  assert.deepEqual(['xl', 'mk2', 'plus', 'plusxl'].map((k) => [S.PROFILES[k].cols, S.PROFILES[k].rows, S.PROFILES[k].knobCols.length, S.PROFILES[k].layout]),
    [[8, 4, 0, 'streamdeck-xl'], [5, 3, 0, 'streamdeck'], [4, 2, 4, 'streamdeck-plus'], [9, 4, 6, 'streamdeck-plus-xl']]);
  assert.deepEqual(S.gridSize(S.PROFILES.plusxl), { minColumn: 0, maxColumn: 8, minRow: 0, maxRow: 5 });
  assert.deepEqual(S.gridSize(S.PROFILES.mk2), { minColumn: 0, maxColumn: 4, minRow: 0, maxRow: 2 });
  assert.deepEqual(S.parseSurfaces('XL, +,plus-xl,mk.2,xl'), ['xl', 'plus', 'plusxl', 'mk2']);
  assert.deepEqual(S.parseSurfaces(), S.ORDER); assert.deepEqual(S.parseSurfaces('all'), S.ORDER);
  assert.throws(() => S.parseSurfaces('mini'), (e) => e.status === 400 && /Unknown surface "mini"/.test(e.message));
});

test('catalogue: every configured system with its presets, destinations, inputs and cameras', () => {
  const cat = PS.catalogue(FIX.state, FIX.views);
  assert.deepEqual(cat.systems.map((s) => s.id), ['rs6', 'e2', 'pixelhue', 'atem', 'ptz']);
  const by = Object.fromEntries(cat.systems.map((s) => [s.id, s]));
  assert.equal(by.rs6.tiles.length, 12, 'RS6 up to the last used tile'); assert.equal(by.rs6.tiles[0], 'preset_1');
  assert.equal(PS.catalogue(FIX.state, FIX.views, { allTiles: true }).systems[0].tiles.length, 48, 'or every tile of the grid');
  assert.deepEqual(by.rs6.dests, FIX.state.destinations.map((d) => `dest_${d.key}`));
  assert.equal(by.rs6.extra.find((x) => x.key === 'rs6_inputs').items.length, FIX.state.live.inputs.length);
  assert.equal(by.pixelhue.tiles[8], null, 'an empty E2 / PixelHue tile stays an empty key'); assert.equal(by.pixelhue.tiles[9], 'pixelhue_preset_10');
  assert.deepEqual(by.atem.sources, FIX.views.atem.bus.map((b) => b.id));
  assert.deepEqual(by.ptz.cams.map((c) => c.id), ['cam1', 'cam2', 'cam3']);
  assert.deepEqual(PS.catalogue(FIX.state, FIX.views, { systems: ['atem'] }).systems.map((s) => s.id), ['atem']);
  assert.deepEqual(PS.catalogue(null, {}).systems, []);
  assert.throws(() => C.generate(null, {}), (e) => e.status === 409);
});

test('file: a version 12 full export with the rs6-presets connection; one file per surface or one for all', () => {
  const per = gen({ surfaces: 'all' });
  assert.deepEqual(per.files.map((f) => f.name), ['xl', 'mk2', 'plus', 'plusxl'].map((s) => `control-center-${s}-2026-10-21.companionconfig`));
  const all = gen({ surfaces: 'all', combined: true });
  assert.equal(all.files.length, 1); assert.equal(all.files[0].name, 'control-center-pages-2026-10-21.companionconfig');
  assert.equal(all.files[0].pages, per.files.reduce((n, f) => n + f.pages, 0));
  for (const f of [...per.files, ...all.files]) {
    const j = f.json;
    assert.equal(j.version, 12); assert.equal(j.type, 'full');
    assert.deepEqual(Object.keys(j.pages).map(Number), Object.keys(j.pages).map((_, i) => i + 1), 'pages numbered from 1');
    assert.deepEqual(Object.keys(j.instances), ['pv_control_center']);
    const inst = j.instances.pv_control_center;
    assert.equal(inst.moduleId, 'rs6-presets'); assert.equal(inst.label, 'rs6presets'); assert.deepEqual([inst.config.host, inst.config.port, inst.config.systems], ['127.0.0.1', 8080, 'on']);
  }
  const one = gen({ surfaces: 'plus', connection: { id: 'abc', label: 'cc_main', host: 'studio-mac.local', port: 9090 } }).files[0].json;
  assert.deepEqual(Object.keys(one.instances), ['abc']); assert.equal(one.instances.abc.label, 'cc_main'); assert.equal(one.instances.abc.config.host, 'studio-mac.local');
  each(one, (ctl) => { for (const e of entities(ctl)) if (e.connectionId !== 'internal') assert.equal(e.connectionId, 'abc'); if (ctl.presetRef) assert.equal(ctl.presetRef.connectionId, 'abc'); });
  assert.equal(JSON.stringify(gen({ surfaces: 'xl' }).files[0].json), JSON.stringify(gen({ surfaces: 'xl' }).files[0].json), 'repeatable with a seed');
});

test('pages: surface layout set, every button on a cell of that surface, nav links inside the file, every page reachable from HOME', () => {
  for (const sid of S.ORDER) {
    const j = gen({ surfaces: sid }).files[0].json; const P = S.PROFILES[sid];
    const ids = new Map(Object.entries(j.pages).map(([n, p]) => [p.id, Number(n)]));
    assert.equal(ids.size, Object.keys(j.pages).length, 'page ids unique');
    const links = new Map([...ids.values()].map((n) => [n, new Set()]));
    each(j, (ctl, r, c, p, n) => {
      assert.equal(p.surfaceLayout, P.layout); assert.deepEqual(p.gridSize, S.gridSize(P));
      assert.ok(layoutCells(P.layout).has(`${r}/${c}`), `${sid} ${p.name}: ${r}/${c} is not a cell of ${P.layout}`);
      assert.ok(['preset-reference', 'button'].includes(ctl.type));
      for (const e of entities(ctl)) {
        if (e.definitionId === 'set_page') {
          assert.equal(e.connectionId, 'internal'); assert.equal(e.options.surfaceId.value, 'self');
          assert.ok(ids.has(e.options.page.value), `${p.name}: link to a page that is not in the file`); links.get(n).add(ids.get(e.options.page.value));
        }
        if (e.definitionId === 'page_missing') assert.ok(ids.has(e.options.page.value));
        for (const v of Object.values(e.options)) assert.equal(v.isExpression, false);
      }
    });
    assert.match(j.pages[1].name, /HOME$/);
    const seen = new Set([1]); const q = [1];
    while (q.length) for (const t of links.get(q.shift())) if (!seen.has(t)) { seen.add(t); q.push(t); }
    assert.equal(seen.size, ids.size, `${sid}: pages not reachable from HOME: ${[...ids.values()].filter((n) => !seen.has(n)).map((n) => j.pages[n].name)}`);
    for (const [n, out] of links) if (n !== 1) assert.ok(out.has(1), `${sid} ${j.pages[n].name}: no way back HOME`);
  }
});

test('buttons: linked module presets with the refresh probe; navigation copies in the module look', () => {
  const j = gen({ surfaces: 'xl' }).files[0].json;
  const home = j.pages[1].controls[0][0];
  assert.equal(home.type, 'button'); assert.match(home.style.text, /RS6\\nPRESETS/); assert.equal(home.style.size, 'auto', 'section names shrink to fit'); assert.equal(home.style.show_topbar, false);
  assert.equal(home.style.png64, require('../lib/companion/styles').preset);
  assert.deepEqual(home.feedbacks.map((f) => f.definitionId), ['page_missing']);
  const tile = j.pages[2].controls[0][0];
  assert.equal(tile.type, 'preset-reference');
  assert.deepEqual(tile.presetRef, { connectionId: 'pv_control_center', moduleId: 'rs6-presets', presetId: 'preset_1', variableValues: null });
  assert.deepEqual(tile.style.layers, []); assert.equal(tile.checksum, null);
  assert.deepEqual(tile.feedbacks.map((f) => [f.definitionId, f.connectionId]), [['cc_pages_refresh', 'pv_control_center']]);
  // the XL footer: HOME, page arrows, destinations, auto take, status, CUT, TAKE (TAKE bottom right)
  const foot = j.pages[2].controls[3];
  assert.equal(foot[0].type, 'button'); assert.equal(foot[7].presetRef.presetId, 'take'); assert.equal(foot[6].presetRef.presetId, 'cut');
  assert.equal(foot[4].presetRef.presetId, 'auto_take'); assert.equal(foot[5].presetRef.presetId, 'last');
  // HOME links to the PTZ LIVE page (cameras are selected on that page, not from HOME)
  const ptzNav = Object.values(j.pages[1].controls).flatMap((r) => Object.values(r)).find((x) => /PTZ\\nCAMERAS/.test((x.style && x.style.text) || ''));
  assert.ok(ptzNav, 'HOME has a PTZ CAMERAS nav');
  assert.equal(ptzNav.steps[0].action_sets.down[0].definitionId, 'set_page');
});

test('PTZ deck pages (0.12.0 / module 0.9.0): LIVE/PAINT/FUNC/MOVE, HOME top-left, dials on + / + XL', () => {
  const page = (sid, nameRe) => { const j = gen({ surfaces: sid }).files[0].json; return Object.values(j.pages).find((p) => nameRe.test(p.name)); };
  const xl = page('xl', /PTZ LIVE$/);
  assert.equal(xl.controls[0][0].type, 'button'); // HOME
  assert.equal(xl.controls[0][1].presetRef.presetId, 'deck_cam_cam1');
  assert.equal(xl.controls[0][7].presetRef.presetId, 'deck_guard');
  assert.equal(xl.controls[1][0].presetRef.presetId, 'deck_sel_preset_1');
  assert.equal(xl.controls[1][7].presetRef.presetId, 'deck_sel_preset_8');
  assert.equal(xl.controls[2][0].presetRef.presetId, 'deck_sel_preset_9');
  // footer tabs
  const foot = xl.controls[3];
  assert.match(foot[1].style.text, /LIVE/);
  assert.match(foot[2].style.text, /PAINT/);
  assert.equal(foot[7].presetRef.presetId, 'deck_stop_all');
  const paint = page('xl', /PTZ PAINT$/);
  assert.equal(paint.controls[1][0].presetRef.presetId, 'deck_iris_auto');
  const func = page('xl', /PTZ FUNCTIONS$/);
  assert.equal(func.controls[1][0].presetRef.presetId, 'deck_fn_tally');
  assert.ok(Object.values(func.controls).flatMap((r) => Object.values(r)).some((x) => x.presetRef && x.presetRef.presetId === 'deck_fn_drs'));
  const move = page('xl', /PTZ MOVE$/);
  assert.equal(move.controls[1][0].presetRef.presetId, 'deck_move_up');
  // + LIVE: cameras on row 0, presets on row 1, dials iris/mped/zoom/focus
  const plus = page('plus', /PTZ LIVE$/);
  assert.equal(plus.controls[0][1].presetRef.presetId, 'deck_cam_cam1');
  assert.equal(plus.controls[1][1].presetRef.presetId, 'deck_sel_preset_1');
  assert.deepEqual([0, 1, 2, 3].map((c) => plus.controls[3][c].presetRef.presetId), ['iris', 'mped', 'zoom', 'focus'].map((k) => `deck_dial_${k}`));
  assert.deepEqual([0, 1, 2, 3].map((c) => plus.controls[2][c].presetRef.presetId), ['iris', 'mped', 'zoom', 'focus'].map((k) => `deck_strip_${k}`));
  assert.equal(plus.controls[3][0].options.rotaryActions, true);
  const pxl = page('plusxl', /PTZ LIVE$/);
  assert.deepEqual([0, 2, 3, 5, 6, 8].map((c) => pxl.controls[5][c].presetRef.presetId), ['iris', 'mped', 'gain_rb', 'ped_rb', 'zoom', 'focus'].map((k) => `deck_dial_${k}`));
  const mk2 = page('mk2', /PTZ LIVE$/);
  assert.equal(mk2.controls[0][0].type, 'button');
  assert.equal(mk2.controls[1][0].presetRef.presetId, 'deck_sel_preset_1');
  // per-camera bank on XL (listed on HOME)
  const bank = page('xl', /Cam 1 Wide$/);
  assert.ok(bank, 'per-camera bank page');
  assert.equal(bank.controls[1][0].presetRef.presetId, 'deck_cam1_preset_1');
  // non-camera pages on a + page through their section with the first knob, push = HOME
  const j = gen({ surfaces: 'plus' }).files[0].json; const p1 = Object.values(j.pages).find((p) => p.name === 'SD+ ATEM PGM/PVW 1/4');
  const k = p1.controls[3][0]; assert.equal(k.type, 'button'); assert.equal(k.options.rotaryActions, true);
  assert.equal(k.steps[0].action_sets.rotate_right[0].options.page.value, Object.values(j.pages).find((p) => p.name === 'SD+ ATEM PGM/PVW 2/4').id);
  assert.equal(k.steps[0].action_sets.down[0].options.page.value, j.pages[1].id);
});

test('ATEM pages: program row over preview row, keys on the XL third row, CUT / AUTO bottom right', () => {
  const j = gen({ surfaces: 'xl' }).files[0].json; const p = Object.values(j.pages).find((x) => x.name === 'XL ATEM PGM/PVW 1/2');
  const bus = FIX.views.atem.bus.map((b) => b.id);
  assert.deepEqual(Object.values(p.controls[0]).map((x) => x.presetRef.presetId), bus.slice(0, 8).map((id) => `atem_pgm_${id}`));
  assert.deepEqual(Object.values(p.controls[1]).map((x) => x.presetRef.presetId), bus.slice(0, 8).map((id) => `atem_pvw_${id}`));
  assert.equal(p.controls[2][0].presetRef.presetId, 'atem_usk_0_air');
  assert.deepEqual([p.controls[3][6].presetRef.presetId, p.controls[3][7].presetRef.presetId], ['atem_cut', 'atem_auto']);
});

test('styles: the copied backgrounds match the module checkout next to this app (when there is one)', (t) => {
  const mod = path.join(__dirname, '..', '..', 'companion-module-rs6-presets', 'src', 'styles.js');
  if (!fs.existsSync(mod)) return t.skip('module checkout not found');
  const src = require(mod); const copy = require('../lib/companion/styles');
  for (const [k, v] of Object.entries(copy)) assert.equal(v, src[k], `style ${k} differs from the module's`);
});

test('model: a copied button is the legacy v12 shape Companion converts on import', () => {
  const ids = M.idMaker('x');
  const b = M.navButton(ids, 'P1', 'GO');
  assert.deepEqual(Object.keys(b).sort(), ['feedbacks', 'localVariables', 'options', 'steps', 'style', 'type']);
  assert.deepEqual(b.steps[0].options, { runWhileHeld: [] });
  assert.deepEqual(b.feedbacks[0].style.bgcolor, M.COLORS.red);
  const k = M.pageKnob(ids, 'A', 'B', 'H');
  assert.deepEqual(Object.keys(k.steps[0].action_sets), ['down', 'up', 'rotate_left', 'rotate_right']);
  assert.equal(M.presetRef(ids, 'c', 'p', true).options.rotaryActions, true);
});

// ---------- the routes, against the real app in mock mode ----------
const waitHttp = (url, ms = 15000) => { const t0 = Date.now(); return new Promise((res, rej) => { const once = () => http.get(url, (r) => { r.resume(); res(); }).on('error', () => (Date.now() - t0 > ms ? rej(new Error('server did not start')) : setTimeout(once, 200))); once(); }); };
test('/api/companion/pages: the plan per surface, files to download, bad input refused', async (t) => {
  const port = 19000 + Math.floor(Math.random() * 1000); const B = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6cp-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--port', String(port), '--host', '127.0.0.1', '--data', data], { stdio: 'ignore', env: { ...process.env, RS6_QUIET: '1' } });
  t.after(async () => { srv.kill(); await new Promise((r) => (srv.exitCode !== null ? r() : srv.once('exit', r))); fs.rmSync(data, { recursive: true, force: true, maxRetries: 5 }); });
  await waitHttp(`${B}/api/state`);
  let plan;
  for (let i = 0; i < 100; i++) { plan = await (await fetch(`${B}/api/companion/pages`)).json(); if (plan.systems && plan.systems.length >= 5) break; await new Promise((r) => setTimeout(r, 100)); }
  assert.deepEqual(plan.systems, ['rs6', 'e2', 'pixelhue', 'atem', 'ptz']);
  assert.deepEqual(plan.surfaces.map((s) => [s.id, s.layout, s.knobs]), [['xl', 'streamdeck-xl', 0], ['mk2', 'streamdeck', 0], ['plus', 'streamdeck-plus', 4], ['plusxl', 'streamdeck-plus-xl', 6]]);
  assert.equal(plan.surfaces[0].pages[0], 'HOME');
  const r = await fetch(`${B}/api/companion/pages/file?surfaces=plus&host=127.0.0.1&port=${port}&label=cc_test`);
  assert.equal(r.status, 200); assert.match(r.headers.get('content-disposition'), /attachment; filename="control-center-plus-\d{4}-\d\d-\d\d\.companionconfig"/);
  const j = await r.json(); assert.equal(j.version, 12); assert.equal(Object.values(j.instances)[0].label, 'cc_test'); assert.equal(Object.values(j.instances)[0].config.port, port);
  assert.equal(j.companionBuild, `pv-control-center ${require('../package.json').version}`);
  assert.ok(Object.values(j.pages).every((p) => p.surfaceLayout === 'streamdeck-plus'));
  const c = await fetch(`${B}/api/companion/pages/file?surfaces=xl,mk2&combined=1`); assert.equal(c.status, 200);
  assert.deepEqual([...new Set(Object.values((await c.json()).pages).map((p) => p.surfaceLayout))], ['streamdeck-xl', 'streamdeck']);
  assert.equal((await fetch(`${B}/api/companion/pages/file?surfaces=xl,mk2`)).status, 400);
  assert.equal((await fetch(`${B}/api/companion/pages/file?surfaces=mini`)).status, 400);
  assert.equal((await fetch(`${B}/api/companion/pages/file?surfaces=xl&host=a%20b`)).status, 400);
  assert.equal((await fetch(`${B}/api/companion/pages/file?surfaces=xl&label=no%20spaces`)).status, 400);
  assert.ok((await (await fetch(`${B}/api/version`)).json()).features.includes('companionPages'));
});

// ---------- SYSTEMS › COMPANION PAGES (Playwright, skipped when it is not installed) ----------
let pw = null;
try { pw = require('playwright'); } catch { pw = null; }
test('UI: SYSTEMS › COMPANION PAGES lists the four surfaces and downloads the ticked ones (Playwright)', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const port = 19000 + Math.floor(Math.random() * 1000); const B = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6cpu-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--port', String(port), '--host', '127.0.0.1', '--data', data], { stdio: 'ignore' });
  t.after(() => { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); });
  await waitHttp(`${B}/api/state`);
  const browser = await pw.chromium.launch(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {}); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(B + '/');
  await page.locator('.cc-surface').nth(3).waitFor();
  await page.click('#ccRefresh'); await page.waitForFunction(() => /PTZ/.test(document.querySelector('#ccMsg').textContent));
  assert.deepEqual(await page.locator('.cc-surface .cc-name').allTextContents(), ['Stream Deck XL', 'Stream Deck MK.2 / original (15 keys)', 'Stream Deck +', 'Stream Deck + XL']);
  assert.equal(await page.locator('.cc-surface[data-id=plusxl] .cc-grid i.knob').count(), 6);
  assert.equal(await page.inputValue('#ccHost'), '127.0.0.1'); assert.equal(await page.inputValue('#ccPort'), String(port));
  await page.check('.cc-surface[data-id=plus] input');
  const got = [];
  page.on('download', (d) => got.push(d.suggestedFilename()));
  await page.click('#ccDownload');
  await page.waitForFunction(() => /Downloaded 2 files/.test(document.querySelector('#ccMsg').textContent));
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(got.map((n) => n.replace(/-\d{4}-\d\d-\d\d/, '')).sort(), ['control-center-plus.companionconfig', 'control-center-xl.companionconfig']);
  await page.check('#ccCombined'); got.length = 0; await page.click('#ccDownload');
  await page.waitForFunction(() => /Downloaded 1 file$/.test(document.querySelector('#ccMsg').textContent)); await new Promise((r) => setTimeout(r, 300));
  assert.match(got[0], /^control-center-pages-/);
  assert.deepEqual(errors, []);
});
