'use strict';
// 0.11.0 ATEM AUDIO monitor area (Playwright, server.js --mock on 127.0.0.1 only): drag a channel into MONITOR, watch
// its level / mute, the list survives a reload (per install, /api/ui-prefs), MUTE ALL / UN-MUTE ALL, DESK ZERO behind
// its confirmation (cancel changes nothing).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
let pw = null; try { pw = require('playwright'); } catch { /* optional */ }
const waitHttp = async (u) => { for (let i = 0; i < 150; i++) { try { await fetch(u); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } throw new Error('server did not start'); };
const until = async (fn, what) => { for (let i = 0; i < 80; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } throw new Error(`timed out: ${what}`); };

test('ATEM 0.11.0 AUDIO: MONITOR drag + persistence, MUTE ALL, DESK ZERO confirmation (Playwright)', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const port = 25000 + Math.floor(Math.random() * 1000); const B = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6auwatch-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--port', String(port), '--host', '127.0.0.1', '--data', data], { stdio: 'ignore' });
  t.after(() => { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); });
  await waitHttp(`${B}/api/state`);
  const api = async (p, body) => (await fetch(B + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
  await api('/api/sys/active', { system: 'atem' });
  const au = async (id) => (await api('/api/sys/atem')).audio.inputs.find((x) => x.id === id);
  const browser = await pw.chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(B + '/');
  await page.waitForFunction(() => document.body.classList.contains('kind-atem'), null, { timeout: 8000 });
  await page.click('.tab[data-tab=aaudio]');
  await page.locator('.au-strip[data-in="1"] .au-name').waitFor();
  await page.locator('#auWatchList .au-wempty').waitFor();
  // drag input 1's name into MONITOR
  const a = await page.locator('.au-strip[data-in="1"] .au-name').boundingBox(); const w = await page.locator('#auWatch').boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(w.x + w.width / 2, w.y + w.height / 2, { steps: 10 });
  assert.equal(await page.locator('#auWatch.drop-ready').count(), 1, 'MONITOR highlights while dragging');
  await page.mouse.up();
  await page.locator('#auWatchList .au-wcard[data-win="1"]').waitFor();
  // 👁 adds a second channel; drag it in front of the first (reorder)
  await page.click('.au-strip[data-in="2"] [data-auwatch="2"]');
  await page.locator('#auWatchList .au-wcard[data-win="2"]').waitFor();
  const h2 = await page.locator('.au-wcard[data-win="2"] .au-whead b').boundingBox(); const c1 = await page.locator('.au-wcard[data-win="1"]').boundingBox();
  await page.mouse.move(h2.x + 10, h2.y + 5); await page.mouse.down(); await page.mouse.move(c1.x + 20, c1.y + 20, { steps: 8 }); await page.mouse.up();
  await until(async () => (await page.$$eval('#auWatchList .au-wcard', (els) => els.map((e) => e.dataset.win).join(','))) === '2,1', 'reordered');
  assert.deepEqual((await api('/api/ui-prefs')).prefs['atem.audioWatch'], [2, 1], 'kept per install on the server');
  // level and mute in the monitor card
  await api('/api/sys/atem/cmd/audioInput', { input: 1, fader: -20 });
  await page.locator('.au-wcard[data-win="1"] .au-wvals b', { hasText: '-20.0' }).waitFor();
  await page.click('.au-wcard[data-win="1"] [data-wmute="1"]');
  await until(async () => (await au(1)).muted, 'muted from the monitor card');
  await page.locator('.au-wcard.muted[data-win="1"]').waitFor();
  // a fresh browser (another device on this install) sees the same monitor list
  const p2 = await browser.newPage({ viewport: { width: 1920, height: 1080 } }); await p2.goto(B + '/');
  await p2.waitForFunction(() => document.body.classList.contains('kind-atem'), null, { timeout: 8000 }); await p2.click('.tab[data-tab=aaudio]');
  await until(async () => (await p2.$$eval('#auWatchList .au-wcard', (els) => els.map((e) => e.dataset.win).join(','))) === '2,1', 'same list in a new browser');
  await p2.close();
  // MUTE ALL / UN-MUTE ALL
  await page.click('#auMuteAll');
  await until(async () => (await api('/api/sys/atem')).audio.inputs.every((x) => x.muted), 'every input muted');
  await page.click('#auUnmuteAll');
  await until(async () => !(await au(2)).muted, 'un-mute puts back what MUTE ALL took off');
  assert.equal((await au(1)).muted, true, 'input 1 was muted before MUTE ALL, so it stays muted');
  // DESK ZERO: cancel does nothing, confirm resets
  await page.click('#auDeskZero'); await page.locator('#dlgDeskZero[open]').waitFor();
  await page.click('#dlgDeskZero button[value=cancel]');
  await new Promise((r) => setTimeout(r, 300)); assert.equal((await au(1)).fader, -20, 'cancel leaves the levels');
  await page.click('#auDeskZero'); await page.click('#dzGo');
  await until(async () => (await au(1)).fader === 0, 'DESK ZERO → fader 0 dB');
  assert.equal((await fetch(`${B}/api/sys/atem/cmd/audioDeskZero`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400, 'the API needs confirm: true');
  assert.deepEqual(errors, []);
});
