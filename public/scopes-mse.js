// 0.12.0 video scopes: fallback when WebCodecs is missing (plain-http pages are not a "secure context", older
// Safari / Firefox): the same relayed H.264 access units are wrapped (no transcoding) into fragmented MP4 and played
// by Media Source Extensions in a hidden <video>; the scopes then read the browser's RGB picture (BT.709 inverse to
// Y′CbCr: exact up to rounding, but sub-black / super-white are clipped by the browser's conversion).
(function (root) {
  'use strict';
  const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const u16 = (v) => [(v >>> 8) & 255, v & 255];
  const str = (s) => [...s].map((c) => c.charCodeAt(0));
  function box(type, ...parts) {
    let len = 8; const arrs = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p))); for (const a of arrs) len += a.length;
    const out = new Uint8Array(len); out.set(u32(len), 0); out.set(str(type), 4); let o = 8; for (const a of arrs) { out.set(a, o); o += a.length; } return out;
  }
  const full = (type, ver, flags, ...parts) => box(type, [ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...parts);
  const TS = 90000;
  function initSegment({ avcC, width, height }) {
    const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(TS), u32(0), u32(0x00010000), u16(0x0100), new Array(10).fill(0), [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0], new Array(24).fill(0), u32(2));
    const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(0), new Array(8).fill(0), u16(0), u16(0), u16(0), u16(0), [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0], u32(width << 16), u32(height << 16));
    const mdhd = full('mdhd', 0, 0, u32(0), u32(0), u32(TS), u32(0), u16(0x55c4), u16(0));
    const hdlr = full('hdlr', 0, 0, u32(0), str('vide'), new Array(12).fill(0), str('VideoHandler'), [0]);
    const avc1 = box('avc1', new Array(6).fill(0), u16(1), new Array(16).fill(0), u16(width), u16(height), u32(0x00480000), u32(0x00480000), u32(0), u16(1), new Array(32).fill(0), u16(0x18), u16(0xffff), box('avcC', avcC));
    const stbl = box('stbl', full('stsd', 0, 0, u32(1), avc1), full('stts', 0, 0, u32(0)), full('stsc', 0, 0, u32(0)), full('stsz', 0, 0, u32(0), u32(0)), full('stco', 0, 0, u32(0)));
    const minf = box('minf', full('vmhd', 0, 1, new Array(8).fill(0)), box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), stbl);
    const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
    const mvex = box('mvex', full('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)));
    return concat(box('ftyp', str('isom'), u32(0x200), str('isomiso6avc1mp41')), box('moov', mvhd, trak, mvex));
  }
  function mediaSegment(seq, dts, duration, key, data) {
    const flags = key ? 0x02000000 : 0x01010000;
    const trun = (off) => full('trun', 0, 0x000701, u32(1), u32(off), u32(duration), u32(data.length), u32(flags));
    const tfdt = full('tfdt', 1, 0, u32(Math.floor(dts / 2 ** 32)), u32(dts >>> 0));
    const mk = (off) => box('moof', full('mfhd', 0, 0, u32(seq)), box('traf', full('tfhd', 0, 0x020000, u32(1)), tfdt, trun(off)));
    const moofLen = mk(0).length;
    return concat(mk(moofLen + 8), box('mdat', data));
  }
  function concat(...a) { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; }

  class MsePlayer {
    // video: HTMLVideoElement; onError(msg)
    constructor(video, { onError = () => {}, maxLagS = 0.35 } = {}) { this.video = video; this.onError = onError; this.maxLagS = maxLagS; this.q = []; this.seq = 1; this.ptsMap = new Map(); }
    static supported(codec) {
      const MS = window.ManagedMediaSource || window.MediaSource; if (!MS) return false;
      try { return MS.isTypeSupported(`video/mp4; codecs="${codec}"`); } catch { return false; }
    }
    configure(cfg, avcC) {
      this.reset();
      const MS = window.ManagedMediaSource || window.MediaSource; const ms = new MS(); this.ms = ms; this.cfg = cfg;
      this.frameDur = Math.round(TS / (cfg.fps || 30));
      const v = this.video; v.muted = true; v.playsInline = true; v.disableRemotePlayback = true;
      ms.addEventListener('sourceopen', () => {
        try {
          this.sb = ms.addSourceBuffer(`video/mp4; codecs="${cfg.codec}"`); this.sb.mode = 'segments';
          this.sb.addEventListener('updateend', () => this._pump());
          this.q.unshift(initSegment({ avcC, width: cfg.width, height: cfg.height })); this._pump();
        } catch (e) { this.onError(`MSE: ${e.message}`); }
      }, { once: true });
      v.src = URL.createObjectURL(ms);
      v.play().catch(() => {});
      this.base = null; this.waitKey = true;
    }
    push(key, ptsUs, data, meta) {
      if (!this.ms) return;
      if (this.waitKey && !key) return; this.waitKey = false;
      if (this.base === null) this.base = ptsUs;
      const dts = Math.round(((ptsUs - this.base) * TS) / 1e6);
      this.ptsMap.set(dts / TS, meta); if (this.ptsMap.size > 300) this.ptsMap.delete(this.ptsMap.keys().next().value);
      this.q.push(mediaSegment(this.seq++, dts, this.frameDur, key, data)); if (this.q.length > 120) { this.q = this.q.filter((_, i) => i === 0 && !this.sb); this.waitKey = true; }
      this._pump();
    }
    metaFor(mediaTime) { let best = null; let bd = 1e9; for (const [t, m] of this.ptsMap) { const d = Math.abs(t - mediaTime); if (d < bd) { bd = d; best = m; } } return bd < 0.05 ? best : null; }
    _pump() {
      const sb = this.sb; if (!sb || sb.updating || !this.q.length) return;
      try { sb.appendBuffer(this.q.shift()); } catch (e) { if (e.name === 'QuotaExceededError') { try { sb.remove(0, Math.max(0, this.video.currentTime - 2)); } catch { /* */ } } else this.onError(`MSE: ${e.message}`); return; }
      // stay at the live edge: low latency beats smoothness for a scope
      const v = this.video; const b = v.buffered;
      if (b.length) {
        const end = b.end(b.length - 1);
        if (end - v.currentTime > this.maxLagS || v.currentTime < b.start(0)) v.currentTime = Math.max(b.start(b.length - 1), end - 0.05);
        if (!this._trimAt || performance.now() - this._trimAt > 5000) { this._trimAt = performance.now(); if (v.currentTime > 6) this._pendTrim = v.currentTime - 4; }
      }
      if (v.paused) v.play().catch(() => {});
      if (this._pendTrim && !sb.updating && !this.q.length) { const t = this._pendTrim; this._pendTrim = 0; try { sb.remove(0, t); } catch { /* */ } }
    }
    reset() { this.q = []; this.ptsMap.clear(); if (this.video.src) { try { URL.revokeObjectURL(this.video.src); } catch { /* */ } this.video.removeAttribute('src'); this.video.load(); } this.ms = null; this.sb = null; this.seq = 1; }
  }
  root.ScopesMse = { MsePlayer, initSegment, mediaSegment };
})(window);
