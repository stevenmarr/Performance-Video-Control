'use strict';
// 0.11.0 auto recall UI (Playwright, server.js --mock on 127.0.0.1 only): RS6 edit dialog + defaults dialog; E2
// ↪ AUTO RECALL mode → per-preset follow-up, the ↪ chip on the tile, and TAKE → the follow-up lands on Preview.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
let pw = null; try { pw = require('playwright'); } catch { /* optional */ }
const waitHttp = async (u) => { for (let i = 0; i < 150; i++) { try { await fetch(u); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } throw new Error('server did not start'); };
const until = async (fn, what) => { for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } throw new Error(`timed out: ${what}`); };

test('auto recall UI: RS6 edit + defaults, E2 AUTO RECALL mode, chip, TAKE → follow-up on Preview (Playwright)', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const port = 27000 + Math.floor(Math.random() * 1000); const B = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6fuui-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--port', String(port), '--host', '127.0.0.1', '--data', data], { stdio: 'ignore' });
  t.after(() => { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); });
  await waitHttp(`${B}/api/state`);
  const api = async (p, body, method = 'POST') => (await fetch(B + p, body !== undefined ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
  await api('/api/presets', { number: 1, name: 'Open', destinations: ['S1'], memories: { S1: 1 } });
  await api('/api/presets', { number: 2, name: 'Keynote', destinations: ['S1'], memories: { S1: 2 } });
  const browser = await pw.chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(B + '/');
  await page.click('.tab[data-tab=presets]');
  await page.locator('#grid .preset[data-preset="1"]').waitFor();
  // RS6: edit preset 1 → follow-up 2
  await page.click('[data-mode=edit]'); await page.click('#grid .preset[data-preset="1"]');
  await page.locator('#dlgEdit[open]').waitFor();
  assert.equal(await page.inputValue('#editFollowUp'), '__inherit'); assert.equal(await page.inputValue('#editFollowState'), 'inherit');
  await page.selectOption('#editFollowUp', '2'); await page.click('#dlgEdit button[value=save]');
  await until(async () => (await api('/api/state')).presets.find((p) => p.number === 1).followUp?.target === 2, 'RS6 preset 1 → 2');
  await page.locator('#grid .preset[data-preset="1"] .chip.fu', { hasText: '↪ 2' }).waitFor();
  // RS6 defaults dialog
  await page.locator('#bailBadge', { hasText: 'default' }).waitFor();
  await page.click('#bailBadge'); await page.locator('#dlgFollowUp[open]').waitFor();
  assert.equal(await page.locator('#fuPresetRow').isVisible(), false); assert.ok(await page.isChecked('#fuEnabled'), 'universal switch ON by default');
  await page.selectOption('#fuDefault', '1'); await page.fill('#fuDelay', '400');
  await page.click('#fuAddGroup'); await page.fill('[data-gname="0"]', 'Keynotes'); await page.selectOption('[data-gpresets="0"]', ['3']); await page.selectOption('[data-gtarget="0"]', '2');
  await page.click('#fuSave');
  await until(async () => { const f = (await api('/api/state')).followUp; return f.default === 1 && f.delayMs === 400 && f.groups[0] && f.groups[0].name === 'Keynotes' && f.groups[0].target === 2; }, 'RS6 default 1, 400 ms, group');
  await page.locator('#grid .preset[data-preset="2"] .chip.fu.src-default', { hasText: '↪ 1' }).waitFor();
  await page.locator('#grid .preset[data-preset="3"] .chip.fu.src-group', { hasText: '↪ 2' }).waitFor();
  // universal switch OFF clears every chip and the badge says so
  await page.click('#bailBadge'); await page.uncheck('#fuEnabled'); await page.click('#fuSave');
  await page.locator('#bailBadge', { hasText: 'OFF' }).waitFor();
  assert.equal(await page.locator('#grid .chip.fu').count(), 0);
  await page.click('#bailBadge'); await page.check('#fuEnabled'); await page.click('#fuSave');
  await page.locator('#grid .preset[data-preset="1"] .chip.fu').waitFor();
  // E2
  await api('/api/sys/active', { system: 'e2' });
  await until(async () => (await api('/api/sys/e2')).presets.length > 3, 'E2 mock presets');
  await api('/api/sys/e2/selection', { destinations: ['S2', 'S3'] });
  await page.click('.tab[data-tab=xpresets]');
  await page.locator('#xgrid .preset[data-key="e2:2"]').waitFor();
  await page.click('[data-xmode=follow]'); await page.click('#xgrid .preset[data-key="e2:2"]');
  await page.locator('#dlgFollowUp[open]').waitFor();
  assert.ok(await page.locator('#fuPresetRow').isVisible());
  assert.equal(await page.locator('#fuPTarget option[value="e2:2"]').count(), 0, 'a preset cannot follow itself');
  await page.selectOption('#fuPTarget', 'e2:3'); await page.fill('#fuDelay', '50'); await page.click('#fuSave');
  await page.locator('#xgrid .preset[data-key="e2:2"] .chip.fu').waitFor();
  assert.deepEqual((await api('/api/sys/e2')).presets.find((p) => p.key === 'e2:2').followUp, { target: 'e2:3' });
  await page.click('[data-xmode=recall]'); await page.click('#xgrid .preset[data-key="e2:2"]');
  await until(async () => (await api('/api/sys/e2')).destinations.find((d) => d.key === 'S2').pvwPreset?.key === 'e2:2', 'IMAG on PVW');
  await page.locator('#xBail', { hasText: 'after TAKE' }).waitFor(); assert.match(await page.locator('#xBail').textContent(), /Panel/, 'badge names the active bail target');
  await page.click('#xTake');
  await until(async () => (await api('/api/sys/e2')).destinations.find((d) => d.key === 'S2').pvwPreset?.key === 'e2:3', 'follow-up on PVW after TAKE');
  await page.locator('#xgrid .preset[data-key="e2:3"] .tag.pvw').first().waitFor();
  assert.deepEqual(errors, []);
});
