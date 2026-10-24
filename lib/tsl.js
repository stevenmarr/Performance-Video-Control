'use strict';
// TSL 5.0 UDP tally sender. Separate from Lightning (NDI ingest → scopes).
// Control Center is the tally authority:
// map switcher PGM → red / PVW → green onto show-file TSL addresses. Default transport is an
// in-memory mock (records packets). Real UDP is allowed only to loopback (127.0.0.1 / ::1) so
// public CI and --mock never touch a LAN device. See docs/tsl-tally.md.
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic } = require('./store');

const DEFAULT_PORT = 8900; // common TSL UMD range; configurable
const MAX_ADDR = 128;
const MAX_LABEL = 16;
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

// TSL 5.0 display CONTROL bits (per display): RH / Text / LH each 0=OFF 1=RED 2=GREEN 3=AMBER
const COLOUR = { off: 0, red: 1, green: 2, amber: 3 };

function cleanSource(s) {
  if (!s || typeof s !== 'object') return null;
  const system = String(s.system || '').toLowerCase();
  if (system === 'atem') {
    const input = Number(s.input);
    if (!Number.isInteger(input) || input < 0 || input > 65535) return null;
    return { system: 'atem', input };
  }
  if (system === 'ptz') {
    const cameraId = String(s.cameraId || s.cam || '').slice(0, 40);
    if (!/^[\w-]{1,40}$/.test(cameraId)) return null;
    return { system: 'ptz', cameraId };
  }
  return null;
}

function cleanAddress(a) {
  if (!a || typeof a !== 'object') return null;
  const index = Number(a.index);
  if (!Number.isInteger(index) || index < 0 || index > 65534) return null;
  const label = String(a.label == null ? '' : a.label).slice(0, MAX_LABEL);
  const sources = Array.isArray(a.sources) ? a.sources.map(cleanSource).filter(Boolean).slice(0, 8) : [];
  return { index, label, sources };
}

function cleanConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const host = String(c.host || '127.0.0.1').trim().slice(0, 200) || '127.0.0.1';
  const port = Number(c.port);
  const addresses = Array.isArray(c.addresses) ? c.addresses.map(cleanAddress).filter(Boolean).slice(0, MAX_ADDR) : [];
  // dedupe by index (last wins)
  const by = new Map(); for (const a of addresses) by.set(a.index, a);
  return {
    version: '5.0',
    transport: c.transport === 'udp' ? 'udp' : 'mock',
    enabled: !!c.enabled,
    host,
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PORT,
    screen: Number.isInteger(Number(c.screen)) && Number(c.screen) >= 0 && Number(c.screen) <= 65534 ? Number(c.screen) : 0,
    brightness: [0, 1, 2, 3].includes(Number(c.brightness)) ? Number(c.brightness) : 3,
    // LH = PGM red, RH = PVW green (industry convention; documented)
    lh: 'pgm',
    rh: 'pvw',
    followPtz: !!c.followPtz, // optional: drive UE150 red/green CGI from the same map
    addresses: [...by.values()].sort((a, b) => a.index - b.index),
  };
}

/** Build one TSL 5.0 UDP packet (little-endian) with a single display message. */
function encodeDisplay({ screen = 0, index = 0, label = '', lh = 0, rh = 0, text = 0, brightness = 3 }) {
  const lbl = Buffer.from(String(label).slice(0, 256), 'ascii');
  const dmsgLen = 2 + 2 + 2 + lbl.length; // INDEX + CONTROL + LENGTH + text
  const pbc = 1 + 1 + 2 + dmsgLen; // VER + FLAGS + SCREEN + DMSG
  const buf = Buffer.alloc(2 + pbc);
  let o = 0;
  buf.writeUInt16LE(pbc, o); o += 2;
  buf.writeUInt8(5, o++); // VER = 5.0
  buf.writeUInt8(0, o++); // FLAGS: ASCII, no control data / checksum
  buf.writeUInt16LE(screen & 0xffff, o); o += 2;
  buf.writeUInt16LE(index & 0xffff, o); o += 2;
  // CONTROL: bits 0-1 RH, 2-3 Text, 4-5 LH, 6-7 brightness (TSL 5.0)
  const ctrl = ((rh & 3) | ((text & 3) << 2) | ((lh & 3) << 4) | ((brightness & 3) << 6)) & 0xff;
  buf.writeUInt16LE(ctrl, o); o += 2;
  buf.writeUInt16LE(lbl.length, o); o += 2;
  lbl.copy(buf, o);
  return buf;
}

function isLoopback(host) {
  const h = String(host || '').toLowerCase();
  return h === '127.0.0.1' || h === '::1' || h === 'localhost' || h === '0.0.0.0';
}

class TslService {
  constructor({ dataDir, systems = null, forceMock = false } = {}) {
    this.file = path.join(dataDir, 'tsl.json');
    this.systems = systems;
    this.forceMock = !!forceMock;
    this.cfg = cleanConfig(readJson(this.file, null));
    this._log = []; // recent packets { at, hex, index, label, lh, rh, via }
    this._sock = null;
    this._lastKey = '';
    this._ptzApplied = new Map(); // cameraId -> { red, green }
  }

  getConfig() { return JSON.parse(JSON.stringify(this.cfg)); }

  setConfig(raw) {
    const next = cleanConfig({ ...this.cfg, ...raw, addresses: raw.addresses !== undefined ? raw.addresses : this.cfg.addresses });
    if (this.forceMock && next.transport === 'udp' && !isLoopback(next.host)) {
      throw err('TSL UDP target must be loopback (127.0.0.1 / ::1) while this session is a simulator — a live desk can send to the address you set');
    }
    this.cfg = next;
    writeJsonAtomic(this.file, this.cfg);
    this._lastKey = '';
    return this.getConfig();
  }

  /** Snapshot suitable for a show file (addresses + options; no live log). */
  showPart() {
    const c = this.cfg;
    if (!c.enabled && !c.addresses.length && !c.followPtz) return null;
    return {
      version: c.version, transport: c.transport, enabled: c.enabled, host: c.host, port: c.port,
      screen: c.screen, brightness: c.brightness, followPtz: c.followPtz, addresses: c.addresses,
    };
  }

  applyShowPart(tsl) {
    if (!tsl || typeof tsl !== 'object') return;
    this.setConfig(tsl);
  }

  status() {
    return {
      ...this.getConfig(),
      forceMock: this.forceMock,
      last: this._log.slice(0, 12),
      via: this._via(),
    };
  }

  _via() {
    if (this.forceMock || this.cfg.transport === 'mock') return 'mock';
    if (this.cfg.transport === 'udp') return isLoopback(this.cfg.host) ? 'udp-loopback' : 'udp';
    return 'mock';
  }

  /** Resolve PGM/PVW input ids from the ATEM driver (first M/E). */
  atemBuses() {
    const d = this.systems && this.systems.drivers && this.systems.drivers.atem;
    if (!d || !d.status || !d.status().connected) return { program: null, preview: null, inputs: [] };
    try {
      const v = d.view();
      return { program: v.program, preview: v.preview, inputs: v.inputs || [] };
    } catch { return { program: null, preview: null, inputs: [] }; }
  }

  /** For each address: colour from mapped ATEM sources (PGM wins red over PVW green). */
  compute() {
    const { program, preview } = this.atemBuses();
    const out = [];
    for (const a of this.cfg.addresses) {
      let onPgm = false; let onPvw = false;
      for (const s of a.sources) {
        if (s.system === 'atem') {
          if (program != null && s.input === program) onPgm = true;
          if (preview != null && s.input === preview) onPvw = true;
        }
      }
      const lh = onPgm ? COLOUR.red : COLOUR.off;
      const rh = onPvw && !onPgm ? COLOUR.green : (onPvw && onPgm ? COLOUR.green : COLOUR.off);
      // PGM on LH (red); PVW on RH (green). If both, both lamps on (camera tally lights often show red only when PGM).
      out.push({ index: a.index, label: a.label, lh, rh, onPgm, onPvw, sources: a.sources });
    }
    return out;
  }

  async tick() {
    if (!this.cfg.enabled && !this.cfg.followPtz) return { ok: true, skipped: true };
    const states = this.compute();
    const key = JSON.stringify(states.map((s) => [s.index, s.lh, s.rh, s.label]));
    if (key === this._lastKey) return { ok: true, unchanged: true };
    this._lastKey = key;
    const packets = [];
    if (this.cfg.enabled) {
      for (const s of states) {
        const buf = encodeDisplay({
          screen: this.cfg.screen, index: s.index, label: s.label || String(s.index),
          lh: s.lh, rh: s.rh, text: 0, brightness: this.cfg.brightness,
        });
        packets.push({ index: s.index, label: s.label, lh: s.lh, rh: s.rh, buf });
        await this._send(buf, s);
      }
    }
    if (this.cfg.followPtz) await this._applyPtz(states);
    return { ok: true, packets: packets.length, states };
  }

  async _send(buf, meta) {
    const via = this._via();
    const entry = { at: new Date().toISOString(), hex: buf.toString('hex'), index: meta.index, label: meta.label, lh: meta.lh, rh: meta.rh, via };
    this._log.unshift(entry); if (this._log.length > 40) this._log.length = 40;
    if (via === 'udp-loopback' || via === 'udp') {
      await new Promise((resolve, reject) => {
        const sock = dgram.createSocket('udp4');
        sock.send(buf, this.cfg.port, this.cfg.host, (e) => { sock.close(); if (e) reject(e); else resolve(); });
      });
    }
  }

  async _applyPtz(states) {
    const drv = this.systems && this.systems.drivers && this.systems.drivers.ptz;
    if (!drv || typeof drv.tally !== 'function') return;
    // Build cameraId -> { red, green } from addresses that also list a PTZ source.
    // Only cameras named in the map are touched — other cameras keep their own TLR path.
    const want = new Map();
    for (const s of states) {
      for (const src of s.sources) {
        if (src.system !== 'ptz') continue;
        const cur = want.get(src.cameraId) || { red: 0, green: 0 };
        if (s.onPgm) cur.red = 1;
        if (s.onPvw) cur.green = 1;
        want.set(src.cameraId, cur);
      }
    }
    for (const [cam, tg] of want) {
      const prev = this._ptzApplied.get(cam) || { red: -1, green: -1 };
      if (prev.red === tg.red && prev.green === tg.green) continue;
      try {
        await drv.tally(cam, !!tg.red, 'red');
        await drv.tally(cam, !!tg.green, 'green');
        this._ptzApplied.set(cam, tg);
      } catch { /* offline / mock gap: ignore */ }
    }
  }

  close() { if (this._sock) try { this._sock.close(); } catch { /* */ } this._sock = null; }
}

module.exports = { TslService, encodeDisplay, cleanConfig, cleanAddress, COLOUR, DEFAULT_PORT, isLoopback };
