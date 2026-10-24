'use strict';
// Mock Panasonic PTZ camera for tests and --mock (0.8.0: the whole command catalog). Serves the paths the
// Companion module uses (/cgi-bin/aw_ptz?cmd=%23...&res=1, /cgi-bin/aw_cam?cmd=...&res=1, /cgi-bin/<web>,
// /live/camdata.html) plus the spec's preset thumbnail CGI. A test double, not an emulator:
//   * model-aware: it accepts exactly the commands lib/drivers/ptz-commands.js offers for its model's series and
//     answers anything else the way the spec says (eR1:<cmd> on aw_ptz, ER1:<cmd> on aw_cam); out-of-range values
//     get ER3, commands other than power / status while in standby get ER2 (eR2 on aw_ptz)
//   * echoes accepted commands like the cameras do (aw_ptz: lower-case first letter; aw_cam: the command)
//   * integrates pan / tilt / zoom / focus speeds into positions, so camdata.html reports moving aPC / axz / axf
//   * records every request in `history`; no network beyond its own 127.0.0.1 port
const http = require('http');
const P = require('../drivers/ptz-commands');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const H = P.H;

class MockPTZ {
  constructor({ model = 'AW-UE150', title = 'MOCK-CAM' } = {}) {
    this.model = model; this.title = title; this.history = []; this.server = null;
    this.series = P.seriesFor(model);
    this.s = { power: 1, tally: 0, tallyGreen: 0, af: 1, autoIris: 1, iris: 50, gain: '08', shutter: '0', wb: '0', pt: '5050', z: '50', f: '50', night: false,
      pan: 0x8000, tilt: 0x8000, zoom: 0x555, focus: 0x800, irisPos: 0x800, ins: 0, menu: 0, menuMoves: [] };
    this.raw = { OAW: '0', OFT: '0', 'OSJ:03': '0', 'OSJ:06': '0064', 'OSJ:09': '00258', 'OSG:39': '800', 'OSG:3A': '800', 'OSJ:0F': '800', ORP: '096', OBP: '096', 'OSJ:10': '096',
      ODT: '1', 'OSA:30': '80', 'OSA:40': '0', 'OSD:A3': '80', 'OSE:72': '0', 'OSA:6A': '80', 'OSA:2D': '2', 'OSA:20': '80', 'OSA:24': '30', 'OSE:31': '0', 'OSJ:4F': '0',
      'OSD:A4': '80', 'OSD:A5': '80', 'OSD:A6': '80', 'OSD:A7': '80', 'OSD:A8': '80', 'OSD:A9': '80', 'OSD:B0': '80', 'OSJ:0B': '80', 'OSI:20': '015E0:0', 'OSI:28': '0',
      OSF: '0', 'OSE:71': '0', 'OSJ:29': '0', uPVS: '999', DCB: '0', OUS: '0', OTP: '0', OSH: '0', 'OSD:B1': '0', DCS: '0', 'OSD:BE': '0', 'OSJ:27': '0', 'OSD:BA': '1',
      OIS: '0', 'OSJ:4E': '0', 'OSE:70': '0', 'OSE:7C': '0', 'OSA:D3': '1', 'OSJ:D9': '0', 'OSJ:DA': '0', 'OSJ:54': '0', 'OSJ:55': '0',
      'OSJ:01': '1', 'OSJ:02': '0', 'OSJ:C0': '0', 'OSD:48': '32', 'OSD:BF': '2' };
    this.limits = { 1: 0, 2: 0, 3: 0, 4: 0 }; this.tae = 1;
    this.presets = new Set([0, 1, 2]);
    this.names = {};
    this.lastRecall = null;
    this.at = Date.now();
    this._allowed = this._buildAllowed();
  }
  calls(prefix) { return this.history.filter((h) => h.cmd.startsWith(prefix)); }
  // prefix -> {lo, hi} (hex code bounds for range commands) for every aw_cam / aw_ptz catalog command of this series
  _buildAllowed() {
    const cat = P.catalogFor(this.series); const out = new Map();
    const prefix = (cmd) => { const m = /^(.*):[^:]*$/.exec(cmd); return m ? m[1] : cmd; };
    for (const o of cat.ops) {
      const def = P.BY_ID.get(o.id); if (!def) continue;
      let lo; let hi; let sample;
      try {
        if (o.type === 'range') { lo = P.build(this.series, o.id, o.range.min); hi = P.build(this.series, o.id, o.range.max); sample = lo; }
        else if (o.type === 'list') sample = P.build(this.series, o.id, o.options[0][0]);
        else if (o.type === 'toggle') sample = P.build(this.series, o.id, true);
        else sample = P.build(this.series, o.id);
      } catch { continue; }
      if (sample.path === 'web') continue;
      const k = o.type === 'button' ? sample.cmd : prefix(sample.cmd);
      const range = lo ? { lo: parseInt(lo.cmd.slice(k.length + 1), 16), hi: parseInt(hi.cmd.slice(k.length + 1), 16) } : null;
      const values = o.type === 'list' ? new Set(o.options.map(([v]) => String(P.build(this.series, o.id, v).cmd.slice(k.length + 1)))) : null;
      out.set(`${sample.path}:${k}`, { range, values, id: o.id });
    }
    return out;
  }
  _integrate() {
    const now = Date.now(); const dt = Math.min(2, (now - this.at) / 1000); this.at = now; const s = this.s;
    const v = (code) => Number(code) - 50;
    s.pan = clamp(s.pan + v(s.pt.slice(0, 2)) * 120 * dt, 0x2D09, 0xD2F5);
    s.tilt = clamp(s.tilt + v(s.pt.slice(2)) * 120 * dt, 0x5555, 0x8E38);
    s.zoom = clamp(s.zoom + v(s.z) * 40 * dt, 0x555, 0xFFF);
    s.focus = clamp(s.focus + v(s.f) * 40 * dt, 0x555, 0xFFF);
  }
  ptz(cmd) {
    const s = this.s; let m;
    this._integrate();
    const refuse = (n) => `eR${n}:${cmd}`;
    if (cmd === 'O') return `p${s.power}`;
    if (cmd === 'O1' || cmd === 'O0') { s.power = cmd === 'O1' ? 1 : 0; if (!s.power) { s.pt = '5050'; s.z = '50'; s.f = '50'; } return `p${s.power}`; }
    if (cmd === 'GZ') return `gz${H(s.zoom, 3)}`;
    if (cmd === 'GF') return `gf${H(s.focus, 3)}`;
    if (cmd === 'GI') return `gi${H(s.irisPos, 3)}${s.autoIris}`;
    if (!s.power) return refuse(2);
    if ((m = /^PTS(\d\d)(\d\d)$/.exec(cmd))) { if (m[1] === '00' || m[2] === '00') return refuse(3); s.pt = m[1] + m[2]; return `pTS${m[1]}${m[2]}`; }
    if ((m = /^Z(\d\d)$/.exec(cmd))) { if (m[1] === '00') return refuse(3); s.z = m[1]; return `zS${m[1]}`; }
    if ((m = /^F(\d\d)$/.exec(cmd))) { if (this.series === 'AW-HE2') return refuse(1); if (m[1] === '00') return refuse(3); s.f = m[1]; return `fS${m[1]}`; }
    if ((m = /^APC([0-9A-F]{4})([0-9A-F]{4})$/.exec(cmd))) { s.pan = parseInt(m[1], 16); s.tilt = parseInt(m[2], 16); return `aPC${m[1]}${m[2]}`; }
    if ((m = /^AX([ZF])([0-9A-F]{3})$/.exec(cmd)) && !P.SPEC_SERIES.has(this.series)) return refuse(1);
    if (/^AXF/.test(cmd) && s.af) return refuse(2); // spec: focus position only in manual focus
    if ((m = /^LC([1-4])([01])$/.exec(cmd))) { if (!P.SPEC_SERIES.has(this.series)) return refuse(1); this.limits[m[1]] = Number(m[2]); return `lC${m[1]}${m[2]}`; }
    if ((m = /^TAE([01])$/.exec(cmd))) { if (!P.SPEC_SERIES.has(this.series)) return refuse(1); this.tae = Number(m[1]); return `tAE${m[1]}`; }
    if ((m = /^AX([ZFI])([0-9A-F]{3})$/.exec(cmd))) { const v = clamp(parseInt(m[2], 16), 0x555, 0xFFF); s[{ Z: 'zoom', F: 'focus', I: 'irisPos' }[m[1]]] = v; return `ax${m[1].toLowerCase()}${m[2]}`; }
    if ((m = /^R(\d\d)$/.exec(cmd))) { const n = Number(m[1]); this.lastRecall = n; return `s${m[1]}`; }
    if ((m = /^M(\d\d)$/.exec(cmd))) { this.presets.add(Number(m[1])); return `s${m[1]}`; }
    if (cmd === 'DA1' || cmd === 'DA0') { s.tally = Number(cmd[2]); return `dA${s.tally}`; }
    if (cmd === 'D11' || cmd === 'D10') { s.af = Number(cmd[2]); this.raw.OAF = String(s.af); return `d1${s.af}`; }
    if (cmd === 'D31' || cmd === 'D30') { s.autoIris = Number(cmd[2]); return `d3${s.autoIris}`; }
    if ((m = /^I(\d\d)$/.exec(cmd))) { const n = Number(m[1]); if (n < 1) return refuse(3); s.iris = n; s.irisPos = Math.round(0x555 + ((n - 1) / 98) * (0xFFF - 0x555)); return `iC${m[1]}`; }
    if ((m = /^INS([01])$/.exec(cmd)) && this._allowed.has('ptz:INS0')) { s.ins = Number(m[1]); return `iNS${m[1]}`; }
    if ((m = /^UPVS(\d{3})$/.exec(cmd))) { const n = Number(m[1]); if (n < 1 || n > 999) return refuse(3); this.raw.uPVS = m[1]; return `uPVS${m[1]}`; }
    return refuse(1);
  }
  cam(cmd) {
    const s = this.s; const r = this.raw; let m;
    const refuse = (n) => `ER${n}:${cmd}`;
    if ((m = /^OSJ:35:(\d\d):(.{0,15})$/.exec(cmd)) && P.SPEC_SERIES.has(this.series)) { this.names[Number(m[1])] = m[2]; return cmd; }
    if (cmd === 'OSE:69:1') return this._allowed.has('cam:OSE:69:1') ? cmd : refuse(1);
    const bare = this._allowed.get(`cam:${cmd}`) && !this._allowed.get(`cam:${cmd}`).range && !this._allowed.get(`cam:${cmd}`).values && P.BY_ID.get(this._allowed.get(`cam:${cmd}`).id).type === 'button' ? this._allowed.get(`cam:${cmd}`) : null;
    let key; let val; let rule;
    if (bare) { key = cmd; rule = bare; } else {
      m = /^(.*):([^:]*)$/.exec(cmd); if (!m) return refuse(1);
      key = m[1]; val = m[2]; rule = this._allowed.get(`cam:${key}`);
      // the module's series lists end with ':' (OGU:, OSH:, OFT:, OSD:B1:): key includes it
      if (!rule) return refuse(1);
    }
    if (!s.power) return refuse(2);
    if (rule.range) { const n = parseInt(val, 16); if (!/^[0-9A-F]+$/.test(val) || n < rule.range.lo || n > rule.range.hi) return refuse(3); }
    if (rule.values && !rule.values.has(val)) return refuse(3);
    switch (rule.id) {
      case 'awb': case 'abb': return s.night ? refuse(3) : cmd;
      case 'menu': s.menu = val === '1' ? 1 : 0; r.OUS = String(s.menu); return cmd;
      case 'menuUp': case 'menuDown': case 'menuLeft': case 'menuRight': case 'menuEnter': case 'menuCancel': if (!s.menu) return refuse(2); s.menuMoves.push(cmd); return cmd;
      case 'shutterStepUp': case 'shutterStepDown': { const l = [60, 100, 120, 250, 500, 1000, 2000, 4000, 8000, 10000]; /* 59.94p steps (spec v2.94) */ const i = l.indexOf(parseInt(r['OSJ:06'], 16)); r['OSJ:06'] = H(l[clamp((i < 0 ? 1 : i) + (rule.id === 'shutterStepUp' ? 1 : -1), 0, l.length - 1)], 4); return cmd; }
      case 'synchroUp': case 'synchroDown': r['OSJ:09'] = H(clamp(parseInt(r['OSJ:09'], 16) + (rule.id === 'synchroUp' ? 1 : -1), 240, 72000), 5); return cmd;
      case 'varTempUp': case 'varTempDown': r['OSI:20'] = `${H(clamp(parseInt(r['OSI:20'], 16) + (rule.id === 'varTempUp' ? 100 : -100), 2000, 15000), 5)}:0`; return cmd;
      case 'varTemp': r['OSI:20'] = `${val}:0`; return cmd;
      case 'scene': r.OSF = String(Number(val) - 1); return cmd;
      case 'tallyRed': s.tally = Number(val); return cmd;
      case 'tallyGreen': s.tallyGreen = Number(val); return cmd;
      case 'gain': s.gain = val; r.OGU = val; return cmd;
      case 'shutter': s.shutter = val; r.OSH = val; return cmd;
      case 'wbMode': s.wb = val; r.OAW = val; return cmd;
      default: break;
    }
    r[key.replace(/:$/, '')] = val === undefined ? r[key] : val;
    return cmd;
  }
  camdata() {
    this._integrate();
    const s = this.s;
    const lines = ['', `OID:${this.model}`, `TITLE:${this.title}`, 'qSV3MOCK1.00', 'rER00', `p${s.power}`, `dA${s.tally}`, `TLR:${s.tally}`, `TLG:${s.tallyGreen}`,
      `OAF:${s.af}`, `d1${s.af}`, `d3${s.autoIris}`, `OGU:0x${s.gain}`, `iNS${s.ins}`,
      `aPC${H(s.pan, 4)}${H(s.tilt, 4)}`, `axz${H(s.zoom, 3)}`, `axf${H(s.focus, 3)}`, `axi${H(s.irisPos, 3)}`];
    if (P.SPEC_SERIES.has(this.series)) { for (const d of [1, 2, 3, 4]) lines.push(`lC${d}${this.limits[d]}`); lines.push(`tAE${this.tae}`); }
    for (const [k, v] of Object.entries(this.raw)) {
      if (['OGU', 'OAF'].includes(k)) continue;
      if (k === 'uPVS') lines.push(`uPVS${v}`);
      else if (/^[A-Z]{3}:[0-9A-F]{2}$/.test(k)) lines.push(`${k}:0x${v}`);
      else lines.push(`${k}:${v}`);
    }
    return lines.concat('').join('\r\n');
  }
  // spec Web CGI supplement 4.16; the mock draws an SVG "frame" (a real camera returns a JPEG)
  thumbnail(n) {
    const idx = n - 1; if (!this.presets.has(idx)) return null;
    const hue = (idx * 47) % 360;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,38%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},40%,14%)"/></linearGradient></defs>`
      + `<rect width="320" height="180" fill="url(#g)"/><rect x="${40 + (idx % 5) * 30}" y="70" width="70" height="90" rx="30" fill="rgba(0,0,0,.35)"/><circle cx="${75 + (idx % 5) * 30}" cy="58" r="22" fill="rgba(0,0,0,.35)"/>`
      + `<text x="12" y="26" font-family="monospace" font-size="16" fill="#fff" opacity=".85">${this.title} P${String(n).padStart(3, '0')}</text></svg>`;
  }
  snapshot() {
    this._integrate(); const s = this.s;
    const px = ((s.pan - 0x8000) / 0x5000) * 140; const ty = ((s.tilt - 0x8000) / 0x3000) * 70; const z = 1 + ((s.zoom - 0x555) / 0xAAA) * 2.2;
    const t = new Date(); const tc = [t.getHours(), t.getMinutes(), t.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b3e57"/><stop offset="1" stop-color="#0d131b"/></linearGradient></defs>`
      + `<rect width="640" height="360" fill="url(#s)"/><g transform="translate(${320 - px} ${200 + ty}) scale(${z.toFixed(2)})"><rect x="-150" y="20" width="300" height="12" fill="#3b2a1d"/><rect x="-40" y="-60" width="80" height="80" rx="34" fill="#1b2430"/><circle cx="0" cy="-82" r="24" fill="#1b2430"/><rect x="-220" y="-120" width="60" height="150" fill="#16202b"/><rect x="160" y="-100" width="70" height="130" fill="#16202b"/></g>`
      + `<text x="14" y="28" font-family="monospace" font-size="18" fill="#fff" opacity=".85">${this.title} · MOCK SNAPSHOT</text><text x="14" y="346" font-family="monospace" font-size="16" fill="#9fb3c8">${tc}  Z ${Math.round(((s.zoom - 0x555) / 0xAAA) * 100)}%</text>`
      + `<rect x="560" y="12" width="66" height="22" rx="4" fill="${s.tally ? '#d22' : '#333'}"/><text x="572" y="28" font-family="monospace" font-size="14" fill="#fff">TALLY</text></svg>`;
  }
  start(port = 0, host = '127.0.0.1') {
    this.server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      let body; let code = 200; let type = 'text/plain';
      if (u.pathname === '/cgi-bin/aw_ptz') {
        const raw = u.searchParams.get('cmd') || '';
        if (!raw.startsWith('#')) { body = `eR1:${raw}`; } else { const cmd = raw.slice(1); this.history.push({ path: 'aw_ptz', cmd, at: Date.now() }); body = this.ptz(cmd); }
      } else if (u.pathname === '/cgi-bin/aw_cam') {
        const cmd = u.searchParams.get('cmd') || ''; this.history.push({ path: 'aw_cam', cmd, at: Date.now() }); body = this.cam(cmd);
      } else if (u.pathname === '/live/camdata.html') { this.history.push({ path: 'camdata', cmd: '', at: Date.now() }); body = this.camdata(); }
      else if (u.pathname === '/cgi-bin/sdctrl') { const v = u.searchParams.get('save'); this.history.push({ path: 'web', cmd: `sdctrl?save=${v}`, at: Date.now() }); if (this._allowed.size && P.seriesSpec(this.series).caps.sdCard) { this.sd = v; body = 'OK'; } else { code = 404; body = 'not found'; } }
      else if (u.pathname === '/cgi-bin/get_preset_thumbnail') {
        this.history.push({ path: 'thumb', cmd: String(u.searchParams.get('preset_number')), at: Date.now() });
        const svg = P.SPEC_SERIES.has(this.series) ? this.thumbnail(Number(u.searchParams.get('preset_number'))) : null;
        if (svg) { body = svg; type = 'image/svg+xml'; } else { code = 404; body = 'not found'; }
      } else if (u.pathname === '/cgi-bin/camera') {
        // spec Web supplement 2.6: one JPEG per call; the mock draws an SVG placeholder frame with the live position
        this.history.push({ path: 'snapshot', cmd: String(u.searchParams.get('resolution') || ''), at: Date.now() });
        if (P.SPEC_SERIES.has(this.series)) { body = this.snapshot(); type = 'image/svg+xml'; } else { code = 404; body = 'not found'; }
      } else if (u.pathname === '/cgi-bin/get_rtsp') {
        this.history.push({ path: 'rtsp', cmd: '', at: Date.now() });
        if (P.SPEC_SERIES.has(this.series)) body = 'rtsp_port=554\r\nh264_rtsp_req_uri1=/MediaInput/h264/stream_1\r\nh264_rtsp_req_uri2=/MediaInput/h264/stream_2\r\nh265_rtsp_req_uri1=/MediaInput/h265/stream_1\r\n';
        else { code = 404; body = 'not found'; }
      } else { code = 404; body = 'not found'; }
      res.writeHead(code, { 'Content-Type': type, Connection: 'close' }); res.end(body);
    });
    return new Promise((r) => this.server.listen(port, host, () => r(this.server.address().port)));
  }
  stop() { return new Promise((r) => { if (!this.server) return r(); this.server.closeAllConnections && this.server.closeAllConnections(); this.server.close(() => r()); }); }
}

module.exports = { MockPTZ };
