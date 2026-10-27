'use strict';
// Blackmagic ATEM network protocol (UDP 9910), implemented natively with dgram. No library is used at run time;
// the wire format follows the open-source references, cited per item:
//   [AC] Sofie atem-connection (https://github.com/Sofie-Automation/sofie-atem-connection, commit 9c77b69):
//        src/lib/atemSocketChild.ts (packet header, flags, hello, acks, retransmit), src/lib/packetBuilder.ts
//        (command framing), src/commands/** (per-command byte layouts), src/enums (ProtocolVersion, Model, ...).
//   [CM] Bitfocus companion-module-bmd-atem (https://github.com/bitfocus/companion-module-bmd-atem, commit 95f09aa),
//        which drives ATEMs through atem-connection: feature set and naming (program / preview, cut / auto,
//        transition style and rate, FTB, DSK / USK on air + tie, aux, macros).
//   Terminology (Program, Preview, Cut, Auto, Fade to Black, Upstream / Downstream Key, Aux, Macro) as in
//   Blackmagic's ATEM Switchers SDK: https://www.blackmagicdesign.com/developer/products/atem (manual:
//   https://documents.blackmagicdesign.com/DeveloperManuals/ATEMSDKManual.pdf). The SDK is a COM / Obj-C API,
//   not a wire spec; the bytes come from [AC].
//
// Packet [AC atemSocketChild.ts]: 12-byte header, big endian
//   0-1  flags (5 bits) << 11 | total length (11 bits)
//   2-3  session id            4-5  ack id (AckReply)       6-7  retransmit-from id (RetransmitRequest)
//   10-11 packet id (AckRequest)    flags: AckRequest 0x01, NewSessionId 0x02, IsRetransmit 0x04,
//                                    RetransmitRequest 0x08, AckReply 0x10
// Payload = commands [AC packetBuilder.ts]: u16 length (incl. 8-byte head), u16 0, 4-char name, data.
const FLAG = { AckRequest: 0x01, NewSessionId: 0x02, IsRetransmit: 0x04, RetransmitRequest: 0x08, AckReply: 0x10 };
const HELLO = Buffer.from([0x10, 0x14, 0x53, 0xab, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3a, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]); // [AC] COMMAND_CONNECT_HELLO
const MAX_PACKET_ID = 1 << 15;
const V8_0 = 0x0002001c; const V8_0_1 = 0x0002001d; const V8_1_1 = 0x0002001e; const V9_6 = 0x00020020; // [AC enums ProtocolVersion]
const STYLES = ['MIX', 'DIP', 'WIPE', 'DVE', 'STING']; // [AC enums TransitionStyle]
const MODELS = { 0x01: 'TVS', 0x02: '1 M/E', 0x03: '2 M/E', 0x04: 'Production Studio 4K', 0x05: '1 M/E Production Studio 4K', 0x06: '2 M/E Production Studio 4K', 0x07: '4 M/E Broadcast Studio 4K', 0x08: 'TVS HD', 0x09: 'TVS Pro HD', 0x0a: 'TVS Pro 4K',
  0x0b: 'Constellation 8K (HD/UHD)', 0x0c: 'Constellation 8K', 0x0d: 'Mini', 0x0e: 'Mini Pro', 0x0f: 'Mini Pro ISO', 0x10: 'Mini Extreme', 0x11: 'Mini Extreme ISO', 0x12: 'Constellation HD 1 M/E',
  0x13: 'Constellation HD 2 M/E', 0x14: 'Constellation HD 4 M/E', 0x15: 'SDI', 0x16: 'SDI Pro ISO', 0x17: 'SDI Extreme ISO', 0x1a: 'Television Studio HD8', 0x1b: 'Television Studio HD8 ISO',
  0x1c: 'Constellation 4K 1 M/E', 0x1d: 'Constellation 4K 2 M/E', 0x1e: 'Constellation 4K 4 M/E', 0x1f: 'Constellation 4K 4 M/E Plus', 0x20: 'Television Studio 4K8', 0x21: 'Mini Extreme ISO G2' }; // [AC enums Model]; 0x07 is named TwoMEBS4K there

function header(flags, len, session, { ack = 0, packetId = 0, retransmitFrom = 0 } = {}) {
  const b = Buffer.alloc(12);
  b.writeUInt16BE(((flags & 0x1f) << 11) | (len & 0x07ff), 0);
  b.writeUInt16BE(session & 0xffff, 2); b.writeUInt16BE(ack, 4); b.writeUInt16BE(retransmitFrom, 6); b.writeUInt16BE(packetId, 10);
  return b;
}
function parseHeader(p) {
  if (p.length < 12) return null;
  const w = p.readUInt16BE(0);
  return { flags: w >> 11, length: w & 0x07ff, session: p.readUInt16BE(2), ack: p.readUInt16BE(4), retransmitFrom: p.readUInt16BE(6), packetId: p.readUInt16BE(10) };
}
function cmd(name, data) { const h = Buffer.alloc(8); h.writeUInt16BE(data.length + 8, 0); h.write(name, 4, 4, 'ascii'); return Buffer.concat([h, data]); }
function splitCommands(payload) {
  const out = []; let o = 0;
  while (o + 8 <= payload.length) {
    const len = payload.readUInt16BE(o); if (len < 8 || o + len > payload.length) break;
    out.push({ name: payload.toString('ascii', o + 4, o + 8), data: payload.subarray(o + 8, o + len) }); o += len;
  }
  return out;
}
const str0 = (b, s, n) => { const x = b.subarray(s, s + n); const i = x.indexOf(0); return x.toString('utf8', 0, i < 0 ? x.length : i); }; // [AC atemUtil bufToNullTerminatedString]
const buf = (n, f) => { const b = Buffer.alloc(n); f(b); return b; };

// Outgoing commands [AC src/commands/**: serialize()]
const OUT = {
  cut: (me) => cmd('DCut', buf(4, (b) => b.writeUInt8(me, 0))),                                   // MixEffects/CutCommand.ts
  auto: (me) => cmd('DAut', buf(4, (b) => b.writeUInt8(me, 0))),                                  // MixEffects/AutoTransitionCommand.ts
  program: (me, src) => cmd('CPgI', buf(4, (b) => { b.writeUInt8(me, 0); b.writeUInt16BE(src, 2); })), // MixEffects/ProgramInputCommand.ts
  preview: (me, src) => cmd('CPvI', buf(4, (b) => { b.writeUInt8(me, 0); b.writeUInt16BE(src, 2); })), // MixEffects/PreviewInputCommand.ts
  style: (me, style) => cmd('CTTp', buf(4, (b) => { b.writeUInt8(1, 0); b.writeUInt8(me, 1); b.writeUInt8(style, 2); })), // Transition/TransitionPropertiesCommand.ts, mask nextStyle
  nextSelection: (me, bits) => cmd('CTTp', buf(4, (b) => { b.writeUInt8(2, 0); b.writeUInt8(me, 1); b.writeUInt8(bits, 3); })), // mask nextSelection
  mixRate: (me, rate) => cmd('CTMx', buf(4, (b) => { b.writeUInt8(me, 0); b.writeUInt8(rate, 1); })), // Transition/TransitionMixCommand.ts
  ftb: (me) => cmd('FtbA', buf(4, (b) => b.writeUInt8(me, 0))),                                    // FadeToBlack/FadeToBlackAutoCommand.ts
  ftbRate: (me, rate) => cmd('FtbC', buf(4, (b) => { b.writeUInt8(1, 0); b.writeUInt8(me, 1); b.writeUInt8(rate, 2); })), // FadeToBlackRateCommand.ts
  dskAuto: (i, version) => cmd('DDsA', buf(4, (b) => { if (version >= V8_0_1) { b.writeUInt8(0, 0); b.writeUInt8(i, 1); } else b.writeUInt8(i, 0); })), // DownstreamKeyAutoCommand.ts
  dskOnAir: (i, on) => cmd('CDsL', buf(4, (b) => { b.writeUInt8(i, 0); b.writeUInt8(on ? 1 : 0, 1); })), // DownstreamKeyOnAirCommand.ts
  dskTie: (i, tie) => cmd('CDsT', buf(4, (b) => { b.writeUInt8(i, 0); b.writeUInt8(tie ? 1 : 0, 1); })), // DownstreamKeyTieCommand.ts
  uskOnAir: (me, k, on) => cmd('CKOn', buf(4, (b) => { b.writeUInt8(me, 0); b.writeUInt8(k, 1); b.writeUInt8(on ? 1 : 0, 2); })), // Key/MixEffectKeyOnAirCommand.ts
  aux: (i, src) => cmd('CAuS', buf(4, (b) => { b.writeUInt8(1, 0); b.writeUInt8(i, 1); b.writeUInt16BE(src, 2); })), // AuxSourceCommand.ts
  macroRun: (i) => cmd('MAct', buf(4, (b) => { b.writeUInt16BE(i, 0); b.writeUInt8(0, 2); })),     // MacroAction.Run = 0
  macroStop: () => cmd('MAct', buf(4, (b) => { b.writeUInt16BE(0xffff, 0); b.writeUInt8(1, 2); })), // MacroAction.Stop = 1
  macroStopRecord: () => cmd('MAct', buf(4, (b) => { b.writeUInt16BE(0xffff, 0); b.writeUInt8(2, 2); })), // StopRecord = 2
  macroUserWait: () => cmd('MAct', buf(4, (b) => { b.writeUInt16BE(0xffff, 0); b.writeUInt8(3, 2); })), // InsertUserWait = 3
  macroContinue: () => cmd('MAct', buf(4, (b) => { b.writeUInt16BE(0xffff, 0); b.writeUInt8(4, 2); })), // Continue = 4
  macroRecord: (i) => cmd('MAct', buf(4, (b) => { b.writeUInt16BE(i, 0); b.writeUInt8(5, 2); })), // Record = 5
};

function emptyState() {
  return { version: 0, product: '', model: 0, topology: null, mes: {}, inputs: {}, dsk: {}, aux: {}, macros: {}, macroRun: { isRunning: false, isWaiting: false, macroIndex: 0xffff }, tally: {}, initComplete: false,
    mvConfig: null, ssConfig: {}, mv: {}, ss: {}, audioMixer: null, classic: null, fairlight: null, routing: { outputs: {}, sources: {} } };
}
const me0 = (st, i) => (st.mes[i] = st.mes[i] || { program: 0, preview: 0, style: 0, selection: 1, nextStyle: 0, nextSelection: 1, inTransition: false, remainingFrames: 0, handle: 0, mixRate: 25, ftb: { black: false, inTransition: false, remaining: 0, rate: 25 }, keyers: {}, keyCount: 0 });
const key0 = (st, me, k) => { const m = me0(st, me); return (m.keyers[k] = m.keyers[k] || { onAir: false }); };
const bits = (v) => [0, 1, 2, 3, 4].filter((i) => v & (1 << i)); // TransitionSelection: bit0 background, bit1.. key 1..

// Incoming state [AC src/commands/**: deserialize()]. Returns true when the command was understood.
function applyCommand(st, name, d) {
  switch (name) {
    case '_ver': st.version = d.readUInt32BE(0); return true; // DeviceProfile/versionCommand.ts
    case '_pin': st.product = str0(d, 0, 40); st.model = d.length > 40 ? d.readUInt8(40) : 0; return true; // productIdentifierCommand.ts
    case '_top': { const off = st.version > V8_0_1 ? 1 : 0; const u = (i) => (d.length > i ? d.readUInt8(i) : 0); st.topology = { mixEffects: u(0), sources: u(1), downstreamKeyers: u(2), auxilliaries: u(3), mixMinusOutputs: u(4), mediaPlayers: u(5), multiviewers: off ? u(6) : -1, serialPorts: u(6 + off), maxHyperdecks: u(7 + off), DVEs: u(8 + off), stingers: u(9 + off), superSources: u(10 + off), talkbackChannels: u(12 + off), cameraControl: u(17 + off) === 1, advancedChromaKeyers: d.length > 20 && u(21 + off) === 1 }; return true; } // topologyCommand.ts
    case '_MeC': me0(st, d.readUInt8(0)).keyCount = d.readUInt8(1); return true; // mixEffectBlockConfigCommand.ts
    case 'InPr': { const id = d.readUInt16BE(0); st.inputs[id] = { id, longName: str0(d, 2, 20), shortName: str0(d, 22, 4), externalPorts: d.readUInt16BE(28), externalPortType: d.readUInt16BE(30), internalPortType: d.readUInt8(32), sourceAvailability: d.readUInt8(34), meAvailability: d.readUInt8(35) }; return true; } // Inputs/InputPropertiesCommand.ts
    case 'PrgI': me0(st, d.readUInt8(0)).program = d.readUInt16BE(2); return true;
    case 'PrvI': me0(st, d.readUInt8(0)).preview = d.readUInt16BE(2); return true;
    case 'TrSS': { const m = me0(st, d.readUInt8(0)); m.style = d.readUInt8(1); m.selection = d.readUInt8(2); m.nextStyle = d.readUInt8(3); m.nextSelection = d.readUInt8(4); return true; } // TransitionPropertiesCommand.ts
    case 'TrPs': { const m = me0(st, d.readUInt8(0)); m.inTransition = d.readUInt8(1) === 1; m.remainingFrames = d.readUInt8(2); m.handle = d.readUInt16BE(4); return true; } // TransitionPositionCommand.ts
    case 'TMxP': me0(st, d.readUInt8(0)).mixRate = d.readUInt8(1); return true; // TransitionMixCommand.ts
    case 'FtbS': { const f = me0(st, d.readUInt8(0)).ftb; f.black = d.readUInt8(1) === 1; f.inTransition = d.readUInt8(2) === 1; f.remaining = d.readUInt8(3); return true; } // FadeToBlackStateCommand.ts
    case 'FtbP': me0(st, d.readUInt8(0)).ftb.rate = d.readUInt8(1); return true; // FadeToBlackRateCommand.ts
    case 'KeOn': key0(st, d.readUInt8(0), d.readUInt8(1)).onAir = d.readUInt8(2) === 1; return true; // MixEffectKeyOnAirCommand.ts
    case 'DskS': { const k = d.readUInt8(0); const x = (st.dsk[k] = st.dsk[k] || {}); x.onAir = d.readUInt8(1) === 1; x.inTransition = d.readUInt8(2) === 1; x.isAuto = d.readUInt8(3) === 1; x.remainingFrames = st.version >= V8_0_1 ? d.readUInt8(5) : d.readUInt8(4); return true; } // DownstreamKeyStateCommand.ts (V8_0_1 layout)
    case 'DskP': { const k = d.readUInt8(0); const x = (st.dsk[k] = st.dsk[k] || {}); Object.assign(x, { tie: d.readUInt8(1) === 1, rate: d.readUInt8(2), preMultiply: d.readUInt8(3) === 1, clip: d.readUInt16BE(4), gain: d.readUInt16BE(6), invert: d.readUInt8(8) === 1,
      mask: { enabled: d.readUInt8(9) === 1, top: d.readInt16BE(10), bottom: d.readInt16BE(12), left: d.readInt16BE(14), right: d.readInt16BE(16) } }); return true; } // DownstreamKeyPropertiesCommand.ts
    case 'AuxS': st.aux[d.readUInt8(0)] = d.readUInt16BE(2); return true; // AuxSourceCommand.ts
    case 'MPrp': { const i = d.readUInt16BE(0); const nl = d.readUInt16BE(4); const dl = d.readUInt16BE(6); st.macros[i] = { index: i, isUsed: d.readUInt8(2) !== 0, name: str0(d, 8, nl), description: str0(d, 8 + nl, dl) }; return true; } // Macro/MacroPropertiesCommand.ts
    case 'MRPr': st.macroRun = { isRunning: !!(d.readUInt8(0) & 1), isWaiting: !!(d.readUInt8(0) & 2), loop: d.readUInt8(1) !== 0, macroIndex: d.readUInt16BE(2) }; return true; // Macro/MacroRunStatusCommand.ts
    case 'TlSr': { const n = d.readUInt16BE(0); const t = {}; for (let i = 0; i < n; i++) { const src = d.readUInt16BE(2 + i * 3); const v = d.readUInt8(4 + i * 3); t[src] = { program: (v & 1) > 0, preview: (v & 2) > 0 }; } st.tally = t; return true; } // TallyBySourceCommand.ts
    case 'InCm': st.initComplete = true; return true; // InitCompleteCommand.ts
    default: return applyCommand2(st, name, d);
  }
}

// ---------- 0.10.0: router, audio, keyers, DSK, SuperSource ----------
// Writable commands carry a mask of the fields they change; every field is still written (as atem-connection does),
// so the driver passes the current state merged with the change. Units are the switcher's own integers:
//   DVE position / size x1000, rotation x10 (degrees), masks x1000, luma / chroma / DSK clip & gain x10 (percent),
//   pattern size / symmetry / softness x100, pattern position x10000, SuperSource box x / y x100, size / crop x1000,
//   Fairlight gains / balance x100 (dB, percent), classic gain as the UInt16 level (dB via dbToU16).
const w = {
  u8: (b, o, v) => b.writeUInt8((Number(v) || 0) & 0xff, o), i8: (b, o, v) => b.writeInt8(Math.max(-128, Math.min(127, Number(v) || 0)), o),
  u16: (b, o, v) => b.writeUInt16BE((Number(v) || 0) & 0xffff, o), i16: (b, o, v) => b.writeInt16BE(Math.max(-32768, Math.min(32767, Math.round(Number(v) || 0))), o),
  u32: (b, o, v) => b.writeUInt32BE((Number(v) >>> 0), o), i32: (b, o, v) => b.writeInt32BE(Math.round(Number(v) || 0) | 0, o), bool: (b, o, v) => b.writeUInt8(v ? 1 : 0, o),
};
// Classic audio: 0 = -inf, 32768 = 0 dB, 65381 = +6 dB [AC atemUtil]
const u16ToDb = (v) => (v <= 0 ? -Infinity : Math.round(Math.log10(v / 32768) * 20 * 100) / 100);
const dbToU16 = (db) => (db === -Infinity || db <= -60 ? 0 : Math.min(65535, Math.floor(10 ** (db / 20) * 32768)));
const balToInt = (b) => Math.round(Number(b) * 200); const intToBal = (i) => Math.round(i / 200); // classic balance -50..+50 <-> -10000..+10000
const KEY_TYPES = ['luma', 'chroma', 'pattern', 'dve'];
const FLY_FRAMES = { a: 1, b: 2, full: 3, infinite: 4 }; // FlyKeyKeyFrame
const MIX = { classic: ['off', 'on', 'afv'], fairlight: { 1: 'off', 2: 'on', 4: 'afv' } }; // AudioMixOption / FairlightAudioMixOption
const FL_MIX = { off: 1, on: 2, afv: 4 };
const FL_STEREO = '-65280'; // the Fairlight source id of a stereo (or mono) input channel; -256 / -255 are dual-mono left / right

Object.assign(OUT, {
  // Settings/MultiViewerSourceCommand.ts
  mvSource: (mv, win, src) => cmd('CMvI', buf(4, (b) => { w.u8(b, 0, mv); w.u8(b, 1, win); w.u16(b, 2, src); })),
  // MixEffects/Key/*
  uskType: (me, k, p, mask) => cmd('CKTp', buf(8, (b) => { w.u8(b, 0, mask); w.u8(b, 1, me); w.u8(b, 2, k); w.u8(b, 3, p.type); w.bool(b, 4, p.flyEnabled); })),
  uskFill: (me, k, src) => cmd('CKeF', buf(4, (b) => { w.u8(b, 0, me); w.u8(b, 1, k); w.u16(b, 2, src); })),
  uskCut: (me, k, src) => cmd('CKeC', buf(4, (b) => { w.u8(b, 0, me); w.u8(b, 1, k); w.u16(b, 2, src); })),
  uskMask: (me, k, p, mask) => cmd('CKMs', buf(12, (b) => { w.u8(b, 0, mask); w.u8(b, 1, me); w.u8(b, 2, k); w.bool(b, 3, p.enabled); w.i16(b, 4, p.top); w.i16(b, 6, p.bottom); w.i16(b, 8, p.left); w.i16(b, 10, p.right); })),
  uskLuma: (me, k, p, mask) => cmd('CKLm', buf(12, (b) => { w.u8(b, 0, mask); w.u8(b, 1, me); w.u8(b, 2, k); w.bool(b, 3, p.preMultiplied); w.u16(b, 4, p.clip); w.u16(b, 6, p.gain); w.bool(b, 8, p.invert); })),
  uskChroma: (me, k, p, mask) => cmd('CKCk', buf(16, (b) => { w.u8(b, 0, mask); w.u8(b, 1, me); w.u8(b, 2, k); w.u16(b, 4, p.hue); w.u16(b, 6, p.gain); w.u16(b, 8, p.ySuppress); w.u16(b, 10, p.lift); w.bool(b, 12, p.narrow); })),
  uskPattern: (me, k, p, mask) => cmd('CKPt', buf(16, (b) => { w.u8(b, 0, mask); w.u8(b, 1, me); w.u8(b, 2, k); w.u8(b, 3, p.style); w.u16(b, 4, p.size); w.u16(b, 6, p.symmetry); w.u16(b, 8, p.softness); w.u16(b, 10, p.positionX); w.u16(b, 12, p.positionY); w.bool(b, 14, p.invert); })),
  uskDve: (me, k, p, mask) => cmd('CKDV', buf(64, (b) => {
    w.u32(b, 0, mask); w.u8(b, 4, me); w.u8(b, 5, k); w.u32(b, 8, p.sizeX); w.u32(b, 12, p.sizeY); w.i32(b, 16, p.positionX); w.i32(b, 20, p.positionY); w.i32(b, 24, p.rotation);
    w.bool(b, 28, p.borderEnabled); w.bool(b, 29, p.shadowEnabled); w.u8(b, 30, p.borderBevel); w.u16(b, 32, p.borderOuterWidth); w.u16(b, 34, p.borderInnerWidth); w.u8(b, 36, p.borderOuterSoftness); w.u8(b, 37, p.borderInnerSoftness);
    w.u8(b, 38, p.borderBevelSoftness); w.u8(b, 39, p.borderBevelPosition); w.u8(b, 40, p.borderOpacity); w.u16(b, 42, p.borderHue); w.u16(b, 44, p.borderSaturation); w.u16(b, 46, p.borderLuma);
    w.u16(b, 48, p.lightSourceDirection); w.u8(b, 50, p.lightSourceAltitude); w.bool(b, 51, p.maskEnabled); w.u16(b, 52, p.maskTop); w.u16(b, 54, p.maskBottom); w.u16(b, 56, p.maskLeft); w.u16(b, 58, p.maskRight); w.u8(b, 60, p.rate);
  })),
  uskFlyStore: (me, k, kf) => cmd('SFKF', buf(4, (b) => { w.u8(b, 0, me); w.u8(b, 1, k); w.u8(b, 2, kf); })), // MixEffectKeyFlyKeyframeStoreCommand
  uskFlyRun: (me, k, kf, dir = 0) => cmd('RFlK', buf(8, (b) => { w.u8(b, 0, kf === FLY_FRAMES.infinite ? 2 : 0); w.u8(b, 1, me); w.u8(b, 2, k); w.u8(b, 4, kf); w.u8(b, 5, dir); })), // MixEffectKeyRunToCommand
  // DownstreamKey/*
  dskFill: (i, src) => cmd('CDsF', buf(4, (b) => { w.u8(b, 0, i); w.u16(b, 2, src); })),
  dskCut: (i, src) => cmd('CDsC', buf(4, (b) => { w.u8(b, 0, i); w.u16(b, 2, src); })),
  dskGeneral: (i, p, mask) => cmd('CDsG', buf(12, (b) => { w.u8(b, 0, mask); w.u8(b, 1, i); w.bool(b, 2, p.preMultiply); w.i16(b, 4, p.clip); w.i16(b, 6, p.gain); w.bool(b, 8, p.invert); })),
  dskMask: (i, p, mask) => cmd('CDsM', buf(12, (b) => { w.u8(b, 0, mask); w.u8(b, 1, i); w.bool(b, 2, p.enabled); w.i16(b, 4, p.top); w.i16(b, 6, p.bottom); w.i16(b, 8, p.left); w.i16(b, 10, p.right); })),
  dskRate: (i, rate) => cmd('CDsR', buf(4, (b) => { w.u8(b, 0, i); w.u8(b, 1, rate); })),
  // SuperSource/* (V8.0+ layouts; before 8.0 there is one SuperSource and no id byte)
  ssBox: (ss, box, p, mask, version = V9_6) => cmd('CSBP', buf(24, (b) => {
    let i = 0; w.u16(b, 0, mask); if (version >= V8_0) { i = 1; w.u8(b, 2, ss); }
    w.u8(b, i + 2, box); w.bool(b, i + 3, p.enabled); if (i === 1) i++;
    w.u16(b, i + 4, p.source); w.i16(b, i + 6, p.x); w.i16(b, i + 8, p.y); w.u16(b, i + 10, p.size); w.bool(b, i + 12, p.cropped); w.u16(b, i + 14, p.cropTop); w.u16(b, i + 16, p.cropBottom); w.u16(b, i + 18, p.cropLeft); w.u16(b, i + 20, p.cropRight);
  })),
  ssProps: (ss, p, mask) => cmd('CSSc', buf(16, (b) => { w.u8(b, 0, mask); w.u8(b, 1, ss); w.u16(b, 2, p.artFillSource); w.u16(b, 4, p.artCutSource); w.u8(b, 6, p.artOption); w.bool(b, 7, p.artPreMultiplied); w.u16(b, 8, p.artClip); w.u16(b, 10, p.artGain); w.bool(b, 12, p.artInvertKey); })),
  ssBorder: (ss, p, mask) => cmd('CSBd', buf(24, (b) => {
    w.u16(b, 0, mask); w.u8(b, 2, ss); w.bool(b, 3, p.borderEnabled); w.u8(b, 4, p.borderBevel); w.u16(b, 6, p.borderOuterWidth); w.u16(b, 8, p.borderInnerWidth); w.u8(b, 10, p.borderOuterSoftness); w.u8(b, 11, p.borderInnerSoftness);
    w.u8(b, 12, p.borderBevelSoftness); w.u8(b, 13, p.borderBevelPosition); w.u16(b, 14, p.borderHue); w.u16(b, 16, p.borderSaturation); w.u16(b, 18, p.borderLuma); w.u16(b, 20, p.borderLightSourceDirection); w.u8(b, 22, p.borderLightSourceAltitude);
  })),
  // Audio/* (classic mixer)
  classicInput: (id, p, mask) => cmd('CAMI', buf(12, (b) => { w.u8(b, 0, mask); w.u16(b, 2, id); w.u8(b, 4, p.mixOption); w.u16(b, 6, p.gain); w.i16(b, 8, p.balance); w.bool(b, 10, p.rcaToXlrEnabled); })),
  classicMaster: (p, mask) => cmd('CAMM', buf(8, (b) => { w.u8(b, 0, mask); w.u16(b, 2, p.gain); w.i16(b, 4, p.balance); w.bool(b, 6, p.followFadeToBlack); })),
  classicMonitor: (p, mask) => cmd('CAMm', buf(12, (b) => { w.u8(b, 0, mask); w.bool(b, 1, p.enabled); w.u16(b, 2, p.gain); w.bool(b, 4, p.mute); w.bool(b, 5, p.solo); w.u16(b, 6, p.soloSource); w.bool(b, 8, p.dim); w.u16(b, 10, p.dimLevel); })),
  classicHeadphones: (p, mask) => cmd('CAMH', buf(12, (b) => { w.u8(b, 0, mask); w.u16(b, 2, p.gain); w.u16(b, 4, p.programOutGain); w.u16(b, 6, p.talkbackGain); w.u16(b, 8, p.sidetoneGain); })),
  // Fairlight/*
  flSource: (index, source, p, mask) => cmd('CFSP', buf(48, (b) => {
    w.u16(b, 0, mask); w.u16(b, 2, index); b.writeBigInt64BE(BigInt(source), 8); w.u8(b, 16, p.framesDelay); w.i32(b, 20, p.gain); w.i16(b, 24, p.stereoSimulation); w.bool(b, 26, p.equalizerEnabled);
    w.i32(b, 28, p.equalizerGain); w.i32(b, 32, p.makeUpGain); w.i16(b, 36, p.balance); w.i32(b, 40, p.faderGain); w.u8(b, 44, p.mixOption);
  })),
  flMaster: (p, mask) => cmd('CFMP', buf(20, (b) => { w.u8(b, 0, mask); w.bool(b, 1, p.equalizerEnabled); w.i32(b, 4, p.equalizerGain); w.i32(b, 8, p.makeUpGain); w.i32(b, 12, p.faderGain); w.bool(b, 16, p.followFadeToBlack); })),
  flMonitor: (p, mask) => cmd('CFMH', buf(36, (b) => { w.u8(b, 0, mask); w.i32(b, 4, p.gain); w.i32(b, 8, p.inputMasterGain); w.u8(b, 12, p.inputMasterMuted ? 0 : 1); w.i32(b, 16, p.inputTalkbackGain); w.u8(b, 20, p.inputTalkbackMuted ? 0 : 1); w.i32(b, 32, p.inputSidetoneGain); })),
  flSolo: (p, mask) => cmd('CFMS', buf(24, (b) => { w.u8(b, 0, mask); w.bool(b, 1, p.solo); w.u16(b, 8, p.index); if (p.source) b.writeBigInt64BE(BigInt(p.source), 16); })),
  // 0.11.0 DESK ZERO resets [AC 3.10.3 Fairlight/*Reset*.ts] — encodings from atem-connection, NOT yet verified on hardware
  flSourceDynReset: (index, source) => cmd('RICD', buf(20, (b) => { w.u16(b, 0, index); b.writeBigInt64BE(BigInt(source), 8); w.u8(b, 17, 0b1111); })), // dynamics|expander|compressor|limiter
  flSourceEqReset: (index, source) => cmd('RICE', buf(20, (b) => { w.u8(b, 0, 1); w.u16(b, 2, index); b.writeBigInt64BE(BigInt(source), 8); w.u8(b, 16, 1); })), // flag equalizer, equalizer = true
  flMasterDynReset: () => cmd('RMOD', buf(4, (b) => { w.u8(b, 1, 0b1111); })),
  flMasterEqReset: () => cmd('RMOE', buf(4, (b) => { w.u8(b, 0, 1); w.u8(b, 1, 1); })),
  // 0.11.0 StartupStateSave [AC 3.10.3 StartupStateCommand.ts]: 4 bytes, mode 0 — NOT yet verified on hardware
  startupSave: () => cmd('SRsv', buf(4, () => {})),
  // Fairlight/AudioRouting/AudioRoutingOutput.ts (mask 1 = source)
  audioRoute: (output, source, mask = 1, name = '') => cmd('AROC', buf(76, (b) => { w.u8(b, 0, mask); w.u32(b, 4, output); w.u32(b, 8, source); b.write(String(name).slice(0, 63), 12, 'utf8'); })),
});


// Mask bit order of each writable command [AC src/commands/**: MaskFlags]; null = an unused bit
const MASKS = {
  CKTp: ['type', 'flyEnabled'], CKMs: ['enabled', 'top', 'bottom', 'left', 'right'], CKLm: ['preMultiplied', 'clip', 'gain', 'invert'], CKCk: ['hue', 'gain', 'ySuppress', 'lift', 'narrow'],
  CKPt: ['style', 'size', 'symmetry', 'softness', 'positionX', 'positionY', 'invert'],
  CKDV: ['sizeX', 'sizeY', 'positionX', 'positionY', 'rotation', 'borderEnabled', 'shadowEnabled', 'borderBevel', 'borderOuterWidth', 'borderInnerWidth', 'borderOuterSoftness', 'borderInnerSoftness', 'borderBevelSoftness',
    'borderBevelPosition', 'borderOpacity', 'borderHue', 'borderSaturation', 'borderLuma', 'lightSourceDirection', 'lightSourceAltitude', 'maskEnabled', 'maskTop', 'maskBottom', 'maskLeft', 'maskRight', 'rate'],
  CDsG: ['preMultiply', 'clip', 'gain', 'invert'], CDsM: ['enabled', 'top', 'bottom', 'left', 'right'],
  CSBP: ['enabled', 'source', 'x', 'y', 'size', 'cropped', 'cropTop', 'cropBottom', 'cropLeft', 'cropRight'],
  CSSc: ['artFillSource', 'artCutSource', 'artOption', 'artPreMultiplied', 'artClip', 'artGain', 'artInvertKey'],
  CSBd: ['borderEnabled', 'borderBevel', 'borderOuterWidth', 'borderInnerWidth', 'borderOuterSoftness', 'borderInnerSoftness', 'borderBevelSoftness', 'borderBevelPosition', 'borderHue', 'borderSaturation', 'borderLuma', 'borderLightSourceDirection', 'borderLightSourceAltitude'],
  CAMI: ['mixOption', 'gain', 'balance', 'rcaToXlrEnabled'], CAMM: ['gain', 'balance', 'followFadeToBlack'], CAMm: ['enabled', 'gain', 'mute', 'solo', 'soloSource', 'dim', 'dimLevel'], CAMH: ['gain', 'programOutGain', 'talkbackGain', 'sidetoneGain'],
  CFSP: ['framesDelay', 'gain', 'stereoSimulation', 'equalizerEnabled', 'equalizerGain', 'makeUpGain', 'balance', 'faderGain', 'mixOption'], CFMP: ['equalizerEnabled', 'equalizerGain', 'makeUpGain', 'faderGain', 'followFadeToBlack'],
  CFMH: ['gain', 'inputMasterGain', 'inputMasterMuted', 'inputTalkbackGain', 'inputTalkbackMuted', null, null, 'inputSidetoneGain'], CFMS: ['solo', 'index'],
};
const maskOf = (name, keys) => keys.reduce((m, k) => { const i = MASKS[name].indexOf(k); return i < 0 ? m : m | (1 << i); }, 0);
// Field layout of each writable command, for the simulator to read what the driver sends: [field, offset, type]
const SETTER = {
  CKTp: { me: 1, key: 2, f: [['type', 3, 'u8'], ['flyEnabled', 4, 'b']] },
  CKMs: { me: 1, key: 2, f: [['enabled', 3, 'b'], ['top', 4, 'i16'], ['bottom', 6, 'i16'], ['left', 8, 'i16'], ['right', 10, 'i16']] },
  CKLm: { me: 1, key: 2, f: [['preMultiplied', 3, 'b'], ['clip', 4, 'u16'], ['gain', 6, 'u16'], ['invert', 8, 'b']] },
  CKCk: { me: 1, key: 2, f: [['hue', 4, 'u16'], ['gain', 6, 'u16'], ['ySuppress', 8, 'u16'], ['lift', 10, 'u16'], ['narrow', 12, 'b']] },
  CKPt: { me: 1, key: 2, f: [['style', 3, 'u8'], ['size', 4, 'u16'], ['symmetry', 6, 'u16'], ['softness', 8, 'u16'], ['positionX', 10, 'u16'], ['positionY', 12, 'u16'], ['invert', 14, 'b']] },
  CKDV: { mask32: true, me: 4, key: 5, f: [['sizeX', 8, 'u32'], ['sizeY', 12, 'u32'], ['positionX', 16, 'i32'], ['positionY', 20, 'i32'], ['rotation', 24, 'i32'], ['borderEnabled', 28, 'b'], ['shadowEnabled', 29, 'b'], ['borderBevel', 30, 'u8'],
    ['borderOuterWidth', 32, 'u16'], ['borderInnerWidth', 34, 'u16'], ['borderOuterSoftness', 36, 'u8'], ['borderInnerSoftness', 37, 'u8'], ['borderBevelSoftness', 38, 'u8'], ['borderBevelPosition', 39, 'u8'], ['borderOpacity', 40, 'u8'],
    ['borderHue', 42, 'u16'], ['borderSaturation', 44, 'u16'], ['borderLuma', 46, 'u16'], ['lightSourceDirection', 48, 'u16'], ['lightSourceAltitude', 50, 'u8'], ['maskEnabled', 51, 'b'], ['maskTop', 52, 'u16'], ['maskBottom', 54, 'u16'],
    ['maskLeft', 56, 'u16'], ['maskRight', 58, 'u16'], ['rate', 60, 'u8']] },
  CDsG: { idx: 1, f: [['preMultiply', 2, 'b'], ['clip', 4, 'i16'], ['gain', 6, 'i16'], ['invert', 8, 'b']] },
  CDsM: { idx: 1, f: [['enabled', 2, 'b'], ['top', 4, 'i16'], ['bottom', 6, 'i16'], ['left', 8, 'i16'], ['right', 10, 'i16']] },
  CSBP: { mask16: true, idx: 2, box: 3, f: [['enabled', 4, 'b'], ['source', 6, 'u16'], ['x', 8, 'i16'], ['y', 10, 'i16'], ['size', 12, 'u16'], ['cropped', 14, 'b'], ['cropTop', 16, 'u16'], ['cropBottom', 18, 'u16'], ['cropLeft', 20, 'u16'], ['cropRight', 22, 'u16']] },
  CSSc: { idx: 1, f: [['artFillSource', 2, 'u16'], ['artCutSource', 4, 'u16'], ['artOption', 6, 'u8'], ['artPreMultiplied', 7, 'b'], ['artClip', 8, 'u16'], ['artGain', 10, 'u16'], ['artInvertKey', 12, 'b']] },
  CSBd: { mask16: true, idx: 2, f: [['borderEnabled', 3, 'b'], ['borderBevel', 4, 'u8'], ['borderOuterWidth', 6, 'u16'], ['borderInnerWidth', 8, 'u16'], ['borderOuterSoftness', 10, 'u8'], ['borderInnerSoftness', 11, 'u8'], ['borderBevelSoftness', 12, 'u8'],
    ['borderBevelPosition', 13, 'u8'], ['borderHue', 14, 'u16'], ['borderSaturation', 16, 'u16'], ['borderLuma', 18, 'u16'], ['borderLightSourceDirection', 20, 'u16'], ['borderLightSourceAltitude', 22, 'u8']] },
  CAMI: { id16: 2, f: [['mixOption', 4, 'u8'], ['gain', 6, 'u16'], ['balance', 8, 'i16'], ['rcaToXlrEnabled', 10, 'b']] },
  CAMM: { f: [['gain', 2, 'u16'], ['balance', 4, 'i16'], ['followFadeToBlack', 6, 'b']] },
  CAMm: { f: [['enabled', 1, 'b'], ['gain', 2, 'u16'], ['mute', 4, 'b'], ['solo', 5, 'b'], ['soloSource', 6, 'u16'], ['dim', 8, 'b'], ['dimLevel', 10, 'u16']] },
  CAMH: { f: [['gain', 2, 'u16'], ['programOutGain', 4, 'u16'], ['talkbackGain', 6, 'u16'], ['sidetoneGain', 8, 'u16']] },
  CFSP: { mask16: true, id16: 2, src64: 8, f: [['framesDelay', 16, 'u8'], ['gain', 20, 'i32'], ['stereoSimulation', 24, 'i16'], ['equalizerEnabled', 26, 'b'], ['equalizerGain', 28, 'i32'], ['makeUpGain', 32, 'i32'], ['balance', 36, 'i16'], ['faderGain', 40, 'i32'], ['mixOption', 44, 'u8']] },
  CFMP: { f: [['equalizerEnabled', 1, 'b'], ['equalizerGain', 4, 'i32'], ['makeUpGain', 8, 'i32'], ['faderGain', 12, 'i32'], ['followFadeToBlack', 16, 'b']] },
  CFMH: { f: [['gain', 4, 'i32'], ['inputMasterGain', 8, 'i32'], ['inputMasterMuted', 12, 'nb'], ['inputTalkbackGain', 16, 'i32'], ['inputTalkbackMuted', 20, 'nb'], null, null, ['inputSidetoneGain', 32, 'i32']] },
};
const RD = { u8: (d, o) => d.readUInt8(o), b: (d, o) => d.readUInt8(o) === 1, nb: (d, o) => d.readUInt8(o) === 0, u16: (d, o) => d.readUInt16BE(o), i16: (d, o) => d.readInt16BE(o), u32: (d, o) => d.readUInt32BE(o), i32: (d, o) => d.readInt32BE(o) };
// Read a writable command: { mask, ids, changes } where changes holds only the masked fields
function readSetter(name, d) {
  const s = SETTER[name]; if (!s) return null;
  const mask = s.mask32 ? d.readUInt32BE(0) : s.mask16 ? d.readUInt16BE(0) : d.readUInt8(0);
  const ids = {}; if (s.me !== undefined) ids.me = d.readUInt8(s.me); if (s.key !== undefined) ids.key = d.readUInt8(s.key); if (s.idx !== undefined) ids.index = d.readUInt8(s.idx);
  if (s.box !== undefined) ids.box = d.readUInt8(s.box); if (s.id16 !== undefined) ids.index = d.readUInt16BE(s.id16); if (s.src64 !== undefined) ids.source = d.readBigInt64BE(s.src64).toString();
  const changes = {}; s.f.forEach((f, i) => { if (f && mask & (1 << i)) changes[f[0]] = RD[f[2]](d, f[1]); });
  return { mask, ids, changes };
}

// Incoming state for the 0.10.0 parts [AC src/commands/**: deserialize()]
const mv0 = (st, i) => (st.mv[i] = st.mv[i] || { index: i, layout: 0, swapped: false, windows: {} });
const ss0 = (st, i) => (st.ss[i] = st.ss[i] || { index: i, boxes: {}, props: {}, border: {} });
const fl0 = (st) => (st.fairlight = st.fairlight || { inputs: {}, master: {}, monitor: null, solo: null });
const cl0 = (st) => (st.classic = st.classic || { inputs: {}, master: {}, monitor: null, headphones: null, afv: false });
function applyCommand2(st, name, d) {
  switch (name) {
    case '_MvC': st.mvConfig = st.version >= V8_1_1 ? { count: -1, windowCount: d.readUInt8(1) } : { count: d.readUInt8(0), windowCount: d.readUInt8(1) }; return true; // multiviewerConfigCommand.ts
    case '_SSC': if (st.version >= V8_0) st.ssConfig[d.readUInt8(0)] = { boxCount: d.readUInt8(2) }; else st.ssConfig[0] = { boxCount: d.readUInt8(0) }; return true; // superSourceConfigCommand.ts
    case '_AMC': st.audioMixer = { type: 'classic', inputs: d.readUInt8(0), monitors: d.readUInt8(1), headphones: d.readUInt8(2) }; cl0(st); return true; // audioMixerConfigCommand.ts
    case '_FAC': st.audioMixer = { type: 'fairlight', inputs: d.readUInt8(0), monitors: d.readUInt8(1) }; fl0(st); return true; // fairlightAudioMixerConfigCommand.ts
    case 'MvIn': { const m = mv0(st, d.readUInt8(0)); m.windows[d.readUInt8(1)] = { index: d.readUInt8(1), source: d.readUInt16BE(2), vu: d.readUInt8(4) !== 0, safeArea: d.readUInt8(5) !== 0 }; return true; } // MultiViewerSourceCommand.ts
    case 'MvPr': { const m = mv0(st, d.readUInt8(0)); m.layout = d.readUInt8(1); m.swapped = d.readUInt8(2) > 0; return true; } // MultiViewerPropertiesCommand.ts (V8)
    case 'KeBP': { const k = key0(st, d.readUInt8(0), d.readUInt8(1)); Object.assign(k, { type: d.readUInt8(2), canFlyKey: d.readUInt8(4) === 1, flyEnabled: d.readUInt8(5) === 1, fill: d.readUInt16BE(6), cut: d.readUInt16BE(8),
      mask: { enabled: d.readUInt8(10) === 1, top: d.readInt16BE(12), bottom: d.readInt16BE(14), left: d.readInt16BE(16), right: d.readInt16BE(18) } }); return true; } // MixEffectKeyPropertiesGetCommand.ts
    case 'KeLm': key0(st, d.readUInt8(0), d.readUInt8(1)).luma = { preMultiplied: d.readUInt8(2) === 1, clip: d.readUInt16BE(4), gain: d.readUInt16BE(6), invert: d.readUInt8(8) === 1 }; return true;
    case 'KeCk': key0(st, d.readUInt8(0), d.readUInt8(1)).chroma = { hue: d.readUInt16BE(2), gain: d.readUInt16BE(4), ySuppress: d.readUInt16BE(6), lift: d.readUInt16BE(8), narrow: d.readUInt8(10) === 1 }; return true;
    case 'KePt': key0(st, d.readUInt8(0), d.readUInt8(1)).pattern = { style: d.readUInt8(2), size: d.readUInt16BE(4), symmetry: d.readUInt16BE(6), softness: d.readUInt16BE(8), positionX: d.readUInt16BE(10), positionY: d.readUInt16BE(12), invert: d.readUInt8(14) === 1 }; return true;
    case 'KeDV': key0(st, d.readUInt8(0), d.readUInt8(1)).dve = { sizeX: d.readUInt32BE(4), sizeY: d.readUInt32BE(8), positionX: d.readInt32BE(12), positionY: d.readInt32BE(16), rotation: d.readInt32BE(20),
      borderEnabled: d.readUInt8(24) === 1, shadowEnabled: d.readUInt8(25) === 1, borderBevel: d.readUInt8(26), borderOuterWidth: d.readUInt16BE(28), borderInnerWidth: d.readUInt16BE(30), borderOuterSoftness: d.readInt8(32), borderInnerSoftness: d.readInt8(33),
      borderBevelSoftness: d.readInt8(34), borderBevelPosition: d.readInt8(35), borderOpacity: d.readInt8(36), borderHue: d.readUInt16BE(38), borderSaturation: d.readUInt16BE(40), borderLuma: d.readUInt16BE(42), lightSourceDirection: d.readUInt16BE(44),
      lightSourceAltitude: d.readUInt8(46), maskEnabled: d.readUInt8(47) === 1, maskTop: d.readUInt16BE(48), maskBottom: d.readUInt16BE(50), maskLeft: d.readUInt16BE(52), maskRight: d.readUInt16BE(54), rate: d.readUInt8(56) }; return true;
    case 'KeFS': key0(st, d.readUInt8(0), d.readUInt8(1)).fly = { isASet: d.readUInt8(2) === 1, isBSet: d.readUInt8(3) === 1, runningToKeyFrame: d.readUInt8(4), isAtKeyFrame: d.readUInt8(6), runToInfiniteIndex: d.readUInt8(7) }; return true; // MixEffectKeyFlyPropertiesGetCommand.ts
    case 'KKFP': { const k = key0(st, d.readUInt8(0), d.readUInt8(1)); const f = d.readUInt8(2); if (f < 1 || f > 2) return true; k.keyframes = k.keyframes || {};
      k.keyframes[f === 1 ? 'a' : 'b'] = { sizeX: d.readUInt32BE(4), sizeY: d.readUInt32BE(8), positionX: d.readInt32BE(12), positionY: d.readInt32BE(16), rotation: d.readInt32BE(20) }; return true; } // MixEffectKeyFlyKeyframeCommand.ts (geometry only)
    case 'DskB': { const k = d.readUInt8(0); const x = (st.dsk[k] = st.dsk[k] || {}); x.fill = d.readUInt16BE(2); x.cut = d.readUInt16BE(4); return true; } // DownstreamKeySourcesCommand.ts
    case 'SSrc': { if (st.version >= V8_0) { const s = ss0(st, d.readUInt8(0)); s.props = { artFillSource: d.readUInt16BE(2), artCutSource: d.readUInt16BE(4), artOption: d.readUInt8(6), artPreMultiplied: d.readUInt8(7) === 1, artClip: d.readUInt16BE(8), artGain: d.readUInt16BE(10), artInvertKey: d.readUInt8(12) === 1 }; return true; }
      const s = ss0(st, 0); s.props = { artFillSource: d.readUInt16BE(0), artCutSource: d.readUInt16BE(2), artOption: d.readUInt8(4), artPreMultiplied: d.readUInt8(5) === 1, artClip: d.readUInt16BE(6), artGain: d.readUInt16BE(8), artInvertKey: d.readUInt8(10) === 1 };
      s.border = { borderEnabled: d.readUInt8(11) === 1, borderBevel: d.readUInt8(12), borderOuterWidth: d.readUInt16BE(14), borderInnerWidth: d.readUInt16BE(16), borderOuterSoftness: d.readUInt8(18), borderInnerSoftness: d.readUInt8(19), borderBevelSoftness: d.readUInt8(20), borderBevelPosition: d.readUInt8(21),
        borderHue: d.readUInt16BE(22), borderSaturation: d.readUInt16BE(24), borderLuma: d.readUInt16BE(26), borderLightSourceDirection: d.readUInt16BE(28), borderLightSourceAltitude: d.readUInt8(30) }; return true; } // SuperSourcePropertiesCommand.ts
    case 'SSBd': ss0(st, d.readUInt8(0)).border = { borderEnabled: d.readUInt8(1) === 1, borderBevel: d.readUInt8(2), borderOuterWidth: d.readUInt16BE(4), borderInnerWidth: d.readUInt16BE(6), borderOuterSoftness: d.readUInt8(8), borderInnerSoftness: d.readUInt8(9),
      borderBevelSoftness: d.readUInt8(10), borderBevelPosition: d.readUInt8(11), borderHue: d.readUInt16BE(12), borderSaturation: d.readUInt16BE(14), borderLuma: d.readUInt16BE(16), borderLightSourceDirection: d.readUInt16BE(18), borderLightSourceAltitude: d.readUInt8(20) }; return true;
    case 'SSBP': { const v8 = st.version >= V8_0; const i = v8 ? 2 : 0; const s = ss0(st, v8 ? d.readUInt8(0) : 0); const box = d.readUInt8(v8 ? 1 : 0);
      s.boxes[box] = { index: box, enabled: d.readUInt8(v8 ? 2 : 1) === 1, source: d.readUInt16BE(i + 2), x: d.readInt16BE(i + 4), y: d.readInt16BE(i + 6), size: d.readUInt16BE(i + 8), cropped: d.readUInt8(i + 10) === 1,
        cropTop: d.readUInt16BE(i + 12), cropBottom: d.readUInt16BE(i + 14), cropLeft: d.readUInt16BE(i + 16), cropRight: d.readUInt16BE(i + 18) }; return true; } // SuperSourceBoxParametersCommand.ts
    // classic audio
    case 'AMIP': { const c = cl0(st); const id = d.readUInt16BE(0); c.inputs[id] = { id, sourceType: d.readUInt8(2), portType: d.readUInt16BE(6), mixOption: d.readUInt8(8), gain: d.readUInt16BE(10), balance: d.readInt16BE(12),
      supportsRcaToXlr: st.version >= V8_0 && d.length > 15 ? d.readUInt8(14) !== 0 : false, rcaToXlrEnabled: st.version >= V8_0 && d.length > 15 ? d.readUInt8(15) !== 0 : false }; return true; } // AudioMixerInputCommand.ts
    case 'AMMO': cl0(st).master = { gain: d.readUInt16BE(0), balance: d.readInt16BE(2), followFadeToBlack: d.readInt8(4) === 1 }; return true;
    case 'AMmO': cl0(st).monitor = { enabled: d.readUInt8(0) > 0, gain: d.readUInt16BE(2), mute: d.readUInt8(4) > 0, solo: d.readUInt8(5) > 0, soloSource: d.readUInt16BE(6), dim: d.readUInt8(8) > 0, dimLevel: d.readUInt16BE(10) }; return true;
    case 'AMHP': cl0(st).headphones = { gain: d.readUInt16BE(0), programOutGain: d.readUInt16BE(2), talkbackGain: d.readUInt16BE(4), sidetoneGain: d.readUInt16BE(6) }; return true;
    case 'AMPP': cl0(st).afv = d.readUInt8(0) > 0; return true;
    // Fairlight
    case 'FAIP': { const f = fl0(st); const id = d.readUInt16BE(0); const old = st.version < V8_1_1; const inp = (f.inputs[id] = f.inputs[id] || { id, sources: {} });
      inp.props = { inputType: d.readUInt8(2), externalPortType: d.readUInt16BE(6), supportedConfigurations: d.readUInt8(old ? 11 : 9), activeConfiguration: d.readUInt8(old ? 12 : 10), supportedInputLevels: old ? 0 : d.readUInt8(11), activeInputLevel: old ? 0 : d.readUInt8(12) }; return true; }
    case 'FASP': { const f = fl0(st); const id = d.readUInt16BE(0); const src = d.readBigInt64BE(8).toString(); const inp = (f.inputs[id] = f.inputs[id] || { id, sources: {} });
      inp.sources[src] = { id: src, sourceType: d.readUInt8(16), maxFramesDelay: d.readUInt8(17), framesDelay: d.readUInt8(18), gain: d.readInt32BE(20), hasStereoSimulation: d.readUInt8(24) > 0, stereoSimulation: d.readInt16BE(26), bandCount: d.readUInt8(28),
        equalizerEnabled: d.readUInt8(29) > 0, equalizerGain: d.readInt32BE(32), makeUpGain: d.readInt32BE(36), balance: d.readInt16BE(40), faderGain: d.readInt32BE(44), supportedMixOptions: d.readUInt8(48), mixOption: d.readUInt8(49) }; return true; }
    case 'FASD': { const f = fl0(st); const inp = f.inputs[d.readUInt16BE(0)]; if (inp) delete inp.sources[d.readBigInt64BE(8).toString()]; return true; }
    case 'FAMP': fl0(st).master = { bandCount: d.readUInt8(0), equalizerEnabled: d.readUInt8(1) > 0, equalizerGain: d.readInt32BE(4), makeUpGain: d.readInt32BE(8), faderGain: d.readInt32BE(12), followFadeToBlack: d.readUInt8(16) > 0 }; return true;
    case 'FMHP': fl0(st).monitor = { gain: d.readInt32BE(0), inputMasterGain: d.readInt32BE(4), inputMasterMuted: d.readUInt8(8) === 0, inputTalkbackGain: d.readInt32BE(12), inputTalkbackMuted: d.readUInt8(16) === 0, inputSidetoneGain: d.readInt32BE(28) }; return true;
    case 'FAMS': fl0(st).solo = { solo: d.readUInt8(0) === 1, index: d.readUInt16BE(8), source: d.readBigInt64BE(16).toString() }; return true;
    case 'AROP': { const id = d.readUInt32BE(0); st.routing.outputs[id] = { id, output: id >>> 16, pair: id & 0xffff, source: d.readUInt32BE(4), externalPortType: d.readUInt16BE(8), internalPortType: d.readUInt16BE(10), name: str0(d, 12, 64) }; return true; }
    case 'ARSP': { const id = d.readUInt32BE(0); st.routing.sources[id] = { id, source: id >>> 16, pair: id & 0xffff, externalPortType: d.readUInt16BE(4), internalPortType: d.readUInt16BE(6), name: str0(d, 8, 64) }; return true; }
    default: return false;
  }
}

module.exports = { MASKS, maskOf, SETTER, readSetter, FLAG, HELLO, MAX_PACKET_ID, V8_0, V8_0_1, V8_1_1, V9_6, STYLES, MODELS, KEY_TYPES, FLY_FRAMES, MIX, FL_MIX, FL_STEREO, header, parseHeader, cmd, splitCommands, OUT, applyCommand, emptyState, bits, str0, u16ToDb, dbToU16, balToInt, intToBal };

