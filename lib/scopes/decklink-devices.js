'use strict';
// Desktop Video devices this Mac can see. The app does not link the DeckLink SDK.
// It runs decklink-recv --list, and when an input is chosen it runs decklink-recv --device
// and feeds the H.264 into the same relay a sidecar would.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { hostRole } = require('../ndi/host');

function helperBin() {
  return process.env.RS6_DECKLINK_RECV || path.join(__dirname, '..', '..', 'tools', 'native', 'decklink-recv', 'build', 'decklink-recv');
}

function parseList(text) {
  const devices = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /^index\b/i.test(t)) continue;
    const parts = t.split('\t');
    if (!/^\d+$/.test(parts[0])) continue;
    devices.push({
      index: Number(parts[0]),
      name: (parts[1] || `DeckLink ${parts[0]}`).trim() || `DeckLink ${parts[0]}`,
      connections: (parts[2] || '').trim(),
      modes: (parts[3] || '').trim(),
    });
  }
  return devices;
}

function listDevices({ bin = helperBin(), role = hostRole(), spawnFn = spawn, timeoutMs = 4000 } = {}) {
  if (!role.decklinkReceiveAllowed) {
    const error = role.pi
      ? 'Desktop Video capture does not run on a Raspberry Pi.'
      : 'Desktop Video capture runs on macOS only.';
    return Promise.resolve({ devices: [], error });
  }
  if (!bin || !fs.existsSync(bin)) {
    return Promise.resolve({ devices: [], error: 'Desktop Video helper is not built. On this Mac run: cd tools/native/decklink-recv && make' });
  }
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (devices, error) => { if (done) return; done = true; resolve({ devices, error }); };
    let child;
    try { child = spawnFn(bin, ['--list'], { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { finish([], e.message); return; }
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* */ } finish([], 'Desktop Video device list timed out.'); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); finish([], e.message); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const devices = parseList(out);
      if (code && !devices.length) finish([], (err || `decklink-recv --list exited ${code}`).trim());
      else finish(devices, devices.length ? null : ((err || '').trim() || null));
    });
  });
}

// One helper process per device index. stdout is Annex-B, pushed into the scopes hub.
class DeckLinkPool {
  constructor({ hub, listDevices: listFn, log = () => {}, role = hostRole() } = {}) {
    this.hub = hub;
    this.listFn = listFn || (() => listDevices({ role }));
    this.log = log;
    this.role = role;
    this.cache = { at: 0, devices: [], error: null };
    this.pending = null;
    this.children = new Map();
  }
  refresh() {
    if (this.pending) return this.pending;
    if (Date.now() - this.cache.at < 2000) return Promise.resolve(this.cache);
    this.pending = Promise.resolve().then(() => this.listFn()).then((r) => {
      this.cache = { at: Date.now(), devices: (r && r.devices) || [], error: (r && r.error) || null };
      return this.cache;
    }).catch((e) => {
      this.cache = { at: Date.now(), devices: [], error: e.message || String(e) };
      return this.cache;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
  devices() { return this.cache.devices || []; }
  error() { return this.cache.error; }
  async ensure(index) {
    const n = Number(index);
    if (!Number.isInteger(n) || n < 0 || n > 31) {
      throw Object.assign(new Error('Desktop Video device must be 0..31'), { status: 400 });
    }
    const live = (this.hub.list() || []).find((s) => s.kind === 'decklink' && String(s.device) === String(n) && s.connected);
    if (live) return live.id;
    if (this.children.has(n)) return `decklink-${n}`;
    if (!this.role.decklinkReceiveAllowed) {
      throw Object.assign(new Error(this.role.pi ? 'Desktop Video capture does not run on a Raspberry Pi.' : 'Desktop Video capture runs on macOS only.'), { status: 409 });
    }
    const bin = helperBin();
    if (!fs.existsSync(bin)) {
      throw Object.assign(new Error('Desktop Video helper is not built. On this Mac run: cd tools/native/decklink-recv && make'), { status: 409 });
    }
    const known = this.devices().find((d) => d.index === n);
    const name = known ? known.name : `DeckLink ${n}`;
    const { EventEmitter } = require('events');
    const conn = new EventEmitter();
    const id = `decklink-${n}`;
    this.hub.attachSocket(id, { name, kind: 'decklink', device: String(n), mode: 'auto', conn });
    const child = spawn(bin, ['--device', String(n), '--mode', 'auto'], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.children.set(n, child);
    child.stdout.on('data', (buf) => conn.emit('binary', buf));
    child.stderr.on('data', (buf) => { const line = String(buf).trim(); if (line) this.log('info', `Desktop Video ${name}: ${line}`); });
    const stop = () => {
      if (this.children.get(n) !== child) return;
      this.children.delete(n);
      conn.emit('close');
    };
    child.on('error', (e) => { this.log('warn', `Desktop Video ${name}: ${e.message}`); stop(); });
    child.on('close', stop);
    this.log('info', `Desktop Video: capturing ${name} (device ${n})`);
    return id;
  }
  close() {
    for (const child of this.children.values()) { try { child.kill('SIGTERM'); } catch { /* */ } }
    this.children.clear();
  }
}

module.exports = { helperBin, parseList, listDevices, DeckLinkPool };
