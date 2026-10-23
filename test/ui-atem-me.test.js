'use strict';
// 0.11.0 ATEM every M/E (Playwright, server.js --mock on 127.0.0.1 only): a 2 M/E and a 4 M/E model expose every M/E on
// SWITCHER (selector + ALL M/Es side by side) and DVE / SS / KEYS, and the selected M/E is the one the bus, CUT and
// AUTO drive. The M/E choice is shared by both tabs and kept per browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
let pw = null; try { pw = require('playwright'); } catch { /* optional */ }
const waitHttp = async (u) => { for (let i = 0; i < 150; i++) { try { await fetch(u); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } throw new Error('server did not start'); };

async function boot(t, model) {
  const port = 23000 + Math.floor(Math.random() * 1000); const B = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6atemme-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--atem-model', model, '--port', String(port), '--host', '127.0.0.1', '--data', data], { stdio: 'ignore' });
  t.after(() => { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); });
  await waitHttp(`${B}/api/state`);
  const api = async (p, body) => (await fetch(B + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
  await api('/api/sys/active', { system: 'atem' });
  const browser = await pw.chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(B + '/#atem');
  await page.waitForFunction(() => document.body.classList.contains('kind-atem'), null, { timeout: 8000 });
  await page.locator('#atemPgm [data-pgm]').first().waitFor();
  return { B, api, page, errors };
}
const until = async (fn, what) => { for (let i = 0; i < 80; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } throw new Error(`timed out: ${what}`); };

for (const [model, n] of [['chd2me', 2], ['c4k4me', 4]]) {
  test(`ATEM 0.11.0: ${n} M/E model (${model}) — every M/E on SWITCHER and KEYS, selector drives bus + CUT / AUTO (Playwright)`, { skip: pw ? false : 'playwright not installed' }, async (t) => {
    const { api, page, errors } = await boot(t, model);
    const v0 = await api('/api/sys/atem');
    assert.equal(v0.mes.length, n, 'the view carries every M/E');
    assert.equal(await page.locator('#atemMe [data-ame]').count(), n, 'one selector button per M/E');
    await page.locator('#atemMe [data-ameall]').waitFor();
    // pick the last M/E: its bus is shown and preview + CUT go to it, not M/E 1
    const last = n - 1;
    await page.click(`#atemMe [data-ame="${last}"]`);
    await page.locator(`#atemMe [data-ame="${last}"].active`).waitFor();
    assert.match(await page.locator('#atemPgmLbl').innerText(), new RegExp(`M/E ${n}`));
    const before = (await api('/api/sys/atem')).mes[0].program;
    const src = v0.mes[last].bus.find((i) => !i.pgm && !i.pvw && i.id >= 1 && i.id < 1000).id;
    await page.click(`#atemPvw [data-pvw="${src}"]`);
    await until(async () => (await api('/api/sys/atem')).mes[last].preview === src, 'preview on the chosen M/E');
    await page.click('#atemCut');
    await until(async () => (await api('/api/sys/atem')).mes[last].program === src, 'CUT on the chosen M/E');
    assert.equal((await api('/api/sys/atem')).mes[0].program, before, 'M/E 1 untouched');
    assert.match(await page.locator('#atemCut').innerText(), new RegExp(`M/E ${n}`), 'the transport says which M/E it drives');
    // ALL M/Es: one block per M/E, each with its own bus and AUTO
    await page.click('#atemMe [data-ameall]');
    await page.locator('#atemMulti .me-block').first().waitFor();
    assert.equal(await page.locator('#atemMulti .me-block').count(), n);
    assert.equal(await page.locator('#atemSingle').isVisible(), false);
    const b1 = page.locator('#atemMulti .me-block[data-meblock="1"]');
    const s1 = v0.mes[1].bus.find((i) => !i.pvw && !i.pgm && i.id >= 1 && i.id < 1000 && i.id !== src).id;
    await b1.locator(`[data-pvw="${s1}"]`).click();
    await until(async () => (await api('/api/sys/atem')).mes[1].preview === s1, 'preview from the M/E 2 block');
    await b1.locator('[data-meauto="1"]').click();
    await until(async () => (await api('/api/sys/atem')).mes[1].program === s1, 'AUTO from the M/E 2 block');
    if (n >= 2) { const boxes = await page.$$eval('#atemMulti .me-block', (els) => els.map((e) => e.getBoundingClientRect().left)); assert.ok(new Set(boxes.map(Math.round)).size >= 2, '1920 px: side by side'); }
    // KEYS: the same M/E selection, every M/E reachable
    await page.click('#atemMe [data-ame="1"]');
    await page.click('.tab[data-tab=akeys]');
    await page.locator('#akMe [data-akme="1"].active').waitFor();
    assert.equal(await page.locator('#akMe [data-akme]').count(), n);
    await page.click(`#akMe [data-akme="${last}"]`);
    await page.locator('[data-uskon="0"]').first().click();
    await until(async () => (await api('/api/sys/atem')).mixEffects[last].keyers[0].onAir === true, `key 1 on air on M/E ${n}`);
    await page.click('.tab[data-tab=atem]');
    await page.locator(`#atemMe [data-ame="${last}"].active`).waitFor();
    // kept per browser
    await page.reload(); await page.locator(`#atemMe [data-ame="${last}"].active`).waitFor({ timeout: 8000 });
    assert.deepEqual(errors, []);
  });
}
