'use strict';
// 0.11.1 PTZ CAMERA CONTROL as a dockable workspace (public/dock.js): move by the header (mouse, touch hold, keys),
// resize from edges / corners snapped to the grid with neighbours pushed (never overlapping), collapse, close into the
// PANELS tray and reopen, pop out as a floating window, one layout per breakpoint saved per install, the narrow
// stack, named layouts (save / load / rename / delete / reset), and motion safety: arranging never sends a camera
// command, never starts under a held joystick, and the joystick keep-alive keeps running. Mock cameras only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
let pw = null; try { pw = require('playwright'); } catch { /* optional */ }
const waitHttp = async (u) => { for (let i = 0; i < 150; i++) { try { await fetch(u); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } throw new Error('server did not start'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('PTZ 0.11.1 dock: move, resize, collapse / tray / float, keyboard, touch, breakpoints, presets, motion safety (Playwright)', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const port = 31000 + Math.floor(Math.random() * 900); const B = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6dock-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--port', String(port), '--host', '127.0.0.1', '--data', data], { stdio: 'ignore' });
  t.after(() => { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); });
  await waitHttp(`${B}/api/state`);
  await fetch(`${B}/api/sys/active`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system: 'ptz' }) });
  const prefs = async () => (await (await fetch(`${B}/api/ui-prefs`)).json()).prefs;
  const prefWait = async (fn, what) => { let p; for (let i = 0; i < 60; i++) { p = await prefs(); if (fn(p)) return p; await sleep(50); } assert.fail(`prefs: ${what} (${JSON.stringify(p)})`); return p; };
  const browser = await pw.chromium.launch(); t.after(() => browser.close());
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  // every camera command the page sends (POST /api/sys/ptz/cmd/<name>)
  const cmds = []; page.on('request', (r) => { const m = /\/api\/sys\/ptz\/cmd\/(\w+)/.exec(r.url()); if (m && r.method() === 'POST') cmds.push(m[1]); });
  await page.goto(`${B}/#pctl`);
  await page.locator('.rgbm [data-op=rPed]').waitFor({ timeout: 10000 });
  await page.waitForFunction(() => window.CCPTZ && window.CCPTZ.dock);
  const L = () => page.evaluate(() => Object.fromEntries(window.CCPTZ.dock.layout().map((i) => [i.id, i])));
  const box = async (id) => { const i = (await L())[id]; return [i.x, i.y, i.w, i.h]; };
  const noOverlap = async () => {
    const l = Object.values(await L()).filter((i) => !i.closed && !i.f); const eh = (i) => (i.c ? 1 : i.h);
    for (const a of l) for (const b of l) if (a !== b) assert.ok(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + eh(b) && b.y < a.y + eh(a)), `${a.id} overlaps ${b.id}`);
    // and on screen
    const rs = await page.$$eval('.rcp > .dk-panel:not([hidden]):not(.dk-floating)', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [e.dataset.panel, r.x, r.y, r.width, r.height]; }));
    for (const a of rs) for (const b of rs) if (a !== b) assert.ok(!(a[1] + 1 < b[1] + b[3] && b[1] + 1 < a[1] + a[3] && a[2] + 1 < b[2] + b[4] && b[2] + 1 < a[2] + a[4]), `${a[0]} overlaps ${b[0]} on screen`);
  };

  // ---- default layout (xl, 24 columns)
  assert.equal(await page.evaluate(() => window.CCPTZ.dock.bp()), 'xl');
  assert.equal(await page.locator('.rcp > .dk-panel').count(), 7);
  assert.deepEqual(await box('joy'), [0, 0, 4, 17]); assert.deepEqual(await box('paint'), [11, 0, 13, 17]); assert.deepEqual(await box('view'), [11, 17, 6, 15]);
  assert.equal((await page.locator('.rcp-paint').boundingBox()).width > 900, true, 'paint fills the rest of the top row');
  assert.equal(await page.locator('.dk-lay-n').textContent(), 'LAYOUT');
  await noOverlap();

  // ---- move: drag PREVIEW by its header to the top-left corner; a placeholder shows the snapped place while dragging
  const rcp = await page.locator('.rcp').boundingBox();
  const drag = async (sel, to, { steps = 10, before } = {}) => {
    const h = await page.locator(sel).boundingBox(); const x0 = h.x + 60; const y0 = h.y + h.height / 2;
    await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move(x0 + 8, y0 + 8, { steps: 2 });
    await page.mouse.move(to(x0, y0, h).x, to(x0, y0, h).y, { steps });
    if (before) await before();
    await page.mouse.up();
  };
  const vp = await page.locator('.rcp-view').boundingBox();
  await drag('.rcp-view > .dk-head', (x0, y0) => ({ x: rcp.x + (x0 - vp.x), y: rcp.y + (y0 - vp.y) }), {
    before: async () => {
      assert.equal(await page.locator('.rcp > .dk-ph').count(), 1, 'placeholder while dragging');
      assert.equal(await page.locator('.rcp-view.dk-moving').count(), 1);
      assert.deepEqual((await box('view')).slice(0, 2), [0, 0], 'snapped target');
      await noOverlap();
    },
  });
  assert.equal(await page.locator('.rcp > .dk-ph').count(), 0);
  assert.deepEqual(await box('view'), [0, 0, 6, 15]);
  assert.ok((await box('joy'))[1] >= 15, 'JOY pushed below PREVIEW'); assert.ok((await box('lens'))[1] >= 15, 'LENS pushed below PREVIEW');
  const vb = await page.locator('.rcp-view').boundingBox(); assert.ok(Math.abs(vb.x - rcp.x) < 2 && Math.abs(vb.y - rcp.y) < 2, 'PREVIEW drawn at the top left');
  await noOverlap();
  let p = await prefWait((x) => typeof x['ptz.dock.xl'] === 'string', 'xl layout saved');
  assert.match(p['ptz.dock.xl'], /view:0,0,6,15,0/);
  assert.notEqual(await page.locator('.dk-lay-n').textContent(), 'LAYOUT', 'custom layout shown');

  // ---- resize: bottom-right corner + 2 columns, + 3 rows (snapped, size badge while resizing), then the left edge
  const se = await page.locator('.rcp-view > .dk-rz-se').boundingBox(); const m = await page.evaluate(() => { const r = document.querySelector('.rcp').getBoundingClientRect(); const cw = (r.width - 8 * 23) / 24; return { px: cw + 8, py: 38 }; });
  await page.mouse.move(se.x + 8, se.y + 8); await page.mouse.down();
  await page.mouse.move(se.x + 8 + 2 * m.px, se.y + 8 + 3 * m.py, { steps: 8 });
  assert.equal(await page.locator('.rcp-view .dk-size.on').textContent(), '8 × 18', 'size badge mid-resize');
  await noOverlap();
  await page.mouse.up();
  assert.deepEqual(await box('view'), [0, 0, 8, 18]); await noOverlap();
  const vb2 = await page.locator('.rcp-view').boundingBox(); assert.ok(Math.abs(vb2.height - (18 * 30 + 17 * 8)) < 2, `18 rows tall (${vb2.height})`);
  // left edge of PAINT one column to the left: x - 1, w + 1
  const pb0 = await box('paint'); const we = await page.locator('.rcp-paint > .dk-rz-w').boundingBox();
  await page.mouse.move(we.x + 4, we.y + 40); await page.mouse.down(); await page.mouse.move(we.x + 4 - m.px, we.y + 40, { steps: 6 }); await page.mouse.up();
  const pb1 = await box('paint'); assert.equal(pb1[0], pb0[0] - 1); assert.equal(pb1[2], pb0[2] + 1); await noOverlap();
  // a resize below the minimum stops at the minimum (PAINT: 4 of 24 columns)
  const ee = await page.locator('.rcp-paint > .dk-rz-e').boundingBox();
  await page.mouse.move(ee.x + 4, ee.y + 40); await page.mouse.down(); await page.mouse.move(ee.x - 30 * m.px, ee.y + 40, { steps: 6 }); await page.mouse.up();
  assert.equal((await box('paint'))[2], 4, 'minimum width'); await noOverlap();

  // ---- collapse to the header, expand again
  await page.click('.rcp-iris [data-dk=collapse]');
  assert.equal(await page.locator('.rcp-iris.dk-collapsed').count(), 1);
  assert.ok((await page.locator('.rcp-iris').boundingBox()).height <= 31, 'only the header');
  assert.equal(await page.locator('.rcp-iris .dk-body').isVisible(), false);
  await noOverlap();
  await page.dblclick('.rcp-iris > .dk-head .dk-grip');
  assert.equal(await page.locator('.rcp-iris.dk-collapsed').count(), 0, 'double-click on the header expands'); await noOverlap();

  // ---- close into the tray and reopen where it was
  const pr0 = await box('presets');
  await page.click('.rcp-presets [data-dk=close]');
  assert.equal(await page.locator('.rcp-presets').isVisible(), false);
  assert.equal(await page.locator('.dk-tray .dk-chip').count(), 1); assert.match(await page.locator('.dk-tray').textContent(), /PRESETS/);
  p = await prefWait((x) => /presets:[\d,]+,2(;|$)/.test(x['ptz.dock.xl'] || ''), 'closed flag saved');
  await page.click('.dk-tray .dk-chip[data-id=presets]');
  assert.equal(await page.locator('.rcp-presets').isVisible(), true); assert.equal(await page.locator('.dk-tray').isVisible(), false);
  assert.deepEqual((await box('presets')).slice(0, 1).concat((await box('presets')).slice(2)), [pr0[0], pr0[2], pr0[3]], 'same column and size'); await noOverlap();
  // the LAYOUT menu's panel list closes / reopens too
  await page.click('.dk-lay'); await page.click('.dk-menu input[data-id=sys]'); assert.equal(await page.locator('.rcp-sys').isVisible(), false);
  await page.click('.dk-menu input[data-id=sys]'); assert.equal(await page.locator('.rcp-sys').isVisible(), true); await page.keyboard.press('Escape');
  assert.equal(await page.locator('.dk-menu').isVisible(), false);

  // ---- pop out as a floating window, drag it, dock it again
  const lensBox = await box('lens');
  await page.click('.rcp-lens [data-dk=float]');
  assert.equal(await page.locator('.rcp-lens.dk-floating').count(), 1);
  assert.equal(await page.$eval('.rcp-lens', (e) => getComputedStyle(e).position), 'fixed'); await noOverlap();
  const f0 = await page.locator('.rcp-lens').boundingBox();
  await drag('.rcp-lens > .dk-head', (x0, y0) => ({ x: x0 + 150, y: y0 + 60 }));
  const f1 = await page.locator('.rcp-lens').boundingBox(); assert.ok(Math.abs(f1.x - f0.x - 150) < 3 && Math.abs(f1.y - f0.y - 60) < 3, 'floating window follows the drag');
  await page.click('.rcp-lens [data-dk=float]');
  assert.equal(await page.locator('.rcp-lens.dk-floating').count(), 0); assert.deepEqual((await box('lens')).slice(2), lensBox.slice(2)); await noOverlap();

  // ---- keyboard on a focused header: arrows move, Shift + arrows resize; no camera command (arrows pan the camera elsewhere)
  const n0 = cmds.length;
  const j0 = await box('joy');
  await page.focus('.rcp-joy > .dk-head'); await page.keyboard.press('ArrowRight');
  assert.equal((await box('joy'))[0], j0[0] + 1);
  await page.keyboard.press('Shift+ArrowRight'); assert.equal((await box('joy'))[2], j0[2] + 1);
  await page.keyboard.press('Shift+ArrowDown'); assert.equal((await box('joy'))[3], j0[3] + 1);
  await page.keyboard.press('Shift+ArrowUp'); assert.equal((await box('joy'))[3], j0[3]);
  await page.keyboard.press('Enter'); assert.equal(await page.locator('.rcp-joy.dk-collapsed').count(), 1); await page.keyboard.press('Enter');
  await noOverlap(); await sleep(200);
  assert.deepEqual(cmds.slice(n0), [], 'arrow keys on a panel header never reach the camera');

  // ---- touch: a quick swipe on a header scrolls (no move); press and hold, then drag, moves
  const touch = (sel, dx, dy, holdMs) => page.evaluate(async ([s, ddx, ddy, h]) => {
    const el = document.querySelector(s); const r = el.getBoundingClientRect(); const x0 = r.x + 60; const y0 = r.y + r.height / 2;
    const ev = (type, x, y, target) => (target || document.elementFromPoint(x, y) || document.body).dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y }));
    ev('pointerdown', x0, y0, el); await new Promise((res) => setTimeout(res, h));
    for (let i = 1; i <= 8; i++) ev('pointermove', x0 + (ddx * i) / 8, y0 + (ddy * i) / 8);
    ev('pointerup', x0 + ddx, y0 + ddy);
  }, [sel, dx, dy, holdMs]);
  const s0 = await box('sys');
  await touch('.rcp-sys > .dk-head', -3 * m.px, 0, 0); assert.deepEqual(await box('sys'), s0, 'a quick swipe does not move a panel');
  await touch('.rcp-sys > .dk-head', -3 * m.px, 0, 380); assert.equal((await box('sys'))[0], s0[0] - 3, 'touch hold + drag moves three columns'); await noOverlap();

  // ---- motion safety
  await sleep(300); const n1 = cmds.length;
  // (a) a drag in progress: a joystick press from another pointer is held off; nothing reaches the camera
  const jb = await page.locator('#ptzJoy').boundingBox();
  await drag('.rcp-sys > .dk-head', (x0, y0) => ({ x: x0 + m.px, y: y0 }), {
    before: async () => {
      await page.evaluate(([x, y]) => { const j = document.querySelector('#ptzJoy'); for (const t of ['pointerdown', 'pointermove']) j.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: false, clientX: x, clientY: y })); }, [jb.x + jb.width * 0.9, jb.y + jb.height / 2]);
      await sleep(250);
      assert.equal(await page.evaluate(() => window.CCPTZ.held().pt), false, 'joystick not taken during a panel drag');
    },
  });
  await page.evaluate(() => document.querySelector('#ptzJoy').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, pointerType: 'touch' })));
  await sleep(300);
  assert.deepEqual(cmds.slice(n1), [], 'moving / resizing panels sends no camera command');
  // (b) joystick held: a panel drag is refused, the layout stays, the keep-alive keeps running, release stops
  const before = JSON.stringify(await L());
  await page.locator('#ptzJoy').scrollIntoViewIfNeeded(); const jb2 = await page.locator('#ptzJoy').boundingBox(); Object.assign(jb, jb2);
  await page.mouse.move(jb.x + jb.width * 0.8, jb.y + jb.height / 2); await page.mouse.down(); await page.mouse.move(jb.x + jb.width * 0.85, jb.y + jb.height / 2, { steps: 2 });
  assert.equal(await page.evaluate(() => window.CCPTZ.held().pt), true);
  const k0 = cmds.filter((c) => c === 'keepalive').length;
  await touch('.rcp-paint > .dk-head', 2 * m.px, 0, 380);
  await page.evaluate(() => { const h = document.querySelector('.rcp-paint > .dk-head'); h.focus(); h.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })); });
  await sleep(1300);
  assert.equal(JSON.stringify(await L()), before, 'no rearranging while the joystick is held');
  assert.ok(cmds.filter((c) => c === 'keepalive').length - k0 >= 2, 'keep-alive continues while a panel drag is refused');
  assert.equal(await page.evaluate(() => window.CCPTZ.held().pt), true, 'joystick still held');
  await page.mouse.up(); await sleep(300);
  assert.ok(cmds.slice(n1).includes('move') && cmds.slice(n1).includes('stop'), 'joystick moved and stopped normally');
  assert.equal(await page.evaluate(() => window.CCPTZ.held().pt), false);

  // ---- breakpoints: each keeps its own layout, per install
  const xlEnc = await page.evaluate(() => window.CCPTZ.dock.enc());
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForFunction(() => window.CCPTZ.dock.bp() === 'lg');
  assert.equal(await page.evaluate(() => window.CCPTZ.dock.enc() === window.CCPTZ.dock.defaults()), true, 'lg starts at its default');
  assert.deepEqual(await box('paint'), [0, 17, 24, 16]);
  await page.focus('.rcp-sys > .dk-head'); await page.keyboard.press('Shift+ArrowLeft'); await page.keyboard.press('Shift+ArrowLeft');
  assert.equal((await box('sys'))[2], 7);
  p = await prefWait((x) => typeof x['ptz.dock.lg'] === 'string', 'lg saved');
  await page.setViewportSize({ width: 1000, height: 800 }); await page.waitForFunction(() => window.CCPTZ.dock.bp() === 'md');
  assert.equal(await page.$eval('.rcp', (e) => getComputedStyle(e).gridTemplateColumns.split(' ').length), 12);
  await page.setViewportSize({ width: 1920, height: 1080 }); await page.waitForFunction(() => window.CCPTZ.dock.bp() === 'xl');
  assert.equal(await page.evaluate(() => window.CCPTZ.dock.enc()), xlEnc, 'xl layout back');
  // a second browser at 1280 gets this install's lg layout
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const p2 = await ctx2.newPage();
  await p2.goto(`${B}/#pctl`); await p2.waitForFunction(() => window.CCPTZ && window.CCPTZ.dock && window.CCPTZ.dock.layout().find((i) => i.id === 'sys').w === 7, null, { timeout: 8000 });
  await ctx2.close();

  // ---- narrow screens: two columns under 820 px, one stacked column under 560 px
  await page.setViewportSize({ width: 700, height: 900 }); await page.waitForFunction(() => window.CCPTZ.dock.bp() === 'sm');
  assert.equal(await page.$eval('.rcp', (e) => getComputedStyle(e).gridTemplateColumns.split(' ').length), 2);
  await page.setViewportSize({ width: 500, height: 900 }); await page.waitForFunction(() => window.CCPTZ.dock.stacked());
  const xs = await page.$$eval('.rcp > .dk-panel:not([hidden])', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.width), Math.round(r.y)]; }));
  assert.equal(new Set(xs.map((x) => x[0])).size, 1, 'one column'); assert.equal(new Set(xs.map((x) => x[1])).size, 1, 'full width');
  assert.equal(new Set(xs.map((x) => x[2])).size, xs.length, 'stacked');
  await page.setViewportSize({ width: 1920, height: 1080 }); await page.waitForFunction(() => window.CCPTZ.dock.bp() === 'xl');

  // ---- named layouts: save, reset, load, rename, delete
  await page.click('.dk-lay'); await page.fill('.dk-menu input[name=dkname]', 'Paint op'); await page.click('.dk-menu [data-dka=save]');
  p = await prefWait((x) => x['ptz.dockPresets'] && x['ptz.dockPresets']['Paint op'], 'preset saved');
  assert.ok(p['ptz.dockPresets']['Paint op'].xl && p['ptz.dockPresets']['Paint op'].lg, 'the preset keeps every changed breakpoint');
  assert.equal(await page.locator('.dk-lay-n').textContent(), 'LAYOUT: Paint op');
  await page.click('.dk-menu [data-dka=reset]');
  assert.equal(await page.evaluate(() => window.CCPTZ.dock.enc() === window.CCPTZ.dock.defaults()), true, 'reset to the default');
  assert.equal(await page.locator('.dk-lay-n').textContent(), 'LAYOUT');
  p = await prefWait((x) => !x['ptz.dock.xl'] && !x['ptz.dock.lg'], 'reset clears every breakpoint');
  assert.ok(p['ptz.dockPresets']['Paint op'], 'reset keeps the saved layouts');
  await page.click('.dk-lay'); await page.click('.dk-menu [data-dka=load][data-name="Paint op"]');
  assert.equal(await page.evaluate(() => window.CCPTZ.dock.enc()), xlEnc, 'loaded');
  assert.equal(await page.locator('.dk-lay-n').textContent(), 'LAYOUT: Paint op');
  await prefWait((x) => typeof x['ptz.dock.lg'] === 'string' && typeof x['ptz.dock.xl'] === 'string', 'load restores every breakpoint');
  await page.click('.dk-lay');
  page.once('dialog', (d) => d.accept('Shader + joystick'));
  await page.click('.dk-menu [data-dka=rename][data-name="Paint op"]');
  p = await prefWait((x) => x['ptz.dockPresets'] && x['ptz.dockPresets']['Shader + joystick'] && !x['ptz.dockPresets']['Paint op'], 'renamed');
  assert.equal(await page.locator('.dk-lay-n').textContent(), 'LAYOUT: Shader + joystick');
  page.once('dialog', (d) => d.accept());
  await page.click('.dk-menu [data-dka=delete][data-name="Shader + joystick"]');
  await prefWait((x) => !x['ptz.dockPresets'], 'deleted');
  assert.equal(await page.locator('.dk-lay-n').textContent(), 'LAYOUT: CUSTOM');

  // the layout survives a reload (per install)
  await page.reload(); await page.waitForFunction(() => window.CCPTZ && window.CCPTZ.dock);
  await page.waitForFunction((e) => window.CCPTZ.dock.enc() === e, xlEnc, { timeout: 8000 });
  assert.deepEqual(errors, []);
});
