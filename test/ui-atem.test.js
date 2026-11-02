'use strict';
// ATEM UI (Playwright, against server.js --mock on 127.0.0.1 only): the simulator model picker, ROUTER
// (destination row, source popover, search, ADVANCED tab, current source highlighted), AUDIO strips (Fairlight
// and classic) and DVE / SS / KEYS (USK type, SuperSource box source, layout recall).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { openTab } = require('./ui-helpers');
let pw = null; try { pw = require('playwright'); } catch { /* optional */ }
const waitHttp = async (u) => { for (let i = 0; i < 150; i++) { try { await fetch(u); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } throw new Error('server did not start'); };

test('ATEM 0.10.0 UI: model picker, ROUTER dialog assignment, AUDIO, DVE / SS / KEYS (Playwright)', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const port = 21000 + Math.floor(Math.random() * 1000); const B = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6atemui-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--atem-model', 'chd2me', '--port', String(port), '--host', '127.0.0.1', '--data', data], { stdio: 'ignore' });
  t.after(() => { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); });
  await waitHttp(`${B}/api/state`);
  const api = async (p, body) => (await fetch(B + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
  await api('/api/sys/active', { system: 'atem' });
  const browser = await pw.chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(B + '/');
  await page.waitForFunction(() => document.body.classList.contains('kind-atem'), null, { timeout: 8000 });
  // ROUTER: outputs only (no multiview windows), then the source popover
  await openTab(page, 'arouter');
  await page.locator('.ar-out[data-out="aux:11"]').waitFor();
  assert.equal(await page.locator('.ar-out.aux').count(), 12, '2 M/E Constellation: 12 outputs');
  assert.equal(await page.locator('.ar-out.me').count(), 0, 'no M/E program / preview outputs');
  assert.equal(await page.locator('#pane-arouter [data-argroup], #pane-arouter [data-kind], #pane-arouter [data-palkind], #arPop [data-kind]').count(), 0, 'no source or output filter groups');
  assert.equal(await page.locator('.ar-out.mv').count(), 0, 'multiview windows are not on the router');
  assert.equal(await page.locator('#btnSystem').count(), 0, 'the header does not repeat the system name');
  await page.click('.ar-out[data-out="aux:2"]');
  const pop = page.locator('#arPop:not([hidden])'); await pop.waitFor();
  const cur = (await api('/api/sys/atem')).outputs.find((o) => o.key === 'aux:2').source;
  assert.equal(await pop.locator(`[data-routesrc="${cur}"].current`).count(), 1, 'current source highlighted');
  assert.equal(await pop.locator('#arSources [data-routesrc="3011"]').count(), 0, 'MP1 key hidden on SOURCES');
  assert.equal(await pop.locator('#arAdv').isVisible(), true);
  await pop.locator('#arAdv').click();
  await pop.locator('#arSources [data-routesrc="3011"]').waitFor();
  await pop.locator('[data-artab="src"]').click();
  await page.fill('#arSearch', 'graphics');
  assert.equal(await pop.locator('[data-routesrc]').count(), 1);
  await pop.locator('[data-routesrc="7"]').click();
  await page.locator('#arPop[hidden]').waitFor({ state: 'attached' });
  await page.locator('.ar-out[data-out="aux:2"] b .nm-l', { hasText: 'Graphics' }).waitFor();
  assert.equal((await api('/api/sys/atem')).aux[2].source, 7);
  // AUDIO (Fairlight): mute toggles from the strip
  await openTab(page, 'aaudio'); await page.locator('.au-type.fairlight').waitFor();
  await page.locator('.au-strip[data-in="5"] [data-au="mute"]').click();
  await page.locator('.au-strip[data-in="5"].muted').waitFor();
  await page.locator('.au-strip[data-in="5"] [data-au="mix"][data-v="on"]').click();
  await page.waitForFunction(async () => (await (await fetch('/api/sys/atem')).json()).audio.inputs.find((i) => i.id === 5).mix === 'on');
  assert.ok(await page.locator('#auRouting').innerText().then((x) => /AUDIO ROUTING/.test(x)));
  // KEYS: DVE type on M/E 2 key 3, SuperSource box 2 source, a layout
  await openTab(page, 'akeys'); await page.click('#akMe [data-akme="1"]');
  await page.locator('[data-usktype="dve"][data-key="2"]').click();
  await page.waitForFunction(async () => (await (await fetch('/api/sys/atem')).json()).mixEffects[1].keyers[2].type === 'dve');
  await page.locator('.ak-dve').first().waitFor();
  await page.locator('.ss-boxbar [data-box="1"]').click();
  await page.selectOption('.ss-ctl select[data-k="source"]', '8');
  await page.waitForFunction(async () => (await (await fetch('/api/sys/atem')).json()).superSources[0].boxes[1].source === 8);
  await page.locator('[data-sslayout="pip"]').click();
  await page.waitForFunction(async () => (await (await fetch('/api/sys/atem')).json()).superSources[0].boxes[0].size === 1000);
  // model picker swaps the simulated model (classic audio)
  await openTab(page, 'arouter'); await page.click('[data-simmodel]');
  await page.locator('#dlgAtemModel[open] .am-card[data-model="ps4k"]').click(); await page.click('#amStart');
  await page.waitForFunction(async () => ((await (await fetch('/api/sys/atem')).json()).profile || {}).key === 'ps4k', null, { timeout: 8000 });
  await openTab(page, 'aaudio'); await page.locator('.au-type.classic').waitFor();
  await openTab(page, 'akeys'); await page.locator('[data-usktype="dve"][disabled]').first().waitFor();
  assert.deepEqual(errors, []);
});
