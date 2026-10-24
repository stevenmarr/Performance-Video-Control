'use strict';
// 0.12.0 scopes: minimal RTSP 1.0 client (RFC 2326) for one H.264 video track, RTP interleaved over the RTSP TCP
// connection (no UDP ports to open on the Pi, survives NAT / firewalls, no packet loss). Basic and Digest auth.
// Emits: 'sdp' {sps, pps, control, sdp}, 'rtp' (Buffer, channel 0 only), 'playing', 'error', 'close'.
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
function parseUrl(u) {
  const m = /^rtsps?:\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^/:]+|\[[^\]]+\])(?::(\d+))?(\/.*)?$/i.exec(u);
  if (!m) throw new Error(`bad RTSP URL: ${u}`);
  const user = m[1] ? decodeURIComponent(m[1]) : ''; const pass = m[2] ? decodeURIComponent(m[2]) : '';
  const host = m[3]; const port = Number(m[4] || 554); const p = m[5] || '/';
  return { user, pass, host, port, path: p, clean: `rtsp://${host}${m[4] ? `:${m[4]}` : ''}${p}` };
}
function parseAuth(headers) {
  const list = [].concat(headers['www-authenticate'] || []);
  const digest = list.find((h) => /^digest/i.test(h)); const basic = list.find((h) => /^basic/i.test(h));
  if (digest) { const p = {}; digest.replace(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g, (_, k, a, b) => { p[k.toLowerCase()] = a !== undefined ? a : b; }); return { scheme: 'digest', ...p }; }
  if (basic) return { scheme: 'basic' };
  return null;
}
function parseSdp(sdp, base) {
  const out = { sps: null, pps: null, control: null, pt: 96, packetizationMode: 0 };
  let inVideo = false; let sessionControl = null;
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith('m=')) { inVideo = line.startsWith('m=video'); if (inVideo) out.pt = Number(line.split(' ')[3]); continue; }
    if (!inVideo) { if (line.startsWith('a=control:')) sessionControl = line.slice(10).trim(); continue; }
    if (line.startsWith('a=rtpmap:') && !/H264\//i.test(line)) { if (/H265|HEVC/i.test(line)) out.codecError = 'the stream is H.265 (HEVC): set the camera stream to H.264'; }
    if (line.startsWith('a=control:')) out.control = line.slice(10).trim();
    if (line.startsWith('a=fmtp:')) {
      const sp = /sprop-parameter-sets=([^;\s]+)/.exec(line);
      if (sp) { const [a, b] = sp[1].split(','); if (a) out.sps = Buffer.from(a, 'base64'); if (b) out.pps = Buffer.from(b, 'base64'); }
      const pm = /packetization-mode=(\d)/.exec(line); if (pm) out.packetizationMode = Number(pm[1]);
    }
  }
  const c = out.control || sessionControl || '*';
  out.controlUrl = /^rtsp:\/\//i.test(c) ? c : c === '*' ? base : base.replace(/\/?$/, '/') + c;
  return out;
}

class RtspClient extends EventEmitter {
  constructor(url, { user, pass, timeoutMs = 8000, userAgent = 'pv-control-center scopes' } = {}) {
    super();
    const u = parseUrl(url);
    this.u = u; this.user = user !== undefined && user !== '' ? user : u.user; this.pass = pass !== undefined && pass !== '' ? pass : u.pass;
    this.url = u.clean; this.timeoutMs = timeoutMs; this.ua = userAgent;
    this.cseq = 0; this.buf = Buffer.alloc(0); this.pending = null; this.auth = null; this.session = null; this.keepalive = null; this.closed = false;
  }
  start() {
    this.sock = net.connect({ host: this.u.host.replace(/^\[|\]$/g, ''), port: this.u.port });
    this.sock.setNoDelay(true);
    this.sock.setTimeout(this.timeoutMs * 2, () => this._fail(new Error('RTSP: no data (timeout)')));
    this.sock.on('data', (d) => this._data(d));
    this.sock.on('error', (e) => this._fail(e));
    this.sock.on('close', () => { if (!this.closed) this._fail(new Error('RTSP: connection closed by the camera')); });
    this.sock.once('connect', () => this._run().catch((e) => this._fail(e)));
    return this;
  }
  _fail(e) { if (this.closed) return; this.closed = true; clearInterval(this.keepalive); try { this.sock.destroy(); } catch { /* */ } if (this.pending) { this.pending.reject(e); this.pending = null; } this.emit('error', e); this.emit('close'); }
  stop() {
    if (this.closed) return; this.closed = true; clearInterval(this.keepalive);
    try { if (this.session) this.sock.write(this._req('TEARDOWN', this.url, {})); } catch { /* */ }
    setTimeout(() => { try { this.sock.destroy(); } catch { /* */ } }, 50);
    this.emit('close');
  }
  _authHeader(method, uri) {
    const a = this.auth; if (!a) return null;
    if (a.scheme === 'basic') return `Basic ${Buffer.from(`${this.user}:${this.pass}`).toString('base64')}`;
    const ha1 = md5(`${this.user}:${a.realm}:${this.pass}`); const ha2 = md5(`${method}:${uri}`);
    if (a.qop && /auth/.test(a.qop)) {
      this.nc = (this.nc || 0) + 1; const nc = this.nc.toString(16).padStart(8, '0'); const cn = crypto.randomBytes(8).toString('hex');
      return `Digest username="${this.user}", realm="${a.realm}", nonce="${a.nonce}", uri="${uri}", qop=auth, nc=${nc}, cnonce="${cn}", response="${md5(`${ha1}:${a.nonce}:${nc}:${cn}:auth:${ha2}`)}"${a.opaque ? `, opaque="${a.opaque}"` : ''}`;
    }
    return `Digest username="${this.user}", realm="${a.realm}", nonce="${a.nonce}", uri="${uri}", response="${md5(`${ha1}:${a.nonce}:${ha2}`)}"${a.opaque ? `, opaque="${a.opaque}"` : ''}`;
  }
  _req(method, uri, headers) {
    const h = { CSeq: ++this.cseq, 'User-Agent': this.ua, ...headers };
    const auth = this._authHeader(method, uri); if (auth) h.Authorization = auth;
    if (this.session) h.Session = this.session;
    return `${method} ${uri} RTSP/1.0\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`;
  }
  async request(method, uri, headers = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await new Promise((resolve, reject) => {
        this.pending = { resolve, reject };
        const t = setTimeout(() => { if (this.pending) { this.pending = null; reject(new Error(`RTSP ${method}: no answer`)); } }, this.timeoutMs);
        this.pending.resolve = (r) => { clearTimeout(t); resolve(r); }; this.pending.reject = (e) => { clearTimeout(t); reject(e); };
        this.sock.write(this._req(method, uri, headers));
      });
      if (res.status === 401 && attempt === 0) {
        const a = parseAuth(res.headers); if (!a) throw new Error('RTSP 401: no supported auth scheme');
        if (!this.user) throw Object.assign(new Error('RTSP 401: the camera wants a user name and password'), { auth: true });
        this.auth = a; continue;
      }
      if (res.status === 401) throw Object.assign(new Error('RTSP 401: user name or password rejected'), { auth: true });
      if (res.status !== 200) throw new Error(`RTSP ${method}: ${res.status} ${res.reason}`);
      return res;
    }
    throw new Error('unreachable');
  }
  _data(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      if (!this.buf.length) return;
      if (this.buf[0] === 0x24) { // '$' interleaved binary frame
        if (this.buf.length < 4) return;
        const len = this.buf.readUInt16BE(2); if (this.buf.length < 4 + len) return;
        const ch = this.buf[1]; const pkt = this.buf.subarray(4, 4 + len); this.buf = this.buf.subarray(4 + len);
        if (ch === this.rtpChannel) this.emit('rtp', pkt);
        continue;
      }
      const end = this.buf.indexOf('\r\n\r\n'); if (end < 0) { if (this.buf.length > 65536) this._fail(new Error('RTSP: garbage from the camera')); return; }
      const head = this.buf.toString('latin1', 0, end).split('\r\n'); const headers = {};
      for (const l of head.slice(1)) { const i = l.indexOf(':'); if (i > 0) { const k = l.slice(0, i).trim().toLowerCase(); const v = l.slice(i + 1).trim(); headers[k] = headers[k] ? [].concat(headers[k], v) : v; } }
      const len = Number(headers['content-length'] || 0); if (this.buf.length < end + 4 + len) return;
      const body = this.buf.toString('utf8', end + 4, end + 4 + len); this.buf = this.buf.subarray(end + 4 + len);
      const m = /^RTSP\/1\.\d (\d+) ?(.*)$/.exec(head[0]);
      if (m && this.pending) { const p = this.pending; this.pending = null; p.resolve({ status: Number(m[1]), reason: m[2], headers, body }); }
    }
  }
  async _run() {
    await this.request('OPTIONS', this.url);
    const d = await this.request('DESCRIBE', this.url, { Accept: 'application/sdp' });
    const base = [].concat(d.headers['content-base'] || d.headers['content-location'] || this.url)[0];
    const sdp = parseSdp(d.body, base);
    if (sdp.codecError) throw new Error(sdp.codecError);
    this.emit('sdp', sdp);
    this.rtpChannel = 0;
    const s = await this.request('SETUP', sdp.controlUrl, { Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1' });
    const sess = String([].concat(s.headers.session)[0] || ''); this.session = sess.split(';')[0];
    const to = /timeout=(\d+)/.exec(sess); const ka = Math.max(5, (to ? Number(to[1]) : 60) / 2) * 1000;
    const tr = /interleaved=(\d+)/.exec(String(s.headers.transport || '')); if (tr) this.rtpChannel = Number(tr[1]);
    await this.request('PLAY', [].concat(base)[0], { Range: 'npt=0.000-' });
    this.sock.setTimeout(this.timeoutMs * 2); // data must keep coming
    this.emit('playing');
    // keep-alive: GET_PARAMETER is answered while RTP flows (the response is parsed between interleaved frames)
    this.keepalive = setInterval(() => { if (!this.closed && !this.pending) this.sock.write(this._req('GET_PARAMETER', this.url, {})); }, ka);
  }
}

module.exports = { RtspClient, parseUrl, parseSdp, parseAuth };
