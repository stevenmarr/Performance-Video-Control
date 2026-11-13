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
