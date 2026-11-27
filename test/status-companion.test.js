'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { CompanionClient } = require('../lib/status/companion');
const ws = require('../lib/status/ws');

const until = async (fn, ms = 3000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
};

test('the Companion client only reads, against a mock server', async () => {
  const seen = [];
  const lines = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.method !== 'GET') {
      res.writeHead(405);
      return res.end('no');
    }
    if (req.url === '/api/connections') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify([{ id: 'abc', label: 'My ATEM', moduleId: 'bmd-atem', enabled: true, status: { category: 'good', level: 'ok', message: 'Connected' } }]));
    }
    if (req.url === '/api/custom-variable/cue/value') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('intro');
    }
    if (req.url === '/api/custom-variable/missing/value') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(404);
    res.end('no');
  });
  server.on('upgrade', (req, socket, head) => {
    ws.upgrade(req, socket, head, (sock) => {
      const link = ws.attach(sock, { onText: (text) => lines.push(text) });
      link.send('BEGIN CompanionVersion=4.3.2 ApiVersion=1.10.0\n');
      link.send('CAPS SUBSCRIPTIONS=1\n');
      setTimeout(() => link.send('PING hello\n'), 30);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const client = new CompanionClient({
    target: () => ({ host: '127.0.0.1', port }),
    wsPort: port,
    variables: ['cue', 'missing'],
    pollMs: 5000,
    pingMs: 200,
    timeoutMs: 1000,
  });
  try {
    client.start();
    await until(() => client.snapshot().httpOnline && client.snapshot().wsOnline);
    const snap = client.snapshot();
    assert.equal(snap.version, '4.3.2');
    assert.equal(snap.apiVersion, '1.10.0');
    assert.equal(snap.variables.cue.value, 'intro');
    assert.equal(snap.variables.cue.found, true);
    assert.equal(snap.variables.missing.found, false);
    assert.equal(snap.connections[0].label, 'My ATEM');
    assert.equal(snap.connections[0].online, true);
    await until(() => lines.some((line) => line.startsWith('PONG hello')));
    assert.ok(seen.length > 0);
    assert.ok(seen.every((line) => line.startsWith('GET ')), seen.join('\n'));
  } finally {
    client.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});
