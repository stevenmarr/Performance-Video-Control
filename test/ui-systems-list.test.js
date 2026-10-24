'use strict';
// 0.11.0 SYSTEMS page: the dense LIST is the default (one short line per system with status and actions), a search
// box and status chips filter it, ⚙ expands CONFIGURE, CARDS / COMPACT still work (Playwright, --mock, 127.0.0.1 only).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
let pw = null; try { pw = require('playwright'); } catch { /* optional */ }
const waitHttp = async (u) => { for (let i = 0; i < 150; i++) { try { await fetch(u); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } throw new Error('server did not start'); };

test('SYSTEMS 0.11.0: compact list, search, status filter, configure, densities (Playwright)', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const port = 28000 + Math.floor(Math.random() * 1000); const B = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6syslist-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--port', String(port), '--host', '127.0.0.1', '--data', data], { stdio: 'ignore' });
  t.after(() => { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); });
  await waitHttp(`${B}/api/state`);
  const browser = await pw.chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(B + '/');
  await page.locator('.sys-cards.list .sys-line[data-card=e2]').waitFor();
  const n = await page.locator('.sys-cards.list .sys-line').count(); assert.ok(n >= 7, `every system listed (${n})`);
  const h = await page.locator('.sys-line[data-card=atem]').boundingBox(); assert.ok(h.height < 60, `a row is one short line (${h.height}px)`);
  const last = await page.locator('#sysCards .sys-line').last().boundingBox(); assert.ok(last.y + last.height < 1080, 'every system fits on one 1080p screen');
  assert.ok(await page.locator('.sys-line[data-card=e2] [data-use=e2]').isVisible(), 'actions on the row');
  // search
  await page.fill('#dashSearch', 'pixel');
  await page.waitForFunction(() => document.querySelectorAll('.sys-line').length === 1);
  assert.equal(await page.locator('.sys-line[data-card=pixelhue]').count(), 1);
  await page.fill('#dashSearch', 'zzz'); await page.locator('#sysCards .note', { hasText: 'No system matches' }).waitFor();
  await page.fill('#dashSearch', '');
  // status filter: ON DESK = only the RS6 at first
  await page.click('[data-dashst=desk]');
  await page.waitForFunction(() => [...document.querySelectorAll('.sys-line')].every((r) => r.classList.contains('on-desk')));
  await page.click('[data-dashst=all]');
  // ⚙ CONFIGURE
  await page.click('.sys-line[data-card=e2] details summary');
  await page.locator('.sys-line[data-card=e2] details[open] form').waitFor();
  await page.click('.sys-line[data-card=e2] details summary');
  // other densities still render cards
  await page.click('[data-density=cards]'); await page.locator('.sys-cards.cards .sys-card[data-card=e2] .stats').waitFor();
  await page.click('[data-density=list]'); await page.locator('.sys-cards.list').waitFor();
  assert.deepEqual(errors, []);
});
