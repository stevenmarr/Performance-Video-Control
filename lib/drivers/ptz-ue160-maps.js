'use strict';
// Per-model paint overlays for the AW-UE160 (and regional UE160). UE150 / UE150A
// keep the codes in ptz-commands.js. Confirmed in the official UE160 interface
// specification, 1 Mar 2025, and COMMANDS.md §§3.1–3.2.
//
// Matrix knobs on the UE160 use OSD:2F–34, data 00h–3Eh = −31…+31, 1Fh = 0
// (not the UE150 OSD:A4–A9 / 80h-centred codes). The _P partners (OSL:6F–74)
// are recorded but not bound: the spec does not say what they do.

const { H, hx, centred } = (() => {
  const H = (n, w) => Math.max(0, Math.round(n)).toString(16).toUpperCase().padStart(w, '0');
  const hx = (s) => parseInt(String(s).replace(/^0x/i, ''), 16);
  const centred = (centre, w) => ({ enc: (v) => H(centre + v, w), dec: (s) => hx(s) - centre });
  return { H, hx, centred };
})();

const list = (pairs) => pairs.map(([v, l]) => [String(v), l]);
const spec = () => true;

const matrixC = centred(0x1F, 2);
const MATRIX_AXES = [
  ['matrixRG', 'R-G', 'OSD:2F'],
  ['matrixRB', 'R-B', 'OSD:30'],
  ['matrixGR', 'G-R', 'OSD:31'],
  ['matrixGB', 'G-B', 'OSD:32'],
  ['matrixBR', 'B-R', 'OSD:33'],
  ['matrixBG', 'B-G', 'OSD:34'],
];
// Partner codes (not wired until a camera test settles _N vs _P).
const MATRIX_P = {
  matrixRG: 'OSL:6F', matrixRB: 'OSL:70', matrixGR: 'OSL:71',
  matrixGB: 'OSL:72', matrixBR: 'OSL:73', matrixBG: 'OSL:74',
};

const kneeEnc160 = (p) => H(Math.round((Number(p) - 80) * 4) + 0x00 /* reserved: see decode */, 2);
// UE160 knee point 80–110 %, 0.25 % steps. The exact hex table is not printed
// the same way as the UE150 22h=70% formula; we keep a linear 0.25%/code
// map centred so 80 % = 00h would be wrong. Use the same 0.25 %/code idea
// starting at 80 % = 00h? COMMANDS.md says the UE150 formula works but the
// range is 80–110. We clamp the range and keep the UE150 encoder, which
// already maps 80 % → 4Ah. 110 % → 4Ah + 30*4 = 4Ah+78h = C2h.
const kneeEnc = (p) => H(0x22 + Math.round((p - 70) * 4), 2);
const kneeDec = (s) => 70 + (hx(s) - 0x22) / 4;

const GAIN = list([
  ['80', 'Auto'],
  ...[-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((db) => {
    const code = (8 + db).toString(16).toUpperCase().padStart(2, '0'); // 0 dB = 08h, −6 = 02h, +12 = 14h
    return [code, db === 0 ? '0dB' : `${db}dB`];
  }),
]);

function matrixOp([id, name, code]) {
  return {
    id, group: 'matrix', label: `Matrix ${name}`, type: 'range', path: 'cam', src: 'spec',
    ref: `UE160 Linear Matrix ${name}_N ${code} (00h=−31, 1Fh=0, 3Eh=+31; needs Matrix Type USER; IF Mar. 1, 2025). Partner ${MATRIX_P[id]} (_P) is not wired.`,
    avail: spec,
    range: { min: -31, max: 31, step: 1, centre: 0 },
    cmd: (v) => `${code}:${matrixC.enc(Number(v))}`,
    key: code,
    decode: matrixC.dec,
  };
}

const OVER = [
  {
    id: 'skinEffect', group: 'detail', label: 'Skin tone crisp', type: 'range', path: 'cam', src: 'spec',
    ref: 'UE160 SKIN TONE CRISP OSG:49 (41h=−63, 80h=0, BFh=+63). OSG:48 is the A/B/C memory, not this knob.',
    avail: spec, range: { min: -63, max: 63, step: 1, centre: 0 },
    cmd: (v) => `OSG:49:${H(0x80 + Number(v), 2)}`, key: 'OSG:49', decode: (v) => hx(v) - 0x80,
  },
  {
    id: 'matrixType', group: 'matrix', label: 'Matrix type', type: 'list', path: 'cam', src: 'spec',
    ref: 'UE160 Matrix Type OSE:31 (0 NORMAL, 1 CINEMA1, 2 CINEMA2, 3 USER, 4 HD)',
    avail: spec, options: () => list([[0, 'NORMAL'], [1, 'CINEMA1'], [2, 'CINEMA2'], [3, 'USER'], [4, 'HD']]),
    cmd: (v) => `OSE:31:${v}`, key: 'OSE:31',
  },
  ...MATRIX_AXES.map(matrixOp),
  {
    id: 'gammaMode', group: 'gamma', label: 'Gamma mode', type: 'list', path: 'cam', src: 'spec',
    ref: 'UE160 GAMMA MODE SELECT OSJ:D7 (00 HD, 01 NORMAL, 02 CINEMA1, 03 CINEMA2). OSE:72 is not in the UE160 spec.',
    avail: spec, options: () => list([['0', 'HD'], ['1', 'NORMAL'], ['2', 'CINEMA1'], ['3', 'CINEMA2']]),
    cmd: (v) => `OSJ:D7:${String(v).padStart(2, '0')}`, key: 'OSJ:D7',
    decode: (v) => String(parseInt(String(v).replace(/^0x/i, ''), 16)),
  },
  {
    id: 'gamma', group: 'gamma', label: 'Gamma (×0.01)', type: 'range', path: 'cam', src: 'spec',
    ref: 'UE160 Gamma OSA:6A (58h=0.15 .. 94h=0.75, 80h=0.55). Needs GAMMA On (OSA:0A).',
    avail: spec, range: { min: 15, max: 75, step: 1, centre: 55 },
    cmd: (v) => `OSA:6A:${H(0x80 + Number(v) - 55, 2)}`, key: 'OSA:6A', decode: (v) => hx(v) - 0x80 + 55,
  },
  {
    id: 'kneePoint', group: 'knee', label: 'Knee point (%)', type: 'range', path: 'cam', src: 'spec',
    ref: 'UE160 Knee Point OSA:20, 80–110 %, 0.25 % steps (UE150 formula, clamped)',
    avail: spec, range: { min: 80, max: 110, step: 0.25 },
    cmd: (v) => `OSA:20:${kneeEnc(Number(v))}`, key: 'OSA:20', decode: kneeDec,
  },
  {
    id: 'kneeSlope', group: 'knee', label: 'Knee slope', type: 'range', path: 'cam', src: 'spec',
    ref: 'UE160 Knee Slope OSA:24 (00h..C7h = 0…199)',
    avail: spec, range: { min: 0, max: 199, step: 1 },
    cmd: (v) => `OSA:24:${H(Number(v), 2)}`, key: 'OSA:24', decode: (v) => hx(v),
  },
  {
    id: 'gain', group: 'exposure', label: 'Gain', type: 'list', path: 'cam', src: 'spec',
    ref: 'UE160 OGU Auto + −6…+12 dB (02h–14h, Auto 80h). 13 dB and up are refused. Super Gain is not in the UE160 spec.',
    avail: spec, options: () => GAIN, cmd: (v) => `OGU:${v}`, key: 'OGU',
  },
  {
    id: 'drs', group: 'exposure', label: 'DRS', type: 'list', path: 'cam', src: 'spec',
    ref: 'UE160 DRS OSA:0D (0 OFF, 1 ON). Depth is drsDepth (OSL:4B, 1–5). OSE:33 is not in the UE160 spec.',
    avail: spec, options: () => list([[0, 'OFF'], [1, 'ON']]),
    cmd: (v) => `OSA:0D:${v}`, key: 'OSA:0D',
  },
  {
    id: 'colorBarsTone', group: 'bars', label: 'Bars tone', type: 'list', path: 'cam', src: 'spec',
    ref: 'UE160 bars tone OSJ:27 (0 OFF, 1 ON)',
    avail: spec, options: () => list([[0, 'OFF'], [1, 'ON']]),
    cmd: (v) => `OSJ:27:${v}`, key: 'OSJ:27',
  },
  {
    id: 'colorBarsType', group: 'bars', label: 'Bars type', type: 'list', path: 'cam', src: 'spec',
    ref: 'UE160 bars type OSD:BA (0 Type2 EBU, 1 Type1 SMPTE, 2 TYPE3 ARIB)',
    avail: spec, options: () => list([[0, 'Type2 EBU'], [1, 'Type1 SMPTE'], [2, 'TYPE3 ARIB']]),
    cmd: (v) => `OSD:BA:${v}`, key: 'OSD:BA',
  },
];

const flareC = centred(0x800, 3);
const ADD = [
  {
    id: 'gammaEnable', group: 'gamma', label: 'Gamma on / off', type: 'toggle', path: 'cam', src: 'spec',
    ref: 'UE160 GAMMA OSA:0A (0 OFF, 1 ON)',
    avail: spec, cmd: (on) => `OSA:0A:${on ? 1 : 0}`, key: 'OSA:0A', decode: (v) => v === '1',
  },
  {
    id: 'drsDepth', group: 'exposure', label: 'DRS depth', type: 'list', path: 'cam', src: 'spec',
    ref: 'UE160 DRS EFFECT DEPTH OSL:4B (1–5). Needs DRS On.',
    avail: spec, options: () => list([[1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5']]),
    cmd: (v) => `OSL:4B:${v}`, key: 'OSL:4B',
  },
  {
    id: 'flare', group: 'paint', label: 'Flare', type: 'toggle', path: 'cam', src: 'spec',
    ref: 'UE160 FLARE OSA:11 (0 OFF, 1 ON). Not on the UE150 / UE150A.',
    avail: spec, cmd: (on) => `OSA:11:${on ? 1 : 0}`, key: 'OSA:11', decode: (v) => v === '1',
  },
  {
    id: 'flareMaster', group: 'paint', label: 'Master flare', type: 'range', path: 'cam', src: 'spec',
    ref: 'UE160 MASTER FLARE OSL:40 (738h=−200, 800h=0, 8C8h=+200). Needs flare On.',
    avail: spec, range: { min: -200, max: 200, step: 1, centre: 0 },
    cmd: (v) => `OSL:40:${flareC.enc(Number(v))}`, key: 'OSL:40', decode: flareC.dec,
  },
  ...[['flareR', 'R', 'OSL:41'], ['flareG', 'G', 'OSL:42'], ['flareB', 'B', 'OSL:43']].map(([id, name, code]) => ({
    id, group: 'paint', label: `${name} flare`, type: 'range', path: 'cam', src: 'spec',
    ref: `UE160 ${name} FLARE ${code} (738h=−200, 800h=0, 8C8h=+200). Needs flare On.`,
    avail: spec, range: { min: -200, max: 200, step: 1, centre: 0 },
    cmd: (v) => `${code}:${flareC.enc(Number(v))}`, key: code, decode: flareC.dec,
  })),
  {
    id: 'skinCrispMem', group: 'detail', label: 'Skin tone memory', type: 'list', path: 'cam', src: 'spec',
    ref: 'UE160 SKIN TONE EFFECT MEMORY OSG:48 (0 A … 6 A+B+C)',
    avail: spec, options: () => list([[0, 'A'], [1, 'B'], [2, 'C'], [3, 'A+B'], [4, 'A+C'], [5, 'B+C'], [6, 'A+B+C']]),
    cmd: (v) => `OSG:48:${v}`, key: 'OSG:48',
  },
];

const REMOVED = new Set(['chromaPhase', 'adaptiveMatrix', 'superGain']);

const ZEBRA = Object.freeze({ supported: false, note: 'None of the UE150, UE150A or UE160 has an exposure zebra command. Only the UE160 skin-tone zebra exists, which is not an exposure zebra.' });

module.exports = {
  OVER, ADD, REMOVED, GAIN, MATRIX_AXES, MATRIX_P, ZEBRA,
  kneeEnc, kneeDec,
};
