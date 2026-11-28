'use strict';
// TourBox process. serialport (or the stty fallback) lives here, so a native fault
// restarts this process and leaves Control Center running. CC_TOURBOX_MOCK=1 uses
// the pretend serial port in ./mock-serial.js and accepts {op:'mock'} to drive it.
const { TourBoxScanner } = require('./scanner');
const serial = require('./serial');

const mock = process.env.CC_TOURBOX_MOCK === '1';
let mockBox = null;
let listPorts = serial.listPorts;
let openPort = serial.openPort;
if (mock) {
  const { MockSerialPort, mockSerial } = require('./mock-serial');
  mockBox = new MockSerialPort();
  const api = mockSerial([mockBox]);
  listPorts = () => api.list();
  openPort = (p) => api.open(p);
}

const send = (msg) => { if (process.connected) process.send(msg); };
const scanner = new TourBoxScanner({
  listPorts, openPort, send,
  log: (level, msg) => send({ event: 'log', level, msg }),
  scanMs: mock ? 80 : undefined,
  retryMs: mock ? 120 : undefined,
});

process.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  const id = msg.id;
  try {
    if (msg.op === 'start') {
      if (msg.port !== undefined) scanner.setPreferredPort(msg.port);
      scanner.start();
      return send({ id, ok: true });
    }
    if (msg.op === 'prefer') { scanner.setPreferredPort(msg.port); return send({ id, ok: true }); }
    if (msg.op === 'stop') { await scanner.stop(); return send({ id, ok: true }); }
    if (msg.op === 'mock') {
      if (!mockBox) return send({ id, ok: false, error: 'not a mock TourBox' });
      const a = msg.action;
      if (a === 'press') mockBox.press(msg.control);
      else if (a === 'release') mockBox.release(msg.control);
      else if (a === 'tap') mockBox.tap(msg.control);
      else if (a === 'turn') mockBox.turn(msg.control, msg.ticks);
      else if (a === 'unplug') mockBox.unplug();
      else if (a === 'replug') mockBox.replug();
      else if (a === 'busy') mockBox.busy = !!msg.on;
      return send({ id, ok: true, opened: mockBox.opened, handshook: mockBox.handshook, writes: mockBox.writes.length });
    }
    send({ id, ok: false, error: `unknown op ${msg.op}` });
  } catch (e) { send({ id, ok: false, error: e.message }); }
});

process.on('disconnect', () => { scanner.stop().finally(() => process.exit(0)); });
send({ event: 'ready', mock });
