'use strict';
// 0.12.0 scopes: relay inputs. Both emit 'au' {nals, key, pts (µs), broken}, 'params' {sps, pps}, 'status' {state, error}.
//   FileInput   a raw Annex-B .h264 / .264 file or a non-fragmented .mp4 / .mov / .m4v (H.264), paced at its frame rate
//               and looped (the "test camera"). Parsed once into memory; sending is a timer + socket writes.
//   RtspInput   rtsp://… (a camera), via RtspClient + H264Depacketizer, reconnecting with back-off.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const H = require('./h264');
const { RtspClient } = require('./rtsp-client');
const { H264Depacketizer } = require('./rtp');

const FILE_EXT = /\.(h264|264|avc|mp4|m4v|mov)$/i;
const MAX_FILE = 512 * 1024 * 1024;
function loadFile(file, { fps } = {}) {
  const st = fs.statSync(file); if (st.size > MAX_FILE) throw new Error(`${path.basename(file)} is larger than 512 MB`);
  const buf = fs.readFileSync(file);
  let sps; let pps; let aus; let rate = fps;
  if (/\.(mp4|m4v|mov)$/i.test(file)) { const m = H.demuxMp4(buf); ({ sps, pps, aus } = m); rate = rate || m.fps; }
  else {
    const nals = H.splitAnnexB(buf);
    if (!nals.length) throw new Error(`${path.basename(file)}: no H.264 start codes (is it Annex-B? MP4 files need the .mp4 extension)`);
    aus = H.splitAccessUnits(nals);
    sps = nals.find((n) => H.nalType(n) === H.NAL.SPS); pps = nals.find((n) => H.nalType(n) === H.NAL.PPS);
  }
  if (!sps || !pps) throw new Error(`${path.basename(file)}: no SPS / PPS found (not H.264, or H.265?)`);
  const info = H.parseSps(sps);
  rate = rate || info.fps || 30;
  const firstKey = aus.findIndex((a) => a.key); if (firstKey < 0) throw new Error(`${path.basename(file)}: no IDR frame`);
  aus = aus.slice(firstKey);
  // every key AU carries the parameter sets, so a looping / joining decoder can always start there
  for (const a of aus) if (a.key && !a.sps) { a.nals = [sps, pps, ...a.nals]; a.sps = sps; a.pps = pps; }
  return { sps, pps, aus, fps: rate, info, bytes: buf.length };
}

class FileInput extends EventEmitter {
  constructor(file, { fps, loop = true } = {}) { super(); this.file = file; this.fpsOpt = fps; this.loop = loop; this.timer = null; this.kind = 'file'; }
  start() {
    let m; try { m = loadFile(this.file, { fps: this.fpsOpt }); } catch (e) { setImmediate(() => this.emit('status', { state: 'error', error: e.message })); return this; }
    this.m = m; this.fps = m.fps;
    setImmediate(() => {
      this.emit('params', { sps: m.sps, pps: m.pps });
      this.emit('status', { state: 'playing' });
      const period = 1000 / m.fps; const t0 = Date.now(); let n = 0;
      const tick = () => {
        if (this.stopped) return;
        const i = n % m.aus.length; if (!this.loop && n >= m.aus.length) { this.emit('status', { state: 'ended' }); return; }
        const au = m.aus[i]; this.emit('au', { nals: au.nals, key: au.key, pts: Math.round((n * 1e6) / m.fps) });
        n++; this.timer = setTimeout(tick, Math.max(0, t0 + n * period - Date.now()));
      };
      tick();
    });
    return this;
  }
  stop() { this.stopped = true; clearTimeout(this.timer); }
}

class RtspInput extends EventEmitter {
  constructor(url, { user, pass, login, retryMs = 1000, maxRetryMs = 10000, resolveUrl } = {}) { super(); this.url = url; this.login = login; this.resolveUrl = resolveUrl; this.user = user; this.pass = pass; this.retryMs = retryMs; this.maxRetryMs = maxRetryMs; this.kind = 'rtsp'; this.backoff = retryMs; }
  start() { this._connect(); return this; }
  _connect() {
    if (this.stopped) return;
    // resolveUrl (optional): ask for the current URL first, e.g. the camera's own get_rtsp request URI
    if (this.resolveUrl && !this._resolved) {
      this._resolved = true;
      Promise.resolve().then(() => this.resolveUrl()).then((u) => { if (u) this.url = u; }, () => {}).then(() => { this._connect(); this._resolved = false; });
      return;
    }
    this.emit('status', { state: 'connecting', url: this.url.replace(/\/\/[^@/]*@/, '//') });
    if (this.login) { try { const l = this.login(); if (l) { this.user = l.user; this.pass = l.pass; } } catch { /* keep the last login */ } }
    const c = new RtspClient(this.url, { user: this.user, pass: this.pass }); this.client = c;
    const dep = new H264Depacketizer((au) => { this.backoff = this.retryMs; if (au.sps && au.pps) this.emit('params', { sps: au.sps, pps: au.pps }); this.emit('au', au); });
    c.on('sdp', (s) => { if (s.sps && s.pps) this.emit('params', { sps: s.sps, pps: s.pps }); });
    c.on('playing', () => this.emit('status', { state: 'playing' }));
    c.on('rtp', (p) => dep.push(p));
    c.on('error', (e) => {
      this.emit('status', { state: 'error', error: e.message, auth: !!e.auth });
      if (this.stopped) return;
      const wait = e.auth ? Math.max(this.backoff, 15000) : this.backoff; this.backoff = Math.min(this.maxRetryMs, this.backoff * 2);
      this.timer = setTimeout(() => this._connect(), wait);
    });
    c.start();
  }
  stop() { this.stopped = true; clearTimeout(this.timer); if (this.client) { this.client.removeAllListeners('error'); this.client.on('error', () => {}); this.client.stop(); } }
}

module.exports = { loadFile, FileInput, RtspInput, FILE_EXT };
