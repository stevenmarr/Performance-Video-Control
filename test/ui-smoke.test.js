'use strict';
// Smoke: every top tab loads inside the window, and the buttons on PRESETS and CUES
// either send a request or change what is on screen. Hardware is the --mock server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
let pw = null;
try { pw = require('playwright'); } catch { /* optional until npm install */ }

const waitHttp = async (u) => {
  for (let i = 0; i < 150; i++) {
    try { await fetch(u); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
};

async function boot(t) {
  const port = 31000 + Math.floor(Math.random() * 2000);
  const base = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-smoke-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--port', String(port), '--host', '127.0.0.1', '--data', data], { stdio: 'ignore' });
  t.after(() => { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); });
  await waitHttp(`${base}/api/state`);
  const browser = await pw.chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.locator('#tabsTop').waitFor();
  return { page, errors, base };
}

function boxOk(box, label) {
  assert.ok(box, `${label} has no box`);
  assert.ok(box.y < 420, `${label} starts too low (${Math.round(box.y)}), the pane is outside the main area`);
  assert.ok(box.height > 500, `${label} is only ${Math.round(box.height)}px tall`);
  assert.ok(box.width > 800, `${label} is only ${Math.round(box.width)}px wide`);
}

test('every top tab loads and its pane fills the window', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const { page, errors } = await boot(t);
  const tabs = [
    ['system', '#pane-system', null],
    ['scopes', '#pane-scopes', null],
    ['cues', '#pane-cues', null],
    ['looks', '#pane-looks', null],
    ['decks', '#pane-decks', null],
  ];
  for (const [tab, pane] of tabs) {
    await page.click(`.tab[data-tab="${tab}"]`);
    await page.locator(pane).waitFor({ state: 'visible' });
    const box = await page.locator(pane).boundingBox();
    boxOk(box, tab);
    const inMain = await page.locator(pane).evaluate((el) => !!el.closest('main'));
    assert.equal(inMain, true, `${tab} pane is inside main`);
  }
  assert.deepEqual(errors, []);
});

test('each system page tab shows its pane', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const { page, errors, base } = await boot(t);
  for (const system of ['rs6', 'e2', 'atem', 'ptz', 'pixera', 'millumin']) {
    await fetch(base + '/api/sys/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system }) });
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.tgrp[data-tabgrp="rs6"]').waitFor({ state: 'visible' });
  const pages = [
    ['rs6', 'presets', '#pane-presets'],
    ['rs6', 'inputs', '#pane-inputs'],
    ['rs6', 'backup', '#pane-backup'],
    ['rs6', 'audio', '#pane-audio'],
    ['preset', 'xpresets', '#pane-xpresets'],
    ['atem', 'atem', '#pane-atem'],
    ['atem', 'amacros', '#pane-amacros'],
    ['ptz', 'pctl', '#pane-pctl'],
    ['pixera', 'pxplay', '#pane-pxplay'],
    ['millumin', 'mlcol', '#pane-mlcol'],
  ];
  for (const [grp, tab, pane] of pages) {
    const group = page.locator(`.tgrp[data-tabgrp="${grp}"]`);
    if (await group.count()) await group.click();
    await page.click(`.tab[data-tab="${tab}"]`);
    await page.locator(pane).waitFor({ state: 'visible' });
    const box = await page.locator(pane).boundingBox();
    assert.ok(box && box.height > 200, `${tab} pane is not visible`);
  }
  assert.deepEqual(errors, []);
});

test('PRESETS and CUES buttons send a request or change the page', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const { page, errors } = await boot(t);
  const hits = [];
  page.on('request', (r) => { if (r.url().includes('/api/')) hits.push(`${r.method()} ${new URL(r.url()).pathname}`); });

  await page.click('.tab[data-tab="looks"]');
  await page.locator('#pane-looks').waitFor({ state: 'visible' });
  const beforeAdd = hits.length;
  await page.click('#cueAdd');
  await page.waitForFunction(() => document.querySelectorAll('#cueList .cue-row').length > 0);
  assert.ok(hits.slice(beforeAdd).some((h) => h.startsWith('POST /api/cues')), 'ADD CUE posts /api/cues');

  const beforeGo = hits.length;
  await page.click('#cueGo');
  await page.waitForTimeout(200);
  assert.ok(hits.slice(beforeGo).some((h) => h.includes('/api/cues')), 'GO talks to the cue API');

  const beforeStop = hits.length;
  await page.click('#cueStop');
  await page.waitForTimeout(150);
  assert.ok(hits.slice(beforeStop).some((h) => h === 'POST /api/cues/stop'), 'STOP posts /api/cues/stop');

  const beforeBack = hits.length;
  await page.click('#cueBack');
  await page.waitForTimeout(150);
  assert.ok(hits.slice(beforeBack).some((h) => h === 'POST /api/cues/back'), 'BACK posts /api/cues/back');

  await page.click('.tab[data-tab="cues"]');
  await page.locator('#pane-cues').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#pane-cues [data-cue]').count(), 8);
  await page.locator('#mcSearch').click();
  for (const ch of 'walk') await page.keyboard.type(ch);
  const search = page.locator('#mcSearch');
  assert.equal(await search.inputValue(), 'walk');
  assert.equal(await search.evaluate((el) => el === document.activeElement), true, 'search keeps focus');

  const beforeMc = hits.length;
  await page.click('#mcGo');
  await page.waitForTimeout(200);
  assert.ok(hits.slice(beforeMc).some((h) => /POST \/api\/master-cues\/.+\/go/.test(h)), 'master GO posts');
  const beforeMcStop = hits.length;
  await page.click('#mcStop');
  await page.waitForTimeout(150);
  assert.ok(hits.slice(beforeMcStop).some((h) => h === 'POST /api/master-cues/stop'), 'master STOP posts');
  assert.deepEqual(errors, []);
});
