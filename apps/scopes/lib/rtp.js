'use strict';
// 0.12.0 scopes: RTP for H.264 (RFC 6184). Depacketizer (single NAL, STAP-A, FU-A; packetization-mode 0 and 1) that
// groups NAL units into access units by RTP timestamp / marker bit, and a packetizer used by the mock camera.
const { AccessUnitAssembler, makeAu } = require('./h264');

function parseRtp(pkt) {
  if (pkt.length < 12 || pkt[0] >> 6 !== 2) return null;
  const cc = pkt[0] & 0x0f; const ext = pkt[0] & 0x10; const pad = pkt[0] & 0x20;
  let off = 12 + cc * 4;
  if (ext) { if (off + 4 > pkt.length) return null; off += 4 + pkt.readUInt16BE(off + 2) * 4; }
  let end = pkt.length; if (pad) end -= pkt[pkt.length - 1];
  if (off > end) return null;
  return { marker: !!(pkt[1] & 0x80), pt: pkt[1] & 0x7f, seq: pkt.readUInt16BE(2), ts: pkt.readUInt32BE(4), ssrc: pkt.readUInt32BE(8), payload: pkt.subarray(off, end) };
}

class H264Depacketizer {
  // onAu({nals, key, sps, pps, rtpTs, pts (µs, unwrapped), broken})
  constructor(onAu, { clockRate = 90000 } = {}) {
    this.onAu = onAu; this.clock = clockRate; this.seq = null; this.ts = null; this.fu = null; this.lost = 0; this.packets = 0;
    this.tsBase = null; this.tsWrap = 0; this.lastTs = null;
    this.asm = new AccessUnitAssembler((au) => this._emit(au));
    this.curBroken = false;
  }
  _emit(au) { au.rtpTs = this.auTs; au.pts = this._pts(this.auTs); if (this.curBroken) au.broken = true; this.curBroken = false; this.onAu(au); }
  _pts(ts) { // 32-bit RTP timestamp -> monotonic µs
    if (ts === undefined || ts === null) return 0;
    if (this.tsBase === null) { this.tsBase = ts; this.lastTs = ts; }
    if (ts < this.lastTs && this.lastTs - ts > 0x80000000) this.tsWrap += 0x100000000;
    this.lastTs = ts;
    return Math.round(((ts + this.tsWrap - this.tsBase) * 1e6) / this.clock);
  }
  push(pkt) {
    const p = parseRtp(pkt); if (!p) return;
    this.packets++;
    if (this.seq !== null && p.seq !== ((this.seq + 1) & 0xffff)) { this.lost++; this.fu = null; this.curBroken = true; }
    this.seq = p.seq;
    if (this.ts !== null && p.ts !== this.ts) { this.asm.flush(); } // timestamp change = new picture
    if (this.asm.cur.length === 0 || this.ts !== p.ts) this.auTs = p.ts;
    this.ts = p.ts;
    const b = p.payload; if (!b.length) return;
    const t = b[0] & 0x1f;
    if (t >= 1 && t <= 23) this.asm.push(b);
    else if (t === 24) { // STAP-A
      let o = 1; while (o + 2 <= b.length) { const l = b.readUInt16BE(o); o += 2; if (o + l > b.length) break; this.asm.push(b.subarray(o, o + l)); o += l; }
    } else if (t === 28) { // FU-A
      if (b.length < 2) return;
      const s = b[1] & 0x80; const e = b[1] & 0x40;
      if (s) this.fu = [Buffer.from([(b[0] & 0xe0) | (b[1] & 0x1f)]), b.subarray(2)];
      else if (this.fu) this.fu.push(b.subarray(2));
      else { this.curBroken = true; return; } // middle of a fragment we never saw the start of
      if (e && this.fu) { this.asm.push(Buffer.concat(this.fu)); this.fu = null; }
    } else { /* STAP-B / MTAP / FU-B (mode 2) are not used by cameras in non-interleaved mode */ }
    if (p.marker) this.asm.flush(); // marker = last packet of the access unit: emit now, no extra latency
  }
}

// NAL units of one access unit -> RTP packets (single NAL ≤ mtu, else FU-A); marker on the last packet
function packetize(nals, { seq, ts, ssrc = 0x52533600, pt = 96, mtu = 1400 }) {
  const out = []; let s = seq;
  const hdr = (marker) => { const h = Buffer.alloc(12); h[0] = 0x80; h[1] = (marker ? 0x80 : 0) | pt; h.writeUInt16BE(s & 0xffff, 2); h.writeUInt32BE(ts >>> 0, 4); h.writeUInt32BE(ssrc >>> 0, 8); s++; return h; };
  nals.forEach((nal, i) => {
    const lastNal = i === nals.length - 1;
    if (nal.length <= mtu) { out.push(Buffer.concat([hdr(lastNal), nal])); return; }
    const ind = (nal[0] & 0xe0) | 28; const type = nal[0] & 0x1f;
    for (let o = 1; o < nal.length; o += mtu) {
      const end = Math.min(nal.length, o + mtu); const first = o === 1; const last = end === nal.length;
      out.push(Buffer.concat([hdr(lastNal && last), Buffer.from([ind, (first ? 0x80 : 0) | (last ? 0x40 : 0) | type]), nal.subarray(o, end)]));
    }
  });
  return { packets: out, seq: s & 0xffff };
}

module.exports = { parseRtp, H264Depacketizer, packetize, makeAu };
