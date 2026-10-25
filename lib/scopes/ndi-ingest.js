'use strict';
// Sidecar ingest into the scopes relay. tools/decklink-sidecar.js (Desktop Video) and
// tools/ndi-sidecar.js (optional legacy NDI) push Annex-B H.264 over a WebSocket.
// This module turns those bytes into the same 'au' / 'params' / 'status' events FileInput
// and RtspInput already emit, so /api/scopes/ws is unchanged.
// No DeckLink SDK, no NDI SDK, and no decode here — the Pi process only relays compressed access units.
const { EventEmitter } = require('events');
const H = require('./h264');

const MAX_BUF = 8 * 1024 * 1024;

class AnnexBStream {
  constructor(onNal) { this.onNal = onNal; this.buf = Buffer.alloc(0); }
  push(chunk) {
    if (!chunk || !chunk.length) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    if (this.buf.length > MAX_BUF) throw new Error('NDI ingest buffer exceeded 8 MB without a NAL boundary');
    const b = this.buf; const n = b.length; let last = -1;
    for (let i = 0; i + 2 < n; i++) {
      if (b[i] === 0 && b[i + 1] === 0 && (b[i + 2] === 1 || (b[i + 2] === 0 && i + 3 < n && b[i + 3] === 1))) last = i;
    }
    if (last <= 0) return;
    for (const nal of H.splitAnnexB(b.subarray(0, last))) this.onNal(Buffer.from(nal));
    this.buf = Buffer.from(b.subarray(last));
  }
  end() {
    if (this.buf.length) { for (const nal of H.splitAnnexB(this.buf)) this.onNal(Buffer.from(nal)); }
    this.buf = Buffer.alloc(0);
  }
}

class NdiHub extends EventEmitter {
  constructor() { super(); this.sessions = new Map(); }
  has(id) { return this.sessions.has(id); }
  get(id) { return this.sessions.get(id) || null; }
  list() {
    return [...this.sessions.values()].map((s) => ({
      id: s.id, name: s.name, connected: s.connected, fps: s.fps, frames: s.frames,
      kind: s.kind || 'ndi', device: s.device || '', mode: s.mode || '',
    }));
  }
  snapshot(id) {
    const s = this.sessions.get(id); if (!s) return null;
    return { connected: s.connected, fps: s.fps, name: s.name, kind: s.kind || 'ndi', device: s.device || '', mode: s.mode || '', sps: s.sps, pps: s.pps, gop: s.gop.slice() };
  }
  subscribe(id, fn) {
    const wrap = (ev) => { if (ev.id === id) fn(ev); };
    this.on('event', wrap);
    return () => this.off('event', wrap);
  }
  open(id, { name, fps, conn, kind, device, mode } = {}) {
    let s = this.sessions.get(id);
    const applyMeta = (row) => {
      if (kind === 'decklink') row.kind = 'decklink';
      else if (kind === 'ndi') row.kind = 'ndi';
      if (device) row.device = device;
      if (mode) row.mode = mode;
    };
    if (!s) {
      s = { id, name, fps: fps || 30, connected: true, gop: [], sps: null, pps: null, frames: 0, timer: null, conn: null, kind: kind === 'decklink' ? 'decklink' : 'ndi', device: device || '', mode: mode || '' };
      this.sessions.set(id, s);
    } else {
      clearTimeout(s.timer); s.timer = null; s.connected = true;
      if (name) s.name = name;
      if (fps) s.fps = fps;
      applyMeta(s);
    }
    const prev = s.conn;
    s.conn = conn;
    s.connected = true;
    if (prev && prev !== conn) { try { prev.close(1000); } catch { /* replaced */ } }
    this.emit('event', { id, type: 'status', status: { state: 'playing' } });
    return s;
  }
  pushAu(s, au) {
    const copy = {
      nals: au.nals.map((n) => Buffer.from(n)),
      key: !!au.key,
      sps: au.sps ? Buffer.from(au.sps) : null,
      pps: au.pps ? Buffer.from(au.pps) : null,
      pts: au.pts || 0,
      broken: !!au.broken,
    };
    if (copy.sps) s.sps = copy.sps;
    if (copy.pps) s.pps = copy.pps;
    if (copy.key) s.gop = [copy];
    else if (s.gop.length && s.gop.length < 90) s.gop.push(copy);
    if (copy.sps && copy.pps) this.emit('event', { id: s.id, type: 'params', sps: copy.sps, pps: copy.pps });
    this.emit('event', { id: s.id, type: 'au', au: copy });
  }
  markDisconnected(s) {
    if (!s || s.conn === null && !s.connected) return;
    s.conn = null; s.connected = false;
    const why = s.kind === 'decklink' ? 'Desktop Video sidecar disconnected' : 'NDI sidecar disconnected';
    this.emit('event', { id: s.id, type: 'status', status: { state: 'error', error: why } });
    clearTimeout(s.timer);
    s.timer = setTimeout(() => { if (!s.connected) this.sessions.delete(s.id); }, 60000);
  }
  attachSocket(id, { name, fps, conn, kind, device, mode }) {
    const s = this.open(id, { name, fps, conn, kind, device, mode });
    const asm = new H.AccessUnitAssembler((au) => {
      au.pts = Math.round((s.frames * 1e6) / (s.fps || 30));
      s.frames++;
      this.pushAu(s, au);
    });
    const stream = new AnnexBStream((nal) => asm.push(nal));
    conn.on('binary', (buf) => {
      try { stream.push(buf); } catch (e) { this.fail(s, e.message); try { conn.close(1009); } catch { /* */ } }
    });
    conn.on('text', (t) => {
      let m; try { m = JSON.parse(t); } catch { return; }
      if (!m || m.type !== 'hello') return;
      if (m.name) s.name = String(m.name).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 64) || s.name;
      const f = Number(m.fps); if (f >= 1 && f <= 120) s.fps = f;
      if (m.kind === 'decklink') s.kind = 'decklink';
      else if (m.kind === 'ndi') s.kind = 'ndi';
      if (m.device != null && String(m.device).trim()) s.device = String(m.device).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 64);
      if (m.mode) s.mode = String(m.mode).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 32);
    });
    conn.on('close', () => {
      if (s.conn !== conn) return;
      try { stream.end(); asm.flush(); } catch { /* */ }
      this.markDisconnected(s);
    });
    return s;
  }
  fail(s, error) { this.emit('event', { id: s.id, type: 'status', status: { state: 'error', error } }); }
  close() {
    for (const s of this.sessions.values()) {
      clearTimeout(s.timer); s.timer = null;
      const c = s.conn; s.conn = null; s.connected = false;
      try { if (c) c.close(1001); } catch { /* */ }
    }
    this.sessions.clear();
  }
}

class NdiPushInput extends EventEmitter {
  constructor(hub, id) { super(); this.hub = hub; this.id = id; this.kind = 'ndi'; this.fps = 30; this.unsub = null; this.stopped = false; }
  start() {
    const snap = this.hub.snapshot(this.id);
    if (snap && snap.fps) this.fps = snap.fps;
    const queued = []; let ready = false;
    this.unsub = this.hub.subscribe(this.id, (ev) => { if (!ready) queued.push(ev); else this._on(ev); });
    setImmediate(() => {
      if (this.stopped) return;
      const live = !!(snap && snap.connected);
      const waiting = snap && snap.kind === 'decklink' ? 'waiting for the Desktop Video sidecar' : 'waiting for the Mac sidecar';
      this.emit('status', live ? { state: 'playing' } : { state: 'connecting', error: waiting });
      if (snap && snap.sps && snap.pps) this.emit('params', { sps: snap.sps, pps: snap.pps });
      const key = snap && snap.gop.find((a) => a.key);
      if (key) this.emit('au', key);
      ready = true;
      for (const ev of queued) this._on(ev);
    });
    return this;
  }
  _on(ev) {
    if (this.stopped) return;
    if (ev.type === 'status') this.emit('status', ev.status);
    else if (ev.type === 'params') this.emit('params', { sps: ev.sps, pps: ev.pps });
    else if (ev.type === 'au') this.emit('au', ev.au);
  }
  stop() { this.stopped = true; if (this.unsub) this.unsub(); this.unsub = null; }
}

module.exports = { AnnexBStream, NdiHub, NdiPushInput, MAX_BUF };
