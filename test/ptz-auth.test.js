'use strict';
// 0.11.1 UE150 camera login: HTTP Digest / Basic answered only when the camera asks (401 + WWW-Authenticate), the
// factory admin / 12345 by default, editable per camera, the password kept only in the install's systems.json
// (never in an API answer, a show file or the log). Mock cameras on 127.0.0.1 only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PTZDriver } = require('../lib/drivers/ptz');
const AUTH = require('../lib/drivers/http-auth');
const { MockPTZ } = require('../lib/mocks/ptz');
const { SystemManager } = require('../lib/systems');

test('http-auth: challenge parsing, Digest (MD5 / MD5-sess / SHA-256, qop auth) and Basic round-trip with verify()', () => {
  const ch = AUTH.parseChallenge(['Basic realm="x"', 'Digest realm="Panasonic network device", nonce="abc", qop="auth,auth-int", opaque="o1", algorithm=MD5']);
  assert.equal(ch.scheme, 'digest'); assert.equal(ch.nonce, 'abc'); assert.equal(ch.opaque, 'o1'); assert.equal(ch.qop, 'auth,auth-int');
  assert.equal(AUTH.parseChallenge('Basic realm="cam"').scheme, 'basic'); assert.equal(AUTH.parseChallenge('Bearer x'), null);
  const login = { user: 'admin', pass: '12345' };
  for (const algorithm of ['MD5', 'MD5-sess', 'SHA-256', undefined]) {
    const st = { ch: { scheme: 'digest', realm: 'r', nonce: 'n1', qop: 'auth', ...(algorithm ? { algorithm } : {}) }, nc: 0 };
    const h = AUTH.authorization(st, login, 'GET', '/live/camdata.html');
    assert.ok(AUTH.verify(h, { ...login, nonces: new Set(['n1']) }), `${algorithm} verifies`);
    assert.equal(AUTH.verify(h, { user: 'admin', pass: 'nope', nonces: new Set(['n1']) }), false);
    assert.equal(AUTH.verify(h, { ...login, nonces: new Set(['other']) }), false, 'unknown nonce refused');
    assert.match(AUTH.authorization(st, login, 'GET', '/x'), /nc=00000002/, 'nc counts up');
  }
  const b = AUTH.authorization({ ch: { scheme: 'basic' } }, login, 'GET', '/');
  assert.equal(b, `Basic ${Buffer.from('admin:12345').toString('base64')}`); assert.ok(AUTH.verify(b, { ...login, scheme: 'basic' }));
  assert.deepEqual({ ...AUTH.FACTORY }, { user: 'admin', pass: '12345' });
});

test('PTZ driver: factory login answers a Digest camera; only after the challenge; up front afterwards; wrong login is reported', async () => {
  const dig = new MockPTZ({ model: 'AW-UE150', title: 'DIG', auth: 'digest' }); const bas = new MockPTZ({ model: 'AW-UE150', title: 'BAS', auth: 'basic', pass: 'Secret-9' });
  const open = new MockPTZ({ model: 'AW-HE130', title: 'OPEN' });
  const list = [{ id: 'd', name: 'Dig', host: '127.0.0.1', port: await dig.start(0) }, { id: 'b', name: 'Bas', host: '127.0.0.1', port: await bas.start(0) }, { id: 'o', name: 'Open', host: '127.0.0.1', port: await open.start(0) }];
  const d = new PTZDriver({ cameras: list });
  try {
    await d.poll('d'); assert.equal(d.cam('d').st.data.model, 'AW-UE150'); assert.equal(dig.challenges, 1, 'one challenge');
    for (let i = 0; i < 5; i++) await d.poll('d');
    await d.ptz('d', 'PTS6050'); await d.ptz('d', 'PTS5050');
    assert.equal(dig.challenges, 1, 'later requests answer up front (no new 401)'); assert.equal(dig.authFails, 0); assert.ok(dig.authOk >= 8);
    assert.equal(d.cameraList().find((c) => c.id === 'd').authScheme, 'digest');
    // an open camera never gets credentials
    await d.poll('o'); assert.equal(d.cameraList().find((c) => c.id === 'o').authScheme, null);
    // Basic camera with a changed password: the factory login is refused, reported, then the right one works
    await assert.rejects(d.poll('b'), /login refused \(HTTP 401, basic\)/);
    let b = d.cameraList().find((c) => c.id === 'b'); assert.equal(b.connected, false); assert.equal(b.authError, true); assert.match(b.error, /check the camera login/);
    d.configure({ cameras: list.map((c) => (c.id === 'b' ? { ...c, pass: 'Secret-9' } : c)) });
    await d.poll('b'); b = d.cameraList().find((c) => c.id === 'b'); assert.equal(b.connected, true); assert.equal(b.authError, false); assert.equal(b.loginDefault, false);
    for (const c of d.cameraList()) assert.equal('pass' in c, false, 'the password is not in the camera list');
    assert.equal(JSON.stringify(d.cameraList()).includes('Secret-9'), false);
  } finally { d.close(); await Promise.all([dig.stop(), bas.stop(), open.stop()]); }
});

test('PTZ login in the SystemManager: per camera, kept in systems.json only, never in API answers or shows; reset to factory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6ptzauth-'));
  const m = new MockPTZ({ model: 'AW-UE150', title: 'A', auth: 'digest', user: 'op', pass: 'S3cret!' }); const port = await m.start(0);
  const logs = [];
  const eng = { settings: { host: '192.0.2.10' }, presets: [], destinations: [], live: { inputs: {} }, log() {}, changed() {} };
  const sm = new SystemManager({ dataDir: dir, engine: eng, autoStart: false }); const origLog = sm.log.bind(sm); sm.log = (l, msg) => { logs.push(String(msg)); return origLog(l, msg); };
  try {
    const cam = sm.addCamera({ name: 'Wide', host: '127.0.0.1', port }); assert.equal(cam.passSet, false); assert.equal('pass' in cam, false);
    await assert.rejects(sm.drivers.ptz.poll('cam1'), /login refused/);
    assert.equal(sm.view('ptz').cameras[0].user, 'admin'); assert.equal(sm.view('ptz').cameras[0].loginDefault, true); assert.equal(sm.view('ptz').cameras[0].authError, true);
    const up = sm.updateCamera('cam1', { user: 'op', pass: 'S3cret!' }); assert.equal(up.passSet, true); assert.equal('pass' in up, false);
    await sm.drivers.ptz.poll('cam1'); assert.equal(sm.view('ptz').cameras[0].connected, true); assert.equal(sm.view('ptz').cameras[0].loginDefault, false);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'systems.json'), 'utf8')).connections.ptz.cameras[0];
    assert.equal(saved.user, 'op'); assert.equal(saved.pass, 'S3cret!', 'kept in the install data folder');
    // never out: API views, the connection, a show with connections, the log
    for (const x of [sm.view('ptz'), sm.publicConn('ptz'), sm.getState(), sm.showPart({ includeConnection: true })]) assert.equal(JSON.stringify(x).includes('S3cret!'), false);
    assert.equal(logs.join('\n').includes('S3cret!'), false);
    // a client re-sending the camera list (no password in it) keeps the login; renaming keeps it too
    sm.updateConnection('ptz', { cameras: sm.publicConn('ptz').cameras.map((c) => ({ ...c, name: 'Wide 2' })) });
    sm.updateCamera('cam1', { name: 'Wide 3' });
    assert.equal(sm.conn('ptz').cameras[0].pass, 'S3cret!'); assert.equal(sm.conn('ptz').cameras[0].name, 'Wide 3');
    // a show applied with connections keeps this install's login for the same camera
    const show = sm.showPart({ includeConnection: true }); sm.applyShowPart(show, { applyConnection: true });
    assert.equal(sm.conn('ptz').cameras[0].pass, 'S3cret!');
    // back to the factory default
    sm.updateCamera('cam1', { user: '', pass: null });
    const c0 = sm.conn('ptz').cameras[0]; assert.equal(c0.user, undefined); assert.equal(c0.pass, undefined);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'systems.json'), 'utf8')).connections.ptz.cameras[0].pass, undefined);
    assert.equal(sm.view('ptz').cameras[0].loginDefault, true);
  } finally { sm.close(); await m.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
