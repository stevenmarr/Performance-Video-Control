'use strict';
// SYSTEMS page: available systems are a filtered, collapsed list. The desk column
// shows every system on the desk and is where CONFIGURE lives.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
let pw = null; try { pw = require('playwright'); } catch { /* optional */ }
const waitHttp = async (u) => { for (let i = 0; i < 150; i++) { try { await fetch(u); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } throw new Error('server did not start'); };

test('SYSTEMS: cards, search, status filter, configure (Playwright)', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const port = 28000 + Math.floor(Math.random() * 1000); const B = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6syslist-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--port', String(port), '--host', '127.0.0.1', '--data', data], { stdio: 'ignore' });
  t.after(() => { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); });
  await waitHttp(`${B}/api/state`);
  const browser = await pw.chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(B + '/');
  await page.locator('.sys-cards.avail .sys-card[data-card=e2]').waitFor();
  const n = await page.locator('.sys-card.avail[data-card]').count(); assert.ok(n >= 6, `available systems are listed collapsed (${n})`);
  assert.equal(await page.locator('.sys-card.avail details').count(), 0, 'an available system has no configure form');
  assert.ok(await page.locator('.sys-card.avail[data-card=e2]').getByText('ADD TO DESK', { exact: true }).isVisible());
  assert.ok(await page.locator('.sys-card.avail[data-card=e2]').getByText('ADD AS SIMULATOR', { exact: true }).isVisible());
  assert.equal(await page.locator('.sys-card.avail[data-card=atem] [data-use=atem][data-open]').count(), 0, 'off-desk ADD does not also open');
  assert.ok(await page.locator('#sysCards').getByText('ON THE DESK').isVisible());
  assert.ok(await page.locator('#sysCards').getByText('AVAILABLE').isVisible());
  assert.equal(await page.locator('[data-density]').count(), 0);
  await page.locator('.sys-card.avail[data-card=e2] [data-use=e2]').click();
  await page.locator('.sys-card.on-desk[data-card=e2] details summary').waitFor();
  await page.fill('#dashSearch', 'pixel');
  await page.locator('.sys-card.avail[data-card=pixelhue]').waitFor();
  assert.equal(await page.locator('.sys-card.on-desk[data-card=e2]').count(), 1, 'a filtered list does not hide the desk');
  await page.fill('#dashSearch', 'zzz');
  await page.locator('#sysCards .note', { hasText: 'Nothing matches this filter' }).waitFor();
  assert.equal(await page.locator('.sys-card.on-desk[data-card=e2]').count(), 1);
  await page.fill('#dashSearch', '');
  await page.click('.sys-card.on-desk[data-card=e2] details summary');
  await page.locator('.sys-card.on-desk[data-card=e2] details[open] form').waitFor();
  assert.deepEqual(errors, []);
});
