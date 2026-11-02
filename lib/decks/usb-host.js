'use strict';
// Parent side of the Stream Deck worker. The service process does not load
// node-hid, resvg, or jpeg-turbo. CC_DECK_USB=0 never starts the worker.

const { fork } = require('child_process');
const path = require('path');

function usbDisabled(env = process.env) {
  const v = String(env.CC_DECK_USB == null ? '' : env.CC_DECK_USB).toLowerCase();
  return v === '0' || v === 'false' || v === 'off' || v === 'no';
}

class DisabledUsb {
  constructor() {
    this.isolated = true;
    this.disabled = true;
    this.openErrors = [];
    this.lastReport = { installed: true, disabled: true, found: 0, opened: [], failed: [], skipped: [], error: null };
  }
  status() { return { installed: true, disabled: true, error: null }; }
  onPress() {}
  onRelease() {}
  onTurn() {}
  async scan() { return []; }
  async paint() { return false; }
  async close() {}
  async closeId() { return false; }
  buttonSize() { return null; }
  stop() {}
}

class UsbWorker {
  constructor({ log, testCrash = false } = {}) {
    this.isolated = true;
    this.disabled = false;
    this.openErrors = [];
    this.lastReport = null;
    this._testCrash = !!testCrash;
    this._log = log || (() => {});
    this._press = null;
    this._release = null;
    this._turn = null;
    this._child = null;
    this._seq = 1;
    this._pending = new Map();
    this._ready = null;
    this._readyResolve = null;
    this._readyReject = null;
    this._stop = false;
    this._nextDelay = 0;
    this._deaths = 0;
  }

  onPress(fn) { this._press = fn; }
  onRelease(fn) { this._release = fn; }
  onTurn(fn) { this._turn = fn; }
  status() {
    return { installed: true, worker: true, error: null };
  }
  buttonSize() { return null; }

  _spawn() {
    const env = { ...process.env, CC_DECK_WORKER: '1' };
    if (this._testCrash) env.CC_DECK_TEST = '1';
    else delete env.CC_DECK_TEST;
    const child = fork(path.join(__dirname, 'worker-main.js'), [], {
      execArgv: [],
      env,
      silent: false,
    });
    this._child = child;
    this._ready = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    child.on('message', (msg) => this._onMessage(msg));
    child.on('error', (err) => {
      this._log('error', `USB deck worker failed to start: ${err.message}`);
    });
    child.on('exit', (code, signal) => this._onExit(child, code, signal));
  }

  _onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.event === 'ready') {
      if (this._readyResolve) this._readyResolve();
      return;
    }
    if (msg.event === 'log') {
      this._log(msg.level || 'info', msg.msg || '');
      return;
    }
    if (msg.event === 'press' && this._press) this._press(msg.deviceId, msg.at || {});
    else if (msg.event === 'release' && this._release) this._release(msg.deviceId, msg.at || {});
    else if (msg.event === 'turn' && this._turn) this._turn(msg.deviceId, msg.at || {});
    if (msg.id && this._pending.has(msg.id)) {
      const pending = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      pending.resolve(msg);
    }
  }

  _onExit(child, code, signal) {
    if (this._child !== child) return;
    this._child = null;
    const why = signal ? `signal ${signal}` : `exit ${code}`;
    const native = signal === 'SIGSEGV' || signal === 'SIGBUS' || signal === 'SIGABRT' || signal === 'SIGILL';
    this._deaths += 1;
    this._nextDelay = Math.min(30000, this._nextDelay ? this._nextDelay * 2 : 500);
    const hint = native
      ? ' A native library crashed while painting a deck. jpeg-turbo is not used on Node 18. If this repeats, set CC_DECK_USB=0 and restart the service.'
      : '';
    this._log('error', `USB deck worker died (${why}). Control Center stays up. The deck worker will restart.${hint}`);
    const err = new Error(`USB deck worker died (${why})`);
    for (const pending of this._pending.values()) pending.reject(err);
    this._pending.clear();
    if (this._readyReject) this._readyReject(err);
    this._ready = null;
    this._readyResolve = null;
    this._readyReject = null;
  }

  async _ensure() {
    if (this._stop) throw new Error('USB decks are stopped');
    if (this._child && this._child.connected) {
      await this._ready;
      return;
    }
    const wait = this._nextDelay;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    if (this._stop) throw new Error('USB decks are stopped');
    if (this._child && this._child.connected) {
      await this._ready;
      return;
    }
    this._spawn();
    await this._ready;
  }

  _rpc(op, body = {}) {
    return this._ensure().then(() => new Promise((resolve, reject) => {
      const id = this._seq++;
      const timer = setTimeout(() => {
        if (!this._pending.has(id)) return;
        this._pending.delete(id);
        reject(new Error(`USB deck worker timed out during ${op}`));
      }, 20000);
      if (timer.unref) timer.unref();
      this._pending.set(id, {
        resolve: (msg) => { clearTimeout(timer); resolve(msg); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      try {
        this._child.send({ id, op, ...body });
      } catch (e) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(e);
      }
    }));
  }

  async scan({ claim } = {}) {
    const listed = await this._rpc('list');
    if (listed && listed.installed === false) {
      this.lastReport = { installed: false, error: listed.error, found: 0, opened: [], failed: [], skipped: [] };
      this.openErrors = [];
      return [];
    }
    const skip = [];
    for (const device of (listed && listed.devices) || []) {
      if (claim && claim({ path: device.path, serialNumber: device.serial, model: device.model }) === false) skip.push(device.path);
    }
    const res = await this._rpc('scan', { skip });
    if (!res.ok) throw new Error(res.error || 'USB deck scan failed');
    this.lastReport = res.report || null;
    this.openErrors = Array.isArray(res.openErrors) ? res.openErrors : [];
    if (this.lastReport && this.lastReport.installed !== false) this._nextDelay = 0;
    return res.devices || [];
  }

  async paint(id, keys, face) {
    const res = await this._rpc('paint', { deviceId: id, keys: keys || [], face: face || null });
    if (!res.ok) throw new Error(res.error || 'USB deck paint failed');
    return !!res.painted;
  }

  async closeId(id) {
    const res = await this._rpc('closeId', { deviceId: id });
    return !!(res && res.closed);
  }

  async close() {
    if (!this._child) return;
    try { await this._rpc('close'); } catch { /* worker already gone */ }
  }

  async die() {
    try { await this._rpc('die'); } catch { /* the worker is supposed to die */ }
  }

  stop() {
    this._stop = true;
    const child = this._child;
    this._child = null;
    for (const pending of this._pending.values()) pending.reject(new Error('USB decks stopped'));
    this._pending.clear();
    if (child) {
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
    }
  }
}

function createDeckUsb(opts = {}) {
  if (usbDisabled(opts.env || process.env)) return new DisabledUsb();
  if (String(process.env.CC_DECK_INPROCESS || '') === '1') return new (require('./usb').UsbDecks)();
  return new UsbWorker(opts);
}

module.exports = { createDeckUsb, usbDisabled, UsbWorker, DisabledUsb };
