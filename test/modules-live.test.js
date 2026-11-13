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
