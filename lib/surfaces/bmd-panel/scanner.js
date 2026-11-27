'use strict';
// Finds an ATEM Micro Panel (1edb:bef0, USB or Bluetooth), opens it, keeps it, and reopens it after an
// unplug. Runs inside the panel worker process (./worker-main.js) so a native HID fault cannot take Control
// Center down; tests run it in process with ./mock-hid.js. `send(msg)` reports to the parent.
const P = require('./protocol');
const { PanelDevice } = require('./device');

const SCAN_MS = 2000; const RETRY_FAILED_MS = 10000;

class PanelScanner {
  constructor({ hid, send = () => {}, log = () => {}, scanMs = SCAN_MS, retryMs = RETRY_FAILED_MS } = {}) {
    this.hid = hid; this.send = send; this.log = log; this.scanMs = scanMs; this.retryMs = retryMs;
    this.dev = null; this.info = null; this.running = false; this.timer = null; this.failed = new Map(); this.state = 'off'; this._busy = false;
  }
  _status(state, extra = {}) { this.state = state; this.send({ event: 'status', state, device: this.info, ...extra }); }

  start() {
    if (this.running) return;
    this.running = true;
    if (!this.hid) { this._status('no-hid', { error: 'node-hid is not installed, so Control Center cannot open the panel' }); return; }
    this._status('searching');
    this._tick();
  }

  _loop() { if (!this.running || this.timer) return; this.timer = setTimeout(() => { this.timer = null; this._tick(); }, this.scanMs); if (this.timer.unref) this.timer.unref(); }

  async _tick() {
    if (!this.running || this.dev || this._busy) return this._loop();
    this._busy = true;
    try {
      const list = (await this.hid.devicesAsync()).filter(P.isPanel);
      if (!list.length && this.state !== 'searching') this._status('searching');
      // Several HID interfaces can match; try each until one answers the handshake.
      for (const d of list) {
        if (!this.running || this.dev) break;
        const failedAt = this.failed.get(d.path);
        if (failedAt && Date.now() - failedAt < this.retryMs) continue;
        await this._open(d);
      }
    } catch (e) {
      this._status('error', { error: `listing HID devices failed: ${e.message}` });
    } finally { this._busy = false; this._loop(); }
  }

  async _open(d) {
    let handle = null;
    this.info = { path: d.path, serial: d.serialNumber || '', product: d.product || P.PRODUCT_NAME, interface: d.interface, transport: /bluetooth|bt/i.test(String(d.path)) || d.busType === 2 ? 'bluetooth' : 'usb' };
    this._status('authenticating');
    try {
      handle = await this.hid.HIDAsync.open(d.path);
      const dev = new PanelDevice(handle, { path: d.path, log: this.log });
      const { lease } = await dev.open();
      if (!this.running) { await dev.close(); return; }
      this.dev = dev; this.failed.delete(d.path);
      dev.on('down', (key) => this.send({ event: 'down', key }));
      dev.on('up', (key) => this.send({ event: 'up', key }));
      dev.on('tbar', (value, raw) => this.send({ event: 'tbar', value, raw }));
      dev.on('battery', (percent) => this.send({ event: 'battery', percent }));
      dev.on('error', (e) => { this.log('warn', `ATEM Micro Panel: ${e.message}`); });
      dev.on('close', () => { if (this.dev === dev) { this.dev = null; this.info = null; if (this.running) { this._status('searching', { error: 'the panel went away (unplugged, switched off or out of Bluetooth range)' }); this._loop(); } } });
      await dev.clear();
      this._status('connected', { lease });
    } catch (e) {
      this.failed.set(d.path, Date.now());
      if (handle) { try { await handle.close(); } catch { /* gone */ } }
      const busy = /exclusive|access|busy|privilege|cannot open/i.test(e.message);
      this._status(busy ? 'busy' : 'refused', { error: busy ? `could not open the panel (${e.message}). Another program may have it (turn off Companion's Blackmagic controller surface), or the udev rule is missing so Control Center cannot open /dev/hidraw` : `the panel did not answer the handshake (${e.message})` });
    }
  }

  async leds(buf) { if (this.dev) return this.dev.setLeds(buf); return false; }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    const dev = this.dev; this.dev = null; this.info = null;
    if (dev) { try { await dev.clear(); } catch { /* gone */ } await dev.close(); }
    this._status('off');
  }
}

module.exports = { PanelScanner };
