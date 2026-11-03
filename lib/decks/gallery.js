'use strict';
// The 21 Stream Deck pages from the console surface design, plus the two
// RCP banks (detail/chroma and gamma/knee) that the design draws in the
// paint section and not again in the static gallery.
//
// A page whose grid matches the deck is copied cell for cell. Any other
// model keeps the same keys in the same order, with HOME pinned at the
// top left and the next-page key in the corner.

const { mainCells, powerCells } = require('../core/console-deck');

const post = (path, body) => ({ method: 'POST', path, body: body || {} });

const CAMROW = ['home:HOME', 'cam:CAM 1', 'camV:CAM 2/PVW', 'camP:CAM 3/PGM', 'cam:CAM 4', 'cam:CAM 5', 'cam:CAM 6', 'cam:CAM 7', 'cam:CAM 8'];
const DIRECT = ['fn:IRIS/AUTO', 'fn:WB/ATW', 'fn:AWB/exec', 'fn:ABB/exec', 'fn:GAIN/0 dB', 'fn:SHUTTER/OFF', 'fn:ND/CLEAR', 'fn:DRS/OFF', 'fn:BARS/OFF'];
const PAINT_TAIL = ['mode:MSU/▸ RCP', 'bank:CAMS/1–6 ▸', 'fn:GANG/off', 'fn:COPY/paint ▸', 'stop:STORE/paint', 'fn:RECALL/paint', 'fn:SCENE/1', 'fn:GUARD/HOLD', 'stop:ALL STOP/hold'];
const PAINT_MSU = [
  ...CAMROW,
  'bank:IRIS/all cams', 'bank:M.PED', 'bank:R GAIN', 'bank:B GAIN', 'bank:R PED', 'bank:B PED', 'bank:M.DTL', 'bank:GAMMA', 'bank:KNEE PT',
  ...DIRECT,
  ...PAINT_TAIL,
];
const PAINT_RCP = [
  ...CAMROW,
  'bank:EXP', 'bank:WHITE/BLACK', 'bank:DTL/CHROMA', 'bank:GAMMA/KNEE', 'bank:MATRIX', 'fn:◂ CAM', 'fn:CAM ▸', 'fn:COMPARE/stored', 'fn:COPY/to gang',
  ...DIRECT,
  'mode:RCP/▸ MSU', 'bank:CAMS/1–6 ▸', 'fn:GANG/off', 'fn:COPY/paint ▸', 'stop:STORE/paint', 'fn:RECALL/paint', 'fn:SCENE/1', 'fn:GUARD/HOLD', 'stop:ALL STOP/hold',
];
const PRESETS = [
  'home:HOME', 'cam:CAM 1', 'camV:CAM 2/PVW', 'camP:CAM 3/PGM', 'cam:CAM 4', 'cam:CAM 5', 'cam:CAM 6', 'bank:CAMS/7–12',
  'pre:1/Wide', 'pre:2/Podium', 'pre:3/MS L', 'pre:4/MS R', 'pre:5/Choir', 'pre:6/Band', 'pre:7/Drums', 'pre:8/Aud',
  'pre:9', 'pre:10', 'pre:11', 'pre:12', 'pre:13', 'pre:14', 'pre:15', 'pre:16',
  'stop:STORE/arm', 'bank:PAGE/17–32', 'fn:SPEED/fast', 'fn:SCOPE/all', 'fn:GUARD/HOLD', 'mode:MATRIX/view', 'fn:FOLLOW/PVW', 'stop:ALL STOP/hold',
];
const PRESETS_MX = [
  'home:HOME', 'pre:1', 'pre:2', 'pre:3', 'pre:4', 'pre:5', 'pre:6', 'pre:7',
  'camV:CAM 2/PVW', 'pre:1', 'pre:2', 'pre:3', 'pre:4', 'pre:5', 'pre:6', 'pre:7',
  'camP:CAM 3/PGM', 'pre:1/guarded', 'pre:2/guarded', 'pre:3/guarded', 'pre:4/guarded', 'pre:5/guarded', 'pre:6/guarded', 'pre:7/guarded',
  'stop:STORE/arm', 'bank:CAMS/4–6', 'fn:SPEED/fast', 'fn:SCOPE/all', 'fn:GUARD/HOLD', 'mode:LIST/view', 'fn:FOLLOW/PVW', 'stop:ALL STOP/hold',
];
const SW_COMP = [
  'home:HOME', 'pgm:CAM 1/ME2 PGM', 'pgm:CAM 2', 'pgm:CAM 3', 'pgm:CAM 4', 'pgm:CAM 5', 'pgm:CAM 6', 'pgm:MITTI', 'pgm:HYPR 1',
  'bank:SHIFT/9–20', 'pvw:CAM 1/ME2 PVW', 'pvw:CAM 2', 'pvw:CAM 3', 'pvw:CAM 4', 'pvw:CAM 5', 'pvw:CAM 6', 'pvw:MITTI', 'pvw:HYPR 1',
  'key:AUX 1/◂ PGM', 'key:AUX 2/◂ CLEAN', 'key:AUX 3/◂ ME2', 'key:AUX 4/◂ CAM 3', 'key:DSK 1/TIE', 'key:DSK 1/AUTO', 'key:DSK 2/TIE', 'key:DSK 2/AUTO', 'key:SS/LOOK A',
  'fn:MACRO/12 Intro', 'fn:CONTINUE/macro', 'mode:MODE/▸ BACKUP', 'tr:ME2/PREV TRN', 'tr:ME2 STYLE/MIX', 'stop:FTB/hold 1 s', 'key:ME2 KEY1/next', 'tr:ME2/CUT', 'tr:ME2/AUTO',
];
const SW_BACK = [
  'home:HOME', 'pgm:CAM 1/ME1 PGM', 'pgm:CAM 2', 'pgm:CAM 3', 'pgm:CAM 4', 'pgm:CAM 5', 'pgm:CAM 6', 'pgm:MITTI', 'pgm:HYPR 1',
  'bank:SHIFT/9–20', 'pvw:CAM 1/ME1 PVW', 'pvw:CAM 2', 'pvw:CAM 3', 'pvw:CAM 4', 'pvw:CAM 5', 'pvw:CAM 6', 'pvw:MITTI', 'pvw:HYPR 1',
  'key:BKGD/next', 'key:KEY 1/next', 'key:KEY 2', 'key:KEY 3', 'key:KEY 4', 'key:DSK 1/TIE', 'key:DSK 1/CUT', 'key:DSK 2/TIE', 'key:DSK 2/CUT',
  'mode:ME 1/▸ ME 2', 'tr:MIX', 'tr:DIP', 'tr:WIPE', 'tr:DVE', 'tr:PREV/TRANS', 'stop:FTB/hold 1 s', 'tr:CUT', 'tr:AUTO',
];
const SYSROW = ['sys:ATEM/2 M/E', 'sys:PTZ A/4/4', 'sys:PTZ B/1/2', 'sys:MITTI', 'sys:HYPER 1/REC', 'sys:HYPER 2', 'sys:VHUB', 'sysX:E2/OFFLINE'];
const CUEROW = ['home:HOME', 'cue:◂ CUE', 'cue:CUE ▸', 'cue:NEXT/mc7 Award', 'cue:STBY/armed', 'fn:BAIL', 'sysX:ALERTS/2 new', 'go:GO'];
const FLEX = {
  ATEM: ['fn:MACRO 1/Open', 'fn:MACRO 2/Cam 2', 'fn:MACRO 3/Lower 3', 'fn:MACRO 4/Sting', 'fn:MACRO 5/Walk', 'fn:MACRO 6/Awards', 'fn:MACRO 7/Clear', 'fn:CONTINUE/macro',
    'pre:MEM A1/Wide', 'pre:MEM A2/2-shot', 'pre:MEM A3/Walk-in', 'pre:MEM A4/Awards', 'key:MV/salvo 1', 'key:SS/LOOK A', 'key:LAYOUT/to PVW', 'fn:UNDO/recall'],
  HYPERDECK: ['stop:REC/hold', 'fn:STOP', 'fn:PLAY', 'fn:◂ CLIP', 'fn:CLIP ▸', 'fn:LOOP/off', 'fn:SLOT/1 ▸ 2', 'fn:INPUT/SDI',
    'pre:CLIP 1', 'pre:CLIP 2', 'pre:CLIP 3', 'pre:CLIP 4', 'pre:CLIP 5', 'pre:CLIP 6', 'bank:DECK/1 ▸ 2', 'fn:REMAIN/2:41 h'],
  MITTI: ['fn:PLAY/next', 'fn:PAUSE', 'fn:◂ PREV', 'fn:NEXT ▸', 'fn:LOOP', 'fn:FADE/out', 'stop:OUTPUTS/off', 'fn:PING',
    'pre:INTRO', 'pre:WALK', 'pre:VT1', 'pre:VT2', 'pre:VT3', 'pre:AWARD', 'pre:OUTRO', 'bank:CUES/9–16'],
  VIDEOHUB: ['key:DEST/MON 1', 'key:DEST/REC 1', 'key:DEST/STREAM', 'key:DEST/PROJ L', 'key:DEST/PROJ R', 'key:DEST/CONF', 'key:DEST/AUX 7', 'bank:DEST/9–16',
    'pre:CAM 1', 'pre:CAM 2', 'pre:CAM 3', 'pre:PGM', 'pre:CLEAN', 'pre:MITTI', 'bank:SRC/9–16', 'tr:TAKE'],
  E2: ['pre:PST 1/Walk-in', 'pre:PST 2/Keynote', 'pre:PST 3/Panel', 'pre:PST 4/Video', 'pre:PST 5/Awards', 'pre:PST 6/Break', 'pre:PST 7/Q&A', 'pre:PST 8/Close',
    'pre:PST 9', 'pre:PST 10', 'pre:PST 11', 'pre:PST 12', 'pre:PST 13', 'bank:PAGE/17–32', 'tr:CUT', 'tr:TAKE'],
};
const OSPAGE = [
  ...SYSROW,
  'fn:RECONNECT/selected', 'stop:RESTART/module', 'fn:ENABLE/on', 'fn:DETAILS/to screen', 'fn:ALERT/next ▸', 'fn:ACK/alert', 'fn:LOG/mark', 'fn:HEALTH/all ok?',
  'fn:PROFILE/load ▸', 'stop:PROFILE/save', 'fn:SHOW/load ▸', 'stop:SHOW/save', 'fn:WAN/hotel Wi‑Fi', 'fn:UNIFI/ok', 'fn:TIMER/out ON', 'fn:SMB/share ok',
  'home:HOME/exit', 'fn:COMPANION/running', 'fn:BACKUP/to SMB', 'stop:REBOOT/box ▸', 'stop:SHUTDOWN/all ▸', 'mode:LOCK/console', 'mode:SAFE/mode', 'go:GO',
];
const COMP_REGION = [
  ...SYSROW,
  'comp:QLAB/GO', 'comp:QLAB/STOP', 'comp:X32/MUTE GRP 1', 'comp:X32/LAV 1 ON', 'comp:MA3/EXEC 1', 'comp:MA3/HOUSE ½', 'comp:PROPRES/NEXT', 'comp:PROPRES/CLEAR',
  'comp:OBS/STREAM', 'comp:OBS/REC', 'comp:ZOOM/MUTE', 'comp:PJ 1/SHUTTER', 'comp:PJ 2/SHUTTER', 'comp:SHURE/RX 1 batt', 'comp:LIGHTS/look 3', 'bank:COMP/page 3 ▸',
  ...CUEROW,
];
const MITTI_FULL = [
  'home:HOME', 'pre:1/Walk-in', 'pre:2/Open VT', 'pre:3/Sponsor', 'camP:4/PLAY −0:42', 'camV:5/NEXT Award', 'pre:6/Award 2', 'pre:7/Award 3',
  'pre:8/Break', 'pre:9/Loop B', 'pre:10/Q&A bed', 'pre:11/Credits', 'pre:12/Outro', 'pre:13/Black', 'pre:14/Test', 'pre:15',
  'pre:16', 'pre:17', 'pre:18', 'pre:19', 'pre:20', 'pre:21', 'pre:22', 'pre:23',
  'fn:PLAY/▶ next', 'fn:PAUSE', 'fn:◂ PREV', 'fn:NEXT ▸', 'fn:LOOP/off', 'fn:FADE/out 2 s', 'stop:STOP/all · hold', 'bank:PAGE/1–23 ▸',
];
const VHUB_XY = [
  'home:HOME', 'mode:PROJ L/◂ PGM', 'key:PROJ R/◂ PGM', 'key:CONF/◂ CAM 3', 'key:REC 1/◂ CLEAN', 'key:STREAM/◂ PGM', 'key:MON 1/◂ MV', 'key:MON 2/◂ CAM 1', 'bank:DEST/9–16 ▸',
  'pre:CAM 1', 'pre:CAM 2', 'pre:CAM 3', 'pre:CAM 4', 'pre:CAM 5', 'pre:CAM 6', 'mode:PGM/current', 'camV:CLEAN/pending', 'pre:MV',
  'pre:MITTI 1', 'pre:MITTI 2', 'pre:HYPR 1', 'pre:HYPR 2', 'pre:LAPTOP', 'pre:E2 OUT', 'pre:BARS', 'pre:BLACK', 'bank:SRC/19–36 ▸',
  'bank:LEVEL/video', 'fn:LOCK/dest off', 'fn:UNDO', 'fn:SALVO 1/walk-in', 'fn:SALVO 2/show', 'fn:SALVO 3/break', 'fn:CLEAR/pending', 'mode:MODE/XY ▸ dest', 'tr:TAKE',
];
const E2_PANEL = [
  'home:HOME', 'pre:PST 1/Walk-in', 'pgm:PST 2/Keynote', 'pvw:PST 3/Panel', 'pre:PST 4/Video', 'pre:PST 5/Awards', 'pre:PST 6/Break', 'pre:PST 7/Q&A', 'pre:PST 8/Close',
  'bank:PAGE/1–16 ▸', 'pre:PST 9', 'pre:PST 10', 'pre:PST 11', 'pre:PST 12', 'pre:PST 13', 'pre:PST 14', 'pre:PST 15', 'pre:PST 16',
  'mode:MAIN/screens', 'key:SCR L', 'key:SCR C', 'key:SCR R', 'key:IMAG', 'key:AUX 1', 'key:AUX 2', 'key:MV', 'fn:ALL/dests',
  'fn:FREEZE/off', 'fn:BLACK/PVW', 'fn:MATCH/PGM ▸ PVW', 'fn:LAYER/edit ▸', 'stop:SAVE/preset', 'fn:UNDO', 'fn:TRANS/1.0 s', 'tr:CUT', 'tr:TAKE',
];

const WIDGET = {
  IRIS: 'iris', 'M.PED': 'masterPed', 'R GAIN': 'gainRb', 'B GAIN': 'gainRb', 'R PED': 'pedRb', 'B PED': 'pedRb',
  'M.DTL': 'masterDetail', GAMMA: 'gamma', 'KNEE PT': 'kneePoint', 'KNEE MODE': 'kneePoint', SHUTTER: 'shutter',
  ND: 'shutter', 'PIC LEVEL': 'iris', GAIN: 'gain', 'VAR TEMP': 'gainRb', 'SKIN DTL': 'masterDetail',
  'SKIN EFFECT': 'masterDetail', 'CHROMA LVL': 'chroma', 'CHROMA PHASE': 'chroma', 'GAMMA MODE': 'gamma',
  'KNEE SLOPE': 'kneePoint', 'R-G': 'gainRb', 'R-B': 'gainRb', 'G-R': 'pedRb', 'G-B': 'pedRb', 'B-R': 'pedRb', 'B-G': 'pedRb',
  ZOOM: 'zoom', FOCUS: 'focus', PAN: 'ptSpeed', TILT: 'zfSpeed', JOG: 'zoom', SHUTTLE: 'focus', DEST: 'iris', SOURCE: 'masterPed',
  PRESET: 'iris', 'CAM 1': 'iris', 'CAM 2': 'masterPed', 'CAM 3': 'gainRb', 'CAM 4': 'pedRb', 'CAM 5': 'zoom', 'CAM 6': 'focus',
};

function dial(label) {
  const name = String(label || '').split('/')[0];
  return { widget: WIDGET[name] || 'iris', label: name.slice(0, 12) };
}

const RCP_DIALS = {
  EXP: ['IRIS/tap A/M', 'M.PED/hold reset', 'SHUTTER/step', 'ND/list', 'PIC LEVEL/auto iris', 'GAIN/dB'],
  WB: ['R GAIN/tap AWB', 'B GAIN/tap AWB', 'R PED/tap ABB', 'B PED/tap ABB', 'VAR TEMP/K', 'M.PED/hold reset'],
  DTL: ['M.DTL/tap ON', 'SKIN DTL', 'SKIN EFFECT', 'CHROMA LVL', 'CHROMA PHASE', 'M.PED/hold reset'],
  GAMMA: ['GAMMA/tap HD', 'GAMMA MODE', 'KNEE PT', 'KNEE SLOPE', 'KNEE MODE', 'M.PED/hold reset'],
  MATRIX: ['R-G', 'R-B', 'G-R', 'G-B', 'B-R', 'B-G'],
};
const MSU_DIALS = ['CAM 1/IRIS', 'CAM 2/IRIS', 'CAM 3/IRIS', 'CAM 4/IRIS', 'CAM 5/IRIS', 'CAM 6/IRIS'];

function spec(id, kind, title, cols, rows, keys, dials) {
  return { id, kind, title, cols, rows, keys, dials: (dials || []).map(dial) };
}

const GALLERY = [
  spec('ptz-msu', 'ptz', 'PTZ paint · MSU', 9, 4, PAINT_MSU, MSU_DIALS),
  spec('ptz-rcp-exp', 'ptz', 'PTZ paint · RCP · EXP', 9, 4, PAINT_RCP, RCP_DIALS.EXP),
  spec('ptz-rcp-wb', 'ptz', 'PTZ paint · RCP · WHITE/BLACK', 9, 4, PAINT_RCP, RCP_DIALS.WB),
  spec('ptz-rcp-dtl', 'ptz', 'PTZ paint · RCP · DTL/CHROMA', 9, 4, PAINT_RCP, RCP_DIALS.DTL),
  spec('ptz-rcp-gamma', 'ptz', 'PTZ paint · RCP · GAMMA/KNEE', 9, 4, PAINT_RCP, RCP_DIALS.GAMMA),
  spec('ptz-rcp-matrix', 'ptz', 'PTZ paint · RCP · MATRIX', 9, 4, PAINT_RCP, RCP_DIALS.MATRIX),
  spec('ptz-presets', 'ptz', 'PTZ presets · list', 8, 4, PRESETS, []),
  spec('ptz-matrix', 'ptz', 'PTZ presets · matrix', 8, 4, PRESETS_MX, []),
  spec('ptz-lens', 'ptz', 'PTZ lens', 4, 2, ['fn:◂ CAM', 'fn:CAM ▸', 'fn:PUSH AF', 'fn:AF/MF', 'fn:HOME/cam', 'fn:GUARD/HOLD', 'fn:FOLLOW/PVW', 'stop:ALL STOP/hold'], ['ZOOM/tap stop', 'FOCUS/tap AF', 'PAN/tap stop', 'TILT/tap stop']),
  spec('atem-companion', 'atem', 'ATEM companion', 9, 4, SW_COMP, ['IRIS', 'M.PED', 'GAIN', 'SHUTTER', 'ZOOM', 'FOCUS']),
  spec('atem-backup', 'atem', 'ATEM backup', 9, 4, SW_BACK, ['ZOOM', 'FOCUS', 'IRIS', 'GAIN', 'M.PED', 'SHUTTER']),
  spec('atem-flex', 'atem', 'ATEM memories', 8, 4, [...SYSROW, ...FLEX.ATEM, ...CUEROW], []),
  spec('vhub-xy', 'videohub', 'Videohub XY', 9, 4, VHUB_XY, ['DEST', 'SOURCE', 'IRIS', 'GAIN', 'ZOOM', 'FOCUS']),
  spec('vhub-flex', 'videohub', 'Videohub flex', 8, 4, [...SYSROW, ...FLEX.VIDEOHUB, ...CUEROW], []),
  spec('vhub-quick', 'videohub', 'Videohub quick', 4, 2, ['tr:TAKE', 'fn:UNDO', 'fn:LOCK/dest', 'fn:SALVO 1', 'fn:SALVO 2', 'fn:SALVO 3', 'bank:LEVEL/video', 'fn:CLEAR'], ['DEST', 'SOURCE', 'IRIS', 'GAIN']),
  spec('e2-panel', 'e2', 'E2 presets', 9, 4, E2_PANEL, ['PRESET', 'DEST', 'IRIS', 'ZOOM', 'FOCUS', 'GAIN']),
  spec('e2-flex', 'e2', 'E2 flex', 8, 4, [...SYSROW, ...FLEX.E2, ...CUEROW], []),
  spec('mitti-grid', 'mitti', 'Mitti cue grid', 8, 4, MITTI_FULL, []),
  spec('mitti-flex', 'mitti', 'Mitti flex', 8, 4, [...SYSROW, ...FLEX.MITTI, ...CUEROW], []),
  spec('mitti-play', 'mitti', 'Playback transport', 4, 2, ['fn:PLAY', 'fn:STOP', 'stop:REC/hold', 'fn:LOOP', 'fn:◂ PREV', 'fn:NEXT ▸', 'bank:TARGET/HYPER 1', 'fn:MARK/in'], ['JOG', 'SHUTTLE', 'ZOOM', 'FOCUS']),
  spec('hyper-flex', 'hyperdeck', 'HyperDeck flex', 8, 4, [...SYSROW, ...FLEX.HYPERDECK, ...CUEROW], []),
  spec('hyper-play', 'hyperdeck', 'HyperDeck transport', 4, 2, ['fn:PLAY', 'fn:STOP', 'stop:REC/hold', 'fn:LOOP', 'fn:◂ PREV', 'fn:NEXT ▸', 'bank:TARGET/MITTI', 'fn:MARK/in'], ['JOG', 'SHUTTLE', 'ZOOM', 'FOCUS']),
  spec('os-page', 'console', 'OS page', 8, 4, OSPAGE, []),
  spec('os-companion', 'console', 'Companion rows', 8, 4, COMP_REGION, []),
];

const JUMP = {
  'mode:MSU': 'ptz-rcp-exp',
  'mode:RCP': 'ptz-msu',
  'bank:EXP': 'ptz-rcp-exp',
  'bank:WHITE': 'ptz-rcp-wb',
  'bank:DTL': 'ptz-rcp-dtl',
  'bank:GAMMA': 'ptz-rcp-gamma',
  'bank:MATRIX': 'ptz-rcp-matrix',
  'mode:MATRIX': 'ptz-matrix',
  'mode:LIST': 'ptz-presets',
  'fn:RECALL': 'ptz-presets',
  'fn:FOLLOW': 'ptz-lens',
  'bank:PAGE': 'ptz-matrix',
  'bank:CAMS': 'ptz-msu',
  'mode:MODE': 'atem-backup',
  'mode:ME 1': 'atem-companion',
  'fn:MACRO': 'atem-flex',
  'sys:ATEM': 'atem-companion',
  'mode:XY': 'vhub-quick',
  'bank:DEST': 'vhub-flex',
  'sys:VHUB': 'vhub-xy',
  'fn:CLEAR': 'vhub-xy',
  'bank:DECK': 'hyper-play',
  'sys:HYPER 1': 'hyper-flex',
  'bank:TARGET': 'mitti-play',
  'sys:MITTI': 'mitti-grid',
  'fn:COMPANION': 'os-companion',
  'bank:COMP': 'os-page',
};

function camerasOf(ctx) {
  const key = ctx.system && ctx.desk && ctx.desk.byKey && ctx.desk.byKey[ctx.system] ? ctx.system : 'ptz';
  const sys = ctx.desk && ctx.desk.byKey && ctx.desk.byKey[key];
  return { cameras: (sys && sys.cameras) || [], selected: sys && sys.selected };
}

function parseToken(token) {
  const idx = token.indexOf(':');
  const cat = token.slice(0, idx);
  const rest = token.slice(idx + 1);
  const cut = rest.indexOf('/');
  const label = cut < 0 ? rest : rest.slice(0, cut);
  const caption = cut < 0 ? '' : rest.slice(cut + 1);
  return { cat, label, caption };
}

function toneOf(cat, label) {
  if (cat === 'home' || cat === 'sys' || cat === 'comp') return 'os';
  if (cat === 'stop') return 'guard';
  if (cat === 'pgm' || cat === 'camP' || cat === 'sysX') return 'stop';
  if (cat === 'pvw' || cat === 'camV') return 'pvw';
  if (cat === 'go') return 'go';
  if (cat === 'tr') return /CUT|AUTO|TAKE/.test(label) ? 'stop' : 'go';
  if (cat === 'pre' || cat === 'cue') return 'memory';
  if (cat === 'bank' || cat === 'mode') return 'nav';
  return 'func';
}

function ptzCmd(ctx, name, body) {
  const id = ctx.system || 'ptz';
  return post(`/api/sys/${id}/cmd/${name}`, body || {});
}

function stepped(label) {
  return ['WB', 'GAIN', 'SHUTTER', 'ND', 'DRS', 'SCENE', 'SPEED', 'SCOPE'].includes(label);
}

const PTZ_OP = {
  IRIS: 'irisMode', WB: 'wbMode', AWB: 'awb', ABB: 'abb', GAIN: 'gain', SHUTTER: 'shutterStep',
  ND: 'ndFilter', DRS: 'drs', BARS: 'colorBars', SCENE: 'scene', GUARD: 'guard', SPEED: 'presetSpeed',
  SCOPE: 'presetScope', 'PUSH AF': 'oneTouchAF', AF: 'focusMode',
};

function keyFromToken(token, ctx) {
  const { cat, label, caption } = parseToken(token);
  const key = { label: label.slice(0, 12), caption: caption.slice(0, 12), tone: toneOf(cat, label), nav: null, action: null };
  if (cat === 'home') {
    return { ...key, label: 'HOME', caption: caption && caption !== 'exit' ? caption.slice(0, 12) : 'BACK', tone: 'os', nav: 'home' };
  }
  const dest = jumpTarget(cat, label, ctx);
  if (dest) return { ...key, tone: 'nav', nav: 'page', goto: dest };
  if (label === 'ALL STOP') {
    return { ...key, tone: 'guard', action: ptzCmd(ctx, 'stopAll', {}) };
  }
  if (label === 'GO') {
    return { ...key, tone: 'go', action: post('/api/cues/go', {}) };
  }
  const camN = /^CAM (\d+)$/.exec(label);
  if (camN && (cat === 'cam' || cat === 'camP' || cat === 'camV')) {
    const { cameras, selected } = camerasOf(ctx);
    const cam = cameras[Number(camN[1]) - 1];
    if (!cam) return { ...key, caption: caption || 'CAM' };
    const on = cam.id === selected;
    return {
      ...key,
      label: String(cam.name || label).slice(0, 10),
      caption: on ? 'ON' : (caption || 'CAM'),
      tone: on ? 'go' : key.tone,
      on,
      ring: on,
      cam: cam.id,
      action: ptzCmd(ctx, 'select', { cam: cam.id }),
    };
  }
  if ((cat === 'pre' || /^PST \d+$/.test(label) || /^MEM A\d+$/.test(label)) && (cat === 'pre' || cat === 'pgm' || cat === 'pvw')) {
    const n = Number((label.match(/\d+/) || [])[0] || 0);
    if (n > 0 && (ctx.kind === 'ptz' || ctx.kind === 'e2' || ctx.kind === 'mitti')) {
      const id = ctx.system || ctx.kind;
      const action = ctx.kind === 'ptz'
        ? ptzCmd(ctx, 'recall', { preset: n, guarded: true })
        : post(`/api/sys/${id}/presets/${n}/recall`, { target: 'preview' });
      return { ...key, label: String(n), caption: caption || 'PRESET', tone: cat === 'pgm' ? 'stop' : (cat === 'pvw' ? 'pvw' : 'memory'), absolute: ctx.kind !== 'ptz', action };
    }
  }
  if (ctx.kind === 'ptz' && PTZ_OP[label]) {
    const op = PTZ_OP[label];
    if (op === 'guard') return { ...key, action: ptzCmd(ctx, 'guard', { mode: 'cycle' }) };
    if (stepped(label)) return { ...key, op, action: ptzCmd(ctx, 'step', { op, steps: 1 }) };
    return { ...key, op, action: ptzCmd(ctx, 'op', { op }) };
  }
  if (ctx.kind === 'ptz' && label === '◂ CAM') return neighbor(ctx, -1, key);
  if (ctx.kind === 'ptz' && label === 'CAM ▸') return neighbor(ctx, 1, key);
  if (ctx.kind === 'ptz' && label === 'HOME' && caption === 'cam') return { ...key, action: ptzCmd(ctx, 'op', { op: 'home' }) };
  if (ctx.kind === 'atem' && label === 'ME2' && (caption === 'CUT' || caption === 'AUTO')) {
    return { ...key, label: caption, caption: 'ME2', tone: 'stop', action: post(`/api/sys/${ctx.system || 'atem'}/cmd/${caption.toLowerCase()}`, { me: 2 }) };
  }
  if (ctx.kind === 'atem' && (label === 'CUT' || label === 'AUTO' || label === 'FTB')) {
    const name = label === 'FTB' ? 'ftb' : label === 'AUTO' ? 'auto' : 'cut';
    return { ...key, action: post(`/api/sys/${ctx.system || 'atem'}/cmd/${name}`, { me: 1 }) };
  }
  if ((ctx.kind === 'atem') && (label === 'MIX' || label === 'DIP' || label === 'WIPE' || label === 'DVE')) {
    return { ...key, action: post(`/api/sys/${ctx.system || 'atem'}/cmd/style`, { style: label, me: 1 }) };
  }
  if (ctx.kind === 'videohub' && label === 'TAKE') {
    return { ...key, action: post(`/api/sys/${ctx.system || 'videohub'}/cmd/crosspoint`, { output: 0, input: 0 }) };
  }
  if ((ctx.kind === 'hyperdeck' || ctx.kind === 'mitti') && (label === 'PLAY' || label === 'STOP' || label === 'REC' || label === 'PAUSE')) {
    return transport(ctx, label, key);
  }
  if (ctx.kind === 'e2' && (label === 'CUT' || label === 'TAKE')) {
    const name = label === 'CUT' ? 'cut' : 'take';
    return { ...key, action: post(`/api/sys/${ctx.system || 'e2'}/${name}`, {}) };
  }
  if (ctx.kind === 'console') return consoleKey(label, key);
  return key;
}

function jumpTarget(cat, label, ctx) {
  if (cat === 'mode' && label === 'MODE') return ctx.kind === 'videohub' ? 'vhub-quick' : (ctx.kind === 'atem' ? 'atem-backup' : '');
  if (cat === 'bank' && label === 'PAGE') {
    if (ctx.kind === 'e2') return ctx.pageId === 'e2-flex' ? 'e2-panel' : 'e2-flex';
    if (ctx.kind === 'mitti') return ctx.pageId === 'mitti-flex' ? 'mitti-grid' : 'mitti-flex';
    if (ctx.kind === 'ptz') return 'ptz-matrix';
    return '';
  }
  if (cat === 'bank' && label === 'TARGET') return ctx.kind === 'hyperdeck' ? 'hyper-flex' : (ctx.kind === 'mitti' ? 'mitti-grid' : '');
  if (cat === 'bank' && label === 'CUES' && ctx.kind === 'mitti') return 'mitti-play';
  if (cat === 'fn' && label === 'FOLLOW' && ctx.pageId === 'ptz-lens') return 'ptz-msu';
  const id = JUMP[`${cat}:${label}`];
  if (!id) return '';
  const hit = GALLERY.find((item) => item.id === id);
  return hit && hit.kind === ctx.kind ? id : '';
}

function neighbor(ctx, dir, key) {
  const { cameras, selected } = camerasOf(ctx);
  if (!cameras.length) return key;
  let i = cameras.findIndex((cam) => cam.id === selected);
  if (i < 0) i = 0;
  const cam = cameras[(i + dir + cameras.length) % cameras.length];
  return { ...key, action: ptzCmd(ctx, 'select', { cam: cam.id }) };
}

function transport(ctx, label, key) {
  const id = ctx.system || ctx.kind;
  if (ctx.kind === 'hyperdeck' || label === 'REC') {
    const name = label === 'REC' ? 'record' : label === 'PLAY' ? 'play' : 'stop';
    return { ...key, tone: label === 'REC' ? 'guard' : key.tone, action: post(`/api/sys/${id}/cmd/${name}`, {}) };
  }
  const name = label === 'PAUSE' ? 'pause' : label === 'PLAY' ? 'play' : 'stop';
  return { ...key, action: post(`/api/sys/${id}/cmd/${name}`, {}) };
}

function consoleKey(label, key) {
  const wanted = {
    RECONNECT: 'connection.reconnect',
    RESTART: 'module.restart',
    ACK: 'health.ack',
    HEALTH: 'health.status',
    'SHOW': label && key.caption === 'save' ? 'show.save' : 'show.load',
    PROFILE: key.caption === 'save' ? 'profile.save' : 'profile.save',
    TIMER: 'service.refresh',
    SMB: 'service.refresh',
    COMPANION: 'service.refresh',
    REBOOT: 'host.reboot',
    SHUTDOWN: 'host.shutdown',
    LOCK: 'panel.lock',
    SAFE: 'panel.safe',
  };
  let actionId = wanted[label];
  if (label === 'SHOW') actionId = key.caption === 'save' ? 'show.save' : 'show.load';
  if (label === 'PROFILE') actionId = key.caption === 'save' ? 'profile.save' : 'profile.save';
  if (!actionId) return key;
  const cell = [...mainCells(), ...powerCells()].find((item) => item.role === actionId);
  return {
    ...key,
    tone: /REBOOT|SHUTDOWN/.test(label) ? 'guard' : 'os',
    role: actionId,
    feedback: cell ? cell.feedback : null,
    action: cell ? cell.action : post(`/api/core/cmd/${actionId}`, {}),
  };
}

function blankGrid(surface) {
  const keys = [];
  for (let row = 0; row < surface.rows; row++) {
    for (let col = 0; col < surface.cols; col++) keys.push({ row, col, label: '', caption: '', tone: 'blank', nav: null, action: null });
  }
  return keys;
}

function put(keys, surface, col, row, key) {
  if (col < 0 || row < 0 || col >= surface.cols || row >= surface.rows) return;
  const i = row * surface.cols + col;
  keys[i] = { ...keys[i], ...key, row, col };
}

function homeKey() {
  return { label: 'HOME', caption: 'BACK', tone: 'os', nav: 'home', action: null };
}

function layoutParts(item, surface, ctx) {
  const parsed = item.keys.map((token) => keyFromToken(token, { ...ctx, pageId: item.id }));
  const same = surface.cols === item.cols && surface.rows === item.rows;
  if (same) {
    const keys = blankGrid(surface);
    parsed.forEach((key, i) => put(keys, surface, i % item.cols, Math.floor(i / item.cols), key));
    if (!keys[0] || keys[0].nav !== 'home') put(keys, surface, 0, 0, homeKey());
    return [{ keys }];
  }
  const home = parsed.find((key) => key.nav === 'home') || homeKey();
  const body = parsed.filter((key) => key !== home);
  const free = [];
  for (let row = 0; row < surface.rows; row++) {
    for (let col = 0; col < surface.cols; col++) {
      if (row === 0 && col === 0) continue;
      if (row === surface.rows - 1 && col === surface.cols - 1) continue;
      free.push({ row, col });
    }
  }
  const per = Math.max(1, free.length);
  const count = Math.max(1, Math.ceil(body.length / per));
  const parts = [];
  for (let p = 0; p < count; p++) {
    const keys = blankGrid(surface);
    put(keys, surface, 0, 0, home);
    body.slice(p * per, (p + 1) * per).forEach((key, i) => put(keys, surface, free[i].col, free[i].row, key));
    // Adapted pages use the corner to reach the next page. The native grid
    // keeps ALL STOP or GO in the corner the design drew.
    put(keys, surface, surface.cols - 1, surface.rows - 1, {
      label: 'PAGE', caption: 'NEXT', tone: 'nav', nav: 'page', next: true, action: null,
    });
    parts.push({ keys });
  }
  return parts;
}

function dialsFor(item, surface) {
  const n = (surface.knobCols || []).length;
  if (!n) return [];
  const list = item.dials && item.dials.length ? item.dials : [
    dial('IRIS'), dial('M.PED'), dial('GAIN'), dial('ZOOM'), dial('FOCUS'), dial('SHUTTER'),
  ];
  return list.slice(0, n);
}

function designPages(kind, surface, ctx = {}) {
  const context = { ...ctx, kind };
  const pages = [];
  for (const item of GALLERY) {
    if (item.kind !== kind) continue;
    layoutParts(item, surface, context).forEach((part, index) => {
      pages.push({
        designId: item.id,
        title: item.title,
        part: index,
        keys: part.keys,
        dials: dialsFor(item, surface),
      });
    });
  }
  const first = new Map();
  pages.forEach((page, index) => {
    if (page.part === 0 && !first.has(page.designId)) first.set(page.designId, index);
  });
  pages.forEach((page, index) => {
    page.keys = page.keys.map((key) => {
      if (key && key.goto && first.has(key.goto)) return { ...key, nav: 'page', page: first.get(key.goto) };
      if (key && key.next) return { ...key, nav: 'page', page: (index + 1) % pages.length };
      return key;
    });
  });
  return pages;
}

module.exports = { GALLERY, designPages, mainCells, powerCells };
