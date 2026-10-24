'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { encodeDisplay, cleanConfig, TslService, COLOUR, isLoopback } = require('../lib/tsl');

test('TSL 5.0 encodeDisplay: little-endian header and CONTROL bits', () => {
  const buf = encodeDisplay({ screen: 0, index: 3, label: 'CAM 3', lh: COLOUR.red, rh: COLOUR.green, brightness: 3 });
  assert.equal(buf.readUInt16LE(0), buf.length - 2, 'PBC = rest of packet');
  assert.equal(buf.readUInt8(2), 5, 'VER 5');
  assert.equal(buf.readUInt16LE(4), 0, 'SCREEN');
  assert.equal(buf.readUInt16LE(6), 3, 'INDEX');
  const ctrl = buf.readUInt16LE(8);
  assert.equal(ctrl & 3, COLOUR.green, 'RH = green');
  assert.equal((ctrl >> 4) & 3, COLOUR.red, 'LH = red');
  assert.equal((ctrl >> 6) & 3, 3, 'brightness');
  const len = buf.readUInt16LE(10);
  assert.equal(buf.slice(12, 12 + len).toString('ascii'), 'CAM 3');
});

test('cleanConfig refuses non-loopback UDP via setConfig', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsl-'));
  const tsl = new TslService({ dataDir: dir, forceMock: true });
  assert.throws(() => tsl.setConfig({ transport: 'udp', host: '192.168.21.125', port: 8900 }), /loopback/);
  assert.ok(isLoopback('127.0.0.1'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('TslService mock: ATEM PGM/PVW map → packets (no real sockets)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsl-'));
  const fakeAtem = {
    status: () => ({ connected: true }),
    view: () => ({ program: 2, preview: 5, inputs: [{ id: 2 }, { id: 5 }] }),
  };
  const systems = { drivers: { atem: fakeAtem, ptz: null } };
  const tsl = new TslService({ dataDir: dir, systems, forceMock: true });
  tsl.setConfig({
    enabled: true, transport: 'mock', host: '127.0.0.1', port: 8900,
    addresses: [
      { index: 1, label: 'CAM 1', sources: [{ system: 'atem', input: 1 }] },
      { index: 2, label: 'CAM 2', sources: [{ system: 'atem', input: 2 }] },
      { index: 5, label: 'CAM 5', sources: [{ system: 'atem', input: 5 }] },
    ],
  });
  const r = await tsl.tick();
  assert.equal(r.packets, 3);
  const st = tsl.status();
  assert.equal(st.last[0].via, 'mock');
  const by = Object.fromEntries(r.states.map((s) => [s.index, s]));
  assert.equal(by[2].lh, COLOUR.red); assert.equal(by[2].onPgm, true);
  assert.equal(by[5].rh, COLOUR.green); assert.equal(by[5].onPvw, true);
  assert.equal(by[1].lh, COLOUR.off); assert.equal(by[1].rh, COLOUR.off);
  // unchanged second tick
  const r2 = await tsl.tick();
  assert.equal(r2.unchanged, true);
  // show part round-trip
  const part = tsl.showPart();
  assert.equal(part.addresses.length, 3);
  const tsl2 = new TslService({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tsl2-')), forceMock: true });
  tsl2.applyShowPart(part);
  assert.equal(tsl2.getConfig().addresses.length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cleanConfig defaults', () => {
  const c = cleanConfig({});
  assert.equal(c.version, '5.0');
  assert.equal(c.port, 8900);
  assert.equal(c.transport, 'mock');
  assert.equal(c.enabled, false);
});
