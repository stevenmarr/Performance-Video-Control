#!/usr/bin/env node
'use strict';
// 0.12.0 scopes: screenshots for review (dev tool; Playwright via NODE_PATH). node tools/scopes-shots.js [outDir] [testDir]
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const pw = require('playwright');
const OUT = process.argv[2] || '/workspace/rs6/multi';
const DIR = process.argv[3] || path.join(__dirname, '..', '..', 'scopes-test');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const port = 32600; const data = fs.mkdtempSync('/tmp/scs-');
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--port', String(port), '--host', '127.0.0.1', '--data', data], { stdio: 'ignore', env: { ...process.env, RS6_SCOPES_TEST_DIR: DIR } });
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${port}/api/state`); break; } catch { await sleep(100); } }
  const b = await pw.chromium.launch({ args: ['--host-resolver-rules=MAP scopes.test 127.0.0.1'] });
  const shot = async (name, q, { w = 1600, h = 900, wait = 2500, host = '127.0.0.1', still = true } = {}) => {
    const p = await b.newPage({ viewport: { width: w, height: h } });
    await p.goto(`http://${host}:${port}/scopes.html?test=1&aw=640&${q}`);
    await p.waitForFunction(() => window.__scopes && window.__scopes.stats.drawn > 2, null, { timeout: 30000 });
    await sleep(wait);
    if (still) await p.evaluate(() => { window.__scopes.stop(true); window.__scopes.render(); });
    await p.screenshot({ path: path.join(OUT, `90-scopes-${name}.png`) }); await p.close(); console.log(`90-scopes-${name}.png`);
  };
  await shot('waveform-bars', 'src=test:bars.h264&show=pic,wfm&view=0');
  await shot('parade-ramps', 'src=test:ramps.h264&show=pic,parade&view=0');
  await shot('vectorscope-ramps', 'src=test:ramps.h264&show=pic,vec&view=0');
  await shot('falsecolor-bars', 'src=test:bars.h264&show=pic,wfm&view=1');
  await shot('falsecolor-ramps', 'src=test:ramps.h264&show=pic,wfm&view=1');
  await shot('falsecolor-moving', 'src=test:moving.h264&show=pic,wfm&view=1', { wait: 3200 });
  await shot('side-by-side-moving', 'src=test:moving.h264&show=pic,wfm,parade,vec&view=0', { wait: 3500 });
  await shot('side-by-side-camera-rtsp', 'src=cam:cam1&show=pic,wfm,parade,vec&view=1', { wait: 3000 });
  await shot('zebra-moving', 'src=test:moving.h264&show=pic,wfm&view=2', { wait: 3000 });
  await shot('ipad-portrait', 'src=test:ramps.h264&show=pic,wfm,parade,vec&view=1', { w: 820, h: 1180 });
  await shot('mse-fallback-plain-http', 'src=test:bars.h264&show=pic,wfm,parade,vec', { host: 'scopes.test', still: false });
  // the SCOPES tab in the PTZ group
  await fetch(`http://127.0.0.1:${port}/api/sys/active`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system: 'ptz' }) });
  const p = await b.newPage({ viewport: { width: 1600, height: 1000 } }); await p.goto(`http://127.0.0.1:${port}/#pctl`); await sleep(800);
  await p.evaluate(() => { localStorage.setItem('cc.scopes.src', 'cam:cam1'); localStorage.setItem('cc.scopes.aw', '640'); });
  await p.click('.tab[data-tab=pscopes]'); await sleep(5000); await p.screenshot({ path: path.join(OUT, '90-scopes-ptz-tab.png') }); console.log('90-scopes-ptz-tab.png');
  await b.close(); srv.kill(); fs.rmSync(data, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
