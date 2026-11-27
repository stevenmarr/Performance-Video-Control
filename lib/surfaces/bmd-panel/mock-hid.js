'use strict';
// A pretend ATEM Micro Panel at the HID level, for tests and `CC_BMD_PANEL_MOCK=1`. It sets a random
// challenge, checks the answer with protocol.authResponse, grants a lease, stays silent until answered,
// records every lamp report, and lets a test press keys and move the T-bar. It only checks that Control
// Center answers the way node-blackmagic-controller does; it proves nothing about a real panel.
const { EventEmitter } = require('events');
const crypto = require('crypto');
const P = require('./protocol');

class MockPanel extends EventEmitter {
  constructor({ path = 'mock:atem-micro-panel', serial = 'MOCK0001', lease = 600, refuse = false } = {}) {
    super();
    this.path = path; this.serial = serial; this.leaseS = lease; this.refuse = refuse;
    this.step = -1; this.challenge = 0n; this.authed = false; this.auths = 0; this.leds = []; this.closed = false; this.opened = 0;
    this.held = [];
  }
  info() { return { vendorId: P.VENDOR_ID, productId: P.PRODUCT_ID, path: this.path, serialNumber: this.serial, product: P.PRODUCT_NAME, manufacturer: 'Blackmagic Design', interface: 2 }; }
  // --- the HIDAsync surface ---
  async sendFeatureReport(data) {
    const b = Buffer.from(data);
    if (b[0] !== P.REPORT.auth) throw new Error('mock panel: unknown feature report');
    const step = b[1];
    if (step === 0) { this.step = 0; this.challenge = crypto.randomBytes(8).readBigUInt64LE(0); this.authed = false; }
    else if (step === 1) this.step = 1;
    else if (step === 3) { this.step = 3; this.answerOk = !this.refuse && b.readBigUInt64LE(2) === P.authResponse(this.challenge); if (this.answerOk) { this.authed = true; this.auths++; } }
    return b.length;
  }
  async getFeatureReport(id, len) {
    const b = Buffer.alloc(len); b[0] = id;
    if (this.step === 0) { b[1] = 0; b.writeBigUInt64LE(this.challenge, 2); }
    else if (this.step === 1) { b[1] = 2; }
    else if (this.step === 3) { b[1] = this.answerOk ? 0x04 : 0x00; b.writeUInt16LE(this.leaseS, 2); }
    return b;
  }
  async write(data) { const b = Buffer.from(data); if (!this.authed) return b.length; this.leds.push(b); this.emit('leds', b); return b.length; }
  async close() { this.closed = true; this.emit('closed'); }
  // --- test controls ---
  _report(buf) { if (this.authed && !this.closed) this.emit('data', buf); }
  hold(ids) {
    this.held = [...ids];
    const b = Buffer.alloc(1 + 2 * 6 + 2); b[0] = P.REPORT.buttons;
    this.held.slice(0, 6).forEach((id, i) => b.writeUInt16LE(P.BY_ID.get(id).code, 1 + 2 * i));
    this._report(b);
  }
  press(id) { this.hold([...this.held.filter((k) => k !== id), id]); }
  release(id) { this.hold(this.held.filter((k) => k !== id)); }
  tap(id) { this.press(id); this.release(id); }
  tbar(value) { const b = Buffer.alloc(3); b[0] = P.REPORT.tbar; b.writeUInt16LE(Math.round(Math.max(0, Math.min(1, value)) * P.TBAR_MAX), 1); this._report(b); }
  battery(pct) { this._report(Buffer.from([P.REPORT.battery, 0, pct])); }
  unplug() { this.emit('error', new Error('could not read from HID device')); }
  lastLeds() { return this.leds.length ? P.decodeLeds(this.leds[this.leds.length - 1]) : null; }
}

// A node-hid shaped module around one or more MockPanels.
function mockHid(panels = [new MockPanel()]) {
  return {
    panels,
    async devicesAsync() { return panels.filter((p) => !p.gone).map((p) => p.info()); },
    HIDAsync: { async open(path) { const p = panels.find((x) => x.path === path && !x.gone); if (!p) throw new Error(`cannot open device with path ${path}`); p.closed = false; p.opened++; p.step = -1; p.authed = false; return p; } },
  };
}

module.exports = { MockPanel, mockHid };
