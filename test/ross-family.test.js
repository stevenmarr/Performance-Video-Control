'use strict';
// RossTalk, XPression, the Ross video server, Caprica and NK-SCP/A.
// Connect opens the socket and sends nothing. Reads use the lines the Ross manuals print.

process.env.RS6_QUIET = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { ownOnly } = require('./own-only');
const { until } = require('./helpers');
const { ModuleDesk } = require('../lib/modules/runtime');
const { get } = require('../lib/modules/catalog');
const { optionDefaults } = require('../lib/modules/framework');

function listen(server, port = 0) {
  ownOnly(server);
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
}

function field(system, id) {
  return system.connection.fields.find((f) => f.id === id);
}

test('Ross sockets reconnect, split on CR LF, and do not invent a take-item state command', () => {
  for (const id of ['ross-rosstalk', 'ross-xpression', 'ross-videoserver', 'ross-caprica', 'ross-nk']) {
    const system = get(id);
    assert.equal(field(system, 'reconnect').default, true, id);
    assert.equal(field(system, 'delimiter').default, '\\r\\n', id);
    if (id === 'ross-rosstalk') {
      assert.equal(system.poll && system.poll.type, 'line-keepalive');
      assert.equal(system.poll.line, 'NOOP\r\n');
      assert.equal(field(system, 'keepalive').default, false);
      assert.equal(field(system, 'keepaliveMs').default, 30000);
    } else {
      assert.equal(system.poll, null, id);
      assert.equal(field(system, 'keepalive'), undefined, id);
    }
  }
  const xp = get('ross-xpression');
  assert.ok(!xp.actions.some((a) => /state|status|noop/i.test(a.id)));
  assert.equal(get('ross-videoserver').actions.map((a) => a.id).join(','), 'cue,play,stop');
  assert.match(get('ross-xpression').docs.note, /does not print a take-item state query/);
  assert.match(get('ross-videoserver').docs.note, /does not print a status query or NOOP/);
});

test('RossTalk connect sends nothing, NOOP is the keepalive, and a crosspoint read keeps the reply', async () => {
  const lines = [];
  const server = net.createServer((sock) => sock.on('data', (buf) => {
    const text = buf.toString();
    lines.push(text);
    if (text.startsWith('XPT') && text.includes('?')) sock.write('IN:6\r\n');
    else if (text.startsWith('HELP')) sock.write('CC\r\n');
  }));
  const port = await listen(server);
  const desk = new ModuleDesk();
  try {
    const row = desk.create('ross-rosstalk', { connection: { host: '127.0.0.1', port } });
    await desk.connect(row.id);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(lines.length, 0, 'connect must not send a command');
    assert.equal(desk.must(row.id).vars.connected, 'true');
    assert.equal(desk.must(row.id).status, 'online');
    await desk.run(row.id, 'keepalive');
    await until(() => lines.some((l) => l === 'NOOP\r\n'), 1000, 'NOOP');
    await desk.run(row.id, 'xptRead', { dest: 'ME:2:PGM' });
    assert.ok(lines.some((l) => l === 'XPT ME:2:PGM:?\r\n'));
    const pub = desk.publicInstance(desk.must(row.id));
    assert.equal(pub.vars['tcp.reply'], 'IN:6');
    assert.equal(pub.flags.reply, true);
    await desk.run(row.id, 'cut', { me: '2' });
    await until(() => lines.some((l) => l.includes('MECUT ME:2\r\n')), 1000, 'cut');
    await desk.run(row.id, 'help');
    assert.ok(lines.some((l) => l === 'HELP\r\n'));
    assert.equal(desk.must(row.id).vars['tcp.reply'], 'CC');
  } finally {
    desk.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('RossTalk drops the session when the socket closes and sends nothing on the way back', async () => {
  const lines = [];
  const socks = [];
  let server;
  const open = () => {
    server = net.createServer((sock) => {
      socks.push(sock);
      sock.on('data', (buf) => lines.push(buf.toString()));
    });
    return listen(server, port || 0);
  };
  let port = 0;
  port = await open();
  const desk = new ModuleDesk();
  try {
    const row = desk.create('ross-rosstalk', { connection: { host: '127.0.0.1', port } });
    await desk.connect(row.id);
    for (const sock of socks) sock.destroy();
    await new Promise((resolve) => server.close(resolve));
    await until(() => desk.must(row.id).vars.connected === 'false', 2000, 'offline');
    const again = await open();
    assert.equal(again, port);
    await until(() => desk.must(row.id).vars.connected === 'true', 3000, 'reconnected');
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(lines.length, 0);
  } finally {
    desk.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  }
});

test('XPression TAKE stays the framebuffer line and connect sends nothing', async () => {
  const lines = [];
  const server = net.createServer((sock) => sock.on('data', (buf) => lines.push(buf.toString())));
  const port = await listen(server);
  const desk = new ModuleDesk();
  try {
    const row = desk.create('ross-xpression', { connection: { host: '127.0.0.1', port } });
    await desk.connect(row.id);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(lines.length, 0);
    await desk.run(row.id, 'take', { take: '5', buffer: 0, layer: 7 });
    await desk.run(row.id, 'cue', { take: '3', buffer: 2, layer: -5 });
    await until(() => lines.some((l) => l.includes('TAKE 5:0:7\r\n')) && lines.some((l) => l.includes('CUE 3:2:-5\r\n')), 1000, 'take and cue');
  } finally {
    desk.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Caprica mute and key reads use the RossTalk-IN lines, and On is not Off', async () => {
  const lines = [];
  const server = net.createServer((sock) => sock.on('data', (buf) => {
    const text = buf.toString();
    lines.push(text);
    if (text.startsWith('KEYSTATE')) sock.write(text.includes('4:4') ? 'On\r\n' : 'Off\r\n');
    else if (text.includes('AM MUTE : ALL : ?')) sock.write('ALL MUTE On\r\n');
    else if (text.startsWith('VER')) sock.write('Caprica 6.1\r\n');
  }));
  const port = await listen(server);
  const desk = new ModuleDesk();
  try {
    const row = desk.create('ross-caprica', { connection: { host: '127.0.0.1', port } });
    await desk.connect(row.id);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(lines.length, 0);
    await desk.run(row.id, 'cut', { me: '0' });
    await until(() => lines.some((l) => l === 'SW MECUT : ME : 0\r\n'), 1000, 'cut');
    await desk.run(row.id, 'muteRead');
    assert.ok(lines.some((l) => l === 'AM MUTE : ALL : ?\r\n'));
    assert.equal(desk.must(row.id).vars['tcp.reply'], 'ALL MUTE On');
    await desk.run(row.id, 'keyState', { me: '4', key: '4' });
    let pub = desk.publicInstance(desk.must(row.id));
    assert.equal(pub.vars['tcp.reply'], 'On');
    assert.equal(pub.flags.keyOn, true);
    assert.equal(pub.flags.keyOff, false);
    await desk.run(row.id, 'keyState', { me: '1', key: '1' });
    pub = desk.publicInstance(desk.must(row.id));
    assert.equal(pub.vars['tcp.reply'], 'Off');
    assert.equal(pub.flags.keyOn, false);
    assert.equal(pub.flags.keyOff, true);
    await desk.run(row.id, 'version');
    assert.ok(lines.some((l) => l === 'VER : Caprica\r\n'));
    assert.equal(desk.must(row.id).vars['tcp.reply'], 'Caprica 6.1');
  } finally {
    desk.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Ross video server still cues, plays and stops, and connect sends nothing', async () => {
  const lines = [];
  const server = net.createServer((sock) => sock.on('data', (buf) => lines.push(buf.toString())));
  const port = await listen(server);
  const desk = new ModuleDesk();
  try {
    const row = desk.create('ross-videoserver', { connection: { host: '127.0.0.1', port } });
    await desk.connect(row.id);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(lines.length, 0);
    await desk.run(row.id, 'cue', { channel: 'D', clip: 'crime-report' });
    await desk.run(row.id, 'play', { channel: 'B' });
    await desk.run(row.id, 'stop', { channel: 'F' });
    await until(() => lines.join('').includes('STOP F\r\n'), 1000, 'stop');
    const text = lines.join('');
    assert.ok(text.includes('CUE D:crime-report\r\n'));
    assert.ok(text.includes('PLAY B\r\n'));
    assert.ok(text.includes('STOP F\r\n'));
    assert.equal(text.includes('NOOP'), false);
  } finally {
    desk.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('NK-SCP/A sends the 11-byte switch, the 5-byte read, and the 37-byte level line', async () => {
  const lines = [];
  const server = net.createServer((sock) => sock.on('data', (buf) => {
    const text = buf.toString();
    lines.push(text);
    if (text.startsWith('R')) sock.write('\r\n000,001,002,003,004,005,006,007\r\n\r\nOK \r\n');
    else sock.write('\r\nOK \r\n');
  }));
  const port = await listen(server);
  const desk = new ModuleDesk();
  try {
    const row = desk.create('ross-nk', { connection: { host: '127.0.0.1', port } });
    await desk.connect(row.id);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(lines.length, 0);
    const nk = get('ross-nk');
    assert.deepEqual(optionDefaults(nk.actionMap.get('switch')), { dest: '000', source: '000', breakaway: '1' });
    await desk.run(row.id, 'switch', optionDefaults(nk.actionMap.get('switch')));
    await until(() => lines.length > 0, 1000, 'switch');
    assert.equal(lines[0], 'X000,000,1\r');
    assert.equal(Buffer.byteLength(lines[0]), 11);
    let pub = desk.publicInstance(desk.must(row.id));
    assert.equal(pub.vars['tcp.reply'], 'OK ');
    assert.equal(pub.flags.accepted, true);
    await desk.run(row.id, 'read', optionDefaults(nk.actionMap.get('read')));
    assert.ok(lines.some((l) => l === 'R000\r'));
    assert.equal(Buffer.byteLength('R000\r'), 5);
    pub = desk.publicInstance(desk.must(row.id));
    assert.equal(pub.vars['tcp.reply'], '000,001,002,003,004,005,006,007');
    assert.equal(pub.flags.status, true);
    assert.equal(pub.flags.accepted, false);
    await desk.run(row.id, 'levels', optionDefaults(nk.actionMap.get('levels')));
    await until(() => lines.some((l) => l.startsWith('Z')), 1000, 'levels');
    const level = lines.find((l) => l.startsWith('Z'));
    assert.equal(level, 'Z000,---,---,---,---,---,---,---,---\r');
    assert.equal(Buffer.byteLength(level), 37);
  } finally {
    desk.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('RossTalk NOOP keep-alive is off until the connection turns it on, and the first line waits', async () => {
  const lines = [];
  const server = net.createServer((sock) => sock.on('data', (buf) => lines.push(buf.toString())));
  const port = await listen(server);
  const desk = new ModuleDesk({ pollFloorMs: 40 });
  try {
    const quiet = desk.create('ross-rosstalk', { connection: { host: '127.0.0.1', port, keepaliveMs: 80 } });
    await desk.connect(quiet.id);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(lines.length, 0, 'keep-alive stays off');
    const row = desk.create('ross-rosstalk', { connection: { host: '127.0.0.1', port, keepalive: true, keepaliveMs: 80 } });
    await desk.connect(row.id);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(lines.length, 0, 'connect does not send NOOP');
    await until(() => lines.filter((l) => l === 'NOOP\r\n').length >= 2, 1000, 'two NOOPs');
    assert.ok(lines.every((l) => l === 'NOOP\r\n'));
    const n = lines.length;
    await desk.disconnect(row.id);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(lines.length, n, 'disconnect stops the timer');
    const xp = desk.create('ross-xpression', { connection: { host: '127.0.0.1', port, keepalive: true, keepaliveMs: 80 } });
    await desk.connect(xp.id);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(lines.length, n, 'XPression does not get the RossTalk timer');
  } finally {
    desk.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
