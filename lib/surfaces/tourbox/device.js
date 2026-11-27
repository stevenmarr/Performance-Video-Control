'use strict';
// One open TourBox NEO: handshake, exclusive use, and a stream of normalized events.
// Events: { control, event, ticks, dtMs, held, at, code }. No camera logic here.
const { EventEmitter } = require('events');
const P = require('./protocol');

const DRAIN_MS = 100;

class TourBoxDevice extends EventEmitter {
  constructor(port, { path = null, now = () => Date.now(), timers = { setTimeout, clearTimeout }, log = () => {} } = {}) {
    super();
    this.port = port;
    this.path = path || port.path || null;
    this.now = now;
    this.timers = timers;
    this.log = log;
    this.held = new Set();
    this.lastTurnAt = new Map();
    this.closed = false;
    this._onData = (data) => this._input(data);
    this._onError = (e) => this._fail(e);
    this._onClose = () => { if (!this.closed) this._fail(new Error('the TourBox port closed')); };
  }

  async open() {
    if (this.port.on) {
      this.port.on('data', this._onData);
      this.port.on('error', this._onError);
      this.port.on('close', this._onClose);
    }
    this._ignore = true;
    await this._write(P.MAGIC1);
    await this._sleep(DRAIN_MS);
    await this._write(P.MAGIC2);
    this._ignore = false;
    return this;
  }

  _write(buf) {
    return new Promise((resolve, reject) => {
      const ok = this.port.write(buf, (err) => err ? reject(err) : resolve());
      if (ok === false && typeof this.port.drain === 'function') this.port.drain((err) => err ? reject(err) : resolve());
    });
  }

  _sleep(ms) {
    return new Promise((resolve) => { const t = this.timers.setTimeout(resolve, ms); if (t && t.unref) t.unref(); });
  }

  _input(data) {
    if (this.closed || this._ignore) return;
    const events = P.decodeBuffer(data);
    const at = this.now();
    for (const ev of events) {
      if (!ev.control) continue;
      let dtMs = null;
      if (ev.event === 'press') this.held.add(ev.control);
      else if (ev.event === 'release') this.held.delete(ev.control);
      else if (ev.event === 'turn') {
        const prev = this.lastTurnAt.get(ev.control);
        dtMs = prev == null ? null : Math.max(0, at - prev);
        this.lastTurnAt.set(ev.control, at);
      }
      this.emit('event', {
        control: ev.control,
        event: ev.event,
        ticks: ev.event === 'turn' ? ev.ticks : 0,
        dtMs,
        held: [...this.held],
        at,
        code: ev.code,
        source: ev.source || 'serial',
      });
    }
  }

  _fail(e) {
    if (this.closed) return;
    this.emit('error', e instanceof Error ? e : new Error(String(e)));
    this.close().catch(() => {});
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.port.off) {
        this.port.off('data', this._onData);
        this.port.off('error', this._onError);
        this.port.off('close', this._onClose);
      } else if (this.port.removeListener) {
        this.port.removeListener('data', this._onData);
        this.port.removeListener('error', this._onError);
        this.port.removeListener('close', this._onClose);
      }
    } catch { /* gone */ }
    try {
      await new Promise((resolve) => {
        if (typeof this.port.close === 'function') this.port.close(() => resolve());
        else resolve();
      });
    } catch { /* already closed */ }
    this.emit('close');
  }
}

module.exports = { TourBoxDevice, DRAIN_MS };
