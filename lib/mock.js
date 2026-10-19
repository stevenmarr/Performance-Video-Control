'use strict';
// Mock Aquilon RS6. One flat {path -> value} store backs both protocols:
//  - AWJ (TCP, 0x04 framing): get / replace, the Subscriptions list (prefix match, §1.4 p.4-5) and
//    push notifications to every subscribed client when any value changes, whoever changed it.
//  - REST: the documented endpoints the app uses, derived from the same store.
// `mock.external` simulates someone else (RC400T / Web RCS) driving the device.
// It is a test double, not an emulator: the real device's notification format, timing and
// edge cases are unverified.
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { P, awjToRest, restToAwj } = require('./paths');

const SCREENS = { 1: 'Center LED', 2: 'Left IMAG', 3: 'Right IMAG', 4: 'Stage Floor' };
const AUXES = { 1: 'Confidence', 2: 'Record' };
const LAYERS = { screen: 4, aux: 2 };
const INPUTS = { 1: 'Cam 1 Wide', 2: 'Cam 2 Tight', 3: 'Cam 3 Jib', 4: 'PPT Main', 5: 'PPT Backup', 6: 'Playback', 7: 'Walk-in Loop', 8: 'Spare', 9: 'PPT Main Bkp', 10: 'Zoom', 11: 'Graphics', 12: 'Clock' };
const AUDIO = { inputs: 4, outputs: 4, channels: 8 };
const BG_SETS = 8; const GROUPS = 4;
// Sample banks. Slot 3 is deliberately unnamed and invalid (tests rely on it). Screen 60/61 and Master 7
// are valid but unnamed: only the INFERRED isValid probe (settings.memoryProbe) reveals them.
const SCREEN_MEM_LABELS = {
  1: 'Walk-in L', 2: 'Walk-in R', 10: 'Keynote', 11: 'IMAG L', 12: 'IMAG R', 13: 'IMAG Wide', 20: 'Panel C', 21: 'Panel LR', 22: 'Panel Floor', 23: 'Panel Conf',
  30: 'Floor Logo', 31: 'Sponsor C', 32: 'Sponsor L', 33: 'Sponsor R', 40: 'Conf PPT', 41: 'Record Clean', 42: 'Conf Clock', 43: 'Record PGM',
  50: 'Awards C', 51: 'Awards LR', 52: 'Awards Floor', 53: 'Awards Logo',
};
const SCREEN_MEM_UNNAMED_VALID = [60, 61];
const MASTER_LABELS = { 1: 'Show Open', 2: 'Keynote', 3: 'Panel', 4: 'Break', 5: 'Awards' };
const MASTER_UNNAMED_VALID = [7];
const MV_OUTPUTS = { 1: 'MVW1', 2: 'MVW2' }; // an RS6 has two Multiviewer outputs
const MV_MEM_LABELS = { 1: 'Show MV', 2: 'Rehearsal MV', 3: 'Tech Full', 10: 'Record Check' };

// Deterministic content for Screen memory `id` (layer -> AWJ source string)
function memoryContent(id, kind) {
  const L = { 1: `LIVE_${((id - 1) % 12) + 1}`, 2: `STILL_${((id - 1) % 8) + 1}` };
  if (kind === 'screen') { L[3] = id % 2 ? `LIVE_${((id + 3) % 12) + 1}` : 'NONE'; L[4] = 'NONE'; }
  L.NATIVE = kind === 'screen' ? `NATIVE_${((id - 1) % 8) + 1}` : 'NONE';
  return L;
}
// Master memory `id` = Screen memory (id*10 + screen index) on S1..S3
const masterContent = (id) => ({ S1: id * 10 + 1, S2: id * 10 + 2, S3: id * 10 + 3 });

class MockAquilon {
  constructor({ password = '' } = {}) {
    this.password = password; this.tokens = new Set(); this.history = [];
    this.v = new Map(); this.clients = new Set();
    this.destKeys = [...Object.keys(SCREENS).map((n) => `S${n}`), ...Object.keys(AUXES).map((n) => `A${n}`)];
    this.subscriptionsSupported = true; // tests can set false to force the polling fallback
    this._init();
    const self = this;
    this.external = {
      loadMemory: (key, id, target = 'preview') => self.loadMemory(key, id, target),
      loadMaster: (id, target = 'preview') => self.loadMaster(id, target),
      take: (key) => self.take(key),
      setSource: (key, target, layer, src) => self.set(P.layerSource(key, self.sideOf(key, target), layer), src),
      setInputLabel: (n, label) => self.set(P.input.label(n), label),
      setMemoryLabel: (n, label) => self.set(P.screenMemoryLabel(n), label),
      setMasterLabel: (n, label) => self.set(P.masterLabel(n), label),
      saveScreenMemory: (n, label) => { self.set(P.screenMemoryValid(n), true); self.set(P.screenMemoryLabel(n), label || ''); },
      deleteScreenMemory: (n) => { self.set(P.screenMemoryValid(n), false); self.set(P.screenMemoryLabel(n), ''); },
      setFreeze: (n, v) => self.set(P.input.freeze(n), !!v),
      setAvailable: (n, v) => self.set(P.input.isAvailable(n), !!v),
      setMute: (dir, i, c, v) => self.set(dir === 'in' ? P.audioInMute(i, c) : P.audioOutMute(i, c), !!v),
    };
  }

  _init() {
    const s = (p, v) => this.v.set(p, v);
    s(P.deviceType(), 'NLC_RS6'); s(P.firmware(), '6.2.79');
    for (let n = 1; n <= 24; n++) s(P.screenMode(`S${n}`), SCREENS[n] ? 'FREESTYLE' : 'DISABLED');
    for (const key of this.destKeys) {
      const kind = key[0] === 'S' ? 'screen' : 'aux';
      s(P.destLabel(key), kind === 'screen' ? SCREENS[key.slice(1)] : AUXES[key.slice(1)]);
      s(P.transition(key), 'AT_DOWN');
      for (const side of ['A', 'B']) {
        for (let l = 1; l <= LAYERS[kind]; l++) s(P.layerSource(key, side, l), 'NONE');
        s(P.layerSource(key, side, 'NATIVE'), 'NONE');
        s(P.lastScreenMemory(key, side), 0);
      }
      if (kind === 'screen') for (let l = 1; l <= 8; l++) s(P.layerCapability(key, l), l <= LAYERS.screen ? 'DUAL' : 'OFF');
    }
    for (let n = 1; n <= 1000; n++) s(P.screenMemoryLabel(n), SCREEN_MEM_LABELS[n] || '');
    for (let n = 1; n <= 500; n++) s(P.masterLabel(n), MASTER_LABELS[n] || '');
    // INFERRED paths (not in the AWJ guide); served so the memoryProbe option can be tested
    for (let n = 1; n <= 1000; n++) s(P.screenMemoryValid(n), !!SCREEN_MEM_LABELS[n] || SCREEN_MEM_UNNAMED_VALID.includes(n));
    for (let n = 1; n <= 500; n++) s(P.masterMemoryValid(n), !!MASTER_LABELS[n] || MASTER_UNNAMED_VALID.includes(n));
    for (let n = 1; n <= 50; n++) { s(P.mvMemoryLabel(n), MV_MEM_LABELS[n] || ''); s(P.mvMemoryValid(n), !!MV_MEM_LABELS[n]); }
    for (let n = 1; n <= 8; n++) { s(P.mvEnabled(n), !!MV_OUTPUTS[n]); s(P.mvLabel(n), MV_OUTPUTS[n] || ''); } // §4.1
    this.mv = {}; // mock-only record of the last Multiviewer memory per output (no documented readback)
    s(P.lastMasterMemory('program'), 0); s(P.lastMasterMemory('preview'), 0);
    for (let n = 1; n <= 32; n++) {
      const exists = !!INPUTS[n];
      s(P.input.label(n), INPUTS[n] || '');
      s(P.input.isEnabled(n), exists && n !== 8);
      s(P.input.isAvailable(n), exists && n !== 6);
      s(P.input.capability(n), exists ? (n <= 3 ? '4K' : 'DUAL') : 'OFF');
      s(P.input.freeze(n), false);
      s(P.input.device(n), '1');
      s(P.input.scope(n), 'GLOBAL');
      s(P.inputBackupSource(n, 1), n === 4 ? 'LIVE_9' : 'NONE');
      s(P.inputBackupSource(n, 2), n === 4 ? 'STILL_1' : 'NONE');
      s(P.inputBackupSelect(n), 'NONE');
      s(P.inputBackupAuto(n), false);
    }
    for (const key of this.destKeys.filter((k) => k[0] === 'S')) {
      for (let b = 1; b <= BG_SETS; b++) {
        s(P.bgBackupSource(key, b, 1), key === 'S1' && b === 1 ? 'NATIVE_2' : 'NONE');
        s(P.bgBackupSource(key, b, 2), 'NONE');
        s(P.bgBackupSelect(key, b), 'NONE'); s(P.bgBackupAuto(key, b), false);
      }
    }
    for (let g = 1; g <= GROUPS; g++) { s(P.groupBackupSelect(g), 'NONE'); s(P.groupBackupAuto(g), false); }
    for (let i = 1; i <= AUDIO.inputs; i++) for (let c = 1; c <= AUDIO.channels; c++) s(P.audioInMute(i, c), false);
    for (let o = 1; o <= AUDIO.outputs; o++) for (let c = 1; c <= AUDIO.channels; c++) s(P.audioOutMute(o, c), false);
  }

  // ---------- store ----------
  get(path) { return this.v.get(path); }
  set(path, value) {
    if (this.v.get(path) === value) return false;
    this.v.set(path, value);
    for (const c of this.clients) {
      if (c.subs.some((p) => path.startsWith(p))) c.send({ path, value });
    }
    return true;
  }
  record(proto, op, detail) { this.history.push({ t: Date.now(), proto, op, ...detail }); }
  kindOf(key) { return key[0] === 'S' ? 'screen' : 'aux'; }
  pgmSide(key) { return this.get(P.transition(key)) === 'AT_UP' ? 'B' : 'A'; }
  sideOf(key, target) { const pg = this.pgmSide(key); return target === 'program' ? pg : (pg === 'A' ? 'B' : 'A'); }
  layersOf(key) { return [...Array(LAYERS[this.kindOf(key)]).keys()].map((i) => i + 1); }

  // Compatibility view used by tests: side(key,'program'|'preview') -> {presetId, layers:{n:{sourceType,sourceId}}, background}
  side(key, target) {
    const sd = this.sideOf(key, target);
    const layers = {};
    for (const l of this.layersOf(key)) layers[l] = awjToRest(this.get(P.layerSource(key, sd, l)));
    return { presetId: this.get(P.lastScreenMemory(key, sd)), layers, background: awjToRest(this.get(P.layerSource(key, sd, 'NATIVE'))) };
  }
  get dests() {
    const out = {};
    for (const k of this.destKeys) out[k] = { transition: this.get(P.transition(k)), A: { presetId: this.get(P.lastScreenMemory(k, 'A')) }, B: { presetId: this.get(P.lastScreenMemory(k, 'B')) } };
    return out;
  }

  // ---------- behaviour ----------
  loadMemory(key, memoryId, target) {
    if (!this.destKeys.includes(key)) return false;
    const sd = this.sideOf(key, target); const c = memoryContent(memoryId, this.kindOf(key));
    for (const [l, src] of Object.entries(c)) if (l === 'NATIVE' || this.layersOf(key).includes(+l)) this.set(P.layerSource(key, sd, l), src);
    this.set(P.lastScreenMemory(key, sd), memoryId);
    this.record('state', 'load', { dest: key, memoryId, target });
    return true;
  }

  loadMaster(id, target) {
    for (const [key, mem] of Object.entries(masterContent(id))) this.loadMemory(key, mem, target);
    this.set(P.lastMasterMemory(target), id);
    return true;
  }

  loadMv(out, slot) {
    if (!MV_OUTPUTS[out] || !(slot >= 1 && slot <= 50)) return false;
    this.mv[out] = slot; this.record('state', 'loadMv', { output: out, memoryId: slot });
    return true;
  }

  take(key) {
    if (!this.destKeys.includes(key)) return false;
    const t = this.get(P.transition(key)) === 'AT_DOWN' ? 'AT_UP' : 'AT_DOWN';
    this.set(P.transition(key), t);
    // "Preset Toggle" disabled (User Manual 14.1.9): PRW keeps the content now on PGM.
    const pg = this.pgmSide(key); const pv = pg === 'A' ? 'B' : 'A';
    for (const l of [...this.layersOf(key), 'NATIVE']) this.set(P.layerSource(key, pv, l), this.get(P.layerSource(key, pg, l)));
    this.set(P.lastScreenMemory(key, pv), this.get(P.lastScreenMemory(key, pg)));
    // Mock assumption (not documented): a TAKE carries the Preview Master memory id to Program (§3.12 readback).
    const pm = this.get(P.lastMasterMemory('preview')); if (pm) this.set(P.lastMasterMemory('program'), pm);
    this.record('state', 'take', { dest: key });
    return true;
  }

  // ---------- REST ----------
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
      if (!url.pathname.startsWith('/api/tpp/v1')) return send(404, { error: 'not found' });
      const p = url.pathname.replace(/^\/api\/tpp\/v1/, '');
      const key = (t, n) => (t === 'screens' ? 'S' : 'A') + Number(n);
      const has = (k) => this.destKeys.includes(k);
      let m;
      if (req.method === 'GET' && p === '/system') return send(200, { type: 'AQL RS6', label: 'MOCK-RS6', isLinked: false, linkName: '', version: { major: 6, minor: 2, patch: 79, beta: false } });
      if (req.method === 'GET' && (m = /^\/(screens|auxiliary-screens)\/(\d+)$/.exec(p))) {
        const n = +m[2]; if (n < 1 || n > (m[1] === 'screens' ? 24 : 96)) return send(404, { error: 'index out of range' });
        const k = key(m[1], n); return send(200, { isEnabled: has(k), label: has(k) ? this.get(P.destLabel(k)) : '' });
      }
      if (req.method === 'POST' && (m = /^\/(screens|auxiliary-screens)\/(\d+)\/load-memory$/.exec(p))) {
        const k = key(m[1], m[2]); const id = Number(body.memoryId); const target = body.target || 'preview';
        if (!has(k)) return send(404, { error: 'unknown destination' });
        if (!(id >= 1 && id <= 1000) || !['preview', 'program'].includes(target)) return send(400, { error: 'bad parameters' });
        this.loadMemory(k, id, target); return send(204);
      }
      if (req.method === 'GET' && (m = /^\/multiviewers\/(\d+)$/.exec(p))) { // REST §5.1
        const n = +m[1]; if (n < 1 || n > 8) return send(404, { error: 'index out of range' });
        return send(200, { isEnabled: !!MV_OUTPUTS[n], isDuplication: false, label: MV_OUTPUTS[n] || '' });
      }
      if (req.method === 'POST' && (m = /^\/multiviewers\/(\d+)\/load-memory$/.exec(p))) { // REST §5.2
        return this.loadMv(+m[1], Number(body.memoryId)) ? send(204) : send(400, { error: 'bad parameters' });
      }
      if (req.method === 'POST' && p === '/load-master-memory') { this.loadMaster(Number(body.memoryId), body.target || 'preview'); return send(204); }
      if (req.method === 'POST' && p === '/take') {
        const a = body.auxiliaryScreenIds || body['auxiliaryScreenIds '] || [];
        for (const n of body.screenIds || []) this.take(`S${n}`); for (const n of a) this.take(`A${n}`);
        return send(204);
      }
      if (req.method === 'POST' && (m = /^\/(screens|auxiliary-screens)\/(\d+)\/take$/.exec(p))) { if (!this.take(key(m[1], m[2]))) return send(404, { error: 'unknown destination' }); return send(204); }
      if ((m = /^\/(screens|auxiliary-screens)\/(\d+)\/layers\/(\d+)\/presets\/(preview|program)(\/source)?$/.exec(p))) {
        const k = key(m[1], m[2]); if (!has(k) || !this.layersOf(k).includes(+m[3])) return send(404, { error: 'layer not allocated' });
        const path = P.layerSource(k, this.sideOf(k, m[4]), +m[3]);
        const cur = awjToRest(this.get(path));
        const status = cur.sourceType === 'none' ? 'close' : 'open';
        if (req.method === 'GET' && (m[5] || m[1] === 'screens')) return send(200, m[1] === 'screens' && !m[5] ? { status, ...cur } : cur);
        if (req.method === 'POST' && m[5]) { this.set(path, restToAwj(body.sourceType, body.sourceId)); this.set(P.lastScreenMemory(k, this.sideOf(k, m[4])), 0); return send(204); }
      }
      if ((m = /^\/screens\/(\d+)\/background-layer\/presets\/(preview|program)(\/source)?$/.exec(p))) {
        const k = `S${m[1]}`; if (!has(k)) return send(404, { error: 'unknown screen' });
        const path = P.layerSource(k, this.sideOf(k, m[2]), 'NATIVE'); const cur = awjToRest(this.get(path));
        if (req.method === 'GET' && !m[3]) return send(200, { target: m[2], status: cur.sourceType === 'none' ? 'close' : 'open', ...cur });
        if (req.method === 'POST' && m[3]) { this.set(path, body.sourceType === 'none' ? 'NONE' : `NATIVE_${body.sourceId}`); return send(204); }
      }
      if (req.method === 'GET' && (m = /^\/inputs\/(\d+)$/.exec(p))) { // REST p.66
        const n = +m[1]; if (n < 1 || n > 32) return send(404, { error: 'input out of range' });
        return send(200, { isEnabled: this.get(P.input.isEnabled(n)), capacity: this.get(P.input.capability(n)) === 'OFF' ? 0 : 2, label: this.get(P.input.label(n)), isValid: this.get(P.input.isAvailable(n)), isFrozen: this.get(P.input.freeze(n)), isVisibleInSourceLists: true });
      }
      return send(404, { error: `not implemented in mock: ${req.method} ${url.pathname}` });
    });
  }

  // ---------- AWJ ----------
  async startAwj(port = 0, host = '127.0.0.1') {
    this.awjServer = net.createServer((sock) => {
      const client = { subs: [], send: (o) => { if (!sock.destroyed) sock.write(Buffer.concat([Buffer.from(JSON.stringify(o)), Buffer.from([0x04])])); } };
      this.clients.add(client); sock.setNoDelay(true);
      sock.on('close', () => this.clients.delete(client));
      sock.on('error', () => {});
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]); let i;
        while ((i = buf.indexOf(0x04)) >= 0) {
          const f = buf.subarray(0, i).toString('utf8'); buf = buf.subarray(i + 1);
          const reply = this._awj(f, client);
          if (reply) client.send(reply);
        }
      });
      client.sock = sock;
    });
    await new Promise((r) => this.awjServer.listen(port, host, r));
    return this.awjServer.address().port;
  }

  dropAwjClients() { for (const c of this.clients) c.sock.destroy(); }

  _awj(frame, client) {
    let cmd; try { cmd = JSON.parse(frame); } catch { return { error: { code: 'E09', message: 'Unexpected command JSON token' } }; }
    if (!['get', 'replace'].includes(cmd.op)) return { error: { code: 'E11', message: 'Unexpected operator' } };
    const path = String(cmd.path || ''); this.record('awj', cmd.op, { path, value: cmd.value });
    const E12 = { error: { code: 'E12', message: `Unexpected path "${path}"` } };
    const E13 = { error: { code: 'E13', message: 'Unexpected value' } };
    let m;
    if (path === 'Subscriptions') {
      if (!this.subscriptionsSupported) return E12;
      if (cmd.op === 'replace') { if (!Array.isArray(cmd.value)) return E13; client.subs = cmd.value.map(String); }
      return { path, value: client.subs };
    }
    if (cmd.op === 'get') return this.v.has(path) ? { path, value: this.v.get(path) } : E12;
    // ---- replace ----
    const v = cmd.value;
    if ((m = /^DeviceObject\/presetBank\/control\/load\/\$slot\/@items\/(\d+)\/\$(screen|auxiliary)\/@items\/([SA]\d+)\/\$preset\/@items\/(PREVIEW|PROGRAM)\/@props\/xRequest$/.exec(path))) {
      return this.loadMemory(m[3], +m[1], m[4] === 'PROGRAM' ? 'program' : 'preview') ? null : E12;
    }
    if ((m = /^DeviceObject\/masterPresetBank\/control\/load\/\$slot\/@items\/(\d+)\/\$preset\/@items\/(PREVIEW|PROGRAM)\/@props\/xRequest$/.exec(path))) { this.loadMaster(+m[1], m[2] === 'PROGRAM' ? 'program' : 'preview'); return null; }
    if ((m = /^DeviceObject\/\$screenAuxGroup\/@items\/([SA]\d+)\/control\/@props\/xTake$/.exec(path))) return this.take(m[1]) ? null : E12;
    if ((m = /^DeviceObject\/monitoringBank\/control\/load\/\$slot\/@items\/(\d+)\/\$output\/@items\/(\d+)\/@props\/xRequest$/.exec(path))) return this.loadMv(+m[2], +m[1]) ? null : E12; // §4.2
    if (path === P.globalUpdate()) return null;
    if (!this.v.has(path)) return E12;
    if (/\/source\/@props\/inputNum$/.test(path)) { if (!/^(LIVE|STILL|SCREEN|NATIVE)_\d+$|^(COLOR|NONE)$/.test(v)) return E13; this.set(path, v); return null; }
    if (/\/control\/@props\/(freeze|mute|enableAutoSelect)$/.test(path)) {
      if (typeof v !== 'boolean') return E13;
      this.set(path, v);
      return /enableAutoSelect$/.test(path) ? { path, value: v } : null; // §6.6/6.9/6.11 show an echo
    }
    if (/\/control\/@props\/xSelectSlot$/.test(path)) {
      if (!['NONE', '1', '2'].includes(String(v))) return E13;
      this.set(path, String(v)); return { path, value: String(v) }; // §6.5/6.8/6.10 show an echo
    }
    return E12;
  }

  async stop() {
    for (const c of this.clients) c.sock.destroy();
    for (const s of [this.restServer, this.awjServer]) if (s) { s.closeAllConnections && s.closeAllConnections(); await new Promise((r) => s.close(r)); }
  }
}

module.exports = { MockAquilon, memoryContent, masterContent, INPUTS, SCREEN_MEM_LABELS, MASTER_LABELS, MV_MEM_LABELS };
