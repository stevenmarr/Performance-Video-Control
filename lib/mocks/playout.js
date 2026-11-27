'use strict';
// A Playout control listener for tests. The documented HTTP surface is
// GET /health, GET /status, POST /transport/play|pause|stop, and POST /rpc.
// Richer fields (clip, playlist, elapsed, remaining, standby, cued) and the
// optional GET /clips, /playlist, and /standby routes are included unless
// `minimal` is set, which answers the way the server documents /status today
// and 404s the lists. POST /transport/next is 404 unless `allowNext` is set,
// because that route is not in the current API. Nothing here plays on accept.

const http = require('http');

const CLIPS = [
  { id: '1', name: 'Open', number: '1' },
  { id: '2', name: 'Keynote', number: '2' },
  { id: '3', name: 'Walk out', number: '3' },
];

class MockPlayout {
  constructor(opts = {}) {
    this.minimal = !!opts.minimal;
    this.allowNext = !!opts.allowNext;
    this.refusePlay = !!opts.refusePlay;
    this.transport = 'stopped';
    this.frame = 120;
    this.buffered = 8;
    this.elapsed = '00:00:04:00';
    this.remaining = '00:01:26:00';
    this.timecode = '00:00:04:00';
    this.clip = 'Open';
    this.cue = '1';
    this.clips = CLIPS.map((c) => ({ ...c }));
    this.playlist = CLIPS.map((c) => ({ ...c }));
    this.standby = 'Keynote';
    this.cued = 'Keynote';
    this.version = '0.2.0';
    this.requests = [];
    this.server = null;
  }

  start(port = 0, host = '127.0.0.1') {
    this.server = http.createServer((req, res) => {
      this._handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end('{"ok":false}');
      });
    });
    return new Promise((resolve) => this.server.listen(port, host, () => resolve(this.server.address().port)));
  }

  posts() { return this.requests.filter((r) => r.method === 'POST'); }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      if (typeof this.server.closeAllConnections === 'function') this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }

  async _handle(req, res) {
    const path = (req.url || '/').split('?')[0];
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    this.requests.push({ method: req.method, path, body: raw });
    const send = (status, body) => {
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(text),
        Connection: 'close',
      });
      res.end(text);
    };
    if (req.method === 'GET' && path === '/health') return send(200, { ok: true, version: this.version });
    if (req.method === 'GET' && path === '/status') return send(200, this._status());
    if (req.method === 'GET' && (path === '/clips' || path === '/playlist' || path === '/standby')) {
      if (this.minimal) return send(404, { ok: false });
      if (path === '/clips') return send(200, { ok: true, clips: this.clips });
      if (path === '/playlist') return send(200, { ok: true, playlist: this.playlist });
      return send(200, { ok: true, standby: this.standby, cued: this.cued });
    }
    if (req.method === 'POST' && path === '/transport/play') {
      if (this.refusePlay || this.buffered < 3) {
        return send(409, { ok: false, message: 'GO refused. Preroll is short.' });
      }
      this.transport = 'playing';
      return send(200, { ok: true, transport: this.transport });
    }
    if (req.method === 'POST' && path === '/transport/pause') {
      if (this.transport === 'playing') this.transport = 'paused';
      return send(200, { ok: true, transport: this.transport });
    }
    if (req.method === 'POST' && path === '/transport/stop') {
      this.transport = 'stopped';
      this.frame = 0;
      return send(200, { ok: true, transport: this.transport });
    }
    if (req.method === 'POST' && path === '/transport/go') {
      if (this.refusePlay || this.buffered < 3) return send(409, { ok: false, message: 'GO refused. Preroll is short.' });
      this.transport = 'playing';
      return send(200, { ok: true, transport: this.transport });
    }
    if (req.method === 'POST' && path === '/transport/next') {
      if (!this.allowNext) return send(404, { ok: false });
      const target = this._follow(this.clip);
      if (!target) return send(409, { ok: false, message: 'no next clip' });
      this._jump(target.number || target.name);
      return send(200, { ok: true, transport: this.transport, clip: this.clip });
    }
    if (req.method === 'POST' && path === '/rpc') return send(200, this._rpc(raw));
    return send(404, { ok: false });
  }

  _status() {
    const base = { ok: true, transport: this.transport, frame: this.frame, buffered: this.buffered };
    if (this.minimal) return base;
    return {
      ...base,
      timecode: this.timecode,
      elapsed: this.elapsed,
      remaining: this.remaining,
      cue: this.cue,
      clip: this.clip,
      clips: this.clips,
      playlist: this.playlist,
      standby: this.standby,
      cued: this.cued,
    };
  }

  _follow(name) {
    const list = this.playlist.length ? this.playlist : this.clips;
    const idx = list.findIndex((c) => c.name === name);
    if (idx < 0) return list[0] || null;
    return list[idx + 1] || null;
  }

  _jump(value) {
    const list = this.playlist.length ? this.playlist : this.clips;
    const item = list.find((c) => c.name === value || c.number === value || c.id === value) || { name: String(value), number: String(value), id: String(value) };
    this.clip = item.name;
    this.cue = item.number || item.name;
    const follow = this._follow(item.name);
    this.cued = follow ? follow.name : item.name;
    this.standby = this.cued;
  }

  _rpc(raw) {
    let data = {};
    try { data = JSON.parse(raw || '{}'); } catch { data = {}; }
    const id = Number.isFinite(Number(data.id)) ? Number(data.id) : 0;
    const method = data.method || '';
    const params = data.params && typeof data.params === 'object' ? data.params : {};
    if (method === 'playout.cues.jump') {
      const value = params.tag || params.number || params.id;
      if (!value) return { jsonrpc: '2.0', id, error: { code: -32602, message: 'cue needs a number or a tag' } };
      this._jump(String(value));
      return { jsonrpc: '2.0', id, result: { ok: true, transport: this.transport, clip: this.clip } };
    }
    if (method === 'playout.transport.play' || method === 'playout.transport.go') {
      if (this.refusePlay || this.buffered < 3) {
        return { jsonrpc: '2.0', id, error: { code: -32001, message: 'GO refused. Preroll is short.' } };
      }
      this.transport = 'playing';
      return { jsonrpc: '2.0', id, result: { ok: true, transport: this.transport } };
    }
    if (method === 'playout.transport.pause') {
      if (this.transport === 'playing') this.transport = 'paused';
      return { jsonrpc: '2.0', id, result: { ok: true, transport: this.transport } };
    }
    if (method === 'playout.transport.stop') {
      this.transport = 'stopped';
      return { jsonrpc: '2.0', id, result: { ok: true, transport: this.transport } };
    }
    if (method === 'playout.status.get') return { jsonrpc: '2.0', id, result: this._status() };
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } };
  }
}

module.exports = { MockPlayout, CLIPS };
