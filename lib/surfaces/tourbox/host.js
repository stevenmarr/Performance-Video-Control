'use strict';
// Parent side of the TourBox worker. Events: 'status' ({state, device, error}),
// 'event' (normalized control event), 'log' (level, msg). `inProcess` runs the
// scanner here instead of a child (tests).
const { fork } = require('child_process');
const path = require('path');
const { EventEmitter } = require('events');
const { TourBoxScanner } = require('./scanner');

class TourBoxHost extends EventEmitter {
  constructor({ inProcess = null, env = process.env } = {}) {
    super();
    this.inProcess = inProcess;
    this.env = env;
    this.child = null;
    this.scanner = null;
    this.seq = 1;
    this.pending = new Map();
    this.wanted = false;
    this.delay = 0;
    this.preferredPort = (inProcess && inProcess.preferredPort) || '';
  }

  setPreferredPort(devPath) {
    this.preferredPort = devPath || '';
    if (this.scanner) this.scanner.setPreferredPort(this.preferredPort);
    if (this.scanner) return Promise.resolve({ ok: true });
    return this._rpc('prefer', { port: this.preferredPort });
  }

  _msg(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.id && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); p(msg); }
    if (msg.event === 'status') this.emit('status', msg);
    else if (msg.event === 'control') this.emit('event', msg.data || msg);
    else if (msg.event === 'log') this.emit('log', msg.level || 'info', msg.msg || '');
    else if (msg.event === 'ready') this.emit('ready', msg);
  }

  _spawn() {
    const child = fork(path.join(__dirname, 'worker-main.js'), [], { execArgv: [], env: { ...this.env }, silent: false });
    this.child = child;
    child.on('message', (m) => this._msg(m));
    child.on('error', (e) => this.emit('log', 'error', `TourBox worker failed to start: ${e.message}`));
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      for (const p of this.pending.values()) p({ ok: false, error: 'TourBox worker exited' });
      this.pending.clear();
      if (!this.wanted) return;
      this.delay = Math.min(30000, this.delay ? this.delay * 2 : 500);
      this.emit('log', 'error', `TourBox worker died (${signal || `exit ${code}`}). Control Center stays up; restarting it in ${this.delay} ms.`);
      this.emit('status', { state: 'searching', device: null, error: 'TourBox worker restarted' });
      const t = setTimeout(() => { if (this.wanted && !this.child) { this._spawn(); this._rpc('start'); } }, this.delay);
      if (t.unref) t.unref();
    });
  }

  _rpc(op, body = {}) {
    if (this.scanner) return Promise.resolve({ ok: true });
    if (!this.child || !this.child.connected) return Promise.resolve({ ok: false, error: 'TourBox worker not running' });
    return new Promise((resolve) => {
      const id = this.seq++;
      const t = setTimeout(() => { if (this.pending.delete(id)) resolve({ ok: false, error: `TourBox worker timed out (${op})` }); }, 5000);
      if (t.unref) t.unref();
      this.pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      try { this.child.send({ id, op, ...body }); } catch (e) { this.pending.delete(id); clearTimeout(t); resolve({ ok: false, error: e.message }); }
    });
  }

  start() {
    this.wanted = true;
    if (this.inProcess) {
      if (!this.scanner) {
        this.scanner = new TourBoxScanner({
          listPorts: this.inProcess.listPorts,
          openPort: this.inProcess.openPort,
          send: (m) => this._msg(m),
          log: (l, m) => this.emit('log', l, m),
          scanMs: this.inProcess.scanMs || 50,
          retryMs: this.inProcess.retryMs || 80,
          preferredPort: this.preferredPort || this.inProcess.preferredPort || '',
        });
      }
      this.scanner.start();
      return Promise.resolve({ ok: true });
    }
    if (!this.child) this._spawn();
    return this._rpc('start', { port: this.preferredPort });
  }

  mock(action, extra = {}) { return this._rpc('mock', { action, ...extra }); }

  async stop() {
    this.wanted = false;
    if (this.scanner) { const s = this.scanner; this.scanner = null; await s.stop(); return; }
    const child = this.child;
    if (!child) return;
    await this._rpc('stop');
    this.child = null;
    await new Promise((resolve) => {
      if (child.exitCode != null || child.signalCode != null) return resolve();
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 2000);
      child.once('exit', () => { clearTimeout(t); resolve(); });
      try { child.disconnect(); } catch { try { child.kill('SIGTERM'); } catch { clearTimeout(t); resolve(); } }
    });
  }
}

module.exports = { TourBoxHost };
