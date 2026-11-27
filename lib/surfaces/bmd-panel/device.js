'use strict';
// One open ATEM Micro Panel: answers the handshake, renews it at half the lease, turns input reports into
// key down / up, T-bar and battery events, and writes the lamp report. `handle` is a node-hid HIDAsync
// (or the mock in ./mock-hid.js): on('data'), on('error'), write(buf), sendFeatureReport(buf),
// getFeatureReport(id, len), close(). No ATEM logic here.
const { EventEmitter } = require('events');
const P = require('./protocol');

const RETRY_S = 15; const MAX_TRIES = 3;

class PanelDevice extends EventEmitter {
  constructor(handle, { path = '', log = () => {}, timers = { setTimeout, clearTimeout } } = {}) {
    super();
    this.handle = handle; this.path = path; this.log = log; this.timers = timers;
    this.held = []; this.tbarRaw = null; this.battery = null; this.lease = null; this.closed = false;
    this._auth = null; this._lastLeds = null;
    this._onData = (d) => this._input(d);
    this._onError = (e) => this._fail(e);
  }

  async open() {
    this.lease = await P.authenticate(this.handle);
    this.handle.on('data', this._onData);
    this.handle.on('error', this._onError);
    this._schedule(this.lease || 600, 1);
    return { lease: this.lease };
  }

  _schedule(leaseS, attempt) {
    if (this.closed) return;
    if (this._auth) this.timers.clearTimeout(this._auth);
    this._auth = this.timers.setTimeout(() => {
      this._auth = null;
      P.authenticate(this.handle).then((next) => { this.lease = next; this._schedule(next || 600, 1); }).catch((e) => {
        if (attempt < MAX_TRIES) { this.log('warn', `ATEM Micro Panel: handshake renewal failed (${e.message}); retrying in ${RETRY_S} s`); this._schedule(RETRY_S * 2, attempt + 1); } else this._fail(new Error(`handshake renewal failed: ${e.message}`));
      });
    }, Math.max(1, leaseS) * 500); // half the lease
    if (this._auth && this._auth.unref) this._auth.unref();
  }

  _input(data) {
    const r = P.decodeInput(data);
    if (!r) return;
    if (r.type === 'keys') {
      const { down, up } = P.diffHeld(this.held, r.held);
      this.held = r.held;
      for (const k of up) this.emit('up', k);
      for (const k of down) this.emit('down', k);
    } else if (r.type === 'tbar') {
      if (r.raw === this.tbarRaw) return;
      this.tbarRaw = r.raw; this.emit('tbar', r.value, r.raw);
    } else if (r.type === 'battery') { this.battery = r.percent; this.emit('battery', r.percent); }
  }

  // frame = { keys, tbar } (see protocol.encodeLeds) or a ready Buffer. Unchanged frames are not re-sent.
  async setLeds(frame, { force = false } = {}) {
    if (this.closed) return false;
    const buf = Buffer.isBuffer(frame) ? frame : P.encodeLeds(frame);
    if (!force && this._lastLeds && this._lastLeds.equals(buf)) return false;
    this._lastLeds = buf;
    await this.handle.write([...buf]);
    return true;
  }

  async clear() { return this.setLeds({}, { force: true }); }

  _fail(e) {
    if (this.closed) return;
    this.emit('error', e instanceof Error ? e : new Error(String(e)));
    this.close().catch(() => {});
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this._auth) this.timers.clearTimeout(this._auth); this._auth = null;
    try { this.handle.removeListener('data', this._onData); this.handle.removeListener('error', this._onError); } catch { /* gone */ }
    try { await this.handle.close(); } catch { /* already closed */ }
    this.emit('close');
  }
}

module.exports = { PanelDevice };
