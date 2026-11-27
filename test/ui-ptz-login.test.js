'use strict';
// CAMERAS → LOGIN: the --mock UE150 uses the shared vault (no factory password). A wrong per-camera
// login is refused; USE SHARED ADMIN goes back to the vault. The password never comes back from the server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { openTab } = require('./ui-helpers');
let pw = null; try { pw = require('playwright'); } catch { /* optional */ }
const waitHttp = async (u) => { for (let i = 0; i < 150; i++) { try { await fetch(u); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } throw new Error('server did not start'); };

test('PTZ camera LOGIN dialog — vault login, changed login refused by the mock, back to vault (Playwright)', { skip: pw ? false : 'playwright not installed' }, async (t) => {
  const port = 32000 + Math.floor(Math.random() * 900); const B = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6login-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--port', String(port), '--host', '127.0.0.1', '--data', data], { stdio: 'ignore' });
  t.after(() => { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); });
  await waitHttp(`${B}/api/state`);
  await fetch(`${B}/api/sys/active`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system: 'ptz' }) });
  const cam = async (id) => ((await (await fetch(`${B}/api/sys/ptz`)).json()).cameras || []).find((c) => c.id === id);
  const browser = await pw.chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(B); await openTab(page, 'pcams');
  const row = page.locator('.cam-line[data-cam=cam1]');
  await row.locator('.chip.login').waitFor();
  await page.waitForFunction(() => /LOGIN .+ · VAULT/.test(document.querySelector('.cam-line[data-cam=cam1] .chip.login').textContent));
  const c1 = await cam('cam1'); assert.equal(c1.connected, true, 'vault login answers the Digest challenge'); assert.equal(c1.authScheme, 'digest'); assert.equal(c1.loginSource, 'vault');
  assert.equal((await cam('cam3')).authScheme, null, 'an open camera gets no credentials');
  const pw1 = `t-${crypto.randomBytes(5).toString('hex')}`;
  await row.locator('[data-login=cam1]').click();
  assert.equal(await page.locator('#dlgPtzLogin').isVisible(), true);
  assert.equal(await page.inputValue('#formPtzLogin [name=pass]'), '');
  await page.fill('#formPtzLogin [name=pass]', pw1); await page.click('#formPtzLogin button[value=save]');
  for (let i = 0; i < 80 && !(await cam('cam1')).authError; i++) await new Promise((r) => setTimeout(r, 100));
  const c2 = await cam('cam1'); assert.equal(c2.authError, true); assert.equal(c2.passSet, true); assert.equal('pass' in c2, false);
  await page.waitForFunction(() => /LOGIN REFUSED/.test(document.querySelector('.cam-line[data-cam=cam1] .chip.login').textContent), null, { timeout: 8000 });
  for (const u of ['/api/sys/ptz', '/api/state', '/api/sys/ptz/cameras/cam1/status', '/api/sys/ptz/provision/vault']) assert.equal((await (await fetch(B + u)).text()).includes(pw1), false, `${u} never carries the password`);
  await row.locator('[data-login=cam1]').click(); await page.click('#formPtzLogin button[value=clear]');
  for (let i = 0; i < 80 && !(await cam('cam1')).connected; i++) await new Promise((r) => setTimeout(r, 100));
  const c3 = await cam('cam1'); assert.equal(c3.connected, true); assert.equal(c3.loginSource, 'vault'); assert.equal(c3.passSet, true);
  await page.waitForFunction(() => /LOGIN .+ · VAULT/.test(document.querySelector('.cam-line[data-cam=cam1] .chip.login').textContent), null, { timeout: 8000 });
  assert.deepEqual(errors, []);
});
