#!/usr/bin/env node
'use strict';
// 0.13.0-dev Lightning tab screenshots → /workspace/rs6/multi/96-lightning-*.png
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const pw = require('playwright');
const OUT = process.argv[2] || '/workspace/rs6/multi';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const port = 32610; const data = fs.mkdtempSync('/tmp/ltn-');
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--port', String(port), '--host', '127.0.0.1', '--data', data], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${port}/api/state`); break; } catch { await sleep(100); } }
  const B = `http://127.0.0.1:${port}`;
  await fetch(`${B}/api/sys/active`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system: 'ptz' }) });
  await fetch(`${B}/api/sys/active`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system: 'atem' }) });
  // seed a TSL map for the SYSTEMS tallies panel
  await fetch(`${B}/api/tsl`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    enabled: true, transport: 'mock', host: '127.0.0.1', port: 8900,
    addresses: [
      { index: 1, label: 'CAM 1', sources: [{ system: 'atem', input: 1 }, { system: 'ptz', cameraId: 'cam1' }] },
      { index: 2, label: 'CAM 2', sources: [{ system: 'atem', input: 2 }, { system: 'ptz', cameraId: 'cam2' }] },
    ],
  }) });
  const b = await pw.chromium.launch();
  const shot = async (name, fn) => {
    const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
    await fn(p);
    await p.screenshot({ path: path.join(OUT, `96-lightning-${name}.png`) });
    console.log(`96-lightning-${name}.png`);
    await p.close();
  };
  await shot('tab-scopes', async (p) => {
    await p.goto(B + '/'); await sleep(600);
    await p.evaluate(() => { localStorage.setItem('cc.scopes.src', 'cam:cam1'); localStorage.setItem('cc.scopes.aw', '640'); });
    await p.click('.tgrp[data-tabgrp=lightning]'); await sleep(500);
    await p.click('.tab[data-tab=lightning]');
    const fr = p.frame({ url: /scopes\.html/ });
    if (fr) { try { await fr.waitForFunction(() => window.__scopes && window.__scopes.stats.drawn > 2, null, { timeout: 20000 }); await sleep(1500); await fr.evaluate(() => { window.__scopes.stop(true); window.__scopes.render(); }); } catch { await sleep(2500); } }
    else await sleep(4000);
  });
  await shot('ndi-help', async (p) => {
    await p.goto(B + '/#lightning'); await sleep(800);
    await p.click('#btnLightningNdi'); await sleep(400);
  });
  await shot('standalone', async (p) => {
    await p.goto(`${B}/lightning.html?test=1&aw=640&src=cam:cam1`);
    try { await p.waitForFunction(() => window.__scopes && window.__scopes.stats.drawn > 2, null, { timeout: 20000 }); await sleep(1200); await p.evaluate(() => { window.__scopes.stop(true); window.__scopes.render(); }); } catch { await sleep(2500); }
    await p.click('#btnNdi'); await sleep(300);
  });
  await shot('tsl-tallies', async (p) => {
    await p.goto(B + '/#system'); await sleep(800);
    await p.click('[data-sysview=tallies]'); await sleep(300);
    await sleep(400);
  });
  await shot('ptz-scopes-shortcut', async (p) => {
    await p.goto(B + '/#pctl'); await sleep(600);
    await p.evaluate(() => localStorage.setItem('cc.scopes.src', 'cam:cam1'));
    await p.click('.tgrp[data-tabgrp=ptz]'); await p.click('.tab[data-tab=pscopes]'); await sleep(3500);
  });
  await b.close(); srv.kill(); fs.rmSync(data, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
