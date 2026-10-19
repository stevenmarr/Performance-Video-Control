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
    await page.goto(`http://127.0.0.1:${port}/`);
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
  await page.goto(`http://127.0.0.1:${port}/`);
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
