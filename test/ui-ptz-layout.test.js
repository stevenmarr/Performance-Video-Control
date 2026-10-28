'use strict';
// 0.11.0 PTZ CAMERA CONTROL: compact R / G / B gain + pedestal matrix, closed expanders for rarely used controls (open
// state remembered). The panel layout itself is tested in ui-ptz-dock.test.js (0.11.1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
let pw = null; try { pw = require('playwright'); } catch { /* optional */ }
const waitHttp = async (u) => { for (let i = 0; i < 150; i++) { try { await fetch(u); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } throw new Error('server did not start'); };

test('PTZ 0.11.0: paint matrix + expanders (Playwright)', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const port = 30000 + Math.floor(Math.random() * 1000); const B = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6ptzlay-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--port', String(port), '--host', '127.0.0.1', '--data', data], { stdio: 'ignore' });
  t.after(() => { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); });
  await waitHttp(`${B}/api/state`);
  const post = (p, body) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  await post('/api/sys/active', { system: 'ptz' });
  const browser = await pw.chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(B + '/#pctl');
  await page.locator('.pcard[data-pane=paint] .knob[data-op=rPed]').waitFor({ timeout: 10000 });
  // paint ranges are dial encoders again (the console), not the compact +/- matrix
  for (const id of ['rGain', 'bGain', 'rPed', 'gPed', 'bPed', 'masterPed']) assert.equal(await page.locator(`.pcard .knob:not(.cell)[data-op=${id}]`).count(), 1, `${id} is a dial`);
  assert.equal(await page.locator('[data-op=masterPed]').count(), 1, 'master pedestal only once');
  assert.equal(await page.locator('.pcard .knob:not(.cell)[data-op=matrixRG]').count(), 1, 'linear matrix is a dial');
  await page.locator('.pcard [data-op=rPed] [data-step="1"]').click();
  const camVal = async (id) => { const v = await (await fetch(`${B}/api/sys/ptz`)).json().catch(() => null); const c = v && (v.cameras || []).find((x) => x.id === 'cam1'); return c && c.values ? c.values[id] : undefined; };
  for (let i = 0; i < 60 && (await camVal('rPed')) !== 1; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(await camVal('rPed'), 1, 'R PED + → 1');
  // rarely used controls: closed expanders, still in the DOM; open state remembered
  for (const x of ['iris', 'exposure']) assert.equal(await page.locator(`details.xp[data-xp=${x}]:not([open])`).count(), 1, `${x} expander closed by default`);
  assert.equal(await page.locator('details.xp[data-xp=iris] [data-op=autoIrisSpeed]').count(), 1);
  assert.equal(await page.locator('[data-op=autoIrisSpeed]').isVisible(), false);
  await page.click('details.xp[data-xp=iris] > summary');
  await page.locator('[data-op=autoIrisSpeed] [data-v="2"]').click();
  for (let i = 0; i < 60 && (await camVal('autoIrisSpeed')) !== '2'; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(await camVal('autoIrisSpeed'), '2', 'AUTO IRIS SPEED FAST sent (OSJ:01:2)');
  // 11: the 0.11.0 grip-swap panels became the 0.11.1 dock (test/ui-ptz-dock.test.js)
  assert.equal(await page.locator('.rcp > .panel .pgrip').count(), 0);
  assert.equal(await page.locator('.rcp > .dk-panel > .dk-head').count(), 7);
  // the expander stayed open across a reload (per browser)
  await page.reload(); await page.locator('details.xp[data-xp=iris]').waitFor({ state: 'attached' });
  assert.equal(await page.locator('details.xp[data-xp=iris][open]').count(), 1);
  assert.deepEqual(errors, []);
});
