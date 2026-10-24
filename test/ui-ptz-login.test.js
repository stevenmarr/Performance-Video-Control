'use strict';
// 0.11.1 CAMERAS → LOGIN: the UE150 factory login (admin / 12345) by default; a changed login is sent on the camera's
// Digest challenge (the --mock UE150 asks for one), refused logins are shown, FACTORY DEFAULT goes back. The password
// never comes back from the server. Mock cameras only.
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

test('PTZ 0.11.1: camera LOGIN dialog — factory default, changed login refused by the mock, back to factory (Playwright)', { skip: pw ? false : 'playwright not installed' }, async (t) => {
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
  await page.waitForFunction(() => /LOGIN admin · FACTORY/.test(document.querySelector('.cam-line[data-cam=cam1] .chip.login').textContent));
  const c1 = await cam('cam1'); assert.equal(c1.connected, true, 'factory login answers the Digest challenge'); assert.equal(c1.authScheme, 'digest'); assert.equal(c1.loginDefault, true);
  assert.equal((await cam('cam3')).authScheme, null, 'an open camera gets no credentials');
  // set a made-up password: the mock still wants 12345, so the camera refuses it
  const pw1 = `t-${crypto.randomBytes(5).toString('hex')}`;
  await row.locator('[data-login=cam1]').click();
  assert.equal(await page.locator('#dlgPtzLogin').isVisible(), true);
  assert.equal(await page.inputValue('#formPtzLogin [name=user]'), 'admin'); assert.equal(await page.inputValue('#formPtzLogin [name=pass]'), '');
  await page.fill('#formPtzLogin [name=pass]', pw1); await page.click('#formPtzLogin button[value=save]');
  for (let i = 0; i < 80 && !(await cam('cam1')).authError; i++) await new Promise((r) => setTimeout(r, 100));
  const c2 = await cam('cam1'); assert.equal(c2.authError, true); assert.equal(c2.passSet, true); assert.equal('pass' in c2, false);
  await page.waitForFunction(() => /LOGIN REFUSED/.test(document.querySelector('.cam-line[data-cam=cam1] .chip.login').textContent), null, { timeout: 8000 });
  for (const u of ['/api/sys/ptz', '/api/state', '/api/sys/ptz/cameras/cam1/status']) assert.equal((await (await fetch(B + u)).text()).includes(pw1), false, `${u} never carries the password`);
  // back to the factory default
  await row.locator('[data-login=cam1]').click(); await page.click('#formPtzLogin button[value=factory]');
  for (let i = 0; i < 80 && !(await cam('cam1')).connected; i++) await new Promise((r) => setTimeout(r, 100));
  const c3 = await cam('cam1'); assert.equal(c3.connected, true); assert.equal(c3.loginDefault, true); assert.equal(c3.passSet, false);
  await page.waitForFunction(() => /LOGIN admin · FACTORY/.test(document.querySelector('.cam-line[data-cam=cam1] .chip.login').textContent), null, { timeout: 8000 });
  assert.deepEqual(errors, []);
});
