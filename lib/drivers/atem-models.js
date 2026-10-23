'use strict';
// 0.10.0 Blackmagic ATEM model profiles: what each switcher model has (M/Es, inputs, keyers, DVEs, SuperSource,
// media players, aux / SDI outputs, multiviewers, audio mixer). Used two ways:
//   - the simulator (lib/mocks/atem.js) builds its protocol state from a profile, so ADD TO DESK AS SIMULATOR can
//     stand in for any of these models with a realistic topology;
//   - the driver (lib/drivers/atem.js) names the profile of a real switcher from its product id (_pin) and topology
//     (_top), for labels and for the parts the protocol does not describe (aux output names, multiviewer routing).
// The live state from a real switcher always wins over the profile; the profile never invents commands.
//
// Sources, cited per number in docs/atem-models.md:
//   [BM]  Blackmagic Design published tech specs (blackmagicdesign.com/products/.../techspecs), checked 2026-10-23.
//   [CM]  Bitfocus companion-module-bmd-atem src/models/*.ts (commit 95f09aa): per-model input lists, source
//         availability bits, audio inputs and Fairlight audio routing ids (the same tables that module ships).
//   [AC]  Sofie atem-connection src/enums (commit 9c77b69): Model ids, port types, availability bits.
// Where [BM] and [CM] disagree the published spec is used for the counts and the difference is listed in `notes`.

// [AC enums] InternalPortType / ExternalPortType / SourceAvailability / MeAvailability
const PORT = { External: 0, Black: 1, ColorBars: 2, ColorGenerator: 3, MediaPlayerFill: 4, MediaPlayerKey: 5, SuperSource: 6, ExternalDirect: 7, MEOutput: 128, Auxiliary: 129, Mask: 130, MultiViewer: 131, AudioMonitor: 132 };
const EXT = { Unknown: 0, SDI: 1, HDMI: 2, Component: 4, Composite: 8, SVideo: 16, XLR: 32, AESEBU: 64, RCA: 128, Internal: 256, TSJack: 512, MADI: 1024, TRSJack: 2048, RJ45: 4096 };
const EXT_NAME = Object.fromEntries(Object.entries(EXT).map(([k, v]) => [v, k === 'TSJack' ? 'TS' : k === 'TRSJack' ? 'TRS' : k === 'AESEBU' ? 'AES' : k.toUpperCase()]));
const AV = { Auxiliary: 1, Multiviewer: 2, SuperSourceArt: 4, SuperSourceBox: 8, KeySource: 16, Auxiliary1: 32, Auxiliary2: 64, WebcamOut: 128 };
const meMask = (n) => (1 << n) - 1;

// Input list, as companion-module-bmd-atem's VideoInputGenerator builds it [CM src/models/util/videoInput.ts]
function inputGen(meCount, base) {
  const list = []; const meAll = meMask(meCount); const def = AV.KeySource | base;
  const add = (id, port, sa, ma, extra = {}) => list.push({ id, port, sa, ma, ...extra });
  const g = {
    colors(skipAux = false) { const sa = skipAux ? def & ~AV.Auxiliary : def; add(0, PORT.Black, sa, meAll); add(1000, PORT.ColorBars, sa, meAll); add(2001, PORT.ColorGenerator, sa & ~AV.KeySource, meAll); add(2002, PORT.ColorGenerator, sa & ~AV.KeySource, meAll); return g; },
    external(n, ext = () => EXT.SDI) { for (let i = 1; i <= n; i++) add(i, PORT.External, def, meAll, { ext: ext(i) }); return g; },
    mediaPlayers(n, skipAux = false) { const sa = skipAux ? def & ~AV.Auxiliary : def; for (let i = 1; i <= n; i++) { add(3000 + i * 10, PORT.MediaPlayerFill, sa, meAll); add(3001 + i * 10, PORT.MediaPlayerKey, sa, meAll); } return g; },
    uskMasks(n) { for (let i = 1; i <= n; i++) add(4000 + i * 10, PORT.Mask, AV.Multiviewer | AV.Auxiliary, 0); return g; },
    dskMasks(n) { for (let i = 1; i <= n; i++) add(5000 + i * 10, PORT.Mask, AV.Multiviewer | AV.Auxiliary, 0); return g; },
    cleanFeeds(n) { for (let i = 1; i <= n; i++) add(7000 + i, PORT.MEOutput, def & ~AV.KeySource & ~AV.SuperSourceArt & ~AV.SuperSourceBox, 0); return g; },
    auxOutputs(n) { for (let i = 0; i < n; i++) add(8001 + i, PORT.Auxiliary, def & AV.Multiviewer, 0); return g; },
    superSource(n = 1) { for (let i = 0; i < n; i++) add(6000 + i, PORT.SuperSource, def & ~AV.SuperSourceArt, meAll); return g; },
    programPreview() {
      for (let i = 1; i <= meCount; i++) {
        let sa = def & ~AV.SuperSourceArt & ~AV.KeySource; if (i === 1) sa &= ~AV.SuperSourceBox;
        const ma = i > 1 ? meMask(i - 1) : 0; // M/E 2 program can be re-entered on M/E 1, and so on
        add(10000 + i * 10, PORT.MEOutput, sa, ma); add(10001 + i * 10, PORT.MEOutput, sa, ma);
      }
      return g;
    },
    multiviewers(n) { for (let i = 0; i < n; i++) add(9001 + i, PORT.MultiViewer, def & (AV.Auxiliary | AV.Auxiliary1 | AV.Auxiliary2 | AV.WebcamOut), 0); return g; },
    mvStatus() { for (const id of [9101, 9102, 9103]) add(id, PORT.MultiViewer, AV.Multiviewer, 0); return g; },
    directAux(n) { for (let i = 1; i <= n; i++) { let sa = AV.Auxiliary; if (i === 1 && base & AV.Auxiliary1) sa |= AV.Auxiliary1; if (i === 2 && base & AV.Auxiliary2) sa |= AV.Auxiliary2; add(11000 + i, PORT.ExternalDirect, sa, 0); } return g; },
    raw(id, port, sa, ma) { add(id, port, sa, ma); return g; },
    done() { return list.sort((a, b) => a.id - b.id); },
  };
  return g;
}

// Names an ATEM gives its sources by default (long up to 20, short up to 4 characters)
function defaultName(x, p) {
  const id = x.id; const n = (v) => String(v);
  if (id === 0) return ['Black', 'Blk'];
  if (id === 1000) return ['Color Bars', 'Bars'];
  if (id === 2001 || id === 2002) return [`Color ${id - 2000}`, `Col${id - 2000}`];
  if (id >= 1 && id < 1000) return [`Camera ${id}`, id < 10 ? `Cam${id}` : `C${id}`.slice(0, 4)];
  if (id >= 3010 && id < 4000) { const m = Math.floor((id - 3000) / 10); return id % 10 === 0 ? [`Media Player ${m}`, `MP${m}`] : [`Media Player ${m} Key`, `MP${m}K`]; }
  if (id >= 4010 && id < 5000) { const k = (id - 4000) / 10; const me = Math.ceil(k / p.uskPerMe); const kk = ((k - 1) % p.uskPerMe) + 1; return [`ME ${me} Key ${kk} Mask`, `M${me}K${kk}`]; }
  if (id >= 5010 && id < 6000) { const k = (id - 5000) / 10; return [`DSK ${k} Mask`, `DK${k}M`]; }
  if (id >= 6000 && id < 7000) return id === 6000 ? ['Super Source', 'SSrc'] : [`Super Source ${id - 5999}`, `SSc${id - 5999}`];
  if (id >= 7001 && id < 8000) return [`Clean Feed ${id - 7000}`, `Cfd${id - 7000}`];
  if (id >= 8001 && id < 9000) return [`Auxiliary ${id - 8000}`, id - 8000 < 10 ? `Aux${id - 8000}` : `Ax${id - 8000}`];
  if (id >= 9001 && id < 9100) return [p.multiviewers > 1 ? `Multiview ${id - 9000}` : 'Multiview', p.multiviewers > 1 ? `MV${id - 9000}` : 'MV'];
  if (id === 9101) return ['Recording Status', 'Rec'];
  if (id === 9102) return ['Streaming Status', 'Strm'];
  if (id === 9103) return ['Audio Status', 'Audi'];
  if (id === 9200) return ['Audio Monitor', 'AMon'];
  if (id >= 10010 && id < 11000) { const me = Math.floor((id - 10000) / 10); const pv = id % 10 === 1; return p.mes > 1 ? [`ME ${me} ${pv ? 'Preview' : 'Program'}`, `M${me}${pv ? 'PV' : 'PG'}`] : [pv ? 'Preview' : 'Program', pv ? 'Pvw' : 'Pgm']; }
  if (id >= 11001 && id < 12000) return [`Camera ${id - 11000} Direct`, `${id - 11000}Dir`];
  return [`Source ${n(id)}`, n(id).slice(0, 4)];
}
// What kind of source this is (the ROUTER dialog filters on it)
function kindOf(x) {
  const id = x.id;
  if (x.port === PORT.External) return 'input';
  if (x.port === PORT.ExternalDirect) return 'direct';
  if (id === 0 || id === 1000 || id === 2001 || id === 2002) return 'internal';
  if (x.port === PORT.MediaPlayerFill || x.port === PORT.MediaPlayerKey) return 'media';
  if (x.port === PORT.SuperSource) return 'supersource';
  if (id >= 7001 && id < 8000) return 'cleanfeed';
  if (x.port === PORT.Mask) return 'mask';
  if (x.port === PORT.Auxiliary) return 'aux';
  if (x.port === PORT.MEOutput) return 'me';
  if (x.port === PORT.MultiViewer || x.port === PORT.AudioMonitor) return 'mv';
  return 'other';
}

// 0.11.0: sources the ROUTER source picker hides until ADVANCED is opened: media player key (cut) signals and key
// masks (the alpha / key halves of a fill + key pair), which are almost never what an operator routes to an output
function isAdvanced(x) { return x.port === PORT.MediaPlayerKey || x.port === PORT.Mask; }

// ---------- audio (Fairlight inputs / routing ids [CM src/models/util/fairlight.ts, audioRouting.ts]) ----------
const PAIRS_ALL = [0, 1, 2, 3, 4, 5, 6, 7]; // AudioChannelPair 1/2 .. 15/16
const fl = (id, ext, extra = {}) => ({ id, ext, ...extra });
const flRange = (first, n, ext) => Array.from({ length: n }, (_, i) => fl(first + i, ext));
const rs = (id, name, pairs = [0]) => ({ id, name, pairs });
const routing = {
  inputs: (n, comms) => Array.from({ length: n }, (_, i) => rs(i + 1, `Input ${i + 1}`, comms ? [0, 1, 6, 7] : [0, 1])),
  madi: (n) => Array.from({ length: n }, (_, i) => rs(1501 + i, `MADI ${i + 1}`)),
  mp: (n) => Array.from({ length: n }, (_, i) => rs(2001 + i, `Media Player ${i + 1}`)),
  talkback: (ext, gen) => [rs(2101, 'Production Talkback'), rs(2102, 'Engineering Talkback'), ...(ext ? [rs(2103, 'External Talkback')] : []), ...(gen ? [rs(2104, 'Talkback')] : [])],
  mixMinus: (n) => Array.from({ length: n }, (_, i) => rs(2801 + i, `Mix Minus ${i + 1}`)),
  aux: (n) => Array.from({ length: n }, (_, i) => rs(3001 + i, `Aux ${i + 1}`)),
  madiOut: (n) => Array.from({ length: n }, (_, i) => rs(1001 + i, `MADI ${i + 1}`)),
  auxOut: (n, stereoOnly = false) => Array.from({ length: n }, (_, i) => rs(2001 + i, `Aux ${i + 1}`, stereoOnly ? [0] : PAIRS_ALL)),
};
const R = { none: rs(0, 'No Audio'), xlr: rs(1001, 'XLR'), rca: rs(1201, 'RCA'), mic: rs(1301, 'Microphone'), trs: rs(1401, 'TRS'), program: rs(2301, 'Program'), monitor: rs(2201, 'Monitor'), control: rs(2501, 'Control'), studio: rs(2601, 'Studio'), headphones: rs(2701, 'Headphones'),
  outMv: rs(3001, 'MV', PAIRS_ALL), outProgram: rs(4001, 'Program', PAIRS_ALL), outReturn: rs(5001, 'Return', PAIRS_ALL) };
const TS = fl(1301, EXT.TSJack, { maxDelay: 8 }); const TRS = fl(1401, EXT.TRSJack, { maxDelay: 8 }); const XLR = fl(1001, EXT.XLR); const RCA = fl(1201, EXT.RCA, { maxDelay: 8 });
const MINI_TS = [fl(1301, EXT.TSJack, { maxDelay: 8 }), fl(1302, EXT.TSJack, { maxDelay: 8 })];
const classicList = (n, ext, extra) => [...Array.from({ length: n }, (_, i) => ({ id: i + 1, ext: typeof ext === 'function' ? ext(i + 1) : ext })), ...extra];

// ---------- the profiles ----------
const BASE = AV.Auxiliary | AV.Multiviewer | AV.SuperSourceBox | AV.SuperSourceArt;
const out = (prefix, n, kind = 'sdi') => Array.from({ length: n }, (_, i) => ({ name: `${prefix} ${i + 1}`, kind }));
const P = [];
const def = (p) => { P.push({ ssBoxes: p.superSources ? 4 : 0, mvWindows: 0, mvRoutable: 'none', stills: 20, clips: 0, macros: 100, notes: [], ...p }); };

const miniInputs = (mv) => { const g = inputGen(1, AV.Auxiliary).colors(true).external(4, () => EXT.HDMI).mediaPlayers(1, true).auxOutputs(1).programPreview().directAux(1); if (mv) g.raw(9001, PORT.MultiViewer, AV.Auxiliary, 0); return g.done(); };
const miniAudio = { type: 'fairlight', monitor: null, inputs: [...flRange(1, 4, EXT.HDMI), ...MINI_TS] };
def({ key: 'mini', name: 'ATEM Mini', family: 'ATEM Mini', productId: 0x0d, mes: 1, uskPerMe: 1, dsk: 1, dve: 1, superSources: 0, mediaPlayers: 1, aux: [{ name: 'HDMI Out', kind: 'hdmi' }, { name: 'Webcam Out', kind: 'webcam' }],
  multiviewers: 0, inputs: miniInputs(false), audio: miniAudio, stills: 20,
  notes: ['The HDMI output and the USB webcam output are the two aux buses the switcher reports [CM]; Blackmagic calls them outputs, not aux.'] });
def({ key: 'minipro', name: 'ATEM Mini Pro', family: 'ATEM Mini', productId: 0x0e, mes: 1, uskPerMe: 1, dsk: 1, dve: 1, superSources: 0, mediaPlayers: 1, aux: [{ name: 'HDMI Out', kind: 'hdmi' }, { name: 'Webcam Out', kind: 'webcam' }],
  multiviewers: 1, mvWindows: 10, mvRoutable: 'none', inputs: miniInputs(true), audio: miniAudio,
  notes: ['The Mini Pro multiview has a fixed layout (no routable windows): uncertain, from the Mini manual, not tested on a unit.'] });
def({ ...P[P.length - 1], key: 'miniproiso', name: 'ATEM Mini Pro ISO', productId: 0x0f });
const extremeInputs = () => inputGen(1, BASE | AV.Auxiliary1 | AV.Auxiliary2).colors().external(8, () => EXT.HDMI).mediaPlayers(2).superSource().cleanFeeds(1).auxOutputs(2).programPreview().directAux(2).multiviewers(1).mvStatus().done();
def({ key: 'miniextreme', name: 'ATEM Mini Extreme', family: 'ATEM Mini', productId: 0x10, mes: 1, uskPerMe: 4, dsk: 2, dve: 2, superSources: 1, mediaPlayers: 2, aux: [{ name: 'HDMI Out 1', kind: 'hdmi' }, { name: 'HDMI Out 2', kind: 'hdmi' }, { name: 'Webcam Out', kind: 'webcam' }],
  multiviewers: 1, mvWindows: 16, mvRoutable: 'all', inputs: extremeInputs(), audio: { type: 'fairlight', monitor: 'split', inputs: [...flRange(1, 8, EXT.HDMI), ...MINI_TS] } });
def({ ...P[P.length - 1], key: 'miniextremeiso', name: 'ATEM Mini Extreme ISO', productId: 0x11 });

const hd8Inputs = () => inputGen(1, BASE).colors().external(8).mediaPlayers(2).cleanFeeds(1).auxOutputs(2).programPreview().superSource().multiviewers(1).mvStatus().done();
const hd8Audio = { type: 'fairlight', monitor: 'split', madiIn: 16, madiOut: 32,
  inputs: [...flRange(1, 8, EXT.SDI), XLR, RCA, TS, ...flRange(1501, 16, EXT.MADI), ...flRange(2001, 2, EXT.Internal)],
  routing: { sources: [R.none, ...routing.inputs(8, true), R.xlr, R.rca, R.mic, ...routing.madi(16), ...routing.mp(2), ...routing.talkback(true, true), R.monitor, R.program, R.control, R.studio, R.headphones, ...routing.aux(2)],
    outputs: [...routing.madiOut(32), ...routing.auxOut(2), R.outProgram, R.outReturn] } };
def({ key: 'tvshd8', name: 'ATEM Television Studio HD8', family: 'Television Studio', productId: 0x1a, mes: 1, uskPerMe: 4, dsk: 2, dve: 2, superSources: 1, mediaPlayers: 2, stills: 20, clips: 2, aux: out('Aux', 2),
  multiviewers: 1, mvWindows: 16, mvRoutable: 'all', inputs: hd8Inputs(), audio: hd8Audio,
  notes: ['DVEs: Blackmagic lists 2 (1 upstream DVE + 1 for DVE transitions); companion-module-bmd-atem models 1.', 'MADI: 16 stereo inputs (32 channels) and 32 MADI routing outputs, from [CM]; the Blackmagic page says "up to 32 channels of MADI".', 'Clean feed count is 1 in [CM] (marked TODO there).'] });
def({ ...P[P.length - 1], key: 'tvshd8iso', name: 'ATEM Television Studio HD8 ISO', productId: 0x1b });

// Constellation HD / 4K
const conAudio = (n, mp, madi, aux, comms = false, talkExt = false) => ({ type: 'fairlight', monitor: 'split', madiIn: madi ? 32 : 0, madiOut: madi ? 32 : 0,
  inputs: [...flRange(1, n, EXT.SDI), TS, TRS, ...(madi ? flRange(1501, 32, EXT.MADI) : []), ...flRange(2001, mp, EXT.Internal)],
  routing: { sources: [R.none, ...routing.inputs(n, comms), R.mic, R.trs, ...(madi ? routing.madi(32) : []), ...routing.mp(mp), ...routing.talkback(talkExt, false), R.program, ...routing.mixMinus(aux)],
    outputs: [...(madi ? routing.madiOut(32) : []), ...routing.auxOut(aux)] } });
const c1 = { family: 'Constellation', mes: 1, uskPerMe: 4, dsk: 1, dve: 1, superSources: 0, mediaPlayers: 2, stills: 20, clips: 2, aux: out('Output', 6), multiviewers: 1, mvWindows: 16, mvRoutable: 'all',
  inputs: inputGen(1, BASE).colors().external(10).mediaPlayers(2).uskMasks(4).dskMasks(1).cleanFeeds(1).auxOutputs(6).programPreview().done(), audio: conAudio(10, 2, false, 6),
  notes: ['DSKs: 1 per [CM]; [CM] also lists 2 DSK mask sources for this model, which does not match one DSK (1 used here).', 'All 6 SDI outputs are routable like aux outputs.'] };
const c2 = { family: 'Constellation', mes: 2, uskPerMe: 4, dsk: 2, dve: 2, superSources: 1, mediaPlayers: 2, stills: 40, clips: 2, aux: out('Output', 12), multiviewers: 2, mvWindows: 16, mvRoutable: 'all',
  inputs: inputGen(2, BASE).colors().external(20).mediaPlayers(2).uskMasks(8).dskMasks(2).cleanFeeds(2).auxOutputs(12).superSource().programPreview().done(), audio: conAudio(20, 2, false, 12),
  notes: ['DVEs: Blackmagic lists 2; companion-module-bmd-atem models 1.', 'No MADI on 2 M/E models (Blackmagic: MADI is on the 4 M/E models).'] };
const c4 = { family: 'Constellation', mes: 4, uskPerMe: 4, dsk: 4, dve: 4, superSources: 2, mediaPlayers: 4, stills: 60, clips: 4, aux: out('Output', 24), multiviewers: 4, mvWindows: 16, mvRoutable: 'all',
  inputs: inputGen(4, BASE).colors().external(40).mediaPlayers(4).uskMasks(16).dskMasks(4).cleanFeeds(4).auxOutputs(24).superSource(2).programPreview().done(), audio: conAudio(40, 4, true, 24),
  notes: ['MADI: 1 MADI input (32 stereo channels, modelled as 32 stereo Fairlight inputs 1501-1532) and 2 MADI outputs (32 routing outputs 1001-1032), from [CM] and the Blackmagic page.'] };
def({ ...c1, key: 'chd1me', name: 'ATEM 1 M/E Constellation HD', productId: 0x12 });
def({ ...c2, key: 'chd2me', name: 'ATEM 2 M/E Constellation HD', productId: 0x13 });
def({ ...c4, key: 'chd4me', name: 'ATEM 4 M/E Constellation HD', productId: 0x14 });
def({ ...c1, key: 'c4k1me', name: 'ATEM 1 M/E Constellation 4K', productId: 0x1c, notes: [...c1.notes, 'Same topology as the HD model per [CM].'] });
def({ ...c2, key: 'c4k2me', name: 'ATEM 2 M/E Constellation 4K', productId: 0x1d, notes: [...c2.notes, 'Same topology as the HD model per [CM]; Blackmagic: 20 x 12G-SDI in, 12 x 12G-SDI out, 2 multiviews, 8 keyers, 1 SuperSource, 2 media players, 40 stills.'] });
def({ ...c4, key: 'c4k4me', name: 'ATEM 4 M/E Constellation 4K', productId: 0x1e, stills: 64, notes: [...c4.notes, 'Stills: 64 for the 4K model [CM].'] });
// Constellation 8K: two personalities depending on the video standard
const c8k = { family: 'Constellation 8K', mes: 1, uskPerMe: 4, dsk: 2, dve: 1, superSources: 1, mediaPlayers: 1, stills: 24, clips: 2, aux: out('Output', 6), multiviewers: 1, mvWindows: 16, mvRoutable: 'all',
  inputs: inputGen(1, BASE).colors().external(10).mediaPlayers(1).uskMasks(4).dskMasks(2).cleanFeeds(2).auxOutputs(6).superSource().programPreview().done(),
  audio: (() => { const a = conAudio(10, 4, true, 6, true, true); a.routing.outputs = [...routing.madiOut(8), ...routing.auxOut(6)]; a.madiOut = 8; a.routing.sources = a.routing.sources.filter((s) => !(s.id >= 2002 && s.id <= 2004)); return a; })(),
  notes: ['8K mode: Blackmagic lists 10 inputs, 6 aux, 1 M/E with 4 keyers, 2 DSKs, 1 DVE, 1 media player, 24 stills, 1 multiview; SuperSource count in 8K mode is not published (1 here, from [CM]).', 'Product id 0x0c is the 8K personality and 0x0b the HD / Ultra HD one, per [CM]; not checked on a unit.', 'MADI routing outputs: 8 in 8K mode per [CM] (uncertain).'] };
def({ ...c8k, key: 'c8k', name: 'ATEM Constellation 8K (8K mode)', productId: 0x0c });
def({ ...c4, family: 'Constellation 8K', key: 'c8khd', name: 'ATEM Constellation 8K (HD/UHD mode)', productId: 0x0b, stills: 64, notes: ['HD / Ultra HD mode: 40 inputs, 24 aux, 4 M/E, 16 keyers, 4 DSKs, 4 DVEs, 2 SuperSource, 4 media players, 4 multiviews [BM].', 'Product id 0x0b for this personality per [CM]; not checked on a unit.'] });

// Classic-audio 4K studio models
const classicAudio = (list, monitors = 1) => ({ type: 'classic', monitors, headphones: 0, inputs: list });
def({ key: 'ps4k', name: 'ATEM Production Studio 4K', family: 'Production Studio', productId: 0x04, mes: 1, uskPerMe: 1, dsk: 2, dve: 0, superSources: 0, mediaPlayers: 2, stills: 20, clips: 0, aux: out('Aux', 1),
  multiviewers: 1, mvWindows: 10, mvRoutable: 'small',
  inputs: inputGen(1, AV.Auxiliary | AV.Multiviewer).colors().external(8, (i) => (i <= 4 ? EXT.HDMI : EXT.SDI)).mediaPlayers(2).uskMasks(1).dskMasks(2).cleanFeeds(2).auxOutputs(1).programPreview().done(),
  audio: classicAudio(classicList(8, (i) => (i <= 4 ? EXT.HDMI : EXT.SDI), [{ id: 1001, ext: EXT.XLR }, { id: 1201, ext: EXT.RCA }])),
  notes: ['No DVE: the upstream key has no DVE type (dve 0 per [CM]).', 'Inputs 1-4 HDMI, 5-8 SDI per [CM] audio port table.', 'Multiview windows 3-10 routable, Program / Preview fixed (classic 10-view layout).'] });
def({ key: '2meps4k', name: 'ATEM 2 M/E Production Studio 4K', family: 'Production Studio', productId: 0x06, mes: 2, uskPerMe: 2, dsk: 2, dve: 1, superSources: 1, mediaPlayers: 2, stills: 32, clips: 2, aux: out('Aux', 6),
  multiviewers: 2, mvWindows: 10, mvRoutable: 'small',
  inputs: inputGen(2, BASE).colors().external(20, (i) => (i === 1 ? EXT.HDMI : EXT.SDI)).mediaPlayers(2).uskMasks(4).dskMasks(2).cleanFeeds(2).auxOutputs(6).superSource().programPreview().done(),
  audio: classicAudio(classicList(20, EXT.SDI, [{ id: 1001, ext: EXT.XLR }, { id: 1201, ext: EXT.RCA }, { id: 2001, ext: EXT.Internal }, { id: 2002, ext: EXT.Internal }])),
  notes: ['Input 1 switches between SDI and HDMI [CM]; shown as HDMI here.', 'Keyers: 2 per M/E [CM].'] });
def({ key: '4mebs4k', name: 'ATEM 4 M/E Broadcast Studio 4K', family: 'Broadcast Studio', productId: 0x07, mes: 4, uskPerMe: 4, dsk: 2, dve: 1, superSources: 1, mediaPlayers: 4, stills: 64, clips: 2, aux: out('Aux', 6),
  multiviewers: 2, mvWindows: 10, mvRoutable: 'small',
  inputs: inputGen(4, BASE).colors().external(20).mediaPlayers(4).uskMasks(16).dskMasks(2).cleanFeeds(2).auxOutputs(6).superSource().programPreview().done(),
  audio: classicAudio(classicList(20, EXT.SDI, [{ id: 1001, ext: EXT.XLR }, { id: 1201, ext: EXT.RCA }, { id: 2001, ext: EXT.Internal }, { id: 2002, ext: EXT.Internal }, { id: 2003, ext: EXT.Internal }, { id: 2004, ext: EXT.Internal }])),
  notes: ['Product id 0x07 is named TwoMEBS4K in atem-connection but is the 4 M/E Broadcast Studio 4K per [CM].', 'Audio: Blackmagic says "24 input x 2 channel mixer"; [CM] lists 26 (20 SDI, XLR, RCA, 4 media players). 26 used here.', 'Multiview: 2 x 10 views (Blackmagic), 8 routable windows each.'] });

const BY_KEY = Object.fromEntries(P.map((p) => [p.key, p]));
const DEFAULT = 'tvshd8iso';
function profile(key) { return BY_KEY[key] || null; }

// Production names the simulator gives the first inputs (so screenshots and tests read like a show)
const SIM_NAMES = [['Cam 1 Wide', 'CAM1'], ['Cam 2 Tight', 'CAM2'], ['Cam 3 Jib', 'CAM3'], ['Cam 4 PTZ', 'CAM4'], ['Playback', 'PLAY'], ['Laptop', 'LAPT'], ['Graphics', 'GFX'], ['Remote', 'REMT']];
// Full source list of a profile: [{ id, long, short, port, ext, sa, ma, kind }]
function sources(p, { simNames = true } = {}) {
  return p.inputs.map((x) => {
    let [long, short] = defaultName(x, p);
    if (simNames && x.port === PORT.External && SIM_NAMES[x.id - 1]) [long, short] = SIM_NAMES[x.id - 1];
    return { id: x.id, long, short, port: x.port, ext: x.ext || (x.port === PORT.External ? EXT.SDI : EXT.Internal), sa: x.sa, ma: x.ma, kind: kindOf(x) };
  });
}
// Fairlight / classic audio input names
function audioName(id, p) {
  if (id >= 1 && id < 1000) return `${p.audio.type === 'classic' ? 'Input' : 'Input'} ${id}`;
  if (id === 1001 || id === 1002) return id === 1001 ? 'XLR' : 'XLR 2';
  if (id === 1201) return 'RCA';
  if (id >= 1301 && id < 1400) return p.family === 'ATEM Mini' ? `Mic ${id - 1300}` : 'Mic (TS)';
  if (id === 1401) return 'Line (TRS)';
  if (id >= 1501 && id < 1600) return `MADI ${id - 1500}`;
  if (id >= 2001 && id < 2050) return `Media Player ${id - 2000}`;
  return `Audio ${id}`;
}
// One-line summary for the model picker
function summary(p) {
  const nIn = p.inputs.filter((x) => x.port === PORT.External).length;
  return { key: p.key, name: p.name, family: p.family, productId: p.productId, mes: p.mes, inputs: nIn, keyers: p.mes * p.uskPerMe, uskPerMe: p.uskPerMe, dsk: p.dsk, dve: p.dve,
    superSources: p.superSources, ssBoxes: p.ssBoxes, mediaPlayers: p.mediaPlayers, aux: p.aux.length, multiviewers: p.multiviewers, mvWindows: p.mvWindows,
    audio: p.audio.type, audioInputs: p.audio.inputs.length, madi: !!p.audio.madiIn, audioRouting: !!p.audio.routing, notes: p.notes };
}
// Which profile a real switcher is, from its product id and topology. Constellation 8K reports a different id per
// personality; a topology that does not match the profile is still shown, flagged `mismatch`.
function detect(productId, top) {
  let p = P.find((q) => q.productId === productId) || null;
  if (!p && top) p = P.find((q) => q.mes === top.mixEffects && q.aux.length === top.auxilliaries && q.dsk === top.downstreamKeyers) || null;
  if (!p) return null;
  const mismatch = !!(top && (top.mixEffects !== p.mes || (top.auxilliaries && top.auxilliaries !== p.aux.length)));
  return { key: p.key, name: p.name, mismatch };
}

module.exports = { PORT, EXT, EXT_NAME, AV, PROFILES: P, DEFAULT, profile, sources, audioName, summary, detect, kindOf, isAdvanced, PAIRS_ALL };
