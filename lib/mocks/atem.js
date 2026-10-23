'use strict';
// Mock Blackmagic ATEM (UDP) for tests, --mock and ADD TO DESK AS SIMULATOR. Since 0.10.0 it is built from a model
// profile (lib/drivers/atem-models.js): `new MockAtem({ model: 'c4k4me' })` reports that model's product id and
// topology and keeps the protocol state of all its M/Es, keyers, DSKs, aux outputs, multiviewers, SuperSources and its
// classic or Fairlight audio mixer (with Fairlight audio routing where the model has it). The default model is the
// Television Studio HD8 ISO with the production input names the earlier single-model mock used.
// Speaks the handshake and session rules of Sofie atem-connection's atemSocketChild.ts from the switcher's side (hello
// reply with NewSessionId, reliable packets with ids, acks, ~1 s keep-alive, at most WINDOW packets in flight, resend of
// unacknowledged packets), sends a state dump that ends with InCm, applies the commands the driver sends and answers
// with the update commands a switcher sends. Transitions run in mock time (frames at 50 fps, sped up 4x).
// A test double, not an emulator: it never contacts a device, and every command it receives is in `history`.
const dgram = require('dgram');
const P = require('../drivers/atem-proto');
const M = require('../drivers/atem-models');

const VERSION = 0x00020020; // 2.32 (ProtocolVersion.V9_6)
const WINDOW = 32; const RESEND_MS = 150;
const MACROS = [[0, 'Opener roll', 'Bars, then Cam 1'], [1, 'Lower third in', ''], [2, 'Break loop', ''], [5, 'Reset keys', '']];
const STEREO = BigInt(P.FL_STEREO);
// The default model's sources as [id, long, short, internalPortType, sourceAvailability, meAvailability]
const tuples = (p) => M.sources(p).map((x) => [x.id, x.long, x.short, x.port, x.sa, x.ma]);
const INPUTS = tuples(M.profile(M.DEFAULT));

const W = { // little writers for the getter layouts
  u8: (b, o, v) => b.writeUInt8((Number(v) || 0) & 0xff, o), b: (b, o, v) => b.writeUInt8(v ? 1 : 0, o), u16: (b, o, v) => b.writeUInt16BE((Number(v) || 0) & 0xffff, o),
  i16: (b, o, v) => b.writeInt16BE(Number(v) || 0, o), u32: (b, o, v) => b.writeUInt32BE(Number(v) >>> 0, o), i32: (b, o, v) => b.writeInt32BE(Number(v) | 0, o), i8: (b, o, v) => b.writeInt8(Number(v) || 0, o),
};
const mk = (name, n, f) => { const b = Buffer.alloc(n); f(b); return P.cmd(name, b); };
const dveDefault = (k) => ({ sizeX: 500, sizeY: 500, positionX: k % 2 ? 8000 : -8000, positionY: 4500, rotation: 0, borderEnabled: false, shadowEnabled: false, borderBevel: 0, borderOuterWidth: 50, borderInnerWidth: 0,
  borderOuterSoftness: 0, borderInnerSoftness: 0, borderBevelSoftness: 0, borderBevelPosition: 0, borderOpacity: 100, borderHue: 0, borderSaturation: 0, borderLuma: 1000, lightSourceDirection: 360, lightSourceAltitude: 25,
  maskEnabled: false, maskTop: 9000, maskBottom: 9000, maskLeft: 16000, maskRight: 16000, rate: 25 });
const SS_QUAD = [[-800, 450], [800, 450], [-800, -450], [800, -450]];

class MockAtem {
  constructor(opts = {}) {
    const key = typeof opts === 'string' ? opts : opts.model;
    this.profile = M.profile(key || M.DEFAULT); if (!this.profile) throw new Error(`unknown ATEM model ${key}`);
    this.history = []; this.sock = null; this.clients = new Map(); this.speed = 4; this.dropIncoming = 0; this.dropOutgoing = 0; this.packets = []; this.timers = new Set();
    const p = this.profile; this.inputs = tuples(p);
    const ext = this.inputs.filter((x) => x[3] === M.PORT.External).map((x) => x[0]);
    const key0 = (k) => ({ onAir: false, type: 0, flyEnabled: false, fill: ext[(k + 4) % ext.length] || 0, cut: 0, mask: { enabled: false, top: 9000, bottom: -9000, left: -16000, right: 16000 },
      luma: { preMultiplied: true, clip: 150, gain: 700, invert: false }, chroma: { hue: 1230, gain: 500, ySuppress: 500, lift: 0, narrow: false },
      pattern: { style: 0, size: 3200, symmetry: 5000, softness: 0, positionX: 5000, positionY: 5000, invert: false }, dve: dveDefault(k), keyframes: { a: null, b: null }, runningTo: 0 });
    this.s = {
      mes: Array.from({ length: p.mes }, (_, m) => ({ program: ext[m * 2 % ext.length] || 1, preview: ext[(m * 2 + 1) % ext.length] || 2, style: 0, nextSelection: 1, mixRate: 25, inTransition: false, remaining: 0, handle: 0,
        ftb: { black: false, inTransition: false, remaining: 0, rate: 25 }, keyers: Array.from({ length: p.uskPerMe }, (_, k) => key0(k)) })),
      dsk: Array.from({ length: p.dsk }, (_, k) => ({ onAir: false, tie: false, rate: 25, inTransition: false, fill: 3010, cut: 3011, preMultiply: true, clip: 0, gain: 0, invert: false,
        mask: { enabled: false, top: 9000, bottom: -9000, left: -16000, right: 16000 }, k })),
      aux: p.aux.map((a, i) => (i === 0 ? 10010 : ext[(i - 1) % ext.length] || 0)),
      macroRun: { running: false, index: 0xffff },
      mv: Array.from({ length: p.multiviewers }, (_, m) => ({ layout: 0, swapped: false, windows: this._mvDefault(m) })),
      ss: Array.from({ length: p.superSources }, (_, i) => ({ boxes: SS_QUAD.map(([x, y], b) => ({ enabled: true, source: ext[(b + i * 4) % ext.length] || 0, x, y, size: 500, cropped: false, cropTop: 0, cropBottom: 0, cropLeft: 0, cropRight: 0 })).slice(0, p.ssBoxes),
        props: { artFillSource: 3010, artCutSource: 3011, artOption: 0, artPreMultiplied: true, artClip: 500, artGain: 700, artInvertKey: false },
        border: { borderEnabled: false, borderBevel: 0, borderOuterWidth: 50, borderInnerWidth: 0, borderOuterSoftness: 0, borderInnerSoftness: 0, borderBevelSoftness: 0, borderBevelPosition: 0, borderHue: 0, borderSaturation: 0, borderLuma: 1000, borderLightSourceDirection: 360, borderLightSourceAltitude: 25 } })),
    };
    this._audioInit();
  }
  get model() { return this.profile.key; }
  calls(name) { return this.history.filter((h) => h.name === name); }
  _mvDefault(m) {
    const p = this.profile; const n = p.mvWindows; const w = {};
    if (!n) return w;
    const ext = this.inputs.filter((x) => x[3] === M.PORT.External).map((x) => x[0]);
    const pick = [...ext.slice(m * 8), ...ext.slice(0, m * 8), ...this.inputs.filter((x) => x[3] === M.PORT.MediaPlayerFill).map((x) => x[0])];
    const meBase = p.mes > 1 ? 10000 + ((m % p.mes) + 1) * 10 : 10010;
    w[0] = meBase + 1; w[1] = meBase; for (let i = 2; i < n; i++) w[i] = pick[(i - 2) % pick.length] || 0;
    if (n === 16) { w[14] = this.inputs.some((x) => x[0] === 9101) ? 9101 : w[14]; }
    return w;
  }
  _audioInit() {
    const a = this.profile.audio;
    if (a.type === 'classic') {
      this.classic = { inputs: {}, master: { gain: 32768, balance: 0, followFadeToBlack: false }, monitor: { enabled: true, gain: 32768, mute: false, solo: false, soloSource: 1, dim: false, dimLevel: 0 }, afv: false };
      for (const x of a.inputs) this.classic.inputs[x.id] = { id: x.id, ext: x.ext, mixOption: x.id <= 4 ? 2 : x.id === 1001 ? 1 : 0, gain: P.dbToU16(x.id === 2 ? -6 : 0), balance: 0, rcaToXlr: false };
      return;
    }
    this.fl = { inputs: {}, master: { equalizerEnabled: false, equalizerGain: 0, makeUpGain: 0, faderGain: 0, followFadeToBlack: false }, monitor: a.monitor ? { gain: 0, inputMasterGain: 0, inputMasterMuted: false, inputTalkbackGain: -1000, inputTalkbackMuted: true, inputSidetoneGain: -1000 } : null,
      solo: { solo: false, index: 0, source: '0' }, routing: {} };
    for (const x of a.inputs) {
      const video = x.id < 1000; const analog = x.ext === M.EXT.XLR || x.ext === M.EXT.TSJack || x.ext === M.EXT.TRSJack || x.ext === M.EXT.RCA;
      this.fl.inputs[x.id] = { id: x.id, ext: x.ext, inputType: video ? 0 : x.ext === M.EXT.MADI ? 3 : x.ext === M.EXT.Internal ? 1 : 2, analog,
        src: { framesDelay: 0, maxFramesDelay: x.maxDelay || 0, gain: 0, stereoSimulation: 0, equalizerEnabled: false, equalizerGain: 0, makeUpGain: 0, balance: 0, faderGain: x.id === 2 ? -600 : 0,
          supportedMixOptions: video ? 7 : 3, mixOption: video ? (x.id <= 4 ? 4 : 1) : analog && (x.id === 1301 || x.id === 1001) ? 2 : 1 } };
    }
    const r = a.routing; if (!r) return;
    const nIn = this.profile.inputs.filter((x) => x.port === M.PORT.External).length;
    for (const o of r.outputs) for (const pair of o.pairs) {
      const id = (o.id << 16) | pair; let src = (2301 << 16) | 0; // Program
      if (o.id >= 1001 && o.id < 2000) src = ((((o.id - 1001) % nIn) + 1) << 16) | 0; // MADI out n <- SDI n
      this.fl.routing[id] = src;
    }
  }
  // ---------- state commands (getter layouts, as atem-connection deserializes them) ----------
  c = {
    ver: () => mk('_ver', 4, (b) => W.u32(b, 0, VERSION)),
    pin: () => mk('_pin', 44, (b) => { b.write(this.profile.name, 0, 40, 'utf8'); W.u8(b, 40, this.profile.productId); }),
    top: () => { const p = this.profile; return mk('_top', 24, (b) => { W.u8(b, 0, p.mes); W.u8(b, 1, this.inputs.length); W.u8(b, 2, p.dsk); W.u8(b, 3, p.aux.length); W.u8(b, 4, p.audio.type === 'fairlight' && p.audio.routing ? p.aux.length : 0); W.u8(b, 5, p.mediaPlayers);
      W.u8(b, 6, p.multiviewers); W.u8(b, 7, 1); W.u8(b, 8, 4); W.u8(b, 9, p.dve); W.u8(b, 10, p.family === 'ATEM Mini' ? 0 : 1); W.u8(b, 11, p.superSources); W.u8(b, 13, 0); W.u8(b, 18, 1); }); },
    mec: (m) => mk('_MeC', 4, (b) => { W.u8(b, 0, m); W.u8(b, 1, this.profile.uskPerMe); }),
    mvc: () => mk('_MvC', 12, (b) => { W.u8(b, 0, this.profile.multiviewers); W.u8(b, 1, this.profile.mvWindows); W.b(b, 2, this.profile.mvRoutable !== 'none'); }),
    ssc: (i) => mk('_SSC', 4, (b) => { W.u8(b, 0, i); W.u8(b, 2, this.profile.ssBoxes); }),
    amc: () => mk('_AMC', 4, (b) => { W.u8(b, 0, Object.keys(this.classic.inputs).length); W.u8(b, 1, 1); W.u8(b, 2, 0); }),
    fac: () => mk('_FAC', 4, (b) => { W.u8(b, 0, Object.keys(this.fl.inputs).length); W.u8(b, 1, this.fl.monitor ? 1 : 0); }),
    inpr: ([id, long, short, type, srcAv, meAv]) => mk('InPr', 36, (b) => { W.u16(b, 0, id); b.write(long, 2, 20, 'utf8'); b.write(short, 22, 4, 'utf8'); W.u8(b, 26, 1); W.u16(b, 28, type === 0 ? 1 : 0); W.u16(b, 30, type === 0 ? 1 : 0); W.u8(b, 32, type); W.u8(b, 34, srcAv); W.u8(b, 35, meAv); }),
    prg: (m) => mk('PrgI', 4, (b) => { W.u8(b, 0, m); W.u16(b, 2, this.s.mes[m].program); }),
    prv: (m) => mk('PrvI', 8, (b) => { W.u8(b, 0, m); W.u16(b, 2, this.s.mes[m].preview); }),
    trss: (m) => { const x = this.s.mes[m]; return P.cmd('TrSS', Buffer.from([m, x.style, x.nextSelection, x.style, x.nextSelection, 0, 0, 0])); },
    trps: (m) => { const x = this.s.mes[m]; return mk('TrPs', 8, (b) => { W.u8(b, 0, m); W.b(b, 1, x.inTransition); W.u8(b, 2, x.remaining); W.u16(b, 4, x.handle); }); },
    tmx: (m) => P.cmd('TMxP', Buffer.from([m, this.s.mes[m].mixRate, 0, 0])),
    ftbs: (m) => { const f = this.s.mes[m].ftb; return P.cmd('FtbS', Buffer.from([m, f.black ? 1 : 0, f.inTransition ? 1 : 0, f.remaining])); },
    ftbp: (m) => P.cmd('FtbP', Buffer.from([m, this.s.mes[m].ftb.rate, 0, 0])),
    keon: (m, k) => P.cmd('KeOn', Buffer.from([m, k, this.s.mes[m].keyers[k].onAir ? 1 : 0, 0])),
    kebp: (m, k) => { const x = this.s.mes[m].keyers[k]; return mk('KeBP', 20, (b) => { W.u8(b, 0, m); W.u8(b, 1, k); W.u8(b, 2, x.type); W.b(b, 4, this.profile.dve > 0); W.b(b, 5, x.flyEnabled); W.u16(b, 6, x.fill); W.u16(b, 8, x.cut);
      W.b(b, 10, x.mask.enabled); W.i16(b, 12, x.mask.top); W.i16(b, 14, x.mask.bottom); W.i16(b, 16, x.mask.left); W.i16(b, 18, x.mask.right); }); },
    kelm: (m, k) => { const x = this.s.mes[m].keyers[k].luma; return mk('KeLm', 12, (b) => { W.u8(b, 0, m); W.u8(b, 1, k); W.b(b, 2, x.preMultiplied); W.u16(b, 4, x.clip); W.u16(b, 6, x.gain); W.b(b, 8, x.invert); }); },
    keck: (m, k) => { const x = this.s.mes[m].keyers[k].chroma; return mk('KeCk', 12, (b) => { W.u8(b, 0, m); W.u8(b, 1, k); W.u16(b, 2, x.hue); W.u16(b, 4, x.gain); W.u16(b, 6, x.ySuppress); W.u16(b, 8, x.lift); W.b(b, 10, x.narrow); }); },
    kept: (m, k) => { const x = this.s.mes[m].keyers[k].pattern; return mk('KePt', 16, (b) => { W.u8(b, 0, m); W.u8(b, 1, k); W.u8(b, 2, x.style); W.u16(b, 4, x.size); W.u16(b, 6, x.symmetry); W.u16(b, 8, x.softness); W.u16(b, 10, x.positionX); W.u16(b, 12, x.positionY); W.b(b, 14, x.invert); }); },
    kedv: (m, k) => { const x = this.s.mes[m].keyers[k].dve; return mk('KeDV', 60, (b) => {
      W.u8(b, 0, m); W.u8(b, 1, k); W.u32(b, 4, x.sizeX); W.u32(b, 8, x.sizeY); W.i32(b, 12, x.positionX); W.i32(b, 16, x.positionY); W.i32(b, 20, x.rotation); W.b(b, 24, x.borderEnabled); W.b(b, 25, x.shadowEnabled); W.u8(b, 26, x.borderBevel);
      W.u16(b, 28, x.borderOuterWidth); W.u16(b, 30, x.borderInnerWidth); W.i8(b, 32, x.borderOuterSoftness); W.i8(b, 33, x.borderInnerSoftness); W.i8(b, 34, x.borderBevelSoftness); W.i8(b, 35, x.borderBevelPosition); W.i8(b, 36, x.borderOpacity);
      W.u16(b, 38, x.borderHue); W.u16(b, 40, x.borderSaturation); W.u16(b, 42, x.borderLuma); W.u16(b, 44, x.lightSourceDirection); W.u8(b, 46, x.lightSourceAltitude); W.b(b, 47, x.maskEnabled); W.u16(b, 48, x.maskTop); W.u16(b, 50, x.maskBottom);
      W.u16(b, 52, x.maskLeft); W.u16(b, 54, x.maskRight); W.u8(b, 56, x.rate); }); },
    kefs: (m, k) => { const x = this.s.mes[m].keyers[k]; return mk('KeFS', 8, (b) => { W.u8(b, 0, m); W.u8(b, 1, k); W.b(b, 2, !!x.keyframes.a); W.b(b, 3, !!x.keyframes.b); W.u8(b, 4, x.runningTo); W.u8(b, 6, x.atKeyFrame || 0); }); },
    kkfp: (m, k, f) => { const x = this.s.mes[m].keyers[k].keyframes[f === 1 ? 'a' : 'b'] || dveDefault(k); return mk('KKFP', 60, (b) => { W.u8(b, 0, m); W.u8(b, 1, k); W.u8(b, 2, f); W.u32(b, 4, x.sizeX); W.u32(b, 8, x.sizeY); W.i32(b, 12, x.positionX); W.i32(b, 16, x.positionY); W.i32(b, 20, x.rotation); }); },
    dsks: (k) => { const d = this.s.dsk[k]; return P.cmd('DskS', Buffer.from([k, d.onAir ? 1 : 0, d.inTransition ? 1 : 0, d.inTransition ? 1 : 0, 1, 0, 0, 0])); },
    dskb: (k) => { const d = this.s.dsk[k]; return mk('DskB', 8, (b) => { W.u8(b, 0, k); W.u16(b, 2, d.fill); W.u16(b, 4, d.cut); }); },
    dskp: (k) => { const d = this.s.dsk[k]; return mk('DskP', 20, (b) => { W.u8(b, 0, k); W.b(b, 1, d.tie); W.u8(b, 2, d.rate); W.b(b, 3, d.preMultiply); W.u16(b, 4, d.clip); W.u16(b, 6, d.gain); W.b(b, 8, d.invert);
      W.b(b, 9, d.mask.enabled); W.i16(b, 10, d.mask.top); W.i16(b, 12, d.mask.bottom); W.i16(b, 14, d.mask.left); W.i16(b, 16, d.mask.right); }); },
    aux: (i) => mk('AuxS', 4, (b) => { W.u8(b, 0, i); W.u16(b, 2, this.s.aux[i]); }),
    mvpr: (m) => mk('MvPr', 4, (b) => { W.u8(b, 0, m); W.u8(b, 1, this.s.mv[m].layout); W.b(b, 2, this.s.mv[m].swapped); }),
    mvin: (m, w) => mk('MvIn', 8, (b) => { W.u8(b, 0, m); W.u8(b, 1, w); W.u16(b, 2, this.s.mv[m].windows[w]); W.b(b, 4, true); W.b(b, 5, true); }),
    ssrc: (i) => { const x = this.s.ss[i].props; return mk('SSrc', 16, (b) => { W.u8(b, 0, i); W.u16(b, 2, x.artFillSource); W.u16(b, 4, x.artCutSource); W.u8(b, 6, x.artOption); W.b(b, 7, x.artPreMultiplied); W.u16(b, 8, x.artClip); W.u16(b, 10, x.artGain); W.b(b, 12, x.artInvertKey); }); },
    ssbd: (i) => { const x = this.s.ss[i].border; return mk('SSBd', 24, (b) => { W.u8(b, 0, i); W.b(b, 1, x.borderEnabled); W.u8(b, 2, x.borderBevel); W.u16(b, 4, x.borderOuterWidth); W.u16(b, 6, x.borderInnerWidth); W.u8(b, 8, x.borderOuterSoftness); W.u8(b, 9, x.borderInnerSoftness);
      W.u8(b, 10, x.borderBevelSoftness); W.u8(b, 11, x.borderBevelPosition); W.u16(b, 12, x.borderHue); W.u16(b, 14, x.borderSaturation); W.u16(b, 16, x.borderLuma); W.u16(b, 18, x.borderLightSourceDirection); W.u8(b, 20, x.borderLightSourceAltitude); }); },
    ssbp: (i, n) => { const x = this.s.ss[i].boxes[n]; return mk('SSBP', 24, (b) => { W.u8(b, 0, i); W.u8(b, 1, n); W.b(b, 2, x.enabled); W.u16(b, 4, x.source); W.i16(b, 6, x.x); W.i16(b, 8, x.y); W.u16(b, 10, x.size); W.b(b, 12, x.cropped);
      W.u16(b, 14, x.cropTop); W.u16(b, 16, x.cropBottom); W.u16(b, 18, x.cropLeft); W.u16(b, 20, x.cropRight); }); },
    amip: (id) => { const x = this.classic.inputs[id]; return mk('AMIP', 16, (b) => { W.u16(b, 0, id); W.u8(b, 2, id < 1000 ? 0 : id >= 2000 ? 1 : 2); W.u16(b, 6, x.ext); W.u8(b, 8, x.mixOption); W.u16(b, 10, x.gain); W.i16(b, 12, x.balance); W.b(b, 14, x.ext === M.EXT.RCA); W.b(b, 15, x.rcaToXlr); }); },
    ammo: () => { const x = this.classic.master; return mk('AMMO', 8, (b) => { W.u16(b, 0, x.gain); W.i16(b, 2, x.balance); W.b(b, 4, x.followFadeToBlack); }); },
    ammo2: () => { const x = this.classic.monitor; return mk('AMmO', 12, (b) => { W.b(b, 0, x.enabled); W.u16(b, 2, x.gain); W.b(b, 4, x.mute); W.b(b, 5, x.solo); W.u16(b, 6, x.soloSource); W.b(b, 8, x.dim); W.u16(b, 10, x.dimLevel); }); },
    ampp: () => mk('AMPP', 4, (b) => W.b(b, 0, this.classic.afv)),
    faip: (id) => { const x = this.fl.inputs[id]; return mk('FAIP', 16, (b) => { W.u16(b, 0, id); W.u8(b, 2, x.inputType); W.u16(b, 6, x.ext); W.u8(b, 9, x.analog ? 1 : 2); W.u8(b, 10, 2); W.u8(b, 11, x.analog ? 6 : 0); W.u8(b, 12, x.analog ? 4 : 0); }); },
    fasp: (id) => { const x = this.fl.inputs[id].src; return mk('FASP', 52, (b) => { W.u16(b, 0, id); b.writeBigInt64BE(STEREO, 8); W.u8(b, 16, 0); W.u8(b, 17, x.maxFramesDelay); W.u8(b, 18, x.framesDelay); W.i32(b, 20, x.gain); W.b(b, 24, false);
      W.i16(b, 26, x.stereoSimulation); W.u8(b, 28, 6); W.b(b, 29, x.equalizerEnabled); W.i32(b, 32, x.equalizerGain); W.i32(b, 36, x.makeUpGain); W.i16(b, 40, x.balance); W.i32(b, 44, x.faderGain); W.u8(b, 48, x.supportedMixOptions); W.u8(b, 49, x.mixOption); }); },
    famp: () => { const x = this.fl.master; return mk('FAMP', 20, (b) => { W.u8(b, 0, 6); W.b(b, 1, x.equalizerEnabled); W.i32(b, 4, x.equalizerGain); W.i32(b, 8, x.makeUpGain); W.i32(b, 12, x.faderGain); W.b(b, 16, x.followFadeToBlack); }); },
    fmhp: () => { const x = this.fl.monitor; return mk('FMHP', 32, (b) => { W.i32(b, 0, x.gain); W.i32(b, 4, x.inputMasterGain); W.b(b, 8, !x.inputMasterMuted); W.i32(b, 12, x.inputTalkbackGain); W.b(b, 16, !x.inputTalkbackMuted); W.i32(b, 28, x.inputSidetoneGain); }); },
    fams: () => { const x = this.fl.solo; return mk('FAMS', 24, (b) => { W.b(b, 0, x.solo); W.u16(b, 8, x.index); b.writeBigInt64BE(BigInt(x.source || 0), 16); }); },
    arop: (id) => { const o = this.profile.audio.routing.outputs.find((x) => x.id === id >>> 16); return mk('AROP', 80, (b) => { W.u32(b, 0, id); W.u32(b, 4, this.fl.routing[id]); W.u16(b, 8, o.id < 2000 ? M.EXT.MADI : M.EXT.Internal); W.u16(b, 10, 0);
      b.write(`${o.name}${o.pairs.length > 1 ? ` ${(id & 0xffff) * 2 + 1}/${(id & 0xffff) * 2 + 2}` : ''}`, 12, 63, 'utf8'); }); },
    arsp: (s, pair) => mk('ARSP', 76, (b) => { W.u32(b, 0, (s.id << 16) | pair); W.u16(b, 4, s.id >= 1501 && s.id < 1600 ? M.EXT.MADI : s.id < 1000 && s.id > 0 ? M.EXT.SDI : M.EXT.Internal);
      b.write(`${s.name}${s.pairs.length > 1 ? ` ${pair * 2 + 1}/${pair * 2 + 2}` : ''}`, 8, 63, 'utf8'); }),
    mprp: (i) => { const m = MACROS.find((x) => x[0] === i); const name = Buffer.from(m ? m[1] : ''); const desc = Buffer.from(m ? m[2] : ''); const b = Buffer.alloc(8 + name.length + desc.length); b.writeUInt16BE(i, 0); b.writeUInt8(m ? 1 : 0, 2); b.writeUInt16BE(name.length, 4); b.writeUInt16BE(desc.length, 6); name.copy(b, 8); desc.copy(b, 8 + name.length); return P.cmd('MPrp', b); },
    mrpr: () => mk('MRPr', 4, (b) => { W.b(b, 0, this.s.macroRun.running); W.u16(b, 2, this.s.macroRun.index); }),
    tlsr: () => {
      const ids = this.inputs.filter((x) => x[3] < 128).map((x) => x[0]);
      const b = Buffer.alloc(2 + ids.length * 3); b.writeUInt16BE(ids.length, 0);
      const pgm = new Set(); const pvw = new Set();
      for (const m of this.s.mes) { pgm.add(m.program); if (m.inTransition) pgm.add(m.preview); pvw.add(m.preview); }
      ids.forEach((id, i) => { b.writeUInt16BE(id, 2 + i * 3); b.writeUInt8((pgm.has(id) ? 1 : 0) | (pvw.has(id) ? 2 : 0), 4 + i * 3); });
      return P.cmd('TlSr', b);
    },
    incm: () => P.cmd('InCm', Buffer.from([1, 0, 0, 0])),
  };
  _keyCmds(m, k) { const c = this.c; return [c.kebp(m, k), c.keon(m, k), c.kelm(m, k), c.keck(m, k), c.kept(m, k), c.kedv(m, k), c.kefs(m, k)]; }
  _audioCmds() {
    const c = this.c; const out = [];
    if (this.classic) { out.push(c.amc(), ...Object.keys(this.classic.inputs).map((id) => c.amip(Number(id))), c.ammo(), c.ammo2(), c.ampp()); return out; }
    out.push(c.fac(), ...Object.keys(this.fl.inputs).flatMap((id) => [c.faip(Number(id)), c.fasp(Number(id))]), c.famp());
    if (this.fl.monitor) out.push(c.fmhp(), c.fams());
    const r = this.profile.audio.routing;
    if (r) { for (const s of r.sources) for (const pair of s.pairs) out.push(c.arsp(s, pair)); for (const id of Object.keys(this.fl.routing)) out.push(c.arop(Number(id))); }
    return out;
  }
  dump() {
    const c = this.c; const p = this.profile; const s = this.s; const R = (n, f) => Array.from({ length: n }, (_, i) => f(i));
    return [c.ver(), c.pin(), c.top(), ...R(p.mes, (m) => c.mec(m)), ...(p.multiviewers ? [c.mvc()] : []), ...R(p.superSources, (i) => c.ssc(i)), ...this.inputs.map((x) => c.inpr(x)),
      ...R(p.mes, (m) => [c.prg(m), c.prv(m), c.trss(m), c.trps(m), c.tmx(m), c.ftbs(m), c.ftbp(m), ...R(p.uskPerMe, (k) => this._keyCmds(m, k)).flat()]).flat(),
      ...R(p.dsk, (k) => [c.dsks(k), c.dskb(k), c.dskp(k)]).flat(), ...R(s.aux.length, (i) => c.aux(i)),
      ...R(p.multiviewers, (m) => [c.mvpr(m), ...Object.keys(s.mv[m].windows).map((w) => c.mvin(m, Number(w)))]).flat(),
      ...R(p.superSources, (i) => [c.ssrc(i), c.ssbd(i), ...R(s.ss[i].boxes.length, (b) => c.ssbp(i, b))]).flat(),
      ...this._audioCmds(), ...Array.from({ length: 10 }, (_, i) => c.mprp(i)), c.mrpr(), c.tlsr(), c.incm()];
  }
  // ---------- transport ----------
  start(port = 0, host = '127.0.0.1') {
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (m, r) => this._recv(m, r));
    this._ka = setInterval(() => { for (const cl of this.clients.values()) if (cl.ready && !cl.queue.length && !cl.unacked.size) this._reliable(cl, []); }, 1000); if (this._ka.unref) this._ka.unref();
    this._rs = setInterval(() => this._resend(), RESEND_MS / 3); if (this._rs.unref) this._rs.unref();
    return new Promise((res) => this.sock.bind(port, host, () => res(this.sock.address().port)));
  }
  stop() {
    clearInterval(this._ka); clearInterval(this._rs); for (const t of this.timers) clearTimeout(t); this.timers.clear();
    return new Promise((r) => { if (!this.sock) return r(); try { this.sock.close(() => r()); } catch { r(); } this.sock = null; });
  }
  _out(cl, b) { if (this.sock) this.sock.send(b, 0, b.length, cl.port, cl.address); }
  _reliable(cl, cmds) {
    // pack into packets of <= 1400 bytes; at most WINDOW in flight, the rest queued until acks arrive
    const packets = []; let cur = []; let size = 0;
    for (const c of cmds) { if (size + c.length > 1400 && cur.length) { packets.push(cur); cur = []; size = 0; } cur.push(c); size += c.length; }
    packets.push(cur);
    for (const p of packets) cl.queue.push(Buffer.concat(p));
    this._pump(cl);
  }
  _pump(cl) {
    while (cl.queue.length && cl.unacked.size < WINDOW) {
      const payload = cl.queue.shift(); cl.nextId = (cl.nextId + 1) % P.MAX_PACKET_ID;
      const pkt = Buffer.concat([P.header(P.FLAG.AckRequest, 12 + payload.length, cl.session, { packetId: cl.nextId }), payload]);
      cl.unacked.set(cl.nextId, { pkt, sent: Date.now() });
      if (this.dropOutgoing > 0) { this.dropOutgoing--; continue; } // simulate a lost packet towards the driver
      this._out(cl, pkt);
    }
  }
  _resend() {
    const now = Date.now();
    for (const cl of this.clients.values()) for (const [id, u] of cl.unacked) {
      if (now - u.sent < RESEND_MS) continue;
      u.sent = now; u.tries = (u.tries || 0) + 1;
      if (u.tries > 30) { cl.unacked.delete(id); continue; } // the client went away
      const b = Buffer.from(u.pkt); b.writeUInt8(b.readUInt8(0) | (P.FLAG.IsRetransmit << 3), 0); this._out(cl, b);
    }
  }
  _acked(cl, ack) { // an ack covers that packet and the ones before it
    for (const id of [...cl.unacked.keys()]) if (id === ack || ((ack - id + P.MAX_PACKET_ID) % P.MAX_PACKET_ID) < P.MAX_PACKET_ID / 2) cl.unacked.delete(id);
    this._pump(cl);
  }
  broadcast(cmds) { for (const cl of this.clients.values()) if (cl.ready) this._reliable(cl, cmds); }
  _recv(m, r) {
    const h = P.parseHeader(m); if (!h || h.length !== m.length) return;
    const key = `${r.address}:${r.port}`;
    if (h.flags & P.FLAG.NewSessionId) { // hello
      const cl = { address: r.address, port: r.port, session: 0x8000 | (this.clients.size + 1), nextId: 0, lastIn: 0, ready: false, helloSession: h.session, queue: [], unacked: new Map() };
      this.clients.set(key, cl);
      this._out(cl, Buffer.concat([P.header(P.FLAG.NewSessionId, 20, h.session, {}), Buffer.from([0x02, 0, 0, 0, 0, 0, 0, 0])]));
      return;
    }
    const cl = this.clients.get(key); if (!cl) return;
    this.packets.push({ flags: h.flags, packetId: h.packetId, length: h.length });
    if ((h.flags & P.FLAG.AckRequest) && this.dropIncoming > 0) { this.dropIncoming--; return; } // simulate a lost packet
    if (h.flags & P.FLAG.AckReply) { if (!cl.ready) { cl.ready = true; this._reliable(cl, this.dump()); } else this._acked(cl, h.ack); }
    if (h.flags & P.FLAG.AckRequest) {
      const fresh = h.packetId !== cl.lastIn; cl.lastIn = h.packetId;
      this._out(cl, P.header(P.FLAG.AckReply, 12, cl.session, { ack: h.packetId }));
      if (fresh && m.length > 12) for (const c of P.splitCommands(m.subarray(12))) this._apply(c.name, c.data);
    }
  }
  _later(ms, fn) { const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms / this.speed); this.timers.add(t); }
  _me(m) { return this.s.mes[m]; }
  _apply(name, d) {
    this.history.push({ name, hex: d.toString('hex'), at: Date.now() });
    const s = this.s; const c = this.c; const p = this.profile;
    const meOk = (m) => m < p.mes; const keyOk = (m, k) => meOk(m) && k < p.uskPerMe;
    switch (name) {
      case 'CPgI': { const m = d.readUInt8(0); if (!meOk(m)) return; s.mes[m].program = d.readUInt16BE(2); return this.broadcast([c.prg(m), c.tlsr()]); }
      case 'CPvI': { const m = d.readUInt8(0); if (!meOk(m)) return; s.mes[m].preview = d.readUInt16BE(2); return this.broadcast([c.prv(m), c.tlsr()]); }
      case 'DCut': { const m = d.readUInt8(0); if (!meOk(m)) return; const x = s.mes[m]; [x.program, x.preview] = [x.preview, x.program]; this._keysAfter(m); return this.broadcast([c.prg(m), c.prv(m), c.tlsr(), ...x.keyers.map((_, k) => c.keon(m, k)), ...s.dsk.map((_, k) => c.dsks(k))]); }
      case 'DAut': {
        const m = d.readUInt8(0); if (!meOk(m)) return; const x = s.mes[m];
        if (x.inTransition) return;
        x.inTransition = true; x.remaining = x.mixRate; this.broadcast([c.trps(m), c.tlsr()]);
        return this._later(x.mixRate * 20, () => { x.inTransition = false; x.remaining = 0; [x.program, x.preview] = [x.preview, x.program]; this._keysAfter(m); this.broadcast([c.trps(m), c.prg(m), c.prv(m), c.tlsr(), ...x.keyers.map((_, k) => c.keon(m, k)), ...s.dsk.map((_, k) => c.dsks(k))]); });
      }
      case 'CTTp': { const f = d.readUInt8(0); const m = d.readUInt8(1); if (!meOk(m)) return; if (f & 1) s.mes[m].style = d.readUInt8(2); if (f & 2) s.mes[m].nextSelection = d.readUInt8(3) || 1; return this.broadcast([c.trss(m)]); }
      case 'CTMx': { const m = d.readUInt8(0); if (!meOk(m)) return; s.mes[m].mixRate = d.readUInt8(1); return this.broadcast([c.tmx(m)]); }
      case 'FtbA': { const m = d.readUInt8(0); if (!meOk(m)) return; const f = s.mes[m].ftb; f.inTransition = true; this.broadcast([c.ftbs(m)]); return this._later(f.rate * 20, () => { f.inTransition = false; f.black = !f.black; this.broadcast([c.ftbs(m)]); }); }
      case 'FtbC': { const m = d.readUInt8(1); if (!meOk(m)) return; s.mes[m].ftb.rate = d.readUInt8(2); return this.broadcast([c.ftbp(m)]); }
      case 'CKOn': { const m = d.readUInt8(0); const k = d.readUInt8(1); if (!keyOk(m, k)) return; s.mes[m].keyers[k].onAir = d.readUInt8(2) === 1; return this.broadcast([c.keon(m, k)]); }
      case 'CDsL': { const k = d.readUInt8(0); if (!s.dsk[k]) return; s.dsk[k].onAir = d.readUInt8(1) === 1; return this.broadcast([c.dsks(k)]); }
      case 'CDsT': { const k = d.readUInt8(0); if (!s.dsk[k]) return; s.dsk[k].tie = d.readUInt8(1) === 1; return this.broadcast([c.dskp(k)]); }
      case 'DDsA': { const k = d.readUInt8(1); const x = s.dsk[k]; if (!x) return; x.inTransition = true; this.broadcast([c.dsks(k)]); return this._later(x.rate * 20, () => { x.inTransition = false; x.onAir = !x.onAir; this.broadcast([c.dsks(k)]); }); }
      case 'CDsF': { const k = d.readUInt8(0); if (!s.dsk[k]) return; s.dsk[k].fill = d.readUInt16BE(2); return this.broadcast([c.dskb(k)]); }
      case 'CDsC': { const k = d.readUInt8(0); if (!s.dsk[k]) return; s.dsk[k].cut = d.readUInt16BE(2); return this.broadcast([c.dskb(k)]); }
      case 'CDsR': { const k = d.readUInt8(0); if (!s.dsk[k]) return; s.dsk[k].rate = d.readUInt8(1); return this.broadcast([c.dskp(k)]); }
      case 'CDsG': { const r = P.readSetter(name, d); const x = s.dsk[r.ids.index]; if (!x) return; Object.assign(x, r.changes); return this.broadcast([c.dskp(r.ids.index)]); }
      case 'CDsM': { const r = P.readSetter(name, d); const x = s.dsk[r.ids.index]; if (!x) return; Object.assign(x.mask, r.changes); return this.broadcast([c.dskp(r.ids.index)]); }
      case 'CAuS': { const i = d.readUInt8(1); if (i >= s.aux.length || !this._srcOk(d.readUInt16BE(2), 'aux')) return; s.aux[i] = d.readUInt16BE(2); return this.broadcast([c.aux(i)]); }
      case 'CMvI': {
        const m = d.readUInt8(0); const w = d.readUInt8(1); const src = d.readUInt16BE(2); const mv = s.mv[m];
        if (!mv || w >= p.mvWindows || p.mvRoutable === 'none' || (p.mvRoutable === 'small' && w < 2) || !this._srcOk(src, 'mv')) return;
        mv.windows[w] = src; return this.broadcast([c.mvin(m, w)]);
      }
      case 'CKTp': {
        const r = P.readSetter(name, d); const { me: m, key: k } = r.ids; if (!keyOk(m, k)) return; const x = s.mes[m].keyers[k];
        if (r.changes.type === 3) { // DVE: the model has only so many
          const used = s.mes.flatMap((e) => e.keyers).filter((y) => y !== x && y.type === 3).length;
          if (used >= p.dve) return this.broadcast([c.kebp(m, k)]);
        }
        if (r.changes.flyEnabled && !p.dve) delete r.changes.flyEnabled;
        Object.assign(x, r.changes); return this.broadcast([c.kebp(m, k)]);
      }
      case 'CKeF': case 'CKeC': { const m = d.readUInt8(0); const k = d.readUInt8(1); if (!keyOk(m, k)) return; s.mes[m].keyers[k][name === 'CKeF' ? 'fill' : 'cut'] = d.readUInt16BE(2); return this.broadcast([c.kebp(m, k)]); }
      case 'CKMs': { const r = P.readSetter(name, d); if (!keyOk(r.ids.me, r.ids.key)) return; Object.assign(s.mes[r.ids.me].keyers[r.ids.key].mask, r.changes); return this.broadcast([c.kebp(r.ids.me, r.ids.key)]); }
      case 'CKLm': { const r = P.readSetter(name, d); if (!keyOk(r.ids.me, r.ids.key)) return; Object.assign(s.mes[r.ids.me].keyers[r.ids.key].luma, r.changes); return this.broadcast([c.kelm(r.ids.me, r.ids.key)]); }
      case 'CKCk': { const r = P.readSetter(name, d); if (!keyOk(r.ids.me, r.ids.key)) return; Object.assign(s.mes[r.ids.me].keyers[r.ids.key].chroma, r.changes); return this.broadcast([c.keck(r.ids.me, r.ids.key)]); }
      case 'CKPt': { const r = P.readSetter(name, d); if (!keyOk(r.ids.me, r.ids.key)) return; Object.assign(s.mes[r.ids.me].keyers[r.ids.key].pattern, r.changes); return this.broadcast([c.kept(r.ids.me, r.ids.key)]); }
      case 'CKDV': { const r = P.readSetter(name, d); if (!keyOk(r.ids.me, r.ids.key) || !p.dve) return; Object.assign(s.mes[r.ids.me].keyers[r.ids.key].dve, r.changes); return this.broadcast([c.kedv(r.ids.me, r.ids.key)]); }
      case 'SFKF': { const m = d.readUInt8(0); const k = d.readUInt8(1); const f = d.readUInt8(2); if (!keyOk(m, k) || (f !== 1 && f !== 2)) return; const x = s.mes[m].keyers[k];
        x.keyframes[f === 1 ? 'a' : 'b'] = { ...x.dve }; return this.broadcast([c.kkfp(m, k, f), c.kefs(m, k)]); }
      case 'RFlK': { const m = d.readUInt8(1); const k = d.readUInt8(2); const f = d.readUInt8(4); if (!keyOk(m, k)) return; const x = s.mes[m].keyers[k];
        const target = f === 1 ? x.keyframes.a : f === 2 ? x.keyframes.b : f === 3 ? { sizeX: 1000, sizeY: 1000, positionX: 0, positionY: 0, rotation: 0 } : null;
        if (!target) return; x.runningTo = f; this.broadcast([c.kefs(m, k)]);
        return this._later(x.dve.rate * 20, () => { Object.assign(x.dve, { sizeX: target.sizeX, sizeY: target.sizeY, positionX: target.positionX, positionY: target.positionY, rotation: target.rotation }); x.runningTo = 0; x.atKeyFrame = f; this.broadcast([c.kedv(m, k), c.kefs(m, k)]); }); }
      case 'CSBP': { const r = P.readSetter(name, d); const ss = s.ss[r.ids.index]; const b = ss && ss.boxes[r.ids.box]; if (!b) return; if ('source' in r.changes && !this._srcOk(r.changes.source, 'ssbox')) delete r.changes.source;
        Object.assign(b, clampBox(r.changes)); return this.broadcast([c.ssbp(r.ids.index, r.ids.box)]); }
      case 'CSSc': { const r = P.readSetter(name, d); const ss = s.ss[r.ids.index]; if (!ss) return; Object.assign(ss.props, r.changes); return this.broadcast([c.ssrc(r.ids.index)]); }
      case 'CSBd': { const r = P.readSetter(name, d); const ss = s.ss[r.ids.index]; if (!ss) return; Object.assign(ss.border, r.changes); return this.broadcast([c.ssbd(r.ids.index)]); }
      case 'CAMI': { if (!this.classic) return; const r = P.readSetter(name, d); const x = this.classic.inputs[r.ids.index]; if (!x) return; Object.assign(x, r.changes); return this.broadcast([c.amip(r.ids.index)]); }
      case 'CAMM': { if (!this.classic) return; Object.assign(this.classic.master, P.readSetter(name, d).changes); return this.broadcast([c.ammo()]); }
      case 'CAMm': { if (!this.classic) return; Object.assign(this.classic.monitor, P.readSetter(name, d).changes); return this.broadcast([c.ammo2()]); }
      case 'CFSP': { if (!this.fl) return; const r = P.readSetter(name, d); const x = this.fl.inputs[r.ids.index]; if (!x || r.ids.source !== P.FL_STEREO) return;
        if ('mixOption' in r.changes && !(x.src.supportedMixOptions & r.changes.mixOption)) delete r.changes.mixOption;
        if ('faderGain' in r.changes) r.changes.faderGain = Math.max(-10000, Math.min(1000, r.changes.faderGain));
        Object.assign(x.src, r.changes); return this.broadcast([c.fasp(r.ids.index)]); }
      case 'CFMP': { if (!this.fl) return; const ch = P.readSetter(name, d).changes; if ('faderGain' in ch) ch.faderGain = Math.max(-10000, Math.min(1000, ch.faderGain)); Object.assign(this.fl.master, ch); return this.broadcast([c.famp()]); }
      case 'CFMH': { if (!this.fl || !this.fl.monitor) return; Object.assign(this.fl.monitor, P.readSetter(name, d).changes); return this.broadcast([c.fmhp()]); }
      case 'CFMS': { if (!this.fl || !this.fl.monitor) return; const f = d.readUInt8(0); if (f & 1) this.fl.solo.solo = d.readUInt8(1) === 1; if (f & 2) { this.fl.solo.index = d.readUInt16BE(8); this.fl.solo.source = d.readBigInt64BE(16).toString(); } return this.broadcast([c.fams()]); }
      case 'AROC': { if (!this.fl) return; const id = d.readUInt32BE(4); if (!(id in this.fl.routing)) return; if (d.readUInt8(0) & 1) { const src = d.readUInt32BE(8);
        if (!this.profile.audio.routing.sources.some((x) => x.id === src >>> 16 && x.pairs.includes(src & 0xffff))) return; this.fl.routing[id] = src; } return this.broadcast([c.arop(id)]); }
      case 'MAct': {
        const i = d.readUInt16BE(0); const a = d.readUInt8(2);
        if (a === 0 && MACROS.some((x) => x[0] === i)) { s.macroRun = { running: true, index: i }; this.broadcast([c.mrpr()]); return this._later(2000, () => { s.macroRun = { running: false, index: 0xffff }; this.broadcast([c.mrpr()]); }); }
        if (a === 1) { s.macroRun = { running: false, index: 0xffff }; return this.broadcast([c.mrpr()]); }
        return undefined;
      }
      default: return undefined;
    }
  }
  _srcOk(id, where) {
    const x = this.inputs.find((i) => i[0] === id); if (!x) return false;
    const sa = x[4]; if (where === 'aux') return !!(sa & M.AV.Auxiliary); if (where === 'mv') return !!(sa & M.AV.Multiviewer);
    if (where === 'ssbox') return !!(sa & M.AV.SuperSourceBox); return true;
  }
  _keysAfter(m) { // keys tied to the transition flip on air with it; DSK tie applies to M/E 1
    const x = this.s.mes[m]; x.keyers.forEach((k, i) => { if (x.nextSelection & (1 << (i + 1))) k.onAir = !k.onAir; });
    if (m === 0) for (const d of this.s.dsk) if (d.tie) d.onAir = !d.onAir;
  }
}
// SuperSource box limits [atem-connection / Blackmagic: x -4800..4800, y -2700..2700 (x100), size 70..1000 (x1000), crop 0..18000 / 32000]
function clampBox(ch) {
  const c = { ...ch }; const cl = (v, a, b) => Math.max(a, Math.min(b, v));
  if ('x' in c) c.x = cl(c.x, -4800, 4800); if ('y' in c) c.y = cl(c.y, -2700, 2700); if ('size' in c) c.size = cl(c.size, 70, 1000);
  for (const k of ['cropTop', 'cropBottom']) if (k in c) c[k] = cl(c[k], 0, 18000); for (const k of ['cropLeft', 'cropRight']) if (k in c) c[k] = cl(c[k], 0, 32000);
  return c;
}

module.exports = { MockAtem, INPUTS, MACROS, tuples };
