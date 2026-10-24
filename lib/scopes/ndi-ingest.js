'use strict';
// 0.20.0-dev NDI ingest for Lightning scopes.
//
// Browsers cannot open NDI. This module does not receive NDI and does not load an NDI SDK.
// A Mac sidecar (sidecar/ndi/ndi-sidecar.js) receives NDI, encodes H.264 Annex-B, and pushes
// access units here. They enter the same StreamRelay the camera RTSP path uses
// (input events: status / params / au). The Pi app only relays those bytes.
//
// --mock (or any caller that passes mockFile) also exposes ndi:mock, a built-in frame source
// (the bars fixture) so CI and demo run with no NDI hardware and no sidecar process.
const fs = require('fs');
const { EventEmitter } = require('events');
const H = require('./h264');
const { FileInput } = require('./sources');

const MAX_FEEDS = 16;
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

function cleanId(id) {
  const s = String(id || '');
  const bare = s.startsWith('ndi:') ? s.slice(4) : s;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(bare)) return null;
  return bare;
}

function cleanName(name, fallback) {
  const s = String(name == null || name === '' ? fallback : name).replace(/[\u0000-\u001f]/g, ' ').trim();
  return (s || fallback).slice(0, 80);
}

/** Annex-B (4-byte start codes) for one access unit's NAL units. */
function toAnnexB(nals) {
  let size = 0;
  for (const n of nals) size += 4 + n.length;
  const out = Buffer.allocUnsafe(size);
  let o = 0;
  for (const n of nals) { out.writeUInt32BE(1, o); n.copy(out, o + 4); o += 4 + n.length; }
  return out;
}

class NdiFeed extends EventEmitter {
  constructor(id, name) {
    super();
    this.setMaxListeners(50);
    this.id = id;
    this.name = name;
    this.frames = 0;
    this.lastAt = 0;
    this.playing = false;
    this.needKey = true;
    this.params = null;
    this.gop = [];
    this._asm = new H.AccessUnitAssembler((au) => this._onAu(au));
  }
  reset(name) {
    if (name) this.name = name;
    this._asm = new H.AccessUnitAssembler((au) => this._onAu(au));
    this.gop = [];
    this.frames = 0;
    this.playing = false;
    this.needKey = true;
    this.params = null;
    this.emit('status', { state: 'waiting', detail: 'NDI ingest waiting for a key frame' });
  }
  /** Called when a scopes viewer opens the relay. Replays the open GOP so a viewer
   *  who connects after the sidecar has already pushed frames still gets a picture.
   *  Does not receive NDI. */
  arm() {
    this.emit('status', { state: this.playing ? 'playing' : 'waiting', detail: 'Mac sidecar ingest' });
    if (this.params) this.emit('params', this.params);
    for (const au of this.gop) this.emit('au', au);
    return this;
  }
  ingestAnnexB(buf, pts) {
    if (!Buffer.isBuffer(buf) || !buf.length) throw err('empty Annex-B body');
    const nals = H.splitAnnexB(buf);
    if (!nals.length) throw err('Annex-B start code not found');
    const before = this.frames;
    const meta = pts != null && Number.isFinite(Number(pts)) ? { pts: Number(pts) } : {};
    for (const n of nals) this._asm.push(Buffer.from(n), meta);
    this._asm.flush();
    return { ok: true, id: this.id, key: `ndi:${this.id}`, frames: this.frames, aus: this.frames - before };
  }
  _onAu(au) {
    if (this.needKey && !au.key) return;
    this.needKey = false;
    this.frames++;
    this.lastAt = Date.now();
    if (au.sps && au.pps) this.params = { sps: Buffer.from(au.sps), pps: Buffer.from(au.pps) };
    if (au.key) this.gop = [au];
    else if (this.gop.length && this.gop[0].key) {
      this.gop.push(au);
      if (this.gop.length > 90) this.gop.splice(1, this.gop.length - 45);
    }
    if (!this.playing) { this.playing = true; this.emit('status', { state: 'playing', detail: 'Mac sidecar ingest' }); }
    this.emit('au', au);
  }
}

/** One relay viewer. A new wrapper per attach so reopen() does not stack listeners on the feed. */
function viewOf(feed) {
  const ee = new EventEmitter();
  const onAu = (au) => ee.emit('au', au);
  const onStatus = (st) => ee.emit('status', st);
  const onParams = (p) => ee.emit('params', p);
  let on = false;
  ee.kind = 'ndi';
  ee.start = () => {
    if (on) return ee;
    on = true;
    feed.on('au', onAu); feed.on('status', onStatus); feed.on('params', onParams);
    feed.arm();
    return ee;
  };
  ee.stop = () => {
    if (!on) return;
    on = false;
    feed.off('au', onAu); feed.off('status', onStatus); feed.off('params', onParams);
  };
  return ee;
}

class NdiIngest {
  constructor({ mockFile = null } = {}) {
    this.feeds = new Map();
    this.mockFile = mockFile && fs.existsSync(mockFile) ? mockFile : null;
  }
  list() {
    const out = [];
    if (this.mockFile) {
      out.push({
        id: 'mock', key: 'ndi:mock', label: 'NDI · Mock bars', kind: 'ndi',
        detail: 'built-in frame source (no NDI hardware)', ok: true, mock: true, frames: null, lastAt: null,
      });
    }
    for (const f of this.feeds.values()) {
      out.push({
        id: f.id, key: `ndi:${f.id}`, label: `NDI · ${f.name}`, kind: 'ndi',
        detail: 'Mac sidecar → scopes ingest', ok: true, mock: false, frames: f.frames, lastAt: f.lastAt || null,
      });
    }
    return out;
  }
  register({ id, name } = {}) {
    const clean = cleanId(id);
    if (!clean) throw err('NDI source id: letters, digits, _ and -, 1–64 characters');
    if (clean === 'mock' && this.mockFile) throw err('id "mock" is the built-in frame source');
    const label = cleanName(name, clean);
    const prev = this.feeds.get(clean);
    if (prev) { prev.reset(label); return { ok: true, id: clean, key: `ndi:${clean}`, name: label, replaced: true }; }
    if (this.feeds.size >= MAX_FEEDS) throw err(`at most ${MAX_FEEDS} NDI ingests`, 409);
    this.feeds.set(clean, new NdiFeed(clean, label));
    return { ok: true, id: clean, key: `ndi:${clean}`, name: label };
  }
  push(id, buf, { pts } = {}) {
    const clean = cleanId(id);
    if (!clean) throw err('NDI source id required');
    if (clean === 'mock') throw err('ndi:mock is the built-in frame source; it does not accept pushed frames');
    const feed = this.feeds.get(clean);
    if (!feed) throw err(`no NDI source ${clean} (POST /api/scopes/ndi/register first)`, 404);
    return feed.ingestAnnexB(buf, pts);
  }
  remove(id) {
    const clean = cleanId(id);
    if (!clean) throw err('bad id');
    if (clean === 'mock') throw err('the built-in mock source cannot be removed');
    if (!this.feeds.delete(clean)) throw err(`no NDI source ${clean}`, 404);
    return { ok: true, id: clean };
  }
  /** Relay factory: same shape as service.resolve (make + meta). Null if unknown. */
  resolve(id) {
    const clean = cleanId(id);
    if (!clean) return null;
    if (clean === 'mock' && this.mockFile) {
      const file = this.mockFile;
      return { make: () => new FileInput(file), meta: { label: 'NDI · Mock bars', kind: 'ndi' } };
    }
    const feed = this.feeds.get(clean);
    if (!feed) return null;
    return { make: () => viewOf(feed), meta: { label: `NDI · ${feed.name}`, kind: 'ndi' } };
  }
}

module.exports = { NdiIngest, NdiFeed, toAnnexB, cleanId, viewOf };
