'use strict';
// 0.12.0 scopes: H.264 bitstream helpers for the stream relay (no decoding, no deps).
//   splitAnnexB(buf)            Annex-B byte stream -> NAL unit views (start codes removed)
//   parseSps(nal)               profile / level / size / cropping / VUI range + colour + timing (ITU-T H.264 7.3.2.1.1, E.1.1)
//   AccessUnitAssembler         NAL units (decode order) -> access units (7.4.1.2.3: AUD / SPS / PPS / SEI or the first VCL
//                               NAL of a new picture start a new AU)
//   avcC(sps, pps), toAvcc(nals), codecString(sps)   what a browser decoder (WebCodecs / MSE) needs
//   demuxMp4(buf)               non-fragmented MP4 / MOV with one avc1/avc3 track -> {sps, pps, aus, fps}
const NAL = { SLICE: 1, IDR: 5, SEI: 6, SPS: 7, PPS: 8, AUD: 9, END_SEQ: 10, END_STREAM: 11, FILLER: 12 };
const nalType = (nal) => nal[0] & 0x1f;
const isVcl = (t) => t >= 1 && t <= 5;

function splitAnnexB(buf) {
  const out = []; const n = buf.length; let i = 0; let start = -1;
  while (i + 2 < n) {
    if (buf[i] === 0 && buf[i + 1] === 0 && (buf[i + 2] === 1 || (buf[i + 2] === 0 && i + 3 < n && buf[i + 3] === 1))) {
      const sc = buf[i + 2] === 1 ? 3 : 4;
      if (start >= 0) { let end = i; while (end > start && buf[end - 1] === 0) end--; if (end > start) out.push(buf.subarray(start, end)); }
      i += sc; start = i; continue;
    }
    i++;
  }
  if (start >= 0 && start < n) out.push(buf.subarray(start, n));
  return out;
}
// Remove emulation-prevention bytes (00 00 03 -> 00 00)
function unescapeRbsp(nal) {
  const out = Buffer.alloc(nal.length); let o = 0; let zeros = 0;
  for (let i = 0; i < nal.length; i++) {
    const b = nal[i];
    if (zeros >= 2 && b === 3) { zeros = 0; continue; }
    out[o++] = b; zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, o);
}
class BitReader {
  constructor(buf) { this.b = buf; this.p = 0; }
  bit() { if (this.p >= this.b.length * 8) throw new Error('SPS truncated'); const v = (this.b[this.p >> 3] >> (7 - (this.p & 7))) & 1; this.p++; return v; }
  bits(n) { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + this.bit(); return v; }
  ue() { let z = 0; while (this.bit() === 0) { z++; if (z > 31) throw new Error('bad exp-Golomb'); } return z ? (2 ** z - 1) + this.bits(z) : 0; }
  se() { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -(k / 2); }
}
const HIGH = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);
function parseSps(nal) {
  if (nalType(nal) !== NAL.SPS) throw new Error('not an SPS');
  const r = new BitReader(unescapeRbsp(nal.subarray(1)));
  const s = { profileIdc: r.bits(8), constraints: r.bits(8), levelIdc: r.bits(8) };
  s.id = r.ue(); s.chromaFormatIdc = 1; s.bitDepthLuma = 8; s.bitDepthChroma = 8; let separate = 0;
  if (HIGH.has(s.profileIdc)) {
    s.chromaFormatIdc = r.ue(); if (s.chromaFormatIdc === 3) separate = r.bit();
    s.bitDepthLuma = 8 + r.ue(); s.bitDepthChroma = 8 + r.ue(); r.bit();
    if (r.bit()) { // seq_scaling_matrix_present_flag: skip the lists
      for (let i = 0; i < (s.chromaFormatIdc !== 3 ? 8 : 12); i++) {
        if (!r.bit()) continue;
        let last = 8; let next = 8; const size = i < 6 ? 16 : 64;
        for (let j = 0; j < size; j++) { if (next !== 0) next = (last + r.se() + 256) % 256; last = next === 0 ? last : next; }
      }
    }
  }
  r.ue(); // log2_max_frame_num_minus4
  s.pocType = r.ue();
  if (s.pocType === 0) r.ue();
  else if (s.pocType === 1) { r.bit(); r.se(); r.se(); const n = r.ue(); for (let i = 0; i < n; i++) r.se(); }
  s.maxRefFrames = r.ue(); r.bit();
  const wMbs = r.ue() + 1; const hMapUnits = r.ue() + 1; const frameMbsOnly = r.bit();
  if (!frameMbsOnly) r.bit();
  r.bit();
  let crop = [0, 0, 0, 0];
  if (r.bit()) crop = [r.ue(), r.ue(), r.ue(), r.ue()];
  const subW = s.chromaFormatIdc === 1 || s.chromaFormatIdc === 2 ? 2 : 1; const subH = s.chromaFormatIdc === 1 ? 2 : 1;
  const cux = s.chromaFormatIdc === 0 || separate ? 1 : subW; const cuy = (s.chromaFormatIdc === 0 || separate ? 1 : subH) * (2 - frameMbsOnly);
  s.codedWidth = wMbs * 16; s.codedHeight = hMapUnits * 16 * (2 - frameMbsOnly);
  s.width = s.codedWidth - cux * (crop[0] + crop[1]); s.height = s.codedHeight - cuy * (crop[2] + crop[3]);
  s.interlaced = !frameMbsOnly;
  s.fullRange = null; s.colour = null; s.fps = null;
  try {
    if (r.bit()) { // VUI
      if (r.bit()) { const idc = r.bits(8); if (idc === 255) { r.bits(16); r.bits(16); } }
      if (r.bit()) r.bit();
      if (r.bit()) { r.bits(3); s.fullRange = !!r.bit(); if (r.bit()) s.colour = { primaries: r.bits(8), transfer: r.bits(8), matrix: r.bits(8) }; }
      if (r.bit()) { r.ue(); r.ue(); }
      if (r.bit()) { const units = r.bits(32); const scale = r.bits(32); r.bit(); if (units > 0) s.fps = Math.round((scale / (2 * units)) * 1000) / 1000; }
    }
  } catch { /* a truncated VUI keeps what was read */ }
  return s;
}
const hex2 = (v) => v.toString(16).padStart(2, '0');
const codecString = (sps) => `avc1.${hex2(sps[1])}${hex2(sps[2])}${hex2(sps[3])}`;
// AVCDecoderConfigurationRecord (ISO/IEC 14496-15 5.3.3.1)
function avcC(sps, pps) {
  const head = Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1]);
  const len = (b) => { const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return l; };
  const parts = [head, len(sps), sps, Buffer.from([1]), len(pps), pps];
  if ([100, 110, 122, 144].includes(sps[1])) {
    let i = { chromaFormatIdc: 1, bitDepthLuma: 8, bitDepthChroma: 8 }; try { i = parseSps(sps); } catch { /* defaults */ }
    parts.push(Buffer.from([0xfc | i.chromaFormatIdc, 0xf8 | (i.bitDepthLuma - 8), 0xf8 | (i.bitDepthChroma - 8), 0]));
  }
  return Buffer.concat(parts);
}
// NAL units -> one AVCC sample (4-byte big-endian length before each NAL)
function toAvcc(nals) {
  let size = 0; for (const n of nals) size += 4 + n.length;
  const out = Buffer.allocUnsafe(size); let o = 0;
  for (const n of nals) { out.writeUInt32BE(n.length, o); n.copy(out, o + 4); o += 4 + n.length; }
  return out;
}
// first_mb_in_slice == 0  <=>  the first bit after the NAL header is 1 (ue(v) of 0 is the single bit '1')
const firstMbIsZero = (nal) => nal.length > 1 && (nal[1] & 0x80) !== 0;

class AccessUnitAssembler {
  constructor(onAu) { this.onAu = onAu; this.cur = []; this.hasVcl = false; this.broken = false; }
  push(nal, meta) {
    const t = nalType(nal);
    if (this.hasVcl && (t === NAL.AUD || t === NAL.SPS || t === NAL.PPS || t === NAL.SEI || (t >= 14 && t <= 18) || (isVcl(t) && firstMbIsZero(nal)))) this.flush();
    if (meta && meta.broken) this.broken = true;
    if (meta && meta.pts !== undefined && this.pts === undefined) this.pts = meta.pts;
    this.cur.push(nal); if (isVcl(t)) this.hasVcl = true;
  }
  markBroken() { this.broken = true; }
  flush() {
    if (!this.cur.length) return;
    const nals = this.cur; const hasVcl = this.hasVcl; const broken = this.broken; const pts = this.pts;
    this.cur = []; this.hasVcl = false; this.broken = false; this.pts = undefined;
    if (hasVcl) this.onAu(makeAu(nals, { broken, pts }));
    else this.cur = nals; // parameter sets / SEI without a picture yet: keep them for the next AU
    if (!hasVcl) this.hasVcl = false;
  }
}
function makeAu(nals, extra = {}) {
  let key = false; let sps = null; let pps = null;
  for (const n of nals) { const t = nalType(n); if (t === NAL.IDR) key = true; else if (t === NAL.SPS) sps = n; else if (t === NAL.PPS) pps = n; }
  return { nals, key, sps, pps, ...extra };
}
function splitAccessUnits(nals) { const aus = []; const a = new AccessUnitAssembler((au) => aus.push(au)); for (const n of nals) a.push(n); a.flush(); return aus; }

// ---------- MP4 / MOV (ISO BMFF), non-fragmented, first avc1 / avc3 video track ----------
function boxes(buf, start = 0, end = buf.length) {
  const out = []; let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p); const type = buf.toString('latin1', p + 4, p + 8); let hdr = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; } else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    out.push({ type, start: p, data: p + hdr, end: p + size }); p += size;
  }
  return out;
}
const child = (buf, b, type) => boxes(buf, b.data, b.end).find((x) => x.type === type);
const path = (buf, b, types) => types.reduce((cur, t) => (cur ? child(buf, cur, t) : null), b);
function demuxMp4(buf) {
  const top = boxes(buf); const moov = top.find((b) => b.type === 'moov');
  if (!moov) throw new Error('MP4: no moov box');
  if (top.some((b) => b.type === 'moof') || child(buf, moov, 'mvex')) throw new Error('fragmented MP4 is not supported: remux with ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4, or use a raw .h264 file');
  for (const trak of boxes(buf, moov.data, moov.end).filter((b) => b.type === 'trak')) {
    const mdia = child(buf, trak, 'mdia'); const hdlr = mdia && child(buf, mdia, 'hdlr');
    if (!hdlr || buf.toString('latin1', hdlr.data + 8, hdlr.data + 12) !== 'vide') continue;
    const mdhd = child(buf, mdia, 'mdhd'); const v1 = buf[mdhd.data] === 1;
    const timescale = buf.readUInt32BE(mdhd.data + (v1 ? 20 : 12));
    const stbl = path(buf, mdia, ['minf', 'stbl']); const stsd = child(buf, stbl, 'stsd');
    const entry = boxes(buf, stsd.data + 8, stsd.end)[0];
    if (!entry || !['avc1', 'avc3'].includes(entry.type)) throw new Error(`MP4: video track is ${entry ? entry.type : 'unknown'}, only H.264 (avc1) is supported`);
    const avcc = boxes(buf, entry.data + 78, entry.end).find((b) => b.type === 'avcC');
    if (!avcc) throw new Error('MP4: no avcC');
    const a = buf.subarray(avcc.data, avcc.end); const lenSize = (a[4] & 3) + 1;
    let p = 6; const sps = []; const pps = [];
    for (let i = 0, n = a[5] & 31; i < n; i++) { const l = a.readUInt16BE(p); sps.push(Buffer.from(a.subarray(p + 2, p + 2 + l))); p += 2 + l; }
    for (let i = 0, n = a[p++]; i < n; i++) { const l = a.readUInt16BE(p); pps.push(Buffer.from(a.subarray(p + 2, p + 2 + l))); p += 2 + l; }
    const full = (t) => { const b = child(buf, stbl, t); return b ? { d: b.data + 4, n: buf.readUInt32BE(b.data + 4) } : null; };
    const stsz = child(buf, stbl, 'stsz'); const fixed = buf.readUInt32BE(stsz.data + 4); const count = buf.readUInt32BE(stsz.data + 8);
    const sizes = []; for (let i = 0; i < count; i++) sizes.push(fixed || buf.readUInt32BE(stsz.data + 12 + i * 4));
    const co = full('stco') || full('co64'); const is64 = !child(buf, stbl, 'stco');
    const offsets = []; for (let i = 0; i < co.n; i++) offsets.push(is64 ? Number(buf.readBigUInt64BE(co.d + 4 + i * 8)) : buf.readUInt32BE(co.d + 4 + i * 4));
    const stsc = full('stsc'); const runs = []; for (let i = 0; i < stsc.n; i++) { const q = stsc.d + 4 + i * 12; runs.push([buf.readUInt32BE(q), buf.readUInt32BE(q + 4)]); }
    const stts = full('stts'); const durs = []; for (let i = 0; i < stts.n; i++) { const q = stts.d + 4 + i * 8; for (let k = 0, c = buf.readUInt32BE(q); k < c; k++) durs.push(buf.readUInt32BE(q + 4)); }
    const stss = full('stss'); const sync = stss ? new Set(Array.from({ length: stss.n }, (_, i) => buf.readUInt32BE(stss.d + 4 + i * 4) - 1)) : null;
    const aus = []; let s = 0;
    for (let c = 0; c < offsets.length; c++) {
      let per = 0; for (const [first, n] of runs) if (c + 1 >= first) per = n;
      let off = offsets[c];
      for (let k = 0; k < per && s < count; k++, s++) {
        const nals = []; let q = off; const e = off + sizes[s];
        while (q + lenSize <= e) { const l = buf.readUIntBE(q, lenSize); nals.push(buf.subarray(q + lenSize, q + lenSize + l)); q += lenSize + l; }
        const au = makeAu(s === 0 || (sync && sync.has(s)) ? [sps[0], pps[0], ...nals.filter((n) => ![NAL.SPS, NAL.PPS].includes(nalType(n)))] : nals);
        if (sync && sync.has(s)) au.key = true;
        au.sps = au.sps || null; aus.push(au); off += sizes[s];
      }
    }
    const avgDur = durs.length ? durs.reduce((x, y) => x + y, 0) / durs.length : timescale / 30;
    return { sps: sps[0], pps: pps[0], aus, fps: Math.round((timescale / avgDur) * 1000) / 1000 };
  }
  throw new Error('MP4: no video track');
}

module.exports = { NAL, nalType, isVcl, splitAnnexB, unescapeRbsp, parseSps, codecString, avcC, toAvcc, AccessUnitAssembler, splitAccessUnits, makeAu, demuxMp4, BitReader };
