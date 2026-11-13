'use strict';
// One desk for module instances. Each instance is a saved connection plus the
// variables the last reply wrote. Buttons call run() with the action id.

const { EventEmitter } = require('events');
const dgram = require('dgram');
const path = require('path');
const { readJson, writeJsonAtomic } = require('../store');
const { systems, get } = require('./catalog');
const { feedbackFlags, interpolateAction } = require('./framework');
const { encodePayload, decodePayload } = require('./encode');
const T = require('./transports');

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

function freshId(system) {
  return `${system}-${Math.random().toString(36).slice(2, 8)}`;
}

function cleanConn(system, raw) {
  const out = {};
  for (const field of system.connection.fields) {
    const given = raw && raw[field.id];
    if (field.type === 'number') out[field.id] = given == null || given === '' ? Number(field.default) || 0 : Number(given);
    else if (field.type === 'boolean') out[field.id] = given == null ? !!field.default : !!given;
    else out[field.id] = given == null ? String(field.default || '') : String(given).slice(0, 2000);
  }
  return out;
}

function authOf(conn) {
  const kind = String(conn.authType || 'none');
  if (kind === 'basic') return { type: 'basic', user: conn.username || '', password: conn.password || '' };
  if (kind === 'bearer') return { type: 'bearer', token: conn.password || conn.token || '' };
  return null;
}

function baseUrl(conn) {
  const scheme = conn.https ? 'https' : 'http';
  const port = conn.port ? `:${conn.port}` : '';
  let base = conn.basePath || '';
  if (base && !base.startsWith('/')) base = `/${base}`;
  return `${scheme}://${conn.host}${port}${base}`;
}

function headerLines(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function delimiterOf(conn) {
  const raw = conn.delimiter == null || conn.delimiter === '' ? '\n' : String(conn.delimiter);
  return raw.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
}

function vmixVars(xml) {
  const tag = (name) => { const m = new RegExp(`<${name}>([^<]*)</${name}>`, 'i').exec(xml || ''); return m ? m[1].trim() : ''; };
  const bool = (s) => /^(true|1)$/i.test(s) ? 'true' : 'false';
  return {
    connected: 'true', version: tag('version'), preview: tag('preview'), program: tag('active'),
    recording: bool(tag('recording')), streaming: bool(tag('streaming')), fadeToBlack: bool(tag('fadeToBlack')),
  };
}

class ModuleDesk extends EventEmitter {
  constructor({ dataDir, pollFloorMs = 500 } = {}) {
    super();
    this.file = dataDir ? path.join(dataDir, 'modules.json') : null;
    this.pollFloorMs = pollFloorMs;
    this.instances = [];
    this.sessions = new Map();
    this.timers = new Map();
    this.armed = new Map();
    this._load();
  }

  _load() {
    const raw = this.file ? readJson(this.file, { instances: [] }) : { instances: [] };
    this.instances = [];
    for (const row of raw.instances || []) {
      const system = get(row && row.system);
      if (!system || system.transport === 'native' || system.transport === 'none' || system.status === 'not yet') continue;
      this.instances.push({
        id: String(row.id),
        system: system.id,
        name: String(row.name || system.short).slice(0, 40),
        connection: cleanConn(system, row.connection || {}),
        vars: { connected: 'false' },
        status: 'offline',
        error: null,
        lastSeen: 0,
      });
    }
  }

  _save() {
    if (!this.file) return;
    writeJsonAtomic(this.file, {
      instances: this.instances.map((i) => ({ id: i.id, system: i.system, name: i.name, connection: i.connection })),
    });
  }

  _changed() { this.emit('state'); }

  listSystems() { return systems(); }

  create(systemId, body = {}) {
    const system = get(systemId);
    if (!system) throw fail(`No system "${systemId}"`, 404);
    if (system.transport === 'native' || system.status === 'not yet') throw fail(`${system.label} uses its existing Control Center connection`, 409);
    if (this.instances.length >= 64) throw fail('Too many module connections', 409);
    const id = freshId(system.id);
    const row = {
      id, system: system.id, name: String(body.name || system.short).slice(0, 40) || system.short,
      connection: cleanConn(system, body.connection || {}),
      vars: { connected: 'false' }, status: 'offline', error: null, lastSeen: 0,
    };
    this.instances.push(row);
    this._save();
    this._changed();
    return this.publicInstance(row);
  }

  must(id) {
    const row = this.instances.find((i) => i.id === id);
    if (!row) throw fail(`No module connection "${id}"`, 404);
    return row;
  }

  update(id, body = {}) {
    const row = this.must(id);
    const system = get(row.system);
    if (body.name != null) row.name = String(body.name).slice(0, 40) || row.name;
    if (body.connection) row.connection = cleanConn(system, { ...row.connection, ...body.connection });
    this._save();
    this._changed();
    return this.publicInstance(row);
  }

  async remove(id) {
    const row = this.must(id);
    await this.disconnect(id).catch(() => {});
    this.instances = this.instances.filter((i) => i !== row);
    this._save();
    this._changed();
    return { ok: true };
  }

  async connect(id) {
    const row = this.must(id);
    const system = get(row.system);
    if (!row.connection.host && system.transport !== 'tcp') throw fail('Set a host first');
    if (system.transport === 'tcp' && row.connection.server && !row.connection.port) throw fail('Set a listen port');
    await this._closeSession(id);
    row.status = 'connecting';
    row.error = null;
    this._changed();
    try {
      await this._open(row, system);
      row.status = 'online';
      row.vars.connected = 'true';
      row.error = null;
      row.lastSeen = Date.now();
      this._startPoll(row, system);
    } catch (e) {
      row.status = 'offline';
      row.vars.connected = 'false';
      row.error = e.message;
      this._changed();
      throw e;
    }
    this._changed();
    return this.publicInstance(row);
  }

  async disconnect(id) {
    const row = this.must(id);
    await this._closeSession(id);
    row.status = 'offline';
    row.vars.connected = 'false';
    this._changed();
    return this.publicInstance(row);
  }

  async _open(row, system) {
    const c = row.connection;
    if (system.transport === 'http' || system.transport === 'osc' || system.transport === 'udp' || system.transport === 'visca') {
      if (system.transport === 'udp' || system.transport === 'osc') await this._openUdp(row, system);
      if (system.poll && system.poll.type === 'vmix') await this._pollOne(row, system);
      else if (system.poll && system.poll.type === 'propresenter') await this._pollOne(row, system);
      return;
    }
    if (system.transport === 'tcp' || system.transport === 'pjlink') {
      if (c.server) {
        const server = await T.listenTcp({
          host: c.listenHost || '127.0.0.1', port: c.port, delimiter: delimiterOf(c),
          onLine: (line) => { row.vars['tcp.last'] = String(line).slice(0, 500); row.vars.connected = 'true'; row.lastSeen = Date.now(); this._changed(); },
        });
        this.sessions.set(row.id, { kind: 'server', server });
        return;
      }
      const session = new T.TcpSession({ host: c.host, port: c.port, delimiter: system.transport === 'pjlink' ? '\r' : delimiterOf(c), reconnect: c.reconnect !== false });
      session.on('data', (line) => { row.vars['tcp.last'] = String(line).slice(0, 500); row.lastSeen = Date.now(); this._changed(); });
      session.on('status', (st) => { row.vars.connected = st.connected ? 'true' : 'false'; row.status = st.connected ? 'online' : 'offline'; this._changed(); });
      await session.start();
      this.sessions.set(row.id, { kind: 'tcp', session });
      if (system.poll && system.poll.type === 'grandma-login' && c.username) {
        const user = String(c.username).replace(/"/g, '');
        const pass = String(c.password || '').replace(/"/g, '');
        await session.send(`Login "${user}" "${pass}"\r\n`);
      }
      return;
    }
    if (system.transport === 'midi') {
      const session = new T.TcpSession({ host: c.host, port: c.port, delimiter: '', reconnect: true });
      await session.start();
      this.sessions.set(row.id, { kind: 'tcp', session });
      return;
    }
    if (system.transport === 'pulse') {
      const rpc = new T.JsonRpcClient({ host: c.host, port: c.port || 9090 });
      rpc.on('notify', (msg) => { applyPulse(row, msg); this._changed(); });
      await rpc.start();
      this.sessions.set(row.id, { kind: 'pulse', rpc });
      await rpc.call('property.subscribe', { property: 'system.state' }).catch(() => {});
      await rpc.call('property.subscribe', { property: 'optics.shutter.position' }).catch(() => {});
      const state = await rpc.call('property.get', { property: 'system.state' }).catch(() => '');
      applyPulseState(row, state);
      return;
    }
    if (system.transport === 'obs') {
      const obs = new T.ObsClient();
      await obs.connect({ host: c.host, port: c.port || 4455, password: c.password || '' });
      this.sessions.set(row.id, { kind: 'obs', obs });
      return;
    }
    throw fail(`${system.label} has no connection to open`, 409);
  }

  async _openUdp(row, system) {
    const port = Number(row.connection.listenPort) || 0;
    if (!port) return;
    const sock = await T.listenUdp({
      port, multicast: row.connection.multicast || '',
      onMessage: (msg, rinfo) => {
        if (system && system.datagram === 'grandma3') applyGrandma3(row, msg);
        else row.vars['udp.last'] = decodePayload(msg, row.connection.encoding || 'ascii').slice(0, 500);
        row.vars['udp.from'] = `${rinfo.address}:${rinfo.port}`;
        row.lastSeen = Date.now();
        this._changed();
      },
    });
    this.sessions.set(row.id, { kind: 'udp', sock });
  }

  async _closeSession(id) {
    clearInterval(this.timers.get(id));
    this.timers.delete(id);
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    if (!s) return;
    if (s.session) s.session.close();
    if (s.obs) s.obs.close();
    if (s.rpc) s.rpc.close();
    if (s.sock) { try { s.sock.close(); } catch { /* closed */ } }
    if (s.server) await new Promise((resolve) => s.server.close(() => resolve()));
  }

  _startPoll(row, system) {
    const live = system.poll && ['vmix', 'propresenter', 'obs', 'visca-power', 'pjlink', 'pulse'].includes(system.poll.type);
    const custom = !!(row.connection.pollPath && Number(row.connection.pollMs) > 0);
    if (!live && !custom) return;
    const ms = Math.max(this.pollFloorMs, Number(row.connection.pollMs) || 1000);
    const timer = setInterval(() => { this._pollOne(row, system).catch((e) => { row.error = e.message; row.vars.connected = 'false'; this._changed(); }); }, ms);
    if (timer.unref) timer.unref();
    this.timers.set(row.id, timer);
    this._pollOne(row, system).catch(() => {});
  }

  async _pollOne(row, system) {
    if (system.poll && system.poll.type === 'vmix') {
      const res = await this._http(row, { method: 'GET', path: '/api/' }, {});
      if (res.status >= 400) throw fail(`vMix returned ${res.status}`, 502);
      Object.assign(row.vars, vmixVars(res.body));
    } else if (system.poll && system.poll.type === 'propresenter') {
      const res = await this._http(row, { method: 'GET', path: '/version' }, {});
      row.vars.connected = res.status < 400 ? 'true' : 'false';
      row.vars.version = res.body.slice(0, 80);
    } else if (system.poll && system.poll.type === 'obs') {
      const obs = this.sessions.get(row.id) && this.sessions.get(row.id).obs;
      if (!obs) return;
      const scene = await obs.request('GetCurrentProgramScene', {});
      const rec = await obs.request('GetRecordStatus', {});
      const stream = await obs.request('GetStreamStatus', {});
      row.vars.programScene = scene.currentProgramSceneName || '';
      row.vars.recording = rec.outputActive ? 'true' : 'false';
      row.vars.streaming = stream.outputActive ? 'true' : 'false';
      row.vars.connected = 'true';
    } else if (system.poll && system.poll.type === 'visca-power') {
      const packet = T.viscaPacket([0x81, 0x09, 0x04, 0x00, 0xFF], 1);
      const reply = await viscaExchange(row.connection.host, row.connection.port || 52381, packet, 1500);
      row.vars.power = reply.includes(0x02) ? 'on' : reply.includes(0x03) ? 'off' : '';
      row.vars.connected = 'true';
    } else if (system.poll && system.poll.type === 'pulse') {
      const rpc = this.sessions.get(row.id) && this.sessions.get(row.id).rpc;
      if (!rpc) return;
      applyPulseState(row, await rpc.call('property.get', { property: 'system.state' }));
      const shutter = await rpc.call('property.get', { property: 'optics.shutter.position' }).catch(() => null);
      if (shutter != null) row.vars.shutter = String(shutter);
    } else if (system.poll && system.poll.type === 'pjlink') {
      const text = await this._pjlink(row, '%1POWR ?\r');
      const m = /POWR=(\d)/.exec(text || '');
      row.vars.power = m ? m[1] : '';
      row.vars.connected = 'true';
    } else if (row.connection.pollPath && system.transport === 'http') {
      const res = await this._http(row, { method: 'GET', path: row.connection.pollPath }, {});
      row.vars['http.status'] = String(res.status);
      row.vars['http.body'] = res.body.slice(0, 500);
      row.vars.connected = res.status < 500 ? 'true' : 'false';
    }
    row.lastSeen = Date.now();
    row.error = null;
    this._changed();
  }

  async run(id, actionId, options = {}) {
    const row = this.must(id);
    const system = get(row.system);
    const action = system.actionMap.get(actionId);
    if (!action) throw fail(`No action "${actionId}"`, 404);
    if (action.confirm) {
      const key = `${row.id}:${action.id}`;
      const until = this.armed.get(key) || 0;
      if (Date.now() > until) {
        this.armed.set(key, Date.now() + 4000);
        return { ok: true, pending: true, armed: false };
      }
      this.armed.delete(key);
    }
    const opts = { ...(action.native && action.native.defaults), ...options };
    const spec = interpolateAction(action, row.connection, opts, row.vars);
    if (row.status !== 'online' && system.transport !== 'http' && system.transport !== 'udp' && system.transport !== 'osc' && system.transport !== 'visca') {
      throw fail(`${row.name} is not connected`, 409);
    }
    const result = await this._dispatch(row, system, spec, opts);
    if (result && result.vars) Object.assign(row.vars, result.vars);
    row.vars.connected = 'true';
    row.lastSeen = Date.now();
    row.error = null;
    if (row.status === 'offline') row.status = 'online';
    this._changed();
    return { ok: true, pending: false, vars: row.vars, raw: result && result.raw };
  }

  async runSteps(id, steps) {
    const out = [];
    for (const step of steps || []) {
      if (step.delayMs) await new Promise((r) => setTimeout(r, Math.min(60000, Number(step.delayMs) || 0)));
      const name = String(step.action || '');
      const actionId = name.includes('.') ? name.split('.').slice(1).join('.') : name;
      const result = await this.run(id, actionId, step.options || {});
      out.push(result);
      if (result.pending) break;
    }
    return { ok: true, steps: out };
  }

  async _dispatch(row, system, spec, options) {
    const type = spec.type;
    if (type === 'http') return this._runHttp(row, spec, options);
    if (type === 'udp') return this._runUdp(row, spec, options);
    if (type === 'tcp' || type === 'line') return this._runTcp(row, spec, options);
    if (type === 'osc') return this._runOsc(row, spec, options);
    if (type === 'visca') return this._runVisca(row, spec.bytes);
    if (type === 'visca-preset') return this._runViscaPreset(row, spec, options);
    if (type === 'obs') return this._runObs(row, spec);
    if (type === 'pjlink') return this._runPjlink(row, spec);
    if (type === 'pulse') return this._runPulse(row, spec);
    if (type === 'sq-mute' || type === 'sq-scene' || type === 'sq-fader') return this._runSq(row, spec, options);
    throw fail(`Action cannot be sent (${type || 'none'})`, 400);
  }

  async _http(row, spec, options) {
    const method = String(spec.method || options.method || 'GET').toUpperCase();
    if (!METHODS.has(method)) throw fail(`Method ${method} is not GET, POST, PUT, PATCH or DELETE`);
    let pathName = String(spec.path || options.path || '/');
    if (pathName.includes('://')) throw fail('The path stays on the connected host');
    if (!pathName.startsWith('/')) pathName = `/${pathName}`;
    const query = spec.query || options.query || '';
    const url = `${baseUrl(row.connection)}${pathName}${query ? (pathName.includes('?') ? '&' : '?') + query : ''}`;
    const headers = headerLines(options.headers || spec.headers || '');
    let body = spec.body != null && spec.body !== '' ? spec.body : (options.body || '');
    const contentType = options.contentType || spec.contentType || '';
    if (contentType) headers['Content-Type'] = contentType;
    if (contentType.includes('json') && body && typeof body === 'string') {
      try { body = JSON.parse(body); } catch { /* send the text */ }
    }
    return T.httpRequest({
      url, method, headers, body: body === '' ? null : body,
      timeoutMs: Number(options.timeoutMs || row.connection.timeoutMs) || 4000,
      retries: options.retries != null ? options.retries : (row.connection.retries || 0),
      auth: authOf(row.connection),
    });
  }

  async _runHttp(row, spec, options) {
    const res = await this._http(row, spec, options);
    const vars = { 'http.status': String(res.status), 'http.body': res.body.slice(0, 500), connected: res.status < 500 ? 'true' : 'false' };
    if ((options.parse || spec.parse) === 'json') {
      const obj = JSON.parse(res.body || 'null');
      const val = T.jsonPath(obj, options.jsonPath || spec.jsonPath || '');
      vars[options.variable || 'http.value'] = val == null ? '' : typeof val === 'object' ? JSON.stringify(val).slice(0, 500) : String(val);
    } else if ((options.parse || spec.parse) === 'regex' && (options.regex || spec.regex)) {
      const pattern = String(options.regex || spec.regex).slice(0, 200);
      const m = new RegExp(pattern).exec(res.body || '');
      vars[options.variable || 'http.value'] = m ? String(m[1] != null ? m[1] : m[0]).slice(0, 500) : '';
    }
    if (res.status >= 400) throw fail(`HTTP ${res.status}`, res.status >= 500 ? 502 : 400);
    return { vars, raw: res.body.slice(0, 500) };
  }

  async _runUdp(row, spec, options) {
    const encoding = options.encoding || spec.encoding || row.connection.encoding || 'ascii';
    let payload;
    if (encoding === 'osc' || spec.address || options.address) {
      const address = options.address || spec.address || '/';
      payload = T.oscMessage(address, options.args || spec.args || '');
    } else payload = encodePayload(options.payload != null ? options.payload : spec.payload, encoding);
    const broadcast = options.broadcast != null ? !!options.broadcast : !!row.connection.broadcast;
    const multicast = options.multicast || row.connection.multicast || '';
    await T.sendUdp({ host: row.connection.host, port: Number(row.connection.port) || 0, payload, broadcast, multicast });
    return { vars: { connected: 'true', 'udp.last': decodePayload(payload, encoding === 'osc' ? 'hex' : encoding).slice(0, 200) } };
  }

  async _runTcp(row, spec, options) {
    const session = this.sessions.get(row.id) && this.sessions.get(row.id).session;
    if (!session) throw fail('TCP is not connected', 409);
    const encoding = options.encoding || 'escape';
    const payload = spec.payload != null ? spec.payload : encodePayload(options.payload || '', encoding);
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const expect = options.expect || spec.expect || '';
    const reply = await session.send(buf, { expect: expect || null, timeoutMs: Number(options.timeoutMs) || 4000 });
    const vars = { connected: 'true' };
    if (reply != null) vars['tcp.reply'] = String(reply).slice(0, 500);
    return { vars, raw: reply };
  }

  async _runOsc(row, spec) {
    const payload = T.oscMessage(spec.address, spec.args || []);
    await T.sendUdp({ host: row.connection.host, port: Number(row.connection.port) || 0, payload });
    const vars = { connected: 'true', last: spec.address };
    if (String(spec.address).includes('/cue/')) vars.cue = spec.address;
    if (String(spec.address).includes('/clips/')) vars.clip = spec.address;
    if (String(spec.address).includes('/columns/')) vars.column = spec.address;
    return { vars };
  }

  async _runVisca(row, bytes) {
    const packet = T.viscaPacket(bytes, (row._seq = (row._seq || 0) + 1));
    await T.sendUdp({ host: row.connection.host, port: Number(row.connection.port) || 52381, payload: packet });
    return { vars: { connected: 'true' } };
  }

  async _runViscaPreset(row, spec, options) {
    const preset = Math.max(0, Math.min(15, (Number(options.preset) || 1) - 1));
    const which = spec.which === 'store' ? 0x01 : 0x02;
    return this._runVisca(row, [0x81, 0x01, 0x04, 0x3F, which, preset, 0xFF]);
  }

  async _runObs(row, spec) {
    const obs = this.sessions.get(row.id) && this.sessions.get(row.id).obs;
    if (!obs) throw fail('OBS is not connected', 409);
    const data = {};
    for (const [k, val] of Object.entries(spec.requestData || {})) {
      if (val === 'true') data[k] = true;
      else if (val === 'false') data[k] = false;
      else data[k] = val;
    }
    const response = await obs.request(spec.requestType, data);
    return { vars: { connected: 'true' }, raw: response };
  }

  async _runPulse(row, spec) {
    const rpc = this.sessions.get(row.id) && this.sessions.get(row.id).rpc;
    if (!rpc) throw fail('Pulse is not connected', 409);
    const result = await rpc.call(spec.method, spec.params);
    const vars = { connected: 'true' };
    if (spec.method === 'property.set' && spec.params && spec.params.property === 'optics.shutter.target') vars.shutter = String(spec.params.value);
    if (spec.method === 'property.set' && spec.params && spec.params.property === 'image.window.main.source') vars.source = String(spec.params.value);
    return { vars, raw: result };
  }

  async _runPjlink(row, spec) {
    const text = await this._pjlink(row, spec.command);
    return { vars: { connected: 'true', last: String(text || '').slice(0, 200) }, raw: text };
  }

  async _pjlink(row, command) {
    const session = this.sessions.get(row.id) && this.sessions.get(row.id).session;
    if (!session) throw fail('PJLink is not connected', 409);
    let line = command;
    if (row._pjlinkSeed) line = T.pjlinkAuth(row._pjlinkSeed, row.connection.password || '', command);
    const reply = await session.send(line, { expect: '.', timeoutMs: 4000 });
    const text = String(reply || '');
    const hello = /PJLINK 1 ([0-9a-f]{8})/i.exec(text);
    if (hello) {
      row._pjlinkSeed = hello[1];
      const again = T.pjlinkAuth(row._pjlinkSeed, row.connection.password || '', command);
      return session.send(again, { expect: '.', timeoutMs: 4000 });
    }
    if (/PJLINK 0/.test(text) && !text.includes('%')) return session.send(command, { expect: '.', timeoutMs: 4000 });
    return text;
  }

  async _runSq(row, spec, options) {
    const session = this.sessions.get(row.id) && this.sessions.get(row.id).session;
    if (!session) throw fail('SQ is not connected', 409);
    const nibble = (Math.max(1, Math.min(16, Number(row.connection.midiChannel) || 1)) - 1) & 0x0f;
    const ch = Math.max(0, (Number(options.channel) || 1) - 1) & 0x7f;
    let bytes;
    if (spec.type === 'sq-mute') bytes = [0xB0 | nibble, 0x63, 0x00, 0xB0 | nibble, 0x62, ch, 0xB0 | nibble, 0x06, 0x00, 0xB0 | nibble, 0x26, spec.on ? 0x01 : 0x00];
    else if (spec.type === 'sq-scene') {
      const scene = Math.max(1, Number(options.scene) || 1);
      const bank = Math.floor((scene - 1) / 128) & 0x7f;
      const program = (scene - 1) % 128;
      bytes = [0xB0 | nibble, 0x00, bank, 0xC0 | nibble, program];
    } else {
      const value = Math.max(0, Math.min(16383, Number(options.value) || 0));
      bytes = [0xB0 | nibble, 0x63, 0x40, 0xB0 | nibble, 0x62, ch, 0xB0 | nibble, 0x06, (value >> 7) & 0x7f, 0xB0 | nibble, 0x26, value & 0x7f];
    }
    await session.send(Buffer.from(bytes));
    return { vars: { connected: 'true', last: Buffer.from(bytes).toString('hex') } };
  }

  close() {
    for (const id of [...this.sessions.keys()]) this._closeSession(id);
  }

  publicInstance(row) {
    const system = get(row.system);
    return {
      id: row.id, system: row.system, name: row.name, label: system ? system.label : row.system,
      status: row.status, error: row.error, lastSeen: row.lastSeen,
      connection: { ...row.connection, password: row.connection.password ? '***' : '' },
      vars: { ...row.vars },
      flags: system ? feedbackFlags(system, row.vars) : {},
    };
  }

  view() {
    return { instances: this.instances.map((row) => this.publicInstance(row)) };
  }
}

function applyPulseState(row, state) {
  const text = state == null ? '' : String(state);
  row.vars.state = text;
  row.vars.power = text === 'on' ? 'on' : text;
}

function applyPulse(row, msg) {
  if (!msg || msg.method !== 'property.changed') return;
  const list = msg.params && msg.params.property;
  const rows = Array.isArray(list) ? list : [];
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue;
    if (item['system.state'] != null) applyPulseState(row, item['system.state']);
    if (item['optics.shutter.position'] != null) row.vars.shutter = String(item['optics.shutter.position']);
    if (item['optics.shutter.target'] != null) row.vars.shutter = String(item['optics.shutter.target']);
  }
}

function applyGrandma3(row, buf) {
  const msg = require('../drivers/osc').decode(buf);
  if (!msg) return;
  let address = msg.address;
  const prefix = String(row.connection.prefix || '');
  if (prefix && address.startsWith(`/${prefix.replace(/^\//, '')}`)) address = address.slice(prefix.replace(/^\//, '').length + 1) || address;
  row.vars.last = address;
  const seq = /^\/13\.13\.1\.6\.(\d+)$/.exec(address);
  if (seq && msg.args.length >= 2) {
    row.vars.sequence = seq[1];
    row.vars.function = String(msg.args[0].value);
    const value = msg.args[msg.args.length - 1].value;
    if (typeof value === 'number') {
      row.vars.fader = String(Math.round(value * 10) / 10);
      row.vars.executor = seq[1];
    }
  }
  const fader = /^\/(?:Page(\d+)\/)?Fader(\d+)$/.exec(address);
  if (fader && msg.args[0]) {
    if (fader[1]) row.vars.page = fader[1];
    row.vars.executor = fader[2];
    row.vars.fader = String(msg.args[0].value);
  }
  const key = /^\/(?:Page(\d+)\/)?Key(\d+)$/.exec(address);
  if (key && msg.args[0]) {
    if (key[1]) row.vars.page = key[1];
    row.vars.executor = key[2];
    const down = msg.args[0].type === 's' ? msg.args[0].value : Number(msg.args[0].value);
    row.vars.key = down === 0 || down === '0' || down === false ? 'up' : 'down';
  }
}

function viscaExchange(host, port, packet, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => { try { sock.close(); } catch { /* closed */ } reject(fail('VISCA did not answer', 504)); }, timeoutMs);
    sock.once('error', (e) => { clearTimeout(timer); try { sock.close(); } catch { /* closed */ } reject(fail(e.message, 502)); });
    sock.once('message', (msg) => { clearTimeout(timer); try { sock.close(); } catch { /* closed */ } resolve(msg); });
    sock.bind(0, () => sock.send(packet, port, host));
  });
}

module.exports = { ModuleDesk, vmixVars, cleanConn };
