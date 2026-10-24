'use strict';
// 0.12.0 video scopes in headless Chromium (Playwright): the H.264 test stream through the relay, decoded by WebCodecs,
// drawn by WebGL2; pixels read back from the scope targets and the false-colour picture. Plus the exact GL maths on a
// raw I420 frame with known code values, the MSE fallback on a non-secure origin, and the SCOPES tab in the PTZ group.
// Headless Chromium here decodes H.264 in WebCodecs (software) on http://127.0.0.1 (a secure context); if a build
// cannot, the WebCodecs parts are skipped and the raw-frame part still checks the GL maths.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
let pw = null; try { pw = require('playwright'); } catch { /* optional */ }
const { rampsFrame, WEDGE } = require('../tools/scopes-testgen');
const SM = require('../public/scopes-gl.js');
const { openTab } = require('./ui-helpers');
const waitHttp = async (u) => { for (let i = 0; i < 150; i++) { try { await fetch(u); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } throw new Error('server did not start'); };
const bandOf = (rgb) => { // picture pixel -> false-colour band name (or GREY)
  for (const b of SM.FALSE_COLOR) { const e = b.rgb.map((v) => Math.round(v * 255)); if (e.every((v, i) => Math.abs(v - rgb[i]) <= 6)) return b.name; }
  return Math.max(...rgb) - Math.min(...rgb) <= 6 ? 'GREY' : `?${rgb.join(',')}`;
};

test('SCOPES (Playwright): H.264 -> relay -> WebCodecs -> WebGL2 waveform / parade / vectorscope / false colour; raw-frame GL maths; MSE fallback; PTZ tab', { skip: pw ? false : 'playwright not installed', timeout: 120000 }, async (t) => {
  const port = 31000 + Math.floor(Math.random() * 1000); const B = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6scopes-ui-'));
  // optional HTTPS mirror (RS6_TLS_*) with a throw-away self-signed certificate, when openssl is on the machine
  const tlsPort = port + 1000; let tlsEnv = {};
  try { require('child_process').execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(data, 'k.pem'), '-out', path.join(data, 'c.pem'), '-days', '1', '-subj', '/CN=scopes.test'], { stdio: 'ignore' }); tlsEnv = { RS6_TLS_CERT: path.join(data, 'c.pem'), RS6_TLS_KEY: path.join(data, 'k.pem'), RS6_TLS_PORT: String(tlsPort) }; } catch { /* no openssl: that sub-test is skipped */ }
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock', '--port', String(port), '--host', '127.0.0.1', '--data', data], { stdio: 'ignore', env: { ...process.env, ...tlsEnv, HOST: '127.0.0.1', RS6_SCOPES_TEST_DIR: path.join(__dirname, 'fixtures', 'scopes') } });
  t.after(() => { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); });
  await waitHttp(`${B}/api/state`);
  const browser = await pw.chromium.launch({ args: ['--host-resolver-rules=MAP scopes.test 127.0.0.1'] }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const open = async (q) => { await page.goto(`${B}/scopes.html?test=1&aw=320&${q}`); await page.waitForFunction(() => window.__scopes && window.__scopes.gl, null, { timeout: 10000 }); };
  await open('idle=1');
  const wc = await page.evaluate(async () => (typeof VideoDecoder === 'function' ? (await VideoDecoder.isConfigSupported({ codec: 'avc1.64001f', codedWidth: 1280, codedHeight: 720 })).supported : false));

  await t.test('decoded bars: waveform non-empty, 40 % grey at 40 %, false colour of known bar levels', { skip: wc ? false : 'this Chromium build has no WebCodecs H.264 decoder' }, async () => {
    await open('src=builtin:bars.h264');
    await page.waitForFunction(() => window.__scopes.stats.drawn >= 5, null, { timeout: 20000 });
    const s = await page.evaluate(() => ({ path: window.__scopes.session().path, exact: window.__scopes.session().exact, cfg: window.__scopes.st.cfg }));
    assert.equal(s.path, 'webcodecs'); assert.equal(s.exact, true, 'I420 / NV12 planes, not RGB'); assert.equal(s.cfg.codec, 'avc1.64001f'); assert.equal(s.cfg.fullRange, false);
    await page.evaluate(() => window.__scopes.stop(true)); // hold the last frame still
    const wf = await page.evaluate(() => window.__scopes.waveform());
    assert.ok(wf.sum > 1000 && wf.nonZero > 300, `waveform has samples (${wf.nonZero} bins)`);
    // left 40 % grey bar (x 0..160 of 1280): its waveform column peaks at 40 %
    const lv = await page.evaluate(() => window.__scopes.waveformLevels(0.01, 0.11));
    const top = lv.slice().sort((a, b) => b.count - a.count)[0];
    assert.ok(Math.abs(top.level - 39.7) < 1, `40 % grey bar at ${top.level.toFixed(1)} %`);
    await page.click('[data-view="1"]');
    const at = (u, v) => page.evaluate(([x, y]) => window.__scopes.pictureAt(x, y), [u, v]);
    assert.equal(bandOf(await at(0.06, 0.3)), 'GREEN', '40 % grey -> green');
    assert.equal(bandOf(await at(0.18, 0.3)), 'GREY', '75 % white -> grey');
    assert.equal(bandOf(await at(0.39, 0.85)), 'RED', '100 % white -> red');
    assert.equal(bandOf(await at(0.62, 0.85)), 'PURPLE', '0 % black -> purple');
    assert.equal(bandOf(await at(0.755, 0.85)), 'BLUE', '+4 % PLUGE (code 24, 3.7 %) -> blue');
    assert.equal(await page.locator('#legend').isVisible(), true, 'legend shown with FALSE');
    const vec = await page.evaluate(() => window.__scopes.vectorPeaks(20));
    assert.ok(vec.length > 6, 'vectorscope has bar clusters');
  });

  await t.test('decoded ramps: every false-colour step of the wedge lands in its band', { skip: wc ? false : 'no WebCodecs H.264' }, async () => {
    await open('src=builtin:ramps.h264&view=1');
    await page.waitForFunction(() => window.__scopes.stats.drawn >= 5, null, { timeout: 20000 });
    await page.evaluate(() => window.__scopes.stop(true));
    const sw = Math.floor(1280 / WEDGE.length / 2) * 2;
    for (const [i, p] of WEDGE.entries()) {
      const u = (i * sw + sw / 2) / 1280; const got = bandOf(await page.evaluate(([x]) => window.__scopes.pictureAt(x, 0.375), [u]));
      assert.equal(got, (SM.falseColorOf(p) || { name: 'GREY' }).name, `${p} %`);
    }
  });

  await t.test('raw I420 frame (exact codes): waveform levels, vectorscope targets, false colour, legal / full switch', async () => {
    await open('idle=1&view=1');
    const W = 1280; const H = 720; const frame = rampsFrame(W, H, false);
    await page.evaluate(([b64, w, h]) => { const b = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); window.__frame = b; window.__scopes.feedI420(b, w, h); }, [frame.toString('base64'), W, H]);
    const sw = Math.floor(W / WEDGE.length / 2) * 2;
    for (const [i, p] of WEDGE.entries()) {
      const u = (i * sw + sw / 2) / W;
      assert.equal(bandOf(await page.evaluate(([x]) => window.__scopes.pictureAt(x, 0.375), [u])), (SM.falseColorOf(Math.round((16 + 2.19 * p) - 16) / 2.19) || { name: 'GREY' }).name, `${p} %`);
      // the wedge column's waveform has a peak at its level (±1 bin = 0.23 %)
      const lv = await page.evaluate(([a, b]) => window.__scopes.waveformLevels(a, b), [(i * sw + 20) / W, (i * sw + sw - 20) / W]);
      const want = ((Math.round(16 + 2.19 * p) - 16) / 219) * 100;
      assert.ok(lv.some((x) => Math.abs(x.level - want) < 0.5 && x.count > 10), `waveform shows ${p} %`);
    }
    // 75 % patches hit their vectorscope targets (each within 0.012 in Pb / Pr)
    const peaks = await page.evaluate(() => window.__scopes.vectorPeaks(30));
    for (const tg of SM.targets().filter((x) => x.amp === 0.75)) assert.ok(peaks.some((q) => Math.abs(q.pb - tg.pb) < 0.012 && Math.abs(q.pr - tg.pr) < 0.012), `75 % ${tg.name} target`);
    const pd = await page.evaluate(() => { const t = window.__scopes.gl.readTarget('parade'); let n = 0; for (const v of t.data) if (v > 0) n++; return n; });
    assert.ok(pd > 500, 'parade has samples');
    // FULL range: code 235 reads 92 %, so the 100 % patch is no longer clipped red
    const last = (WEDGE.length - 1) * sw + 40;
    assert.equal(bandOf(await page.evaluate(([x]) => window.__scopes.pictureAt(x, 0.375), [last / W])), 'RED');
    await page.selectOption('#range', 'full');
    assert.equal(bandOf(await page.evaluate(([x]) => window.__scopes.pictureAt(x, 0.375), [last / W])), 'GREY', 'full range: 92 %');
    await page.selectOption('#range', 'auto');
    // toggles: hide PARADE and VEC -> two panels side by side
    await page.click('[data-show="parade"]'); await page.click('[data-show="vec"]');
    const r = await page.evaluate(() => window.__scopes.rects());
    assert.ok(r.pic && r.wfm && !r.parade && !r.vec); assert.ok(r.wfm[0] > r.pic[0] && Math.abs(r.wfm[1] - r.pic[1]) < r.pic[3], 'side by side');
    await page.click('[data-show="parade"]'); await page.click('[data-show="vec"]');
  });

  await t.test('plain-http origin (not a secure context): no WebCodecs, MSE fallback plays the same stream', async () => {
    const p2 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await p2.goto(`http://scopes.test:${port}/scopes.html?test=1&aw=160&src=builtin:bars.h264`);
    const env = await p2.evaluate(() => ({ secure: isSecureContext, vd: typeof VideoDecoder, mse: typeof MediaSource === 'function' && MediaSource.isTypeSupported('video/mp4; codecs="avc1.64001f"') }));
    assert.equal(env.secure, false); assert.equal(env.vd, 'undefined');
    if (!env.mse) { await p2.close(); return; }
    await p2.waitForFunction(() => window.__scopes.stats.drawn >= 3, null, { timeout: 20000 });
    assert.equal(await p2.evaluate(() => window.__scopes.session().path), 'mse');
    assert.match(await p2.textContent('#note'), /secure context|https/);
    await p2.close();
  });

  await t.test('HTTPS mirror (RS6_TLS_CERT / RS6_TLS_KEY) makes a LAN host name a secure context: WebCodecs, exact Y′', { skip: wc && tlsEnv.RS6_TLS_CERT ? false : 'needs openssl + WebCodecs H.264' }, async () => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } }); const p4 = await ctx.newPage();
    await p4.goto(`https://scopes.test:${tlsPort}/scopes.html?test=1&aw=160&src=builtin:bars.h264`);
    await p4.waitForFunction(() => window.__scopes && window.__scopes.stats.drawn >= 3, null, { timeout: 20000 });
    assert.deepEqual(await p4.evaluate(() => [isSecureContext, window.__scopes.session().path, window.__scopes.session().exact]), [true, 'webcodecs', true]);
    await ctx.close();
  });

  await t.test('PTZ group: SCOPES tab opens the scopes on the mock UE150 RTSP stream and stops it when left', { skip: wc ? false : 'no WebCodecs H.264' }, async () => {
    await fetch(`${B}/api/sys/active`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system: 'ptz' }) });
    const p3 = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await p3.goto(`${B}/#pctl`); await p3.waitForTimeout(500);
    await p3.evaluate(() => localStorage.setItem('cc.scopes.src', 'cam:cam1'));
    await openTab(p3, 'pscopes');
    const f = p3.frameLocator('#scopesFrame');
    await f.locator('#ro').waitFor({ timeout: 10000 });
    const fr = p3.frame({ url: /scopes\.html/ });
    await fr.waitForFunction(() => window.__scopes && window.__scopes.stats.drawn >= 3, null, { timeout: 20000 });
    let st = await (await fetch(`${B}/api/scopes/status`)).json();
    assert.ok(st.relays.some((x) => x.key === 'cam:cam1' && x.viewers === 1 && x.status.state === 'playing'));
    await openTab(p3, 'pcams');
    for (let i = 0; i < 40; i++) { st = await (await fetch(`${B}/api/scopes/status`)).json(); if (!st.relays.some((x) => x.viewers > 0)) break; await new Promise((r) => setTimeout(r, 100)); }
    assert.ok(!st.relays.some((x) => x.viewers > 0), 'leaving the tab stops the stream');
    await p3.close();
  });

  await t.test('Lightning tab: always available, hosts the same scopes frame + NDI help', { skip: wc ? false : 'no WebCodecs H.264' }, async () => {
    const p4 = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await p4.goto(`${B}/`); await p4.waitForTimeout(400);
    await p4.evaluate(() => localStorage.setItem('cc.scopes.src', 'builtin:bars.h264'));
    await openTab(p4, 'lightning');
    assert.equal(await p4.locator('#pane-lightning').isVisible(), true);
    await p4.click('#btnLightningNdi');
    assert.equal(await p4.locator('#lightningNdi').isVisible(), true);
    assert.match(await p4.locator('#lightningNdi').innerText(), /ingest/i);
    const ndiLabels = await p4.$$eval('#ndiSource option', (os) => os.map((o) => o.textContent));
    assert.ok(ndiLabels.some((t) => /Mock/.test(t)), `NDI picker: ${ndiLabels.join(' | ')}`);
    const f = p4.frameLocator('#scopesFrame');
    await f.locator('#ro').waitFor({ timeout: 10000 });
    const fr = p4.frame({ url: /scopes\.html/ });
    await fr.waitForFunction(() => window.__scopes && window.__scopes.stats.drawn >= 2, null, { timeout: 20000 });
    // standalone alias
    const r = await fetch(`${B}/lightning.html`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /scopes\.js|SOURCE/);
    await p4.close();
  });
  assert.deepEqual(errors, []);
});
