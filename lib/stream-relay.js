'use strict';
// 0.12.0 scopes: H.264 stream relay. One input per source (a camera's RTSP stream or a test file), shared by every
// browser that watches it (fan-out of the same buffers). Access units go out unchanged (no transcoding, no
// decoding): Annex-B NAL units are re-framed as AVCC (4-byte lengths) for the browser's decoder, SPS / PPS travel in
// a `config` message (WebCodecs `description` = avcC). CPU cost on the Pi is a few socket writes per frame.
//
// WebSocket protocol (server -> browser):
//   text   {"type":"config", codec:"avc1.64001f", description:<base64 avcC>, width, height, fps, fullRange, colour, label}
//   text   {"type":"status", state:"connecting"|"playing"|"error"|"ended", error?}
//   text   {"type":"pong", t:<client ms>, server:<server ms>}               (clock offset for the latency readout)
//   binary [u8 1][u8 flags: 1 key, 2 catch-up (decode, do not draw), 4 replayed from the GOP cache][u16 0][f64 server receive ms][f64 pts µs][AVCC access unit]
// (browser -> server): text {"type":"ping", t}
// A new viewer gets the config, then the current GOP from its IDR (flag catch-up: decode, do not draw) so the picture
// starts at once instead of waiting for the next IDR. A viewer that cannot keep up (socket backlog) is skipped to the
// next IDR instead of buffering latency.
const { EventEmitter } = require('events');
const H = require('./scopes/h264');

const now = () => Date.now();
const HDR = 20;
function auHeader(flags, serverMs, ptsUs) { const h = Buffer.alloc(HDR); h[0] = 1; h[1] = flags; h.writeDoubleLE(serverMs, 4); h.writeDoubleLE(ptsUs, 12); return h; }
const DROP = new Set([H.NAL.AUD, H.NAL.SPS, H.NAL.PPS, H.NAL.FILLER, H.NAL.END_SEQ, H.NAL.END_STREAM]);

class StreamRelay extends EventEmitter {
  constructor({ log = () => {}, lingerMs = 3000, gopCacheBytes = 8e6, gopCacheFrames = 600, maxBuffered = 2e6 } = {}) {
    super(); this.log = log; this.lingerMs = lingerMs; this.gopCacheBytes = gopCacheBytes; this.gopCacheFrames = gopCacheFrames; this.maxBuffered = maxBuffered;
    this.sources = new Map();
  }
  // key: source id; make(): a started-on-demand input (lib/scopes/sources.js); meta {label, kind}
  attach(key, make, ws, meta = {}) {
    let s = this.sources.get(key);
    if (!s) { s = this._open(key, make, meta); }
    clearTimeout(s.linger); s.linger = null;
    const c = { ws, waitKey: true, sent: 0, dropped: 0, bytes: 0, at: now() };
    s.clients.add(c);
    ws.on('text', (t) => { let m; try { m = JSON.parse(t); } catch { return; } if (m && m.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: m.t, server: now() })); });
    ws.on('close', () => { s.clients.delete(c); if (!s.clients.size) s.linger = setTimeout(() => this._close(s), this.lingerMs); });
    if (s.status) ws.send(JSON.stringify({ type: 'status', ...s.status }));
    if (s.config) {
      ws.send(JSON.stringify(s.config));
      if (s.gop.length) { s.gop.forEach((m, i) => this._sendAu(c, m, (i < s.gop.length - 1 ? 2 : 0) | 4, true)); c.waitKey = false; }
    }
    return c;
  }
  // settings changed (camera login, stream number, custom input): restart that source's input, keep its viewers
  reopen(key, make) {
    const s = this.sources.get(key); if (!s) return false;
    try { if (s.input) s.input.stop(); } catch { /* */ }
    s.params = null; s.config = null; s.gop = []; s.gopOk = false; s.waitKey = true; for (const c of s.clients) c.waitKey = true;
    this._start(s, make); return true;
  }
  _open(key, make, meta) {
    const s = { key, meta, clients: new Set(), gop: [], gopBytes: 0, gopOk: false, config: null, params: null, status: null, waitKey: true,
      stats: { aus: 0, keys: 0, bytes: 0, since: now(), lastAt: 0, broken: 0, fpsWin: [] } };
    this.sources.set(key, s);
    this._start(s, make);
    return s;
  }
  _start(s, make) {
    const { meta } = s; let input;
    try { input = make(); } catch (e) { s.status = { state: 'error', error: e.message }; s.input = null; this._broadcast(s, JSON.stringify({ type: 'status', ...s.status })); return; }
    s.input = input;
    input.on('status', (st) => { s.status = st; this._broadcast(s, JSON.stringify({ type: 'status', ...st })); if (st.state === 'error') this.log('warn', `Scopes ${meta.label || s.key}: ${st.error}`); });
    input.on('params', (p) => this._params(s, p.sps, p.pps));
    input.on('signal', (sig) => this._signal(s, sig));
    input.on('au', (au) => this._au(s, au));
    input.start();
    this.log('info', `Scopes: relay ${meta.label || s.key} started`);
  }
  _close(s) {
    if (s.clients.size) return;
    try { if (s.input) s.input.stop(); } catch { /* */ }
    this.sources.delete(s.key); this.log('info', `Scopes: relay ${s.meta.label || s.key} stopped (no viewers)`);
  }
  _signal(s, sig) {
    if (!sig) return;
    s.signal = { width: Number(sig.width) || 0, height: Number(sig.height) || 0, fps: Number(sig.fps) || 0, scan: sig.scan === 'i' ? 'i' : 'p', mode: sig.mode || '' };
    if (s.input && s.signal.fps) s.input.fps = s.signal.fps;
    if (s.config) {
      if (s.signal.width) s.config.width = s.signal.width;
      if (s.signal.height) s.config.height = s.signal.height;
      if (s.signal.fps) s.config.fps = s.signal.fps;
      s.config.scan = s.signal.scan;
      s.config.modeName = s.signal.mode;
    }
    this._broadcast(s, JSON.stringify({ type: 'format', ...s.signal, width: (s.config && s.config.width) || s.signal.width, height: (s.config && s.config.height) || s.signal.height, fps: (s.config && s.config.fps) || s.signal.fps }));
  }
  _params(s, sps, pps) {
    if (!sps || !pps) return;
    if (s.params && s.params.sps.equals(sps) && s.params.pps.equals(pps)) return;
    let info; try { info = H.parseSps(sps); } catch (e) { this.log('warn', `Scopes: bad SPS (${e.message})`); return; }
    s.params = { sps: Buffer.from(sps), pps: Buffer.from(pps), info };
    const sig = s.signal;
    s.config = { type: 'config', codec: H.codecString(sps), description: H.avcC(sps, pps).toString('base64'), width: (sig && sig.width) || info.width, height: (sig && sig.height) || info.height, codedWidth: info.codedWidth, codedHeight: info.codedHeight,
      fps: (sig && sig.fps) || (s.input && s.input.fps) || info.fps || null, scan: (sig && sig.scan) || (info.interlaced ? 'i' : ''), modeName: (sig && sig.mode) || '', fullRange: info.fullRange, colour: info.colour, profile: info.profileIdc, level: info.levelIdc, interlaced: !!(info.interlaced || (sig && sig.scan === 'i')),
      label: s.meta.label || s.key, kind: s.meta.kind || '' };
    s.gop = []; s.gopBytes = 0; s.waitKey = true;
    for (const c of s.clients) c.waitKey = true;
    this._broadcast(s, JSON.stringify(s.config));
  }
  _au(s, au) {
    if (au.sps && au.pps) this._params(s, au.sps, au.pps);
    if (!s.config) return; // nothing decodable before the parameter sets
    const st = s.stats; const t = now();
    st.aus++; if (au.key) st.keys++; st.lastAt = t; st.fpsWin.push(t); while (st.fpsWin.length && t - st.fpsWin[0] > 2000) st.fpsWin.shift();
    if (au.broken) { st.broken++; s.waitKey = true; }
    if (s.waitKey && !au.key) return;
    s.waitKey = false;
    const payload = H.toAvcc(au.nals.filter((n) => !DROP.has(H.nalType(n))));
    st.bytes += payload.length;
    const msg = { key: au.key, serverMs: t, pts: au.pts || 0, payload };
    if (au.key) { s.gop = [msg]; s.gopBytes = payload.length; s.gopOk = true; }
    else if (s.gopOk) { s.gop.push(msg); s.gopBytes += payload.length; if (s.gopBytes > this.gopCacheBytes || s.gop.length > this.gopCacheFrames) { s.gop = []; s.gopOk = false; } }
    for (const c of s.clients) this._sendAu(c, msg, 0, false);
  }
  _sendAu(c, m, flags, catchup) {
    if (c.waitKey && !m.key) { c.dropped++; return; }
    if (!catchup && c.ws.buffered > this.maxBuffered) { c.waitKey = true; c.dropped++; return; } // slow viewer: skip to the next IDR
    c.waitKey = false;
    c.ws.send([auHeader((m.key ? 1 : 0) | flags, m.serverMs, m.pts), m.payload]); c.sent++; c.bytes += m.payload.length;
  }
  _broadcast(s, text) { for (const c of s.clients) c.ws.send(text); }
  stats() {
    return [...this.sources.values()].map((s) => {
      const st = s.stats; const secs = Math.max(0.001, (now() - st.since) / 1000);
      return { key: s.key, label: s.meta.label || s.key, kind: s.meta.kind || '', status: s.status, viewers: s.clients.size, codec: s.config && s.config.codec, width: s.config && s.config.width, height: s.config && s.config.height,
        fps: st.fpsWin.length > 1 ? Math.round(((st.fpsWin.length - 1) * 1000 / (st.fpsWin[st.fpsWin.length - 1] - st.fpsWin[0])) * 10) / 10 : 0,
        kbps: Math.round((st.bytes * 8) / secs / 1000), frames: st.aus, keyFrames: st.keys, broken: st.broken, gopFrames: s.gop.length,
        clients: [...s.clients].map((c) => ({ sent: c.sent, dropped: c.dropped, buffered: c.ws.buffered })) };
    });
  }
  closeAll() { for (const s of this.sources.values()) { for (const c of s.clients) c.ws.close(1001); s.clients.clear(); clearTimeout(s.linger); try { if (s.input) s.input.stop(); } catch { /* */ } } this.sources.clear(); }
}

module.exports = { StreamRelay, auHeader, HDR };
