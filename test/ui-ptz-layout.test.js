'use strict';
// 0.11.0 PTZ CAMERA CONTROL: compact R / G / B gain + pedestal matrix, closed expanders for rarely used controls (open
// state remembered), and panels rearranged by dragging their grip (mouse and touch hold), persisted per install, reset.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
let pw = null; try { pw = require('playwright'); } catch { /* optional */ }
const waitHttp = async (u) => { for (let i = 0; i < 150; i++) { try { await fetch(u); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } throw new Error('server did not start'); };

test('PTZ 0.11.0: paint matrix + expanders, drag panels (mouse + touch), persisted per install, reset (Playwright)', { skip: pw ? false : 'playwright not installed' }, async (t) => {
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
  await page.locator('.rgbm [data-op=rPed]').waitFor({ timeout: 10000 });
  // 10: one compact matrix: GAIN row R / B, PED row R / G / B / M
  for (const id of ['rGain', 'bGain', 'rPed', 'gPed', 'bPed', 'masterPed']) assert.equal(await page.locator(`.rgbm .knob.cell[data-op=${id}]`).count(), 1, `${id} in the matrix`);
  assert.equal(await page.locator('[data-op=masterPed]').count(), 1, 'master pedestal only once');
  const mbox = await page.locator('.rgbm').boundingBox(); assert.ok(mbox.height < 140, `matrix is compact: shorter than one old knob row pair (${mbox.height}px)`);
  // a matrix cell steps the camera
  await page.locator('.rgbm [data-op=rPed] [data-step="1"]').click();
  const camVal = async (id) => { const v = await (await fetch(`${B}/api/sys/ptz`)).json().catch(() => null); const c = v && (v.cameras || []).find((x) => x.id === 'cam1'); return c && c.values ? c.values[id] : undefined; };
  for (let i = 0; i < 60 && (await camVal('rPed')) !== 1; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(await camVal('rPed'), 1, 'R PED + → 1');
  // rarely used controls: closed expanders, still in the DOM; open state remembered
  for (const x of ['iris', 'exposure', 'matrix', 'detail']) assert.equal(await page.locator(`details.xp[data-xp=${x}]:not([open])`).count(), 1, `${x} expander closed by default`);
  assert.equal(await page.locator('details.xp[data-xp=iris] [data-op=autoIrisSpeed]').count(), 1);
  assert.equal(await page.locator('details.xp[data-xp=matrix] .knob.cell[data-op=matrixRG]').count(), 1);
  assert.equal(await page.locator('[data-op=autoIrisSpeed]').isVisible(), false);
  await page.click('details.xp[data-xp=iris] > summary');
  await page.locator('[data-op=autoIrisSpeed] [data-v="2"]').click();
  for (let i = 0; i < 60 && (await camVal('autoIrisSpeed')) !== '2'; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(await camVal('autoIrisSpeed'), '2', 'AUTO IRIS SPEED FAST sent (OSJ:01:2)');
  // 11: every panel has a grip; mouse drag PREVIEW onto IRIS swaps the two places
  assert.equal(await page.locator('.rcp > .panel .pgrip').count(), 7);
  assert.equal(await page.locator('#ptzResetLayout').isVisible(), false, 'no reset button on the default layout');
  const area = (n) => page.$eval(`.rcp-${n}`, (e) => e.dataset.place);
  const g = await page.locator('[data-grip=view]').boundingBox(); const tb = await page.locator('.rcp-iris').boundingBox();
  const irisX0 = tb.x;
  await page.mouse.move(g.x + 10, g.y + 10); await page.mouse.down(); await page.mouse.move(g.x + 40, g.y + 30, { steps: 3 });
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 8 }); await page.mouse.up();
  assert.equal(await area('view'), 'iris'); assert.equal(await area('iris'), 'view');
  const vb = await page.locator('.rcp-view').boundingBox(); assert.ok(Math.abs(vb.x - irisX0) < 2, 'PREVIEW now sits where IRIS was');
  assert.equal(await page.locator('#ptzResetLayout').isVisible(), true);
  // persisted per install (server-side), so a fresh browser context sees it
  let prefs = (await (await fetch(`${B}/api/ui-prefs`)).json()).prefs;
  assert.deepEqual(prefs['ptz.panelOrder'], ['joy', 'lens', 'view', 'paint', 'presets', 'iris', 'sys']);
  const ctx2 = await browser.newContext({ viewport: { width: 1920, height: 1080 } }); const p2 = await ctx2.newPage();
  await p2.goto(B + '/#pctl'); await p2.waitForFunction(() => document.querySelector('.rcp-view') && document.querySelector('.rcp-view').dataset.place === 'iris', null, { timeout: 8000 });
  await ctx2.close();
  // touch: press and hold the grip, then drag (synthetic touch pointer events); a quick swipe does nothing
  const touch = (sel, to, holdMs) => page.evaluate(async ([s, tt, h]) => {
    const el = document.querySelector(s); const r = el.getBoundingClientRect(); const x0 = r.x + r.width / 2; const y0 = r.y + r.height / 2;
    const tg = document.querySelector(tt).getBoundingClientRect(); const x1 = tg.x + tg.width / 2; const y1 = tg.y + tg.height / 2;
    const ev = (type, x, y, target) => (target || document.elementFromPoint(x, y) || document.body).dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y }));
    ev('pointerdown', x0, y0, el); await new Promise((res) => setTimeout(res, h));
    for (let i = 1; i <= 6; i++) ev('pointermove', x0 + (x1 - x0) * i / 6, y0 + (y1 - y0) * i / 6);
    ev('pointerup', x1, y1);
  }, [sel, to, holdMs]);
  await touch('[data-grip=sys]', '.rcp-paint', 0);
  assert.equal(await area('sys'), 'sys', 'a quick touch swipe does not move a panel');
  await touch('[data-grip=sys]', '.rcp-paint', 350);
  assert.equal(await area('sys'), 'paint', 'touch hold + drag swaps'); assert.equal(await area('paint'), 'sys');
  // keyboard: arrow keys on a grip swap with the neighbouring place
  await page.focus('[data-grip=joy]'); await page.keyboard.press('ArrowRight');
  assert.equal(await area('joy'), 'lens');
  // reset
  await page.click('#ptzResetLayout');
  for (const n of ['joy', 'lens', 'iris', 'paint', 'presets', 'view', 'sys']) assert.equal(await area(n), n, `${n} back home`);
  assert.equal(await page.locator('#ptzResetLayout').isVisible(), false);
  for (let i = 0; i < 40; i++) { prefs = (await (await fetch(`${B}/api/ui-prefs`)).json()).prefs; if (!prefs['ptz.panelOrder']) break; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(prefs['ptz.panelOrder'], undefined, 'reset clears the saved layout');
  // the expander stayed open across a reload (per browser)
  await page.reload(); await page.locator('details.xp[data-xp=iris]').waitFor({ state: 'attached' });
  assert.equal(await page.locator('details.xp[data-xp=iris][open]').count(), 1);
  assert.deepEqual(errors, []);
});
