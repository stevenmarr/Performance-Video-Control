'use strict';
// 0.34.0: Control Center runs PV Companion (the stevenmarr/companion fork) as a headless child process, so
// Control Center and Companion are one web app: one start command (the launchd service), one address
// (Companion's web UI is served under /companion/ by lib/companion/proxy.js), and Companion stops when
// Control Center stops. Companion stays its own checkout (default ~/companion) and is updated with git pull
// there; none of its source is copied into Control Center.
//
// What runs: `yarn start:local` in the Companion checkout, the same command used by hand, with
//   COMPANION_APP_PORT=<port>             (default 8000; start:local already binds 127.0.0.1 only)
//   COMPANION_CONFIG_BASEDIR=<configDir>  (default ~/companion-config)
//   COMPANION_TRUSTED_PROXIES=loopback    (Control Center's proxy is on loopback)
// It runs in its own process group, so stopping kills yarn, tsx and Companion's node together.
// start:local needs Node 26.10+ (<27). Node and yarn are found from the settings, Control Center's own node,
// the usual install places (nvm, Homebrew, Volta, fnm, mise, asdf), and the login shell's PATH (the PATH the
// Terminal has), because launchd starts Control Center with a bare PATH.
//
// Settings live in companion-supervisor.json in the data dir. mode "external" turns all of this off and Control
// Center uses a Companion run some other way (the COMPANION tab's host and port), still proxied under /companion/.
// Env overrides (handy in the launchd plist): CC_COMPANION_MODE, CC_COMPANION_PATH, CC_COMPANION_CONFIG_DIR,
// CC_COMPANION_PORT, CC_COMPANION_NODE, CC_COMPANION_YARN.

const { EventEmitter } = require('events');
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { readJson, writeJsonAtomic } = require('../store');

const DEFAULTS = { mode: 'managed', path: '~/companion', configDir: '~/companion-config', port: 8000, nodePath: '', yarnPath: '' };
const NODE_RANGE = { min: [26, 10, 0], belowMajor: 27 };
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000, 60000];
const STABLE_MS = 120000; // a run this long resets the backoff
const LOG_LINES = 1500;
const fail = (status, message) => Object.assign(new Error(message), { status });

function expandHome(p, home = os.homedir()) {
  const s = String(p == null ? '' : p).trim();
  if (s === '~') return home;
  if (s.startsWith('~/')) return path.join(home, s.slice(2));
  return s;
}

function cleanPort(v, def = DEFAULTS.port) {
  if (v == null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw fail(400, 'Port must be 1 to 65535');
  return n;
}

function cleanPathSetting(v, label) {
  const s = String(v == null ? '' : v).trim();
  if (s.length > 1024 || /[\0\r\n]/.test(s)) throw fail(400, `${label} is not a valid path`);
  return s;
}

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// ">=26.10.0 <27" from Companion's package.json engines.node, or the default above.
function parseRange(spec) {
  const lo = /(?:^|\s)>=\s*v?(\d+)\.(\d+)\.(\d+)/.exec(String(spec || ''));
  const hi = /(?:^|\s)<\s*v?(\d+)/.exec(String(spec || ''));
  if (!lo) return NODE_RANGE;
  return { min: [Number(lo[1]), Number(lo[2]), Number(lo[3])], belowMajor: hi ? Number(hi[1]) : Infinity };
}

function versionOk(v, range = NODE_RANGE) {
  const p = parseVersion(v);
  if (!p) return false;
  if (p[0] >= range.belowMajor) return false;
  for (let i = 0; i < 3; i++) { if (p[i] > range.min[i]) return true; if (p[i] < range.min[i]) return false; }
  return true;
}

function isExecutable(file) {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
}

function listDirs(dir) {
  try { return fs.readdirSync(dir).map((d) => path.join(dir, d)); } catch { return []; }
}

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

class CompanionSupervisor extends EventEmitter {
  // opts: dataDir, env (process.env), home, spawn, execFileSync, probe (async (port) => {companion, answered, error}),
  //       now, timers {setTimeout, clearTimeout}, platform, execPath, killGroup
  constructor(opts = {}) {
    super();
    this.dataDir = opts.dataDir || null;
    this.file = this.dataDir ? path.join(this.dataDir, 'companion-supervisor.json') : null;
    this.pidFile = this.dataDir ? path.join(this.dataDir, 'companion.pid') : null;
    this.logFile = this.dataDir ? path.join(this.dataDir, 'companion.log') : null;
    this.env = opts.env || process.env;
    this.home = opts.home || os.homedir();
    this._spawn = opts.spawn || childProcess.spawn;
    this._execFileSync = opts.execFileSync || childProcess.execFileSync;
    this._probe = opts.probe || ((port) => probeCompanion(port));
    this._now = opts.now || (() => Date.now());
    this._setTimeout = (opts.timers && opts.timers.setTimeout) || setTimeout;
    this._clearTimeout = (opts.timers && opts.timers.clearTimeout) || clearTimeout;
    this.platform = opts.platform || process.platform;
    this.execPath = opts.execPath || process.execPath;
    this._killGroup = opts.killGroup || ((pid, sig) => { try { process.kill(-pid, sig); return true; } catch { try { process.kill(pid, sig); return true; } catch { return false; } } });
    this._groupAlive = opts.groupAlive || ((pid) => { try { process.kill(-pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } });
    this.reapMs = opts.reapMs || 5000;
    this.healthMs = opts.healthMs || 5000;
    this.stopTimeoutMs = opts.stopTimeoutMs || 10000;
    this.backoffMs = opts.backoffMs || BACKOFF_MS;
    this.loginShellPath = opts.loginShellPath; // undefined: look it up once; null: skip
    const raw = this.file ? readJson(this.file, {}) : {};
    this.settings = this._merge(DEFAULTS, raw);
    this.child = null;
    this.state = 'stopped';
    this.message = '';
    this.wanted = false;
    this.restarts = 0;
    this.failures = 0;
    this.startedAt = null;
    this.healthyAt = null;
    this.lastExit = null;
    this.resolved = null;
    this.logs = [];
    this.logSeq = 0;
    this._timer = null;
    this._healthTimer = null;
    this._exitHook = null;
  }

  _merge(base, raw) {
    const s = { ...base };
    if (raw && (raw.mode === 'managed' || raw.mode === 'external')) s.mode = raw.mode;
    for (const k of ['path', 'configDir', 'nodePath', 'yarnPath']) if (raw && typeof raw[k] === 'string') s[k] = raw[k];
    try { if (raw && raw.port != null) s.port = cleanPort(raw.port); } catch { /* keep default */ }
    return s;
  }

  // Settings after env overrides; what actually runs.
  effective() {
    const e = this.env;
    const s = { ...this.settings };
    if (e.CC_COMPANION_MODE === 'managed' || e.CC_COMPANION_MODE === 'external') s.mode = e.CC_COMPANION_MODE;
    if (e.CC_COMPANION_PATH) s.path = e.CC_COMPANION_PATH;
    if (e.CC_COMPANION_CONFIG_DIR) s.configDir = e.CC_COMPANION_CONFIG_DIR;
    if (e.CC_COMPANION_NODE) s.nodePath = e.CC_COMPANION_NODE;
    if (e.CC_COMPANION_YARN) s.yarnPath = e.CC_COMPANION_YARN;
    if (e.CC_COMPANION_PORT) { try { s.port = cleanPort(e.CC_COMPANION_PORT); } catch { /* keep */ } }
    return { ...s, path: expandHome(s.path, this.home), configDir: expandHome(s.configDir, this.home), nodePath: expandHome(s.nodePath, this.home), yarnPath: expandHome(s.yarnPath, this.home) };
  }

  get managed() { return this.effective().mode === 'managed'; }
  get port() { return this.effective().port; }

  // Where the proxy should send /companion/ while Control Center runs Companion (or found one on its port).
  target() {
    if (!this.managed) return null;
    if (['running', 'starting', 'unhealthy', 'adopted'].includes(this.state)) return { host: '127.0.0.1', port: this.port };
    return null;
  }

  log(stream, text) {
    for (const line of stripAnsi(text).split(/\r?\n/)) {
      if (!line.trim()) continue;
      const entry = { seq: ++this.logSeq, t: new Date(this._now()).toISOString(), stream, text: line.slice(0, 2000) };
      this.logs.push(entry);
      if (this.logs.length > LOG_LINES) this.logs.splice(0, this.logs.length - LOG_LINES);
      if (this.logFile) { try { fs.appendFileSync(this.logFile, `${entry.t} ${stream} ${entry.text}\n`); } catch { /* logging must never stop Companion */ } }
    }
  }

  logsView({ since = 0, limit = 400 } = {}) {
    const lim = Math.max(1, Math.min(LOG_LINES, Number(limit) || 400));
    const list = this.logs.filter((l) => l.seq > (Number(since) || 0));
    return { seq: this.logSeq, lines: list.slice(-lim), file: this.logFile };
  }

  _set(state, message = '') {
    const changed = state !== this.state || message !== this.message;
    this.state = state; this.message = message;
    if (changed) this.emit('state', this.status());
  }

  status() {
    const s = this.effective();
    const child = this.child;
    return {
      mode: s.mode,
      managed: s.mode === 'managed',
      state: s.mode === 'managed' ? this.state : 'external',
      message: s.mode === 'managed' ? this.message : 'Companion is run outside Control Center (COMPANION tab host and port).',
      pid: child ? child.pid : null,
      port: s.port,
      path: s.path,
      configDir: s.configDir,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      healthyAt: this.healthyAt ? new Date(this.healthyAt).toISOString() : null,
      uptimeSec: child && this.startedAt ? Math.round((this._now() - this.startedAt) / 1000) : 0,
      restarts: this.restarts,
      lastExit: this.lastExit,
      node: this.resolved ? { path: this.resolved.node, version: this.resolved.nodeVersion } : null,
      yarn: this.resolved ? this.resolved.yarn : null,
      settings: { ...this.settings },
      envOverrides: ['CC_COMPANION_MODE', 'CC_COMPANION_PATH', 'CC_COMPANION_CONFIG_DIR', 'CC_COMPANION_PORT', 'CC_COMPANION_NODE', 'CC_COMPANION_YARN'].filter((k) => this.env[k]),
      uiPath: '/companion/',
      logSeq: this.logSeq,
    };
  }

  setConfig(body = {}) {
    const next = { ...this.settings };
    if (body.mode != null) {
      if (body.mode !== 'managed' && body.mode !== 'external') throw fail(400, 'mode must be "managed" or "external"');
      next.mode = body.mode;
    }
    if (body.path != null) next.path = cleanPathSetting(body.path, 'Companion folder') || DEFAULTS.path;
    if (body.configDir != null) next.configDir = cleanPathSetting(body.configDir, 'Config folder') || DEFAULTS.configDir;
    if (body.nodePath != null) next.nodePath = cleanPathSetting(body.nodePath, 'Node path');
    if (body.yarnPath != null) next.yarnPath = cleanPathSetting(body.yarnPath, 'yarn path');
    if (body.port != null) next.port = cleanPort(body.port);
    const before = JSON.stringify(this.effective());
    this.settings = next;
    if (this.file) writeJsonAtomic(this.file, this.settings);
    const changed = before !== JSON.stringify(this.effective());
    return { changed, status: this.status() };
  }

  // Apply new settings: restart when it runs, stop when switched to external, start when switched to managed.
  async applyConfig(body = {}) {
    const { changed } = this.setConfig(body);
    if (!changed) return this.status();
    await this.stop();
    if (this.managed) this.start();
    return this.status();
  }

  // ---- finding node 26 and yarn ----
  _nodeVersion(file) {
    try { return String(this._execFileSync(file, ['-v'], { timeout: 4000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim(); } catch { return null; }
  }

  _loginPath() {
    if (this.loginShellPath !== undefined) return this.loginShellPath;
    this.loginShellPath = null;
    const shell = this.env.SHELL || (this.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    try {
      const out = String(this._execFileSync(shell, ['-ilc', 'printf "\\n__CC_PATH__=%s\\n" "$PATH"'], { timeout: 6000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { HOME: this.home, USER: this.env.USER || '', SHELL: shell, TERM: 'dumb' } }));
      const m = /__CC_PATH__=(.*)/.exec(out);
      if (m && m[1].trim()) this.loginShellPath = m[1].trim();
    } catch { /* no login shell PATH; the fixed places still apply */ }
    return this.loginShellPath;
  }

  _searchDirs() {
    const h = this.home;
    const dirs = [];
    const add = (d) => { if (d && !dirs.includes(d)) dirs.push(d); };
    const versions = (base, sub = 'bin') => listDirs(base).filter((d) => /\bv?26\./.test(path.basename(d))).sort().reverse().map((d) => path.join(d, sub));
    for (const d of versions(path.join(h, '.nvm', 'versions', 'node'))) add(d);
    add('/opt/homebrew/opt/node@26/bin'); add('/usr/local/opt/node@26/bin');
    for (const d of versions(path.join(h, '.local', 'share', 'fnm', 'node-versions'), path.join('installation', 'bin'))) add(d);
    for (const d of versions(path.join(h, 'Library', 'Application Support', 'fnm', 'node-versions'), path.join('installation', 'bin'))) add(d);
    for (const d of versions(path.join(h, '.local', 'share', 'mise', 'installs', 'node'))) add(d);
    for (const d of versions(path.join(h, '.asdf', 'installs', 'nodejs'))) add(d);
    for (const d of versions(path.join(h, '.volta', 'tools', 'image', 'node'))) add(d);
    add(path.join(h, '.volta', 'bin'));
    add('/opt/homebrew/bin'); add('/usr/local/bin');
    add(path.join(h, '.yarn', 'bin')); add(path.join(h, '.npm-global', 'bin')); add(path.join(h, '.local', 'bin'));
    const lp = this._loginPath();
    for (const d of String(lp || '').split(path.delimiter)) add(d);
    for (const d of String(this.env.PATH || '').split(path.delimiter)) add(d);
    add('/usr/bin'); add('/bin');
    return dirs;
  }

  _range(dir) {
    try { return parseRange(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).engines.node); } catch { return NODE_RANGE; }
  }

  // { node, nodeVersion, yarn: {cmd, args}, pathEnv } or throws with a message for the COMPANION tab
  resolveTools(s = this.effective()) {
    const range = this._range(s.path);
    const want = `Node ${range.min.join('.')} or newer, below ${range.belowMajor}`;
    let node = null; let nodeVersion = null;
    if (s.nodePath) {
      nodeVersion = isExecutable(s.nodePath) ? this._nodeVersion(s.nodePath) : null;
      if (!versionOk(nodeVersion, range)) throw fail(409, `The Node set in Companion settings (${s.nodePath}) is ${nodeVersion || 'not runnable'}; Companion needs ${want}.`);
      node = s.nodePath;
    } else {
      const own = parseVersion(process.version) && this.execPath === process.execPath ? process.version : this._nodeVersion(this.execPath);
      if (versionOk(own, range)) { node = this.execPath; nodeVersion = own; }
      const dirs = node ? [] : this._searchDirs();
      for (const d of dirs) {
        const f = path.join(d, 'node');
        if (!isExecutable(f)) continue;
        const v = this._nodeVersion(f);
        if (versionOk(v, range)) { node = f; nodeVersion = v; break; }
      }
      if (!node) throw fail(409, `Could not find ${want} for Companion. Install it (for example nvm install 26) or set the Node path in COMPANION → Companion service.`);
    }
    const nodeDir = path.dirname(node);
    const dirs = [nodeDir, ...this._searchDirs()];
    let yarn = null;
    if (s.yarnPath) {
      if (!isExecutable(s.yarnPath)) throw fail(409, `The yarn set in Companion settings (${s.yarnPath}) is not runnable.`);
      yarn = { cmd: s.yarnPath, args: [] };
    } else {
      for (const d of dirs) { const f = path.join(d, 'yarn'); if (isExecutable(f)) { yarn = { cmd: f, args: [] }; break; } }
      if (!yarn) for (const d of dirs) { const f = path.join(d, 'corepack'); if (isExecutable(f)) { yarn = { cmd: f, args: ['yarn'] }; break; } }
      if (!yarn) throw fail(409, 'Could not find yarn for Companion. Run corepack enable (or npm i -g corepack && corepack enable) in Terminal, or set the yarn path in COMPANION → Companion service.');
    }
    const pathEnv = [nodeDir, ...dirs.filter((d) => d !== nodeDir)].join(path.delimiter);
    return { node, nodeVersion, yarn, pathEnv };
  }

  _checkout(s) {
    try { const pkg = JSON.parse(fs.readFileSync(path.join(s.path, 'package.json'), 'utf8')); return pkg && pkg.scripts && pkg.scripts['start:local'] ? pkg : null; } catch { return null; }
  }

  // A Companion child left behind by a Control Center that was killed hard (kill -9, crash).
  // The command line of a pid, or null when it is gone, or undefined when this system cannot tell (no /proc and no
  // ps, e.g. a minimal container). Linux reads /proc; macOS and others ask ps.
  _processCommand(pid) {
    if (this.platform === 'linux') {
      try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0+/g, ' ').trim(); } catch (e) { if (e.code === 'ENOENT') return null; }
    }
    try {
      return String(this._execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim() || null;
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'EACCES') return undefined; // no ps
      return null; // ps ran: no such process (exit 1)
    }
  }

  // A Companion child left behind by a Control Center that was killed hard (kill -9, crash).
  async _reapOrphan() {
    if (!this.pidFile) return;
    const rec = readJson(this.pidFile, null);
    try { fs.unlinkSync(this.pidFile); } catch { /* gone */ }
    if (!rec || !Number.isInteger(rec.pid) || rec.pid <= 1 || rec.pid === process.pid) return;
    if (!this._groupAlive(rec.pid)) return;
    const cmd = this._processCommand(rec.pid);
    if (cmd === undefined) {
      // Cannot read its command. Our child led its own process group (detached), so a live group with that id is
      // almost certainly it; stop it rather than fight it for the port.
      this.log('cc', `Stopping process group ${rec.pid} left by an earlier Control Center (could not read its command on this system)`);
      await this._reapGroup(rec.pid);
      return;
    }
    if (cmd === null || /yarn|node|tsx|companion|corepack/i.test(cmd)) {
      // null: the leader is gone but its group (tsx / node) may still run
      this.log('cc', `Stopping a Companion left running by an earlier Control Center (pid ${rec.pid})`);
      await this._reapGroup(rec.pid);
    } else {
      this.log('cc', `Pid ${rec.pid} from companion.pid is now another program (${cmd.slice(0, 80)}); leaving it alone`);
    }
  }

  _rotateLog() {
    if (!this.logFile) return;
    try { if (fs.statSync(this.logFile).size > 5 * 1024 * 1024) fs.renameSync(this.logFile, `${this.logFile}.1`); } catch { /* none yet */ }
  }

  // Start supervising. Safe to call again; does nothing in external mode.
  start() {
    if (!this.managed) return this.status();
    this.wanted = true;
    this.failures = 0;
    if (!this.child && !this._timer) this._launch().catch((e) => this._set('error', e.message));
    return this.status();
  }

  async _launch() {
    this._timer = null;
    if (!this.wanted || this.child) return;
    if (this._reaping) { await this._reaping; this._reaping = null; if (!this.wanted || this.child) return; }
    const s = this.effective();
    if (!this._checkout(s)) {
      this._set('not-installed', `No Companion checkout at ${s.path} (a folder with package.json and a start:local script). Set the folder in COMPANION → Companion service, or switch to "Companion runs separately".`);
      this._schedule(30000, false);
      return;
    }
    await this._reapOrphan();
    if (!this.wanted || this.child) return;
    const seen = await this._probe(s.port).catch(() => ({ answered: false }));
    if (!this.wanted || this.child) return;
    if (seen.companion) {
      this._set('adopted', `A Companion that Control Center did not start already answers on port ${s.port}; using it. Quit it (Ctrl-C in its Terminal) and Control Center starts its own within a few seconds.`);
      this._schedule(10000, false);
      return;
    }
    if (seen.answered) {
      this._set('error', `Port ${s.port} is used by something that is not Companion. Free it or pick another port in COMPANION → Companion service.`);
      this._schedule(15000, false);
      return;
    }
    let tools;
    try { tools = this.resolveTools(s); } catch (e) { this._set('error', e.message); this._schedule(30000, false); return; }
    this.resolved = { node: tools.node, nodeVersion: tools.nodeVersion, yarn: [tools.yarn.cmd, ...tools.yarn.args].join(' ') };
    const env = {
      ...this.env,
      PATH: tools.pathEnv,
      COMPANION_APP_PORT: String(s.port),
      COMPANION_CONFIG_BASEDIR: s.configDir,
      COMPANION_TRUSTED_PROXIES: 'loopback',
      // PV Companion (fork) 0.34-era dev.mts: skip the webui rebuild when webui/build matches the checkout, so a
      // restart after a crash takes seconds, not a rebuild. Older checkouts ignore it and rebuild as before.
      COMPANION_DEV_REBUILD_WEBUI: 'auto',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    };
    for (const k of Object.keys(env)) if (k.startsWith('CC_COMPANION_')) delete env[k];
    this._rotateLog();
    this.log('cc', `Starting Companion: ${this.resolved.yarn} start:local in ${s.path} (Node ${tools.nodeVersion}, port ${s.port}, config ${s.configDir})`);
    let child;
    try {
      child = this._spawn(tools.yarn.cmd, [...tools.yarn.args, 'start:local'], { cwd: s.path, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      this._set('error', `Could not start Companion: ${e.message}`); this._schedule(this._backoff(), true); return;
    }
    this.child = child;
    this.startedAt = this._now();
    this.healthyAt = null;
    this._set('starting', 'Companion is starting. The first start after a git pull rebuilds its web UI, which can take a few minutes.');
    if (this.pidFile && child.pid) { try { writeJsonAtomic(this.pidFile, { pid: child.pid, startedAt: new Date(this.startedAt).toISOString() }); } catch { /* best effort */ } }
    if (!this._exitHook) { this._exitHook = () => { if (this.child && this.child.pid) this._killGroup(this.child.pid, 'SIGTERM'); }; process.once('exit', this._exitHook); }
    if (child.stdout) child.stdout.on('data', (d) => this.log('out', d.toString()));
    if (child.stderr) child.stderr.on('data', (d) => this.log('err', d.toString()));
    child.on('error', (e) => { this.log('cc', `Companion process error: ${e.message}`); if (!child.pid) this._onExit(child, null, null, e.message); });
    child.on('exit', (code, signal) => this._onExit(child, code, signal));
    this._healthLoop();
  }

  // The group leader (yarn) exiting does not end Companion's node: tsx and Companion can outlive it and keep the
  // port. Every exit therefore ends the whole process group (SIGTERM, then SIGKILL) before anything restarts.
  async _reapGroup(pid) {
    if (!pid || !this._groupAlive(pid)) return true;
    this._killGroup(pid, 'SIGTERM');
    const wait = (ms) => new Promise((r) => { const t = this._setTimeout(r, ms); if (t && t.unref) t.unref(); });
    for (let waited = 0; waited < this.reapMs; waited += 200) { if (!this._groupAlive(pid)) return true; await wait(200); }
    this.log('cc', `Companion processes still running ${Math.round(this.reapMs / 1000)} s after SIGTERM; sending SIGKILL`);
    this._killGroup(pid, 'SIGKILL');
    for (let waited = 0; waited < 2000; waited += 200) { if (!this._groupAlive(pid)) return true; await wait(200); }
    return !this._groupAlive(pid);
  }

  _onExit(child, code, signal, error) {
    if (this.child !== child) return;
    this._reaping = this._reapGroup(child.pid).catch(() => false);
    this.child = null;
    this._clearTimeout(this._healthTimer); this._healthTimer = null;
    try { if (this.pidFile) fs.unlinkSync(this.pidFile); } catch { /* gone */ }
    const ran = this.startedAt ? this._now() - this.startedAt : 0;
    this.lastExit = { code: code == null ? null : code, signal: signal || null, error: error || null, at: new Date(this._now()).toISOString(), ranSec: Math.round(ran / 1000) };
    this.log('cc', `Companion exited (${signal ? `signal ${signal}` : `code ${code}`}) after ${Math.round(ran / 1000)} s`);
    if (this._stopResolve) { const r = this._stopResolve; this._stopResolve = null; r(); }
    if (!this.wanted) { this._set('stopped', 'Companion is stopped.'); return; }
    if (ran >= STABLE_MS) this.failures = 0;
    const wait = this._backoff();
    this.restarts += 1;
    this._set('backoff', `Companion stopped unexpectedly (${signal ? signal : `exit code ${code}`}). Restarting in ${Math.round(wait / 1000)} s. See the log below.`);
    const reaping = this._reaping;
    reaping.then(() => { if (this.wanted && !this.child) this._schedule(wait, true); });
  }

  _backoff() {
    const i = Math.min(this.failures, this.backoffMs.length - 1);
    this.failures += 1;
    return this.backoffMs[i];
  }

  _schedule(ms) {
    this._clearTimeout(this._timer);
    this._timer = this._setTimeout(() => { this._timer = null; this._launch().catch((e) => this._set('error', e.message)); }, ms);
    if (this._timer && this._timer.unref) this._timer.unref();
  }

  _healthLoop() {
    this._clearTimeout(this._healthTimer);
    const tick = async () => {
      if (!this.child) return;
      const r = await this._probe(this.port).catch(() => ({ companion: false }));
      if (!this.child) return;
      if (r.companion) {
        if (!this.healthyAt) this.log('cc', `Companion answers on 127.0.0.1:${this.port}; its web UI is at /companion/`);
        this.healthyAt = this._now();
        this._set('running', 'Companion is running inside Control Center.');
      } else if (this.healthyAt) {
        this._set('unhealthy', `Companion's process is running but its web server stopped answering${r.error ? ` (${r.error})` : ''}.`);
      }
      this._healthTimer = this._setTimeout(tick, this.healthMs);
      if (this._healthTimer && this._healthTimer.unref) this._healthTimer.unref();
    };
    this._healthTimer = this._setTimeout(tick, Math.min(1000, this.healthMs));
    if (this._healthTimer && this._healthTimer.unref) this._healthTimer.unref();
  }

  // Stop Companion and its whole process group: SIGTERM, then SIGKILL after stopTimeoutMs.
  async stop() {
    this.wanted = false;
    this._clearTimeout(this._timer); this._timer = null;
    this._clearTimeout(this._healthTimer); this._healthTimer = null;
    const child = this.child;
    if (!child) { if (this.managed) this._set('stopped', 'Companion is stopped.'); return this.status(); }
    this._set('stopping', 'Stopping Companion…');
    this.log('cc', 'Stopping Companion');
    const exited = new Promise((resolve) => { this._stopResolve = resolve; });
    this._killGroup(child.pid, 'SIGTERM');
    let to;
    const timeout = new Promise((resolve) => { to = this._setTimeout(() => resolve('timeout'), this.stopTimeoutMs); });
    const r = await Promise.race([exited, timeout]);
    this._clearTimeout(to);
    if (r === 'timeout' && this.child === child) {
      this.log('cc', `Companion did not stop in ${Math.round(this.stopTimeoutMs / 1000)} s; killing it`);
      this._killGroup(child.pid, 'SIGKILL');
      await Promise.race([exited, new Promise((resolve) => this._setTimeout(resolve, 2000))]);
      if (this.child === child) this._onExit(child, null, 'SIGKILL');
    }
    if (this._reaping) { await this._reaping; this._reaping = null; }
    if (this._exitHook) { process.removeListener('exit', this._exitHook); this._exitHook = null; }
    return this.status();
  }

  async restart() {
    await this.stop();
    return this.start();
  }
}

// Does a Companion answer on 127.0.0.1:port? Companion sets X-App: Bitfocus Companion on every response.
function probeCompanion(port, { host = '127.0.0.1', timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/', timeout: timeoutMs, headers: { Accept: 'text/html' } }, (res) => {
      const app = String(res.headers['x-app'] || '');
      res.resume();
      resolve({ answered: true, companion: /companion/i.test(app), status: res.statusCode });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e) => resolve({ answered: e.message === 'timed out', companion: false, error: e.code || e.message }));
  });
}

module.exports = { CompanionSupervisor, probeCompanion, versionOk, parseRange, expandHome, DEFAULTS, BACKOFF_MS };
