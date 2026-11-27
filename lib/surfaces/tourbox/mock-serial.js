'use strict';
// A pretend TourBox NEO at the serial-port level, for tests and CC_TOURBOX_MOCK=1.
// It records the handshake writes, streams one event byte at a time, and can unplug
// or refuse the open. It proves the decoder and reconnect path, not a real unit.
const { EventEmitter } = require('events');
const P = require('./protocol');

class MockSerialPort extends EventEmitter {
  constructor({ path = 'mock:tourbox-neo', serial = 'MOCKTB01', busy = false } = {}) {
    super();
    this.path = path;
    this.serialNumber = serial;
    this.vendorId = P.VENDOR_ID;
    this.productId = P.PRODUCT_ID;
    this.product = P.PRODUCT_NAME;
    this.busy = busy;
    this.opened = 0;
    this.closed = true;
    this.gone = false;
    this.writes = [];
    this.handshook = false;
  }

  info() {
    return {
      path: this.path,
      vendorId: this.vendorId,
      productId: this.productId,
      serialNumber: this.serialNumber,
      manufacturer: 'TourBox Tech Inc.',
      product: this.product,
    };
  }

  async open() {
    if (this.gone) throw Object.assign(new Error(`cannot open ${this.path}: not present`), { code: 'ENOENT' });
    if (this.busy) throw Object.assign(new Error(`cannot open ${this.path}: resource busy`), { code: 'EBUSY' });
    this.closed = false;
    this.opened += 1;
    this.handshook = false;
    this.writes = [];
    return this;
  }

  write(data, cb) {
    const buf = Buffer.from(data);
    this.writes.push(buf);
    if (buf.equals(P.MAGIC1) || buf.equals(P.MAGIC2)) {
      if (this.writes.some((w) => w.equals(P.MAGIC2))) this.handshook = true;
    }
    if (typeof cb === 'function') queueMicrotask(() => cb(null));
    return true;
  }

  close(cb) {
    this.closed = true;
    this.emit('close');
    if (typeof cb === 'function') queueMicrotask(() => cb(null));
  }

  // --- test controls ---
  _send(code) {
    if (this.closed || this.gone) return;
    this.emit('data', Buffer.from([code & 0xff]));
  }
  press(control) {
    const code = P.BUTTONS[control];
    if (code == null) throw new Error(`unknown control ${control}`);
    this._send(code);
  }
  release(control) {
    const code = P.BUTTONS[control];
    if (code == null) throw new Error(`unknown control ${control}`);
    this._send(code | 0x80);
  }
  tap(control) { this.press(control); this.release(control); }
  turn(control, ticks = 1) {
    const dirs = P.ROTARIES[control];
    if (!dirs) throw new Error(`not a rotary: ${control}`);
    const n = Math.trunc(Number(ticks) || 0);
    if (!n) return;
    const code = n > 0 ? (dirs.cw ?? dirs.up) : (dirs.ccw ?? dirs.down);
    for (let i = 0; i < Math.abs(n); i++) this._send(code);
  }
  unplug() {
    this.gone = true;
    this.closed = true;
    this.emit('error', Object.assign(new Error('the TourBox went away'), { code: 'EIO' }));
    this.emit('close');
  }
  replug() { this.gone = false; this.closed = true; this.busy = false; }
}

// A serialport-shaped list + open around one or more MockSerialPorts.
function mockSerial(ports = [new MockSerialPort()]) {
  return {
    ports,
    async list() { return ports.filter((p) => !p.gone).map((p) => p.info()); },
    async open(path) {
      const p = ports.find((x) => x.path === path && !x.gone);
      if (!p) throw Object.assign(new Error(`cannot open ${path}`), { code: 'ENOENT' });
      await p.open();
      return p;
    },
  };
}

module.exports = { MockSerialPort, mockSerial };
