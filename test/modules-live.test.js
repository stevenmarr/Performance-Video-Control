'use strict';
process.env.RS6_QUIET = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const { ModuleDesk } = require('../lib/modules/runtime');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('Brompton brightness, NovaStar checksum and HELIOS sACN channels', async () => {
  const { novastarBrightness, sacnPacket } = require('../lib/modules/transports');
  assert.equal(novastarBrightness(255).slice(-3).toString('hex'), 'ff545b');
  const packet = sacnPacket({ universe: 1, slots: [255, 0, 200, 119] });
  assert.equal(packet.slice(4, 13).toString(), 'ASC-E1.17');
  assert.equal(packet[128], 200);
  const seen = [];
  const httpServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { seen.push(`${req.method} ${req.url} ${body}`); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"brightness":5000}'); });
  });
  const httpPort = await listen(httpServer);
  const frames = [];
  const tcp = net.createServer((sock) => sock.on('data', (buf) => frames.push(Buffer.from(buf))));
  const tcpPort = await listen(tcp);
  const dgram = require('dgram');
  const sink = dgram.createSocket('udp4');
  const got = new Promise((resolve) => sink.once('message', resolve));
  await new Promise((resolve) => sink.bind(0, '127.0.0.1', resolve));
  const desk = new ModuleDesk();
  try {
    const tessera = desk.create('brompton-tessera', { connection: { host: '127.0.0.1', port: httpPort } });
    await desk.run(tessera.id, 'brightness', { value: 5000 });
    assert.ok(seen.some((line) => line.startsWith('PUT /api/output/global-colour/brightness') && line.includes('"data":5000')));
    const armed = await desk.run(tessera.id, 'blackout');
    assert.equal(armed.pending, true);
    const nova = desk.create('novastar-vxpro', { connection: { host: '127.0.0.1', port: tcpPort } });
    await desk.connect(nova.id);
    await desk.run(nova.id, 'brightness', { level: 255 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(Buffer.concat(frames).slice(-3).toString('hex'), 'ff545b');
    const wall = desk.create('helios', { connection: { host: '127.0.0.1', port: sink.address().port, universe: 1 } });
    await desk.run(wall.id, 'brightness', { level: 200 });
    const msg = await got;
    assert.equal(msg[128], 200);
  } finally {
    desk.close();
    sink.close();
    await new Promise((resolve) => httpServer.close(resolve));
    await new Promise((resolve) => tcp.close(resolve));
  }
});

test('Art-Net ArtDmx carries the opcode and the slot', async () => {
  const { artDmx } = require('../lib/modules/transports');
  const packet = artDmx({ universe: 1, slots: [0, 255] });
  assert.equal(packet.slice(0, 8).toString(), 'Art-Net\0');
  assert.equal(packet.readUInt16LE(8), 0x5000);
  assert.equal(packet[19], 255);
  const dgram = require('dgram');
  const sink = dgram.createSocket('udp4');
  const got = new Promise((resolve) => sink.once('message', resolve));
  await new Promise((resolve) => sink.bind(0, '127.0.0.1', resolve));
  const desk = new ModuleDesk();
  try {
    const row = desk.create('artnet', { connection: { host: '127.0.0.1', port: sink.address().port, universe: 0 } });
    await desk.run(row.id, 'slot', { channel: 2, value: 255, universe: 0 });
    const msg = await got;
    assert.equal(msg.slice(0, 8).toString(), 'Art-Net\0');
    assert.equal(msg[19], 255);
  } finally {
    desk.close();
    sink.close();
  }
});

test('X32 channel fader is the published OSC address', async () => {
  const dgram = require('dgram');
  const osc = require('../lib/drivers/osc');
  const sink = dgram.createSocket('udp4');
  const got = new Promise((resolve) => sink.once('message', resolve));
  await new Promise((resolve) => sink.bind(0, '127.0.0.1', resolve));
  const desk = new ModuleDesk();
  try {
    const row = desk.create('behringer-x32', { connection: { host: '127.0.0.1', port: sink.address().port } });
    await desk.run(row.id, 'fader', { channel: '01', level: '0.75' });
    const msg = osc.decode(await got);
    assert.equal(msg.address, '/ch/01/mix/fader');
    assert.equal(msg.args[0].type, 'f');
    assert.ok(Math.abs(msg.args[0].value - 0.75) < 0.001);
  } finally {
    desk.close();
    sink.close();
  }
});

test('Ki Pro record and KUMO crosspoint use the AJA /config parameters', async () => {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push(req.url); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"value":"1"}'); });
  const port = await listen(server);
  const desk = new ModuleDesk();
  try {
    const kipro = desk.create('aja-kipro', { connection: { host: '127.0.0.1', port } });
    const armed = await desk.run(kipro.id, 'record');
    assert.equal(armed.pending, true);
    await desk.run(kipro.id, 'record');
    assert.ok(seen.some((u) => u.includes('eParamID_TransportCommand') && u.includes('value=3')));
    const kumo = desk.create('aja-kumo', { connection: { host: '127.0.0.1', port } });
    await desk.run(kumo.id, 'crosspoint', { destination: 1, source: 2 });
    assert.ok(seen.some((u) => u.includes('eParamID_XPT_Destination1_Status') && u.includes('value=2')));
  } finally {
    desk.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('XPression TAKE uses the RossTalk framebuffer form', async () => {
  const lines = [];
  const server = net.createServer((sock) => sock.on('data', (buf) => { lines.push(buf.toString()); sock.write('OK\r\n'); }));
  const port = await listen(server);
  const desk = new ModuleDesk();
  try {
    const row = desk.create('ross-xpression', { connection: { host: '127.0.0.1', port } });
    await desk.connect(row.id);
    await desk.run(row.id, 'take', { take: '5', buffer: 0, layer: 7, expect: 'OK' });
    assert.ok(lines.some((l) => l.includes('TAKE 5:0:7')));
  } finally {
    desk.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('SmartView brightness is the Ethernet protocol block', async () => {
  const lines = [];
  const server = net.createServer((sock) => sock.on('data', (buf) => lines.push(buf.toString())));
  const port = await listen(server);
  const desk = new ModuleDesk();
  try {
    const row = desk.create('bmd-smartview', { connection: { host: '127.0.0.1', port, delimiter: '\\n\\n', reconnect: false } });
    await desk.connect(row.id);
    await desk.run(row.id, 'brightness', { monitor: 'A', value: 127 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const text = lines.join('');
    assert.match(text, /MONITOR A:\nBrightness: 127\n/);
  } finally {
    desk.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('LW3, Extron SIS and Kramer Protocol 3000 send the published route lines', async () => {
  const lines = [];
  const server = net.createServer((sock) => sock.on('data', (buf) => lines.push(buf.toString())));
  const port = await listen(server);
  const desk = new ModuleDesk();
  try {
    const lw = desk.create('lightware-lw3', { connection: { host: '127.0.0.1', port, delimiter: '\\r\\n', reconnect: false } });
    await desk.connect(lw.id);
    await desk.run(lw.id, 'switch', { input: 4, output: 1 });
    const ex = desk.create('extron-sis', { connection: { host: '127.0.0.1', port, delimiter: '\\r\\n', reconnect: false } });
    await desk.connect(ex.id);
    await desk.run(ex.id, 'tie', { input: 1, output: 3 });
    await desk.run(ex.id, 'video', { input: 7, output: 5 });
    const kr = desk.create('kramer-p3000', { connection: { host: '127.0.0.1', port, delimiter: '\\r', reconnect: false } });
    await desk.connect(kr.id);
    const armed = await desk.run(kr.id, 'preset', { preset: 3 });
    assert.equal(armed.pending, true);
    await desk.run(kr.id, 'preset', { preset: 3 });
    await desk.run(kr.id, 'route', { layer: 1, output: 4, input: 2 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const text = lines.join('');
    assert.match(text, /CALL \/MEDIA\/VIDEO\/XP:switch\(I4:O1\)\r\n/);
    assert.match(text, /1\*3!\r/);
    assert.match(text, /7\*5%\r/);
    assert.match(text, /#ROUTE 1,4,2\r/);
    assert.match(text, /#PRST-RCL 3\r/);
  } finally {
    desk.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('HELO record, Teranex output mode and Streaming Encoder start use the published commands', async () => {
  const seen = [];
  const httpServer = http.createServer((req, res) => { seen.push(req.url); res.writeHead(200); res.end('{"value":"1"}'); });
  const lines = [];
  const tcp = net.createServer((sock) => sock.on('data', (buf) => lines.push(buf.toString())));
  const httpPort = await listen(httpServer);
  const tcpPort = await listen(tcp);
  const desk = new ModuleDesk();
  try {
    const helo = desk.create('aja-helo', { connection: { host: '127.0.0.1', port: httpPort } });
    const armed = await desk.run(helo.id, 'record');
    assert.equal(armed.pending, true);
    await desk.run(helo.id, 'record');
    await desk.run(helo.id, 'recordingprofile', { profile: 2 });
    assert.ok(seen.some((u) => u.includes('eParamID_ReplicatorCommand') && u.includes('value=1')));
    assert.ok(seen.some((u) => u.includes('eParamID_RecordingProfileSel') && u.includes('value=2')));
    const teranex = desk.create('bmd-teranex', { connection: { host: '127.0.0.1', port: tcpPort, delimiter: '\\n', reconnect: false } });
    await desk.connect(teranex.id);
    await desk.run(teranex.id, 'output', { mode: '1080i5994' });
    const stream = desk.create('bmd-streaming', { connection: { host: '127.0.0.1', port: tcpPort, delimiter: '\\n', reconnect: false } });
    await desk.connect(stream.id);
    const live = await desk.run(stream.id, 'start');
    assert.equal(live.pending, true);
    await desk.run(stream.id, 'start');
    await new Promise((resolve) => setTimeout(resolve, 40));
    const text = lines.join('');
    assert.match(text, /VIDEO OUTPUT:\nVideo mode: 1080i5994\n/);
    assert.match(text, /STREAM STATE:\nAction: Start\n/);
  } finally {
    desk.close();
    await new Promise((resolve) => httpServer.close(resolve));
    await new Promise((resolve) => tcp.close(resolve));
  }
});

test('MagicQ go and blackout use the published OSC addresses', async () => {
  const dgram = require('dgram');
  const osc = require('../lib/drivers/osc');
  const sink = dgram.createSocket('udp4');
  const messages = [];
  sink.on('message', (msg) => messages.push(osc.decode(msg)));
  await new Promise((resolve) => sink.bind(0, '127.0.0.1', resolve));
  const desk = new ModuleDesk();
  try {
    const magic = desk.create('chamsys-magicq', { connection: { host: '127.0.0.1', port: sink.address().port } });
    await desk.run(magic.id, 'go', { playback: 1 });
    const armed = await desk.run(magic.id, 'blackout');
    assert.equal(armed.pending, true);
    await desk.run(magic.id, 'blackout');
    const quick = desk.create('chamsys-quickq', { connection: { host: '127.0.0.1', port: sink.address().port } });
    await desk.run(quick.id, 'go', { playback: 3 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.ok(messages.some((m) => m.address === '/pb/1/go' && m.args.length === 0));
    const dbo = messages.find((m) => m.address === '/dbo');
    assert.ok(dbo && dbo.args[0].type === 'i' && dbo.args[0].value === 0);
    assert.ok(messages.some((m) => m.address === '/pb/3/go'));
  } finally {
    desk.close();
    sink.close();
  }
});

test('X Air channel fader is the published OSC example', async () => {
  const dgram = require('dgram');
  const osc = require('../lib/drivers/osc');
  const sink = dgram.createSocket('udp4');
  const messages = [];
  sink.on('message', (msg) => messages.push(osc.decode(msg)));
  await new Promise((resolve) => sink.bind(0, '127.0.0.1', resolve));
  const desk = new ModuleDesk();
  try {
    const row = desk.create('behringer-xair', { connection: { host: '127.0.0.1', port: sink.address().port } });
    await desk.run(row.id, 'fader', { channel: '01', level: '0.5' });
    await desk.run(row.id, 'info');
    await new Promise((resolve) => setTimeout(resolve, 40));
    const fader = messages.find((m) => m.address === '/ch/01/mix/fader');
    assert.ok(fader && fader.args[0].type === 'f' && Math.abs(fader.args[0].value - 0.5) < 0.001);
    assert.ok(messages.some((m) => m.address === '/xinfo' && m.args.length === 0));
  } finally {
    desk.close();
    sink.close();
  }
});

test('LW2, Protocol 2000, dLive and Wing send the published messages', async () => {
  const { p2000Packet, dliveMute, dliveScene } = require('../lib/modules/transports');
  assert.equal(p2000Packet({ instruction: 1, input: 5, output: 8, machine: 3 }).toString('hex'), '01858883');
  assert.equal(dliveMute({ channel: 1, on: true, midi: 0 }).toString('hex'), '90007f900000');
  assert.equal(dliveScene({ scene: 1, midi: 0 }).toString('hex'), 'b00000c000');
  const lines = [];
  const server = net.createServer((sock) => sock.on('data', (buf) => lines.push(buf)));
  const port = await listen(server);
  const dgram = require('dgram');
  const osc = require('../lib/drivers/osc');
  const sink = dgram.createSocket('udp4');
  const messages = [];
  sink.on('message', (msg) => messages.push(osc.decode(msg)));
  await new Promise((resolve) => sink.bind(0, '127.0.0.1', resolve));
  const desk = new ModuleDesk();
  try {
    const lw = desk.create('lightware-lw2', { connection: { host: '127.0.0.1', port, reconnect: false } });
    await desk.connect(lw.id);
    await desk.run(lw.id, 'switch', { input: 1, output: 5 });
    const kr = desk.create('kramer-p2000', { connection: { host: '127.0.0.1', port, reconnect: false } });
    await desk.connect(kr.id);
    await desk.run(kr.id, 'video', { input: 5, output: 8, machine: 3 });
    const dl = desk.create('allenheath-dlive', { connection: { host: '127.0.0.1', port, midiChannel: 1, reconnect: false } });
    await desk.connect(dl.id);
    await desk.run(dl.id, 'mute', { channel: 1 });
    const wing = desk.create('behringer-wing', { connection: { host: '127.0.0.1', port: sink.address().port } });
    await desk.run(wing.id, 'fader', { channel: 2, db: '-2.5' });
    await desk.run(wing.id, 'mute', { channel: 1 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const text = Buffer.concat(lines);
    assert.ok(text.includes(Buffer.from('{1@5}')));
    assert.ok(text.includes(Buffer.from('01858883', 'hex')));
    assert.ok(text.includes(Buffer.from('90007f900000', 'hex')));
    const fader = messages.find((m) => m.address === '/ch/2/fdr');
    assert.ok(fader && fader.args[0].type === 'f' && Math.abs(fader.args[0].value + 2.5) < 0.001);
    const mute = messages.find((m) => m.address === '/ch/1/mute');
    assert.ok(mute && mute.args[0].type === 'i' && mute.args[0].value === 1);
  } finally {
    desk.close();
    sink.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('HS6000 bus select, Spyder transition and PDS preset use the published commands', async () => {
  const { spyderPacket } = require('../lib/modules/transports');
  const spy = spyderPacket('METR 1 D1');
  assert.equal(spy.slice(0, 6).toString(), 'spyder');
  assert.equal(spy[6], 0);
  assert.equal(spy.slice(10).toString(), 'METR 1 D1');
  const lines = [];
  const tcp = net.createServer((sock) => sock.on('data', (buf) => lines.push(buf)));
  const tcpPort = await listen(tcp);
  const dgram = require('dgram');
  const sink = dgram.createSocket('udp4');
  const got = new Promise((resolve) => sink.once('message', resolve));
  await new Promise((resolve) => sink.bind(0, '127.0.0.1', resolve));
  const desk = new ModuleDesk();
  try {
    const hs = desk.create('panasonic-hs6000', { connection: { host: '127.0.0.1', port: tcpPort, reconnect: false } });
    await desk.connect(hs.id);
    await desk.run(hs.id, 'bus', { bus: '01', source: '02' });
    const pds = desk.create('barco-pds', { connection: { host: '127.0.0.1', port: tcpPort, delimiter: '\\r\\n', reconnect: false } });
    await desk.connect(pds.id);
    const armed = await desk.run(pds.id, 'recall', { preset: 10 });
    assert.equal(armed.pending, true);
    await desk.run(pds.id, 'recall', { preset: 10 });
    const sp = desk.create('christie-spyder', { connection: { host: '127.0.0.1', port: sink.address().port } });
    const armedTake = await desk.run(sp.id, 'transition', { mix: 1, frames: 1 });
    assert.equal(armedTake.pending, true);
    await desk.run(sp.id, 'transition', { mix: 1, frames: 1 });
    const packet = await got;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const text = Buffer.concat(lines);
    assert.equal(text[0], 0x02);
    assert.ok(text.includes(Buffer.from('SBUS:01:02')));
    assert.ok(text.includes(0x03));
    assert.ok(text.includes(Buffer.from('PRESET -r 10\r')));
    assert.equal(packet.slice(0, 6).toString(), 'spyder');
    assert.equal(packet.slice(10).toString(), 'METR 1 D1');
  } finally {
    desk.close();
    sink.close();
    await new Promise((resolve) => tcp.close(resolve));
  }
});

test('Canon preset, V-60HD cut and WATCHOUT run use the published commands', async () => {
  const seen = [];
  const httpServer = http.createServer((req, res) => { seen.push(req.url); res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('p=1\n'); });
  const lines = [];
  const tcp = net.createServer((sock) => sock.on('data', (buf) => lines.push(buf)));
  const httpPort = await listen(httpServer);
  const tcpPort = await listen(tcp);
  const desk = new ModuleDesk();
  try {
    const canon = desk.create('canon-xc', { connection: { host: '127.0.0.1', port: httpPort } });
    await desk.run(canon.id, 'preset', { preset: 1 });
    await desk.run(canon.id, 'stop');
    const roland = desk.create('roland-v60hd', { connection: { host: '127.0.0.1', port: tcpPort, reconnect: false } });
    await desk.connect(roland.id);
    await desk.run(roland.id, 'program', { input: 0 });
    const armed = await desk.run(roland.id, 'cut');
    assert.equal(armed.pending, true);
    await desk.run(roland.id, 'cut');
    const wo = desk.create('dataton-watchout', { connection: { host: '127.0.0.1', port: tcpPort, delimiter: '\\r\\n', reconnect: false } });
    await desk.connect(wo.id);
    await desk.run(wo.id, 'run');
    await desk.run(wo.id, 'cue', { cue: 'Cue1' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(seen.some((u) => u.includes('/-wvhttp-01-/control.cgi') && u.includes('p=1')));
    assert.ok(seen.some((u) => u.includes('p.action=stop')));
    const text = Buffer.concat(lines);
    assert.ok(text.includes(Buffer.from('\x02PGM:0;')));
    assert.ok(text.includes(Buffer.from('\x02CUT;')));
    assert.ok(text.includes(Buffer.from('run\r\n')));
    assert.ok(text.includes(Buffer.from('gotoControlCue Cue1\r\n')));
  } finally {
    desk.close();
    await new Promise((resolve) => httpServer.close(resolve));
    await new Promise((resolve) => tcp.close(resolve));
  }
});

test('Colorlight brightness, COEX cabinet brightness and Roland basic cut use the published commands', async () => {
  const seen = [];
  const httpServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"code":0,"message":"Success"}');
    });
  });
  const lines = [];
  const tcp = net.createServer((sock) => sock.on('data', (buf) => lines.push(buf.toString())));
  const httpPort = await listen(httpServer);
  const tcpPort = await listen(tcp);
  const desk = new ModuleDesk();
  try {
    const color = desk.create('colorlight-processor', { connection: { host: '127.0.0.1', port: httpPort } });
    await desk.run(color.id, 'brightness', { index: 0, group: 0, brightness: 80 });
    const coex = desk.create('novastar-coex', { connection: { host: '127.0.0.1', port: httpPort } });
    await desk.run(coex.id, 'cabinet', { cabinet: '42', ratio: '0.5' });
    const roland = desk.create('roland-basic', { connection: { host: '127.0.0.1', port: tcpPort, delimiter: '\\n', reconnect: false } });
    await desk.connect(roland.id);
    await desk.run(roland.id, 'program', { channel: 'INPUT2' });
    const armed = await desk.run(roland.id, 'cut');
    assert.equal(armed.pending, true);
    await desk.run(roland.id, 'cut');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const bright = seen.find((s) => s.url.includes('/processor/setBrightness'));
    assert.equal(bright.method, 'POST');
    assert.equal(JSON.parse(bright.body).data.brightness, 80);
    const cab = seen.find((s) => s.url.includes('/api/v1/device/cabinet/brightness'));
    assert.equal(cab.method, 'PUT');
    assert.equal(JSON.parse(cab.body).ratio, 0.5);
    const text = lines.join('');
    assert.match(text, /PGM:INPUT2;/);
    assert.match(text, /CUT;/);
  } finally {
    desk.close();
    await new Promise((resolve) => httpServer.close(resolve));
    await new Promise((resolve) => tcp.close(resolve));
  }
});

test('Q-SYS, Tesira, MXA910, Bravia and AHM send the published commands', async () => {
  const { braviaSimple } = require('../lib/modules/transports');
  const on = braviaSimple('POWR', '1');
  assert.equal(on.length, 24);
  assert.equal(on.slice(0, 7).toString(), '*SCPOWR');
  assert.equal(on[22], 0x31);
  assert.equal(on[23], 0x0a);
  const lines = [];
  const server = net.createServer((sock) => sock.on('data', (buf) => lines.push(buf)));
  const port = await listen(server);
  const desk = new ModuleDesk();
  try {
    const q = desk.create('qsys-qrc', { connection: { host: '127.0.0.1', port, delimiter: '\\0', reconnect: false } });
    await desk.connect(q.id);
    await desk.run(q.id, 'set', { name: 'MainGain', value: '-12' });
    const tesira = desk.create('biamp-tesira', { connection: { host: '127.0.0.1', port, delimiter: '\\n', reconnect: false } });
    await desk.connect(tesira.id);
    const armed = await desk.run(tesira.id, 'preset', { preset: 1001 });
    assert.equal(armed.pending, true);
    await desk.run(tesira.id, 'preset', { preset: 1001 });
    const shure = desk.create('shure-mxa910', { connection: { host: '127.0.0.1', port, delimiter: '\\r', reconnect: false } });
    await desk.connect(shure.id);
    await desk.run(shure.id, 'mute', { channel: '1' });
    const tv = desk.create('sony-bravia-simple', { connection: { host: '127.0.0.1', port, reconnect: false } });
    await desk.connect(tv.id);
    await desk.run(tv.id, 'on');
    const ahm = desk.create('allenheath-ahm', { connection: { host: '127.0.0.1', port, reconnect: false } });
    await desk.connect(ahm.id);
    await desk.run(ahm.id, 'mute', { channel: 1 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const text = Buffer.concat(lines);
    assert.ok(text.includes(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"Control.Set","params":{"Name":"MainGain","Value":-12}}\0')));
    assert.ok(text.includes(Buffer.from('DEVICE recallPreset 1001\n')));
    assert.ok(text.includes(Buffer.from('< SET 1 AUDIO_MUTE ON >\r')));
    assert.ok(text.includes(on));
    assert.ok(text.includes(Buffer.from('90007f900000', 'hex')));
  } finally {
    desk.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('NEC power, Samsung MDC, Ultimatte density and Wake-on-LAN match the published bytes', async () => {
  const { necPower, samsungMdcPower, wakeOnLan } = require('../lib/modules/transports');
  const on = necPower(true, 'A');
  let bcc = 0;
  for (const byte of on.subarray(1, on.length - 2)) bcc ^= byte;
  assert.equal(on[on.length - 2], bcc);
  assert.equal(on[on.length - 1], 0x0d);
  assert.ok(on.includes(Buffer.from('C203D60001')));
  assert.equal(samsungMdcPower(1, false).toString('hex'), 'aa11010012');
  assert.equal(samsungMdcPower(1, true).toString('hex'), 'aa11010113');
  const lines = [];
  const server = net.createServer((sock) => sock.on('data', (buf) => lines.push(buf)));
  const port = await listen(server);
  const dgram = require('dgram');
  const sink = dgram.createSocket('udp4');
  const got = new Promise((resolve) => sink.once('message', resolve));
  await new Promise((resolve) => sink.bind(0, '127.0.0.1', resolve));
  const desk = new ModuleDesk();
  try {
    const nec = desk.create('nec-display', { connection: { host: '127.0.0.1', port, monitor: 'A', reconnect: false } });
    await desk.connect(nec.id);
    await desk.run(nec.id, 'on');
    const sam = desk.create('samsung-mdc', { connection: { host: '127.0.0.1', port, monitorId: 1, reconnect: false } });
    await desk.connect(sam.id);
    const armed = await desk.run(sam.id, 'off', { id: 1 });
    assert.equal(armed.pending, true);
    await desk.run(sam.id, 'off', { id: 1 });
    const ult = desk.create('bmd-ultimatte', { connection: { host: '127.0.0.1', port, delimiter: '\\n', reconnect: false } });
    await desk.connect(ult.id);
    await desk.run(ult.id, 'matte', { value: 100 });
    const wol = desk.create('wake-on-lan', { connection: { host: '127.0.0.1', port: sink.address().port, mac: '00:11:22:33:44:55' } });
    await desk.run(wol.id, 'wake', { mac: '00:11:22:33:44:55' });
    const packet = await got;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const text = Buffer.concat(lines);
    assert.ok(text.includes(on));
    assert.ok(text.includes(Buffer.from('aa11010012', 'hex')));
    assert.match(text.toString(), /CONTROL:\nMatte Density: 100\n/);
    assert.equal(packet.length, 102);
    assert.equal(packet.slice(0, 6).toString('hex'), 'ffffffffffff');
    assert.equal(packet.slice(6, 12).toString('hex'), '001122334455');
  } finally {
    desk.close();
    sink.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Epson opens ESC/VP.net and then sends PWR ON', async () => {
  const lines = [];
  const server = net.createServer((sock) => sock.on('data', (buf) => lines.push(buf)));
  const port = await listen(server);
  const desk = new ModuleDesk();
  try {
    const row = desk.create('epson-projector', { connection: { host: '127.0.0.1', port, delimiter: '\\r', reconnect: false } });
    await desk.connect(row.id);
    await desk.run(row.id, 'on');
    await desk.run(row.id, 'hdmi1');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const text = Buffer.concat(lines);
    assert.equal(text.slice(0, 16).toString('hex'), '4553432f56502e6e6574100300000000');
    assert.ok(text.includes(Buffer.from('PWR ON\r')));
    assert.ok(text.includes(Buffer.from('SOURCE 30\r')));
    assert.equal(text.indexOf(Buffer.from('PWR ON')), 16);
  } finally {
    desk.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the new display, camera, console, timer and protocol systems send their published commands', async () => {
  const T = require('../lib/modules/transports');
  const { get } = require('../lib/modules/catalog');
  assert.equal(T.quMute({ channel: 1, on: true }).toString('hex'), '90207f902000');
  assert.equal(T.quScene({ scene: 1 }).toString('hex'), 'b00000b02000c000');
  assert.equal(T.modbusWriteRegister({ unit: 1, address: 0, value: 1 }).toString('hex'), '000100000006010600000001');
  assert.equal(T.mscCommand(1).toString('hex'), 'f07f7f0201f7');
  assert.ok(T.mqttPublish({ topic: 'a', payload: '1', clientId: 'cc' }).includes(Buffer.from('MQTT')));
  assert.equal(T.snmpSet({ community: 'public', oid: '1.3.6.1.2.1.1.1.0', value: 1 })[0], 0x30);
  for (const id of ['panasonic-projector', 'optoma-projector', 'vivitek-projector', 'sanyo-projector', 'eiki-projector', 'digital-projection']) {
    assert.equal(get(id).actionMap.get('on').execute.command, '%1POWR 1\r');
  }
  const lines = [];
  const tcp = net.createServer((sock) => sock.on('data', (buf) => lines.push(buf)));
  const port = await listen(tcp);
  const dgram = require('dgram');
  const sink = dgram.createSocket('udp4');
  const packets = [];
  sink.on('message', (msg) => packets.push(msg));
  await new Promise((resolve) => sink.bind(0, '127.0.0.1', resolve));
  const desk = new ModuleDesk();
  try {
    const lg = desk.create('lg-signage', { connection: { host: '127.0.0.1', port, reconnect: false } });
    await desk.connect(lg.id);
    await desk.run(lg.id, 'on', { id: '01' });
    const sharp = desk.create('sharp-ascii', { connection: { host: '127.0.0.1', port, delimiter: '\\r', reconnect: false } });
    await desk.connect(sharp.id);
    await desk.run(sharp.id, 'on');
    const qu = desk.create('allenheath-qu', { connection: { host: '127.0.0.1', port, reconnect: false } });
    await desk.connect(qu.id);
    await desk.run(qu.id, 'mute', { channel: 1 });
    const sym = desk.create('symetrix-dsp', { connection: { host: '127.0.0.1', port, delimiter: '\\r', reconnect: false } });
    await desk.connect(sym.id);
    await desk.run(sym.id, 'set', { controller: 100, position: 32768 });
    const para = desk.create('etc-paradigm', { connection: { host: '127.0.0.1', port: sink.address().port } });
    await desk.run(para.id, 'preset', { name: 'P1' });
    await desk.run(para.id, 'preset', { name: 'P1' });
    const clock = desk.create('clock-8001', { connection: { host: '127.0.0.1', port: sink.address().port } });
    await desk.run(clock.id, 'down', { timer: 0, seconds: 60 });
    const msc = desk.create('midi-show-control', { connection: { host: '127.0.0.1', port: sink.address().port } });
    await desk.run(msc.id, 'go');
    await new Promise((resolve) => setTimeout(resolve, 40));
    const text = Buffer.concat(lines);
    assert.ok(text.includes(Buffer.from('ka 01 01\r')));
    assert.ok(text.includes(Buffer.from('power on\r')));
    assert.ok(text.includes(Buffer.from('90207f902000', 'hex')));
    assert.ok(text.includes(Buffer.from('CS 100 32768\r')));
    const osc = require('../lib/drivers/osc');
    assert.ok(packets.some((p) => p.includes(Buffer.from('pst act P1\r'))));
    assert.ok(packets.some((p) => { const m = osc.decode(p); return m && m.address === '/clock/timer/0/countdown'; }));
    assert.ok(packets.some((p) => p.toString('hex') === 'f07f7f0201f7'));
  } finally {
    desk.close();
    sink.close();
    await new Promise((resolve) => tcp.close(resolve));
  }
});

test('the live-event consoles, multiview, recorders, cameras and graphics send their published commands', async () => {
  const { get } = require('../lib/modules/catalog');
  assert.equal(get('viz-flowics').actionMap.get('output').execute.path, '/graphics/$(options:token)/control');
  const lines = [];
  const tcp = net.createServer((sock) => sock.on('data', (buf) => lines.push(buf)));
  const port = await listen(tcp);
  const seen = [];
  const web = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { seen.push(`${req.method} ${req.url} ${body}`); res.writeHead(204); res.end(); });
  });
  const webPort = await listen(web);
  const dgram = require('dgram');
  const sink = dgram.createSocket('udp4');
  const packets = [];
  sink.on('message', (msg) => packets.push(msg));
  await new Promise((resolve) => sink.bind(0, '127.0.0.1', resolve));
  const udp = sink.address().port;
  const desk = new ModuleDesk();
  try {
    const tcpConn = { host: '127.0.0.1', port, reconnect: false };
    const avantis = desk.create('allenheath-avantis', { connection: { ...tcpConn, midiChannel: 12 } });
    await desk.connect(avantis.id);
    await desk.run(avantis.id, 'mute', { channel: 1 });
    const cq = desk.create('allenheath-cq', { connection: { ...tcpConn, midiChannel: 1 } });
    await desk.connect(cq.id);
    await desk.run(cq.id, 'mute', { channel: 1 });
    const mv = desk.create('bmd-multiview', { connection: tcpConn });
    await desk.connect(mv.id);
    await desk.run(mv.id, 'route', { output: 7, input: 2 });
    const smp = desk.create('extron-smp351', { connection: tcpConn });
    await desk.connect(smp.id);
    await desk.run(smp.id, 'stop');
    const pcs = desk.create('extron-pcs4', { connection: tcpConn });
    await desk.connect(pcs.id);
    await desk.run(pcs.id, 'on', { port: 1 });
    const vaddio = desk.create('vaddio-ptz', { connection: tcpConn });
    await desk.connect(vaddio.id);
    await desk.run(vaddio.id, 'preset', { preset: 3 });
    await desk.run(vaddio.id, 'home');
    const ross = desk.create('ross-videoserver', { connection: tcpConn });
    await desk.connect(ross.id);
    await desk.run(ross.id, 'play', { channel: 'B' });
    const cap = desk.create('ross-caprica', { connection: tcpConn });
    await desk.connect(cap.id);
    await desk.run(cap.id, 'cut', { me: '0' });
    const trio = desk.create('viz-trio', { connection: tcpConn });
    await desk.connect(trio.id);
    await desk.run(trio.id, 'take', { page: '1000' });
    const pic = desk.create('picturall', { connection: tcpConn });
    await desk.connect(pic.id);
    await desk.run(pic.id, 'select', { layer: 1, slot: 3, collection: 2 });
    const cam = desk.create('bmd-cameras', { connection: { host: '127.0.0.1', port: webPort, https: false } });
    await desk.run(cam.id, 'stop');
    const spx = desk.create('spx-graphics', { connection: { host: '127.0.0.1', port: webPort } });
    await desk.run(spx.id, 'play');
    const wled = desk.create('wled', { connection: { host: '127.0.0.1', port: webPort } });
    await desk.run(wled.id, 'on', { bri: 255 });
    const udpConn = { host: '127.0.0.1', port: udp };
    const aver = desk.create('aver-ptz', { connection: udpConn });
    await desk.run(aver.id, 'preset');
    const dm = desk.create('yamaha-dm', { connection: udpConn });
    await desk.run(dm.id, 'on', { channel: 1 });
    const tcc = desk.create('sennheiser-tcc2', { connection: udpConn });
    await desk.run(tcc.id, 'mute');
    const ew = desk.create('sennheiser-ewdx', { connection: udpConn });
    await desk.run(ew.id, 'mute1');
    const dis = desk.create('disguise-osc', { connection: udpConn });
    await desk.run(dis.id, 'play');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const text = Buffer.concat(lines);
    assert.ok(text.includes(Buffer.from('9b007f9b0000', 'hex')));
    assert.ok(text.includes(Buffer.from('b06300b06200b00600b02601', 'hex')));
    assert.ok(text.includes(Buffer.from('VIDEO OUTPUT ROUTING:\n7 2\n\n')));
    assert.ok(text.includes(Buffer.from('EY0RCDR}')));
    assert.ok(text.includes(Buffer.from('W1*1PC|')));
    assert.ok(text.includes(Buffer.from('camera preset recall 3\r')));
    assert.ok(text.includes(Buffer.from('camera home\r')));
    assert.ok(text.includes(Buffer.from('PLAY B\r\n')));
    assert.ok(text.includes(Buffer.from('SW MECUT : ME : 0\r\n')));
    assert.ok(text.includes(Buffer.from('page:take 1000\r\n')));
    assert.ok(text.includes(Buffer.from('set source1 selection slot=3,collection=2\r\n')));
    assert.ok(seen.includes('POST /control/api/v1/transports/0/stop '));
    assert.ok(seen.includes('GET /api/v1/rundown/play '));
    assert.ok(seen.some((row) => row.startsWith('POST /json/state ') && row.includes('"bri":255')));
    const osc = require('../lib/drivers/osc');
    assert.ok(packets.some((p) => p.includes(Buffer.from([0x81, 0x01, 0x04, 0x3F, 0x02, 0x01, 0xFF]))));
    assert.ok(packets.some((p) => { const m = osc.decode(p); return m && m.address === '/yosc:req/set/MIXER:Current/InCh/Fader/On/1/1'; }));
    assert.ok(packets.some((p) => p.includes(Buffer.from('{"out1":{"xlr1":{"mute":true}}}'))));
    assert.ok(packets.some((p) => p.includes(Buffer.from('{"rx1":{"mute":true}}'))));
    assert.ok(packets.some((p) => { const m = osc.decode(p); return m && m.address === '/d3/showcontrol/play'; }));
  } finally {
    desk.close();
    sink.close();
    await new Promise((resolve) => tcp.close(resolve));
    await new Promise((resolve) => web.close(resolve));
  }
});

test('the PDU, camera, graphics and timer systems send their published commands', async () => {
  const lines = [];
  const tcp = net.createServer((sock) => sock.on('data', (buf) => lines.push(buf)));
  const port = await listen(tcp);
  const seen = [];
  const web = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { seen.push(`${req.method} ${req.url} ${body}`); res.writeHead(204); res.end(); });
  });
  const webPort = await listen(web);
  const dgram = require('dgram');
  const sink = dgram.createSocket('udp4');
  const packets = [];
  sink.on('message', (msg) => packets.push(msg));
  await new Promise((resolve) => sink.bind(0, '127.0.0.1', resolve));
  const udp = sink.address().port;
  const desk = new ModuleDesk();
  try {
    const tcpConn = { host: '127.0.0.1', port, reconnect: false };
    const apc = desk.create('apc-rackpdu', { connection: tcpConn });
    await desk.connect(apc.id);
    await desk.run(apc.id, 'on', { outlet: 1 });
    const atdm = desk.create('audiotechnica-atdm', { connection: tcpConn });
    await desk.connect(atdm.id);
    await desk.run(atdm.id, 'mute', { output: 0 });
    const audia = desk.create('biamp-audia', { connection: tcpConn });
    await desk.connect(audia.id);
    await desk.run(audia.id, 'preset', { preset: 1004 });
    await desk.run(audia.id, 'preset', { preset: 1004 });
    const denon = desk.create('denon-dn500', { connection: tcpConn });
    await desk.connect(denon.id);
    await desk.run(denon.id, 'on');
    const iris = desk.create('irisdown-timer', { connection: tcpConn });
    await desk.connect(iris.id);
    await desk.run(iris.id, 'go');
    const httpConn = { host: '127.0.0.1', port: webPort, https: false };
    const gude = desk.create('gude-pdu', { connection: httpConn });
    await desk.run(gude.id, 'on', { output: 1 });
    const neol = desk.create('neol-epowerswitch', { connection: httpConn });
    await desk.run(neol.id, 'on', { outlet: 1 });
    const iboot = desk.create('dataprobe-iboot', { connection: httpConn });
    await desk.run(iboot.id, 'on', { token: 'abcd', outlet: 1 });
    const aten = desk.create('aten-pdu', { connection: { ...httpConn, https: false } });
    await desk.run(aten.id, 'off', { user: 'admin', pass: 'secret', index: 1 });
    await desk.run(aten.id, 'off', { user: 'admin', pass: 'secret', index: 1 });
    const bravia = desk.create('sony-bravia', { connection: { ...httpConn, psk: '1234' } });
    await desk.run(bravia.id, 'hdmi', { port: 2 });
    const fos = desk.create('foscam-ptz', { connection: { ...httpConn, username: 'admin', password: '' } });
    await desk.run(fos.id, 'preset', { name: 'test' });
    const zm = desk.create('zoneminder', { connection: httpConn });
    await desk.run(zm.id, 'off', { monitor: 1 });
    const h2r = desk.create('h2r-graphics', { connection: { ...httpConn, project: 'ABCD' } });
    await desk.run(h2r.id, 'run');
    const mos = desk.create('viz-mosart', { connection: { ...httpConn, key: 'test-api-key' } });
    await desk.run(mos.id, 'next');
    const lil = desk.create('lilliput-matrix', { connection: { host: '127.0.0.1', port: udp } });
    await desk.run(lil.id, 'route', { input: 1, output: 2 });
    const cue = desk.create('cuetimer', { connection: { host: '127.0.0.1', port: udp } });
    await desk.run(cue.id, 'fire');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const text = Buffer.concat(lines);
    assert.ok(text.includes(Buffer.from('on 1\r')));
    assert.ok(text.includes(Buffer.from('s_output_mute S 0000 00 NC 0,1\r')));
    assert.ok(text.includes(Buffer.from('RECALL 0 PRESET 1004\n')));
    assert.ok(text.includes(Buffer.from('@0PW00\r')));
    assert.ok(text.includes(Buffer.from('GO\r\n')));
    assert.ok(seen.includes('GET /ov.html?cmd=1&p=1&s=1 '));
    assert.ok(seen.includes('GET /hidden.htm?M0:O1=ON '));
    assert.ok(seen.some((row) => row.startsWith('POST /services/control/') && row.includes('"command":"on"') && row.includes('"outlets":[1]')));
    assert.ok(seen.some((row) => row.startsWith('POST /api/outlet/relay ') && row.includes('method=off') && row.includes('index=1')));
    assert.ok(seen.some((row) => row.startsWith('POST /sony/avContent ') && row.includes('extInput:hdmi?port=2')));
    assert.ok(seen.includes('GET /cgi-bin/CGIProxy.fcgi?cmd=ptzGotoPresetPoint&name=test&usr=admin&pwd= '));
    assert.ok(seen.includes('GET /zm/api/monitors/alarm/id:1/command:off.json '));
    assert.ok(seen.includes('POST /api/ABCD/run '));
    assert.ok(seen.includes('GET /api/v1/command/start-continue '));
    const osc = require('../lib/drivers/osc');
    assert.ok(packets.some((p) => p.toString() === '1v2.'));
    assert.ok(packets.some((p) => { const m = osc.decode(p); return m && m.address === '/global/fire'; }));
  } finally {
    desk.close();
    sink.close();
    await new Promise((resolve) => tcp.close(resolve));
    await new Promise((resolve) => web.close(resolve));
  }
});

test('the matrix, display, router and show-control systems send their published commands', async () => {
  const lines = [];
  const tcp = net.createServer((sock) => sock.on('data', (buf) => lines.push(buf)));
  const port = await listen(tcp);
  const seen = [];
  const web = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => { seen.push(`${req.method} ${req.url}`); res.writeHead(204); res.end(); });
  });
  const webPort = await listen(web);
  const dgram = require('dgram');
  const sink = dgram.createSocket('udp4');
  const packets = [];
  sink.on('message', (msg) => packets.push(msg));
  await new Promise((resolve) => sink.bind(0, '127.0.0.1', resolve));
  const udp = sink.address().port;
  const desk = new ModuleDesk();
  try {
    const tcpConn = { host: '127.0.0.1', port, reconnect: false };
    const pairs = [
      ['wyrestorm-matrix', 'route', { input: 4, output: 1 }],
      ['blustream-matrix', 'route', { output: '01', input: '04' }],
      ['tesmart-matrix', 'route', { input: '01', output: '02' }],
      ['gefen-matrix', 'route', { input: 7, output: 3 }],
      ['directout', 'route', { dest: 65, src: 66 }],
      ['panasonic-th', 'on', {}],
      ['atlona-omega', 'input', { input: 2 }],
      ['atlona-clso', 'hdmi', { input: 2 }],
      ['atnd1061', 'mute', {}],
      ['vidblaster', 'record', { recorder: 1 }],
      ['blackbird-matrix', 'route', { input: 1, output: 2 }],
      ['cyp-matrix', 'route', { output: 'A', input: 1 }],
    ];
    for (const [system, action, options] of pairs) {
      const row = desk.create(system, { connection: tcpConn });
      await desk.connect(row.id);
      await desk.run(row.id, action, options);
      if (action === 'record') await desk.run(row.id, action, options);
    }
    const box = desk.create('wattbox', { connection: { host: '127.0.0.1', port: webPort, https: false, authType: 'basic' } });
    await desk.run(box.id, 'on', { outlet: 1 });
    const cue = desk.create('cueserver', { connection: { host: '127.0.0.1', port: udp } });
    await desk.run(cue.id, 'go', { cue: 1 });
    const avm = desk.create('avmatrix-switcher', { connection: { host: '127.0.0.1', port: udp } });
    await desk.run(avm.id, 'route', { input: 1, output: 2 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const text = Buffer.concat(lines);
    assert.ok(text.includes(Buffer.from('SET SW in4 out1\n')));
    assert.ok(text.includes(Buffer.from('OUT01FR04\r')));
    assert.ok(text.includes(Buffer.from('MT00SW0102NT\r')));
    assert.ok(text.includes(Buffer.from('r 7 3\r')));
    assert.ok(text.includes(Buffer.from('audioxp 1 65 66\r')));
    assert.ok(text.includes(Buffer.from('\x02PON\x03')));
    assert.ok(text.includes(Buffer.from('x2AVx1\r')));
    assert.ok(text.includes(Buffer.from('Input HDMI 2\r')));
    assert.ok(text.includes(Buffer.from('s_output_mute S 0000 00 NC 0,1\r')));
    assert.ok(text.includes(Buffer.from('apiwrite recorder 1, record, true\r\n')));
    assert.ok(text.includes(Buffer.from('1V2.\r')));
    assert.ok(text.includes(Buffer.from('set out A route 1\r')));
    assert.ok(seen.includes('GET /control.cgi?outlet=1&command=1'));
    assert.ok(packets.some((p) => p.toString() === 'Cue 1 Go'));
    assert.ok(packets.some((p) => p.toString() === '1v2.'));
  } finally {
    desk.close();
    sink.close();
    await new Promise((resolve) => tcp.close(resolve));
    await new Promise((resolve) => web.close(resolve));
  }
});

test('the audio, lighting and playback systems send their published commands', async () => {
  const lines = [];
  const tcp = net.createServer((sock) => sock.on('data', (buf) => lines.push(buf)));
  const port = await listen(tcp);
  const seen = [];
  const web = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { seen.push(`${req.method} ${req.url} ${body}`); res.writeHead(204); res.end(); });
  });
  const webPort = await listen(web);
  const dgram = require('dgram');
  const osc = require('../lib/drivers/osc');
  const sink = dgram.createSocket('udp4');
  const packets = [];
  sink.on('message', (msg) => packets.push(msg));
  await new Promise((resolve) => sink.bind(0, '127.0.0.1', resolve));
  const udp = sink.address().port;
  const desk = new ModuleDesk();
  try {
    const tcpConn = { host: '127.0.0.1', port, reconnect: false };
    for (const [system, action, options] of [
      ['audac-mtx', 'route', { zone: 1, input: 3 }],
      ['audac-mtx', 'mute', { zone: 1 }],
      ['atlasied-atmosphere', 'gain', {}],
      ['axia-livewire', 'login', {}],
      ['axia-livewire', 'route', { destination: 1, address: '239.190.1.1' }],
      ['delta-media', 'play', { timeline: 1 }],
    ]) {
      const row = desk.create(system, { connection: tcpConn });
      await desk.connect(row.id);
      await desk.run(row.id, action, options);
    }
    const titan = desk.create('avolites-titan', { connection: { host: '127.0.0.1', port: webPort, https: false } });
    await desk.run(titan.id, 'fire', { user: 6, level: 1 });
    const watchout = desk.create('dataton-watchout-json', { connection: { host: '127.0.0.1', port: webPort, https: false } });
    await desk.run(watchout.id, 'play', { timeline: 1 });
    const hog = desk.create('highend-hog4', { connection: { host: '127.0.0.1', port: udp } });
    await desk.run(hog.id, 'go', { list: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const text = Buffer.concat(lines);
    assert.ok(text.includes(Buffer.from('#|X001|web|SR1|3|U|\r\n')));
    assert.ok(text.includes(Buffer.from('#|X001|web|SM01|1|U|\r\n')));
    assert.ok(text.includes(Buffer.from('{"jsonrpc":"2.0","method":"set","params":[{"param":"ZoneGain_0","pct":50},{"param":"ZoneGain_1","val":-20}]}\n')));
    assert.ok(text.includes(Buffer.from('LOGIN\r\n')));
    assert.ok(text.includes(Buffer.from('DST 1 ADDR:"239.190.1.1"\r\n')));
    assert.ok(text.includes(Buffer.from('PLAY TL=1\r')));
    assert.ok(seen.some((line) => line.startsWith('GET /titan/script/2/Playbacks/FirePlaybackAtLevel?handle_userNumber=6&level_level=1&alwaysRefire=true')));
    assert.ok(seen.some((line) => line.startsWith('POST /v0/play/1')));
    assert.ok(packets.some((p) => {
      const m = osc.decode(p);
      return m && m.address === '/hog/playback/go/0' && m.args[0] && m.args[0].type === 'i' && m.args[0].value === 1;
    }));
    const mq = desk.create('magicq-udp', { connection: { host: '127.0.0.1', port: udp } });
    await desk.run(mq.id, 'go', { playback: 1 });
    const scs = desk.create('scs-show', { connection: { host: '127.0.0.1', port: udp } });
    await desk.run(scs.id, 'go', { cue: '0' });
    const cap = desk.create('capture-visualiser', { connection: { host: '127.0.0.1', port: udp } });
    await desk.run(cap.id, 'ping', {});
    const lampy = desk.create('showtec-lampy', { connection: { host: '127.0.0.1', port: udp } });
    await desk.run(lampy.id, 'press', { fader: 1 });
    const aten = desk.create('aten-matrix', { connection: tcpConn });
    await desk.connect(aten.id);
    await desk.run(aten.id, 'route', { input: '02', output: '05' });
    const mimo = desk.create('mimolive', { connection: { host: '127.0.0.1', port: webPort, https: false } });
    await desk.run(mimo.id, 'live', { document: '458706932', layer: 'BA868701-8131-49CB-8EDD-8C7E6E7CD60B' });
    const axi = desk.create('aximmetry', { connection: { host: '127.0.0.1', port: webPort, https: false } });
    await desk.run(axi.id, 'camera', {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    const more = Buffer.concat(lines);
    assert.ok(more.includes(Buffer.from('sw i02 o05\r')));
    assert.ok(packets.some((p) => p.toString() === '1G'));
    assert.ok(packets.some((p) => p.toString() === 'scsGo("0")\r'));
    assert.ok(packets.some((p) => { const m = osc.decode(p); return m && m.address === '/ping'; }));
    assert.ok(packets.some((p) => {
      const m = osc.decode(p);
      return m && m.address === '/lampy/pbf/1/flash' && m.args[0] && m.args[0].type === 'i' && m.args[0].value === 1;
    }));
    assert.ok(seen.some((line) => line.startsWith('GET /api/v1/documents/458706932/layers/BA868701-8131-49CB-8EDD-8C7E6E7CD60B/setLive')));
    assert.ok(seen.some((line) => line.startsWith('POST / ') && line.includes('ComposerCtrBoardPressButtonAction') && line.includes('Button="CAM 2"')));
  } finally {
    desk.close();
    sink.close();
    await new Promise((resolve) => tcp.close(resolve));
    await new Promise((resolve) => web.close(resolve));
  }
});

test('ONYX, Dugan and Bosch send the commands printed in their manuals', async () => {
  const lines = [];
  const tcp = net.createServer((sock) => sock.on('data', (buf) => lines.push(buf)));
  const port = await listen(tcp);
  const seen = [];
  const web = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => { seen.push(`${req.method} ${req.url}`); res.writeHead(204); res.end(); });
  });
  const webPort = await listen(web);
  const dgram = require('dgram');
  const osc = require('../lib/drivers/osc');
  const sink = dgram.createSocket('udp4');
  const packets = [];
  sink.on('message', (msg) => packets.push(msg));
  await new Promise((resolve) => sink.bind(0, '127.0.0.1', resolve));
  const udp = sink.address().port;
  const desk = new ModuleDesk();
  try {
    const onyx = desk.create('onyx-osc', { connection: { host: '127.0.0.1', port: udp } });
    await desk.run(onyx.id, 'go', { page: 1, button: 0 });
    const dugan = desk.create('dugan-automixer', { connection: { host: '127.0.0.1', port, reconnect: false } });
    await desk.connect(dugan.id);
    await desk.run(dugan.id, 'auto', { channel: 2 });
    await desk.run(dugan.id, 'mute', { channel: 2 });
    const bosch = desk.create('bosch-hd-camera', { connection: { host: '127.0.0.1', port: webPort, https: false } });
    await desk.run(bosch.id, 'wide', {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    const text = Buffer.concat(lines);
    assert.ok(packets.some((p) => {
      const m = osc.decode(p);
      return m && m.address === '/Mx/playback/page1/0/go' && m.args[0] && m.args[0].type === 'i' && m.args[0].value === 1;
    }));
    assert.ok(text.includes(Buffer.from('CM 2, 1\r')));
    assert.ok(text.includes(Buffer.from('CM 2, 2\r')));
    assert.ok(seen.includes('GET /rcp.xml?command=0x09A5&type=P_OCTET&direction=WRITE&num=1&payload=0x80000601d0022328232801ae0000'));
  } finally {
    desk.close();
    sink.close();
    await new Promise((resolve) => tcp.close(resolve));
    await new Promise((resolve) => web.close(resolve));
  }
});

test('the recorder, router, display and console systems send their published commands', async () => {
  const { wsAcceptKey } = require('../lib/modules/transports');
  const lines = [];
  const tcp = net.createServer((sock) => sock.on('data', (buf) => lines.push(buf)));
  const port = await listen(tcp);
  const seen = [];
  const web = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { seen.push(`${req.method} ${req.url} ${body}`); res.writeHead(204); res.end(); });
  });
  const webPort = await listen(web);
  const dgram = require('dgram');
  const sink = dgram.createSocket('udp4');
  const packets = [];
  sink.on('message', (msg) => packets.push(msg));
  await new Promise((resolve) => sink.bind(0, '127.0.0.1', resolve));
  const udp = sink.address().port;
  const frames = [];
  const ws = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let open = false;
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!open) {
        const at = buf.indexOf('\r\n\r\n');
        if (at < 0) return;
        const key = /Sec-WebSocket-Key:\s*(\S+)/i.exec(buf.subarray(0, at).toString());
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAcceptKey(key[1])}\r\n\r\n`);
        buf = buf.subarray(at + 4);
        open = true;
      }
      if (buf.length >= 2 && (buf[1] & 0x80)) {
        let len = buf[1] & 0x7f;
        let maskAt = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          maskAt = 4;
        }
        const start = maskAt + 4;
        if (buf.length >= start + len) {
          const mask = buf.subarray(maskAt, maskAt + 4);
          const payload = Buffer.alloc(len);
          for (let i = 0; i < len; i++) payload[i] = buf[start + i] ^ mask[i % 4];
          frames.push(payload.toString('utf8'));
          buf = buf.subarray(start + len);
        }
      }
    });
  });
  const wsPort = await listen(ws);
  const desk = new ModuleDesk();
  try {
    const tcpConn = { host: '127.0.0.1', port, reconnect: false };
    for (const [system, action, options] of [
      ['tvone-corio', 'preset', { preset: 1 }],
      ['iiyama-prolite', 'on', {}],
      ['racklink', 'on', {}],
    ]) {
      const row = desk.create(system, { connection: tcpConn });
      await desk.connect(row.id);
      await desk.run(row.id, action, options);
    }
    const monarch = desk.create('matrox-monarch', { connection: { host: '127.0.0.1', port: webPort, https: false, authType: 'basic', username: 'admin', password: 'admin' } });
    await desk.run(monarch.id, 'record', {});
    await desk.run(monarch.id, 'record', {});
    const box = desk.create('netio-powerbox', { connection: { host: '127.0.0.1', port: webPort, https: false } });
    await desk.run(box.id, 'on', { output: 1 });
    const vlc = desk.create('vlc-http', { connection: { host: '127.0.0.1', port: webPort, https: false } });
    await desk.run(vlc.id, 'next', {});
    const cue = desk.create('cuety', { connection: { host: '127.0.0.1', port: udp } });
    await desk.run(cue.id, 'go', { playback: '21' });
    const qlc = desk.create('qlcplus', { connection: { host: '127.0.0.1', port: wsPort, path: '/qlcplusWS' } });
    await desk.run(qlc.id, 'start', { fn: 1 });
    const cisco = desk.create('cisco-roomos', { connection: { host: '127.0.0.1', port: wsPort, path: '/ws' } });
    await desk.run(cisco.id, 'present', {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    const text = Buffer.concat(lines);
    assert.ok(text.includes(Buffer.from('Preset.Take = 1\r')));
    assert.ok(text.includes(Buffer.from('A60100000004011802B8', 'hex')));
    assert.ok(text.includes(Buffer.from('fe090020010101303030306aff', 'hex')));
    assert.ok(seen.some((line) => line.startsWith('GET /Monarch/syncconnect/sdk.aspx?command=StartRecording')));
    assert.ok(seen.some((line) => line.startsWith('POST /netio.json') && line.includes('"Action":1')));
    assert.ok(seen.some((line) => line.startsWith('GET /requests/status.xml?command=pl_next')));
    assert.ok(packets.some((p) => p.toString() === 'pb21/go+'));
    assert.ok(frames.includes('QLC+API|setFunctionStatus|1|1'));
    assert.ok(frames.some((frame) => frame.includes('xCommand/Presentation/Start') && frame.includes('"ConnectorId":[2,3]')));
  } finally {
    desk.close();
    sink.close();
    await new Promise((resolve) => tcp.close(resolve));
    await new Promise((resolve) => web.close(resolve));
    await new Promise((resolve) => ws.close(resolve));
  }
});
