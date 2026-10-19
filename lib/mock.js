'use strict';
// Mock Aquilon RS6: a small REST (HTTP) + AWJ (TCP, 0x04-framed) server that implements ONLY the
// documented endpoints this app uses, with plausible state. It is a test double, not an emulator:
// the real device's edge-case behaviour (errors, timing, preset-toggle semantics) is unverified.
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const SCREENS = { 1: 'Center LED', 2: 'Left IMAG', 3: 'Right IMAG', 4: 'Stage Floor' };
const AUXES = { 1: 'Confidence', 2: 'Record' };
const SCREEN_LAYERS = 4; const AUX_LAYERS = 2;

function memoryContent(id, kind) {
  const layers = [
    { layer: 1, sourceType: 'input', sourceId: ((id - 1) % 12) + 1, status: 'open' },
    { layer: 2, sourceType: 'image', sourceId: ((id - 1) % 8) + 1, status: 'open' },
  ];
  if (kind === 'screen') {
    layers.push({ layer: 3, sourceType: id % 2 ? 'input' : 'none', sourceId: id % 2 ? ((id + 3) % 12) + 1 : 0, status: id % 2 ? 'open' : 'close' });
    layers.push({ layer: 4, sourceType: 'none', sourceId: 0, status: 'close' });
  }
  return { layers, background: kind === 'screen' ? { sourceType: 'background-set', sourceId: ((id - 1) % 8) + 1 } : null };
}

function emptySide(kind) {
  const n = kind === 'screen' ? SCREEN_LAYERS : AUX_LAYERS;
  return {
    layers: Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, { sourceType: 'none', sourceId: 0, status: 'close' }])),
    background: kind === 'screen' ? { sourceType: 'none', sourceId: 0 } : null,
    presetId: 0,
  };
}

class MockAquilon {
  constructor({ password = '' } = {}) {
    this.password = password; this.tokens = new Set(); this.history = [];
    this.dests = {};
    for (const [id, label] of Object.entries(SCREENS)) this.dests[`S${id}`] = { kind: 'screen', id: +id, label, transition: 'AT_DOWN', A: emptySide('screen'), B: emptySide('screen') };
    for (const [id, label] of Object.entries(AUXES)) this.dests[`A${id}`] = { kind: 'aux', id: +id, label, transition: 'AT_DOWN', A: emptySide('aux'), B: emptySide('aux') };
  }

  side(key, which) { const d = this.dests[key]; const pgm = d.transition === 'AT_DOWN' ? 'A' : 'B'; const pvw = pgm === 'A' ? 'B' : 'A'; return d[which === 'program' ? pgm : pvw]; }
  record(proto, op, detail) { this.history.push({ t: Date.now(), proto, op, ...detail }); }

  loadMemory(key, memoryId, target) {
    const d = this.dests[key]; if (!d) return false;
    const c = memoryContent(memoryId, d.kind); const s = this.side(key, target);
    for (const l of c.layers) s.layers[l.layer] = { sourceType: l.sourceType, sourceId: l.sourceId, status: l.status };
    if (c.background) s.background = { ...c.background };
    s.presetId = memoryId;
    this.record('state', 'load', { dest: key, memoryId, target });
    return true;
  }

  take(key) {
    const d = this.dests[key]; if (!d) return false;
    d.transition = d.transition === 'AT_DOWN' ? 'AT_UP' : 'AT_DOWN';
    // Model "Preset Toggle" disabled (User Manual 14.1.9): PRW content stays in PRW after the take.
    const pgm = this.side(key, 'program'); const pvw = this.side(key, 'preview');
    Object.assign(pvw, JSON.parse(JSON.stringify(pgm)));
    this.record('state', 'take', { dest: key });
    return true;
  }

  // ---------------- REST ----------------
  async startRest(port = 0, host = '127.0.0.1') {
    this.restServer = http.createServer((req, res) => this._rest(req, res));
    await new Promise((r) => this.restServer.listen(port, host, r));
    return this.restServer.address().port;
  }

  _rest(req, res) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const send = (status, obj, headers = {}) => {
        const body = obj === undefined ? '' : JSON.stringify(obj);
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(body);
      };
      const url = new URL(req.url, 'http://x');
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = {};
      if (raw) { try { body = JSON.parse(raw); } catch { return send(400, { error: 'invalid json' }); } }
      if (req.method === 'POST' && url.pathname === '/auth/login') {
        if (url.searchParams.get('identifier') === 'Admin' && url.searchParams.get('password') === this.password) {
          const tok = crypto.randomBytes(12).toString('hex'); this.tokens.add(tok);
          res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': `auth-jwt=${tok}; Path=/; HttpOnly` }); return res.end('OK');
        }
        return send(401, { error: 'bad credentials' });
      }
      if (this.password) {
        const m = /auth-jwt=([^;]+)/.exec(req.headers.cookie || '');
        if (!m || !this.tokens.has(m[1])) return send(401, { error: 'Unauthorized' });
      }
      this.record('rest', req.method, { path: url.pathname, body: raw ? body : undefined });
      const p = url.pathname.replace(/^\/api\/tpp\/v1/, '');
      if (!url.pathname.startsWith('/api/tpp/v1')) return send(404, { error: 'not found' });
      let m;
      if (req.method === 'GET' && p === '/system') return send(200, { type: 'AQL RS6', label: 'MOCK-RS6', isLinked: false, linkName: '', version: { major: 6, minor: 2, patch: 79, beta: false } });
      if (req.method === 'GET' && (m = /^\/screens\/(\d+)$/.exec(p))) {
        const n = +m[1]; if (n < 1 || n > 24) return send(404, { error: 'screen index out of range' });
        const d = this.dests[`S${n}`]; return send(200, { isEnabled: !!d, label: d ? d.label : '' });
      }
      if (req.method === 'GET' && (m = /^\/auxiliary-screens\/(\d+)$/.exec(p))) {
        const n = +m[1]; if (n < 1 || n > 96) return send(404, { error: 'aux index out of range' });
        const d = this.dests[`A${n}`]; return send(200, { isEnabled: !!d, label: d ? d.label : '' });
      }
      if (req.method === 'POST' && (m = /^\/(screens|auxiliary-screens)\/(\d+)\/load-memory$/.exec(p))) {
        const key = (m[1] === 'screens' ? 'S' : 'A') + m[2];
        const id = Number(body.memoryId); const target = body.target || 'preview';
        if (!this.dests[key]) return send(404, { error: 'unknown destination' });
        if (!(id >= 1 && id <= 1000) || !['preview', 'program'].includes(target)) return send(400, { error: 'bad parameters' });
        this.loadMemory(key, id, target); return send(204);
      }
      if (req.method === 'POST' && p === '/take') {
        const s = body.screenIds || []; const a = body.auxiliaryScreenIds || body['auxiliaryScreenIds '] || [];
        for (const n of s) this.take(`S${n}`); for (const n of a) this.take(`A${n}`);
        return send(204);
      }
      if (req.method === 'POST' && (m = /^\/(screens|auxiliary-screens)\/(\d+)\/take$/.exec(p))) {
        const key = (m[1] === 'screens' ? 'S' : 'A') + m[2]; if (!this.take(key)) return send(404, { error: 'unknown destination' }); return send(204);
      }
      if ((m = /^\/screens\/(\d+)\/layers\/(\d+)\/presets\/(preview|program)(\/source)?$/.exec(p))) {
        const key = `S${m[1]}`; const d = this.dests[key]; if (!d) return send(404, { error: 'unknown screen' });
        const L = this.side(key, m[3]).layers[m[2]]; if (!L) return send(404, { error: 'layer not allocated' });
        if (req.method === 'GET' && !m[4]) return send(200, { status: L.status, sourceType: L.sourceType, sourceId: L.sourceId });
        if (req.method === 'POST' && m[4]) { L.sourceType = body.sourceType; L.sourceId = body.sourceId ?? 0; L.status = body.sourceType === 'none' ? 'close' : 'open'; this.side(key, m[3]).presetId = 0; return send(204); }
      }
      if ((m = /^\/auxiliary-screens\/(\d+)\/layers\/(\d+)\/presets\/(preview|program)\/source$/.exec(p))) {
        const key = `A${m[1]}`; const d = this.dests[key]; if (!d) return send(404, { error: 'unknown aux' });
        const L = this.side(key, m[3]).layers[m[2]]; if (!L) return send(404, { error: 'layer not allocated' });
        if (req.method === 'GET') return send(200, { sourceType: L.sourceType, sourceId: L.sourceId });
        if (req.method === 'POST') { L.sourceType = body.sourceType; L.sourceId = body.sourceId ?? 0; L.status = body.sourceType === 'none' ? 'close' : 'open'; this.side(key, m[3]).presetId = 0; return send(204); }
      }
      if ((m = /^\/screens\/(\d+)\/background-layer\/presets\/(preview|program)(\/source)?$/.exec(p))) {
        const key = `S${m[1]}`; if (!this.dests[key]) return send(404, { error: 'unknown screen' });
        const s = this.side(key, m[2]);
        if (req.method === 'GET' && !m[3]) return send(200, { target: m[2], status: s.background.sourceType === 'none' ? 'close' : 'open', ...s.background });
        if (req.method === 'POST' && m[3]) { s.background = { sourceType: body.sourceType, sourceId: body.sourceId ?? 0 }; return send(204); }
      }
      return send(404, { error: `not implemented in mock: ${req.method} ${url.pathname}` });
    });
  }

  // ---------------- AWJ ----------------
  async startAwj(port = 0, host = '127.0.0.1') {
    this._socks = new Set();
    this.awjServer = net.createServer((sock) => {
      this._socks.add(sock); sock.on('close', () => this._socks.delete(sock));
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]); let i;
        while ((i = buf.indexOf(0x04)) >= 0) {
          const f = buf.subarray(0, i).toString('utf8'); buf = buf.subarray(i + 1);
          const reply = this._awj(f);
          if (reply) sock.write(Buffer.concat([Buffer.from(JSON.stringify(reply)), Buffer.from([0x04])]));
        }
      });
      sock.on('error', () => {});
    });
    await new Promise((r) => this.awjServer.listen(port, host, r));
    return this.awjServer.address().port;
  }

  _awj(frame) {
    let cmd; try { cmd = JSON.parse(frame); } catch { return { error: { code: 'E09', message: 'Unexpected command JSON token' } }; }
    if (!['get', 'replace'].includes(cmd.op)) return { error: { code: 'E11', message: 'Unexpected operator' } };
    const path = String(cmd.path || ''); this.record('awj', cmd.op, { path, value: cmd.value });
    const E12 = { error: { code: 'E12', message: `Unexpected path "${path}"` } };
    const ok = (value) => ({ path, value });
    let m;
    if (path === 'Subscriptions') { if (cmd.op === 'replace') this.subs = cmd.value; return ok(this.subs || []); }
    if (cmd.op === 'get') {
      if (path === 'DeviceObject/system/$device/@items/1/@props/dev') return ok('NLC_RS6');
      if (path === 'DeviceObject/system/$device/@items/1/version/@props/updater') return ok('6.2.79');
      if ((m = /^DeviceObject\/preconfig\/resources\/new\/\$screen\/@items\/S(\d+)\/control\/@props\/mode$/.exec(path))) return ok(this.dests[`S${m[1]}`] ? 'FREESTYLE' : 'DISABLED');
      if ((m = /^DeviceObject\/\$(screen|auxiliary)\/@items\/([SA]\d+)\/control\/@props\/label$/.exec(path))) { const d = this.dests[m[2]]; return d ? ok(d.label) : E12; }
      if ((m = /^DeviceObject\/\$screenAuxGroup\/@items\/([SA]\d+)\/status\/@props\/transition$/.exec(path))) { const d = this.dests[m[1]]; return d ? ok(d.transition) : E12; }
      if ((m = /^DeviceObject\/presetBank\/status\/presetId\/\$(screen|auxiliary)\/@items\/([SA]\d+)\/\$preset\/@items\/([AB])\/@props\/id$/.exec(path))) { const d = this.dests[m[2]]; return d ? ok(d[m[3]].presetId) : E12; }
      return E12;
    }
    if ((m = /^DeviceObject\/presetBank\/control\/load\/\$slot\/@items\/(\d+)\/\$(screen|auxiliary)\/@items\/([SA]\d+)\/\$preset\/@items\/(PREVIEW|PROGRAM)\/@props\/xRequest$/.exec(path))) {
      if (!this.dests[m[3]]) return E12; this.loadMemory(m[3], +m[1], m[4] === 'PROGRAM' ? 'program' : 'preview'); return null;
    }
    if ((m = /^DeviceObject\/\$screenAuxGroup\/@items\/([SA]\d+)\/control\/@props\/xTake$/.exec(path))) { if (!this.take(m[1])) return E12; return null; }
    return E12;
  }

  async stop() {
    for (const s of this._socks || []) s.destroy();
    for (const s of [this.restServer, this.awjServer]) if (s) { s.closeAllConnections && s.closeAllConnections(); await new Promise((r) => s.close(r)); }
  }
}

module.exports = { MockAquilon, memoryContent };
