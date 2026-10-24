'use strict';
// 0.12.0 scopes: mock camera RTSP server (pure Node) that streams an H.264 file like a Panasonic AW-UE150 does:
// rtsp://127.0.0.1:<port>/MediaInput/h264/stream_1..4, Digest auth (factory default admin / 12345 unless set),
// RTP over the RTSP TCP connection (interleaved) only, SPS/PPS in the SDP (sprop-parameter-sets) and in band.
// The picture runs on a wall clock, like a live camera: a new client joins mid-GOP and has to wait for an IDR.
// A test double for tests and --mock; it never contacts anything.
const net = require('net');
const crypto = require('crypto');
const H = require('../scopes/h264');
const { packetize } = require('../scopes/rtp');
const { loadFile } = require('../scopes/sources');

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

class MockRtspCamera {
  // streams: { '/MediaInput/h264/stream_1': '/path/file.h264' | {path, fps} }
  constructor({ streams = {}, user = 'admin', password = '12345', realm = 'AW-UE150 mock', auth = 'digest', joinLive = true } = {}) {
    this.streams = new Map(); for (const [p, v] of Object.entries(streams)) this.streams.set(p.toLowerCase(), typeof v === 'string' ? { path: v } : v);
    this.user = user; this.password = password; this.realm = realm; this.auth = auth; this.joinLive = joinLive;
    this.nonce = crypto.randomBytes(12).toString('hex'); this.sessions = new Set(); this.history = []; this.t0 = Date.now();
  }
  start(port = 0, host = '127.0.0.1') {
    this.server = net.createServer((s) => this._conn(s));
    return new Promise((res, rej) => { this.server.once('error', rej); this.server.listen(port, host, () => { this.port = this.server.address().port; res(this.port); }); });
  }
  stop() { for (const s of this.sessions) s.stop(); return new Promise((r) => (this.server ? this.server.close(() => r()) : r())); }
  _media(p) {
    const st = this.streams.get(p.toLowerCase()); if (!st) return null;
    if (!st.loaded) st.loaded = loadFile(st.path, { fps: st.fps });
    return st.loaded;
  }
  _checkAuth(method, h) {
    if (this.auth === 'none') return true;
    const a = h.authorization || '';
    if (this.auth === 'basic') return a === `Basic ${Buffer.from(`${this.user}:${this.password}`).toString('base64')}`;
    const p = {}; a.replace(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g, (_, k, x, y) => { p[k] = x !== undefined ? x : y; });
    if (!/^Digest /.test(a) || p.username !== this.user || p.nonce !== this.nonce) return false;
    return p.response === md5(`${md5(`${this.user}:${this.realm}:${this.password}`)}:${this.nonce}:${md5(`${method}:${p.uri}`)}`);
  }
  _conn(sock) {
    let buf = ''; let sess = null;
    const send = (code, reason, cseq, headers = {}, body = '') => {
      const h = { CSeq: cseq, Server: 'mock-rtsp-camera', ...headers }; if (body) h['Content-Length'] = Buffer.byteLength(body);
      sock.write(`RTSP/1.0 ${code} ${reason}\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${body}`);
    };
    sock.on('error', () => {}); sock.on('close', () => { if (sess) sess.stop(); });
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      for (;;) {
        while (buf.charCodeAt(0) === 0x24 && buf.length >= 4) { const l = (buf.charCodeAt(2) << 8) | buf.charCodeAt(3); if (buf.length < 4 + l) return; buf = buf.slice(4 + l); } // RTCP from the client
        const end = buf.indexOf('\r\n\r\n'); if (end < 0) return;
        const lines = buf.slice(0, end).split('\r\n'); const h = {};
        for (const l of lines.slice(1)) { const i = l.indexOf(':'); if (i > 0) h[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
        const len = Number(h['content-length'] || 0); if (buf.length < end + 4 + len) return;
        buf = buf.slice(end + 4 + len);
        const [method, uri] = lines[0].split(' '); const cseq = h.cseq;
        this.history.push({ method, uri, at: Date.now() });
        let u; try { u = new URL(uri.replace(/^rtsp:/i, 'http:')); } catch { send(400, 'Bad Request', cseq); continue; }
        const p = u.pathname.replace(/\/trackID=\d+$/i, '').replace(/\/+$/, '');
        if (method === 'OPTIONS') { send(200, 'OK', cseq, { Public: 'OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN, GET_PARAMETER' }); continue; }
        if (!this._checkAuth(method, h)) {
          send(401, 'Unauthorized', cseq, { 'WWW-Authenticate': this.auth === 'basic' ? `Basic realm="${this.realm}"` : `Digest realm="${this.realm}", nonce="${this.nonce}"` }); continue;
        }
        const media = this._media(p);
        if (!media && method !== 'TEARDOWN' && method !== 'GET_PARAMETER') { send(404, 'Not Found', cseq); continue; }
        if (method === 'DESCRIBE') {
          const sdp = ['v=0', `o=- ${this.t0} 1 IN IP4 127.0.0.1`, 's=Mock UE150 H.264', 'c=IN IP4 0.0.0.0', 't=0 0', 'a=control:*', 'a=range:npt=now-',
            'm=video 0 RTP/AVP 96', 'a=rtpmap:96 H264/90000',
            `a=fmtp:96 packetization-mode=1;profile-level-id=${media.sps.subarray(1, 4).toString('hex')};sprop-parameter-sets=${media.sps.toString('base64')},${media.pps.toString('base64')}`,
            `a=framerate:${media.fps}`, 'a=control:trackID=1', ''].join('\r\n');
          send(200, 'OK', cseq, { 'Content-Type': 'application/sdp', 'Content-Base': `rtsp://${u.host}${p}/` }, sdp); continue;
        }
        if (method === 'SETUP') {
          const tr = h.transport || '';
          if (!/RTP\/AVP\/TCP/i.test(tr)) { send(461, 'Unsupported Transport', cseq); continue; }
          const ch = Number((/interleaved=(\d+)/.exec(tr) || [0, 0])[1]);
          sess = new Session(this, sock, media, ch); this.sessions.add(sess);
          send(200, 'OK', cseq, { Transport: `RTP/AVP/TCP;unicast;interleaved=${ch}-${ch + 1}`, Session: `${sess.id};timeout=60` }); continue;
        }
        if (method === 'PLAY') { if (!sess) { send(455, 'Method Not Valid in This State', cseq); continue; } send(200, 'OK', cseq, { Session: sess.id, Range: 'npt=now-' }); sess.play(); continue; }
        if (method === 'GET_PARAMETER') { send(200, 'OK', cseq, sess ? { Session: sess.id } : {}); continue; }
        if (method === 'TEARDOWN') { send(200, 'OK', cseq); if (sess) sess.stop(); sock.end(); continue; }
        send(405, 'Method Not Allowed', cseq);
      }
    });
  }
}
class Session {
  constructor(cam, sock, media, ch) { this.cam = cam; this.sock = sock; this.media = media; this.ch = ch; this.id = crypto.randomBytes(4).toString('hex'); this.seq = Math.floor(Math.random() * 65535); this.timer = null; }
  play() {
    const { aus, fps } = this.media; const period = 1000 / fps;
    let i = this.cam.joinLive ? Math.floor((Date.now() - this.cam.t0) / period) : 0; const t0 = Date.now(); let n = 0;
    const ts0 = Math.floor(Math.random() * 0xffffffff);
    const tick = () => {
      if (this.stopped) return;
      const au = aus[i % aus.length];
      const r = packetize(au.nals, { seq: this.seq, ts: (ts0 + Math.round((n * 90000) / fps)) >>> 0 }); this.seq = r.seq;
      if (this.sock.writableLength < 4e6) for (const pkt of r.packets) { const hdr = Buffer.from([0x24, this.ch, pkt.length >> 8, pkt.length & 0xff]); this.sock.write(hdr); this.sock.write(pkt); }
      i++; n++;
      this.timer = setTimeout(tick, Math.max(0, t0 + n * period - Date.now()));
    };
    tick();
  }
  stop() { this.stopped = true; clearTimeout(this.timer); this.cam.sessions.delete(this); }
}

module.exports = { MockRtspCamera };
