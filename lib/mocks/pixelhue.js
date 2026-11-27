'use strict';
// Mock PixelHue switcher (P20-style) for tests and --mock. Serves the official API paths under the /pixelhue
// prefix (API User Guide V2.0.1 §3.1) and checks the Authorization JWT exactly as described there: HS256 signed
// with the node's startTime, claim SN = the node serial. A test double, not an emulator; every call is recorded
// in `history`.
const http = require('http');
const { verifyToken } = require('../drivers/pixelhue');

const SN = 'MOCKP20000000001';
const START = '1718282915976';
const SCREENS = [[1, 'LED Wall', 2], [2, 'Left IMAG', 2], [3, 'Right IMAG', 2], [101, 'AUX Confidence', 4], [200, 'MVR', 8]];
const INPUTS = ['Cam 1', 'Cam 2', 'Cam 3', 'Laptop 1', 'Laptop 2', 'Playback', 'Media Server', 'Spare SDI'];
// [serial, name, screenIds]
const PRESETS = [[1, 'Opener', [1, 2, 3]], [2, 'Keynote', [1]], [3, 'IMAG Pair', [2, 3]], [4, 'Panel', [1, 2, 3, 101]], [5, 'Confidence PPT', [101]],
  [6, 'Video Roll', [1]], [7, 'Break', [1, 2, 3, 101]], [8, 'Awards', [1, 2, 3]], [10, 'Close', [1, 2, 3, 101]]];

class MockPixelHue {
  constructor({ prefix = '/pixelhue' } = {}) {
    this.prefix = prefix; this.history = []; this.server = null;
    this.screens = SCREENS.map(([screenId, name, type], i) => ({ screenId, guid: `scr-${screenId}-guid`, screenIdObj: { id: screenId, type }, general: { name }, select: 0, freeze: 0, enable: 1, ftb: { enable: 0, time: 500 }, ...(screenId === 1 ? { presetPoll: { enable: 0, presetGroupId: 2 } } : {}), pvw: null, pgm: null, order: i }));
    this.presets = PRESETS.map(([serial, name, ids]) => ({ guid: `preset-${serial}-guid`, serial, name, type: 3, loadType: 1, sourceRegion: 4, screens: ids.map((screenId) => ({ screenId })) }));
    this.inputs = INPUTS.map((name, i) => ({ interfaceId: i + 1, general: { name }, state: i === 7 ? 0 : 1, auxiliaryInfo: { connectorInfo: { interfaceType: i < 3 ? 1 : 2, type: 1, workMode: 0 } }, linkInfo: { isLink: 0 } }));
    // Program layers: screen 1 on Cam 1, screen 2 failed over to Spare SDI (primary stays Cam 2), screen 3 on Cam 3.
    // AUX Confidence has a PVW layer and a PGM layer. Preview layer on screen 1 is what a still recall lands on.
    const layer = (layerId, screenId, type, sceneType, sourceId, primaryId) => ({
      layerId,
      layerIdObj: { id: layerId, type, sceneType, attachScreenId: screenId, attachScreenType: 0, screenGuid: `scr-${screenId}-guid` },
      enable: 1, selected: 0,
      source: {
        general: { sourceId, sourceType: 2, sourceName: INPUTS[sourceId - 1] || '', connectorType: 9, connectCapacityNum: 0, relationId: 0 },
        primary: { sourceId: primaryId, sourceType: 2 },
        actual: { sourceId, sourceType: 2, sourceName: INPUTS[sourceId - 1] || '', connectorType: 9, connectCapacityNum: 0, relationId: 0 },
      },
    });
    this.layers = [layer(11, 1, 2, 2, 1, 1), layer(12, 1, 2, 4, 1, 1), layer(21, 2, 2, 2, 8, 2), layer(31, 3, 2, 2, 3, 3), layer(101, 101, 4, 4, 5, 5), layer(102, 101, 4, 2, 5, 5)];
    this.pictures = [
      { pictureId: 1, isUsed: 2, pictureObj: { id: 0, order: 0, type: 1 }, general: { name: 'Hold Logo', width: 1920, height: 1080, size: 480 }, path: [{ type: 0, url: '/picture/1/thumb.bmp', relativePath: '1/thumb.bmp' }], position: 0 },
      { pictureId: 2, isUsed: 1, pictureObj: { id: 1, order: 1, type: 1 }, general: { name: 'Sponsor', width: 1920, height: 1080, size: 510 }, path: [{ type: 0, url: '/picture/2/thumb.bmp', relativePath: '2/thumb.bmp' }], position: 1 },
    ];
  }
  _sourceName(sourceType, sourceId) {
    if (Number(sourceType) === 5) { const p = this.pictures.find((x) => x.pictureId === Number(sourceId)); return (p && p.general && p.general.name) || `Still ${sourceId}`; }
    return INPUTS[Number(sourceId) - 1] || `Input ${sourceId}`;
  }
  handle(method, p, q, body, auth) {
    const ok = (data = {}) => ({ code: 0, message: 'ok', data });
    if (method === 'GET' && p === '/v1/node/open-detail') return ok({ sn: SN, startTime: START });
    const claims = verifyToken(auth, START);
    if (!claims || claims.SN !== SN) return { status: 401, body: { code: 401, message: 'invalid token', data: {} } };
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) return { status: 401, body: { code: 401, message: 'token expired', data: {} } };
    if (method === 'GET' && p === '/v1/screen/list-detail') return ok({ list: this.screens.map(({ pvw, pgm, order, ...s }) => s), totalCount: this.screens.length });
    if (method === 'GET' && p === '/v1/preset') return ok({ list: this.presets, totalCount: this.presets.length });
    if (method === 'GET' && p === '/v1/interface/list-detail') return ok({ list: this.inputs, totalCount: this.inputs.length });
    if (method === 'GET' && p === '/v1/layers/list-detail') return ok({ list: this.layers, totalCount: this.layers.length });
    if (method === 'GET' && p === '/v1/picture/list') return ok({ list: this.pictures, totalCount: this.pictures.length, stateInfo: { import: 0 } });
    if (method === 'PUT' && p === '/v1/screen/freeze') {
      if (!Array.isArray(body) || !body.length) return { code: 1, message: 'body must be a non-empty array', data: {} };
      for (const b of body) {
        if (b.freeze === undefined || !b.screenGuid) return { code: 1, message: 'freeze and screenGuid are required', data: {} };
        const sc = this.screens.find((x) => x.guid === b.screenGuid);
        if (!sc || (b.screenId !== undefined && sc.screenId !== b.screenId)) return { code: 1, message: `no screen ${b.screenId || b.screenGuid}`, data: {} };
        sc.freeze = Number(b.freeze) ? 1 : 0;
      }
      return ok();
    }
    if (method === 'PUT' && p === '/v1/layers/source') {
      if (!Array.isArray(body) || !body.length) return { code: 1, message: 'body must be a non-empty array', data: {} };
      for (const b of body) {
        const layer = this.layers.find((x) => x.layerId === b.layerId);
        if (!layer) return { code: 1, message: `no layer ${b.layerId}`, data: {} };
        const g = b.source && b.source.general;
        if (!g || g.sourceId === undefined || g.sourceType === undefined || g.relationId === undefined) return { code: 1, message: 'source.general sourceId, sourceType and relationId are required', data: {} };
        const sourceName = this._sourceName(g.sourceType, g.sourceId);
        layer.source.general = { ...layer.source.general, sourceId: g.sourceId, sourceType: g.sourceType, relationId: g.relationId, sourceName };
        layer.source.actual = { ...layer.source.actual, sourceId: g.sourceId, sourceType: g.sourceType, relationId: g.relationId, sourceName };
      }
      return ok();
    }
    if (method === 'POST' && p === '/v1/preset/apply') {
      const pr = this.presets.find((x) => x.guid === body.presetId || x.serial === body.serial);
      if (!pr) return { code: 1, message: 'preset not found', data: {} };
      const where = Number(body.targetRegion) === 2 ? 'pgm' : 'pvw';
      for (const s of pr.screens) { const sc = this.screens.find((x) => x.screenId === s.screenId); if (sc) sc[where] = pr.serial; }
      return ok();
    }
    if (method === 'PUT' && (p === '/v1/screen/take' || p === '/v1/screen/cut')) {
      if (!Array.isArray(body) || !body.length) return { code: 1, message: 'body must be a non-empty array', data: {} };
      for (const b of body) {
        if (b.direction === undefined || b.swapEnable === undefined) return { code: 1, message: 'direction and swapEnable are required', data: {} };
        const sc = this.screens.find((x) => x.screenId === b.screenId); if (!sc) return { code: 1, message: `no screen ${b.screenId}`, data: {} };
        const old = sc.pgm; sc.pgm = sc.pvw; if (b.swapEnable) sc.pvw = old;
      }
      return ok();
    }
    return { status: 404, body: { code: 404, message: `no route ${method} ${p}`, data: {} } };
  }
  start(port = 0, host = '127.0.0.1') {
    this.server = http.createServer((req, res) => {
      let raw = ''; req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        const send = (code, j) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
        if (!u.pathname.startsWith(this.prefix + '/')) return send(404, { code: 404, message: 'unknown prefix', data: {} });
        const p = u.pathname.slice(this.prefix.length);
        let body = null; if (raw) { try { body = JSON.parse(raw); } catch { return send(400, { code: 400, message: 'bad json', data: {} }); } }
        this.history.push({ method: req.method, path: p, query: Object.fromEntries(u.searchParams), body, auth: !!req.headers.authorization, t: Date.now() });
        const r = this.handle(req.method, p, u.searchParams, body, req.headers.authorization);
        if (r.status) return send(r.status, r.body);
        send(200, r);
      });
    });
    return new Promise((resolve) => this.server.listen(port, host, () => resolve(this.server.address().port)));
  }
  stop() { return new Promise((r) => { if (!this.server) return r(); this.server.close(() => r()); if (this.server.closeAllConnections) this.server.closeAllConnections(); }); }
  calls(method, p) { return this.history.filter((h) => h.method === method && h.path === p); }
}
module.exports = { MockPixelHue, SN, START };
