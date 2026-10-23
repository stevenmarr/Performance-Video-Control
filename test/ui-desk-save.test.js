'use strict';
// 0.11.0 SAVE on the switcher pages (server.js --mock on 127.0.0.1 only): ATEM SAVE saves the show and sends SRsv
// (startup state; unverified on hardware) unless unticked; E2 SAVE saves the show only; the API on its own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
let pw = null; try { pw = require('playwright'); } catch { /* optional */ }
const waitHttp = async (u) => { for (let i = 0; i < 150; i++) { try { await fetch(u); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } throw new Error('server did not start'); };
const until = async (fn, what) => { for (let i = 0; i < 80; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } throw new Error(`timed out: ${what}`); };

test('SAVE on switcher pages: show saved, ATEM startup state (SRsv) on request (Playwright + API)', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const port = 26000 + Math.floor(Math.random() * 1000); const B = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6dsave-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--port', String(port), '--host', '127.0.0.1', '--data', data], { stdio: 'ignore' });
  t.after(() => { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); });
  await waitHttp(`${B}/api/state`);
  const api = async (p, body) => { const r = await fetch(B + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}); return { status: r.status, json: await r.json() }; };
  // the API: e2 = show only; atem = show + SRsv; startup:false skips it
  let r = await api('/api/sys/e2/save', {}); assert.equal(r.status, 200); assert.equal(r.json.startup, false); assert.ok(r.json.show.id);
  await api('/api/sys/active', { system: 'atem' });
  r = await api('/api/sys/atem/save', { startup: false }); assert.equal(r.json.startup, false);
  const logHas = async (txt) => (await api('/api/log')).json.some((l) => String(l.msg || l.message || l).includes(txt));
  assert.equal(await logHas('startup state saved'), false);
  r = await api('/api/sys/atem/save', {}); assert.equal(r.json.startup, true, JSON.stringify(r.json)); assert.deepEqual(r.json.unverified, ['SRsv']);
  assert.ok(await logHas('ATEM: startup state saved (SRsv)'));
  // the UI
  const browser = await pw.chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(B + '/');
  await page.waitForFunction(() => document.body.classList.contains('kind-atem'), null, { timeout: 8000 });
  await page.click('.tab[data-tab=atem]');
  const before = (await api('/api/shows')).json;
  await page.click('#atemSave'); await page.locator('#dlgDeskSave[open]').waitFor();
  assert.ok(await page.locator('#dsStartupRow').isVisible(), 'ATEM: startup option offered');
  await page.click('#dsGo');
  await page.locator('.toast', { hasText: 'ATEM startup state saved' }).first().waitFor();
  await until(async () => (await api('/api/log')).json.filter((l) => String(l.msg || l.message || l).includes('startup state saved')).length >= 2, 'second SRsv from the UI');
  assert.ok(JSON.stringify((await api('/api/shows')).json).length >= JSON.stringify(before).length);
  assert.deepEqual(errors, []);
});
