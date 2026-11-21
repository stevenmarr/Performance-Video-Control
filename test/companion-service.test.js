'use strict';
// 0.34.0: Control Center runs PV Companion as a headless child (lib/companion/supervisor.js). These tests run the
// real supervisor against test/fixtures/fake-companion (a stand-in that answers like Companion and leaves a
// grandchild behind, like yarn → tsx → node), so process groups, restarts and stops are real.
process.env.RS6_QUIET = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { CompanionSupervisor, groupAlive, versionOk, parseRange, expandHome } = require('../lib/companion/supervisor');
const { until } = require('./helpers');

const FAKE = path.join(__dirname, 'fixtures', 'fake-companion');
const posix = process.platform !== 'win32';
// A zombie (exited, not collected yet) is not alive: in a container whose PID 1 never collects orphans, the fake's
// grandchild stays one after it is killed.
const alive = (pid) => {
  try { process.kill(pid, 0); } catch (e) { return e.code === 'EPERM'; }
  try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return !/^[ZX]/.test(st.slice(st.lastIndexOf(')') + 2)); } catch { return true; }
};
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const readMarker = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// Everything a test starts is stopped after it, pass or fail, so a failure cannot keep the event loop busy and
// cancel the rest of the file.
const made = [];
const extraPids = [];
const servers = [];
test.afterEach(async () => {
  for (const srv of servers.splice(0)) { try { srv.closeAllConnections(); srv.close(); } catch { /* closed */ } }
  for (const sup of made.splice(0)) { try { await sup.stop(); } catch { /* already stopped */ } }
  for (const pid of extraPids.splice(0)) { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
});

// A directory with only a `node` in it (a copy-free wrapper that runs this node), so tests do not depend on what
// sits next to the real node (some machines have /usr/bin/yarn beside /usr/bin/node).
function loneNodeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-lone-node-'));
  const f = path.join(dir, 'node');
  fs.writeFileSync(f, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  fs.chmodSync(f, 0o755);
  return { dir, node: f };
}

async function make(extraEnv = {}, opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cmpsvc-'));
  const port = await freePort();
  const marker = path.join(dataDir, 'marker.json');
  const env = { ...process.env, CC_COMPANION_MODE: 'managed', CC_COMPANION_PATH: FAKE, CC_COMPANION_CONFIG_DIR: path.join(dataDir, 'cfg'), CC_COMPANION_PORT: String(port), CC_COMPANION_NODE: process.execPath, CC_COMPANION_YARN: path.join(FAKE, 'fake-yarn'), FAKE_MARKER: marker, ...extraEnv };
  const sup = new CompanionSupervisor({ dataDir, env, loginShellPath: null, healthMs: 100, backoffMs: [100, 200, 400], stopTimeoutMs: 1500, reapMs: 800, ...opts });
  made.push(sup);
  return { sup, dataDir, port, marker };
}

test('version range: Node 26.10+ below 27 by default, and from Companion\'s engines.node', () => {
  assert.equal(versionOk('v26.10.0'), true);
  assert.equal(versionOk('v26.13.1'), true);
  assert.equal(versionOk('v26.9.9'), false);
  assert.equal(versionOk('v27.0.0'), false);
  assert.equal(versionOk('v24.22.1'), false);
  assert.equal(versionOk('garbage'), false);
  const r = parseRange('>=26.10.0 <27');
  assert.deepEqual(r.min, [26, 10, 0]); assert.equal(r.belowMajor, 27);
  assert.equal(expandHome('~/companion', '/Users/pv'), '/Users/pv/companion');
});

test('defaults: managed, ~/companion, ~/companion-config, port 8000; settings persist; env overrides win', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cmpsvc-'));
  const sup = new CompanionSupervisor({ dataDir, env: {}, home: '/Users/pv', loginShellPath: null });
  const e = sup.effective();
  assert.equal(e.mode, 'managed'); assert.equal(e.path, '/Users/pv/companion'); assert.equal(e.configDir, '/Users/pv/companion-config'); assert.equal(e.port, 8000);
  sup.setConfig({ mode: 'external', port: 8001, path: '~/pv-companion' });
  const again = new CompanionSupervisor({ dataDir, env: { CC_COMPANION_PORT: '8123' }, home: '/Users/pv', loginShellPath: null });
  assert.equal(again.effective().mode, 'external');
  assert.equal(again.effective().path, '/Users/pv/pv-companion');
  assert.equal(again.effective().port, 8123, 'env override');
  assert.deepEqual(again.status().envOverrides, ['CC_COMPANION_PORT']);
  assert.equal(again.status().state, 'external');
  assert.equal(again.target(), null, 'external mode: the proxy uses the COMPANION tab host and port');
  assert.throws(() => sup.setConfig({ mode: 'sideways' }), /mode must be/);
  assert.throws(() => sup.setConfig({ port: 70000 }), /Port must be/);
});

test('no checkout at the folder: not-installed with a plain message, nothing spawned', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cmpsvc-'));
  let spawned = 0;
  const sup = new CompanionSupervisor({ dataDir, env: { CC_COMPANION_PATH: path.join(dataDir, 'nope') }, loginShellPath: null, spawn: () => { spawned += 1; throw new Error('should not spawn'); } });
  sup.start();
  await until(() => sup.state === 'not-installed', 2000, 'not-installed');
  assert.match(sup.status().message, /No Companion checkout/);
  assert.equal(spawned, 0);
  await sup.stop();
});

test('Node too old or missing yarn: error says what to install; yarn next to node is found first', { skip: !posix }, async () => {
  const { sup } = await make({ CC_COMPANION_NODE: '' });
  sup._range = () => ({ min: [99, 0, 0], belowMajor: 100 });
  sup._searchDirs = () => [];
  assert.throws(() => sup.resolveTools(), /Could not find Node 99\.0\.0/);
  const lone = loneNodeDir();
  const { sup: s2 } = await make({ CC_COMPANION_YARN: '', CC_COMPANION_NODE: lone.node });
  s2._searchDirs = () => [];
  assert.throws(() => s2.resolveTools(), /Could not find yarn/);
  // and with a yarn next to that node, it is found there first
  fs.writeFileSync(path.join(lone.dir, 'yarn'), '#!/bin/sh\nexit 0\n'); fs.chmodSync(path.join(lone.dir, 'yarn'), 0o755);
  const t = s2.resolveTools();
  assert.equal(t.yarn.cmd, path.join(lone.dir, 'yarn'));
  assert.equal(t.pathEnv.split(path.delimiter)[0], lone.dir);
});

test('starts Companion headless with the port, config dir and trusted-proxy env; health turns it running', { skip: !posix }, async () => {
  const { sup, port, marker, dataDir } = await make();
  sup.start();
  await until(() => sup.state === 'running', 8000, 'running');
  const st = sup.status();
  assert.ok(st.pid > 0);
  assert.deepEqual(sup.target(), { host: '127.0.0.1', port });
  const m = readMarker(marker);
  assert.equal(m.env.COMPANION_CONFIG_BASEDIR, path.join(dataDir, 'cfg'));
  assert.equal(m.env.COMPANION_TRUSTED_PROXIES, 'loopback');
  assert.equal(m.env.COMPANION_DEV_REBUILD_WEBUI, 'auto');
  assert.ok(fs.existsSync(path.join(dataDir, 'companion.pid')), 'pid file for orphan clean-up');
  assert.ok(sup.logsView().lines.some((l) => /Started on/.test(l.text)), 'stdout is in the log');
  assert.ok(fs.readFileSync(path.join(dataDir, 'companion.log'), 'utf8').includes('Started on'), 'and in companion.log');
  await sup.stop();
  assert.equal(sup.state, 'stopped');
  await until(() => !alive(m.pid) && !alive(m.grandchild), 3000, 'whole group gone');
  assert.ok(!fs.existsSync(path.join(dataDir, 'companion.pid')));
});

test('a crash restarts with backoff, and the leftover grandchild is reaped first', { skip: !posix }, async () => {
  const { sup, marker } = await make();
  sup.start();
  await until(() => sup.state === 'running', 8000, 'running');
  const first = readMarker(marker);
  process.kill(first.pid, 'SIGKILL'); // only the leader dies; its grandchild would keep running
  await until(() => sup.restarts === 1, 3000, 'restart counted');
  await until(() => !alive(first.grandchild), 3000, 'grandchild reaped');
  await until(() => sup.state === 'running' && sup.child && sup.child.pid !== first.pid, 8000, 'running again');
  assert.equal(sup.status().lastExit.signal, 'SIGKILL');
  const second = readMarker(marker);
  await sup.stop();
  await until(() => !alive(second.pid) && !alive(second.grandchild), 3000, 'group gone');
});

test('stop escalates to SIGKILL when Companion ignores SIGTERM', { skip: !posix }, async () => {
  const { sup, marker } = await make({ FAKE_IGNORE_TERM: '1' });
  sup.start();
  await until(() => sup.state === 'running', 8000, 'running');
  const m = readMarker(marker);
  const t0 = Date.now();
  await sup.stop();
  assert.ok(Date.now() - t0 < 6000);
  await until(() => !alive(m.pid), 3000, 'killed');
  assert.ok(sup.logsView().lines.some((l) => /killing it|SIGKILL/.test(l.text)));
});

test('a Companion already on the port is used (adopted), not fought over', async () => {
  const { sup, port } = await make();
  const http = require('http');
  const other = http.createServer((req, res) => { res.setHeader('X-App', 'Bitfocus Companion'); res.end('x'); });
  servers.push(other);
  await new Promise((r) => other.listen(port, '127.0.0.1', r));
  let spawned = 0;
  sup._spawn = () => { spawned += 1; throw new Error('should not spawn'); };
  sup.start();
  await until(() => sup.state === 'adopted', 3000, 'adopted');
  assert.equal(spawned, 0);
  assert.deepEqual(sup.target(), { host: '127.0.0.1', port });
  await sup.stop();
});

test('a port held by something that is not Companion is an error, not a crash loop', async () => {
  const { sup, port } = await make();
  const http = require('http');
  const other = http.createServer((req, res) => res.end('not companion'));
  servers.push(other);
  await new Promise((r) => other.listen(port, '127.0.0.1', r));
  sup.start();
  await until(() => sup.state === 'error', 3000, 'error');
  assert.match(sup.status().message, /not Companion/);
  await sup.stop();
});

test('an orphan left by a Control Center killed with -9 is stopped before starting again', { skip: !posix }, async () => {
  const { sup, dataDir, marker } = await make();
  // a leftover group from "the previous Control Center"
  const { spawn } = require('child_process');
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  extraPids.push(orphan.pid);
  fs.writeFileSync(path.join(dataDir, 'companion.pid'), JSON.stringify({ pid: orphan.pid }));
  sup.start();
  await until(() => sup.state === 'running', 8000, 'running');
  await until(() => !alive(orphan.pid) || orphan.exitCode !== null || orphan.signalCode !== null, 3000, 'orphan stopped');
  assert.ok(sup.logsView().lines.some((l) => /left running by an earlier Control Center/.test(l.text)));
  const m = readMarker(marker);
  await sup.stop();
  await until(() => !alive(m.pid), 3000, 'stopped');
});

test('switching to external stops Companion; switching back starts it', { skip: !posix }, async () => {
  const { sup, marker } = await make({ CC_COMPANION_MODE: '' });
  sup.start();
  await until(() => sup.state === 'running', 8000, 'running');
  const m = readMarker(marker);
  await sup.applyConfig({ mode: 'external' });
  assert.equal(sup.status().state, 'external');
  await until(() => !alive(m.pid), 3000, 'stopped');
  await sup.applyConfig({ mode: 'managed' });
  await until(() => sup.state === 'running', 8000, 'running again');
  await sup.stop();
});

test('orphan clean-up without /proc or ps (minimal container): the leftover group is still stopped', { skip: !posix }, async () => {
  const { spawn } = require('child_process');
  const noPs = (cmd, args, o) => { if (cmd === 'ps') { const e = new Error('spawnSync ps ENOENT'); e.code = 'ENOENT'; throw e; } return require('child_process').execFileSync(cmd, args, o); };
  const { sup, dataDir } = await make({}, { platform: 'darwin', execFileSync: noPs });
  assert.equal(sup._processCommand(process.pid), undefined, 'cannot tell on this system');
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  extraPids.push(orphan.pid);
  fs.writeFileSync(path.join(dataDir, 'companion.pid'), JSON.stringify({ pid: orphan.pid }));
  await sup._reapOrphan();
  await until(() => orphan.exitCode !== null || orphan.signalCode !== null, 3000, 'orphan stopped');
  assert.ok(sup.logsView().lines.some((l) => /could not read its command/.test(l.text)));
  assert.ok(!fs.existsSync(path.join(dataDir, 'companion.pid')));
});

test('a stale companion.pid naming another program, or nothing, is left alone', { skip: !posix }, async () => {
  const { spawn } = require('child_process');
  const { sup, dataDir } = await make();
  const other = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  extraPids.push(other.pid);
  fs.writeFileSync(path.join(dataDir, 'companion.pid'), JSON.stringify({ pid: other.pid }));
  await sup._reapOrphan();
  assert.ok(alive(other.pid), 'sleep was not touched');
  assert.ok(sup.logsView().lines.some((l) => /now another program/.test(l.text)));
  fs.writeFileSync(path.join(dataDir, 'companion.pid'), JSON.stringify({ pid: 2147483000 }));
  await sup._reapOrphan(); // no such group: nothing to do, no throw
});

test('groupAlive: zombies do not count (a container whose PID 1 never collects orphans), live members do', () => {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-fakeproc-'));
  const put = (pid, comm, state, pgrp) => { fs.mkdirSync(path.join(proc, String(pid))); fs.writeFileSync(path.join(proc, String(pid), 'stat'), `${pid} (${comm}) ${state} 1 ${pgrp} ${pgrp} 0 -1\n`); };
  put(4100, 'yarn', 'Z', 4100);
  put(4101, 'node (tsx) x', 'Z', 4100); // a comm with spaces and ')'
  put(4200, 'other', 'S', 4200);
  fs.mkdirSync(path.join(proc, 'self'));
  const kill = () => true; // kill(-pgid, 0) succeeds for a zombie-only group
  assert.equal(groupAlive(4100, { kill, platform: 'linux', procDir: proc }), false, 'only zombies left: gone');
  put(4102, 'node', 'S', 4100);
  assert.equal(groupAlive(4100, { kill, platform: 'linux', procDir: proc }), true, 'a sleeping member: alive');
  assert.equal(groupAlive(4100, { kill, platform: 'linux', procDir: path.join(proc, 'nope') }), true, 'no /proc: trust the signal');
  assert.equal(groupAlive(4100, { kill, platform: 'darwin', procDir: proc }), true, 'not Linux: trust the signal');
  const esrch = () => { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; };
  assert.equal(groupAlive(4100, { kill: esrch, platform: 'linux', procDir: proc }), false, 'no such group');
  assert.equal(groupAlive(process.pid === 1 ? 2 : 999999, { platform: 'linux' }), false, 'real kill: a group that does not exist');
});
