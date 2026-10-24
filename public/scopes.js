// 0.12.0 video scopes page (public/scopes.html; also the SCOPES tab of the PTZ group, in an iframe).
// Transport: WebSocket /api/scopes/ws?src=<key> (lib/stream-relay.js): the camera's H.264 access units, untouched.
// Decode paths, best first:
//   WEBCODECS  VideoDecoder (hardware where the browser has it) -> VideoFrame.copyTo() I420 / NV12 planes -> exact Y′
//   MSE        the same access units wrapped as fragmented MP4 -> hidden <video> -> RGB picture (public/scopes-mse.js)
//   JPEG       camera snapshots through the app (/api/sys/ptz/cameras/:id/snapshot), ~2 fps, cameras only
// WebCodecs needs a secure context (https:// or http://localhost); on plain http://<pi-address> the page uses MSE.
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const Q = new URLSearchParams(location.search);
  const onLightning = Q.get('lightning') === '1' || /\/lightning(?:\.html)?$/.test(location.pathname);
  const LS = (k, v) => { const key = `cc.scopes.${k}`; if (v === undefined) return localStorage.getItem(key); if (v === null) localStorage.removeItem(key); else localStorage.setItem(key, String(v)); return v; };
  if (Q.get('embed')) document.body.classList.add('embed');
  const TEST = Q.get('test') === '1';
  const BENCH = Q.get('bench') === '1'; // draw cost includes the GPU (1-pixel readback per frame)
  const M = window.ScopesMath;

  // ---------- state ----------
  const st = {
    src: Q.get('src') || LS('src') || '', mode: Q.get('mode') || LS('mode') || 'auto', range: LS('range') || 'auto',
    show: new Set((Q.get('show') || LS('show') || 'pic,wfm,parade,vec').split(',').filter(Boolean)),
    view: Number(Q.get('view') || LS('view') || 0), gain: Number(LS('gain') || 1), vgain: Number(LS('vgain') || 1), zebra: Number(LS('zebra') || 95),
    playing: true, solo: null, cfg: null, active: '', sources: [],
  };
  const stats = { drawn: 0, decoded: 0, skipped: 0, bytes: 0, resets: 0, decodeMs: [], drawMs: [], uploadMs: [], latMs: [], winStart: performance.now(), fps: 0, kbps: 0, offset: 0, rtt: Infinity, lastLat: null };
  const push = (a, v, n = 60) => { a.push(v); if (a.length > n) a.shift(); };
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

  // ---------- GL ----------
  const glCanvas = $('#gl'); const ov = $('#ov'); const octx = ov.getContext('2d');
  let G = null;
  try { G = new window.ScopesGL(glCanvas, { preserve: TEST, analysisWidth: Number(Q.get('aw')) || Number(LS('aw')) || 640 }); } catch (e) { showMsg('WebGL2 unavailable', `${e.message}. The scopes need WebGL 2 (Safari 15+, Chrome 56+, Firefox 51+).`); }
  let rects = {}; let dirty = true; let overlayDirty = true;
  function layout() {
    const stage = $('#stage'); const dpr = window.devicePixelRatio || 1; const W = stage.clientWidth; const H = stage.clientHeight;
    for (const c of [glCanvas, ov]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const vis = [...document.querySelectorAll('.pnl')].filter((p) => { const on = st.show.has(p.dataset.k); p.hidden = !on; return on; });
    const n = vis.length; $('#panels').style.setProperty('--cols', String(n <= 1 ? 1 : n === 2 ? 2 : W > 1500 && n === 3 ? 3 : 2));
    $('#panels').classList.toggle('solo', !!st.solo && st.show.has(st.solo));
    document.querySelectorAll('.pnl').forEach((p) => p.classList.toggle('max', p.dataset.k === st.solo));
    const sb = stage.getBoundingClientRect(); rects = {};
    for (const p of vis) {
      if (p.offsetParent === null) continue;
      const b = p.getBoundingClientRect(); let r = [(b.left - sb.left + 1) * dpr, (b.top - sb.top + 1) * dpr, (b.width - 2) * dpr, (b.height - 2) * dpr];
      const k = p.dataset.k;
      if (k === 'pic') { const ar = st.cfg ? st.cfg.width / st.cfg.height : 16 / 9; r = fit(r, ar); }
      if (k === 'vec') r = fit(r, 1);
      rects[k] = r.map(Math.round);
    }
    dirty = true; overlayDirty = true;
  }
  const fit = ([x, y, w, h], ar) => { if (w / h > ar) { const nw = h * ar; return [x + (w - nw) / 2, y, nw, h]; } const nh = w / ar; return [x, y + (h - nh) / 2, w, nh]; };
  function drawOverlay() {
    overlayDirty = false; octx.clearRect(0, 0, ov.width, ov.height);
    const dpr = window.devicePixelRatio || 1; const full = G ? G.effFull : false;
    for (const k of ['wfm', 'parade', 'vec']) if (rects[k]) M.drawGraticule(octx, k, rects[k], { full, dpr, vgain: st.vgain });
    if (rects.pic) { octx.font = `${Math.round(10 * dpr)}px ui-monospace, Menlo, monospace`; octx.fillStyle = 'rgba(255,255,255,0.6)'; octx.fillText(['PICTURE', 'FALSE COLOUR', `ZEBRA ≥ ${st.zebra} %`][st.view] || '', rects.pic[0] + 6 * dpr, rects.pic[1] + 14 * dpr); }
  }
  new ResizeObserver(layout).observe($('#stage'));
  window.addEventListener('resize', layout);

  // ---------- controls ----------
  function applyOpts() {
    if (!G) return;
    const full = st.range === 'full' ? true : st.range === 'legal' ? false : !!(st.cfg && st.cfg.fullRange);
    const mx = st.cfg && st.cfg.colour && [5, 6].includes(st.cfg.colour.matrix) ? 1 : 0;
    G.set({ full, gain: st.gain, vgain: st.vgain, view: st.view, zebra: st.zebra, matrix: mx });
    dirty = true; overlayDirty = true;
  }
  function syncUi() {
    document.querySelectorAll('[data-show]').forEach((b) => b.setAttribute('aria-pressed', String(st.show.has(b.dataset.show))));
    document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.view) === st.view)));
    $('#range').value = st.range; $('#gain').value = st.gain; $('#vgain').value = String(st.vgain); $('#mode').value = st.mode; $('#zebra').value = st.zebra;
    $('#btnPlay').setAttribute('aria-pressed', String(st.playing)); $('#btnPlay').textContent = st.playing ? 'LIVE' : 'STOPPED';
    const lg = $('#legend'); lg.hidden = st.view !== 1;
    if (!lg.dataset.done) { lg.dataset.done = '1'; lg.innerHTML = M.FALSE_COLOR.map((b) => `<span title="${b.label}"><i style="background:rgb(${b.rgb.map((v) => Math.round(v * 255)).join(',')})"></i>${b.label}</span>`).join(''); }
  }
  $('#showGrp').addEventListener('click', (e) => { const b = e.target.closest('[data-show]'); if (!b) return; const k = b.dataset.show; if (st.show.has(k)) { if (st.show.size > 1) st.show.delete(k); } else st.show.add(k); LS('show', [...st.show].join(',')); syncUi(); layout(); });
  $('#viewGrp').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (!b) return; st.view = Number(b.dataset.view); LS('view', st.view); if (st.view && !st.show.has('pic')) { st.show.add('pic'); layout(); } syncUi(); applyOpts(); });
  $('#range').addEventListener('change', (e) => { st.range = e.target.value; LS('range', st.range); applyOpts(); });
  $('#gain').addEventListener('input', (e) => { st.gain = Number(e.target.value); LS('gain', st.gain); applyOpts(); });
  $('#vgain').addEventListener('change', (e) => { st.vgain = Number(e.target.value); LS('vgain', st.vgain); applyOpts(); });
  $('#zebra').addEventListener('change', (e) => { st.zebra = Math.max(50, Math.min(109, Number(e.target.value) || 95)); LS('zebra', st.zebra); applyOpts(); });
  $('#mode').addEventListener('change', (e) => { st.mode = e.target.value; LS('mode', st.mode); start(); });
  $('#src').addEventListener('change', (e) => { st.src = e.target.value; LS('src', st.src); announce(); start(); });
  $('#btnPlay').addEventListener('click', () => { st.playing = !st.playing; syncUi(); if (st.playing) start(); else stop(); });
  // double-click (or double-tap) a panel: that scope alone; again: back to the grid
  $('#stage').addEventListener('dblclick', (e) => {
    const sb = $('#stage').getBoundingClientRect(); const dpr = window.devicePixelRatio || 1; const x = (e.clientX - sb.left) * dpr; const y = (e.clientY - sb.top) * dpr;
    if (st.solo) st.solo = null; else for (const [k, r] of Object.entries(rects)) if (x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3]) st.solo = k;
    layout();
  });
  for (const p of document.querySelectorAll('.pnl')) p.style.pointerEvents = 'auto';
  // pause while hidden (saves the camera's stream slot and the Pi's bandwidth); resume on return
  document.addEventListener('visibilitychange', () => { if (document.hidden) { if (session) stop(true); } else if (st.playing && !session) start(); });
  function announce() { if (window.parent && window.parent !== window) window.parent.postMessage({ type: 'scopes-src', src: st.src }, location.origin); }
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data || e.data.type !== 'scopes') return;
    if (typeof e.data.src === 'string' && e.data.src) { st.src = e.data.src; LS('src', st.src); const sel = $('#src'); if ([...sel.options].some((o) => o.value === st.src)) sel.value = st.src; announce(); }
    if (e.data.visible === false) stop(true);
    else if (e.data.src) { if (st.playing) start(); }
    else if (st.playing) start();
  });

  function showMsg(title, html) { const m = $('#msg'); if (!title) { m.hidden = true; return; } m.innerHTML = `<h3>${title}</h3><div>${html}</div>`; m.hidden = false; }
  function note(t) { const n = $('#note'); n.textContent = t || ''; n.hidden = !t; }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- sources ----------
  let ndiPreferApplied = false;
  async function loadSources() {
    const r = await fetch('/api/scopes/sources').then((x) => x.json());
    st.sources = r.sources; st.settings = r.settings; st.ndi = r.ndi || null;
    const sel = $('#src');
    sel.innerHTML = r.sources.map((s) => `<option value="${esc(s.key)}" ${s.ok ? '' : 'data-noh264="1"'}>${esc(s.label)}${s.ok ? '' : ' — JPEG only'}</option>`).join('') || '<option value="">no sources</option>';
    if (!r.sources.some((s) => s.key === st.src)) st.src = (r.sources.find((s) => s.kind === 'camera' && s.ok) || r.sources[0] || {}).key || '';
    // Lightning opens on an NDI ingest. PTZ → SCOPES keeps the camera preference.
    if (!ndiPreferApplied && (Q.get('prefer') === 'ndi' || onLightning)) {
      ndiPreferApplied = true;
      const ndi = r.sources.find((s) => s.kind === 'ndi' && s.ok);
      const cur = r.sources.find((s) => s.key === st.src);
      if (ndi && (!cur || cur.kind !== 'ndi')) { st.src = ndi.key; LS('src', st.src); }
    }
    sel.value = st.src;
    announce();
    return r;
  }

  // ---------- session (one per source / mode) ----------
  let session = null;
  function stop(keepPlaying) {
    const s = session; session = null; if (!s) return;
    s.closed = true; clearInterval(s.pingT); clearInterval(s.jpegT); clearTimeout(s.retryT);
    try { s.ws && s.ws.close(); } catch { /* */ }
    try { if (s.dec && s.dec.state !== 'closed') s.dec.close(); } catch { /* */ }
    if (s.mse) s.mse.reset();
    if (pending) { try { pending.frame.close(); } catch { /* */ } pending = null; }
    if (!keepPlaying) note('');
  }
  const canWebCodecs = () => typeof window.VideoDecoder === 'function' && window.isSecureContext;
  function start() {
    stop(true); showMsg(null); if (!st.playing || !st.src) return;
    const src = st.sources.find((s) => s.key === st.src) || { key: st.src, kind: '' };
    const s = { src, closed: false, path: null, waitKey: true, meta: new Map() }; session = s;
    st.active = st.src; st.cfg = null; resetStats();
    const camId = src.camId || (src.key.startsWith('cam:') ? src.key.slice(4) : null);
    let mode = st.mode;
    if (mode === 'auto') mode = !src.ok && camId ? 'jpeg' : canWebCodecs() ? 'webcodecs' : (window.MediaSource || window.ManagedMediaSource) ? 'mse' : camId ? 'jpeg' : 'none';
    if (mode === 'webcodecs' && !canWebCodecs()) {
      const why = typeof window.VideoDecoder !== 'function' && window.isSecureContext ? 'This browser has no WebCodecs VideoDecoder.' : `WebCodecs needs a secure context (https:// or http://localhost); this page is ${esc(location.origin)}.`;
      if (st.mode === 'webcodecs') { showMsg('WebCodecs unavailable', `${why} Choose DECODE: AUTO to use the MSE fallback${camId ? ' or JPEG snapshots' : ''}.`); return; }
    }
    if (mode === 'none') { showMsg('No H.264 decoder in this browser', 'Neither WebCodecs (needs https:// or localhost) nor Media Source Extensions are available. Pick a camera source to use JPEG snapshots, or open this page in Chrome / Edge / Safari 16.4+ / Firefox 130+.'); return; }
    s.path = mode;
    if (mode === 'webcodecs' && !window.isSecureContext) note('');
    if (mode === 'mse' && !canWebCodecs()) note(`MSE fallback (RGB picture): WebCodecs needs https:// or localhost for exact Y′ values${window.isSecureContext ? '' : ` — this page is ${location.protocol}//${location.host}`}.`);
    if (mode === 'jpeg') { if (!camId) { showMsg('JPEG snapshots are for cameras', 'Pick a camera source, or DECODE: AUTO for this test video.'); return; } startJpeg(s, camId); return; }
    openWs(s);
  }
  function resetStats() { Object.assign(stats, { catchups: 0, drawn: 0, decoded: 0, skipped: 0, bytes: 0, resets: 0, decodeMs: [], drawMs: [], uploadMs: [], latMs: [], winStart: performance.now(), fps: 0, kbps: 0, lastLat: null, frames0: 0, bytes0: 0 }); }
  function openWs(s) {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/scopes/ws?src=${encodeURIComponent(s.src.key)}`);
    ws.binaryType = 'arraybuffer'; s.ws = ws;
    ws.onopen = () => { const ping = () => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'ping', t: Date.now() })); ping(); s.pingT = setInterval(ping, 2000); };
    ws.onmessage = (ev) => {
      if (s.closed) return;
      if (typeof ev.data === 'string') { const m = JSON.parse(ev.data); if (m.type === 'config') onConfig(s, m); else if (m.type === 'status') onStatus(s, m); else if (m.type === 'pong') onPong(m); return; }
      onAu(s, ev.data);
    };
    ws.onclose = () => { clearInterval(s.pingT); if (!s.closed && session === s) { note('Stream connection lost — reconnecting…'); s.retryT = setTimeout(() => { if (session === s) start(); }, 1500); } };
  }
  function onPong(m) { const t1 = Date.now(); const rtt = t1 - m.t; if (rtt <= stats.rtt * 1.5 || rtt < 20) { stats.rtt = Math.min(rtt, stats.rtt); stats.offset = m.server - (m.t + rtt / 2); } }
  function onStatus(s, m) {
    if (m.state === 'error') showMsg(m.auth ? 'Camera login rejected' : 'Stream error', `${esc(m.error)}${m.auth ? '<br>Check the camera login on the PTZ CAMERAS tab (or under ⚙ INPUTS; factory default admin / 12345).' : ''}<br><small>Retrying…</small>`);
    else if (m.state === 'connecting') note('Connecting to the stream…');
    else if (m.state === 'playing') { showMsg(null); note(s.path === 'mse' && !canWebCodecs() ? $('#note').textContent : ''); }
  }
  const b64 = (t) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
  async function onConfig(s, cfg) {
    st.cfg = cfg; applyOpts(); layout();
    const desc = b64(cfg.description);
    if (s.path === 'webcodecs') {
      const conf = { codec: cfg.codec, description: desc, codedWidth: cfg.codedWidth || cfg.width, codedHeight: cfg.codedHeight || cfg.height, optimizeForLatency: true, hardwareAcceleration: 'no-preference' };
      let ok = false; try { ok = (await VideoDecoder.isConfigSupported(conf)).supported; } catch { ok = false; }
      if (s.closed) return;
      if (!ok) {
        if (st.mode === 'auto' && (window.MediaSource || window.ManagedMediaSource)) { s.path = 'mse'; note(`WebCodecs cannot decode ${cfg.codec} here; using the MSE fallback.`); }
        else { showMsg('Codec not supported', `This browser's WebCodecs cannot decode ${esc(cfg.codec)} (${cfg.width}×${cfg.height}).`); return; }
      } else {
        s.conf = conf; makeDecoder(s); return;
      }
    }
    if (s.path === 'mse') {
      if (!window.ScopesMse.MsePlayer.supported(cfg.codec)) { showMsg('Codec not supported', `Media Source Extensions in this browser cannot play ${esc(cfg.codec)}.`); return; }
      const v = $('#vid');
      if (!s.mse) { s.mse = new window.ScopesMse.MsePlayer(v, { onError: (e) => note(e) }); hookVideo(s, v); }
      s.mse.configure(cfg, desc);
    }
  }
  function makeDecoder(s) {
    try { if (s.dec && s.dec.state !== 'closed') s.dec.close(); } catch { /* */ }
    s.waitKey = true;
    s.dec = new VideoDecoder({
      output: (frame) => onFrame(s, frame),
      error: (e) => { if (s.closed) return; stats.resets++; note(`Decoder error (${e.message}); waiting for the next key frame`); setTimeout(() => { if (!s.closed) makeDecoder(s); }, 50); },
    });
    s.dec.configure(s.conf);
  }
  function onAu(s, buf) {
    const dv = new DataView(buf); const flags = dv.getUint8(1); const serverMs = dv.getFloat64(4, true); const pts = dv.getFloat64(12, true);
    const key = !!(flags & 1); const catchup = !!(flags & 2); const replay = !!(flags & 4);
    const data = new Uint8Array(buf, 20); stats.bytes += data.length;
    if (s.path === 'webcodecs') {
      const d = s.dec; if (!d || d.state !== 'configured') return;
      if (s.waitKey && !key) return; s.waitKey = false;
      if (d.decodeQueueSize > 20 && !key) { stats.skipped++; s.waitKey = true; return; } // decoder behind: skip to the next IDR
      // latency guard: frames come out late (slow GPU / main thread) -> drop the backlog at the next IDR
      if (key && s.behind && !catchup) { s.behind = false; stats.catchups = (stats.catchups || 0) + 1; try { d.reset(); d.configure(s.conf); } catch { /* */ } s.meta.clear(); if (pending) { pending.frame.close(); pending = null; } }
      s.meta.set(pts, { serverMs, catchup, replay, t: performance.now() }); if (s.meta.size > 120) s.meta.delete(s.meta.keys().next().value);
      try { d.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: pts, data })); } catch (e) { s.waitKey = true; }
    } else if (s.path === 'mse' && s.mse) {
      s.mse.push(key, pts, data, { serverMs, replay, t: performance.now() });
    }
  }
  // ---------- frames -> GL ----------
  let pending = null; let busy = false;
  function onFrame(s, frame) {
    const m = s.meta.get(frame.timestamp); if (m) s.meta.delete(frame.timestamp);
    stats.decoded++; if (m) { const dt = performance.now() - m.t; push(stats.decodeMs, dt); if (!m.catchup && !m.replay && dt > 400) s.behind = true; }
    if (s.closed || (m && m.catchup)) { frame.close(); return; }
    if (pending) { pending.frame.close(); stats.skipped++; }
    pending = { frame, m: m || null, s };
  }
  let planeBuf = null;
  async function drawPending() {
    const p = pending; pending = null; busy = true;
    const t0 = performance.now(); const f = p.frame;
    try {
      const fmt = f.format; const w = f.visibleRect ? f.visibleRect.width : f.codedWidth; const h = f.visibleRect ? f.visibleRect.height : f.codedHeight;
      if (fmt === 'I420' || fmt === 'NV12' || fmt === 'I420A') {
        const size = f.allocationSize(); if (!planeBuf || planeBuf.length < size) planeBuf = new Uint8Array(size);
        const layout = await f.copyTo(planeBuf);
        G.uploadPlanes({ format: fmt === 'NV12' ? 'NV12' : 'I420', width: w, height: h, data: planeBuf, layout });
        p.s.exact = true;
      } else { G.uploadImage(f, w, h); p.s.exact = false; } // RGB / opaque GPU frames: the browser's conversion
      const t1 = performance.now(); push(stats.uploadMs, t1 - t0);
      G.render(rects, performance.now() / 1000); if (BENCH) G.sync();
      push(stats.drawMs, performance.now() - t0);
      stats.drawn++;
      if (p.m && !p.m.replay) { const lat = Date.now() + stats.offset - p.m.serverMs; stats.lastLat = lat; push(stats.latMs, lat); }
    } catch (e) { note(`draw: ${e.message}`); } finally { f.close(); busy = false; }
    if (overlayDirty) drawOverlay();
    dirty = false;
  }
  function hookVideo(s, v) {
    const step = (now, md) => {
      if (s.closed) return;
      if (v.videoWidth && G) {
        const t0 = performance.now(); G.uploadImage(v, v.videoWidth, v.videoHeight); G.render(rects, t0 / 1000); if (BENCH) G.sync();
        push(stats.drawMs, performance.now() - t0); stats.drawn++; stats.decoded++;
        const m = md && s.mse ? s.mse.metaFor(md.mediaTime) : null; if (m && !m.replay) { const lat = Date.now() + stats.offset - m.serverMs; stats.lastLat = lat; push(stats.latMs, lat); }
        if (overlayDirty) drawOverlay(); dirty = false;
      }
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(step); else requestAnimationFrame(() => step(0, null));
    };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(step); else requestAnimationFrame(() => step(0, null));
  }
  function startJpeg(s, camId) {
    note('JPEG snapshots (~2 fps, the camera\'s JPEG encoder: 8-bit, full range).');
    const img = new Image(); st.cfg = { width: 16, height: 9, fullRange: false };
    const tick = async () => {
      if (s.closed || s.busy) return; s.busy = true;
      try {
        const t0 = performance.now(); const r = await fetch(`/api/sys/ptz/cameras/${encodeURIComponent(camId)}/snapshot?t=${Date.now()}`, { cache: 'no-store' }); if (!r.ok) throw new Error(`snapshot ${r.status}`);
        const blob = await r.blob(); stats.bytes += blob.size; const url = URL.createObjectURL(blob); img.src = url; await img.decode(); URL.revokeObjectURL(url);
        const w = img.naturalWidth || 640; const h = img.naturalHeight || 360;
        if (!st.cfg || st.cfg.width !== w) { st.cfg = { width: w, height: h, fullRange: false, codec: 'jpeg' }; layout(); }
        const t1 = performance.now(); G.uploadImage(img, w, h); G.render(rects, t1 / 1000); push(stats.drawMs, performance.now() - t1); push(stats.latMs, performance.now() - t0); stats.drawn++; stats.decoded++;
        if (overlayDirty) drawOverlay(); showMsg(null);
      } catch (e) { showMsg('No snapshot', esc(e.message)); } finally { s.busy = false; }
    };
    tick(); s.jpegT = setInterval(tick, 500);
  }
  function loop() {
    if (G && pending && !busy) drawPending();
    else if (G && dirty && !busy && G.src && session && session.path !== 'mse') { G.render(rects, performance.now() / 1000); if (overlayDirty) drawOverlay(); dirty = false; }
    else if (overlayDirty) drawOverlay();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ---------- readout ----------
  function readout() {
    const now = performance.now(); const secs = (now - stats.winStart) / 1000;
    if (secs >= 1) { stats.fps = (stats.drawn - (stats.frames0 || 0)) / secs; stats.kbps = ((stats.bytes - (stats.bytes0 || 0)) * 8) / secs / 1000; stats.frames0 = stats.drawn; stats.bytes0 = stats.bytes; stats.winStart = now; }
    const s = session; const c = st.cfg || {};
    adapt();
    const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—'); const f0 = (v) => (Number.isFinite(v) ? Math.round(v) : '—');
    const path = s ? ({ webcodecs: `WEBCODECS${s.exact === false ? ' (RGB)' : ' · exact Y′'}`, mse: 'MSE · RGB', jpeg: 'JPEG' }[s.path] || '—') : 'STOPPED';
    const range = G ? (G.effFull ? 'FULL' : 'LEGAL') + (st.range === 'auto' ? ` (auto${c.fullRange === true ? ', VUI full' : c.fullRange === false ? ', VUI legal' : ''})` : '') : '';
    $('#ro').innerHTML = [
      `<span class="mode">${path}</span>`,
      c.codec ? `<span>${esc(c.codec)} <b>${c.width}×${c.height}</b>${c.fps ? ` @ ${c.fps}` : ''}</span>` : '',
      `<span>FPS <b data-ro="fps">${f1(stats.fps)}</b></span>`,
      `<span>LATENCY <b data-ro="lat">${f0(avg(stats.latMs))}</b> ms</span>`,
      `<span>DECODE <b data-ro="dec">${f1(avg(stats.decodeMs))}</b> ms</span>`,
      `<span>DRAW <b data-ro="draw">${f1(avg(stats.drawMs))}</b> ms</span>`,
      `<span>${f0(stats.kbps)} kb/s</span>`, `<span>${range}</span>`, G ? `<span>DETAIL <b data-ro="aw">${G.analysisSize.join('×')}</b></span>` : '',
      stats.skipped ? `<span>SKIPPED ${stats.skipped}</span>` : '', stats.resets ? `<span>RESETS ${stats.resets}</span>` : '', stats.catchups ? `<span>CATCH-UPS ${stats.catchups}</span>` : '',
    ].filter(Boolean).join('');
  }
  setInterval(readout, 500);
  // DETAIL auto: a GPU that cannot keep up (frames replaced before they were drawn) gets fewer analysis columns
  // (640 -> 480 -> 320 -> 240 -> 160); after 10 s without skips it steps back up. ?aw=<n> fixes it.
  const adaptSt = { skipped: 0, drawn: 0, calmSince: performance.now() };
  function adapt() {
    if (!G || Q.get('aw') || !session || session.path === 'jpeg') return;
    const sk = stats.skipped - adaptSt.skipped; const dr = stats.drawn - adaptSt.drawn; adaptSt.skipped = stats.skipped; adaptSt.drawn = stats.drawn;
    const steps = [160, 240, 320, 480, 640]; const i = steps.indexOf(G.maxAW);
    const late = avg(stats.decodeMs.slice(-10)) > 250;
    if (((dr + sk > 4 && sk / (dr + sk) > 0.25) || late) && i > 0) { G.maxAW = steps[i - 1]; adaptSt.calmSince = performance.now(); dirty = true; }
    else if (sk > 0) adaptSt.calmSince = performance.now();
    else if (performance.now() - adaptSt.calmSince > 10000 && i >= 0 && i < steps.length - 1) { G.maxAW = steps[i + 1]; adaptSt.calmSince = performance.now(); }
  }

  // ---------- settings dialog ----------
  $('#btnSettings').addEventListener('click', async () => {
    const r = await loadSources(); const set = r.settings; const cams = set.cameras || {};
    const names = Object.fromEntries(r.sources.filter((x) => x.camId).map((x) => [x.camId, x.label]));
    $('#camTbl tbody').innerHTML = Object.entries(cams).map(([id, c]) => `<tr data-cam="${esc(id)}"><td>${esc(names[id] || id)}<br><small class="hint">${esc(c.url)}</small></td>
      <td><select data-f="stream">${[1, 2, 3, 4].map((n) => `<option ${Number(c.stream) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></td>
      <td><input data-f="path" value="${esc(c.path || '')}" placeholder="${esc(set.cameraDefaults.path)}"></td><td><input data-f="port" value="${esc(c.port || 554)}" style="width:64px"></td>
      ${c.loginFrom === 'camera' ? `<td colspan="2" class="hint" title="Change it on the PTZ CAMERAS tab (LOGIN)">${esc(c.user || '')} · camera login (CAMERAS tab)</td>` : `<td><input data-f="user" value="${esc(c.user || '')}" autocomplete="off"></td><td><input data-f="password" type="password" autocomplete="new-password" placeholder="${c.hasPassword ? 'unchanged' : 'none'}"></td>`}</tr>`).join('') || '<tr><td colspan="6" class="hint">No PTZ cameras on the desk (SYSTEMS → PTZ).</td></tr>';
    $('#testDir').value = set.testDir || ''; $('#custom').value = set.custom || ''; $('#customUser').value = set.customUser || ''; $('#customPassword').value = '';
    $('#dlg').showModal();
  });
  $('#dlg').addEventListener('close', async () => {
    if ($('#dlg').returnValue !== 'save') return;
    const cameras = {};
    for (const tr of document.querySelectorAll('#camTbl tr[data-cam]')) { const c = {}; for (const i of tr.querySelectorAll('[data-f]')) { if (i.dataset.f === 'password' && !i.value) continue; c[i.dataset.f] = i.dataset.f === 'stream' || i.dataset.f === 'port' ? Number(i.value) : i.value; } cameras[tr.dataset.cam] = c; }
    const body = { cameras, testDir: $('#testDir').value, customUser: $('#customUser').value };
    const cu = $('#custom').value; if (!cu.includes('***@')) body.custom = cu;
    if ($('#customPassword').value) body.customPassword = $('#customPassword').value;
    const r = await fetch('/api/scopes/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json());
    if (r.error) { showMsg('Settings not saved', esc(r.error)); return; }
    await loadSources(); start();
  });

  // ---------- test / measurement hooks ----------
  window.__scopes = {
    st, stats, get gl() { return G; }, rects: () => rects, session: () => session,
    // feed a raw I420 frame (bypasses the decoder): the GL maths on known code values
    feedI420(bytes, w, h, { full = false } = {}) { stop(true); st.playing = false; st.cfg = { width: w, height: h, fullRange: full, codec: 'raw I420' }; applyOpts(); layout(); G.uploadI420(bytes, w, h); G.render(rects, 0); G.finish(); drawOverlay(); },
    render() { G.render(rects, 0); G.finish(); },
    // picture-panel colour at a normalised picture position (u, v from the top-left)
    pictureAt(u, v) { const r = rects.pic; G.render(rects, 0); const px = G.readCanvas(Math.round(r[0] + u * (r[2] - 1)), Math.round(r[1] + v * (r[3] - 1))); return [px[0], px[1], px[2]]; },
    waveform() { const t = G.readTarget('wfm'); if (!t) return null; let sum = 0; let nz = 0; for (const v of t.data) { sum += v; if (v > 0) nz++; } return { w: t.w, h: t.h, sum, nonZero: nz }; },
    // Y′ level (%) histogram rows of the waveform: which display rows got samples for columns [c0, c1)
    waveformLevels(c0, c1) { const t = G.readTarget('wfm'); const out = []; for (let y = 0; y < t.h; y++) { let s = 0; for (let x = Math.floor(c0 * t.w); x < Math.ceil(c1 * t.w); x++) s += t.data[y * t.w + x]; if (s > 0) out.push({ level: M.WFM_LO * 100 + ((y + 0.5) / t.h) * (M.WFM_HI - M.WFM_LO) * 100, count: s }); } return out; },
    vectorPeaks(min = 0) { const t = G.readTarget('vec'); const out = []; for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) { const v = t.data[y * t.w + x]; if (v > min) out.push({ pb: ((x + 0.5) / t.w * 2 - 1) / (M.VEC_SCALE * st.vgain), pr: ((y + 0.5) / t.h * 2 - 1) / (M.VEC_SCALE * st.vgain), count: v }); } return out; },
    start, stop, loadSources,
  };

  syncUi(); layout();
  loadSources().then(() => { if (st.playing && !Q.get('idle')) start(); }).catch((e) => showMsg('Cannot list sources', esc(e.message)));
})();
