'use strict';
// One pasteable picture of USB Stream Deck discovery: library, Elgato nodes,
// permissions, and which process holds them. Used by GET /api/surfaces/diag
// and by `node tools/deck-diag.js`.

const fs = require('fs');
const { loadDriver } = require('./usb');

const ELGATO = 0x0fd9;
const CORSAIR = 0x1b1c;

function userName(uid) {
  const name = lookup('/etc/passwd', uid);
  return name || String(uid);
}

function groupName(gid) {
  const name = lookup('/etc/group', gid);
  return name || String(gid);
}

function lookup(file, id) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      const parts = line.split(':');
      if (parts.length >= 3 && Number(parts[2]) === Number(id)) return parts[0];
    }
  } catch { /* missing */ }
  return '';
}

function hidrawSysfs(name) {
  let uevent = '';
  try { uevent = fs.readFileSync(`/sys/class/hidraw/${name}/device/uevent`, 'utf8'); } catch { /* not Linux or no sysfs */ }
  const hidId = (uevent.match(/^HID_ID=(.*)$/m) || [])[1] || '';
  const hidName = (uevent.match(/^HID_NAME=(.*)$/m) || [])[1] || '';
  const parts = hidId.split(':');
  const vendor = parts[1] ? parseInt(parts[1], 16) : null;
  const product = parts[2] ? parseInt(parts[2], 16) : null;
  return {
    hidId,
    hidName,
    vendor: Number.isFinite(vendor) ? vendor : null,
    product: Number.isFinite(product) ? product : null,
    elgato: vendor === ELGATO || (vendor === CORSAIR && product === 0x2b18),
  };
}

function usbNodeFor(name) {
  let dir = `/sys/class/hidraw/${name}/device`;
  for (let i = 0; i < 8; i++) {
    try {
      const bus = fs.readFileSync(`${dir}/busnum`, 'utf8').trim();
      const dev = fs.readFileSync(`${dir}/devnum`, 'utf8').trim();
      if (/^\d+$/.test(bus) && /^\d+$/.test(dev)) {
        return `/dev/bus/usb/${bus.padStart(3, '0')}/${dev.padStart(3, '0')}`;
      }
    } catch { /* this directory is not the USB device */ }
    try { dir = fs.realpathSync(`${dir}/..`); } catch { break; }
  }
  return '';
}

function listHidraw() {
  let names = [];
  try { names = fs.readdirSync('/dev').filter((n) => /^hidraw\d+$/.test(n)); } catch { return []; }
  return names.map((name) => {
    const node = `/dev/${name}`;
    const info = { path: node, usbPath: usbNodeFor(name), ...hidrawSysfs(name) };
    try {
      const st = fs.statSync(node);
      info.mode = (st.mode & 0o777).toString(8).padStart(4, '0');
      info.uid = st.uid;
      info.gid = st.gid;
      info.user = userName(st.uid);
      info.group = groupName(st.gid);
    } catch (e) {
      info.error = e.code || e.message;
    }
    info.holders = [];
    return info;
  });
}

function procCmd(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() || fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  } catch {
    return '';
  }
}

function holdersFor(paths) {
  const wanted = new Set(paths);
  const byPath = new Map(paths.map((p) => [p, []]));
  let unread = 0;
  let pids = [];
  try { pids = fs.readdirSync('/proc'); } catch { return { byPath, unread, proc: false }; }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let fds;
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); }
    catch (e) {
      if (e && (e.code === 'EACCES' || e.code === 'EPERM')) unread += 1;
      continue;
    }
    for (const fd of fds) {
      let link;
      try { link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      if (!wanted.has(link)) continue;
      const list = byPath.get(link);
      if (list.some((h) => h.pid === Number(pid))) continue;
      list.push({ pid: Number(pid), cmd: procCmd(pid) });
    }
  }
  return { byPath, unread, proc: true };
}

async function listDecks(driver) {
  const out = { streamDecks: [], hid: [], listError: null };
  if (!driver) return out;
  try {
    const listed = await driver.listStreamDecks();
    out.streamDecks = (listed || []).map((d) => ({
      path: d.path || '',
      serial: d.serialNumber || '',
      model: d.model || '',
    }));
  } catch (e) {
    out.listError = e.message || String(e);
  }
  try {
    const HID = require('node-hid');
    const devices = typeof HID.devices === 'function' ? HID.devices() : [];
    out.hid = devices
      .filter((d) => d && (d.vendorId === ELGATO || d.vendorId === CORSAIR))
      .map((d) => ({
        path: d.path || '',
        vendorId: d.vendorId,
        productId: d.productId,
        serial: d.serialNumber || '',
        product: d.product || '',
        interface: d.interface,
        usage: d.usage,
      }));
  } catch (e) {
    out.listError = out.listError || e.message || String(e);
  }
  return out;
}

function groupList() {
  const ids = typeof process.getgroups === 'function' ? process.getgroups() : [];
  return ids.map((id) => ({ id, name: groupName(id) || String(id) }));
}

async function diagnose({ usb } = {}) {
  const loaded = loadDriver();
  const listed = await listDecks(loaded.driver);
  const hidraw = listHidraw();
  const watch = [];
  for (const node of hidraw) {
    watch.push(node.path);
    if (node.usbPath) watch.push(node.usbPath);
  }
  const held = holdersFor(watch);
  for (const node of hidraw) {
    node.holders = held.byPath.get(node.path) || [];
    node.usbHolders = node.usbPath ? (held.byPath.get(node.usbPath) || []) : [];
  }
  const report = {
    node: process.version,
    platform: process.platform,
    pid: process.pid,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    gid: typeof process.getgid === 'function' ? process.getgid() : null,
    user: typeof process.getuid === 'function' ? userName(process.getuid()) : '',
    group: typeof process.getgid === 'function' ? groupName(process.getgid()) : '',
    groups: groupList(),
    library: {
      name: '@elgato-stream-deck/node',
      installed: !!loaded.driver,
      error: loaded.error,
      code: loaded.code || null,
    },
    listError: listed.listError,
    streamDecks: listed.streamDecks,
    elgatoHid: listed.hid,
    hidraw,
    unreadFds: held.unread,
    proc: held.proc,
    openErrors: (usb && usb.openErrors) ? usb.openErrors.slice() : [],
    lastReport: usb && usb.lastReport ? {
      installed: usb.lastReport.installed,
      error: usb.lastReport.error,
      found: usb.lastReport.found,
      opened: usb.lastReport.opened || [],
      failed: usb.lastReport.failed || [],
      skipped: usb.lastReport.skipped || [],
    } : null,
  };
  report.text = formatDiag(report);
  return report;
}

function hex(n) {
  if (n == null || !Number.isFinite(n)) return '?';
  return n.toString(16).padStart(4, '0');
}

function formatDiag(report) {
  const lines = [];
  lines.push('Control Center Stream Deck diagnostic');
  lines.push(`node ${report.node}  platform ${report.platform}  pid ${report.pid}  uid ${report.uid} (${report.user})  gid ${report.gid} (${report.group})`);
  lines.push(`groups: ${(report.groups || []).map((g) => `${g.name}(${g.id})`).join(', ') || '(none)'}`);
  if (report.library && report.library.installed) lines.push('HID library: @elgato-stream-deck/node loaded');
  else lines.push(`HID library: MISSING. require('@elgato-stream-deck/node') failed: ${report.library && report.library.error ? report.library.error : 'unknown error'}`);
  if (report.listError) lines.push(`listStreamDecks failed: ${report.listError}`);
  const decks = report.streamDecks || [];
  lines.push(`found ${decks.length} stream decks`);
  for (const d of decks) lines.push(`  stream deck serial ${d.serial || '(none)'}  model ${d.model || '?'}  path ${d.path}`);
  const hid = report.elgatoHid || [];
  if (hid.length) {
    lines.push(`Elgato HID interfaces: ${hid.length}`);
    for (const d of hid) lines.push(`  ${d.path}  ${hex(d.vendorId)}:${hex(d.productId)}  serial ${d.serial || '(none)'}  ${d.product || ''}`);
  }
  const nodes = report.hidraw || [];
  if (!nodes.length) lines.push('hidraw nodes: none');
  else lines.push('hidraw nodes:');
  for (const n of nodes) {
    const who = n.holders && n.holders.length ? n.holders.map((h) => `${h.pid} ${h.cmd}`.trim()).join('; ') : 'nobody';
    const usbWho = n.usbHolders && n.usbHolders.length ? n.usbHolders.map((h) => `${h.pid} ${h.cmd}`.trim()).join('; ') : 'nobody';
    const id = n.vendor != null ? `vendor ${hex(n.vendor)} product ${hex(n.product)}` : 'vendor unknown';
    lines.push(`  ${n.path}  mode ${n.mode || '?'}  ${n.user || '?'}:${n.group || '?'}  ${id}${n.elgato ? '  Elgato' : ''}  holders: ${who}${n.usbPath ? `  usb ${n.usbPath} holders: ${usbWho}` : ''}${n.error ? `  ${n.error}` : ''}`);
    if ((!n.holders || !n.holders.length) && n.usbHolders && n.usbHolders.length) {
      lines.push(`  hidraw is free but ${n.usbPath} is open. lsof /dev/hidraw* does not show that program.`);
    }
  }
  if (report.unreadFds) lines.push(`${report.unreadFds} processes could not be checked. Run: sudo node tools/deck-diag.js`);
  if (!report.proc) lines.push('No /proc, so this host cannot say who holds a device node.');
  const errors = report.openErrors || [];
  if (errors.length) {
    lines.push('last open errors:');
    for (const e of errors) lines.push(`  ${e}`);
  }
  lines.push('If holders are nobody and the keys still show Companion pages, the deck is keeping the last picture. Nothing is drawing. Turning off Companion USB does not clear the keys. Control Center has to open the device and paint.');
  lines.push('The + on crw-rw----+ is a login-seat permission. A systemd service does not get it. Group companion is Companion\'s udev rule. Install the rules file as 99-control-center-streamdeck.rules so the group becomes plugdev, then restart the service. A running service keeps the groups it had at start.');
  return lines.join('\n');
}

module.exports = { diagnose, formatDiag };
