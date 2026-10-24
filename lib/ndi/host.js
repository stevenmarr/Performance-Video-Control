'use strict';
// Where NDI is allowed to run. The Control Center process never receives NDI (no SDK, no
// decode). A Mac sidecar receives and pushes H.264 into the scopes relay. A Raspberry Pi
// is never a receive host.

const fs = require('fs');

function readPiModel() {
  for (const p of ['/proc/device-tree/model', '/sys/firmware/devicetree/base/model']) {
    try {
      const t = fs.readFileSync(p, 'utf8').replace(/\0/g, '').trim();
      if (t) return t;
    } catch { /* not a Pi, or the file is unreadable */ }
  }
  return '';
}

function hostRole(opts = {}) {
  const platform = opts.platform || process.platform;
  const arch = opts.arch || process.arch;
  const model = opts.model !== undefined ? opts.model : readPiModel();
  const pi = !!opts.pi || /raspberry pi/i.test(model);
  return {
    receive: 'sidecar',
    inProcess: false,
    pi,
    platform,
    arch,
    model,
    // Real NDI receive is a macOS sidecar only, and never on a Pi.
    ndiReceiveAllowed: platform === 'darwin' && !pi,
  };
}

function isLoopbackAddress(addr) {
  const a = String(addr || '').toLowerCase().replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1' || a === 'localhost';
}

function ingestAllowed(addr, { allowLan = false } = {}) {
  if (allowLan) return true;
  return isLoopbackAddress(addr);
}

function isNdiId(id) {
  return /^[a-z0-9][a-z0-9-]{0,40}$/.test(String(id || ''));
}

function cleanNdiName(s, fallback) {
  const t = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64);
  return t || fallback || 'NDI';
}

function assertReceiveHost(role = hostRole()) {
  if (role.ndiReceiveAllowed) return role;
  const why = role.pi
    ? 'This machine looks like a Raspberry Pi. NDI receive does not run on the Pi.'
    : `NDI receive runs on macOS only (this process is ${role.platform}).`;
  const err = new Error(`${why} Control Center only relays H.264. Use --mock for fixture frames, or run the sidecar on a Mac.`);
  err.code = 'NDI_HOST';
  throw err;
}

module.exports = { hostRole, readPiModel, isLoopbackAddress, ingestAllowed, isNdiId, cleanNdiName, assertReceiveHost };
