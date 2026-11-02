'use strict';
// A small Videohub for tests. It speaks the same text blocks as a Smart Videohub.
const net = require('net');

const PREAMBLE = [
  'PROTOCOL PREAMBLE:',
  'Version: 2.3',
  '',
  'VIDEOHUB DEVICE:',
  'Device present: true',
  'Model name: Blackmagic Smart Videohub',
  'Video inputs: 4',
  'Video outputs: 4',
  '',
  'INPUT LABELS:',
  '0 Cam 1',
  '1 Cam 2',
  '2 Playback',
  '3 Bars',
  '',
  'OUTPUT LABELS:',
  '0 Rec 1',
  '1 Rec 2',
  '2 PGM',
  '3 PVW',
  '',
].join('\n');

class MockVideohub {
  constructor() {
    this.routing = { 0: 0, 1: 1, 2: 2, 3: 3 };
    this.server = null;
    this.clients = new Set();
  }
  start(port = 0, host = '127.0.0.1') {
    this.server = net.createServer((sock) => {
      this.clients.add(sock);
      sock.setEncoding('utf8');
      sock.write(`${PREAMBLE}\n${this._routeBlock()}`);
      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk;
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const part of parts) this._cmd(part);
        this._broadcast(this._routeBlock());
      });
      sock.on('close', () => this.clients.delete(sock));
      sock.on('error', () => this.clients.delete(sock));
    });
    return new Promise((resolve) => this.server.listen(port, host, () => resolve(this.server.address().port)));
  }
  _cmd(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length || lines[0] !== 'VIDEO OUTPUT ROUTING:') return;
    for (const line of lines.slice(1)) {
      const m = /^(\d+)\s+(\d+)$/.exec(line.trim());
      if (m) this.routing[Number(m[1])] = Number(m[2]);
    }
  }
  _routeBlock() {
    const lines = Object.keys(this.routing).sort((a, b) => a - b).map((o) => `${o} ${this.routing[o]}`);
    return `VIDEO OUTPUT ROUTING:\n${lines.join('\n')}\n\n`;
  }
  _broadcast(body) { for (const s of this.clients) { try { s.write(body); } catch { /* gone */ } } }
  stop() {
    for (const s of this.clients) { try { s.destroy(); } catch { /* gone */ } }
    this.clients.clear();
    return new Promise((resolve) => { if (!this.server) return resolve(); this.server.close(() => resolve()); });
  }
}

module.exports = { MockVideohub };
