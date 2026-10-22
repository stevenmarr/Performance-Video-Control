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
  await page.click('.tab[data-tab=system]');
  for (const k of ['rs6', 'e2', 'pixelhue']) await page.locator(`.sys-card[data-card=${k}]`).waitFor();
  assert.equal(await page.locator('.sys-card.planned').count(), 2, 'ATEM + PTZ are shown as stubs');
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
