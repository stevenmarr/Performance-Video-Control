'use strict';
// Mock AV Stumpfl Pixera (TCP) for tests and --mock: the pxr1 + uint32le JSON-RPC framing of lib/drivers/pixera.js,
// from Pixera's side. Three timelines, a handful of cues, and the transport / cue methods the driver sends. A test
// double, not an emulator; every call lands in `history`. Binds loopback only.
const net = require('net');
const { frame, takeFrames } = require('../drivers/pixera');

const TIMELINES = [
  { handle: 101, name: 'Main', fps: 60, cues: ['Walk in', 'Keynote', 'Rollout', 'Walk out'] },
  { handle: 102, name: 'Side wall', fps: 60, cues: ['Hold', 'Logos'] },
  { handle: 103, name: 'Countdown', fps: 30, cues: ['10 minutes', 'Stand by'] },
];

class MockPixera {
  constructor() {
    this.history = []; this.server = null; this.sockets = new Set(); this.rx = new Map();
    this.transport = {}; this.cue = {}; this.revision = 367; this.drop = false;
    for (const t of TIMELINES) { this.transport[t.handle] = 'stop'; this.cue[t.handle] = t.cues[0]; }
  }
  calls(method) { return this.history.filter((h) => h.method === method); }
  start(port = 0, host = '127.0.0.1') {
    this.server = net.createServer((sock) => this._client(sock));
    return new Promise((res, rej) => { this.server.once('error', rej); this.server.listen(port, host, () => res(this.server.address().port)); });
  }
  stop() {
    for (const s of this.sockets) { try { s.destroy(); } catch { /* already gone */ } }
    this.sockets.clear();
    return new Promise((r) => { if (!this.server) return r(); this.server.close(() => r()); this.server = null; });
  }
  _client(sock) {
    this.sockets.add(sock); const st = { buf: null }; this.rx.set(sock, st);
    sock.on('data', (c) => { for (const raw of takeFrames(st, c)) this._handle(sock, raw); });
    sock.on('close', () => { this.sockets.delete(sock); this.rx.delete(sock); });
    sock.on('error', () => {});
  }
  _send(sock, msg) { if (!this.drop) sock.write(frame(msg)); }
  _handle(sock, raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const { id, method, params } = msg; const p = params || {};
    this.history.push({ method, params: p });
    const tl = (h) => TIMELINES.find((t) => t.handle === Number(h));
    let result = null; let error = null;
    if (method === 'Pixera.Utility.getApiRevision') result = this.revision;
    else if (method === 'Pixera.Utility.setShowContextInReplies') result = true;
    else if (method === 'Pixera.Timelines.getTimelines') result = TIMELINES.map((t) => t.handle);
    else if (method === 'Pixera.Timelines.Timeline.getAttributes') { const t = tl(p.handle); result = t ? { name: t.name, fps: t.fps, context: { handle: t.handle } } : null; if (!t) error = { message: `no timeline ${p.handle}` }; }
    else if (method === 'Pixera.Timelines.Timeline.setTransportMode') { const t = tl(p.handle); if (!t) error = { message: `no timeline ${p.handle}` }; else { this.transport[t.handle] = { 1: 'play', 2: 'pause', 3: 'stop' }[p.mode] || 'stop'; result = true; } }
    else if (method === 'Pixera.Timelines.Timeline.toggleTransport') { const t = tl(p.handle); if (!t) error = { message: `no timeline ${p.handle}` }; else { this.transport[t.handle] = this.transport[t.handle] === 'play' ? 'pause' : 'play'; result = true; } }
    else if (method === 'Pixera.Timelines.Timeline.moveToNextCue' || method === 'Pixera.Timelines.Timeline.moveToNextCueIgnoreProperties' || method === 'Pixera.Timelines.Timeline.moveToPreviousCue' || method === 'Pixera.Timelines.Timeline.moveToPreviousCueIgnoreProperties') {
      const t = tl(p.handle); if (!t) error = { message: `no timeline ${p.handle}` };
      else {
        const back = /Previous/.test(method); const at = Math.max(0, t.cues.indexOf(this.cue[t.handle]));
        const i = Math.max(0, Math.min(t.cues.length - 1, at + (back ? -1 : 1)));
        this.cue[t.handle] = t.cues[i]; result = { name: t.cues[i] };
      }
    } else if (method === 'Pixera.Compound.applyCueOnTimeline') {
      const t = TIMELINES.find((x) => x.name === p.timelineName);
      if (!t || !t.cues.includes(p.cueName)) error = { message: `no cue "${p.cueName}" on "${p.timelineName}"` };
      else { this.cue[t.handle] = p.cueName; result = true; }
    } else if (method === 'Pixera.Compound.applyCueAtIndexOnTimelineAtIndex') {
      const t = TIMELINES[p.timelineIndex];
      if (!t || !t.cues[p.cueIndex]) error = { message: 'index out of range' };
      else { this.cue[t.handle] = t.cues[p.cueIndex]; result = true; }
    } else error = { message: `unknown method ${method}` };
    this._send(sock, error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result });
  }
}

module.exports = { MockPixera, TIMELINES };
