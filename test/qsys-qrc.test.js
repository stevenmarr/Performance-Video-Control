'use strict';
process.env.RS6_QUIET = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { ownOnly } = require('./own-only');
const { ModuleDesk, QSYS_KEEPALIVE_MS } = require('../lib/modules/runtime');
const { get } = require('../lib/modules/catalog');

async function settle(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
}

function listen(server) {
  ownOnly(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function qrcFrames(chunks) {
  return Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean).map((text) => JSON.parse(text));
}

test('Q-SYS catalog keeps Logon on the connection and sends nothing by itself', () => {
  const sys = get('qsys-qrc');
  assert.equal(sys.poll, null);
  assert.equal(sys.connection.fields.find((f) => f.id === 'delimiter').default, '\\0');
  const password = sys.connection.fields.find((f) => f.id === 'password');
  assert.equal(password.secret, true);
  assert.equal(password.default, '');
  assert.equal(sys.connection.fields.find((f) => f.id === 'username').default, '');
  assert.equal(sys.actionMap.get('logon').execute.type, 'qsys');
  assert.ok(QSYS_KEEPALIVE_MS < 60000 && QSYS_KEEPALIVE_MS >= 1000);
  assert.equal(sys.actionMap.get('set').execute.payload, '{"jsonrpc":"2.0","id":1,"method":"Control.Set","params":{"Name":"$(options:name)","Value":$(options:value)}}\0');
  assert.equal(sys.actionMap.get('noop').execute.payload.includes('NoOp'), true);
  assert.equal(sys.actionMap.get('autoPoll').execute.payload.includes('ChangeGroup.AutoPoll'), true);
  assert.equal(sys.variables.map((v) => v.id).includes('tcp.last'), true);
  assert.equal(sys.feedbacks.some((f) => f.variable === 'tcp.last' && f.value.includes('Changes')), true);
});

test('Q-SYS connect sends nothing, then the QRC commands', async () => {
  const chunks = [];
  const server = net.createServer((sock) => sock.on('data', (buf) => chunks.push(buf)));
  const port = await listen(server);
  const desk = new ModuleDesk();
  try {
    const row = desk.create('qsys-qrc', { connection: { host: '127.0.0.1', port, reconnect: false } });
    await desk.connect(row.id);
    await settle(30);
    assert.equal(Buffer.concat(chunks).length, 0);
    await desk.run(row.id, 'noop');
    await desk.run(row.id, 'logon');
    await desk.run(row.id, 'set', { name: 'MainGain', value: '-12' });
    await desk.run(row.id, 'get', { name: 'MainGain' });
    await desk.run(row.id, 'addControl');
    await desk.run(row.id, 'autoPoll');
    await desk.run(row.id, 'componentGet');
    await desk.run(row.id, 'componentSet');
    const loadArmed = await desk.run(row.id, 'snapshotLoad');
    assert.equal(loadArmed.pending, true);
    const saveArmed = await desk.run(row.id, 'snapshotSave');
    assert.equal(saveArmed.pending, true);
    await settle(20);
    const beforeConfirm = qrcFrames(chunks).map((frame) => frame.method);
    assert.deepEqual(beforeConfirm, [
      'NoOp', 'Logon', 'Control.Set', 'Control.Get', 'ChangeGroup.AddControl', 'ChangeGroup.AutoPoll', 'Component.Get', 'Component.Set',
    ]);
    await desk.run(row.id, 'snapshotLoad');
    await desk.run(row.id, 'snapshotSave');
    await settle(30);
    const frames = qrcFrames(chunks);
    assert.deepEqual(frames.map((frame) => frame.method), beforeConfirm.concat(['Snapshot.Load', 'Snapshot.Save']));
    assert.deepEqual(frames[0].params, {});
    assert.deepEqual(frames[1].params, { User: '', Password: '' });
    assert.deepEqual(frames[2].params, { Name: 'MainGain', Value: -12 });
    assert.deepEqual(frames[3].params, ['MainGain']);
    assert.deepEqual(frames[4].params, { Id: 'cc', Controls: ['MainGain'] });
    assert.deepEqual(frames[5].params, { Id: 'cc', Rate: 1 });
    assert.deepEqual(frames[6].params, { Name: 'Gain', Controls: [{ Name: 'gain' }] });
    assert.deepEqual(frames[7].params, { Name: 'Gain', Controls: [{ Name: 'gain', Value: -12 }] });
    assert.deepEqual(frames[8].params, { Name: 'Bank', Bank: 1, Ramp: 0 });
    assert.deepEqual(frames[9].params, { Name: 'Bank', Bank: 1 });
    const pub = desk.view().instances.find((item) => item.id === row.id);
    assert.equal(pub.connection.password, '');
  } finally {
    desk.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Q-SYS change-group messages show as live state when the delimiter is a null byte', async () => {
  const chunks = [];
  let client = null;
  const server = net.createServer((sock) => {
    client = sock;
    sock.on('data', (buf) => chunks.push(buf));
    sock.write(Buffer.from('{"jsonrpc":"2.0","method":"EngineStatus","params":{"State":"Active"}}\0'));
  });
  const port = await listen(server);
  const desk = new ModuleDesk();
  try {
    const row = desk.create('qsys-qrc', { connection: { host: '127.0.0.1', port, delimiter: '\0', reconnect: false } });
    await desk.connect(row.id);
    await settle(30);
    assert.equal(Buffer.concat(chunks).length, 0);
    let pub = desk.view().instances.find((item) => item.id === row.id);
    assert.equal(pub.flags.live, false);
    assert.equal(pub.flags.value, false);
    assert.match(pub.vars['tcp.last'], /EngineStatus/);
    await desk.run(row.id, 'addControl');
    await desk.run(row.id, 'autoPoll');
    client.write(Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"Id":"cc","Changes":[{"Name":"MainGain","Value":-12,"String":"-12dB"}]}}\0'));
    await settle(30);
    pub = desk.view().instances.find((item) => item.id === row.id);
    assert.equal(pub.flags.live, true);
    assert.equal(pub.flags.value, true);
    assert.match(pub.vars['tcp.last'], /"Name":"MainGain"/);
    assert.match(pub.vars['tcp.last'], /"Value":-12/);
    assert.equal(pub.vars.MainGain, '-12');
    const sent = qrcFrames(chunks);
    assert.deepEqual(sent.map((frame) => frame.method), ['ChangeGroup.AddControl', 'ChangeGroup.AutoPoll']);
  } finally {
    desk.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Q-SYS default delimiter is a null, and each change-group control is its own variable', async () => {
  let client = null;
  const server = net.createServer((sock) => { client = sock; });
  const port = await listen(server);
  const desk = new ModuleDesk();
  try {
    const row = desk.create('qsys-qrc', { connection: { host: '127.0.0.1', port, reconnect: false } });
    await desk.connect(row.id);
    client.write(Buffer.from(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        Id: 'cc',
        Changes: [
          { Name: 'MainGain', Value: -12, String: '-12dB' },
          { Name: 'MainMute', Value: false, String: 'Unmuted' },
          { Name: 'Label', Value: 'Hall' },
          { Component: 'Gain', Name: 'gain', Value: -6.5, String: '-6.5dB' },
          { Name: 'connected', Value: 1 },
        ],
      },
    })}\0`));
    await settle(30);
    const pub = desk.view().instances.find((item) => item.id === row.id);
    assert.equal(pub.vars.MainGain, '-12');
    assert.equal(pub.vars.MainMute, 'false');
    assert.equal(pub.vars.Label, 'Hall');
    assert.equal(pub.vars['Gain.gain'], '-6.5');
    assert.equal(pub.vars.connected, 'true');
    assert.equal(pub.vars['control.connected'], '1');
  } finally {
    desk.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Q-SYS logs on at connect when both fields are saved, and NoOp follows on the timer', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const chunks = [];
  const server = net.createServer((sock) => sock.on('data', (buf) => chunks.push(buf)));
  const port = await listen(server);
  const desk = new ModuleDesk();
  const user = 'op"er';
  const pass = 'a"b\\\n';
  try {
    const plain = desk.create('qsys-qrc', { connection: { host: '127.0.0.1', port, username: user, reconnect: false } });
    await desk.connect(plain.id);
    await settle(40);
    assert.equal(Buffer.concat(chunks).length, 0, 'a user without a password does not log on');
    await desk.disconnect(plain.id);

    const row = desk.create('qsys-qrc', { connection: { host: '127.0.0.1', port, username: user, password: pass, reconnect: false } });
    await desk.connect(row.id);
    await settle(40);
    t.mock.timers.tick(QSYS_KEEPALIVE_MS - 1);
    await settle(20);
    let frames = qrcFrames(chunks);
    assert.deepEqual(frames.map((frame) => frame.method), ['Logon']);
    assert.deepEqual(frames[0].params, { User: user, Password: pass });
    const pub = desk.view().instances.find((item) => item.id === row.id);
    assert.equal(pub.connection.password, '***');
    assert.equal(JSON.stringify(frames[0]).includes('***'), false);

    t.mock.timers.tick(1);
    await settle(30);
    frames = qrcFrames(chunks);
    assert.deepEqual(frames.map((frame) => frame.method), ['Logon', 'NoOp']);
    assert.deepEqual(frames[1].params, {});

    await desk.run(row.id, 'logon');
    await settle(20);
    frames = qrcFrames(chunks);
    assert.equal(frames.at(-1).method, 'Logon');
    assert.deepEqual(frames.at(-1).params, { User: user, Password: pass });

    const before = chunks.length;
    await desk.disconnect(row.id);
    t.mock.timers.tick(QSYS_KEEPALIVE_MS);
    await settle(20);
    assert.equal(chunks.length, before);
  } finally {
    desk.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
