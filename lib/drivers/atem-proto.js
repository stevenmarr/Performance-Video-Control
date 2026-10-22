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
const V8_0_1 = 0x0002001d; // [AC enums ProtocolVersion]
const STYLES = ['MIX', 'DIP', 'WIPE', 'DVE', 'STING']; // [AC enums TransitionStyle]
const MODELS = { 0x01: 'TVS', 0x02: '1 M/E', 0x03: '2 M/E', 0x04: 'PS 4K', 0x05: '1 M/E 4K', 0x06: '2 M/E 4K', 0x07: '2 M/E BS 4K', 0x08: 'TVS HD', 0x09: 'TVS Pro HD', 0x0a: 'TVS Pro 4K',
  0x0b: 'Constellation', 0x0c: 'Constellation 8K', 0x0d: 'Mini', 0x0e: 'Mini Pro', 0x0f: 'Mini Pro ISO', 0x10: 'Mini Extreme', 0x11: 'Mini Extreme ISO', 0x12: 'Constellation HD 1 M/E',
  0x13: 'Constellation HD 2 M/E', 0x14: 'Constellation HD 4 M/E', 0x15: 'SDI', 0x16: 'SDI Pro ISO', 0x17: 'SDI Extreme ISO', 0x1a: 'Television Studio HD8', 0x1b: 'Television Studio HD8 ISO',
  0x1c: 'Constellation 4K 1 M/E', 0x1d: 'Constellation 4K 2 M/E' }; // [AC enums Model]

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
  macroRun: (i) => cmd('MAct', buf(4, (b) => { b.writeUInt16BE(i, 0); b.writeUInt8(0, 2); })),     // Macro/MacroActionCommand.ts, MacroAction.Run = 0
  macroStop: () => cmd('MAct', buf(4, (b) => { b.writeUInt16BE(0xffff, 0); b.writeUInt8(1, 2); })), // MacroAction.Stop = 1, index 0xffff
};

function emptyState() {
  return { version: 0, product: '', model: 0, topology: null, mes: {}, inputs: {}, dsk: {}, aux: {}, macros: {}, macroRun: { isRunning: false, isWaiting: false, macroIndex: 0xffff }, tally: {}, initComplete: false };
}
const me0 = (st, i) => (st.mes[i] = st.mes[i] || { program: 0, preview: 0, style: 0, selection: 1, nextStyle: 0, nextSelection: 1, inTransition: false, remainingFrames: 0, handle: 0, mixRate: 25, ftb: { black: false, inTransition: false, remaining: 0, rate: 25 }, keyers: {}, keyCount: 0 });
const bits = (v) => [0, 1, 2, 3, 4].filter((i) => v & (1 << i)); // TransitionSelection: bit0 background, bit1.. key 1..

// Incoming state [AC src/commands/**: deserialize()]. Returns true when the command was understood.
function applyCommand(st, name, d) {
  switch (name) {
    case '_ver': st.version = d.readUInt32BE(0); return true; // DeviceProfile/versionCommand.ts
    case '_pin': st.product = str0(d, 0, 40); st.model = d.length > 40 ? d.readUInt8(40) : 0; return true; // productIdentifierCommand.ts
    case '_top': { const off = st.version > V8_0_1 ? 1 : 0; st.topology = { mixEffects: d.readUInt8(0), sources: d.readUInt8(1), downstreamKeyers: d.readUInt8(2), auxilliaries: d.readUInt8(3), mediaPlayers: d.readUInt8(5), superSources: d.length > 10 + off ? d.readUInt8(10 + off) : 0 }; return true; } // topologyCommand.ts
    case '_MeC': me0(st, d.readUInt8(0)).keyCount = d.readUInt8(1); return true; // mixEffectBlockConfigCommand.ts
    case 'InPr': { const id = d.readUInt16BE(0); st.inputs[id] = { id, longName: str0(d, 2, 20), shortName: str0(d, 22, 4), internalPortType: d.readUInt8(32), sourceAvailability: d.readUInt8(34), meAvailability: d.readUInt8(35) }; return true; } // Inputs/InputPropertiesCommand.ts
    case 'PrgI': me0(st, d.readUInt8(0)).program = d.readUInt16BE(2); return true;
    case 'PrvI': me0(st, d.readUInt8(0)).preview = d.readUInt16BE(2); return true;
    case 'TrSS': { const m = me0(st, d.readUInt8(0)); m.style = d.readUInt8(1); m.selection = d.readUInt8(2); m.nextStyle = d.readUInt8(3); m.nextSelection = d.readUInt8(4); return true; } // TransitionPropertiesCommand.ts
    case 'TrPs': { const m = me0(st, d.readUInt8(0)); m.inTransition = d.readUInt8(1) === 1; m.remainingFrames = d.readUInt8(2); m.handle = d.readUInt16BE(4); return true; } // TransitionPositionCommand.ts
    case 'TMxP': me0(st, d.readUInt8(0)).mixRate = d.readUInt8(1); return true; // TransitionMixCommand.ts
    case 'FtbS': { const f = me0(st, d.readUInt8(0)).ftb; f.black = d.readUInt8(1) === 1; f.inTransition = d.readUInt8(2) === 1; f.remaining = d.readUInt8(3); return true; } // FadeToBlackStateCommand.ts
    case 'FtbP': me0(st, d.readUInt8(0)).ftb.rate = d.readUInt8(1); return true; // FadeToBlackRateCommand.ts
    case 'KeOn': { const m = me0(st, d.readUInt8(0)); m.keyers[d.readUInt8(1)] = { onAir: d.readUInt8(2) === 1 }; return true; } // MixEffectKeyOnAirCommand.ts
    case 'DskS': { const k = d.readUInt8(0); const x = (st.dsk[k] = st.dsk[k] || {}); x.onAir = d.readUInt8(1) === 1; x.inTransition = d.readUInt8(2) === 1; x.isAuto = d.readUInt8(3) === 1; x.remainingFrames = st.version >= V8_0_1 ? d.readUInt8(5) : d.readUInt8(4); return true; } // DownstreamKeyStateCommand.ts (V8_0_1 layout)
    case 'DskP': { const k = d.readUInt8(0); const x = (st.dsk[k] = st.dsk[k] || {}); x.tie = d.readUInt8(1) === 1; x.rate = d.readUInt8(2); return true; } // DownstreamKeyPropertiesCommand.ts
    case 'AuxS': st.aux[d.readUInt8(0)] = d.readUInt16BE(2); return true; // AuxSourceCommand.ts
    case 'MPrp': { const i = d.readUInt16BE(0); const nl = d.readUInt16BE(4); const dl = d.readUInt16BE(6); st.macros[i] = { index: i, isUsed: d.readUInt8(2) !== 0, name: str0(d, 8, nl), description: str0(d, 8 + nl, dl) }; return true; } // Macro/MacroPropertiesCommand.ts
    case 'MRPr': st.macroRun = { isRunning: !!(d.readUInt8(0) & 1), isWaiting: !!(d.readUInt8(0) & 2), loop: d.readUInt8(1) !== 0, macroIndex: d.readUInt16BE(2) }; return true; // Macro/MacroRunStatusCommand.ts
    case 'TlSr': { const n = d.readUInt16BE(0); const t = {}; for (let i = 0; i < n; i++) { const src = d.readUInt16BE(2 + i * 3); const v = d.readUInt8(4 + i * 3); t[src] = { program: (v & 1) > 0, preview: (v & 2) > 0 }; } st.tally = t; return true; } // TallyBySourceCommand.ts
    case 'InCm': st.initComplete = true; return true; // InitCompleteCommand.ts
    default: return false;
  }
}

module.exports = { FLAG, HELLO, MAX_PACKET_ID, V8_0_1, STYLES, MODELS, header, parseHeader, cmd, splitCommands, OUT, applyCommand, emptyState, bits, str0 };
