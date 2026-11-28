'use strict';
// Open a TourBox CDC port and find units by VID/PID. serialport is optional.
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

function rowFromIds(devPath, ids) {
  return {
    path: P.preferCalloutPath(devPath),
    vendorId: ids.vendorId,
    productId: ids.productId,
    serialNumber: ids.serialNumber || '',
    manufacturer: ids.manufacturer || '',
    product: P.productNameFor(ids),
  };
}

function listLinux(io = fs) {
  return collectLinux(io).matches;
}

function collectLinux(io = fs) {
  const matches = [];
  const other = [];
  let names = [];
  try { names = io.readdirSync('/dev'); } catch { return { matches, other }; }
  for (const name of names) {
    if (!/^ttyACM|^ttyUSB/.test(name)) continue;
    const devPath = `/dev/${name}`;
    const sys = `/sys/class/tty/${name}/device`;
    let real = sys;
    try { real = io.realpathSync(sys); } catch { /* keep */ }
    const ids = walkVendor(real);
    if (!ids) { other.push({ path: devPath }); continue; }
    if (P.isTourBoxUsb(ids)) matches.push(rowFromIds(devPath, ids));
    else other.push(rowFromIds(devPath, ids));
  }
  return { matches, other };
}

function parseNum(raw) {
  const s = String(raw || '').trim();
  if (/^0x/i.test(s)) return parseInt(s, 16);
  const n = Number(s.replace(/[^\d]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

function parseQuoted(raw) {
  const m = /"([^"]*)"/.exec(String(raw || ''));
  return m ? m[1] : String(raw || '').trim();
}

function inherit(parent) {
  return {
    vendorId: parent && parent.vendorId,
    productId: parent && parent.productId,
    serialNumber: (parent && parent.serialNumber) || '',
    manufacturer: (parent && parent.manufacturer) || '',
    product: (parent && parent.product) || '',
  };
}

function applyIoregProp(cur, key, raw) {
  if (key === 'idVendor') cur.vendorId = parseNum(raw);
  else if (key === 'idProduct') cur.productId = parseNum(raw);
  else if (key === 'USB Serial Number' || key === 'USB SerialNumber') cur.serialNumber = parseQuoted(raw);
  else if (key === 'USB Vendor Name' || key === 'kUSBVendorString') cur.manufacturer = parseQuoted(raw);
  else if (key === 'USB Product Name' || key === 'kUSBProductString') cur.product = parseQuoted(raw);
  else if (key === 'IOCalloutDevice') cur.callout = parseQuoted(raw);
  else if (key === 'IODialinDevice') cur.dialin = parseQuoted(raw);
}

function recordSerialNode(node, matches, other) {
  const rawPath = node.callout || node.dialin;
  if (!rawPath) return;
  const row = rowFromIds(rawPath, node);
  if (P.isTourBoxUsb(node)) matches.push(row);
  else other.push(row);
}

// Real macOS ioreg puts idVendor on the parent IOUSBHostDevice and IOCalloutDevice
// on the child IOSerialBSDClient. The old same-block parser only worked on a
// synthetic fixture. Walk the indented tree and inherit USB IDs down to the cu.* path.
function parseIoregTree(text, matches, other) {
  const stack = [];
  for (const rawLine of String(text || '').split(/\n/)) {
    const objAt = rawLine.indexOf('+-o ');
    if (objAt !== -1 && /(?:^|[\s|])\+-o /.test(rawLine)) {
      while (stack.length && stack[stack.length - 1].indent >= objAt) stack.pop();
      const parent = stack[stack.length - 1];
      stack.push({ indent: objAt, ...inherit(parent) });
      continue;
    }
    const cur = stack[stack.length - 1];
    if (!cur) continue;
    const kv = /"([^"]+)"\s*=\s*(.+)$/.exec(rawLine);
    if (!kv) continue;
    applyIoregProp(cur, kv[1], kv[2]);
    if (kv[1] === 'IOCalloutDevice' || kv[1] === 'IODialinDevice') {
      // Defer until we have both if they appear in the same node — record once after
      // the second key, or at the first if that's all we get, by stamping a flag.
      if (cur._recorded) {
        // rewrite last classification if we just learned the callout path
        const dest = P.isTourBoxUsb(cur) ? matches : other;
        const last = dest[dest.length - 1];
        if (last && (last.path === P.preferCalloutPath(cur.dialin || '') || last.path === P.preferCalloutPath(cur.callout || ''))) {
          last.path = P.preferCalloutPath(cur.callout || cur.dialin);
        }
      } else {
        recordSerialNode(cur, matches, other);
        cur._recorded = true;
      }
    }
  }
}

function parseIoregFlat(text, matches, other) {
  const blocks = String(text || '').split(/\n\s*\n/);
  for (const block of blocks) {
    const node = inherit(null);
    for (const line of block.split(/\n/)) {
      const kv = /"([^"]+)"\s*=\s*(.+)$/.exec(line);
      if (kv) applyIoregProp(node, kv[1], kv[2]);
    }
    // Also accept the unquoted idVendor 11836 form used in the original fixture
    // (the quoted parser already covers "idVendor" = 11836).
    recordSerialNode(node, matches, other);
  }
}

function parseIoregSurvey(text) {
  const matches = [];
  const other = [];
  const src = String(text || '');
  if (/^\s*\|?\s*\+-o |\n\s*\|?\s*\+-o /.test(src) || src.includes('+-o ')) parseIoregTree(src, matches, other);
  else parseIoregFlat(src, matches, other);
  const seen = new Set();
  const dedupe = (rows) => rows.filter((row) => {
    if (!row.path || seen.has(row.path)) return false;
    seen.add(row.path);
    return true;
  });
  return { matches: dedupe(matches), other: dedupe(other) };
}

function parseIoreg(text) {
  return parseIoregSurvey(text).matches;
}

function listDarwinDisk(io = fs) {
  const other = [];
  try {
    for (const name of io.readdirSync('/dev')) {
      if (/^cu\.usb(modem|serial)/i.test(name) || /^cu\.wchusbserial/i.test(name)) {
        other.push({ path: `/dev/${name}` });
      }
    }
  } catch { /* no /dev listing */ }
  return other;
}

function listDarwin(exec = execFile, io = fs) {
  return listDarwinSurvey(exec, io).then((s) => s.matches);
}

function listDarwinSurvey(exec = execFile, io = fs) {
  return new Promise((resolve) => {
    // -l -w0 walks the IOService plane from the root so parent USB idVendor /
    // idProduct appear above the child IOCalloutDevice. Rooting at
    // IOSerialBSDClient (the old command) never includes those properties.
    exec('ioreg', ['-l', '-w0'], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const disk = listDarwinDisk(io);
      if (err) return resolve({ matches: [], other: disk });
      const survey = parseIoregSurvey(String(stdout || ''));
      const known = new Set([...survey.matches, ...survey.other].map((r) => r.path));
      for (const row of disk) if (!known.has(row.path)) survey.other.push(row);
      resolve(survey);
    });
  });
}

function collectSerialport(list) {
  const matches = [];
  const other = [];
  for (const row of list || []) {
    const vendorId = parseInt(String(row.vendorId || ''), 16);
    const productId = parseInt(String(row.productId || ''), 16);
    const info = {
      vendorId: Number.isFinite(vendorId) ? vendorId : undefined,
      productId: Number.isFinite(productId) ? productId : undefined,
      serialNumber: row.serialNumber || '',
      manufacturer: row.manufacturer || '',
      product: row.product || row.productName || '',
    };
    const item = {
      path: P.preferCalloutPath(row.path),
      ...info,
      product: P.isTourBoxUsb(info) ? P.productNameFor(info) : (info.product || ''),
    };
    if (!item.path) continue;
    if (P.isTourBoxUsb(info)) matches.push(item);
    else other.push(item);
  }
  return { matches, other };
}

function mergeSurvey(...parts) {
  const found = new Map();
  const otherMap = new Map();
  const add = (dest, row) => {
    if (!row || !row.path || dest.has(row.path)) return;
    dest.set(row.path, row);
  };
  for (const part of parts) {
    if (!part) continue;
    for (const row of part.matches || []) add(found, row);
    for (const row of part.other || []) add(otherMap, row);
  }
  for (const path of found.keys()) otherMap.delete(path);
  return { matches: [...found.values()], other: [...otherMap.values()] };
}

async function listPortSurvey({ platform = process.platform, serialport = trySerialport(), io = fs, exec = execFile } = {}) {
  const parts = [];
  if (serialport && typeof serialport.SerialPort === 'function' && typeof serialport.SerialPort.list === 'function') {
    try { parts.push(collectSerialport(await serialport.SerialPort.list())); }
    catch { /* fall through to sysfs / ioreg */ }
  }
  if (platform === 'linux') parts.push(collectLinux(io));
  if (platform === 'darwin') parts.push(await listDarwinSurvey(exec, io));
  return mergeSurvey(...parts);
}

async function listPorts(opts = {}) {
  const survey = await listPortSurvey(opts);
  return survey.matches;
}
listPorts.survey = listPortSurvey;

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

module.exports = { trySerialport, listPorts, listPortSurvey, listLinux, listDarwin, parseIoreg, parseIoregSurvey, sttyArgs, openPort, openRaw, RawPort };
