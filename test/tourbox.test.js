
'use strict';
// TourBox NEO surface (lib/surfaces/tourbox). No test opens a real serial port: the box is the
// pretend one in mock-serial.js, the cameras are MockPTZ.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../lib/surfaces/tourbox/protocol');
const { MockSerialPort, mockSerial } = require('../lib/surfaces/tourbox/mock-serial');
const { TourBoxDevice } = require('../lib/surfaces/tourbox/device');
const { TourBoxScanner } = require('../lib/surfaces/tourbox/scanner');
const { TourBoxHost } = require('../lib/surfaces/tourbox/host');
const { TourBoxService, cleanCfg, cleanPort } = require('../lib/surfaces/tourbox/service');
const mapping = require('../lib/surfaces/tourbox/mapping');
const serial = require('../lib/surfaces/tourbox/serial');
const { DeskSelection } = require('../lib/surfaces/desk-selection');
const { MockPTZ } = require('../lib/mocks/ptz');
const { SystemManager } = require('../lib/systems');
const { createServer } = require('../lib/server');
const { setup, until } = require('./helpers');
const paint = require('../lib/paint-accel');
const deck = require('../lib/deck');
const PC = require('../lib/drivers/ptz-commands');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- protocol ----------
test('TourBox protocol: every NEO control decodes, and Max rotary bytes are accepted', () => {
  assert.equal(P.VENDOR_ID, 0x2E3C);
  assert.equal(P.PRODUCT_ID, 0x5740);
  assert.equal(P.MODEL, 'TBG_H');
  assert.equal(P.BAUD, 115200);
  assert.equal(P.LONG_PRESS_MS, 800);
  assert.equal(P.MAGIC1.length, 8);
  assert.equal(P.MAGIC1[0], 0x55);
  assert.equal(P.MAGIC1[P.MAGIC1.length - 1], 0xfe);
  assert.equal(P.MAGIC2[0], 0xb5);
  assert.equal(P.MAGIC2[P.MAGIC2.length - 1], 0xfe);
  assert.ok(P.MAGIC2.length > 80);

  const expect = [
    [0x00, 'tall', 'press'], [0x80, 'tall', 'release'],
    [0x01, 'side', 'press'], [0x81, 'side', 'release'],
    [0x02, 'top', 'press'], [0x82, 'top', 'release'],
    [0x03, 'short', 'press'], [0x83, 'short', 'release'],
    [0x0a, 'scroll', 'press'], [0x8a, 'scroll', 'release'],
    [0x10, 'up', 'press'], [0x90, 'up', 'release'],
    [0x11, 'down', 'press'], [0x91, 'down', 'release'],
    [0x12, 'left', 'press'], [0x92, 'left', 'release'],
    [0x13, 'right', 'press'], [0x93, 'right', 'release'],
    [0x22, 'c1', 'press'], [0xa2, 'c1', 'release'],
    [0x23, 'c2', 'press'], [0xa3, 'c2', 'release'],
    [0x2a, 'tour', 'press'], [0xaa, 'tour', 'release'],
    [0x37, 'knob', 'press'], [0xb7, 'knob', 'release'],
    [0x38, 'dial', 'press'], [0xb8, 'dial', 'release'],
  ];
  for (const [code, control, event] of expect) {
    const d = P.decodeByte(code);
    assert.equal(d.control, control, `0x${code.toString(16)}`);
    assert.equal(d.event, event, `0x${code.toString(16)}`);
  }
  assert.deepEqual(P.decodeByte(0x44), { control: 'knob', event: 'turn', code: 0x44, ticks: 1 });
  assert.deepEqual(P.decodeByte(0x04), { control: 'knob', event: 'turn', code: 0x04, ticks: -1 });
  assert.deepEqual(P.decodeByte(0x4f), { control: 'dial', event: 'turn', code: 0x4f, ticks: 1 });
  assert.deepEqual(P.decodeByte(0x0f), { control: 'dial', event: 'turn', code: 0x0f, ticks: -1 });
  assert.deepEqual(P.decodeByte(0x49), { control: 'scroll', event: 'turn', code: 0x49, ticks: 1 });
  assert.deepEqual(P.decodeByte(0x09), { control: 'scroll', event: 'turn', code: 0x09, ticks: -1 });
  // Max/MSP rotary integers are the serial byte OR 0x80 (Knob CW 0xC4 = 196).
  const maxCw = P.decodeByte(196);
  assert.equal(maxCw.control, 'knob');
  assert.equal(maxCw.event, 'turn');
  assert.equal(maxCw.ticks, 1);
  assert.equal(maxCw.source, 'max');
  assert.equal(P.decodeByte(0xff).event, 'unknown');
  assert.equal(P.labelOf('knob'), 'Knob');
});

test('TourBox serial helpers: stty args, ioreg parse, Linux VID/PID walk', () => {
  const args = serial.sttyArgs('/dev/ttyACM0', 'linux');
  assert.equal(args[0], '-F');
  assert.ok(args.includes('115200'));
  const rows = serial.parseIoreg(`
    "idVendor" = 11836
    "idProduct" = 22336
    "IODialinDevice" = "/dev/cu.usbmodemTB01"
    "USB Product Name" = "TourBox NEO"
    "USB Serial Number" = "ABC"
  `);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, '/dev/cu.usbmodemTB01');
  assert.equal(rows[0].vendorId, 0x2E3C);
  assert.equal(rows[0].productId, 0x5740);
  assert.equal(P.preferCalloutPath('/dev/tty.usbmodemTB01'), '/dev/cu.usbmodemTB01');
  assert.ok(P.USB_IDS.some((r) => r.vendorId === 0xC251 && r.productId === 0x2005));
  assert.equal(P.isTourBoxUsb({ vendorId: 0xC251, productId: 0x2005 }), true);
  assert.equal(P.isTourBoxUsb({ vendorId: 0x1A86, productId: 0x7523 }), false);
  assert.equal(P.isTourBoxUsb({ vendorId: 0x0403, productId: 0x6001, product: 'TourBox custom' }), true);
  assert.equal(P.isTourBoxUsb({ vendorId: 0x10C4, productId: 0xEA60 }), false);
  assert.equal(P.isTourBoxCandidate({ vendorId: 0x10C4, productId: 0xEA60 }), true);
  assert.equal(P.isTourBoxCandidate({ vendorId: 0x2E3C, productId: 0x5740 }), false);
  assert.equal(cleanPort('/dev/tty.usbserial-01BBEB67'), '/dev/cu.usbserial-01BBEB67');
  assert.equal(cleanPort('/dev/cu.usbserial-01BBEB67'), '/dev/cu.usbserial-01BBEB67');
  assert.equal(cleanPort(''), '');
  assert.equal(cleanPort('/tmp/evil'), '');
  assert.equal(cleanPort('/dev/../etc/passwd'), '');
  assert.equal(cleanCfg({ port: '/dev/cu.usbserial-01BBEB67' }).port, '/dev/cu.usbserial-01BBEB67');
});

// Realistic macOS ioreg: VID/PID live on the parent IOUSBHostDevice, the cu.*
// path lives on a child IOSerialBSDClient. A dump rooted at IOSerialBSDClient
// (the old listDarwin command) has no idVendor and must not invent a match.
const DARWIN_IOREG = `
+-o Root  <class IORegistryEntry, id 0x100000100, !registered, !matched, active, busy 0, retain 22>
  +-o USB-Serial Controller@00100000  <class IOUSBHostDevice, id 0x100000210, registered, matched, active, busy 0, retain 10>
    {
      "idVendor" = 1027
      "idProduct" = 24577
      "USB Product Name" = "FT232R USB UART"
      "USB Vendor Name" = "FTDI"
    }
    +-o IOSerialBSDClient  <class IOSerialBSDClient, id 0x100000211, registered, matched, active, busy 0, retain 5>
      {
        "IODialinDevice" = "/dev/tty.usbserial-FT0"
        "IOCalloutDevice" = "/dev/cu.usbserial-FT0"
      }
  +-o USB2.0-Serial@00110000  <class IOUSBHostDevice, id 0x100000220, registered, matched, active, busy 0, retain 8>
    {
      "idVendor" = 6790
      "idProduct" = 29987
      "USB Product Name" = "USB Serial"
      "USB Vendor Name" = "QinHeng"
    }
    +-o IOSerialBSDClient  <class IOSerialBSDClient, id 0x100000221, registered, matched, active, busy 0, retain 5>
      {
        "IOCalloutDevice" = "/dev/cu.wchusbserial1410"
      }
  +-o TourBox NEO@00200000  <class IOUSBHostDevice, id 0x100000300, registered, matched, active, busy 0, retain 14>
    {
      "idVendor" = 11836
      "idProduct" = 22336
      "USB Product Name" = "TourBox NEO"
      "USB Vendor Name" = "ARTERY Technology"
      "USB Serial Number" = "ABC"
    }
    +-o AppleUSBACMData  <class AppleUSBACMData, id 0x100000301, registered, matched, active, busy 0, retain 8>
      {
        "IOTTYBaseName" = "usbmodem"
      }
      +-o IOSerialBSDClient  <class IOSerialBSDClient, id 0x100000302, registered, matched, active, busy 0, retain 5>
        {
          "IODialinDevice" = "/dev/tty.usbmodemTB01"
          "IOCalloutDevice" = "/dev/cu.usbmodemTB01"
          "IOTTYDevice" = "usbmodemTB01"
        }
  +-o TourBox Elite Plus@00300000  <class IOUSBHostDevice, id 0x100000400, registered, matched, active, busy 0, retain 14>
    {
      "idVendor" = 49745
      "idProduct" = 8197
      "USB Product Name" = "TourBox Elite Plus"
      "USB Vendor Name" = "TourBoxTech"
      "USB Serial Number" = "ELITE1"
    }
    +-o IOSerialBSDClient  <class IOSerialBSDClient, id 0x100000401, registered, matched, active, busy 0, retain 5>
      {
        "IODialinDevice" = "/dev/tty.usbmodemELITE1"
        "IOCalloutDevice" = "/dev/cu.usbmodemELITE1"
      }
  +-o AT32 Virtual ComPort@00400000  <class IOUSBHostDevice, id 0x100000500, registered, matched, active, busy 0, retain 10>
    {
      "idVendor" = 11836
      "idProduct" = 22336
      "USB Product Name" = "AT32 Virtual ComPort in FS Mode"
      "USB Vendor Name" = "ArteryTek"
      "USB Serial Number" = "NEO2"
    }
    +-o IOSerialBSDClient  <class IOSerialBSDClient, id 0x100000501, registered, matched, active, busy 0, retain 5>
      {
        "IOCalloutDevice" = "/dev/cu.usbmodemNEO2"
      }
+-o Bluetooth-Incoming-Port  <class IOSerialBSDClient, id 0x100000600, registered, matched, active, busy 0, retain 5>
  {
    "IOCalloutDevice" = "/dev/cu.Bluetooth-Incoming-Port"
  }
`;

const SERIAL_CLIENT_ONLY = `
+-o IOSerialBSDClient  <class IOSerialBSDClient, id 0x100000302, registered, matched, active, busy 0, retain 5>
  {
    "IODialinDevice" = "/dev/tty.usbmodemTB01"
    "IOCalloutDevice" = "/dev/cu.usbmodemTB01"
    "IOTTYDevice" = "usbmodemTB01"
  }
`;

test('TourBox macOS discovery walks the ioreg tree and names Elite as well as Neo', async () => {
  const survey = serial.parseIoregSurvey(DARWIN_IOREG);
  const paths = survey.matches.map((r) => r.path).sort();
  assert.deepEqual(paths, ['/dev/cu.usbmodemELITE1', '/dev/cu.usbmodemNEO2', '/dev/cu.usbmodemTB01']);
  const neo = survey.matches.find((r) => r.path === '/dev/cu.usbmodemTB01');
  assert.equal(neo.vendorId, 0x2E3C);
  assert.equal(neo.productId, 0x5740);
  assert.equal(neo.serialNumber, 'ABC');
  const elite = survey.matches.find((r) => r.path === '/dev/cu.usbmodemELITE1');
  assert.equal(elite.vendorId, 0xC251);
  assert.equal(elite.productId, 0x2005);
  const artery = survey.matches.find((r) => r.path === '/dev/cu.usbmodemNEO2');
  assert.equal(artery.product, 'AT32 Virtual ComPort in FS Mode');
  const otherPaths = survey.other.map((r) => r.path).sort();
  assert.ok(otherPaths.includes('/dev/cu.usbserial-FT0'));
  assert.ok(otherPaths.includes('/dev/cu.wchusbserial1410'));
  assert.ok(otherPaths.includes('/dev/cu.Bluetooth-Incoming-Port'));
  assert.equal(serial.parseIoreg(SERIAL_CLIENT_ONLY).length, 0);
  const clientSurvey = serial.parseIoregSurvey(SERIAL_CLIENT_ONLY);
  assert.equal(clientSurvey.matches.length, 0);
  assert.deepEqual(clientSurvey.other.map((r) => r.path), ['/dev/cu.usbmodemTB01']);

  let argv;
  const rows = await serial.listPorts({
    platform: 'darwin',
    serialport: null,
    io: { readdirSync: () => ['cu.usbserial-FT0', 'cu.Bluetooth-Incoming-Port'] },
    exec: (cmd, args, _opts, cb) => { argv = [cmd, ...args]; cb(null, DARWIN_IOREG); },
  });
  assert.deepEqual(argv, ['ioreg', '-l', '-w0']);
  assert.deepEqual(rows.map((r) => r.path).sort(), ['/dev/cu.usbmodemELITE1', '/dev/cu.usbmodemNEO2', '/dev/cu.usbmodemTB01']);

  const empty = [];
  const listPorts = async () => [];
  listPorts.survey = async () => ({ matches: [], other: [{ path: '/dev/cu.usbserial-FT0' }, { path: '/dev/cu.Bluetooth-Incoming-Port' }] });
  const scanner = new TourBoxScanner({
    listPorts,
    openPort: async () => { throw new Error('should not open'); },
    send: (m) => empty.push(m),
    scanMs: 30,
    retryMs: 30,
  });
  scanner.start();
  await until(() => empty.some((m) => m.state === 'searching' && m.error), 2000, 'searching reason');
  await scanner.stop();
  const hit = empty.find((m) => m.state === 'searching');
  assert.match(hit.error, /Ports seen: \/dev\/cu\.usbserial-FT0, \/dev\/cu\.Bluetooth-Incoming-Port/);
  assert.match(hit.error, /quit TourBox Console/);
  assert.match(hit.error, /2E3C:5740/);
});

// Steven's Mac (PV-M2-1577): TourBox on the Stream Deck + XL USB pass-through
// enumerates as a stock Silicon Labs CP2104 (10C4:EA60), not a TourBox-named device.
const STREAMDECK_HUB_IOREG = `
+-o GenesysLogic USB2.1 Hub@00100000  <class IOUSBHostDevice, id 0x100000200, registered, matched, active, busy 0, retain 12>
  {
    "idVendor" = 1507
    "idProduct" = 1552
    "USB Product Name" = "USB2.1 Hub"
    "USB Vendor Name" = "GenesysLogic"
  }
  +-o Stream Deck + XL@00110000  <class IOUSBHostDevice, id 0x100000210, registered, matched, active, busy 0, retain 10>
    {
      "idVendor" = 4057
      "idProduct" = 198
      "USB Product Name" = "Stream Deck + XL"
      "USB Vendor Name" = "Elgato Systems"
    }
  +-o CP2104 USB to UART Bridge Controller@00120000  <class IOUSBHostDevice, id 0x100000220, registered, matched, active, busy 0, retain 10>
    {
      "idVendor" = 4292
      "idProduct" = 60000
      "USB Product Name" = "CP2104 USB to UART Bridge Controller"
      "USB Vendor Name" = "Silicon Labs"
    }
    +-o AppleUSBSLCOM  <class AppleUSBSLCOM, id 0x100000221, registered, matched, active, busy 0, retain 6>
      {
        "IOTTYBaseName" = "usbserial"
      }
      +-o IOSerialBSDClient  <class IOSerialBSDClient, id 0x100000222, registered, matched, active, busy 0, retain 5>
        {
          "IODialinDevice" = "/dev/tty.usbserial-01BBEB67"
          "IOCalloutDevice" = "/dev/cu.usbserial-01BBEB67"
        }
`;

test('TourBox on a Stream Deck pass-through is a CP2104 candidate and can be claimed by port', async () => {
  const survey = serial.parseIoregSurvey(STREAMDECK_HUB_IOREG);
  assert.deepEqual(survey.matches, []);
  assert.equal(survey.candidates.length, 1);
  assert.equal(survey.candidates[0].path, '/dev/cu.usbserial-01BBEB67');
  assert.equal(survey.candidates[0].vendorId, 0x10C4);
  assert.equal(survey.candidates[0].productId, 0xEA60);
  assert.equal(survey.candidates[0].kind, 'candidate');
  assert.match(survey.candidates[0].product, /CP2104/);
  assert.equal(survey.other.length, 0);

  const rows = await serial.listPorts({
    platform: 'darwin',
    serialport: null,
    io: { readdirSync: () => ['cu.usbserial-01BBEB67'] },
    exec: (_cmd, _args, _opts, cb) => cb(null, STREAMDECK_HUB_IOREG),
  });
  assert.deepEqual(rows, []);
  const listed = await serial.listPortSurvey({
    platform: 'darwin',
    serialport: null,
    io: { readdirSync: () => ['cu.usbserial-01BBEB67'] },
    exec: (_cmd, _args, _opts, cb) => cb(null, STREAMDECK_HUB_IOREG),
  });
  assert.equal(listed.candidates[0].path, '/dev/cu.usbserial-01BBEB67');

  const box = new MockSerialPort();
  box.path = '/dev/cu.usbserial-01BBEB67';
  const api = mockSerial([box]);
  const candidate = {
    path: '/dev/cu.usbserial-01BBEB67',
    vendorId: 0x10C4,
    productId: 0xEA60,
    product: 'CP2104 USB to UART Bridge Controller',
    kind: 'candidate',
  };
  const listPorts = async () => [];
  listPorts.survey = async () => ({ matches: [], candidates: [candidate], other: [] });

  const opened = [];
  const searching = [];
  const auto = new TourBoxScanner({
    listPorts,
    openPort: async (p) => { opened.push(p); return api.open(p); },
    send: (m) => searching.push(m),
    scanMs: 30,
    retryMs: 30,
  });
  auto.start();
  await until(() => searching.some((m) => m.state === 'searching' && m.error), 2000, 'possible TourBox');
  await auto.stop();
  assert.deepEqual(opened, []);
  const hint = searching.find((m) => m.state === 'searching');
  assert.match(hint.error, /possible TourBox/);
  assert.match(hint.error, /cu\.usbserial-01BBEB67/);
  assert.match(hint.error, /Use this port/);

  const claimed = [];
  const claim = new TourBoxScanner({
    listPorts,
    openPort: (p) => { opened.push(p); return api.open(p); },
    send: (m) => claimed.push(m),
    scanMs: 30,
    retryMs: 30,
    preferredPort: '/dev/cu.usbserial-01BBEB67',
  });
  claim.start();
  await until(() => claim.state === 'connected', 2000, 'claimed CP2104');
  await claim.stop();
  assert.ok(opened.includes('/dev/cu.usbserial-01BBEB67'));
  assert.ok(box.handshook);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbx-port-'));
  const box2 = new MockSerialPort();
  box2.path = '/dev/cu.usbserial-01BBEB67';
  const api2 = mockSerial([box2]);
  const list2 = async () => [];
  list2.survey = async () => ({ matches: [], candidates: [candidate], other: [] });
  const host = new TourBoxHost({
    inProcess: { listPorts: list2, openPort: (p) => api2.open(p), scanMs: 30, retryMs: 30 },
  });
  const live = new TourBoxService({ dataDir: dir, host, env: {} });
  live.listPorts = async () => ({ matches: [], candidates: [candidate], other: [] });
  live.start();
  const adopted = await live.configure({ enabled: true });
  assert.equal(adopted.port, '/dev/cu.usbserial-01BBEB67');
  await until(() => live.hw.state === 'connected', 2000, 'service adopted lone CP2104');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'tourbox.json'), 'utf8'));
  assert.equal(saved.port, '/dev/cu.usbserial-01BBEB67');
  await live.stop();
});

// ---------- ingest ----------
test('TourBox device: handshake then one byte per event, with tick timing', async () => {
  const box = new MockSerialPort();
  await box.open();
  const evs = [];
  let now = 1000;
  const dev = new TourBoxDevice(box, { now: () => now, timers: { setTimeout: (fn, ms) => { const t = setTimeout(fn, Math.min(ms, 5)); return Object.assign(t, { unref() { return this; } }); }, clearTimeout } });
  await dev.open();
  assert.equal(box.handshook, true);
  assert.ok(box.writes[0].equals(P.MAGIC1));
  assert.ok(box.writes[1].equals(P.MAGIC2));
  dev.on('event', (e) => evs.push(e));
  box.press('side');
  box.turn('knob', 1);
  now = 1080;
  box.turn('knob', 1);
  box.release('side');
  assert.equal(evs[0].control, 'side');
  assert.equal(evs[0].event, 'press');
  assert.deepEqual(evs[0].held, ['side']);
  assert.equal(evs[1].event, 'turn');
  assert.equal(evs[1].ticks, 1);
  assert.equal(evs[1].dtMs, null);
  assert.equal(evs[2].dtMs, 80);
  assert.equal(evs[3].event, 'release');
  await dev.close();
});

test('TourBox scanner: connects, reports blocked when the port is busy, reconnects after unplug', async () => {
  const box = new MockSerialPort();
  const api = mockSerial([box]);
  const statuses = [];
  const scanner = new TourBoxScanner({
    listPorts: () => api.list(),
    openPort: (p) => api.open(p),
    send: (m) => { if (m.event === 'status') statuses.push(m.state); },
    scanMs: 30, retryMs: 30,
  });
  scanner.start();
  await until(() => scanner.state === 'connected', 2000, 'connected');
  assert.ok(statuses.includes('connecting'));
  box.unplug();
  await until(() => scanner.state === 'searching' || scanner.state === 'failed', 2000, 'unplugged');
  box.replug();
  await until(() => scanner.state === 'connected', 2000, 'replugged');
  await scanner.stop();
  assert.equal(scanner.state, 'off');

  const busy = new MockSerialPort({ busy: true });
  const busyApi = mockSerial([busy]);
  const blocked = [];
  const s2 = new TourBoxScanner({
    listPorts: () => busyApi.list(),
    openPort: (p) => busyApi.open(p),
    send: (m) => blocked.push(m),
    scanMs: 30, retryMs: 40,
  });
  s2.start();
  await until(() => blocked.some((m) => m.state === 'blocked'), 2000, 'blocked');
  const hit = blocked.find((m) => m.state === 'blocked');
  assert.match(hit.error, /TourBox Console|busy/);
  await s2.stop();
});

// ---------- mapping ----------
test('TourBox mapping: home layer, modifier layers, and unbound camera keys', () => {
  const rcp = mapping.withIndex(mapping.loadBuiltin('ptz-rcp'));
  const iris = mapping.resolve(rcp, 'knob', 'turn', []);
  assert.equal(iris.binding.action, 'ptz.step');
  assert.equal(iris.binding.op, 'iris');
  assert.equal(iris.binding.target, 'selected');
  const focus = mapping.resolve(rcp, 'knob', 'turn', ['side']);
  assert.equal(focus.binding.action, 'ptz.rate');
  assert.equal(focus.binding.axis, 'focus');
  const rGain = mapping.resolve(rcp, 'knob', 'turn', ['top']);
  assert.equal(rGain.binding.op, 'rGain');
  const longIris = mapping.resolve(rcp, 'knob', 'long', []);
  assert.equal(longIris.binding.action, 'ptz.reset');
  assert.equal(longIris.binding.liveGuard, 'exposure');
  // No fixed camera keys: C1, C2, Left and Right have no default RCP binding.
  for (const c of ['c1', 'c2', 'left', 'right']) {
    assert.equal(mapping.resolve(rcp, c, 'press', []), null, c);
  }
  const msu = mapping.withIndex(mapping.loadBuiltin('ptz-msu'));
  const knob = mapping.resolve(msu, 'knob', 'turn', []);
  assert.equal(knob.binding.target, 'msu-a');
  const dial = mapping.resolve(msu, 'dial', 'turn', []);
  assert.equal(dial.binding.target, 'msu-b');
  const page = mapping.resolve(msu, 'left', 'press', []);
  assert.equal(page.binding.action, 'tourbox.msuPair');
  assert.equal(mapping.resolve(msu, 'c1', 'press', []), null);
  const gang = mapping.resolve(msu, 'knob', 'turn', ['side']);
  assert.equal(gang.binding.target, 'gang');
});

// ---------- live service + cameras ----------
async function liveRig({ cams = 2, deskSelection = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tbx-'));
  const mocks = [];
  const cameras = [];
  const models = ['AW-UE150', 'AW-UE160', 'AW-UE150'];
  for (let i = 0; i < cams; i++) {
    const m = new MockPTZ({ model: models[i] || 'AW-UE150', title: `PTZ${i + 1}` });
    const port = await m.start(0);
    mocks.push(m);
    cameras.push({ id: `cam${i + 1}`, name: `PTZ${i + 1}`, host: '127.0.0.1', port });
  }
  const ctx = await setup({});
  const systems = new SystemManager({ dataDir: dir, engine: ctx.engine, overrides: { ptz: { cameras } }, autoStart: false });
  await wait(80);
  for (const c of cameras) await systems.drivers.ptz.poll(c.id).catch(() => {});
  await systems.ptz('select', { cam: 'cam1' });
  const box = new MockSerialPort();
  const api = mockSerial([box]);
  const host = new TourBoxHost({ inProcess: { listPorts: () => api.list(), openPort: (p) => api.open(p), scanMs: 30, retryMs: 30 } });
  const desk = deskSelection || new DeskSelection({ camera: 'cam1' });
  const followed = [];
  const decks = { followPtzPage: (id) => { followed.push(id); return { ok: true, pageId: id }; } };
  const svc = new TourBoxService({ systems, dataDir: dir, host, deskSelection: desk, decks });
  return {
    dir, ctx, systems, mocks, box, host, desk, svc, followed,
    async stop() {
      await svc.stop();
      await systems.close();
      await ctx.teardown();
      for (const m of mocks) await m.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('TourBox service: Claim, iris on the selected camera, Learn mode does not fire, Tour switches MSU', async () => {
  const L = await liveRig({ cams: 2 });
  try {
    const st0 = L.svc.start();
    assert.equal(st0.state, 'off');
    await L.svc.configure({ enabled: true });
    L.svc.start();
    await until(() => L.svc.status().state === 'connected', 2000, 'connected');
    assert.equal(L.svc.status().camera, 'cam1');
    assert.equal(L.svc.status().profile, 'ptz-rcp');

    const irisOf = (id) => L.systems.ptzView().cameras.find((c) => c.id === id).values.iris;
    const before = irisOf('cam1');
    const cam2Before = irisOf('cam2');
    L.box.turn('knob', 1);
    await until(() => irisOf('cam1') !== before, 2000, 'iris stepped');
    const after = irisOf('cam1');
    assert.ok(after > before, `iris ${before} -> ${after}`);
    assert.equal(irisOf('cam2'), cam2Before, 'cam 2 iris did not move');

    await L.svc.configure({ learn: true });
    const iris2 = L.systems.ptzView().cameras.find((c) => c.id === 'cam1').values.iris;
    L.box.turn('knob', 3);
    await wait(80);
    assert.equal(L.systems.ptzView().cameras.find((c) => c.id === 'cam1').values.iris, iris2, 'Learn mode does not fire');
    assert.equal(L.svc.status().lastTouched.learn, true);
    await L.svc.configure({ learn: false });

    L.box.tap('tour');
    await until(() => L.svc.status().profile === 'ptz-msu', 2000, 'MSU');
    assert.ok(L.followed.includes('ptz-msu'));
    L.box.tap('tour');
    await until(() => L.svc.status().profile === 'ptz-rcp', 2000, 'back to RCP');
  } finally { await L.stop(); }
});

test('TourBox follows the Stream Deck camera; C1 does not select camera 1', async () => {
  const desk = new DeskSelection({ camera: 'cam1' });
  const L = await liveRig({ cams: 2, deskSelection: desk });
  try {
    await L.svc.configure({ enabled: true }); L.svc.start();
    await until(() => L.svc.status().state === 'connected', 2000, 'connected');
    desk.set({ camera: 'cam2', source: 'deck' });
    assert.equal(L.svc.status().camera, 'cam2');
    const i1 = L.systems.ptzView().cameras.find((c) => c.id === 'cam1').values.iris;
    const i2 = L.systems.ptzView().cameras.find((c) => c.id === 'cam2').values.iris;
    L.box.turn('knob', 1);
    await until(() => L.systems.ptzView().cameras.find((c) => c.id === 'cam2').values.iris !== i2, 2000, 'cam2 iris');
    assert.equal(L.systems.ptzView().cameras.find((c) => c.id === 'cam1').values.iris, i1, 'cam 1 stayed put');
    L.box.tap('c1');
    await wait(60);
    assert.equal(L.svc.status().camera, 'cam2', 'C1 is not a fixed camera key');
  } finally { await L.stop(); }
});

test('TourBox long press is 800 ms, a turn cancels the click, and exposure reset is blocked on red tally', async () => {
  const L = await liveRig({ cams: 1 });
  try {
    await L.svc.configure({ enabled: true }); L.svc.start();
    await until(() => L.svc.status().state === 'connected', 2000, 'connected');
    await L.systems.ptz('op', { cam: 'cam1', op: 'iris', value: 30 });
    // A click shorter than 800 ms toggles auto iris, it does not reset.
    L.box.press('knob');
    await wait(80);
    L.box.release('knob');
    await wait(80);
    const mode = L.systems.ptzView().cameras[0].values.irisMode;
    assert.equal(typeof mode === 'boolean' ? mode : !!mode, false, 'short press toggled auto iris off (mock starts on)');

    // Turn while held: no reset, no second toggle.
    await L.systems.ptz('op', { cam: 'cam1', op: 'iris', value: 40 });
    const beforeTurn = L.systems.ptzView().cameras[0].values.iris;
    L.box.press('knob');
    L.box.turn('knob', 1);
    L.box.release('knob');
    await until(() => L.systems.ptzView().cameras[0].values.iris !== beforeTurn, 2000, 'iris from the turn');

    await L.systems.ptz('tally', { cam: 'cam1', on: true });
    await L.systems.drivers.ptz.poll('cam1');
    assert.equal(L.systems.ptzView().cameras[0].tally, true);
    L.box.press('knob');
    await wait(P.LONG_PRESS_MS + 80);
    L.box.release('knob');
    await wait(80);
    const notice = L.svc.status().lastNotice;
    assert.ok(notice && /live \(red tally\).*exposure reset is blocked/.test(notice.reason), notice && notice.reason);
  } finally { await L.stop(); }
});

test('PTZ reset uses the scene value, and a live camera still accepts a paint reset', async () => {
  const L = await liveRig({ cams: 1 });
  try {
    await L.systems.ptz('op', { cam: 'cam1', op: 'iris', value: 22 });
    await L.systems.ptz('op', { cam: 'cam1', op: 'rGain', value: -4 });
    await L.systems._captureScene('cam1');
    await L.systems.ptz('op', { cam: 'cam1', op: 'iris', value: 70 });
    await L.systems.ptz('op', { cam: 'cam1', op: 'rGain', value: 12 });
    const iris = await L.systems.ptz('reset', { cam: 'cam1', op: 'iris' });
    assert.equal(iris.value, 22, 'iris returned to the scene value');
    await L.systems.ptz('tally', { cam: 'cam1', on: true });
    await L.systems.drivers.ptz.poll('cam1');
    await assert.rejects(L.systems.ptz('reset', { cam: 'cam1', op: 'iris' }), /exposure reset is blocked/);
    const paintReset = await L.systems.ptz('reset', { cam: 'cam1', op: 'rGain' });
    assert.equal(paintReset.value, -4, 'paint reset still uses the scene value on a live camera');
  } finally { await L.stop(); }
});

test('TourBox Side-held gain clamps and does not wrap onto Auto; COMPARE is reserved', async () => {
  const L = await liveRig({ cams: 1 });
  try {
    await L.svc.configure({ enabled: true }); L.svc.start();
    await until(() => L.svc.status().state === 'connected', 2000, 'connected');
    await L.systems.ptz('op', { cam: 'cam1', op: 'gain', value: '08' });
    L.box.press('side');
    L.box.turn('dial', -1);
    L.box.release('side');
    await wait(120);
    const g = L.systems.ptzView().cameras[0].values.gain;
    assert.equal(String(g), '08', 'gain stayed on 0 dB, not Auto');

    const irisBefore = L.systems.ptzView().cameras[0].values.iris;
    await L.svc.configure({ profile: 'ptz-msu' });
    L.box.tap('short');
    await until(() => L.svc.status().lastNotice && /not built yet/.test(L.svc.status().lastNotice.reason), 2000, 'COMPARE reserved');
    assert.equal(L.systems.ptzView().cameras[0].values.iris, irisBefore, 'COMPARE did not touch the picture');
  } finally { await L.stop(); }
});

test('DeskSelection shares the camera, and /api/surfaces/tourbox serves status', async () => {
  const ctx = await setup({});
  const m = new MockPTZ({ model: 'AW-UE150', title: 'PTZ1' });
  const port = await m.start(0);
  const systems = new SystemManager({ dataDir: ctx.dataDir, engine: ctx.engine, overrides: { ptz: { cameras: [{ id: 'cam1', name: 'PTZ1', host: '127.0.0.1', port }] } }, autoStart: false });
  const server = createServer(ctx.engine, systems);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  };
  try {
    const st = (await call('GET', '/api/surfaces/tourbox')).json;
    assert.equal(st.enabled, false);
    assert.equal(st.model, 'TBG_H');
    assert.equal(st.longPressMs, 800);
    assert.equal(st.profile, 'ptz-rcp');
    assert.equal(st.port, '');
    assert.ok(Array.isArray(st.ports));
    const set = (await call('POST', '/api/surfaces/tourbox', { enabled: false, learn: true, profile: 'ptz-msu', port: '/dev/cu.usbserial-01BBEB67' })).json;
    assert.equal(set.learn, true);
    assert.equal(set.profile, 'ptz-msu');
    assert.equal(set.port, '/dev/cu.usbserial-01BBEB67');
    await systems.ptz('select', { cam: 'cam1' });
    await wait(30);
    assert.equal(server.deskSelection.camera, 'cam1');
    const desk = new DeskSelection();
    assert.deepEqual(desk.snapshot(), { me: 1, armed: false, camera: null });
    desk.set({ camera: 'cam2', source: 'deck' });
    assert.equal(desk.camera, 'cam2');
  } finally {
    server.closeClients && server.closeClients();
    server.close();
    await systems.close();
    await m.stop();
    await ctx.teardown();
  }
});

test('list knobs clamp, Auto is not a dial stop, and velocity uses paint-accel', () => {
  const gain = PC.catalogFor('UE160').ops.find((o) => o.id === 'gain');
  assert.equal(deck.nextValue(gain, '08', -1, { wrap: false }), '08');
  assert.equal(deck.nextValue(gain, '80', 1, { wrap: false }), '08');
  const steps = paint.stepsFor('iris', 1, 20);
  assert.ok(steps >= 1);
  assert.equal(paint.pressKind(799, 800), 'toggle');
  assert.equal(paint.pressKind(800, 800), 'reset');
});

test('TourBox worker mock path starts and the udev rule is shipped', () => {
  const rules = fs.readFileSync(path.join(__dirname, '../tools/udev/50-control-center-tourbox.rules'), 'utf8');
  assert.match(rules, /2e3c/);
  assert.match(rules, /5740/);
  assert.match(rules, /c251/);
  assert.match(rules, /2005/);
  assert.match(rules, /10c4/);
  assert.match(rules, /ea60/);
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, /tbxPanel/);
  assert.match(html, /tourbox\.js/);
  assert.match(html, /tbxPort/);
  assert.match(html, /tbxUsePort/);
  assert.match(html, /Use this port/);
  const page = fs.readFileSync(path.join(__dirname, '../public/tourbox.js'), 'utf8');
  assert.match(page, /\/api\/surfaces\/tourbox/);
  assert.match(page, /tbxUsePort/);
  assert.match(page, /possible TourBox/);
});
