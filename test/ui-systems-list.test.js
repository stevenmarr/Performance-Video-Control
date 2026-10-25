'use strict';
// SYSTEMS page: cards in ON THE DESK and AVAILABLE, with ADD / OPEN / CONFIGURE / REMOVE.
// Search and status chips still filter the cards (Playwright, --mock, 127.0.0.1 only).
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
  await page.locator('.sys-cards.cards .sys-card[data-card=e2]').waitFor();
  const n = await page.locator('.sys-card[data-card]').count(); assert.ok(n >= 7, `every system listed (${n})`);
  assert.ok(await page.locator('.sys-card[data-card=e2]').getByText('ADD TO DESK', { exact: true }).isVisible(), 'ADD is on an off-desk card');
  assert.ok(await page.locator('.sys-card[data-card=rs6]').getByText('OPEN', { exact: false }).isVisible(), 'OPEN is on a desk card');
  assert.ok(await page.locator('.sys-card[data-card=rs6]').getByText('REMOVE FROM DESK').isVisible());
  assert.equal(await page.locator('.sys-card[data-card=atem] [data-use=atem][data-open]').count(), 0, 'off-desk ADD does not also open');
  assert.ok(await page.locator('#sysCards').getByText('ON THE DESK').isVisible());
  assert.ok(await page.locator('#sysCards').getByText('AVAILABLE').isVisible());
  assert.equal(await page.locator('[data-density]').count(), 0);
  // search
  await page.fill('#dashSearch', 'pixel');
  await page.waitForFunction(() => document.querySelectorAll('.sys-card[data-card]').length === 1);
  assert.equal(await page.locator('.sys-card[data-card=pixelhue]').count(), 1);
  await page.fill('#dashSearch', 'zzz'); await page.locator('#sysCards .note', { hasText: 'No system matches' }).waitFor();
  await page.fill('#dashSearch', '');
  // status filter: ON DESK = only the RS6 at first
  await page.click('[data-dashst=desk]');
  await page.waitForFunction(() => [...document.querySelectorAll('.sys-card[data-card]')].every((r) => r.classList.contains('on-desk')));
  await page.click('[data-dashst=all]');
  // CONFIGURE
  await page.click('.sys-card[data-card=e2] details summary');
  await page.locator('.sys-card[data-card=e2] details[open] form').waitFor();
  await page.click('.sys-card[data-card=e2] details summary');
  assert.deepEqual(errors, []);
});
