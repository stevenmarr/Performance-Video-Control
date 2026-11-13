'use strict';
process.env.RS6_QUIET = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const dgram = require('dgram');
const { resolveKey, actionList, THEMES } = require('../lib/decks/key-class');
const { ButtonLibrary } = require('../lib/decks/button-library');
const { actionToRequest } = require('../lib/decks/page-push');
const { ModuleDesk } = require('../lib/modules/runtime');
const { get } = require('../lib/modules/catalog');
const { viscaPacket, obsPassword, wsAcceptKey } = require('../lib/modules/transports');
const osc = require('../lib/drivers/osc');
const coverage = require('../lib/modules/coverage');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('dark button colors stay the mission-critical set, and light mode is a second high-contrast set', () => {
  const dark = resolveKey({ role: 'program', text: 'CAM 1' }, {}, {});
  assert.equal(dark.style.bgcolor, '#5c2428');
  assert.equal(dark.style.bar, '#C42020');
  assert.equal(resolveKey({ role: 'preview', text: 'CAM' }, {}, {}).style.bar, '#3DDC84');
  assert.equal(resolveKey({ role: 'hot', text: 'CUT' }, {}, {}).style.bgcolor, '#C42020');
  assert.equal(resolveKey({ role: 'nav', text: 'HOME' }, {}, {}).style.os, true);
  const light = resolveKey({ role: 'program', text: 'CAM 1', theme: 'light' }, {}, {});
  assert.equal(light.style.bgcolor, THEMES.light.program.bgcolor);
  assert.notEqual(light.style.bgcolor, dark.style.bgcolor);
  assert.equal(light.style.color, '#3B0A0E');
  assert.equal(light.style.bar, '#C42020');
  const os = resolveKey({ role: 'nav', text: 'HOME' }, {}, {}, 'light');
  assert.equal(os.style.os, true);
  assert.equal(os.style.bgcolor, '#E8EEF6');
  assert.equal(os.style.border, '#243044');
  const guard = resolveKey({ role: 'hot', text: 'FTB', confirm: true }, {}, {});
  assert.equal(guard.style.guard, true);
  assert.equal(guard.style.border, '#E0B030');
  const armed = resolveKey({
    role: 'toggle', text: 'REC',
    feedbacks: [{ variable: 'recording', op: 'eq', value: 'true', style: { bgcolor: '#C42020', color: '#FFFFFF' } }],
  }, {}, { recording: 'true' });
  assert.equal(armed.style.bgcolor, '#C42020');
  assert.deepEqual(actionList({ actions: { press: [{ action: 'vmix.cut' }, { action: 'vmix.fade', delayMs: 20 }] } }, 'press').map((a) => a.action), ['vmix.cut', 'vmix.fade']);
});

test('a library button keeps confirm, theme, delay and a variable feedback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-btn-'));
  const lib = new ButtonLibrary({ dataDir: dir });
  const row = lib.createButton({
    name: 'Fade', role: 'hot', text: 'FADE', confirm: true, theme: 'light',
    actions: { press: [{ action: 'generic-http.request', delayMs: 25, options: { method: 'POST', path: '/mix' } }] },
    feedbacks: [{ variable: 'http.status', op: 'eq', value: '200', style: { border: '#3DDC84' } }],
  });
  assert.equal(row.confirm, true);
  assert.equal(row.theme, 'light');
  assert.equal(row.actions.press[0].delayMs, 25);
  assert.equal(row.actions.press[0].options.path, '/mix');
  assert.equal(row.feedbacks[0].variable, 'http.status');
  const again = new ButtonLibrary({ dataDir: dir });
  assert.equal(again.button(row.id).theme, 'light');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('native commands keep their routes, and a new ATEM command is bound too', () => {
  assert.equal(actionToRequest({ action: 'atem.cut' }).path, '/api/sys/atem/cmd/cut');
  assert.equal(actionToRequest({ action: 'atem.ftb' }).path, '/api/sys/atem/cmd/ftb');
  assert.equal(actionToRequest({ action: 'hyperdeck.previewOff' }).path, '/api/sys/hyperdeck/cmd/previewOff');
  const op = actionToRequest({ action: 'ptz.detail' });
  assert.equal(op.path, '/api/sys/ptz/cmd/op');
  assert.equal(op.body.op, 'detail');
  assert.equal(actionToRequest({ action: 'vmix.cut' }).path, '/api/modules/cmd/vmix/cut');
  assert.equal(get('ndi').status, 'not yet');
  assert.ok(get('atem').actions.length > 20);
  assert.ok(get('ptz').actions.length > 40);
});

test('generic HTTP sends the verb, retries a 500, parses JSON, and stays on the connected host', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    if (req.url.startsWith('/flaky') && hits === 1) { res.writeHead(500); res.end('no'); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const auth = req.headers.authorization || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, url: req.url, body, auth, value: { level: 7 } }));
    });
  });
  const port = await listen(server);
  const desk = new ModuleDesk();
  try {
    const row = desk.create('generic-http', { connection: { host: '127.0.0.1', port, authType: 'bearer', password: 'tok', retries: 1 } });
    const ok = await desk.run(row.id, 'request', { method: 'POST', path: '/mix', body: '{"a":1}', contentType: 'application/json', parse: 'json', jsonPath: 'value.level', variable: 'level' });
    assert.equal(ok.vars.level, '7');
    assert.equal(ok.vars['http.status'], '200');
    const parsed = JSON.parse(ok.raw);
    assert.equal(parsed.method, 'POST');
    assert.equal(parsed.auth, 'Bearer tok');
    hits = 0;
    await desk.run(row.id, 'request', { method: 'GET', path: '/flaky', retries: 1 });
    assert.equal(hits, 2);
    await assert.rejects(() => desk.run(row.id, 'request', { method: 'FOO', path: '/' }), /GET, POST/);
    await assert.rejects(() => desk.run(row.id, 'request', { path: 'http://other/x' }), /connected host/);
  } finally {
    desk.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('vMix cut is the documented Function URL and the XML state fills variables', async () => {
  const xml = '<vmix><version>27.0</version><recording>True</recording><streaming>False</streaming><fadeToBlack>False</fadeToBlack><preview>2</preview><active>4</active></vmix>';
  const seen = [];
  const server = http.createServer((req, res) => { seen.push(req.url); res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end(xml); });
  const port = await listen(server);
  const desk = new ModuleDesk();
  try {
    const row = desk.create('vmix', { connection: { host: '127.0.0.1', port } });
    await desk.connect(row.id);
    assert.equal(desk.must(row.id).vars.program, '4');
    assert.equal(desk.must(row.id).vars.recording, 'true');
    assert.equal(desk.publicInstance(desk.must(row.id)).flags.recording, true);
    await desk.run(row.id, 'cut');
    assert.ok(seen.some((u) => u.includes('Function=Cut')));
    await desk.run(row.id, 'fade', { duration: 500 });
    assert.ok(seen.some((u) => u.includes('Function=Fade') && u.includes('Duration=500')));
  } finally {
    desk.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('UDP hears a datagram, and OSC go is a QLab message', async () => {
  const desk = new ModuleDesk();
  const probe = dgram.createSocket('udp4');
  const got = new Promise((resolve) => probe.on('message', (msg) => resolve(msg)));
  await new Promise((resolve) => probe.bind(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  try {
    const row = desk.create('generic-udp', { connection: { host: '127.0.0.1', port, listenPort: 0, encoding: 'ascii' } });
    await desk.connect(row.id);
    await desk.run(row.id, 'send', { payload: 'PING', encoding: 'ascii' });
    const msg = await got;
    assert.equal(msg.toString(), 'PING');
    const qlab = desk.create('qlab', { connection: { host: '127.0.0.1', port } });
    const heard = new Promise((resolve) => probe.once('message', resolve));
    await desk.run(qlab.id, 'go');
    const packet = await heard;
    const decoded = osc.decode(packet);
    assert.equal(decoded.address, '/go');
  } finally {
    desk.close();
    await new Promise((resolve) => probe.close(resolve));
  }
});

test('TCP echoes a delimited line, and server mode records an incoming line', async () => {
  const server = net.createServer((sock) => {
    sock.on('data', (buf) => sock.write(buf.toString().trim() + '-ok\n'));
  });
  const port = await listen(server);
  const desk = new ModuleDesk();
  try {
    const row = desk.create('generic-tcp', { connection: { host: '127.0.0.1', port, delimiter: '\\n', reconnect: false } });
    await desk.connect(row.id);
    const res = await desk.run(row.id, 'send', { payload: 'hello\\n', encoding: 'escape', expect: 'ok' });
    assert.match(res.vars['tcp.reply'], /hello-ok/);
    const listenPort = port + 1;
    const inbound = desk.create('generic-tcp', { connection: { host: '', port: listenPort, server: true, listenHost: '127.0.0.1', delimiter: '\\n' } });
    await desk.connect(inbound.id);
    const client = net.connect({ host: '127.0.0.1', port: listenPort });
    await new Promise((resolve) => client.once('connect', resolve));
    client.write('from-show\n');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.match(desk.must(inbound.id).vars['tcp.last'], /from-show/);
    client.end();
  } finally {
    desk.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('RossTalk cut is the documented line, and a HyperDeck-style confirm arms first', async () => {
  const lines = [];
  const server = net.createServer((sock) => sock.on('data', (buf) => { lines.push(buf.toString()); sock.write('OK\r\n'); }));
  const port = await listen(server);
  const desk = new ModuleDesk();
  try {
    const row = desk.create('ross-rosstalk', { connection: { host: '127.0.0.1', port } });
    await desk.connect(row.id);
    await desk.run(row.id, 'cut', { me: '2', expect: 'OK' });
    assert.ok(lines.some((l) => l.includes('MECUT ME:2')));
    const armed = await desk.run(row.id, 'ftb');
    assert.equal(armed.pending, true);
    assert.equal(lines.filter((l) => l.includes('FTB')).length, 0);
    await desk.run(row.id, 'ftb', { expect: 'OK' });
    assert.ok(lines.some((l) => l.includes('FTB')));
  } finally {
    desk.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('VISCA-over-IP uses the 8-byte header, and SQ mute is the Issue 5 NRPN', async () => {
  const packet = viscaPacket([0x81, 0x01, 0x04, 0x00, 0x02, 0xFF], 7);
  assert.equal(packet.readUInt16BE(0), 0x0100);
  assert.equal(packet.readUInt16BE(2), 6);
  assert.equal(packet.readUInt32BE(4), 7);
  assert.equal(packet[packet.length - 1], 0xFF);
  const got = [];
  const server = net.createServer((sock) => sock.on('data', (buf) => got.push(Buffer.from(buf))));
  const port = await listen(server);
  const desk = new ModuleDesk();
  try {
    const row = desk.create('allenheath-sq', { connection: { host: '127.0.0.1', port, midiChannel: 1 } });
    await desk.connect(row.id);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await desk.run(row.id, 'muteOn', { channel: 1 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const bytes = Buffer.concat(got);
    assert.deepEqual([...bytes.subarray(0, 12)], [0xB0, 0x63, 0x00, 0xB0, 0x62, 0x00, 0xB0, 0x06, 0x00, 0xB0, 0x26, 0x01]);
  } finally {
    desk.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('OBS websocket 5 identifies with the documented password hash', async () => {
  const password = 'pw';
  const salt = 'salt';
  const challenge = 'chal';
  const expectAuth = obsPassword(password, salt, challenge);
  let authed = null;
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let open = false;
    const rx = { buf: null };
    const { wsTake } = require('../lib/modules/transports');
    const send = (obj) => {
      const payload = Buffer.from(JSON.stringify(obj));
      let header;
      if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
      else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
      sock.write(Buffer.concat([header, payload]));
    };
    sock.on('data', (chunk) => {
      if (!open) {
        buf = Buffer.concat([buf, chunk]);
        const at = buf.indexOf('\r\n\r\n');
        if (at < 0) return;
        const text = buf.subarray(0, at).toString();
        const key = /Sec-WebSocket-Key:\s*(\S+)/i.exec(text)[1];
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAcceptKey(key)}\r\n\r\n`);
        open = true;
        send({ op: 0, d: { rpcVersion: 1, authentication: { challenge, salt } } });
        const rest = buf.subarray(at + 4);
        buf = Buffer.alloc(0);
        if (rest.length) chunk = rest; else return;
      }
      for (const frame of wsTake(rx, chunk)) {
        const msg = JSON.parse(frame.payload.toString());
        if (msg.op === 1) { authed = msg.d.authentication; send({ op: 2, d: { negotiatedRpcVersion: 1 } }); }
        if (msg.op === 6) send({ op: 7, d: { requestType: msg.d.requestType, requestId: msg.d.requestId, requestStatus: { result: true, code: 100 }, responseData: { currentProgramSceneName: 'Main' } } });
      }
    });
  });
  const port = await listen(server);
  const desk = new ModuleDesk();
  try {
    const row = desk.create('obs', { connection: { host: '127.0.0.1', port, password } });
    await desk.connect(row.id);
    assert.equal(authed, expectAuth);
    const scene = await desk.run(row.id, 'scene', { scene: 'Main' });
    assert.equal(scene.raw.currentProgramSceneName, 'Main');
  } finally {
    desk.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the coverage manifest lists every Companion module and matches the catalog', () => {
  const list = coverage.rows();
  assert.equal(list.length, coverage.ids.length);
  assert.equal(list.find((r) => r.id === 'studiocoast-vmix').status, 'implemented');
  assert.equal(list.find((r) => r.id === 'bmd-atem').status, 'implemented');
  assert.equal(list.find((r) => r.id === 'generic-tcp-udp').status, 'implemented');
  assert.equal(list.find((r) => r.id === 'malighting-grandma3').status, 'partial');
  assert.equal(list.find((r) => r.id === 'newtek-ndistudiomonitor').status, 'not yet');
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'systems-coverage.md'), 'utf8');
  assert.equal(doc, coverage.markdown());
  const sum = coverage.summary();
  assert.ok(sum.implemented > 20);
  assert.equal(sum.implemented + sum.partial + sum['not yet'], sum.total);
});
