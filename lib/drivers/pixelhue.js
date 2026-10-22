'use strict';
// PixelHue P10 / P20 / P80 / Q8 driver over the official PixelHue HTTP API ("API User Guide" V2.0.1, 2025-10-14,
// published at https://api.pixelhue.com, OpenAPI 3.0 per endpoint). Section numbers below are from that guide.
//   §3.1  every call: http://<ip>:8088/pixelhue/<protocol url>, header Authorization: <token>
//         token = HS256 JWT signed with the node's startTime, claim SN = node serial, from
//         GET /v1/node/open-detail?nodeId=1 (no token needed). Expiry 2 min in the guide's example, so a fresh
//         token is minted for every request.
//   §4.2.1 GET  /v1/screen/list-detail          screens; screenIdObj.type 2 = common screen, 4 = AUX
//   §4.2.3 PUT  /v1/screen/take   [{screenId, direction 0 = PVW->PGM, effectSelect, swapEnable, switchEffect}]
//   §4.2.4 PUT  /v1/screen/cut    [{screenId, direction, swapEnable}]
//   §6.2.1 GET  /v1/preset                       presets (guid, serial, name, ...)
//   §6.2.3 POST /v1/preset/apply  {presetId: guid, serial, targetRegion: 4 PVW | 2 PGM | 0 auto}
//          GET  /v1/interface/list-detail        inputs (interface module)
// Responses are {code: 0 (success) | non-0, message, data}.
// The V2 guide removed the "screen selection" logic: TAKE / CUT name their screens in the request body, so the
// app's own destination selection maps 1:1.
const crypto = require('crypto');
const { httpJson, destKey } = require('./common');

const b64u = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function makeToken(sn, secret, now = Math.floor(Date.now() / 1000)) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ SN: String(sn), exp: now + 120, iat: now, iss: 'gin-jwt-demo' }));
  const sig = b64u(crypto.createHmac('sha256', String(secret)).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}
function verifyToken(tok, secret) {
  const [h, b, s] = String(tok || '').split('.');
  if (!h || !b || !s) return null;
  const want = b64u(crypto.createHmac('sha256', String(secret)).update(`${h}.${b}`).digest());
  if (want !== s) return null;
  try { return JSON.parse(Buffer.from(b.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch { return null; }
}

class PixelHueDriver {
  constructor(conn = {}, log = () => {}) {
    this.system = 'pixelhue';
    this.log = log;
    this.capabilities = { presets: true, recallPreview: true, recallProgram: true, take: true, cut: true, destinations: true, armDestinations: false,
      sources: true, freeze: false, auxRoute: false, stills: false, cues: false, backups: false, destFilteredRecall: false };
    this.configure(conn);
    this.st = { connected: false, info: null, error: null, lastSeen: 0 };
    this.node = null; this.screens = new Map();
  }
  configure(conn) { this.conn = { host: '', port: 8088, prefix: '/pixelhue', swap: true, timeout: 4000, ...conn }; this.node = null; }
  close() { this.st.connected = false; }
  status() { return { ...this.st }; }
  _path(p) { const pre = String(this.conn.prefix || '').replace(/\/+$/, ''); return `${pre}${p}`; }

  async req(method, p, body) {
    if (!this.conn.host) throw new Error('PixelHue: no IP address set (System tab)');
    const auth = p.startsWith('/v1/node/open-detail') ? {} : { Authorization: makeToken(this.node.sn, this.node.startTime) };
    let r;
    try { r = await httpJson({ host: this.conn.host, port: Number(this.conn.port) || 8088, method, path: this._path(p), body, headers: auth, timeout: this.conn.timeout }); }
    catch (e) { this.st.connected = false; this.st.error = e.message; throw e; }
    this.st.lastSeen = Date.now();
    if (!r || typeof r !== 'object') throw new Error(`PixelHue ${method} ${p}: empty response`);
    if (Number(r.code) !== 0) throw new Error(`PixelHue ${method} ${p}: code ${r.code} ${r.message || ''}`.trim());
    return r.data;
  }

  async connect() {
    this.node = null;
    const d = await this.req('GET', '/v1/node/open-detail?nodeId=1'); // §3.1
    if (!d || !d.sn || d.startTime === undefined) throw new Error('PixelHue open-detail: no sn / startTime');
    this.node = { sn: String(d.sn), startTime: String(d.startTime) };
    const info = { model: d.modelName || d.model || 'PixelHue', sn: this.node.sn, version: d.version || d.firmwareVersion || '' };
    await this.listDestinations(); // proves the token works
    this.st = { connected: true, info, error: null, lastSeen: Date.now() };
    return info;
  }
  async heartbeat() {
    try { if (!this.node) await this.connect(); else await this.req('GET', '/v1/node/open-detail?nodeId=1'); this.st.connected = true; this.st.error = null; }
    catch (e) { this.st.connected = false; this.st.error = e.message; throw e; }
  }

  async listDestinations() {
    const d = await this.req('GET', '/v1/screen/list-detail'); // §4.2.1
    const list = (d && d.list) || [];
    const scr = list.filter((s) => s.screenIdObj && s.screenIdObj.type === 2).sort((a, b) => a.screenId - b.screenId);
    const aux = list.filter((s) => s.screenIdObj && s.screenIdObj.type === 4).sort((a, b) => a.screenId - b.screenId);
    this.screens = new Map(); const out = [];
    scr.forEach((s, i) => { const key = destKey('screen', i + 1); this.screens.set(key, s); this.screens.set(`id:${s.screenId}`, key); out.push({ key, kind: 'screen', id: s.screenId, guid: s.guid, label: (s.general && s.general.name) || `Screen ${i + 1}`, frozen: !!s.freeze }); });
    aux.forEach((s, i) => { const key = destKey('aux', i + 1); this.screens.set(key, s); this.screens.set(`id:${s.screenId}`, key); out.push({ key, kind: 'aux', id: s.screenId, guid: s.guid, label: (s.general && s.general.name) || `AUX ${i + 1}`, frozen: !!s.freeze }); });
    return out;
  }
  async listPresets() {
    if (!this.screens.size) await this.listDestinations();
    const d = await this.req('GET', '/v1/preset'); // §6.2.1
    return ((d && d.list) || []).map((p, i) => {
      const scr = Array.isArray(p.screens) ? p.screens : [];
      const dests = scr.length ? scr.map((s) => this.screens.get(`id:${s.screenId}`)).filter(Boolean) : null;
      const n = Number(p.serial);
      return { key: `ph:${p.guid || p.serial}`, id: p.guid, serial: p.serial, number: Number.isFinite(n) ? n : i + 1, name: p.name || (p.general && p.general.name) || `Preset ${p.serial}`, dests };
    });
  }
  async recall(preset, { target = 'preview' } = {}) {
    return this.req('POST', '/v1/preset/apply', { presetId: preset.id, serial: preset.serial, targetRegion: target === 'program' ? 2 : 4 }); // §6.2.3
  }
  async select() { /* V2 API: no screen selection on the device; TAKE / CUT name their screens */ }
  _bodyFor(keys) {
    return keys.map((k) => this.screens.get(k)).filter(Boolean);
  }
  async take(keys, { time } = {}) {
    const scr = this._bodyFor(keys || []); if (!scr.length) throw new Error('PixelHue TAKE: no screens selected');
    const custom = time !== undefined && time !== null && time !== '';
    return this.req('PUT', '/v1/screen/take', scr.map((s) => ({ screenId: s.screenId, screenGuid: s.guid, direction: 0, effectSelect: custom ? 1 : 0, swapEnable: this.conn.swap ? 1 : 0, ...(custom ? { switchEffect: { type: 1, time: Number(time) } } : {}) }))); // §4.2.3
  }
  async cut(keys) {
    const scr = this._bodyFor(keys || []); if (!scr.length) throw new Error('PixelHue CUT: no screens selected');
    return this.req('PUT', '/v1/screen/cut', scr.map((s) => ({ screenId: s.screenId, direction: 0, swapEnable: this.conn.swap ? 1 : 0 }))); // §4.2.4
  }
  async listSources() {
    const d = await this.req('GET', '/v1/interface/list-detail');
    return ((d && d.list) || []).map((x) => ({ key: `if:${x.interfaceId}`, id: x.interfaceId, name: (x.general && x.general.name) || `Input ${x.interfaceId}`, kind: 'input',
      status: x.state === undefined ? '' : x.state ? 'ok' : 'no signal', frozen: false, type: x.auxiliaryInfo && x.auxiliaryInfo.connectorInfo ? x.auxiliaryInfo.connectorInfo.interfaceType : null }));
  }
}

module.exports = { PixelHueDriver, makeToken, verifyToken };
