'use strict';
// ROUTER popover (Playwright, server.js --mock on 127.0.0.1 only): pick an output, search, ADVANCED,
// and SHIFT to the next bank of sources. Drag-from-palette routing is gone; the source bank is the popover.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { openTab } = require('./ui-helpers');
let pw = null; try { pw = require('playwright'); } catch { /* optional */ }
const waitHttp = async (u) => { for (let i = 0; i < 150; i++) { try { await fetch(u); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } throw new Error('server did not start'); };
const until = async (fn, what) => { for (let i = 0; i < 80; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } throw new Error(`timed out: ${what}`); };

test('ATEM ROUTER: destination popover, search, ADVANCED, SHIFT paging (Playwright)', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const port = 24000 + Math.floor(Math.random() * 1000); const B = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6arouter-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--atem-model', 'chd2me', '--port', String(port), '--host', '127.0.0.1', '--data', data], { stdio: 'ignore' });
  t.after(() => { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); });
  await waitHttp(`${B}/api/state`);
  const api = async (p, body) => (await fetch(B + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
  await api('/api/sys/active', { system: 'atem' });
  const out = async (key) => ((await api('/api/sys/atem')).outputs.find((o) => o.key === key) || {}).source;
  const browser = await pw.chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(B + '/#arouter');
  await page.waitForFunction(() => document.body.classList.contains('kind-atem'), null, { timeout: 8000 });
  await openTab(page, 'arouter');
  await page.locator('.ar-out[data-out="aux:1"]').waitFor();
  assert.equal(await page.locator('#arPalette,#arPalList,[data-argroup]').count(), 0, 'no source palette and no filter groups');
  assert.equal(await page.locator('.ar-out.mv').count(), 0);
  const label = await page.locator('.ar-out[data-out="aux:1"] .ar-lbl').innerText();
  const now = await page.locator('.ar-out[data-out="aux:1"] b .nm-l').innerText();
  assert.ok(label.length > 0 && now.length > 0, 'each output shows its name and its current source');

  await page.click('.ar-out[data-out="aux:1"]');
  const pop = page.locator('#arPop:not([hidden])');
  await pop.waitFor();
  const ids = () => pop.locator('#arSources [data-routesrc]').evaluateAll((els) => els.map((e) => e.getAttribute('data-routesrc')));
  const page1 = await ids();
  assert.ok(page1.length > 0 && page1.length <= 16, `one bank (${page1.length})`);
  assert.equal(await pop.locator('#arShift').isEnabled(), true, 'SHIFT is live when sources exceed the bank');
  const pageLabel = await pop.locator('#arPage').innerText();
  await pop.locator('#arShift').click();
  const page2 = await ids();
  assert.notDeepEqual(page1, page2, 'SHIFT shows the next sources');
  assert.notEqual(await pop.locator('#arPage').innerText(), pageLabel);
  const pick = page2[0];
  await pop.locator(`[data-routesrc="${pick}"]`).click();
  await until(async () => (await out('aux:1')) === Number(pick), 'SHIFT page source routed to Output');
  await page.locator('#arPop[hidden]').waitFor({ state: 'attached' });
  await page.locator(`.ar-out[data-out="aux:1"] b .nm-l`).waitFor();

  // search stays on the popover, and ADVANCED is a tab rather than a filter chip
  await page.click('.ar-out[data-out="aux:3"]');
  await pop.waitFor();
  await page.fill('#arSearch', 'color bars');
  assert.equal(await pop.locator('[data-routesrc]').count(), 1);
  await page.fill('#arSearch', '');
  assert.equal(await pop.locator('#arSources [data-routesrc="3011"]').count(), 0);
  await pop.locator('#arAdv').click();
  await pop.locator('#arSources [data-routesrc="3011"]').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('#arPop[hidden]').waitFor({ state: 'attached' });
  assert.deepEqual(errors, []);
});
