'use strict';
// Mock Panasonic PTZ camera (AW-UE150-style) for tests and --mock. Serves the three paths the Companion module
// uses (companion-module-panasonic-ptz): /cgi-bin/aw_ptz?cmd=%23...&res=1, /cgi-bin/aw_cam?cmd=...&res=1 and
// /live/camdata.html. A test double, not an emulator: it echoes commands the way the cameras do (lower-case first
// letter), keeps enough state for the status page, and records every command in `history`.
const http = require('http');

class MockPTZ {
  constructor({ model = 'AW-UE150', title = 'MOCK-CAM' } = {}) {
    this.model = model; this.title = title; this.history = []; this.server = null;
    this.s = { power: 1, tally: 0, tallyGreen: 0, af: 1, autoIris: 1, iris: 50, gain: '08', shutter: '0', wb: '0', pan: 0x8000, tilt: 0x8000, zoom: 0x555, pt: '5050', z: '50', f: '50' };
    this.presets = new Set([0, 1, 2]);
    this.lastRecall = null;
  }
  calls(prefix) { return this.history.filter((h) => h.cmd.startsWith(prefix)); }
  ptz(cmd) {
    const s = this.s; let m;
    if ((m = /^PTS(\d\d)(\d\d)$/.exec(cmd))) { s.pt = m[1] + m[2]; return `pTS${m[1]}${m[2]}`; }
    if ((m = /^Z(\d\d)$/.exec(cmd))) { s.z = m[1]; return `zS${m[1]}`; }
    if ((m = /^F(\d\d)$/.exec(cmd))) { s.f = m[1]; return `fS${m[1]}`; }
    if (cmd === 'APC7FFF7FFF') { s.pan = 0x7fff; s.tilt = 0x7fff; return 'aPC7FFF7FFF'; }
    if ((m = /^R(\d\d)$/.exec(cmd))) { const n = Number(m[1]); if (!s.power) return 'E2'; this.lastRecall = n; return `s${m[1]}`; }
    if ((m = /^M(\d\d)$/.exec(cmd))) { this.presets.add(Number(m[1])); return `s${m[1]}`; }
    if (cmd === 'O1' || cmd === 'O0') { s.power = cmd === 'O1' ? 1 : 0; return `p${s.power}`; }
    if (cmd === 'O') return `p${s.power}`;
    if (cmd === 'DA1' || cmd === 'DA0') { s.tally = Number(cmd[2]); return `dA${s.tally}`; }
    if (cmd === 'D11' || cmd === 'D10') { s.af = Number(cmd[2]); return `d1${s.af}`; }
    if (cmd === 'D31' || cmd === 'D30') { s.autoIris = Number(cmd[2]); return `d3${s.autoIris}`; }
    if ((m = /^I(\d\d)$/.exec(cmd))) { s.iris = Number(m[1]); return `iC${m[1]}`; }
    return 'E1';
  }
  cam(cmd) {
    const s = this.s; let m;
    if ((m = /^OGU:([0-9A-F]{2})$/.exec(cmd))) { s.gain = m[1]; return cmd; }
    if ((m = /^OSH:([0-9A-C])$/.exec(cmd))) { s.shutter = m[1]; return cmd; }
    if ((m = /^OAW:([0-2])$/.exec(cmd))) { s.wb = m[1]; return cmd; }
    if ((m = /^TLR:([01])$/.exec(cmd))) { s.tally = Number(m[1]); return cmd; }
    if ((m = /^TLG:([01])$/.exec(cmd))) { s.tallyGreen = Number(m[1]); return cmd; }
    if (cmd === 'OSE:69:1') return cmd;
    return 'ER1:' + cmd;
  }
  camdata() {
    const s = this.s;
    return ['', `OID:${this.model}`, `TITLE:${this.title}`, 'qSV3MOCK1.00', 'rER00', `p${s.power}`, `dA${s.tally}`, `TLR:${s.tally}`, `TLG:${s.tallyGreen}`,
      `OAF:${s.af}`, `d3${s.autoIris}`, `OGU:${s.gain}`, ''].join('\r\n');
  }
  start(port = 0, host = '127.0.0.1') {
    this.server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      let body; let code = 200;
      if (u.pathname === '/cgi-bin/aw_ptz') {
        const raw = u.searchParams.get('cmd') || '';
        if (!raw.startsWith('#')) { body = 'E1'; } else { const cmd = raw.slice(1); this.history.push({ path: 'aw_ptz', cmd, at: Date.now() }); body = this.ptz(cmd); }
      } else if (u.pathname === '/cgi-bin/aw_cam') {
        const cmd = u.searchParams.get('cmd') || ''; this.history.push({ path: 'aw_cam', cmd, at: Date.now() }); body = this.cam(cmd);
      } else if (u.pathname === '/live/camdata.html') { this.history.push({ path: 'camdata', cmd: '', at: Date.now() }); body = this.camdata(); }
      else { code = 404; body = 'not found'; }
      res.writeHead(code, { 'Content-Type': 'text/plain' }); res.end(body);
    });
    return new Promise((r) => this.server.listen(port, host, () => r(this.server.address().port)));
  }
  stop() { return new Promise((r) => { if (!this.server) return r(); this.server.closeAllConnections && this.server.closeAllConnections(); this.server.close(() => r()); }); }
}

module.exports = { MockPTZ };
