'use strict';
// Blackmagic HyperDeck Ethernet Protocol (TCP 9993). Record / play / stop are
// the transport machine in the core. This driver sends the words and keeps the
// clip list, transport, timecode, and remaining time the deck reports.
// Connecting only reads: notify transport, slot info, clips get, transport info.
// It does not record, play, stop, or seek.
const net = require('net');

const COMMANDS = {
  record: 'record',
  play: 'play',
  stop: 'stop',
  preview: 'preview: enable: true',
  info: 'transport info',
};

const READS_ON_CONNECT = ['notify: transport: true', 'slot info', 'clips get', 'transport info'];

class HyperDeckDriver {
  constructor(conn = {}, log = () => {}, onChange = () => {}) {
    this.system = 'hyperdeck';
    this.log = log;
    this.onChange = onChange;
    this.capabilities = { hyperdeck: true, transport: true, clips: true };
    this.st = { connected: false, info: null, error: null, lastSeen: 0 };
    this.sock = null;
    this.buf = '';
    this.waiters = [];
    this.transport = blankTransport();
    this.slot = blankSlot();
    this.clips = [];
    this.configure(conn);
  }
  configure(conn) { this.close(); this.conn = { host: '', port: 9993, ...conn }; }
  status() { return { ...this.st, info: this.st.info ? { ...this.st.info } : null }; }
  close() {
    if (this.sock) { try { this.sock.destroy(); } catch { /* already closed */ } }
    this.sock = null;
    this.st.connected = false;
    const pending = this.waiters;
    this.waiters = [];
    for (const w of pending) w.reject(new Error('HyperDeck closed'));
  }
  _changed() { if (this._chg) return; this._chg = setTimeout(() => { this._chg = null; this.onChange(); }, 20); if (this._chg.unref) this._chg.unref(); }

  connect() {
    if (!this.conn.host) return Promise.reject(new Error('HyperDeck: no IP address set (SYSTEMS tab)'));
    this.close();
    this.buf = '';
    this.clips = [];
    this.transport = blankTransport();
    this.slot = blankSlot();
    const sock = net.connect({ host: this.conn.host, port: Number(this.conn.port) || 9993 });
    this.sock = sock;
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => this._data(chunk));
    sock.on('close', () => { this.st.connected = false; this._changed(); });
    sock.on('error', () => {});
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.st.error = 'no answer'; this.close(); reject(new Error(`HyperDeck ${this.conn.host}: no answer within 4 s`)); }, 4000);
      sock.once('error', (e) => { clearTimeout(timer); this.close(); reject(new Error(`HyperDeck: ${e.message}`)); });
      this._hello = (info) => {
        clearTimeout(timer);
        this._hello = null;
        // Queries only. A deck that refuses one read (an empty timeline) stays connected.
        this._prime().then(() => resolve(info), () => resolve(info));
      };
    });
  }
  async _prime() {
    for (const line of READS_ON_CONNECT) {
      try { await this._command(line); } catch { /* read failed; the link itself is up */ }
    }
  }
  async heartbeat() {
    if (!this.sock || !this.st.connected) throw new Error(this.st.error || 'not connected');
    await this._command('transport info');
    const clip = this.transport.clip;
    if (clip != null && !this.clips.some((c) => String(c.id) === String(clip))) {
      try { await this._command('clips get'); } catch { /* recording can start before a clip id exists */ }
    }
  }
  _data(chunk) {
    this.buf += String(chunk).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const parts = this.buf.split('\n\n');
    this.buf = parts.pop();
    for (const part of parts) if (part.trim()) this._response(part);
  }
  _response(text) {
    const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length);
    const head = lines[0] || '';
    const code = Number(head.slice(0, 3));
    this.st.lastSeen = Date.now();
    if (head.startsWith('500 connection info')) {
      const model = field(lines, 'model') || 'HyperDeck';
      this.st.connected = true;
      this.st.error = null;
      this.st.info = { model, version: field(lines, 'protocol version') || '' };
      if (this._hello) this._hello(this.st.info);
      this._changed();
      return;
    }
    if (code === 208 || code === 508) this._transport(lines);
    else if (code === 205 || code === 519) this._clips(lines);
    else if (code === 202 || code === 502) this._slot(lines);
    // 5xx is an asynchronous notice (notify). It is not the answer to the command in flight.
    if (code >= 500 && code <= 599) return;
    const waiter = this.waiters[0];
    if (!waiter) return;
    if (code >= 200 && code < 300) waiter.resolve({ code, lines });
    else waiter.reject(Object.assign(new Error(head || 'HyperDeck refused the command'), { status: 409 }));
  }
  _transport(lines) {
    const timeline = field(lines, 'timecode');
    const display = field(lines, 'display timecode') || timeline;
    const prev = this.transport;
    this.transport = {
      status: (field(lines, 'status') || prev.status || 'stopped').toLowerCase(),
      speed: numberOr(field(lines, 'speed'), prev.speed || 0),
      slot: idOf(field(lines, 'slot id')),
      clip: idOf(field(lines, 'clip id')),
      timecode: display || null,
      timeline: timeline || null,
      videoFormat: field(lines, 'video format') || prev.videoFormat || '',
      loop: field(lines, 'loop') === 'true',
      singleClip: field(lines, 'single clip') === 'true',
      elapsed: null,
      remaining: null,
    };
    if (this.transport.slot == null) this.transport.slot = prev.slot == null ? 1 : prev.slot;
    this._retime();
    this._changed();
  }
  _clips(lines) {
    const clips = [];
    for (const line of lines.slice(1)) {
      const clip = parseClipLine(line);
      if (clip) clips.push(clip);
    }
    this.clips = clips;
    this._retime();
    this._changed();
  }
  _slot(lines) {
    const recording = field(lines, 'recording time');
    this.slot = {
      id: idOf(field(lines, 'slot id')),
      name: field(lines, 'slot name') || '',
      status: (field(lines, 'status') || '').toLowerCase(),
      volume: field(lines, 'volume name') || '',
      recordingTime: recording === '' ? null : Number(recording),
      videoFormat: field(lines, 'video format') || '',
    };
    if (!this.transport.videoFormat && this.slot.videoFormat) {
      this.transport.videoFormat = this.slot.videoFormat;
      this._retime();
    }
    this._changed();
  }
  // Remaining time is the current clip's duration minus where the timeline is
  // sitting. Slot "recording time" is free disk, not the clip.
  _retime() {
    const t = this.transport;
    const clip = this.clips.find((c) => String(c.id) === String(t.clip));
    const fps = frameRate(t.videoFormat || this.slot.videoFormat);
    const clock = clip ? clipClock(clip, t.timeline || t.timecode, fps) : null;
    t.elapsed = clock ? clock.elapsed : null;
    t.remaining = clock ? clock.remaining : null;
  }
  _command(line) {
    if (!this.sock || !this.st.connected) return Promise.reject(Object.assign(new Error('HyperDeck not connected'), { status: 409 }));
    return new Promise((resolve, reject) => {
      let settled = false;
      const row = {
        resolve: (v) => finish(resolve, v),
        reject: (e) => finish(reject, e),
      };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== row);
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, new Error('HyperDeck did not answer')), 4000);
      if (timer.unref) timer.unref();
      this.waiters.push(row);
      this.sock.write(`${line}\n`, (err) => { if (err) row.reject(err); });
    });
  }
  _optimistic(name) {
    if (name === 'record') this.transport.status = 'record';
    else if (name === 'play' || name === 'speed') this.transport.status = 'play';
    else if (name === 'stop') this.transport.status = 'stopped';
    else if (name === 'preview' || name === 'previewOff') this.transport.status = 'preview';
  }
  async transportCmd(name, body = {}) {
    let line = COMMANDS[name];
    if (name === 'clips') line = 'clips get';
    else if (name === 'goto' || name === 'select') line = `goto: clip id: ${Math.round(Number(body.clip != null ? body.clip : body.value) || 1)}`;
    else if (name === 'slot') line = `slot select: slot id: ${Math.round(Number(body.slot != null ? body.slot : body.value) || 1)}`;
    else if (name === 'speed') line = `play: speed: ${Number(body.speed != null ? body.speed : body.value) || 0}`;
    else if (name === 'previewOff') line = 'preview: enable: false';
    if (!line) throw Object.assign(new Error('HyperDeck command is record, play, stop, preview, goto, slot, speed, or clips'), { status: 404 });
    const r = await this._command(line);
    const moves = name === 'record' || name === 'play' || name === 'stop' || name === 'preview' || name === 'previewOff' || name === 'speed' || name === 'goto' || name === 'select';
    if (moves) {
      try { await this._command('transport info'); } catch { this._optimistic(name); }
    }
    if (name === 'slot') {
      try { await this._command('slot info'); } catch { /* the select itself was accepted */ }
      try { await this._command('clips get'); } catch { /* the new slot can be empty */ }
      try { await this._command('transport info'); } catch { this._optimistic(name); }
    }
    this._changed();
    const out = { ok: true, status: this.transport.status, code: r.code, timecode: this.transport.timecode, elapsed: this.transport.elapsed, remaining: this.transport.remaining, clip: this.transport.clip };
    if (name === 'clips') out.clips = this.clips.map((c) => ({ ...c }));
    return out;
  }
  view() {
    const t = this.transport;
    const clip = this.clips.find((c) => String(c.id) === String(t.clip)) || null;
    return {
      transport: { ...t },
      timecode: t.timecode,
      elapsed: t.elapsed,
      remaining: t.remaining,
      slot: { ...this.slot },
      clip: t.clip,
      clipName: clip ? clip.name : null,
      clips: this.clips.map((c) => ({ ...c })),
      variables: {
        connected: this.st.connected ? 'true' : 'false',
        transport: t.status || '',
        timecode: t.timecode || '',
        slot: t.slot == null ? '' : String(t.slot),
        clip: t.clip == null ? '' : String(t.clip),
        elapsed: t.elapsed || '',
        remaining: t.remaining || '',
        clips: this.clips.map((c) => c.name || c.id).join(', '),
      },
      modes: ['record', 'play', 'stop', 'preview', 'previewOff', 'goto', 'slot', 'speed', 'clips'],
    };
  }
}

function blankTransport() {
  return { status: 'stopped', speed: 0, slot: 1, clip: null, timecode: null, timeline: null, videoFormat: '', loop: false, singleClip: false, elapsed: null, remaining: null };
}
function blankSlot() {
  return { id: null, name: '', status: '', volume: '', recordingTime: null, videoFormat: '' };
}
function field(lines, name) {
  const row = lines.find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return row ? row.slice(row.indexOf(':') + 1).trim() : '';
}
function idOf(v) {
  if (v == null || v === '' || String(v).toLowerCase() === 'none') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : String(v);
}
function numberOr(v, fallback) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Version 2 puts the name last (four timecodes, then the name) so a name may
// contain spaces. Version 1 is "name start duration", which is what a plain
// "clips get" returns.
function parseClipLine(line) {
  const m = /^(\d+):\s*(.*)$/.exec(String(line || '').trim());
  if (!m) return null;
  const id = Number(m[1]);
  const rest = m[2].trim();
  const v2 = /^(\d{2}:\d{2}:\d{2}:\d{2})\s+(\d{2}:\d{2}:\d{2}:\d{2})\s+(\d{2}:\d{2}:\d{2}:\d{2})\s+(\d{2}:\d{2}:\d{2}:\d{2})(?:\s+(.*))?$/.exec(rest);
  if (v2) return { id, name: (v2[5] || '').trim(), start: v2[1], duration: v2[2], in: v2[3], out: v2[4] };
  const v1 = /^(.*?)(?:\s+)?(\d{2}:\d{2}:\d{2}:\d{2})\s+(\d{2}:\d{2}:\d{2}:\d{2})$/.exec(rest);
  if (v1) return { id, name: v1[1].trim(), start: v1[2], duration: v1[3], in: null, out: null };
  if (!rest) return null;
  return { id, name: rest, start: null, duration: null, in: null, out: null };
}

function frameRate(format) {
  const s = String(format || '');
  if (/23\.?976|23\.98/.test(s)) return 24;
  if (/29\.?97/.test(s)) return 30;
  if (/59\.?94/.test(s)) return 60;
  if (/ntsc/i.test(s)) return 30;
  if (/^pal$/i.test(s) || /palp/i.test(s)) return 25;
  const m = /[pi](\d{2,3}(?:\.\d+)?)/i.exec(s);
  const n = m ? Number(m[1]) : 0;
  if (n >= 23 && n < 24) return 24;
  if (n >= 29 && n < 30) return 30;
  if (n >= 59 && n < 60) return 60;
  if (n >= 1 && n <= 120) return Math.round(n);
  return 30;
}
function tcFrames(tc, fps) {
  const m = /^(\d{2}):(\d{2}):(\d{2}):(\d{2})$/.exec(String(tc || '').trim());
  if (!m || !fps) return null;
  return ((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * fps) + Number(m[4]);
}
function framesToTc(frames, fps) {
  const f = ((frames % fps) + fps) % fps;
  let sec = Math.floor(frames / fps);
  const s = ((sec % 60) + 60) % 60;
  sec = Math.floor(sec / 60);
  const min = ((sec % 60) + 60) % 60;
  const h = Math.floor(sec / 60);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(h)}:${p(min)}:${p(s)}:${p(f)}`;
}
function clipClock(clip, position, fps) {
  const dur = tcFrames(clip.duration, fps);
  const cur = tcFrames(position, fps);
  const start = tcFrames(clip.start, fps);
  if (dur == null || cur == null) return null;
  let elapsed = cur;
  if (start != null && cur >= start && (cur - start) <= dur) elapsed = cur - start;
  else if (cur > dur) elapsed = dur;
  if (elapsed < 0) elapsed = 0;
  if (elapsed > dur) elapsed = dur;
  return { elapsed: framesToTc(elapsed, fps), remaining: framesToTc(dur - elapsed, fps) };
}

module.exports = { HyperDeckDriver, COMMANDS, parseClipLine, clipClock, frameRate };
