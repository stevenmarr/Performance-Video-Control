#!/usr/bin/env node
'use strict';
// 0.12.0 scopes: measurements (dev tool). Needs Playwright (NODE_PATH) and the test clips from tools/scopes-testgen.js.
//   node tools/scopes-bench.js [testDir]   -> JSON on stdout
// 1. relay CPU: a bare relay process (no app) serving a file and the mock RTSP camera to N WebSocket viewers
// 2. browser: WebCodecs decode cost per frame (flat out), GL cost per scope pass (GPU-synced), and the live pipeline
//    (fps, relay->drawn latency, decode, draw) for 720p30 and 1080p59.94 at several analysis widths
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const pw = require('playwright');
const DIR = process.argv[2] || path.join(__dirname, '..', '..', 'scopes-test');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function relayCpu() {
  // child: relay server; parent: viewers (raw WebSocket, so the parent's CPU is not counted)
  const child = spawn(process.execPath, ['-e', `
    const http = require('http'); const { attachScopes } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'scopes', 'service.js'))});
    const s = http.createServer(); const fakeSys = { drivers: { ptz: { cams: new Map([['cam1', { conf: { name: 'c', host: '127.0.0.1' }, st: { series: 'UE150', data: {} } }]]) } } };
    const sc = attachScopes(s, { systems: fakeSys, dataDir: null, mock: true, testDir: ${JSON.stringify(DIR)} });
    s.listen(0, '127.0.0.1', () => process.send(s.address().port));`], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const port = await new Promise((r) => child.once('message', r));
  const crypto = require('crypto'); const socks = [];
  const view = (src) => new Promise((res) => { const req = http.get(`http://127.0.0.1:${port}/api/scopes/ws?src=${encodeURIComponent(src)}`, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' } }); req.on('upgrade', (r, sock) => { let n = 0; sock.on('data', (d) => { n += d.length; }); socks.push(sock); res(() => n); }); });
  const cpu = async (ms) => { const fs = require('fs'); const rd = () => { const f = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(') ')[1].split(' '); return Number(f[11]) + Number(f[12]); }; const a = rd(); await sleep(ms); return ((rd() - a) / 100 / (ms / 1000)) * 100; };
  const out = {};
  await sleep(500); out.idle = +(await cpu(3000)).toFixed(2);
  for (const [label, src, n] of [['file 1080p59.94 x1', 'test:bars1080.h264', 1], ['file 720p30 6 Mb/s x1', 'test:moving.h264', 1], ['mock RTSP camera 720p30 6 Mb/s x1', 'cam:cam1', 1], ['mock RTSP camera 720p30 6 Mb/s x4', 'cam:cam1', 4]]) {
    const counters = []; for (let i = 0; i < n; i++) counters.push(await view(src));
    await sleep(1500); const b0 = counters.map((c) => c()); const c = await cpu(5000); const b1 = counters.map((c) => c());
    out[label] = { cpuPercentOfOneCore: +c.toFixed(2), mbitPerViewer: +(((b1[0] - b0[0]) * 8) / 5 / 1e6).toFixed(2) };
    for (const s of socks.splice(0)) s.destroy(); await sleep(3500);
  }
  child.kill();
  return out;
}

async function browser() {
  const port = 32500; const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--port', String(port), '--host', '127.0.0.1', '--data', require('fs').mkdtempSync('/tmp/scb-')], { stdio: 'ignore', env: { ...process.env, RS6_SCOPES_TEST_DIR: DIR } });
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${port}/api/state`); break; } catch { await sleep(100); } }
  const b = await pw.chromium.launch(); const out = {};
  try {
    const page = await b.newPage({ viewport: { width: 1600, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/scopes.html?idle=1&test=1`);
    out.renderer = await page.evaluate(() => { const gl = window.__scopes.gl.gl; const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); });
    out.userAgent = await page.evaluate(() => navigator.userAgent);
    // 1. decode flat out
    for (const src of ['test:moving.h264', 'test:bars1080.h264']) {
      out[`decode ${src}`] = await page.evaluate((s) => new Promise((res) => {
        const ws = new WebSocket(`ws://${location.host}/api/scopes/ws?src=${s}`); ws.binaryType = 'arraybuffer'; let cfg; const aus = [];
        ws.onmessage = (e) => { if (typeof e.data === 'string') { const m = JSON.parse(e.data); if (m.type === 'config') cfg = m; return; } aus.push(e.data); };
        setTimeout(async () => {
          ws.close(); const t0 = performance.now(); let n = 0; let planesMs = 0; let buf = null;
          const d = new VideoDecoder({ output: async (f) => { n++; f.close(); }, error: () => {} });
          d.configure({ codec: cfg.codec, description: Uint8Array.from(atob(cfg.description), (c) => c.charCodeAt(0)), optimizeForLatency: true });
          let i = 0; for (const a of aus) { const k = new DataView(a).getUint8(1) & 1; if (!i && !k) continue; d.decode(new EncodedVideoChunk({ type: k ? 'key' : 'delta', timestamp: i++, data: new Uint8Array(a, 20) })); }
          await d.flush(); const ms = performance.now() - t0;
          // copyTo cost (planes to CPU memory: what "exact Y′" pays per frame)
          const d2 = new VideoDecoder({ output: async (f) => { const t = performance.now(); if (!buf) buf = new Uint8Array(f.allocationSize()); await f.copyTo(buf); planesMs += performance.now() - t; f.close(); }, error: () => {} });
          d2.configure({ codec: cfg.codec, description: Uint8Array.from(atob(cfg.description), (c) => c.charCodeAt(0)) });
          i = 0; for (const a of aus.slice(0, 60)) { const k = new DataView(a).getUint8(1) & 1; if (!i && !k) continue; d2.decode(new EncodedVideoChunk({ type: k ? 'key' : 'delta', timestamp: i++, data: new Uint8Array(a, 20) })); }
          await d2.flush();
          res({ frames: n, size: `${cfg.width}x${cfg.height}`, msPerFrame: +(ms / n).toFixed(2), copyToMsPerFrame: +(planesMs / Math.min(60, i)).toFixed(2) });
        }, 3000);
      }), src);
    }
    // 2. GL cost per pass (1-pixel readback after each render forces the GPU to finish)
    await page.goto(`http://127.0.0.1:${port}/scopes.html?src=test:moving.h264&test=1&aw=640`);
    await page.waitForFunction(() => window.__scopes.stats.drawn > 3, null, { timeout: 20000 });
    out.passes = await page.evaluate(() => {
      const S = window.__scopes; S.stop(true); const G = S.gl; const R = S.rects(); const o = {};
      const time = (panels, n = 8) => { G.render(panels, 0); G.sync(); const t0 = performance.now(); for (let i = 0; i < n; i++) { G.render(panels, 0); G.sync(); } return +((performance.now() - t0) / n).toFixed(2); };
      for (const aw of [640, 320, 160]) { G.maxAW = aw; const k = G.analysisSize.join('x'); o[k] = { all: time(R), picture: time({ pic: R.pic }), waveform: time({ wfm: R.wfm }), parade: time({ parade: R.parade }), vectorscope: time({ vec: R.vec }), analyzeOnly: time({}) }; }
      return o;
    });
    // 3. live pipeline, 10 s each
    for (const [src, aw] of [['test:moving.h264', 640], ['test:moving.h264', 160], ['test:bars1080.h264', 160], ['cam:cam1', 160]]) {
      await page.goto(`http://127.0.0.1:${port}/scopes.html?src=${src}&aw=${aw}&bench=1`);
      await sleep(4000); await page.evaluate(() => { const s = window.__scopes.stats; s.latMs.length = 0; s.decodeMs.length = 0; s.drawMs.length = 0; s.d0 = s.drawn; s.t0 = performance.now(); });
      await sleep(10000);
      out[`live ${src} aw=${aw}`] = await page.evaluate(() => { const s = window.__scopes.stats; const a = (x) => +(x.reduce((p, q) => p + q, 0) / Math.max(1, x.length)).toFixed(1); const sorted = s.latMs.slice().sort((p, q) => p - q); return { fps: +(((s.drawn - s.d0) * 1000) / (performance.now() - s.t0)).toFixed(1), latencyMs: a(s.latMs), latencyP90: sorted[Math.floor(sorted.length * 0.9)], decodeMs: a(s.decodeMs), drawMs: a(s.drawMs), skipped: s.skipped, catchups: s.catchups }; });
    }
  } finally { await b.close(); srv.kill(); }
  return out;
}

(async () => { const r = { relay: await relayCpu(), browser: await browser(), host: { cpus: require('os').cpus().length, model: require('os').cpus()[0].model } }; console.log(JSON.stringify(r, null, 2)); })().catch((e) => { console.error(e); process.exit(1); });
