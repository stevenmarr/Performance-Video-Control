'use strict';
// Camera login: HTTP Digest / Basic answered only when the camera asks (401 + WWW-Authenticate).
// There is no factory password. Credentials come from the shared vault or a per-camera login
// kept only in the install's systems.json (never in an API answer, a show file or the log).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PTZDriver } = require('../lib/drivers/ptz');
const AUTH = require('../lib/drivers/http-auth');
const { MockPTZ } = require('../lib/mocks/ptz');
const { SystemManager } = require('../lib/systems');
const vault = require('../lib/ptz-provision/vault');
const { ownOnly } = require('./own-only');
const startOwn = (mock) => { const port = mock.start(0); ownOnly(mock.server); return port; };
const PW1 = `t-${require('crypto').randomBytes(6).toString('hex')}-Aa1`;
const PW2 = `t-${require('crypto').randomBytes(6).toString('hex')}-Aa1`;
const PW3 = `t-${require('crypto').randomBytes(6).toString('hex')}-Aa1`;

test('http-auth: no FACTORY export; Digest and Basic round-trip with verify()', () => {
  assert.equal('FACTORY' in AUTH, false);
  const ch = AUTH.parseChallenge(['Basic realm="x"', 'Digest realm="Panasonic network device", nonce="abc", qop="auth,auth-int", opaque="o1", algorithm=MD5']);
  assert.equal(ch.scheme, 'digest'); assert.equal(ch.nonce, 'abc'); assert.equal(ch.opaque, 'o1'); assert.equal(ch.qop, 'auth,auth-int');
  assert.equal(AUTH.parseChallenge('Basic realm="cam"').scheme, 'basic'); assert.equal(AUTH.parseChallenge('Bearer x'), null);
  const login = { user: 'op', pass: PW3 };
  for (const algorithm of ['MD5', 'MD5-sess', 'SHA-256', undefined]) {
    const st = { ch: { scheme: 'digest', realm: 'r', nonce: 'n1', qop: 'auth', ...(algorithm ? { algorithm } : {}) }, nc: 0 };
    const h = AUTH.authorization(st, login, 'GET', '/live/camdata.html');
    assert.ok(AUTH.verify(h, { ...login, nonces: new Set(['n1']) }), `${algorithm} verifies`);
    assert.equal(AUTH.verify(h, { user: 'op', pass: 'nope', nonces: new Set(['n1']) }), false);
    assert.equal(AUTH.verify(h, { ...login, nonces: new Set(['other']) }), false, 'unknown nonce refused');
    assert.match(AUTH.authorization(st, login, 'GET', '/x'), /nc=00000002/, 'nc counts up');
  }
  const b = AUTH.authorization({ ch: { scheme: 'basic' } }, login, 'GET', '/');
  assert.equal(b, `Basic ${Buffer.from(`op:${PW3}`).toString('base64')}`); assert.ok(AUTH.verify(b, { ...login, scheme: 'basic' }));
});

test('PTZ driver: no credentials means a 401 is reported as login required; vault login answers Digest; wrong login is reported', async () => {
  const dig = new MockPTZ({ model: 'AW-UE150', title: 'DIG', auth: 'digest', user: 'house', pass: PW1 });
  const bas = new MockPTZ({ model: 'AW-UE150', title: 'BAS', auth: 'basic', user: 'house', pass: PW2 });
  const open = new MockPTZ({ model: 'AW-HE130', title: 'OPEN' });
  const list = [{ id: 'd', name: 'Dig', host: '127.0.0.1', port: await startOwn(dig) }, { id: 'b', name: 'Bas', host: '127.0.0.1', port: await startOwn(bas) }, { id: 'o', name: 'Open', host: '127.0.0.1', port: await startOwn(open) }];
  const d = new PTZDriver({ cameras: list });
  try {
    await assert.rejects(d.poll('d'), /login required/);
    assert.equal(d.cameraList().find((c) => c.id === 'd').loginSource, 'none');
    d.setVault(() => ({ user: 'house', pass: PW1, source: 'file' }));
    await d.poll('d'); assert.equal(d.cam('d').st.data.model, 'AW-UE150'); assert.equal(dig.challenges, 2, 'challenge before vault, then one more to log in');
    for (let i = 0; i < 5; i++) await d.poll('d');
    await d.ptz('d', 'PTS6050'); await d.ptz('d', 'PTS5050');
    assert.equal(dig.authFails, 0); assert.ok(dig.authOk >= 8);
    assert.equal(d.cameraList().find((c) => c.id === 'd').authScheme, 'digest');
    assert.equal(d.cameraList().find((c) => c.id === 'd').loginSource, 'vault');
    await d.poll('o'); assert.equal(d.cameraList().find((c) => c.id === 'o').authScheme, null);
    // Basic camera with a different password: vault is refused, then a per-camera login works
    await assert.rejects(d.poll('b'), /login refused \(HTTP 401, basic\)/);
    let b = d.cameraList().find((c) => c.id === 'b'); assert.equal(b.connected, false); assert.equal(b.authError, true); assert.match(b.error, /check the camera login/);
    d.configure({ cameras: list.map((c) => (c.id === 'b' ? { ...c, pass: PW2, user: 'house' } : c)) });
    d.setVault(() => ({ user: 'house', pass: PW1, source: 'file' }));
    await d.poll('b'); b = d.cameraList().find((c) => c.id === 'b'); assert.equal(b.connected, true); assert.equal(b.authError, false); assert.equal(b.loginSource, 'camera');
    for (const c of d.cameraList()) assert.equal('pass' in c, false, 'the password is not in the camera list');
    assert.equal(JSON.stringify(d.cameraList()).includes(PW1), false);
    assert.equal(JSON.stringify(d.cameraList()).includes(PW2), false);
  } finally { d.close(); await Promise.all([dig.stop(), bas.stop(), open.stop()]); }
});

test('PTZ login in the SystemManager: vault is shared, per-camera pass stays in systems.json only, never in API answers or shows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6ptzauth-'));
  const m = new MockPTZ({ model: 'AW-UE150', title: 'A', auth: 'digest', user: 'op', pass: PW2 }); const port = await startOwn(m);
  const logs = [];
  const eng = { settings: { host: '192.0.2.10' }, presets: [], destinations: [], live: { inputs: {} }, log() {}, changed() {} };
  const sm = new SystemManager({ dataDir: dir, engine: eng, autoStart: false }); const origLog = sm.log.bind(sm); sm.log = (l, msg) => { logs.push(String(msg)); return origLog(l, msg); };
  try {
    const cam = sm.addCamera({ name: 'Wide', host: '127.0.0.1', port }); assert.equal(cam.passSet, false); assert.equal('pass' in cam, false);
    await assert.rejects(sm.drivers.ptz.poll('cam1'), /login required|login refused/);
    assert.equal(sm.view('ptz').cameras[0].loginSource, 'none'); assert.equal(sm.view('ptz').cameras[0].authError, true);
    sm.setPtzVault({ user: 'op', pass: PW2 });
    await sm.drivers.ptz.poll('cam1'); assert.equal(sm.view('ptz').cameras[0].connected, true); assert.equal(sm.view('ptz').cameras[0].loginSource, 'vault');
    assert.equal(JSON.stringify(sm.ptzVaultView()).includes(PW2), false);
    const savedVault = fs.readFileSync(vault.filePath(dir), 'utf8');
    assert.ok(savedVault.includes(PW2));
    assert.equal(fs.statSync(vault.filePath(dir)).mode & 0o777, 0o600);
    // a per-camera login also stays in systems.json, never out
    const up = sm.updateCamera('cam1', { user: 'op', pass: PW2 }); assert.equal(up.passSet, true); assert.equal('pass' in up, false);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'systems.json'), 'utf8')).connections.ptz.cameras[0];
    assert.equal(saved.user, 'op'); assert.equal(saved.pass, PW2, 'kept in the install data folder');
    for (const x of [sm.view('ptz'), sm.publicConn('ptz'), sm.getState(), sm.showPart({ includeConnection: true }), sm.ptzVaultView()]) assert.equal(JSON.stringify(x).includes(PW2), false);
    assert.equal(logs.join('\n').includes(PW2), false);
    sm.updateConnection('ptz', { cameras: sm.publicConn('ptz').cameras.map((c) => ({ ...c, name: 'Wide 2' })) });
    sm.updateCamera('cam1', { name: 'Wide 3' });
    assert.equal(sm.conn('ptz').cameras[0].pass, PW2); assert.equal(sm.conn('ptz').cameras[0].name, 'Wide 3');
    const show = sm.showPart({ includeConnection: true }); sm.applyShowPart(show, { applyConnection: true });
    assert.equal(sm.conn('ptz').cameras[0].pass, PW2);
    // clear the per-camera login: falls back to the vault
    sm.updateCamera('cam1', { user: '', pass: null });
    const c0 = sm.conn('ptz').cameras[0]; assert.equal(c0.user, undefined); assert.equal(c0.pass, undefined);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'systems.json'), 'utf8')).connections.ptz.cameras[0].pass, undefined);
    await sm.drivers.ptz.poll('cam1');
    assert.equal(sm.view('ptz').cameras[0].loginSource, 'vault');
    assert.equal(sm.view('ptz').cameras[0].connected, true);
  } finally { sm.close(); await m.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
