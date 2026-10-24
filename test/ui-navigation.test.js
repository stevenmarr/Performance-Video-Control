'use strict';
// 0.11.0 navigation (docs/navigation.md): top row = ⌂ SYSTEMS + one button per system group on the desk in a fixed
// order with a status led; second row = the selected group's pages; rows scroll sideways on narrow screens (Playwright).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
let pw = null; try { pw = require('playwright'); } catch { /* optional */ }
const waitHttp = async (u) => { for (let i = 0; i < 150; i++) { try { await fetch(u); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } throw new Error('server did not start'); };

test('navigation 0.11.0: group row, page row, deep link, last page per group, overflow (Playwright)', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const port = 29000 + Math.floor(Math.random() * 1000); const B = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6nav-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--port', String(port), '--host', '127.0.0.1', '--data', data], { stdio: 'ignore' });
  t.after(() => { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); });
  await waitHttp(`${B}/api/state`);
  const api = (p, body) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  for (const s of ['ptz', 'pixera', 'atem']) await api('/api/sys/active', { system: s });
  const browser = await pw.chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  // a deep link selects its group
  await page.goto(B + '/#arouter');
  await page.waitForFunction(() => document.body.classList.contains('tab-arouter'));
  assert.equal(await page.locator('.tgrp[data-tabgrp=atem].active').count(), 1);
  const order = await page.$$eval('#tabsTop .tgrp:not([hidden])', (b) => b.map((x) => x.dataset.tabgrp));
  assert.deepEqual(order, ['rs6', 'atem', 'ptz', 'pixera'], 'groups in the fixed order');
  assert.equal(await page.locator('.tab[data-tab=scopes]').count(), 1, 'SCOPES is a persistent top tab');
  assert.equal(await page.locator('.tgrp[data-tabgrp=lightning]').count(), 0, 'LIGHTNING is not a top tab');
  const sub = await page.$$eval('#tabsSub .tab', (b) => b.filter((x) => x.offsetParent).map((x) => x.dataset.tab));
  assert.deepEqual(sub, ['atem', 'arouter', 'aaudio', 'akeys', 'amacros'], 'second row = ATEM pages only');
  await page.locator('.tgrp[data-tabgrp=atem] .led.ok').waitFor();
  // last page per group
  await page.click('.tgrp[data-tabgrp=pixera]'); await page.waitForFunction(() => document.body.classList.contains('tab-pxplay'));
  await page.click('.tab[data-tab=pxcues]');
  await page.click('.tgrp[data-tabgrp=atem]'); await page.waitForFunction(() => document.body.classList.contains('tab-arouter'));
  await page.click('.tgrp[data-tabgrp=pixera]'); await page.waitForFunction(() => document.body.classList.contains('tab-pxcues'));
  // home: no page row, a hint instead
  await page.click('.tab[data-tab=system]');
  assert.equal(await page.locator('#tabsHomeNote').isVisible(), true);
  assert.equal(await page.$$eval('#tabsSub .tab', (b) => b.filter((x) => x.offsetParent).length), 0);
  // narrow: each row is one line that scrolls sideways (no wrapping), the active tab stays in view
  await page.setViewportSize({ width: 420, height: 800 });
  await page.click('.tgrp[data-tabgrp=atem]'); await page.click('.tab[data-tab=amacros]');
  await page.waitForFunction(() => {
    const r = document.querySelector('#tabsSub'); const a = document.querySelector('#tabsSub .tab.active');
    if (!r || !a || !(r.scrollWidth > r.clientWidth)) return false;
    a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const rb = r.getBoundingClientRect(); const ab = a.getBoundingClientRect();
    return ab.left >= rb.left - 2 && ab.right <= rb.right + 2;
  });
  const m = await page.evaluate(() => { const r = document.querySelector('#tabsSub'); const a = document.querySelector('#tabsSub .tab.active'); const rb = r.getBoundingClientRect(); const ab = a.getBoundingClientRect(); return { over: r.scrollWidth > r.clientWidth, h: rb.height, inView: ab.left >= rb.left - 2 && ab.right <= rb.right + 2 }; });
  assert.ok(m.over, 'the page row overflows at 420 px'); assert.ok(m.h < 70, `one line (${m.h}px)`); assert.ok(m.inView, 'active tab scrolled into view');
  // SCOPES is always on the top row, including on a narrow viewport. Lightning is not a tab.
  await page.click('.tab[data-tab=scopes]'); await page.waitForFunction(() => document.body.classList.contains('tab-scopes'));
  assert.equal(await page.locator('#pane-scopes').isVisible(), true);
  assert.match(await page.locator('#pane-scopes').innerText(), /SIDECAR \/ DISCOVERED NDI/);
  assert.match(await page.locator('#ndiCmds').innerText(), /ndi-sidecar\.js --list/);
  assert.match(await page.locator('#ndiCmds').innerText(), /--ndi "NAME"/);
  const fr = page.frameLocator('#scopesFrame');
  await fr.locator('[data-show="ltng"]').waitFor({ timeout: 10000 });
  assert.equal(await fr.locator('[data-show="wfm"]').count(), 1);
  assert.equal(await fr.locator('[data-show="parade"]').count(), 1);
  assert.equal(await fr.locator('[data-show="vec"]').count(), 1);
  assert.equal(await fr.locator('[data-view="1"]').count(), 1);
  await page.goto(B + '/#lightning');
  await page.waitForFunction(() => document.body.classList.contains('tab-scopes'));
  assert.deepEqual(errors, []);
});
