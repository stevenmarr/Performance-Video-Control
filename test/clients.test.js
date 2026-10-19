'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { setup } = require('./helpers');
const { AwjClient } = require('../lib/awj');
const { RestClient, API } = require('../lib/rest');
const { parseDest } = require('../lib/device');

test('parseDest accepts S/A keys and rejects junk', () => {
  assert.deepEqual(parseDest('s3'), { key: 'S3', kind: 'screen', id: 3 });
  assert.deepEqual(parseDest('A02'), { key: 'A2', kind: 'aux', id: 2 });
  assert.throws(() => parseDest('X1'));
});

test('AWJ client: 0x04 framing, get replies, E12 errors, writes', async () => {
  const { mock, awjPort, teardown } = await setup();
  const c = new AwjClient({ host: '127.0.0.1', port: awjPort });
  try {
    assert.equal(await c.get('DeviceObject/system/$device/@items/1/@props/dev'), 'NLC_RS6');
    assert.equal(await c.get('DeviceObject/system/$device/@items/1/version/@props/updater'), '6.2.79');
    await assert.rejects(c.get('DeviceObject/nonsense'), /E12/);
    // queued gets after an error still resolve correctly
    const [a, b] = await Promise.all([
      c.get('DeviceObject/$screen/@items/S1/control/@props/label'),
      c.get('DeviceObject/$screenAuxGroup/@items/S2/status/@props/transition'),
    ]);
    assert.equal(a, 'Center LED'); assert.equal(b, 'AT_DOWN');
    await c.replace('DeviceObject/presetBank/control/load/$slot/@items/33/$screen/@items/S1/$preset/@items/PREVIEW/@props/xRequest', true);
    assert.equal(mock.dests.S1.B.presetId, 33);
    assert.ok(mock.history.some((h) => h.proto === 'awj' && h.op === 'replace'));
  } finally { c.close(); await teardown(); }
});

test('AWJ client reassembles a frame split across TCP packets', async () => {
  const srv = net.createServer((s) => s.on('data', () => {
    const msg = Buffer.from('{"path":"DeviceObject/x","value":42}');
    s.write(msg.subarray(0, 10)); setTimeout(() => s.write(Buffer.concat([msg.subarray(10), Buffer.from([4])])), 20);
  }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const c = new AwjClient({ host: '127.0.0.1', port: srv.address().port });
  try { assert.equal(await c.get('DeviceObject/x'), 42); } finally { c.close(); await new Promise((r) => srv.close(r)); }
});

test('REST client logs in on 401 via /auth/login and sends auth-jwt cookie', async () => {
  const { mock, restPort, teardown } = await setup({ password: 'secret' });
  try {
    const bad = new RestClient({ host: '127.0.0.1', port: restPort });
    await assert.rejects(bad.get(`${API}/system`), /password/);
    const good = new RestClient({ host: '127.0.0.1', port: restPort, password: 'secret' });
    const sys = await good.get(`${API}/system`);
    assert.equal(sys.type, 'AQL RS6');
    assert.ok(good.cookie && good.cookie.length > 8);
    // the token is reused on the next call without a new login
    const before = mock.tokens.size; await good.get(`${API}/screens/1`); assert.equal(mock.tokens.size, before);
    const wrong = new RestClient({ host: '127.0.0.1', port: restPort, password: 'nope' });
    await assert.rejects(wrong.get(`${API}/system`), /Login failed/);
  } finally { await teardown(); }
});

test('REST POST body Content-Length matches byte count (REST p.12)', async () => {
  const http = require('http');
  let seen;
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { seen = { len: Number(req.headers['content-length']), bytes: Buffer.byteLength(b), ct: req.headers['content-type'] }; res.writeHead(204); res.end(); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const c = new RestClient({ host: '127.0.0.1', port: srv.address().port });
    await c.post(`${API}/screens/2/load-memory`, { memoryId: 30, target: 'preview' });
    assert.equal(seen.len, seen.bytes); assert.equal(seen.ct, 'application/json');
  } finally { await new Promise((r) => srv.close(r)); }
});
