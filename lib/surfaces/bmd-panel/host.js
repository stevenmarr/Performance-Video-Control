'use strict';
// Parent side of the ATEM Micro Panel worker. Events: 'status' ({state, device, error, lease}), 'down' (key),
// 'up' (key), 'tbar' (value 0..1), 'battery' (percent), 'log' (level, msg). `inProcess: { hid }` runs the
// scanner here instead (tests).
const { fork } = require('child_process');
const path = require('path');
const { EventEmitter } = require('events');
const { PanelScanner } = require('./scanner');

class PanelHost extends EventEmitter {
  constructor({ inProcess = null, env = process.env } = {}) {
    super();
    this.inProcess = inProcess; this.env = env;
    this.child = null; this.scanner = null; this.seq = 1; this.pending = new Map(); this.wanted = false; this.delay = 0; this.deaths = 0;
  }
  _msg(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.id && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); p(msg); }
    if (msg.event === 'status') this.emit('status', msg);
    else if (msg.event === 'down' || msg.event === 'up') this.emit(msg.event, msg.key);
    else if (msg.event === 'tbar') this.emit('tbar', msg.value, msg.raw);
    else if (msg.event === 'battery') this.emit('battery', msg.percent);
    else if (msg.event === 'log') this.emit('log', msg.level || 'info', msg.msg || '');
    else if (msg.event === 'ready') this.emit('ready', msg);
  }
  _spawn() {
    const child = fork(path.join(__dirname, 'worker-main.js'), [], { execArgv: [], env: { ...this.env }, silent: false });
    this.child = child;
    child.on('message', (m) => this._msg(m));
    child.on('error', (e) => this.emit('log', 'error', `ATEM Micro Panel worker failed to start: ${e.message}`));
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      for (const p of this.pending.values()) p({ ok: false, error: 'panel worker exited' });
      this.pending.clear();
      if (!this.wanted) return;
      this.deaths++; this.delay = Math.min(30000, this.delay ? this.delay * 2 : 500);
      this.emit('log', 'error', `ATEM Micro Panel worker died (${signal || `exit ${code}`}). Control Center stays up; restarting it in ${this.delay} ms.`);
      this.emit('status', { state: 'searching', device: null, error: 'panel worker restarted' });
      const t = setTimeout(() => { if (this.wanted && !this.child) { this._spawn(); this._rpc('start'); } }, this.delay); if (t.unref) t.unref();
    });
  }
  _rpc(op, body = {}) {
    if (this.scanner) return Promise.resolve({ ok: true });
    if (!this.child || !this.child.connected) return Promise.resolve({ ok: false, error: 'panel worker not running' });
    return new Promise((resolve) => {
      const id = this.seq++;
      const t = setTimeout(() => { if (this.pending.delete(id)) resolve({ ok: false, error: `panel worker timed out (${op})` }); }, 5000); if (t.unref) t.unref();
      this.pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      try { this.child.send({ id, op, ...body }); } catch (e) { this.pending.delete(id); clearTimeout(t); resolve({ ok: false, error: e.message }); }
    });
  }
  start() {
    this.wanted = true;
    if (this.inProcess) {
      if (!this.scanner) this.scanner = new PanelScanner({ hid: this.inProcess.hid, send: (m) => this._msg(m), log: (l, m) => this.emit('log', l, m), scanMs: 50, retryMs: 200 });
      this.scanner.start(); return Promise.resolve({ ok: true });
    }
    if (!this.child) this._spawn();
    return this._rpc('start');
  }
  async setLeds(buf) {
    if (this.scanner) return { ok: true, painted: await this.scanner.leds(buf) };
    return this._rpc('leds', { hex: Buffer.from(buf).toString('hex') });
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

module.exports = { PanelHost };
