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
