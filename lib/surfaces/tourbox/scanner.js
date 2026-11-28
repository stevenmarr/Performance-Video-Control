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
  } = {}) {
    this.listPorts = listPorts;
    this.openPort = openPort;
    this.send = send;
    this.log = log;
    this.scanMs = scanMs;
    this.retryMs = retryMs;
    this.now = now;
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
    let ports = [];
    let other = [];
    try {
      if (typeof this.listPorts.survey === 'function') {
        const survey = await this.listPorts.survey();
        ports = survey.matches || [];
        other = survey.other || [];
      } else {
        ports = await this.listPorts();
      }
    } catch (e) {
      this._status('failed', { error: `could not list serial ports (${e.message})` });
      this._later();
      return;
    }
    if (!ports.length) {
      const seen = other.map((r) => r.path || r).filter(Boolean);
      const error = seen.length
        ? `no matching TourBox (${P.usbIdGuide()}). Ports seen: ${seen.join(', ')}. If yours is plugged in, quit TourBox Console, then Claim.`
        : `no TourBox on USB (looked for ${P.usbIdGuide()}). Plug it in over USB-C, quit TourBox Console, then Claim. Bluetooth is not used.`;
      this._status('searching', { error });
      this.delay = this.scanMs;
      this._later();
      return;
    }
    const d = ports[0];
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
}

module.exports = { TourBoxScanner, MAX_BACKOFF };
