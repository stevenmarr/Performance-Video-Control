'use strict';
// Millumin (Anomes): OSC over UDP. There is no HTTP or JSON API. The addresses are the ones
// bitfocus/companion-module-anomes-millumin sends (src/actions.ts), which are Millumin's own OSC API
// (Interactions › Manage devices › OSC; the input port defaults to 5000 and is changeable). Millumin only
// reports state back when "send feedback" is on, and then only to the sender, so this driver listens on its own
// socket for /millumin/board/launchedColumn [index, name] and /millumin/board/stoppedColumn. A dashboard works
// without that: every command is fire-and-forget and the last one sent is what the page shows.
const dgram = require('dgram');
const osc = require('./osc');

const COMMANDS = {
  launchColumn: { address: '/action/launchColumn', arg: 'column' },
  launchOrStopColumn: { address: '/action/launchOrStopColumn', arg: 'column' },
  stopColumn: { address: '/action/stopColumn' },
  nextColumn: { address: '/action/launchNextColumn' },
  previousColumn: { address: '/action/launchPreviousColumn' },
  play: { address: '/action/play' },
  pause: { address: '/action/pause' },
  playOrPause: { address: '/action/playOrPause' },
  goToTime: { address: '/action/goToTime', arg: 'time' },
  goToSegment: { address: '/action/goToTimelineSegment', arg: 'name' },
  selectBoard: { address: '/action/selectBoard', arg: 'which' },
  selectLayer: { address: '/action/selectLayer', arg: 'which' },
  selectLight: { address: '/action/selectLight', arg: 'which' },
  enterFullscreen: { address: '/action/enterFullscreen' },
  exitFullscreen: { address: '/action/exitFullscreen' },
  displayTestCard: { address: '/action/displayTestCard' },
  hideTestCard: { address: '/action/hideTestCard' },
  startMedia: { address: '/selectedLayer/startMedia', arg: 'media', optional: true },
  pauseMedia: { address: '/selectedLayer/pauseMedia' },
  startOrPauseMedia: { address: '/selectedLayer/startOrPauseMedia' },
  stopMedia: { address: '/selectedLayer/stopMedia' },
  mediaTime: { address: '/selectedLayer/media/time', arg: 'time' },
  mediaSpeed: { address: '/selectedLayer/media/speed', arg: 'speed' },
  opacity: { address: '/selectedLayer/opacity', arg: 'opacity' },
};
const WHICH = { column: 'column', which: 'board, layer or light', media: 'media', name: 'segment' };

class MilluminDriver {
  constructor(conn = {}, log = () => {}, onChange = () => {}) {
    this.system = 'millumin';
    this.log = log; this.onChange = onChange;
    this.capabilities = { milluminColumns: true, milluminLayer: true, millumin: true };
    this.st = { connected: false, info: null, error: null, lastSeen: 0 };
    this.sock = null;
    this.configure(conn);
  }
  configure(conn) { this.close(); this.conn = { host: '', port: 5000, ...conn }; this._blank(); }
  _blank() {
    this.state = { board: null, column: null, columnName: null, running: false, layer: null, media: null, opacity: null, fullscreen: false, testCard: false, lastCommand: null };
  }
  status() { return { ...this.st, info: this.st.info ? { ...this.st.info } : null }; }
  close() {
    if (this.sock) { try { this.sock.close(); } catch { /* already closed */ } }
    this.sock = null; this.st.connected = false;
  }
  _changed() { if (this._chg) return; this._chg = setTimeout(() => { this._chg = null; this.onChange(); }, 20); if (this._chg.unref) this._chg.unref(); }

  // UDP has no handshake. "Connected" means the socket is open toward a configured host; Millumin answers only
  // when its feedback is enabled, so a silent peer is still a usable target.
  connect() {
    if (!this.conn.host) return Promise.reject(new Error('Millumin: no IP address set (SYSTEMS tab)'));
    this.close(); this._blank();
    const sock = dgram.createSocket('udp4'); this.sock = sock;
    sock.on('error', (e) => { this.st.error = e.message; this.log('warn', `Millumin: ${e.message}`); });
    sock.on('message', (m, r) => this._receive(m, r));
    return new Promise((resolve, reject) => {
      sock.once('error', (e) => reject(new Error(`Millumin: ${e.message}`)));
      sock.bind(0, () => {
        this.st.connected = true; this.st.error = null; this.st.lastSeen = Date.now();
        this.st.info = { model: 'Millumin', version: '' };
        this._changed(); resolve(this.st.info);
      });
    });
  }
  async heartbeat() {
    if (!this.sock || !this.st.connected) throw new Error(this.st.error || 'not connected');
  }
  _receive(buf, rinfo) {
    if (rinfo.address !== this.conn.host && rinfo.address !== '127.0.0.1') return;
    const msg = osc.decode(buf); if (!msg) return;
    this.st.lastSeen = Date.now();
    const s = this.state; const a = msg.args;
    if (msg.address === '/millumin/board/launchedColumn') { s.running = true; s.column = a[0] && a[0].type === 'i' ? a[0].value : s.column; s.columnName = a[1] && a[1].type === 's' ? a[1].value : s.columnName; }
    else if (msg.address === '/millumin/board/stoppedColumn') { s.running = false; }
    else if (msg.address === '/millumin/board/name' && a[0]) s.board = a[0].value;
    else return;
    this._changed();
  }
  // Send one command. `value` is the argument its address takes (a column index or name, a time, an opacity).
  send(name, value) {
    const spec = COMMANDS[name];
    if (!spec) throw Object.assign(new Error(`Unknown Millumin command "${name}"`), { status: 404 });
    if (!this.sock || !this.st.connected) throw Object.assign(new Error('Millumin not connected'), { status: 409 });
    let args = [];
    if (spec.arg && !(spec.optional && (value === undefined || value === null || value === ''))) {
      if (value === undefined || value === null || value === '') throw Object.assign(new Error(`${name} needs a ${WHICH[spec.arg] || spec.arg}`), { status: 400 });
      if (spec.arg === 'time' || spec.arg === 'speed' || spec.arg === 'opacity') {
        const n = Number(value); if (!Number.isFinite(n)) throw Object.assign(new Error(`${name} needs a number`), { status: 400 });
        if (spec.arg === 'opacity' && (n < 0 || n > 1)) throw Object.assign(new Error('Opacity is 0..1'), { status: 400 });
        args = [{ type: 'f', value: n }];
      } else if (typeof value === 'number' || /^\d+$/.test(String(value))) args = [{ type: 'i', value: Number(value) }];
      else args = [{ type: 's', value: String(value).slice(0, 200) }];
    }
    const pkt = osc.encode(spec.address, args);
    return new Promise((resolve, reject) => {
      this.sock.send(pkt, 0, pkt.length, Number(this.conn.port) || 5000, this.conn.host, (e) => {
        if (e) { reject(Object.assign(new Error(`Millumin: ${e.message}`), { status: 502 })); return; }
        this._apply(name, args[0] ? args[0].value : null); this.st.lastSeen = Date.now(); resolve({ ok: true, address: spec.address });
      });
    });
  }
  // What the page shows until Millumin's own feedback (if enabled) says otherwise.
  _apply(name, value) {
    const s = this.state; s.lastCommand = name;
    if (name === 'launchColumn' || name === 'launchOrStopColumn') {
      s.running = name === 'launchOrStopColumn' ? !s.running : true;
      if (s.column !== value) s.columnName = typeof value === 'string' ? value : null;
      else if (typeof value === 'string') s.columnName = value;
      s.column = value;
    } else if (name === 'nextColumn' || name === 'previousColumn') s.running = true;
    else if (name === 'stopColumn' || name === 'pause') s.running = false;
    else if (name === 'play') s.running = true;
    else if (name === 'playOrPause') s.running = !s.running;
    else if (name === 'selectBoard') s.board = value;
    else if (name === 'selectLayer') s.layer = value;
    else if (name === 'startMedia') { s.media = value === null ? s.media : value; s.running = true; }
    else if (name === 'pauseMedia' || name === 'stopMedia') s.running = false;
    else if (name === 'startOrPauseMedia') s.running = !s.running;
    else if (name === 'opacity') s.opacity = value;
    else if (name === 'enterFullscreen') s.fullscreen = true;
    else if (name === 'exitFullscreen') s.fullscreen = false;
    else if (name === 'displayTestCard') s.testCard = true;
    else if (name === 'hideTestCard') s.testCard = false;
    this._changed();
  }
  view() { return { ...this.state, commands: Object.keys(COMMANDS) }; }
}

module.exports = { MilluminDriver, COMMANDS };
