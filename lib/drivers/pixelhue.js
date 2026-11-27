'use strict';
// PixelHue P10 / P20 / P80 / Q8 driver over the official PixelHue HTTP API ("API User Guide" V2.0.1, 2025-10-14,
// published at https://api.pixelhue.com, OpenAPI 3.0 per endpoint). Section numbers below are from that guide.
//   §3.1  every call: http://<ip>:8088/pixelhue/<protocol url>, header Authorization: <token>
//         token = HS256 JWT signed with the node's startTime, claim SN = node serial, from
//         GET /v1/node/open-detail?nodeId=1 (no token needed). Expiry 2 min in the guide's example, so a fresh
//         token is minted for every request.
//   §4.2.1 GET  /v1/screen/list-detail          screens; screenIdObj.type 2 = common screen, 4 = AUX
//         freeze 0/1, select 0/1, presetPoll {enable, presetGroupId} are fields on that read
//   §4.2.2 PUT  /v1/screen/freeze [{screenId, screenGuid, freeze 0|1}]
//   §4.2.4 PUT  /v1/screen/cut    [{screenId, direction, swapEnable}]
//   §4.2.5 PUT  /v1/screen/take   [{screenId, direction 0 = PVW->PGM, effectSelect, swapEnable, switchEffect}]
//   §5.1   GET  /v1/layers/list-detail         layers; type 4 = AUX, sceneType 2 = PGM, 4 = PVW
//         source.general.sourceType 2 = input, 5 = BKG still; source.primary is the input saved after a failover
//   §5.4   PUT  /v1/layers/source  [{layerId, source:{general:{sourceId, sourceType, relationId}}}]
//   §6.2.1 GET  /v1/preset                       presets (guid, serial, name, ...)
//   §6.2.3 POST /v1/preset/apply  {presetId: guid, serial, targetRegion: 4 PVW | 2 PGM | 0 auto}
//   §7.1   GET  /v1/picture/list                gallery; pictureObj.type 1 = BKG. No capture or delete write is published.
//          GET  /v1/interface/list-detail        inputs (interface module)
// Responses are {code: 0 (success) | non-0, message, data}.
// The V2 guide removed the screen-selection write: TAKE / CUT name their screens in the request body. select()
// records the app's armed destinations and does not transmit. The guide also has no preset-playlist transport
// write (presetPoll is a read) and no gallery capture or delete, so those stay refused.
const crypto = require('crypto');
const { httpJson, destKey, parseKey } = require('./common');

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
    this.capabilities = { presets: true, recallPreview: true, recallProgram: true, take: true, cut: true, destinations: true, armDestinations: true,
      sources: true, freeze: true, auxRoute: true, stills: true, cues: false, backups: true, destFilteredRecall: false };
    this.configure(conn);
    this.st = { connected: false, info: null, error: null, lastSeen: 0 };
    this.node = null; this.screens = new Map(); this.armed = [];
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
  // V2.0.0 removed the device screen-selection write. The app still calls select() when armDestinations is set;
  // the armed keys stay here and TAKE / CUT keep naming their screens. Nothing is sent.
  async select(keys) {
    this.armed = [...new Set((keys || []).map((k) => String(k).toUpperCase()))];
    return this.armed;
  }
  _bodyFor(keys) {
    return keys.map((k) => this.screens.get(k)).filter(Boolean);
  }
  async take(keys, { time } = {}) {
    const scr = this._bodyFor(keys || []); if (!scr.length) throw new Error('PixelHue TAKE: no screens selected');
    const custom = time !== undefined && time !== null && time !== '';
    return this.req('PUT', '/v1/screen/take', scr.map((s) => ({ screenId: s.screenId, screenGuid: s.guid, direction: 0, effectSelect: custom ? 1 : 0, swapEnable: this.conn.swap ? 1 : 0, ...(custom ? { switchEffect: { type: 1, time: Number(time) } } : {}) }))); // §4.2.5
  }
  async cut(keys) {
    const scr = this._bodyFor(keys || []); if (!scr.length) throw new Error('PixelHue CUT: no screens selected');
    return this.req('PUT', '/v1/screen/cut', scr.map((s) => ({ screenId: s.screenId, direction: 0, swapEnable: this.conn.swap ? 1 : 0 }))); // §4.2.4
  }
  async listSources() {
    if (!this.screens.size) await this.listDestinations();
    const [d, layers] = await Promise.all([this.req('GET', '/v1/interface/list-detail'), this._layers()]);
    const frozenScreens = new Set(this._screenList().filter((s) => Number(s.freeze) === 1).map((s) => s.screenId));
    const shown = new Map();
    for (const layer of layers) {
      const src = layer.source && layer.source.general;
      const obj = layer.layerIdObj || {};
      if (!src || Number(src.sourceType) !== 2 || Number(obj.sceneType) !== 2) continue;
      const id = Number(src.sourceId);
      const rec = shown.get(id) || { n: 0, frozen: 0 };
      rec.n += 1;
      if (frozenScreens.has(obj.attachScreenId)) rec.frozen += 1;
      shown.set(id, rec);
    }
    return ((d && d.list) || []).map((x) => {
      const rec = shown.get(Number(x.interfaceId));
      return { key: `if:${x.interfaceId}`, id: x.interfaceId, name: (x.general && x.general.name) || `Input ${x.interfaceId}`, kind: 'input',
        status: x.state === undefined ? '' : x.state ? 'ok' : 'no signal', frozen: !!(rec && rec.n && rec.frozen === rec.n), type: x.auxiliaryInfo && x.auxiliaryInfo.connectorInfo ? x.auxiliaryInfo.connectorInfo.interfaceType : null };
    });
  }

  _screenList() {
    const out = [];
    for (const [k, v] of this.screens) if (v && typeof v === 'object' && !String(k).startsWith('id:')) out.push(v);
    return out;
  }
  _screenByKey(key) {
    const v = this.screens.get(String(key || '').toUpperCase());
    return v && typeof v === 'object' ? v : null;
  }
  async _layers() {
    const d = await this.req('GET', '/v1/layers/list-detail'); // §5.1
    return (d && d.list) || [];
  }
  async _pictures() {
    const d = await this.req('GET', '/v1/picture/list'); // §7.1
    return (d && d.list) || [];
  }
  _confirmed(opts) { return !!(opts && opts.confirm === true); }

  // ---------- freeze (PUT /v1/screen/freeze, §4.2.2) ----------
  // kind screen|aux addresses a destination (S1 / A1 or the device screenId). kind input freezes every program
  // screen whose program layer is showing that input. There is no input-freeze write in the guide.
  async freeze(kind, id, on) {
    if (!this.screens.size) await this.listDestinations();
    let screens;
    if (kind === 'input') {
      const layers = await this._layers();
      const ids = new Set();
      for (const layer of layers) {
        const src = layer.source && layer.source.general;
        const obj = layer.layerIdObj || {};
        if (!src || Number(src.sourceType) !== 2 || Number(src.sourceId) !== Number(id) || Number(obj.sceneType) !== 2) continue;
        ids.add(obj.attachScreenId);
      }
      screens = this._screenList().filter((s) => ids.has(s.screenId));
      if (!screens.length) throw new Error(`PixelHue freeze: no program screen is showing input ${id}`);
    } else if (kind === 'screen' || kind === 'aux') {
      const want = kind === 'aux' ? 4 : 2;
      const byKey = this._screenByKey(id);
      if (byKey) {
        if (!byKey.screenIdObj || byKey.screenIdObj.type !== want) throw new Error(`PixelHue freeze: ${id} is not a ${kind}`);
        screens = [byKey];
      } else {
        screens = this._screenList().filter((s) => s.screenId === Number(id) && s.screenIdObj && s.screenIdObj.type === want);
        if (!screens.length) throw new Error(`PixelHue freeze: no ${kind} ${id}`);
      }
    } else throw new Error(`PixelHue freeze: unknown kind ${kind}`);
    const freeze = on ? 1 : 0;
    const data = await this.req('PUT', '/v1/screen/freeze', screens.map((s) => ({ screenId: s.screenId, screenGuid: s.guid, freeze })));
    for (const s of screens) s.freeze = freeze;
    return data;
  }

  // ---------- aux routing (PUT /v1/layers/source, §5.4) ----------
  // An aux output is a type-4 screen (§4.2.1). Its picture is the type-4 layer on that screen, sceneType 4 = PVW, 2 = PGM.
  async routeAux(auxKey, sourceId, target = 'preview') {
    if (!this.screens.size) await this.listDestinations();
    const screen = this._screenByKey(auxKey);
    const parsed = parseKey(auxKey);
    if (!screen || !parsed || parsed.kind !== 'aux') throw new Error(`Not an aux destination: ${auxKey}`);
    const sceneType = target === 'program' ? 2 : 4;
    const layers = (await this._layers()).filter((layer) => {
      const obj = layer.layerIdObj || {};
      return Number(obj.type) === 4 && Number(obj.attachScreenId) === screen.screenId && Number(obj.sceneType) === sceneType;
    });
    if (!layers.length) throw new Error(`PixelHue aux: ${auxKey} has no ${target} layer`);
    const sourceIdNum = Number(sourceId);
    return this.req('PUT', '/v1/layers/source', layers.map((layer) => ({
      layerId: layer.layerId,
      source: { general: { sourceId: sourceIdNum, sourceType: 2, relationId: 0 } },
    })));
  }

  // ---------- stills (GET /v1/picture/list §7.1, recall via §5.4 sourceType 5) ----------
  async listStills() {
    return (await this._pictures()).filter((p) => !p.pictureObj || Number(p.pictureObj.type) === 1 || Number(p.pictureObj.type) === 0).map((p) => {
      const g = p.general || {};
      const seq = p.pictureObj && p.pictureObj.id !== undefined ? p.pictureObj.id : p.pictureId;
      return { key: `still:${p.pictureId}`, id: seq, pictureId: p.pictureId, name: g.name || `Still ${p.pictureId}`, size: g.width ? `${g.width}×${g.height}` : '', state: p.isUsed, fileKB: g.size };
    });
  }
  async _picture(stillId) {
    const id = Number(stillId);
    return (await this._pictures()).find((p) => p.pictureId === id || (p.pictureObj && p.pictureObj.id === id)) || null;
  }
  // Recall puts the BKG on the destination's preview (or program) layers. Program is live, so it needs confirm.
  async recallStill(stillId, { dest, target = 'preview', confirm } = {}) {
    if (target === 'program' && !this._confirmed({ confirm })) throw new Error('PixelHue still recall to program needs confirm: true');
    const pic = await this._picture(stillId);
    if (!pic) throw new Error(`PixelHue: no still ${stillId}`);
    if (!this.screens.size) await this.listDestinations();
    const keys = dest ? (Array.isArray(dest) ? dest : [dest]) : (this.armed.length ? this.armed : this._screenList().filter((s) => s.screenIdObj && s.screenIdObj.type === 2).slice(0, 1).map((s) => this.screens.get(`id:${s.screenId}`)));
    const sceneType = target === 'program' ? 2 : 4;
    const want = new Set();
    for (const key of keys) {
      const screen = this._screenByKey(key);
      if (screen) want.add(screen.screenId);
    }
    if (!want.size) throw new Error('PixelHue still recall: no destination');
    const layers = (await this._layers()).filter((layer) => {
      const obj = layer.layerIdObj || {};
      return want.has(obj.attachScreenId) && Number(obj.sceneType) === sceneType && (Number(obj.type) === 2 || Number(obj.type) === 16);
    });
    if (!layers.length) throw new Error('PixelHue still recall: no layer on that destination');
    return this.req('PUT', '/v1/layers/source', layers.map((layer) => ({
      layerId: layer.layerId,
      source: { general: { sourceId: pic.pictureId, sourceType: 5, relationId: 0 } },
    })));
  }
  // Capture and delete are not published (guide §7 is the list read). Overwriting a filled slot is refused
  // unless confirm is set, and even then no capture request is sent.
  async takeStill(inputId, file, opts = {}) {
    const slot = Number(file);
    const stills = await this.listStills();
    if (stills.some((s) => s.id === slot) && !this._confirmed(opts)) throw new Error('PixelHue still overwrite needs confirm: true');
    throw new Error('PixelHue gallery capture is not in the published OpenAPI (V2.0.1 §7 Gallery is GET /v1/picture/list only)');
  }
  async deleteStill(id, opts = {}) {
    if (!this._confirmed(opts)) throw new Error('PixelHue still delete needs confirm: true');
    throw new Error('PixelHue gallery delete is not in the published OpenAPI (V2.0.1 §7 Gallery is GET /v1/picture/list only)');
  }

  // ---------- input backup (layer source.primary vs the source on air, §5.1 / §5.4) ----------
  // The guide publishes the primary saved after a failover, not a list of configured backup inputs and not a
  // project-file restore. Restoring the primary is the destructive half and needs confirm: true.
  async listBackups() {
    const [layers, inputs] = await Promise.all([this._layers(), this.req('GET', '/v1/interface/list-detail').then((d) => (d && d.list) || [])]);
    const names = new Map(inputs.map((x) => [Number(x.interfaceId), (x.general && x.general.name) || `Input ${x.interfaceId}`]));
    const rows = new Map();
    for (const layer of layers) {
      const src = layer.source || {};
      const primary = src.primary;
      const general = src.general || {};
      if (!primary || primary.sourceId === undefined || Number(primary.sourceType) !== 2) continue;
      const id = Number(primary.sourceId);
      const row = rows.get(id) || { key: `bk:${id}`, id, name: names.get(id) || `Input ${id}`, active: -1, backups: [], primary: { sourceId: id, sourceType: 2 } };
      const live = Number(general.sourceId);
      if (Number(general.sourceType) === 2 && live !== id) {
        row.active = 0;
        if (!row.backups.some((b) => b.inputId === live)) row.backups.push({ id: row.backups.length, inputId: live, name: names.get(live) || general.sourceName || `Input ${live}` });
      }
      rows.set(id, row);
    }
    return [...rows.values()];
  }
  async _writeInputSource(inputId, source) {
    const id = Number(inputId);
    const layers = (await this._layers()).filter((layer) => {
      const primary = layer.source && layer.source.primary;
      const general = (layer.source && layer.source.general) || {};
      return (primary && Number(primary.sourceId) === id) || Number(general.sourceId) === id;
    });
    if (!layers.length) throw new Error(`PixelHue: input ${inputId} is not on a layer`);
    return this.req('PUT', '/v1/layers/source', layers.map((layer) => ({
      layerId: layer.layerId,
      source: { general: { sourceId: Number(source.sourceId), sourceType: Number(source.sourceType) || 2, relationId: 0 } },
    })));
  }
  async selectBackup(inputId, slot, opts = {}) {
    const row = (await this.listBackups()).find((x) => x.id === Number(inputId));
    if (!row) throw new Error(`PixelHue: input ${inputId} has no backup state`);
    if (Number(slot) < 0) {
      if (!this._confirmed(opts)) throw new Error('PixelHue backup restore needs confirm: true');
      return this._writeInputSource(row.id, row.primary);
    }
    const b = row.backups.find((x) => x.id === Number(slot));
    if (!b) throw new Error(`PixelHue: input ${inputId} has no backup slot ${slot}`);
    return this._writeInputSource(row.id, { sourceId: b.inputId, sourceType: 2 });
  }

  // ---------- preset playlists (read of screen.presetPoll, §4.2.1). No play / pause / stop write is published. ----------
  async listCues() {
    if (!this.screens.size) await this.listDestinations();
    const groups = new Map();
    for (const s of this._screenList()) {
      const poll = s.presetPoll;
      if (!poll || !Number(poll.presetGroupId)) continue;
      const id = Number(poll.presetGroupId);
      const row = groups.get(id) || { key: `cue:${id}`, id, name: poll.name || `Playlist ${id}`, number: id, enable: 0, screens: [] };
      const key = this.screens.get(`id:${s.screenId}`);
      if (key) row.screens.push(key);
      if (Number(poll.enable) === 1) row.enable = 1;
      groups.set(id, row);
    }
    return [...groups.values()];
  }
  async activateCue() {
    const e = new Error('PixelHue preset playlist has no play, pause, or stop write in the published OpenAPI (V2.0.1). presetPoll on GET /v1/screen/list-detail is read-only.');
    e.status = 409;
    throw e;
  }
}

module.exports = { PixelHueDriver, makeToken, verifyToken };
