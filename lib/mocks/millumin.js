'use strict';
// Mock Millumin (UDP OSC) for tests and --mock. Listens on loopback, records every OSC message, keeps a small
// board (columns, one selected layer) and, like Millumin with "send feedback" on, replies to the sender with
// /millumin/board/launchedColumn [index, name] or /millumin/board/stoppedColumn.
const dgram = require('dgram');
const osc = require('../drivers/osc');

const COLUMNS = ['Walk in', 'Keynote', 'Rollout', 'Walk out', 'Hold'];

class MockMillumin {
  constructor() {
    this.history = []; this.sock = null; this.feedback = true;
    this.s = { column: 0, running: false, layer: 1, media: null, opacity: 1, fullscreen: false, testCard: false, board: 'Main' };
  }
  calls(address) { return this.history.filter((h) => h.address === address); }
  start(port = 0, host = '127.0.0.1') {
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (m, r) => this._recv(m, r));
    return new Promise((res) => this.sock.bind(port, host, () => res(this.sock.address().port)));
  }
  stop() { return new Promise((r) => { if (!this.sock) return r(); try { this.sock.close(() => r()); } catch { r(); } this.sock = null; }); }
  _reply(rinfo, address, args) { if (this.feedback && this.sock) { const b = osc.encode(address, args); this.sock.send(b, 0, b.length, rinfo.port, rinfo.address); } }
  _recv(buf, rinfo) {
    const msg = osc.decode(buf); if (!msg) return;
    this.history.push({ address: msg.address, args: msg.args });
    const v = msg.args[0] ? msg.args[0].value : undefined;
    const s = this.s; const colAt = () => (typeof s.column === 'number' ? s.column : Math.max(0, COLUMNS.indexOf(s.column) + 1));
    const col = () => { const i = colAt(); return [i, COLUMNS[i - 1] || (typeof s.column === 'string' ? s.column : `Column ${i}`)]; };
    const launch = (value) => { s.column = value; s.running = true; const [i, name] = typeof value === 'number' ? [value, COLUMNS[value - 1] || `Column ${value}`] : [Math.max(0, COLUMNS.indexOf(value) + 1), value]; this._reply(rinfo, '/millumin/board/launchedColumn', [{ type: 'i', value: i }, { type: 's', value: name }]); };
    switch (msg.address) {
      case '/action/launchColumn': launch(v); break;
      case '/action/launchOrStopColumn': if (s.running) { s.running = false; this._reply(rinfo, '/millumin/board/stoppedColumn', []); } else launch(v); break;
      case '/action/stopColumn': s.running = false; this._reply(rinfo, '/millumin/board/stoppedColumn', []); break;
      case '/action/launchNextColumn': launch(Math.min(COLUMNS.length, colAt() + 1)); break;
      case '/action/launchPreviousColumn': launch(Math.max(1, colAt() - 1)); break;
      case '/action/play': s.running = true; this._reply(rinfo, '/millumin/board/launchedColumn', [{ type: 'i', value: col()[0] }, { type: 's', value: col()[1] }]); break;
      case '/action/pause': s.running = false; this._reply(rinfo, '/millumin/board/stoppedColumn', []); break;
      case '/action/playOrPause': s.running = !s.running; this._reply(rinfo, s.running ? '/millumin/board/launchedColumn' : '/millumin/board/stoppedColumn', s.running ? [{ type: 'i', value: col()[0] }, { type: 's', value: col()[1] }] : []); break;
      case '/action/selectLayer': s.layer = v; break;
      case '/action/selectBoard': s.board = v; this._reply(rinfo, '/millumin/board/name', [typeof v === 'number' ? { type: 'i', value: v } : { type: 's', value: String(v) }]); break;
      case '/selectedLayer/startMedia': s.media = v == null ? s.media : v; s.running = true; break;
      case '/selectedLayer/pauseMedia':
      case '/selectedLayer/stopMedia': s.running = false; break;
      case '/selectedLayer/opacity': s.opacity = v; break;
      case '/action/enterFullscreen': s.fullscreen = true; break;
      case '/action/exitFullscreen': s.fullscreen = false; break;
      case '/action/displayTestCard': s.testCard = true; break;
      case '/action/hideTestCard': s.testCard = false; break;
      default: break;
    }
  }
}

module.exports = { MockMillumin, COLUMNS };
