'use strict';
// 0.6.0 Control Center UI (Playwright, skipped when it is not installed): dashboard cards with live status,
// switching systems swaps the tab set, E2 tiles recall to preview and TAKE, RS6 comes back unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
let pw = null;
try { pw = require('playwright'); } catch { pw = null; }
const waitHttp = (url, ms = 15000) => { const t0 = Date.now(); return new Promise((res, rej) => { const once = () => http.get(url, (r) => { r.resume(); res(); }).on('error', () => (Date.now() - t0 > ms ? rej(new Error('server did not start')) : setTimeout(once, 200))); once(); }); };

test('Control Center: dashboard, E2 presets (dim, recall, TAKE), PixelHue, back to RS6 (Playwright)', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const port = 19000 + Math.floor(Math.random() * 1000); const B = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6cc-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--port', String(port), '--host', '127.0.0.1', '--data', data], { stdio: 'ignore' });
  t.after(() => { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); });
  await waitHttp(`${B}/api/state`);
  const browser = await pw.chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(B + '/');
  for (const k of ['rs6', 'e2', 'pixelhue', 'atem', 'ptz']) await page.locator(`.sys-card[data-card=${k}]`).waitFor();
  assert.equal(await page.locator('.tab[data-tab=system].active').count(), 1, '0.7.0: SYSTEMS is the landing page');
  assert.equal(await page.locator('.sys-card.planned').count(), 0, 'ATEM + PTZ are real systems now');
  await page.locator('.sys-card[data-card=e2] .led.ok, .sys-card[data-card=e2] .led.on').first().waitFor({ timeout: 8000 });
  await page.click('[data-use=e2]');
  await page.waitForFunction(() => document.body.classList.contains('sys-x'));
  assert.equal(await page.locator('.tab[data-tab=xcues]').isVisible(), true);
  assert.equal(await page.locator('.tab[data-tab=presets]').isVisible(), false, 'RS6 tabs hidden while E2 is active');
  await page.click('.tab[data-tab=xpresets]');
  await page.locator('#xgrid .preset[data-key]').first().waitFor();
  // select only Screen 4: S1-only presets dim
  await fetch(`${B}/api/sys/e2/selection`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ destinations: ['S4'] }) });
  await page.waitForFunction(() => document.querySelector('#xgrid .preset[data-key="e2:1"]') && document.querySelector('#xgrid .preset[data-key="e2:1"]').classList.contains('dim'));
  await page.click('#xgrid .preset[data-key="e2:0"]');
  await page.locator('#xgrid .preset[data-key="e2:0"].pvw-full, #xgrid .preset[data-key="e2:0"] .tag.pvw').first().waitFor();
  await page.click('#xTake');
  await page.locator('#xgrid .preset[data-key="e2:0"] .tag.pgm').first().waitFor();
  await page.goto(B + '/');
  await page.click('.tab[data-tab=system]');
  await page.click('[data-use=pixelhue]');
  await page.click('.tab[data-tab=xpresets]');
  await page.locator('#xgrid .preset[data-key^="ph:"]').first().waitFor();
  assert.equal(await page.locator('.tab[data-tab=xcues]').isVisible(), false, 'PixelHue API has no cues');
  await page.click('.tab[data-tab=system]');
  await page.click('[data-use=rs6]');
  await page.waitForFunction(() => !document.body.classList.contains('sys-x'));
  assert.equal(await page.locator('.tab[data-tab=presets]').isVisible(), true);
  assert.deepEqual(errors, []);
});

test('Control Center 0.7.0: SYSTEMS home, group filter, ATEM bus + CUT, PTZ hold-to-move then stop on release (Playwright)', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const port = 20000 + Math.floor(Math.random() * 1000); const B = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6cc7-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--port', String(port), '--host', '127.0.0.1', '--data', data], { stdio: 'ignore' });
  t.after(() => { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); });
  await waitHttp(`${B}/api/state`);
  const api = async (p, body) => (await fetch(B + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
  const browser = await pw.chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(B + '/');
  await page.locator('.sys-card[data-card=atem] .led.ok, .sys-card[data-card=atem] .led.on').first().waitFor({ timeout: 8000 });
  assert.match(await page.locator('header').first().innerText(), /CONTROL\s*CENTER/);
  // group filter: Cameras shows only the PTZ card; a density click must not touch the RS6 tile mode (0.6.0 bug)
  await page.click('[data-group="Cameras"]');
  await page.waitForFunction(() => document.querySelectorAll('.sys-card[data-card]').length === 1);
  assert.equal(await page.locator('.sys-card[data-card=ptz]').count(), 1);
  await page.click('[data-group="all"]'); await page.click('[data-density=compact]'); await page.click('[data-density=cards]');
  assert.equal(await page.locator('[data-group].active').count(), 1, 'only the chosen group chip is lit');
  assert.equal(await page.locator('.mode[data-mode].active').count(), 1, 'RS6 tile mode untouched');
  // ATEM: preview from the bus, then CUT
  await page.click('[data-use=atem]');
  await page.waitForFunction(() => document.body.classList.contains('kind-atem'));
  await page.click('.tab[data-tab=atem]');
  await page.click('#atemPvw [data-pvw="4"]');
  await page.locator('#atemPvw [data-pvw="4"].on-pvw').waitFor();
  await page.click('#atemCut');
  await page.locator('#atemPgm [data-pgm="4"].on-pgm').waitFor();
  assert.equal((await api('/api/sys/atem')).program, 4);
  // PTZ: hold the joystick to the right, the camera moves; release, it stops
  await page.click('.tab[data-tab=system]');
  await page.click('[data-use=ptz]');
  await page.click('.tab[data-tab=pctl]');
  const joy = page.locator('#ptzJoy'); await joy.waitFor();
  await page.locator('#pane-pctl [data-op=iris]').waitFor();
  const box = await joy.boundingBox();
  const grab = async (fx, fy) => { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 3 }); };
  await grab(0.95, 0.5);
  const moving = async () => ((await api('/api/sys/ptz')).cameras.find((c) => c.id === 'cam1') || {}).moving;
  for (let i = 0; i < 40 && !(await moving()); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(await moving(), true, 'held: moving');
  await page.mouse.up();
  for (let i = 0; i < 40 && (await moving()); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(await moving(), false, 'released: stopped');
  // blur while held also stops
  await grab(0.95, 0.5);
  for (let i = 0; i < 40 && !(await moving()); i++) await new Promise((r) => setTimeout(r, 50));
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  for (let i = 0; i < 40 && (await moving()); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(await moving(), false, 'blur: stopped');
  await page.mouse.up();
  await page.click('.tab[data-tab=system]'); await page.click('[data-use=rs6]');
  await page.waitForFunction(() => document.body.classList.contains('kind-rs6'));
  assert.deepEqual(errors, []);
});

test('Control Center 0.8.0: CAMERA CONTROL dashboard: proportional joystick, rockers, RCP knobs, menu, per-model command set (Playwright)', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const port = 21000 + Math.floor(Math.random() * 1000); const B = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6cc8-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--port', String(port), '--host', '127.0.0.1', '--data', data], { stdio: 'ignore' });
  t.after(() => { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); });
  await waitHttp(`${B}/api/state`);
  const api = async (p, body) => (await fetch(B + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
  await api('/api/sys/active', { system: 'ptz' });
  const browser = await pw.chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(B + '/#pctl');
  await page.locator('#pane-pctl [data-op=rGain]').first().waitFor({ timeout: 10000 });
  const cam = async (id = 'cam1') => (await api('/api/sys/ptz')).cameras.find((c) => c.id === id);
  const until = async (fn, what) => { for (let i = 0; i < 60; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } throw new Error(`timed out: ${what}`); };
  // every catalog command of this camera has a control (motion / presets have their own)
  const cat = await (await fetch(`${B}/api/sys/ptz/cameras/cam1/catalog`)).json();
  const ctl = new Set(await page.$$eval('#pane-pctl [data-op]', (els) => els.map((e) => e.dataset.op)));
  const own = new Set(['move', 'zoom', 'focus', 'stop', 'recall', 'store', 'presetName', 'thumbnail', 'speeds', 'keepalive', 'snapshot', 'streamInfo']);
  for (const o of cat.ops) if (!own.has(o.id)) assert.ok(ctl.has(o.id), `control for ${o.id}`);
  // proportional joystick: a small push is slow, a full push is fast (the server reports the PTS code it sent)
  const box = await page.locator('#ptzJoy').boundingBox();
  const cx = box.x + box.width / 2; const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + box.width * 0.18, cy, { steps: 2 });
  const slow = await until(async () => { const c = await cam(); return c.sent && c.sent.pt && c.sent.pt !== 'PTS5050' && c.sent.pt; }, 'slow move');
  await page.mouse.move(cx + box.width * 0.5, cy - box.height * 0.5, { steps: 3 });
  const fast = await until(async () => { const c = await cam(); return c.sent.pt !== slow && c.sent.pt; }, 'fast move');
  const pan = (code) => Number(code.slice(3, 5)) - 50; const tilt = (code) => Number(code.slice(5, 7)) - 50;
  assert.ok(pan(slow) > 0 && pan(slow) < 10, `slow pan ${slow}`); assert.ok(pan(fast) > pan(slow), `faster pan ${fast}`); assert.ok(tilt(fast) > 0, 'up = tilt +');
  // hidden page stops
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await until(async () => !(await cam()).moving, 'hidden: stopped');
  await page.mouse.up();
  await page.evaluate(() => { delete document.hidden; });
  // zoom rocker: proportional too, and releasing stops only zoom
  const z = await page.locator('#ptzZoomR .rk-track').boundingBox();
  await page.mouse.move(z.x + z.width / 2, z.y + z.height / 2); await page.mouse.down(); await page.mouse.move(z.x + z.width / 2, z.y + 4, { steps: 3 });
  await until(async () => { const c = await cam(); return c.sent.z && Number(c.sent.z.slice(1)) > 60; }, 'zoom tele');
  await page.mouse.up();
  await until(async () => (await cam()).sent.z === 'Z50', 'zoom stopped');
  // RCP: knob + buttons send catalog ops and the value reads back
  const rk = page.locator('#pane-pctl [data-pane=paint] [data-op=rGain]');
  await page.click('[data-ptab=paint]'); await rk.locator('[data-step="1"]').click(); await rk.locator('[data-step="1"]').click();
  await until(async () => (await cam()).values.rGain === 2, 'R gain +2');
  const kb = await rk.locator('svg').boundingBox();
  await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2); await page.mouse.down(); await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2 - 30, { steps: 3 }); await page.mouse.up();
  await until(async () => (await cam()).values.rGain > 20, 'R gain drag');
  await page.click('[data-ptab=wb]'); await page.click('#pane-pctl [data-pane=wb] [data-op=wbMode] [data-v="9"]');
  await until(async () => (await cam()).values.wbMode === '9', 'WB VAR');
  await page.click('#pane-pctl [data-op=menu]'); await until(async () => (await cam()).values.menu === true, 'menu on');
  await page.click('#pane-pctl [data-op=menuDown]'); await page.click('#pane-pctl [data-op=menu]'); await until(async () => (await cam()).values.menu === false, 'menu off');
  await page.click('#pane-pctl [data-op=irisMode]'); await until(async () => (await cam()).values.irisMode === false, 'manual iris');
  // presets: thumbnail tiles; STORE asks, RECALL moves
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Lectern' : undefined));
  await page.click('[data-pmode=store]'); await page.click('#ptzGrid [data-cp="4"]');
  await until(async () => ((await cam()).presetNames || {})[4] === 'Lectern', 'stored');
  await page.locator('#ptzGrid [data-cp="4"]:not(.noimg) img').waitFor({ timeout: 5000 });
  await page.click('[data-pmode=recall]'); await page.click('#ptzGrid [data-cp="4"]'); await until(async () => (await cam()).lastPreset === 4, 'recalled');
  // AW-HE130: no paint / menu (UE150-spec commands), its own shutter list
  await page.click('.cam-strip [data-cam=cam3]');
  await page.locator('#pane-pctl [data-slot=exposure] [data-op=shutter]').waitFor({ timeout: 8000 });
  assert.equal(await page.locator('#pane-pctl [data-op=rGain]').count(), 0); assert.equal(await page.locator('#pane-pctl [data-op=menu]').count(), 0);
  assert.equal(await page.locator('[data-ptab=paint]').isDisabled(), true);
  assert.deepEqual(errors, []);
});

test('Control Center 0.9.1: CAMERA CONTROL fills 1280 / 1440 / 1920 (no dead zones, no sideways scroll); paint cards, lock, notes, memories, preview, keys 1-9 (Playwright)', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const port = 22000 + Math.floor(Math.random() * 1000); const B = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6cc91-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--port', String(port), '--host', '127.0.0.1', '--data', data], { stdio: 'ignore' });
  t.after(() => { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); });
  await waitHttp(`${B}/api/state`);
  const api = async (p, body) => (await fetch(B + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
  await api('/api/sys/active', { system: 'ptz' }); await api('/api/sys/ptz/cmd/select', { cam: 'cam1' });
  const browser = await pw.chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Warm' : undefined));
  await page.goto(B + '/#pctl');
  await page.locator('#pane-pctl [data-op=rGain]').first().waitFor({ timeout: 10000 });
  const cam = async (id = 'cam1') => (await api('/api/sys/ptz')).cameras.find((c) => c.id === id);
  const until = async (fn, what) => { for (let i = 0; i < 80; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } throw new Error(`timed out: ${what}`); };
  const metrics = () => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth,
    gaps: [...document.querySelectorAll('#pane-pctl .rcp>.panel')].map((p) => { const r = p.getBoundingClientRect(); const bot = Math.max(...[...p.children].filter((k) => k.offsetParent !== null).map((k) => k.getBoundingClientRect().bottom)); return [p.className, r.bottom - bot]; }),
    cards: [...document.querySelectorAll('#pane-pctl .pcard:not(.hide)')].length, tabs: getComputedStyle(document.querySelector('#ptzPaintTabs .ptab')).display !== 'none' }));
  for (const [w, h, allCards] of [[1920, 1080, true], [1440, 900, false], [1280, 800, true]]) {
    await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(500);
    const m = await metrics();
    assert.ok(m.sw <= m.w, `${w}: no sideways scroll (${m.sw})`);
    for (const [cls, gap] of m.gaps) assert.ok(gap < 40, `${w}: ${cls} has ${Math.round(gap)} px empty at the bottom`);
    if (allCards) { assert.equal(m.cards, 8, `${w}: every paint group side by side`); assert.equal(m.tabs, false); } else { assert.ok(m.cards >= 4, `${w}: ${m.cards} paint cards`); assert.equal(m.tabs, true); }
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  // absolute zoom slider -> AXZ; limit toggle; FINE / COARSE steps
  await page.locator('#pane-pctl [data-op=zoomPos] input').fill('50');
  await until(async () => { const c = await cam(); return c.values.zoomPos !== undefined && Math.abs(c.values.zoomPos - 50) < 1; }, 'zoom 50 %');
  await page.click('#pane-pctl [data-op=limitUp]'); await until(async () => (await cam()).values.limitUp === true, 'limit up');
  await page.click('[data-stepmul="10"]');
  const rk = page.locator('#pane-pctl [data-pane=paint] [data-op=rGain]'); await rk.locator('[data-step="1"]').click();
  await until(async () => (await cam()).values.rGain === 10, 'COARSE +10'); await page.click('[data-stepmul="1"]');
  // paint memory: SAVE (prompt), change, LOAD (confirm)
  await page.click('#ptzMem [data-msave="1"]'); await until(async () => ((await cam()).paintMem || {})[1], 'mem 1 saved');
  await api('/api/sys/ptz/cmd/op', { cam: 'cam1', op: 'rGain', value: -40 });
  await page.locator('#ptzMem [data-mload="1"]:not([disabled])').waitFor(); await page.click('#ptzMem [data-mload="1"]');
  await until(async () => (await api('/api/sys/ptz/cameras/cam1/status')).values.rGain === 10, 'mem 1 loaded');
  // lock: controls disabled, server refuses
  await page.click('#ptzLock'); await until(async () => (await cam()).locked === true, 'locked');
  await page.locator('.rcp-paint.locked').waitFor(); assert.equal(await rk.locator('[data-step="1"]').isDisabled(), true);
  assert.equal((await fetch(`${B}/api/sys/ptz/cmd/op`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cam: 'cam1', op: 'rGain', value: 0 }) })).status, 423);
  await page.click('#ptzLock'); await until(async () => (await cam()).locked === false, 'unlocked');
  // notes save on their own
  await page.fill('#ptzNotes', 'Riser, 20x'); await page.locator('#ptzNotes').blur(); await until(async () => (await cam()).notes === 'Riser, 20x', 'notes');
  // preview frame + stream info
  await page.waitForFunction(() => { const i = document.querySelector('#ptzSnapImg'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 6000 });
  await page.locator('#ptzInfo .url').first().waitFor();
  // keys 1-9 select a camera; the HE130 has no preview and no paint
  await page.keyboard.press('3'); await until(async () => (await api('/api/sys/ptz')).selected === 'cam3', 'key 3');
  await page.locator('#ptzSnap.na').waitFor(); assert.equal(await page.locator('#pane-pctl [data-op=zoomPos]').count(), 0);
  assert.deepEqual(errors, []);
});
