'use strict';
// Claim the first TourBox we can open, handshake, and reconnect after unplug,
// sleep, or a busy port (TourBox Console still holding it). Backoff is 1s, 2s, 4s
// … up to 30s. Status: off, searching, connecting, connected, blocked, failed.
const { TourBoxDevice } = require('./device');
const serial = require('./serial');
const P = require('./protocol');

const MAX_BACKOFF = 30000;

class TourBoxScanner {
  constructor({
    listPorts = serial.listPorts,
    openPort = serial.openPort,
    send = () => {},
    log = () => {},
    scanMs = 1500,
    retryMs = 1000,
    now = () => Date.now(),
    preferredPort = '',
  } = {}) {
    this.listPorts = listPorts;
    this.openPort = openPort;
    this.send = send;
    this.log = log;
    this.scanMs = scanMs;
    this.retryMs = retryMs;
    this.now = now;
    this.preferredPort = preferredPort || '';
    this.running = false;
    this.dev = null;
    this.info = null;
    this.timer = null;
    this.delay = retryMs;
    this.state = 'off';
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.delay = this.retryMs;
    this._loop();
  }

  setPreferredPort(devPath) {
    const next = devPath ? P.preferCalloutPath(devPath) : '';
    const prev = this.preferredPort || '';
    this.preferredPort = next;
    if (!this.running || prev === next) return;
    const current = this.info && this.info.path;
    if (this.dev && current && next && current === next) return;
    const dev = this.dev;
    this.dev = null;
    this.info = null;
    if (dev) dev.close().catch(() => {});
    this.delay = this.retryMs;
    this._loop();
  }

  _status(state, extra = {}) {
    this.state = state;
    this.send({ event: 'status', state, device: this.info, error: extra.error || null, ...extra });
  }

  _loop() {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this._scan().catch((e) => this.log('warn', `TourBox scan: ${e.message}`));
  }

  _later() {
    if (!this.running) return;
    const wait = this.delay;
    this.delay = Math.min(MAX_BACKOFF, Math.max(this.retryMs, this.delay * 2));
    this.timer = setTimeout(() => this._loop(), wait);
    if (this.timer.unref) this.timer.unref();
  }

  async _scan() {
    if (!this.running || this.dev) return;
    let matches = [];
    let candidates = [];
    let other = [];
    try {
      if (typeof this.listPorts.survey === 'function') {
        const survey = await this.listPorts.survey();
        matches = survey.matches || [];
        candidates = survey.candidates || [];
        other = survey.other || [];
      } else {
        matches = await this.listPorts();
      }
    } catch (e) {
      this._status('failed', { error: `could not list serial ports (${e.message})` });
      this._later();
      return;
    }
    const all = [...matches, ...candidates, ...other];
    const preferred = this.preferredPort ? P.preferCalloutPath(this.preferredPort) : '';
    let d = null;
    if (preferred) {
      d = all.find((r) => r.path === preferred) || { path: preferred, product: 'chosen port' };
    } else if (matches.length) {
      d = matches[0];
    }
    if (!d) {
      const error = this._searchError({ matches, candidates, other });
      this._status('searching', { error });
      this.delay = this.scanMs;
      this._later();
      return;
    }
    this.info = { path: d.path, serial: d.serialNumber || null, product: d.product || P.PRODUCT_NAME, vendorId: d.vendorId, productId: d.productId };
    this._status('connecting');
    let handle = null;
    try {
      handle = await this.openPort(d.path);
      const dev = new TourBoxDevice(handle, { path: d.path, log: this.log, now: this.now });
      await dev.open();
      if (!this.running) { await dev.close(); return; }
      this.dev = dev;
      this.delay = this.retryMs;
      dev.on('event', (ev) => this.send({ event: 'control', data: ev }));
      dev.on('error', (e) => this.log('warn', `TourBox: ${e.message}`));
      dev.on('close', () => {
        if (this.dev === dev) {
          this.dev = null;
          this.info = null;
          if (this.running) {
            this._status('searching', { error: 'the TourBox went away (unplugged or the port closed)' });
            this.delay = this.retryMs;
            this._loop();
          }
        }
      });
      this._status('connected');
    } catch (e) {
      if (handle && typeof handle.close === 'function') {
        try { await new Promise((r) => handle.close(() => r())); } catch { /* gone */ }
      }
      const busy = /busy|exclusive|access|EACCES|EBUSY|resource locked|in use/i.test(String(e.message) + (e.code || ''));
      const msg = busy
        ? `TourBox Console or another app is using the device — quit Console, then Claim (${e.message})`
        : `the TourBox did not answer the handshake (${e.message})`;
      this._status(busy ? 'blocked' : 'failed', { error: msg });
      this._later();
    }
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const dev = this.dev;
    this.dev = null;
    this.info = null;
    if (dev) await dev.close();
    this._status('off');
  }
  _searchError({ candidates = [], other = [] } = {}) {
    const label = (r) => {
      const path = r.path || r;
      const name = r.product || r.manufacturer || '';
      return name ? `${path} (${name})` : path;
    };
    if (candidates.length) {
      return `possible TourBox (${P.usbIdGuide()}): ${candidates.map(label).join(', ')}. Choose it under Port, click Use this port, then CLAIM. Quit TourBox Console first.`;
    }
    const seen = other.map((r) => r.path || r).filter(Boolean);
    if (seen.length) {
      return `no matching TourBox (${P.usbIdGuide()}). Ports seen: ${seen.join(', ')}. Pick the port, click Use this port, then CLAIM. If it is plugged in, quit TourBox Console first.`;
    }
    return `no TourBox on USB (looked for ${P.usbIdGuide()}). Plug it in over USB-C, quit TourBox Console, pick the port if it shows up as a CP2104, then CLAIM. Bluetooth is not used.`;
  }
}

module.exports = { TourBoxScanner, MAX_BACKOFF };
