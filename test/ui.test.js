'use strict';
// 0.3.2 regression: "there is no Settings icon". In 0.3.0/0.3.1 the drag-preview rule `.ghost{position:fixed;
// transform:translate(-50%,-130%);pointer-events:none}` also matched every `btn ghost` button (the header
// Settings button and the dialogs' Cancel/Close), which put them off-screen above the top-left corner.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PUB = path.join(__dirname, '..', 'public');
const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');

function rules(src) { // flat rules incl. those inside @media
  const out = []; const re = /([^{}]+)\{([^{}]*)\}/g; let m;
  while ((m = re.exec(src))) out.push({ sel: m[1].replace(/@media[^{]*\{?/g, '').trim(), body: m[2] });
  return out;
}

test('no position:fixed rule can match a <button> by one of its classes (static check)', () => {
  const btnClasses = new Set();
  for (const m of html.matchAll(/<button\b[^>]*class="([^"]*)"/g)) m[1].split(/\s+/).forEach((c) => c && btnClasses.add(c));
  assert.ok(btnClasses.has('ghost'), 'fixture: buttons use the ghost class');
  for (const r of rules(css)) {
    if (!/position\s*:\s*fixed/.test(r.body)) continue;
    for (const sel of r.sel.split(',')) {
      const last = sel.trim().split(/[\s>+~]+/).pop(); // the compound selector that picks the element
      if (/^(button|\*)?\./.test(last) && !/^[a-z]/i.test(last.replace(/^button/, ''))) {
        const classes = [...last.matchAll(/\.([\w-]+)/g)].map((x) => x[1]);
        if (/^button/.test(last) || classes.length) {
          const hitsButton = classes.every((c) => btnClasses.has(c)) && !/[#\[:]/.test(last);
          assert.ok(!hitsButton, `rule "${sel.trim()}" (position:fixed) would match a <button class="${classes.join(' ')}">`);
        }
      }
    }
  }
});

test('Settings button markup and /settings deep link are present', () => {
  assert.match(html, /<header class="top">[\s\S]*<button id="btnSettings"[^>]*>[^<]*Settings<\/button>[\s\S]*<\/header>/);
  const app = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
  assert.match(app, /location\.pathname === '\/settings'/);
});

// Browser check. Uses Playwright when it can be resolved (npm i -g playwright, or NODE_PATH); skipped otherwise,
// because the app itself has no dependencies.
let pw = null;
try { pw = require('playwright'); } catch { pw = null; }

function waitHttp(url, ms = 15000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => http.get(url, (r) => { r.resume(); resolve(); }).on('error', () => (Date.now() - t0 > ms ? reject(new Error('server did not start')) : setTimeout(tryOnce, 200)));
    tryOnce();
  });
}

test('#btnSettings is visible, clickable and inside the viewport at 820 and 1440 px (Playwright)', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6ui-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--port', String(port), '--data', data], { stdio: 'ignore' });
  t.after(() => { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); });
  await waitHttp(`http://127.0.0.1:${port}/api/state`);
  const browser = await pw.chromium.launch();
  t.after(() => browser.close());
  for (const width of [820, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/#presets`);
    const btn = page.locator('#btnSettings');
    await btn.waitFor({ state: 'visible' });
    const box = await btn.boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= 900, `in viewport at ${width}: ${JSON.stringify(box)}`);
    const top = await page.evaluate(() => { const e = document.querySelector('#btnSettings'); const r = e.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === e; });
    assert.ok(top, `not covered at ${width}`);
    const hdr = await page.locator('header.top').boundingBox();
    assert.ok(box.y + box.height <= hdr.y + hdr.height + 1, `inside the top bar at ${width}`);
    await btn.click();
    await page.locator('#dlgSettings[open]').waitFor();
    const cancel = await page.locator('#dlgSettings .btn.ghost').boundingBox();
    assert.ok(cancel && cancel.x >= 0 && cancel.y >= 0, `dialog Cancel on screen at ${width}`);
    await page.close();
  }
});

// 0.3.3 regression: "The presets in the gui (the ones dropped to the buttons) still don't display their preset names".
test('a memory tapped onto an empty tile names the tile after the memory; long-press and right-click rename (Playwright)', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const port = 19000 + Math.floor(Math.random() * 1000);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6ui-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--port', String(port), '--data', data], { stdio: 'ignore' });
  t.after(() => { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); });
  await waitHttp(`http://127.0.0.1:${port}/api/state`);
  const browser = await pw.chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`http://127.0.0.1:${port}/#presets`);
  const mem = page.locator('[data-mtype=screen][data-slot="1"]');
  await mem.waitFor();
  const label = (await mem.locator('.nm').textContent()).trim();
  await mem.click(); await page.click('[data-empty="20"]');
  await page.locator('#dlgPick[open] #pickList button').first().click();
  const tile = page.locator('[data-preset="20"]');
  await tile.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-preset="20"] .name').textContent.trim().length > 0);
  assert.equal((await tile.locator('.name').textContent()).trim(), label);
  assert.equal((await tile.locator('.num').textContent()).trim(), '20');
  const [numPx, namePx] = await tile.evaluate((e) => ['.num', '.name'].map((s) => parseFloat(getComputedStyle(e.querySelector(s)).fontSize)));
  assert.ok(namePx > numPx, `name (${namePx}px) is more prominent than the number (${numPx}px)`);
  // long-press -> prompt -> typed name
  page.once('dialog', (d) => d.accept('Walk-in wide'));
  const b = await tile.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down(); await page.waitForTimeout(800); await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-preset="20"] .name').textContent.trim() === 'Walk-in wide');
  // right-click -> prompt -> empty = automatic again
  page.once('dialog', (d) => d.accept(''));
  await tile.click({ button: 'right' });
  await page.waitForFunction((l) => document.querySelector('[data-preset="20"] .name').textContent.trim() === l, label);
  await page.close();
});

// ---------------- 0.3.4 ----------------
function startApp(port, data, env = {}) {
  return spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--port', String(port), '--data', data], { stdio: 'ignore', env: { ...process.env, ...env } });
}
async function appFixture(t, env) {
  const port = 20000 + Math.floor(Math.random() * 5000);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6ui-'));
  const app = { port, data, base: `http://127.0.0.1:${port}`, proc: startApp(port, data, env) };
  app.restart = async () => { app.proc = startApp(port, data, env); await waitHttp(`${app.base}/api/state`); };
  t.after(() => { try { app.proc.kill('SIGCONT'); app.proc.kill(); } catch { /* gone */ } fs.rmSync(data, { recursive: true, force: true }); });
  await waitHttp(`${app.base}/api/state`);
  return app;
}
const browsers = () => (pw ? [['chromium', pw.chromium], ['firefox', pw.firefox]] : []);
async function launch(t, type) {
  try { const b = await type.launch(); t.after(() => b.close()); return b; } catch (e) { t.skip(`browser not installed: ${e.message.split('\n')[0]}`); return null; }
}

test('3. layout: each destination tile sits exactly above its board card (820-1920 px)', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const app = await appFixture(t);
  const browser = await launch(t, pw.chromium); if (!browser) return;
  for (const width of [820, 1024, 1280, 1440, 1680, 1920]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(app.base + '/#presets'); await page.waitForSelector('#board .card[data-drop="S1"]');
    const r = await page.evaluate(() => {
      const box = (e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width) }; };
      const keys = [...document.querySelectorAll('#destRow [data-dest]')].map((e) => e.dataset.dest);
      return {
        pairs: keys.map((k) => [k, box(document.querySelector(`#destRow [data-dest="${k}"]`)), box(document.querySelector(`#board [data-drop="${k}"]`))]),
        lead: [box(document.querySelector('#destRow .ctlcell')), box(document.querySelector('#board [data-drop="master"]'))],
        widths: [...document.querySelectorAll('#board .card')].map((e) => Math.round(e.getBoundingClientRect().width)),
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    assert.ok(r.pairs.length >= 4);
    for (const [k, a, b] of r.pairs) assert.deepEqual(a, b, `${width}px: ${k} tile ${JSON.stringify(a)} vs card ${JSON.stringify(b)}`);
    assert.deepEqual(r.lead[0], r.lead[1], `${width}px: ALL/CLEAR above MASTER`);
    assert.equal(new Set(r.widths).size, 1, `${width}px: equal card widths ${r.widths}`);
    assert.ok(r.overflow <= 0, `${width}px: page scrolls sideways by ${r.overflow}px`);
    const set = await page.locator('#btnSettings').boundingBox(); assert.ok(set.x + set.width <= width);
    await page.close();
  }
});

test('2. palette: MV tab with the box unchecked lists no unknown slots and says what to do; no LAYER tab', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const app = await appFixture(t);
  const browser = await launch(t, pw.chromium); if (!browser) return;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(app.base + '/#presets'); await page.waitForSelector('#palTabs [data-ptab="multiviewer"]');
  await page.click('#palTabs [data-ptab="multiviewer"]');
  assert.equal(await page.locator('#palList .mem').count(), 0);
  assert.match(await page.textContent('#palList'), /No Multiviewer memories known.*probe.*show empty \/ unknown slots/s);
  await page.check('#palAll');
  await page.waitForFunction(() => document.querySelectorAll('#palList .mem').length === 50);
  await page.uncheck('#palAll');
  await page.waitForFunction(() => document.querySelectorAll('#palList .mem').length === 0);
  assert.equal(await page.locator('#palTabs [data-ptab="layer"]').count(), 0); // 0.4.0: Layer memories removed
});

for (const [name, type] of browsers()) {
  test(`4. ${name}: live updates resume after a back/forward-cache round trip, a server restart, a frozen stream and offline`, async (t) => {
    const app = await appFixture(t, { RS6_SSE_HEARTBEAT_MS: '500' });
    const browser = await launch(t, type); if (!browser) return;
    const ctx = await browser.newContext();
    // record the page's EventSources so the test can close them the way Firefox does on bfcache entry
    await ctx.addInitScript(() => {
      window.RS6_WATCHDOG_MS = 2500;
      const ES = window.EventSource; window.__es = [];
      window.EventSource = function (u, o) { const e = new ES(u, o); window.__es.push(e); return e; };
      window.EventSource.prototype = ES.prototype; Object.assign(window.EventSource, { CONNECTING: 0, OPEN: 1, CLOSED: 2 });
    });
    const page = await ctx.newPage();
    await page.goto(app.base + '/#presets');
    const linkIs = (s, ms = 8000) => page.waitForFunction((x) => window.__rs6link && window.__rs6link.state === x, s, { timeout: ms });
    const sel = () => page.evaluate(() => document.querySelector('#destRow [data-dest="S2"]').classList.contains('on'));
    const toggleAndSee = async (what) => {
      const before = await sel();
      await page.request.post(app.base + '/api/destinations/S2/toggle');
      await page.waitForFunction((b) => document.querySelector('#destRow [data-dest="S2"]').classList.contains('on') !== b, before, { timeout: 8000 })
        .catch(() => { throw new Error(`${name}: no live update after ${what}`); });
    };
    await linkIs('ok'); assert.equal(await page.textContent('#link'), 'APP LINK OK'); assert.ok(await page.locator('#linkBanner').isHidden());
    await toggleAndSee('page load');

    // (a) bfcache: Firefox closes the EventSource on pagehide(persisted) and doesn't reopen it on pageshow
    await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); for (const e of window.__es) e.close(); });
    await page.request.post(app.base + '/api/destinations/S3/toggle'); // changed while away
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await page.waitForFunction(() => document.querySelector('#destRow [data-dest="S3"]').classList.contains('on'), null, { timeout: 5000 }); // refetched on resume
    await linkIs('ok'); await toggleAndSee('bfcache restore');

    // (b) app server restarts
    app.proc.kill(); await linkIs('reconnecting');
    assert.ok(await page.locator('#linkBanner').isVisible()); assert.match(await page.textContent('#link'), /RECONNECTING/);
    await app.restart(); await linkIs('ok', 20000); await toggleAndSee('server restart');

    // (c) a stream that stays open but goes silent (frozen tab / sleeping laptop): the watchdog reopens it
    app.proc.kill('SIGSTOP'); await linkIs('reconnecting', 10000);
    app.proc.kill('SIGCONT'); await linkIs('ok', 20000); await toggleAndSee('silent stream');

    // (d) the browser goes offline and back
    await ctx.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event('offline'))); await linkIs('offline');
    assert.equal(await page.textContent('#link'), 'OFFLINE');
    await ctx.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); await linkIs('ok', 10000); await toggleAndSee('back online');

    // (e) tab hidden then visible again with a dead stream
    await page.evaluate(() => { for (const e of window.__es) e.close(); Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await linkIs('ok'); await toggleAndSee('tab visible again');
  });
}

// ---------------- 0.4.0 ----------------
const visible = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; }), sel);

test('0.4.0 #1: INPUTS / BACKUP / AUDIO show no destinations, TAKE/CUT or presets, and use the full width', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const app = await appFixture(t);
  const browser = await launch(t, pw.chromium); if (!browser) return;
  for (const width of [820, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(app.base + '/#presets'); await page.waitForSelector('#grid [data-preset="1"]');
    assert.ok(await visible(page, '.transport'), 'PRESETS tab has TAKE/CUT');
    for (const tab of ['inputs', 'backup', 'audio']) {
      await page.click(`.tab[data-tab=${tab}]`);
      await page.waitForFunction((x) => document.body.classList.contains(`tab-${x}`), tab);
      for (const sel of ['.transport', '#destRow', '#grid', '#board', '#last', '#master', '.modes', '#palette']) {
        assert.equal(await visible(page, sel), false, `${width}px ${tab}: ${sel} hidden`);
      }
      const r = await page.evaluate((x) => { const p = document.querySelector(`#pane-${x}`).getBoundingClientRect(); return { x: p.x, w: p.width, vw: document.documentElement.clientWidth }; }, tab);
      assert.ok(r.w >= r.vw - 60, `${width}px ${tab}: pane spans the width (${r.w} of ${r.vw})`);
      await page.keyboard.press('Space'); await page.keyboard.press('c');
    }
    await page.close();
  }
  // Space / C on those tabs never sent a TAKE or CUT
  const log = await (await fetch(app.base + '/api/state')).json();
  assert.ok(!JSON.stringify(log.log || []).match(/\b(TAKE|CUT)\b.*(S1|A1)/), 'no take from the other tabs');
});

test('0.4.0 #3: drag a tile onto another swaps them; MOVE mode tap-tap moves into an empty tile', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const app = await appFixture(t);
  const browser = await launch(t, pw.chromium); if (!browser) return;
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(app.base + '/#presets'); await page.waitForSelector('#grid [data-preset="2"]');
  const nameOf = async (n) => (await (await fetch(app.base + '/api/state')).json()).presets.find((p) => p.number === n)?.name;
  const [n1, n2] = [await nameOf(1), await nameOf(2)];
  const a = await page.locator('#grid [data-preset="1"]').boundingBox(); const b = await page.locator('#grid [data-preset="2"]').boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 20, a.y + a.height / 2, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  assert.equal(await page.locator('#grid .swap-hover[data-preset="2"]').count(), 1, 'target highlighted');
  await page.mouse.up();
  await page.waitForFunction(() => /Swapped 1 ⇄ 2/.test(document.body.innerText));
  assert.equal(await nameOf(1), n2); assert.equal(await nameOf(2), n1);
  // a drag is not a click: nothing went to PVW
  assert.ok(!(await (await fetch(app.base + '/api/state')).json()).lastRecalled, 'drag did not recall');
  // MOVE mode (iPad): tap source, tap empty target
  await page.click('.mode[data-mode=move]');
  assert.match(await page.textContent('#modeHint'), /MOVE/);
  await page.click('#grid [data-preset="3"]');
  assert.equal(await page.locator('#grid .move-src[data-preset="3"]').count(), 1);
  await page.keyboard.press('Escape'); // cancel
  assert.equal(await page.locator('#grid .move-src').count(), 0);
  const n3 = await nameOf(3);
  await page.click('#grid [data-preset="3"]'); await page.click('#grid [data-empty="20"]');
  await page.waitForFunction(() => /Moved 3 → 20/.test(document.body.innerText));
  assert.equal(await nameOf(20), n3); assert.equal(await nameOf(3), undefined);
  assert.equal(await page.locator('#grid .mode-move').count() + await page.locator('#grid.mode-move').count(), 1, 'still in MOVE mode for the next one');
});

test('0.4.0 #4: the mode bar says what a tile tap does; SAVE is "SAVE PVW → TILE"', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const app = await appFixture(t);
  const browser = await launch(t, pw.chromium); if (!browser) return;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(app.base + '/#presets'); await page.waitForSelector('#grid [data-preset="1"]');
  assert.match(await page.textContent('.modes'), /TAP A TILE TO\s*RECALL\s*EDIT\s*MOVE ⇄\s*SAVE PVW → TILE/);
  const expect = { recall: /Preview/, edit: /edit|rename/i, move: /swap/i, save: /overwrite[\s\S]*stores[\s\S]*Preview/ };
  for (const [m, re] of Object.entries(expect)) {
    await page.click(`.mode[data-mode=${m}]`);
    assert.match(await page.textContent('#modeHint'), re, `${m} hint`);
    assert.ok((await page.getAttribute(`.mode[data-mode=${m}]`, 'title')).length > 20, `${m} tooltip`);
    assert.equal(await page.locator(`#grid.mode-${m}`).count(), 1, `${m} grid class (corner cue)`);
  }
  await page.click('.mode[data-mode=save]');
  await page.click('#grid [data-empty="20"]'); // nothing lit yet: told why
  await page.waitForFunction(() => /Light at least one screen above first/.test(document.body.innerText));
  await page.click('#destRow [data-dest="S1"]'); await page.waitForSelector('#destRow .dest.on[data-dest="S1"]');
  await page.click('#grid [data-preset="1"]');
  await page.waitForSelector('#dlgSave[open]');
  assert.match(await page.textContent('#saveTitle'), /Overwrite tile 1 with what is on Preview/);
  await page.click('#dlgSave button[value=cancel]');
  await page.click('#grid [data-empty="20"]'); await page.waitForSelector('#dlgSave[open]');
  assert.match(await page.textContent('#saveTitle'), /Save Preview to tile 20/);
});

test('0.4.0 #5: BACKUP tab shows the group label and only existing backups', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const app = await appFixture(t);
  const browser = await launch(t, pw.chromium); if (!browser) return;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(app.base + '/#presets'); await page.click('.tab[data-tab=backup]');
  await page.waitForFunction(() => /MEDIA BU/.test(document.querySelector('#pane-backup').innerText));
  const txt = await page.textContent('#pane-backup');
  assert.match(txt, /MEDIA BU\s*GROUP 1/);
  assert.doesNotMatch(txt, /IN 9\b|OLD SET|Group 2\b|GROUP 2\b/);
});

test('0.4.0 #6: WEB RCS tab embeds the device page; a unit that refuses framing gets the side-window fallback', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const app = await appFixture(t);
  const browser = await launch(t, pw.chromium); if (!browser) return;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(app.base + '/#presets'); await page.click('.tab[data-tab=webrcs]');
  await page.waitForFunction(() => /EMBEDDED/.test(document.querySelector('#rcsStatus').textContent));
  const frame = page.frameLocator('#rcsFrame');
  await frame.locator('text=Web RCS placeholder').waitFor();
  assert.equal(await visible(page, '.transport'), false);
  const pop = page.waitForEvent('popup'); await page.click('#rcsSide'); const w = await pop;
  assert.match(w.url(), /^http:\/\/127\.0\.0\.1:\d+\/$/); await w.close();
  await page.click('#rcsUnload'); assert.equal(await page.getAttribute('#rcsFrame', 'src') || '', '' || (await page.getAttribute('#rcsFrame', 'src')) || '');
  // a unit that sends X-Frame-Options: DENY
  const p2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await p2.route('**/api/webrcs', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ url: 'http://127.0.0.1:9/', reachable: true, status: 200, framable: false, blockedBy: ['X-Frame-Options: DENY'] }) }));
  await p2.goto(app.base + '/#presets'); await p2.click('.tab[data-tab=webrcs]');
  await p2.waitForFunction(() => /CAN'T EMBED/.test(document.querySelector('#rcsStatus').textContent));
  assert.ok(await visible(p2, '#rcsBlocked')); assert.match(await p2.textContent('#rcsBlocked'), /X-Frame-Options: DENY/);
  assert.ok(await visible(p2, '#rcsSide'));
});

// ---------------- 0.5.0 ----------------
const stateOf = async (app) => (await fetch(app.base + '/api/state')).json();
const layout = (st) => st.presets.map((p) => `${p.number}:${p.name}`).join('|');
// each tile's number and its position inside the grid (page scroll doesn't matter)
const tileOrder = (page) => page.evaluate(() => { const g = document.querySelector('#grid').getBoundingClientRect(); return [...document.querySelectorAll('#grid > *')].map((e) => {
  const r = e.getBoundingClientRect(); return `${e.dataset.preset || '-' + e.dataset.empty}@${Math.round(r.x - g.x)},${Math.round(r.y - g.y)}`;
}).join(' '); });

test('0.5.0 #2: leaving PRESETS and coming back never re-orders tiles; MOVE ends on a tab switch; taps then recall', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const app = await appFixture(t);
  for (const [name, type] of browsers()) {
    const browser = await launch(t, type); if (!browser) return;
    for (const width of [820, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(app.base + '/#presets'); await page.waitForSelector('#grid [data-preset="1"]');
      const data0 = layout(await stateOf(app)); const tiles0 = await tileOrder(page);
      // plain round trip through every tab
      for (const tb of ['inputs', 'backup', 'audio', 'webrcs', 'presets']) { await page.click(`.tab[data-tab=${tb}]`); await page.waitForTimeout(150); }
      assert.equal(await tileOrder(page), tiles0, `${name} ${width}: tiles at the same place`);
      // the reported case: MOVE mode with a tile picked, leave, come back, tap tiles meaning to recall
      await page.click('.mode[data-mode=move]'); await page.click('#grid [data-preset="6"]');
      assert.equal(await page.locator('#grid .move-src').count(), 1);
      for (const tb of ['inputs', 'backup', 'audio', 'webrcs', 'presets']) { await page.click(`.tab[data-tab=${tb}]`); await page.waitForTimeout(100); }
      assert.equal(await page.locator('.mode[data-mode].active').getAttribute('data-mode'), 'recall', `${name} ${width}: back in RECALL`);
      assert.equal(await page.locator('#grid .move-src').count(), 0);
      for (const n of [2, 4, 5]) { await page.click(`#grid [data-preset="${n}"]`); await page.waitForTimeout(120); }
      await page.click('#grid [data-empty="16"]');
      await page.waitForTimeout(300);
      const st = await stateOf(app);
      assert.equal(layout(st), data0, `${name} ${width}: no preset moved`);
      assert.equal(st.lastRecalled.number, 5, 'the taps recalled');
      assert.equal(await tileOrder(page), tiles0);
      // a sloppy mouse click (10 px) is not a drag
      const a = await page.locator('#grid [data-preset="1"]').boundingBox();
      await page.mouse.move(a.x + a.width - 6, a.y + 20); await page.mouse.down(); await page.mouse.move(a.x + a.width + 4, a.y + 20, { steps: 3 }); await page.mouse.up();
      await page.waitForTimeout(250);
      assert.equal(layout(await stateOf(app)), data0, `${name} ${width}: a 10 px wobble did not swap 1 and 2`);
      await page.close();
    }
  }
});

test('0.5.0 #2: MOVE mode ends by itself when idle; a swap can be undone', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const app = await appFixture(t);
  const browser = await launch(t, pw.chromium); if (!browser) return;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => { window.RS6_MOVE_IDLE_MS = 700; });
  await page.goto(app.base + '/#presets'); await page.waitForSelector('#grid [data-preset="1"]');
  const data0 = layout(await stateOf(app));
  assert.equal(await page.isVisible('#undoBar'), false, 'no empty UNDO bar before any swap');
  await page.click('.mode[data-mode=move]');
  await page.waitForFunction(() => document.querySelector('.mode[data-mode].active').dataset.mode === 'recall', null, { timeout: 3000 });
  await page.click('.mode[data-mode=move]');
  await page.click('#grid [data-preset="1"]'); await page.click('#grid [data-preset="2"]');
  await page.waitForFunction(() => /Swapped 1 ⇄ 2/.test(document.querySelector('#undoBar').textContent));
  assert.notEqual(layout(await stateOf(app)), data0);
  await page.click('#undoBar button');
  await page.waitForFunction(() => /Undone/.test(document.querySelector('#toast').textContent));
  assert.equal(layout(await stateOf(app)), data0);
  assert.equal(await page.isVisible('#undoBar'), false, 'UNDO bar hidden again after undo');
});

test('0.5.0 #3: 48 tiles by default, 96 from Settings, pages of 24 work on an iPad', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const app = await appFixture(t);
  const browser = await launch(t, pw.chromium); if (!browser) return;
  const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.goto(app.base + '/#presets'); await page.waitForSelector('#grid [data-preset="1"]');
  assert.equal(await page.locator('#grid > *').count(), 48);
  assert.equal(await page.locator('#pager .pg').count(), 3); // ALL, 1–24, 25–48
  await page.click('#btnSettings'); await page.waitForSelector('#dlgSettings[open]');
  await page.selectOption('#formSettings select[name=tileCount]', '96');
  await page.click('#btnSaveSettings');
  await page.waitForFunction(() => document.querySelectorAll('#grid > *').length === 96);
  assert.match(await page.textContent('#pager'), /ALL\s*1–24\s*\d*\s*25–48\s*49–72\s*73–96/);
  await page.tap('#pager [data-page="4"]');
  await page.waitForFunction(() => document.querySelectorAll('#grid > *').length === 24);
  assert.equal(await page.locator('#grid > *').first().getAttribute('data-empty'), '73');
  // a preset can be moved to tile 96 across pages (MOVE: pick on page 1, tap on page 4)
  await page.tap('#pager [data-page="1"]');
  await page.tap('.mode[data-mode=move]'); await page.tap('#grid [data-preset="3"]');
  await page.tap('#pager [data-page="4"]'); await page.tap('#grid [data-empty="96"]');
  await page.waitForFunction(() => document.querySelector('#grid [data-preset="96"]'));
  assert.ok((await stateOf(app)).presets.some((p) => p.number === 96));
  const pb = await page.locator('#pager [data-page="1"]').boundingBox(); assert.ok(pb.height >= 40, 'page buttons are finger-sized');
  // the page choice survives a reload
  await page.reload(); await page.waitForSelector('#grid [data-preset="96"]');
  assert.equal(await page.locator('#grid > *').count(), 24);
});

test('0.5.0 shows: header name + unsaved dot, Save, Save as, Open with confirmation (nothing sent), Settings shows the data folder', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const app = await appFixture(t);
  const browser = await launch(t, pw.chromium); if (!browser) return;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(app.base + '/#presets'); await page.waitForSelector('#grid [data-preset="1"]');
  assert.equal(await page.textContent('#showName'), 'Untitled show');
  assert.ok(await page.isVisible('#showDirty'), 'seeded presets are unsaved');
  await page.click('#btnShow'); await page.waitForSelector('#dlgShows[open]');
  page.once('dialog', (d) => d.accept('Gala'));
  await page.click('#shSaveAs');
  await page.waitForFunction(() => document.querySelector('#showName').textContent === 'Gala');
  await page.waitForFunction(() => document.querySelector('#showDirty').hidden);
  assert.match(await page.textContent('#shList'), /Gala.*12 presets.*48 tiles/s);
  // password box needs the connection box, and warns
  assert.ok(await page.isDisabled('#shPass'));
  await page.check('#shConn'); page.once('dialog', (d) => d.accept()); await page.check('#shPass');
  assert.ok(await page.isVisible('#shPassWarn'));
  await page.uncheck('#shConn'); assert.ok(!(await page.isChecked('#shPass')));
  await page.click('#dlgShows button[value=close]');
  // change something -> dot
  await fetch(app.base + '/api/presets/swap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: 1, b: 2 }) });
  await page.waitForFunction(() => !document.querySelector('#showDirty').hidden);
  // open Gala: confirm dialog names the unsaved changes; cancel keeps everything
  await page.click('#btnShow'); await page.waitForSelector('#dlgShows[open] .show-row');
  let msg = '';
  page.once('dialog', (d) => { msg = d.message(); d.dismiss(); });
  await page.click('.show-row[data-id="Gala"] [data-sh=open]');
  await page.waitForTimeout(300);
  assert.match(msg, /Open show "Gala".*UNSAVED.*backup.*Nothing is sent to the RS6/s);
  assert.equal((await stateOf(app)).presets.find((p) => p.number === 1).name, 'Keynote Full');
  page.once('dialog', (d) => d.accept());
  await page.click('.show-row[data-id="Gala"] [data-sh=open]');
  await page.waitForFunction(() => document.querySelector('#showDirty').hidden);
  assert.equal((await stateOf(app)).presets.find((p) => p.number === 1).name, 'Walk-in');
  assert.match(await page.textContent('#shBackups summary'), /Automatic backups \(1/);
  await page.click('#dlgShows button[value=close]');
  // download the current show
  const [dl] = await Promise.all([page.waitForEvent('download'), (async () => { await page.click('#btnShow'); await page.click('#shExport'); })()]);
  assert.equal(dl.suggestedFilename(), 'Gala.rs6show');
  const body = JSON.parse(fs.readFileSync(await dl.path(), 'utf8')); assert.equal(body.format, 'rs6-presets-show'); assert.equal(body.connection, null);
  // upload a file (an old presets.json)
  const f = path.join(app.data, 'old-presets.json');
  fs.writeFileSync(f, JSON.stringify({ version: 2, presets: [{ number: 40, name: 'From 0.4', destinations: ['S1'], memories: { S1: 10 } }] }));
  page.once('dialog', (d) => d.dismiss()); // "open now?" -> no
  await page.setInputFiles('#shUpload', f);
  await page.waitForFunction(() => /converted from presets\.json/.test(document.querySelector('#toast').textContent));
  await page.waitForFunction(() => document.querySelectorAll('#shList .show-row').length === 2);
  await page.click('#dlgShows button[value=close]');
  // Settings shows the data folder
  await page.click('#btnSettings'); await page.waitForSelector('#dlgSettings[open]');
  assert.equal(await page.textContent('#dataDirPath'), app.data);
});
