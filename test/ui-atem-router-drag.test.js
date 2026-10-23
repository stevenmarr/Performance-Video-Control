'use strict';
// 0.11.0 ATEM ROUTER click-and-drag (Playwright, server.js --mock on 127.0.0.1 only): drag a source from the palette
// onto an output (mouse), drag an output tile onto another to copy its source, tap-to-arm then tap outputs, a touch
// press-and-hold drag (synthetic touch pointer events) and a quick touch swipe that must NOT route. The click → dialog
// flow on an output still works.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
let pw = null; try { pw = require('playwright'); } catch { /* optional */ }
const waitHttp = async (u) => { for (let i = 0; i < 150; i++) { try { await fetch(u); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } throw new Error('server did not start'); };
const until = async (fn, what) => { for (let i = 0; i < 80; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } throw new Error(`timed out: ${what}`); };

test('ATEM 0.11.0 ROUTER: drag a source onto an output (mouse + touch), copy output → output, tap-to-arm (Playwright)', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const port = 24000 + Math.floor(Math.random() * 1000); const B = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6ardrag-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--atem-model', 'chd2me', '--port', String(port), '--host', '127.0.0.1', '--data', data], { stdio: 'ignore' });
  t.after(() => { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); });
  await waitHttp(`${B}/api/state`);
  const api = async (p, body) => (await fetch(B + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
  await api('/api/sys/active', { system: 'atem' });
  const out = async (key) => ((await api('/api/sys/atem')).outputs.find((o) => o.key === key) || {}).source;
  const browser = await pw.chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(B + '/#arouter');
  await page.waitForFunction(() => document.body.classList.contains('kind-atem'), null, { timeout: 8000 });
  await page.click('.tab[data-tab=arouter]');
  await page.locator('.ar-out[data-out="aux:1"]').waitFor();
  await page.locator('#arPalList [data-dragsrc="3"]').waitFor();
  assert.equal(await page.locator('#arPalList [data-dragsrc="3011"]').count(), 0, 'media player key sources hidden from the palette by default');
  const center = async (sel) => { const b = await page.locator(sel).boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };

  // 1. mouse drag palette source 3 → AUX 1
  await api('/api/sys/atem/cmd/route', { output: 'aux:1', source: 1 });
  let [x, y] = await center('#arPalList [data-dragsrc="3"]'); const [tx, ty] = await center('.ar-out[data-out="aux:1"]');
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 20, y + 5, { steps: 3 });
  await page.locator('.cc-ghost').waitFor();
  assert.ok(await page.locator('.ar-out.drop-ok').count() > 0, 'compatible outputs light up while dragging');
  await page.mouse.move(tx, ty, { steps: 8 });
  assert.equal(await page.locator('.ar-out[data-out="aux:1"].cc-drop-hover').count(), 1, 'the output under the pointer is the drop target');
  await page.mouse.up();
  await until(async () => (await out('aux:1')) === 3, 'AUX 1 ← source 3 by drag');
  assert.equal(await page.locator('#dlgAtemRoute[open]').count(), 0, 'a drag does not open the route dialog');
  assert.equal(await page.locator('.cc-ghost').count(), 0, 'ghost removed');
  assert.equal(await page.locator('.ar-out.drop-ok').count(), 0, 'targets cleared after the drop');

  // 2. drag an output tile onto another output copies its source
  await api('/api/sys/atem/cmd/route', { output: 'aux:2', source: 1 });
  const long3 = (await api('/api/sys/atem')).sources.find((s) => s.id === 3).long;
  await page.locator('.ar-out[data-out="aux:1"] .nm-l', { hasText: long3 }).waitFor(); // the UI has caught up
  [x, y] = await center('.ar-out[data-out="aux:1"]'); const [t2x, t2y] = await center('.ar-out[data-out="aux:2"]');
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(t2x, t2y, { steps: 10 }); await page.mouse.up();
  await until(async () => (await out('aux:2')) === 3, 'AUX 2 ← AUX 1 source by output drag');

  // 3. tap a source to arm it, then tap outputs
  await page.click('#arPalList [data-dragsrc="4"]');
  await page.locator('#arArmed:not([hidden])').waitFor();
  await page.click('.ar-out[data-out="aux:1"]'); await page.click('.ar-out[data-out="aux:2"]');
  await until(async () => (await out('aux:1')) === 4 && (await out('aux:2')) === 4, 'armed source routed to two outputs');
  assert.equal(await page.locator('#dlgAtemRoute[open]').count(), 0, 'armed taps route without the dialog');
  await page.keyboard.press('Escape');
  await page.locator('#arArmed[hidden]').waitFor({ state: 'attached' });
  // the click → dialog flow still works when nothing is armed
  await page.click('.ar-out[data-out="aux:1"]'); await page.locator('#dlgAtemRoute[open]').waitFor();
  await page.keyboard.press('Escape');

  // 4. touch: press and hold, then drag (synthetic touch pointer events)
  const touch = (sel, to, holdMs) => page.evaluate(async ([s, t, h]) => {
    const el = document.querySelector(s); const r = el.getBoundingClientRect(); const x0 = r.x + r.width / 2; const y0 = r.y + r.height / 2;
    const tg = document.querySelector(t).getBoundingClientRect(); const x1 = tg.x + tg.width / 2; const y1 = tg.y + tg.height / 2;
    const ev = (type, x, y, target) => (target || document.elementFromPoint(x, y) || document.body).dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y }));
    ev('pointerdown', x0, y0, el);
    await new Promise((r) => setTimeout(r, h));
    for (let i = 1; i <= 6; i++) ev('pointermove', x0 + (x1 - x0) * i / 6, y0 + (y1 - y0) * i / 6);
    ev('pointerup', x1, y1);
  }, [sel, to, holdMs]);
  await touch('#arPalList [data-dragsrc="5"]', '.ar-out[data-out="aux:3"]', 350);
  await until(async () => (await out('aux:3')) === 5, 'touch hold-and-drag routes');
  await api('/api/sys/atem/cmd/route', { output: 'aux:4', source: 1 });
  await touch('#arPalList [data-dragsrc="6"]', '.ar-out[data-out="aux:4"]', 0); // a quick swipe scrolls, never routes
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await out('aux:4'), 1, 'a quick touch swipe does not route');

  // 5. ADVANCED reveals media player key sources in the palette (persisted)
  await page.check('#arPalAdv'); await page.locator('#arPalList [data-dragsrc="3011"]').waitFor();
  await page.reload(); await page.click('.tab[data-tab=arouter]');
  await page.locator('#arPalList [data-dragsrc="3011"]').waitFor();
  assert.deepEqual(errors, []);
});
