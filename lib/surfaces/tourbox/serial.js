'use strict';
// Open a TourBox NEO CDC port and find units by VID/PID. serialport is optional.
// When it is missing, Linux and macOS fall back to stty + fs so the Pi does not
// need another native addon. Tests inject a mock open/list and never touch a real port.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const P = require('./protocol');

function trySerialport() {
  try { return require('serialport'); } catch { return null; }
}

function walkVendor(start) {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const vendor = path.join(dir, 'idVendor');
    const product = path.join(dir, 'idProduct');
    if (fs.existsSync(vendor) && fs.existsSync(product)) {
      return {
        vendorId: parseInt(fs.readFileSync(vendor, 'utf8').trim(), 16),
        productId: parseInt(fs.readFileSync(product, 'utf8').trim(), 16),
        serialNumber: fs.existsSync(path.join(dir, 'serial')) ? fs.readFileSync(path.join(dir, 'serial'), 'utf8').trim() : '',
        manufacturer: fs.existsSync(path.join(dir, 'manufacturer')) ? fs.readFileSync(path.join(dir, 'manufacturer'), 'utf8').trim() : '',
        product: fs.existsSync(path.join(dir, 'product')) ? fs.readFileSync(path.join(dir, 'product'), 'utf8').trim() : '',
      };
    }
    const parent = path.resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function listLinux(io = fs) {
  const out = [];
  let names = [];
  try { names = io.readdirSync('/dev'); } catch { return out; }
  for (const name of names) {
    if (!/^ttyACM|^ttyUSB/.test(name)) continue;
    const devPath = `/dev/${name}`;
    const sys = `/sys/class/tty/${name}/device`;
    let real = sys;
    try { real = io.realpathSync(sys); } catch { /* keep */ }
    const ids = walkVendor(real);
    if (!ids) continue;
    if (ids.vendorId !== P.VENDOR_ID || ids.productId !== P.PRODUCT_ID) continue;
    out.push({ path: devPath, ...ids });
  }
  return out;
}

function parseIoreg(text) {
  const blocks = String(text || '').split(/\n\s*\n/);
  const out = [];
  for (const block of blocks) {
    const vid = /idVendor[^\d]+(\d+)/.exec(block);
    const pid = /idProduct[^\d]+(\d+)/.exec(block);
    if (!vid || !pid) continue;
    if (Number(vid[1]) !== P.VENDOR_ID || Number(pid[1]) !== P.PRODUCT_ID) continue;
    const dial = /"IODialinDevice"\s*=\s*"([^"]+)"/.exec(block) || /"IOCalloutDevice"\s*=\s*"([^"]+)"/.exec(block);
    if (!dial) continue;
    const serial = /"USB Serial Number"\s*=\s*"([^"]+)"/.exec(block);
    const product = /"USB Product Name"\s*=\s*"([^"]+)"/.exec(block);
    out.push({
      path: dial[1],
      vendorId: P.VENDOR_ID,
      productId: P.PRODUCT_ID,
      serialNumber: serial ? serial[1] : '',
      product: product ? product[1] : P.PRODUCT_NAME,
    });
  }
  return out;
}

function listDarwin(exec = execFile) {
  return new Promise((resolve) => {
    exec('ioreg', ['-r', '-c', 'IOSerialBSDClient', '-l'], { timeout: 4000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(parseIoreg(String(stdout || '')));
    });
  });
}

async function listPorts({ platform = process.platform, serialport = trySerialport(), io = fs, exec = execFile } = {}) {
  const found = new Map();
  const add = (row) => { if (row && row.path && !found.has(row.path)) found.set(row.path, row); };
  if (serialport && typeof serialport.SerialPort === 'function' && typeof serialport.SerialPort.list === 'function') {
    try {
      const list = await serialport.SerialPort.list();
      for (const row of list) {
        const vendorId = parseInt(String(row.vendorId || ''), 16);
        const productId = parseInt(String(row.productId || ''), 16);
        if (vendorId === P.VENDOR_ID && productId === P.PRODUCT_ID) {
          add({
            path: row.path,
            vendorId, productId,
            serialNumber: row.serialNumber || '',
            manufacturer: row.manufacturer || '',
            product: row.product || P.PRODUCT_NAME,
          });
        }
      }
    } catch { /* fall through to sysfs / ioreg */ }
  }
  if (platform === 'linux') for (const row of listLinux(io)) add(row);
  if (platform === 'darwin') for (const row of await listDarwin(exec)) add(row);
  return [...found.values()];
}

function sttyArgs(devPath, platform = process.platform) {
  const flag = platform === 'darwin' ? '-f' : '-F';
  return [flag, devPath, String(P.BAUD), 'cs8', '-cstopb', '-parenb', '-echo', 'raw', 'clocal', 'cread', 'min', '1', 'time', '0'];
}

function runStty(devPath, { platform = process.platform, exec = execFile } = {}) {
  return new Promise((resolve, reject) => {
    exec('stty', sttyArgs(devPath, platform), { timeout: 3000 }, (err) => {
      if (err) reject(Object.assign(new Error(`could not set 115200 8N1 on ${devPath}: ${err.message}`), { code: err.code }));
      else resolve();
    });
  });
}

// A small SerialPort-shaped wrapper around an already-configured fd.
class RawPort extends EventEmitter {
  constructor(devPath, fd) {
    super();
    this.path = devPath;
    this.fd = fd;
    this._reading = false;
    this._buf = Buffer.alloc(64);
    this._closed = false;
  }
  _pump() {
    if (this._closed || this._reading) return;
    this._reading = true;
    fs.read(this.fd, this._buf, 0, this._buf.length, null, (err, n) => {
      this._reading = false;
      if (this._closed) return;
      if (err) {
        if (err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK' || err.code === 'EINTR') {
          setTimeout(() => this._pump(), 20);
          return;
        }
        this.emit('error', err);
        return;
      }
      if (n > 0) this.emit('data', Buffer.from(this._buf.subarray(0, n)));
      this._pump();
    });
  }
  write(data, cb) {
    if (this._closed) {
      const e = new Error('port is closed');
      if (cb) cb(e);
      return false;
    }
    const buf = Buffer.from(data);
    fs.write(this.fd, buf, 0, buf.length, null, (err) => { if (cb) cb(err || null); });
    return true;
  }
  close(cb) {
    if (this._closed) { if (cb) cb(null); return; }
    this._closed = true;
    try { fs.closeSync(this.fd); } catch { /* already closed */ }
    this.emit('close');
    if (cb) cb(null);
  }
  start() { this._pump(); }
}

async function openRaw(devPath, { platform = process.platform, exec = execFile, openSync = fs.openSync } = {}) {
  await runStty(devPath, { platform, exec });
  const flags = (fs.constants.O_RDWR | (fs.constants.O_NOCTTY || 0) | (fs.constants.O_NONBLOCK || 0));
  const fd = openSync(devPath, flags);
  const port = new RawPort(devPath, fd);
  port.start();
  return port;
}

async function openPort(devPath, { serialport = trySerialport(), platform = process.platform, exec = execFile, openSync = fs.openSync } = {}) {
  if (serialport && typeof serialport.SerialPort === 'function') {
    const port = new serialport.SerialPort({ path: devPath, baudRate: P.BAUD, autoOpen: false, lock: true });
    await new Promise((resolve, reject) => port.open((err) => err ? reject(err) : resolve()));
    return port;
  }
  return openRaw(devPath, { platform, exec, openSync });
}

module.exports = { trySerialport, listPorts, listLinux, parseIoreg, sttyArgs, openPort, openRaw, RawPort };
