'use strict';
// Every Panasonic PTZ command the app can send, as one table (0.8.0). Two sources, each entry says which:
//   src 'module'  the Bitfocus Companion module bitfocus/companion-module-panasonic-ptz v2.6.1 (src/actions.js),
//                 gated per camera series exactly like the module (src/models.js SERIES_SPECS[].actions)
//   src 'spec'    Panasonic "AW-UE150 / AW-HE145 Interface Specifications" v2.94 (UE150_IF_E.pdf) for commands the
//                 module does not have (paint, OSD menu, AWB / ABB, shutter mode, ...). Offered only on the UE150
//                 series (AW-UE100 / UE150 / UE155 / HE145 / UN145 in the module's model table) because that is the
//                 spec they come from. Other models may support some of them; see ptz/API-NOTES.md.
// Paths: 'ptz' = /cgi-bin/aw_ptz?cmd=%23<cmd>&res=1, 'cam' = /cgi-bin/aw_cam?cmd=<cmd>&res=1, 'web' = /cgi-bin/<cmd>.
// Types: button (no value), toggle (true / false), list (one of options()), range (number, min..max).
// `key` names the camdata.html field the value reads back from; decode() turns that field into the UI value.
const DATA = require('./panasonic-data');

const H = (n, w) => Math.max(0, Math.round(n)).toString(16).toUpperCase().padStart(w, '0');
const hx = (s) => parseInt(String(s).replace(/^0x/i, ''), 16);
const two = (n) => String(Math.max(0, Math.min(99, Math.round(n)))).padStart(2, '0');
const table = (s, k) => { const l = s.lists[k]; return l && l.table ? DATA.tables[l.table] : []; };
const cap = (k) => (s) => !!s.caps[k];
const SPEC_SERIES = new Set(['UE150']);
const spec = (s) => SPEC_SERIES.has(s.id);
const anyOf = (...fs) => (s) => fs.some((f) => f(s));
// centred hex ranges: value v (-n..+n) <-> code centre + v
const centred = (centre, w) => ({ enc: (v) => H(centre + v, w), dec: (s) => hx(s) - centre });
const list = (pairs) => pairs.map(([v, l]) => [String(v), l]);

// knee point: the spec table rows (22h = 70 %, 4Ah = 80 %, 80h = 93.5 %, B6h = 107 %) are 0.25 % per code; the
// remark column says "Step: 0.5 %" (the camera may round). Encoded from the table.
const kneeEnc = (p) => H(0x22 + Math.round((p - 70) * 4), 2);
const kneeDec = (s) => 70 + (hx(s) - 0x22) / 4;

const C = [];
const add = (o) => { C.push({ type: 'button', path: 'cam', src: 'spec', ...o }); };

// ---------- lens ----------
add({ id: 'focusMode', group: 'lens', label: 'Focus AF / MF', type: 'toggle', path: 'ptz', src: 'module', ref: 'focusM', avail: cap('OAF'), cmd: (on) => (on ? 'D11' : 'D10'), key: 'OAF', decode: (v) => v === '1' });
add({ id: 'oneTouchAF', group: 'lens', label: 'Push AF (one-touch auto focus)', src: 'module', ref: 'focusOTAF', avail: cap('OTAF'), cmd: () => 'OSE:69:1' });
add({ id: 'irisMode', group: 'exposure', label: 'Auto iris', type: 'toggle', path: 'ptz', src: 'module', ref: 'irisM', avail: cap('iris'), cmd: (on) => (on ? 'D31' : 'D30'), key: 'd3', decode: (v) => v === '1' });
add({ id: 'iris', group: 'exposure', label: 'Iris', type: 'range', path: 'ptz', src: 'module', ref: 'irisS (#I, 01 close .. 99 open)', range: { min: 1, max: 99, step: 1 }, avail: cap('iris'), cmd: (v) => `I${two(v)}`, key: 'axi', decode: (v) => Math.round(1 + ((hx(v) - 0x555) / (0xFFF - 0x555)) * 98) });
// 0.11.0 auto-iris setup (spec v2.94, all 'cam' commands; the iris mode itself is #D3 above: D31 auto / D30 manual)
add({ id: 'autoIrisSpeed', group: 'exposure', label: 'Auto iris speed', type: 'list', ref: 'Auto Iris Speed OSJ:01 (0 Slow, 1 Normal, 2 Fast)', avail: spec, options: () => list([[0, 'SLOW'], [1, 'NORMAL'], [2, 'FAST']]), cmd: (v) => `OSJ:01:${v}`, key: 'OSJ:01', decode: (v) => String(hx(v)) });
add({ id: 'autoIrisWindow', group: 'exposure', label: 'Auto iris window', type: 'list', ref: 'Auto Iris Window OSJ:02 (0 Normal1, 1 Normal2, 2 Center)', avail: spec, options: () => list([[0, 'NORMAL 1'], [1, 'NORMAL 2'], [2, 'CENTER']]), cmd: (v) => `OSJ:02:${v}`, key: 'OSJ:02', decode: (v) => String(hx(v)) });
add({ id: 'autoIrisLimit', group: 'exposure', label: 'Auto iris close limit', type: 'list', ref: 'Auto Iris Close Limit OSJ:C0 (0 Normal, 1 F8, 2 F7, 3 F5.6)', avail: spec, options: () => list([[0, 'NORMAL'], [1, 'F8'], [2, 'F7'], [3, 'F5.6']]), cmd: (v) => `OSJ:C0:${v}`, key: 'OSJ:C0', decode: (v) => String(hx(v)) });
add({ id: 'pictureLevel', group: 'exposure', label: 'Picture level', type: 'range', ref: 'Picture Level OSD:48 (00h = -50, 32h = 0, 64h = +50; with auto iris, ELC or AGC)', avail: spec, range: { min: -50, max: 50, step: 1, centre: 0 }, cmd: (v) => `OSD:48:${H(0x32 + Number(v), 2)}`, key: 'OSD:48', decode: (v) => hx(v) - 0x32 });
add({ id: 'home', group: 'motion', label: 'Home (pan / tilt centre)', path: 'ptz', src: 'module', ref: 'home', avail: cap('panTilt'), cmd: () => 'APC7FFF7FFF' });
add({ id: 'install', group: 'system', label: 'Install position', type: 'list', path: 'ptz', src: 'module', ref: 'insPosition', avail: cap('ins'), options: () => list([[0, 'Desktop'], [1, 'Hanging']]), cmd: (v) => `INS${v}`, key: 'iNS' });

// ---------- exposure ----------
// 0.11.0: checked against the AW-UE150 / HE145 spec v2.94 (Brightness table). Step VAL OSJ:06 takes the shutter
// denominator as 4 hex digits (0001h..2710h). Valid steps by format: 59.94p/i and 50p/i: 1/60 1/100 1/120 1/250
// 1/500 .. 1/10000; 29.97p adds 1/30; 25p adds 1/25 1/50; 23.98p / 24p add 1/24 1/48. There is no 1/125 (removed).
const SHUTTER_STEPS = [24, 25, 30, 48, 50, 60, 100, 120, 250, 500, 1000, 2000, 4000, 8000, 10000];
add({ id: 'gain', group: 'exposure', label: 'Gain', type: 'list', src: 'module', ref: 'gainS', avail: cap('gain'), options: (s) => table(s, 'gain'), cmd: (v, s) => `${s.lists.gain.cmd}${v}`, key: 'OGU' });
add({ id: 'superGain', group: 'exposure', label: 'Super gain', type: 'toggle', ref: 'Super Gain OSI:28', avail: spec, cmd: (on) => `OSI:28:${on ? 1 : 0}`, key: 'OSI:28', decode: (v) => v === '1' });
add({ id: 'ndFilter', group: 'exposure', label: 'ND filter', type: 'list', src: 'module', ref: 'filterS', avail: (s) => !!s.lists.filter, options: (s) => table(s, 'filter'), cmd: (v, s) => `${s.lists.filter.cmd}${v}`, key: 'OFT' });
add({ id: 'shutter', group: 'exposure', label: 'Shutter', type: 'list', src: 'module', ref: 'shutS', avail: (s) => !!s.lists.shut, options: (s) => table(s, 'shut'), cmd: (v, s) => `${s.lists.shut.cmd}${v}`, key: 'OSH' });
add({ id: 'shutterMode', group: 'exposure', label: 'Shutter mode', type: 'list', ref: 'Shutter Mode OSJ:03', avail: spec, options: () => list([[0, 'OFF'], [1, 'STEP'], [2, 'SYNCHRO'], [3, 'ELC']]), cmd: (v) => `OSJ:03:${v}`, key: 'OSJ:03', decode: (v) => String(hx(v)) });
add({ id: 'shutterStep', group: 'exposure', label: 'Shutter step (1/n s)', type: 'list', ref: 'Step VAL OSJ:06 (shutter denominator, 4 hex digits; 1/24 .. 1/50 depend on the format, the camera answers ER3 otherwise)', avail: spec,
  options: () => SHUTTER_STEPS.map((n) => [String(n), `1/${n}`]), cmd: (v) => `OSJ:06:${H(Number(v), 4)}`, key: 'OSJ:06', decode: (v) => String(hx(v)) });
add({ id: 'shutterStepUp', group: 'exposure', label: 'Shutter step +', ref: 'Step Inc OSJ:04', avail: spec, cmd: () => 'OSJ:04:01' });
add({ id: 'shutterStepDown', group: 'exposure', label: 'Shutter step −', ref: 'Step Dec OSJ:05', avail: spec, cmd: () => 'OSJ:05:01' });
add({ id: 'synchro', group: 'exposure', label: 'Synchro scan (Hz)', type: 'range', ref: 'Synchro VAL OSJ:09 (0.1 Hz units, hex)', avail: spec, range: { min: 24, max: 7200, step: 0.1 }, cmd: (v) => `OSJ:09:${H(Number(v) * 10, 5)}`, key: 'OSJ:09', decode: (v) => hx(v) / 10 });
add({ id: 'synchroUp', group: 'exposure', label: 'Synchro +', ref: 'Synchro Inc OSJ:07', avail: spec, cmd: () => 'OSJ:07:01' });
add({ id: 'synchroDown', group: 'exposure', label: 'Synchro −', ref: 'Synchro Dec OSJ:08', avail: spec, cmd: () => 'OSJ:08:01' });
add({ id: 'elcLimit', group: 'exposure', label: 'ELC limit (auto shutter)', type: 'list', ref: 'ELC Limit OSD:BF (2 1/100, 3 1/120, 4 1/250; shutter mode ELC)', avail: spec, options: () => list([[2, '1/100'], [3, '1/120'], [4, '1/250']]), cmd: (v) => `OSD:BF:${v}`, key: 'OSD:BF' });
add({ id: 'pedestal', group: 'paint', label: 'Master pedestal', type: 'list', src: 'module', ref: 'pedS', avail: (s) => !!s.lists.ped, options: (s) => table(s, 'ped'), cmd: (v, s) => `${s.lists.ped.cmd}${v}`, key: 'OTP' });

// ---------- white balance ----------
add({ id: 'wbMode', group: 'wb', label: 'White balance mode', type: 'list', src: 'module', ref: 'sceneSet (OAW 0/1/2) + spec OAW 4/5/9', avail: cap('whiteBalanceMode'),
  options: (s) => list(spec(s) ? [[0, 'ATW'], [1, 'AWC A'], [2, 'AWC B'], [4, '3200K'], [5, '5600K'], [9, 'VAR']] : [[0, 'ATW'], [1, 'AWC A'], [2, 'AWC B']]), cmd: (v) => `OAW:${v}`, key: 'OAW' });
add({ id: 'awb', group: 'wb', label: 'AWB execute', ref: 'AWB OWS', avail: spec, cmd: () => 'OWS' });
add({ id: 'abb', group: 'wb', label: 'ABB execute', ref: 'ABB OAS', avail: spec, cmd: () => 'OAS' });
add({ id: 'colorTemp', group: 'wb', label: 'Colour temperature', type: 'list', src: 'module', ref: 'colorTemperatureSet', avail: (s) => !!s.lists.colorTemperature, options: (s) => table(s, 'colorTemperature'), cmd: (v, s) => `${s.lists.colorTemperature.cmd}${v}`, key: 'OSD:B1' });
add({ id: 'varTemp', group: 'wb', label: 'VAR colour temperature (K)', type: 'range', ref: 'Color Temperature OSI:20 (007D0h-03A98h)', avail: spec, range: { min: 2000, max: 15000, step: 10 }, cmd: (v) => `OSI:20:${H(Number(v), 5)}`, key: 'OSI:20', decode: (v) => hx(String(v).split(':')[0]) });
add({ id: 'varTempUp', group: 'wb', label: 'Colour temp +', ref: 'Color Temperature Inc OSI:1E', avail: spec, cmd: () => 'OSI:1E:1' });
add({ id: 'varTempDown', group: 'wb', label: 'Colour temp −', ref: 'Color Temperature Dec OSI:1F', avail: spec, cmd: () => 'OSI:1F:1' });

// ---------- paint (RCP) ----------
const paint = (id, label, code, ref, w, centre, n, group = 'paint') => { const c = centred(centre, w); add({ id, group, label, type: 'range', ref, avail: spec, range: { min: -n, max: n, step: 1, centre: 0 }, cmd: (v) => `${code}:${c.enc(Number(v))}`, key: code, decode: c.dec }); };
paint('rGain', 'R gain', 'OSG:39', 'R Gain OSG:39 (738h..8C8h, 800h = 0)', 3, 0x800, 200);
paint('bGain', 'B gain', 'OSG:3A', 'B Gain OSG:3A (738h..8C8h, 800h = 0)', 3, 0x800, 200);
paint('masterPed', 'Master pedestal', 'OSJ:0F', 'Master Pedestal OSJ:0F (738h..8C8h)', 3, 0x800, 200);
paint('rPed', 'R pedestal', 'ORP', 'R Pedestal ORP (032h..0FAh, 096h = 0)', 3, 0x096, 100);
paint('gPed', 'G pedestal', 'OSJ:10', 'G Pedestal OSJ:10 (032h..0FAh)', 3, 0x096, 100);
paint('bPed', 'B pedestal', 'OBP', 'B Pedestal OBP (032h..0FAh)', 3, 0x096, 100);
// ---------- detail ----------
add({ id: 'detail', group: 'detail', label: 'Detail', type: 'toggle', ref: 'Detail ODT', avail: spec, cmd: (on) => `ODT:${on ? 1 : 0}`, key: 'ODT', decode: (v) => v !== '0' });
paint('masterDetail', 'Master detail', 'OSA:30', 'Master Detail OSA:30 (61h..9Fh)', 2, 0x80, 31, 'detail');
add({ id: 'skinDetail', group: 'detail', label: 'Skin tone detail', type: 'toggle', ref: 'Skin Tone Detail OSA:40', avail: spec, cmd: (on) => `OSA:40:${on ? 1 : 0}`, key: 'OSA:40', decode: (v) => v === '1' });
add({ id: 'skinEffect', group: 'detail', label: 'Skin detail effect', type: 'range', ref: 'Skin Detail Effect OSD:A3 (80h..9Fh)', avail: spec, range: { min: 0, max: 31, step: 1 }, cmd: (v) => `OSD:A3:${H(0x80 + Number(v), 2)}`, key: 'OSD:A3', decode: (v) => hx(v) - 0x80 });
// ---------- gamma / knee ----------
add({ id: 'gammaMode', group: 'gamma', label: 'Gamma mode', type: 'list', ref: 'Gamma Mode Select OSE:72', avail: spec, options: () => list([[0, 'HD'], [2, 'FILMLIKE1'], [3, 'FILMLIKE2'], [4, 'FILMLIKE3'], [5, 'FILM-REC'], [6, 'VIDEO-REC'], [7, 'HLG']]), cmd: (v) => `OSE:72:${v}`, key: 'OSE:72' });
add({ id: 'gamma', group: 'gamma', label: 'Gamma (×0.01)', type: 'range', ref: 'Gamma OSA:6A (67h = 0.30 .. 94h = 0.75)', avail: spec, range: { min: 30, max: 75, step: 1, centre: 55 }, cmd: (v) => `OSA:6A:${H(0x80 + Number(v) - 55, 2)}`, key: 'OSA:6A', decode: (v) => hx(v) - 0x80 + 55 });
add({ id: 'kneeMode', group: 'knee', label: 'Knee mode', type: 'list', ref: 'Knee Mode OSA:2D', avail: spec, options: () => list([[0, 'OFF'], [1, 'MANUAL'], [2, 'AUTO']]), cmd: (v) => `OSA:2D:${v}`, key: 'OSA:2D' });
add({ id: 'kneePoint', group: 'knee', label: 'Knee point (%)', type: 'range', ref: 'Knee Point OSA:20 (22h = 70 % .. B6h = 107 %)', avail: spec, range: { min: 70, max: 107, step: 0.25 }, cmd: (v) => `OSA:20:${kneeEnc(Number(v))}`, key: 'OSA:20', decode: kneeDec });
add({ id: 'kneeSlope', group: 'knee', label: 'Knee slope', type: 'range', ref: 'Knee Slope OSA:24 (00h..63h)', avail: spec, range: { min: 0, max: 99, step: 1 }, cmd: (v) => `OSA:24:${H(Number(v), 2)}`, key: 'OSA:24', decode: (v) => hx(v) });
// ---------- matrix / chroma ----------
add({ id: 'matrixType', group: 'matrix', label: 'Matrix type', type: 'list', ref: 'Matrix Type OSE:31', avail: spec, options: () => list([[0, 'NORMAL'], [1, 'EBU'], [2, 'NTSC'], [3, 'USER']]), cmd: (v) => `OSE:31:${v}`, key: 'OSE:31' });
add({ id: 'adaptiveMatrix', group: 'matrix', label: 'Adaptive matrix', type: 'toggle', ref: 'Adaptive Matrix OSJ:4F', avail: spec, cmd: (on) => `OSJ:4F:${on ? 1 : 0}`, key: 'OSJ:4F', decode: (v) => v === '1' });
for (const [i, n] of ['R-G', 'R-B', 'G-R', 'G-B', 'B-R', 'B-G'].entries()) paint(`matrix${n.replace('-', '')}`, `Matrix ${n}`, `OSD:A${4 + i}`, `Matrix(${n}) OSD:A${4 + i} (41h..BFh)`, 2, 0x80, 63, 'matrix');
add({ id: 'chromaLevel', group: 'chroma', label: 'Chroma level (%; −100 = OFF)', type: 'range', ref: 'Chroma Level OSD:B0 (00h = OFF, 1Dh..E3h = −99..+99 %)', avail: spec, range: { min: -100, max: 99, step: 1, centre: 0 },
  cmd: (v) => `OSD:B0:${Number(v) <= -100 ? '00' : H(0x80 + Number(v), 2)}`, key: 'OSD:B0', decode: (v) => (hx(v) === 0 ? -100 : hx(v) - 0x80) });
paint('chromaPhase', 'Chroma phase', 'OSJ:0B', 'Chroma Phase OSJ:0B (61h..9Fh)', 2, 0x80, 31, 'chroma');

// ---------- scene / presets ----------
add({ id: 'scene', group: 'scene', label: 'Scene file', type: 'list', src: 'module', ref: 'sceneSelect (XSF)', avail: cap('sceneSelect'), options: () => list([[1, 'Scene 1'], [2, 'Scene 2'], [3, 'Scene 3'], [4, 'Scene 4']]), cmd: (v) => `XSF:${v}`, key: 'OSF', decode: (v) => String(Number(v) + 1) });
add({ id: 'presetScope', group: 'preset', label: 'Preset recall scope', type: 'list', src: 'module', ref: 'recallModePset (OSE:71)', avail: cap('preset'), options: () => list([[0, 'A: PTZ + iris + WB/colour'], [1, 'B: PTZ + iris'], [2, 'C: PTZ only']]), cmd: (v) => `OSE:71:${v}`, key: 'OSE:71' });
add({ id: 'presetSpeedMode', group: 'preset', label: 'Preset speed / time mode', type: 'list', src: 'module', ref: 'modePset (OSJ:29)', avail: cap('timePset'), options: () => list([[0, 'Speed'], [1, 'Time']]), cmd: (v) => `OSJ:29:${v}`, key: 'OSJ:29' });
add({ id: 'presetSpeed', group: 'preset', label: 'Preset speed', type: 'list', path: 'ptz', src: 'module', ref: 'speedPset (UPVS)', avail: cap('speedPset'), options: () => DATA.presetSpeeds, cmd: (v) => `UPVS${String(v).padStart(3, '0')}`, key: 'uPVS' });
add({ id: 'presetTime', group: 'preset', label: 'Preset time', type: 'list', path: 'ptz', src: 'module', ref: 'timePset (UPVS)', avail: cap('timePset'), options: () => DATA.presetTimes, cmd: (v) => `UPVS${String(v).padStart(3, '0')}`, key: 'uPVS' });

// ---------- system / tally / bars ----------
add({ id: 'power', group: 'system', label: 'Power', type: 'toggle', path: 'ptz', src: 'module', ref: 'powerOn / powerOff', avail: cap('power'), cmd: (on) => (on ? 'O1' : 'O0'), key: 'p', decode: (v) => v === '1' });
add({ id: 'tallyRed', group: 'tally', label: 'Red tally', type: 'toggle', src: 'module', ref: 'tallyOn / tallyOff', avail: cap('tally'), path: (s) => (s.caps.tally2 ? 'cam' : 'ptz'), cmd: (on, s) => (s.caps.tally2 ? `TLR:${on ? 1 : 0}` : `DA${on ? 1 : 0}`), key: 'TLR', decode: (v) => v === '1' });
add({ id: 'tallyGreen', group: 'tally', label: 'Green tally', type: 'toggle', src: 'module', ref: 'tally2On / tally2Off', avail: cap('tally2'), cmd: (on) => `TLG:${on ? 1 : 0}`, key: 'TLG', decode: (v) => v === '1' });
add({ id: 'sdRec', group: 'system', label: 'SD card record', type: 'list', path: 'web', src: 'module', ref: 'sdCardRec', avail: cap('sdCard'), options: () => list([['start', 'Start'], ['end', 'Stop']]), cmd: (v) => `sdctrl?save=${v}` });
add({ id: 'colorBars', group: 'bars', label: 'Colour bars', type: 'toggle', src: 'module', ref: 'colorBarsOn / Off (DCB)', avail: cap('colorBars'), cmd: (on) => `DCB:${on ? 1 : 0}`, key: 'DCB', decode: (v) => v === '1' });
add({ id: 'colorBarsSetup', group: 'bars', label: 'Bars setup level', type: 'toggle', src: 'module', ref: 'colorBarSetupsOn / Off (DCS)', avail: cap('colorBarsSetup'), cmd: (on) => `DCS:${on ? 1 : 0}`, key: 'DCS', decode: (v) => v === '1' });
add({ id: 'colorBarsTitle', group: 'bars', label: 'Bars title', type: 'toggle', src: 'module', ref: 'colorBarsTitleOn / Off (OSD:BE)', avail: cap('colorBarsTitle'), cmd: (on) => `OSD:BE:${on ? 1 : 0}`, key: 'OSD:BE', decode: (v) => v === '1' });
add({ id: 'colorBarsTone', group: 'bars', label: 'Bars tone', type: 'list', src: 'module', ref: 'colorBarsTone (OSJ:27; module sends "0h"/"1h"/"2h", spec data is 0/1/2)', avail: cap('colorBarsTone'), options: () => list([[0, 'Off'], [1, 'Low'], [2, 'Normal']]), cmd: (v) => `OSJ:27:${v}`, key: 'OSJ:27' });
add({ id: 'colorBarsType', group: 'bars', label: 'Bars type', type: 'list', src: 'module', ref: 'colorBarsType (OSD:BA)', avail: cap('colorBarsType'), options: () => list([[1, 'Type 1'], [0, 'Type 2']]), cmd: (v) => `OSD:BA:${v}`, key: 'OSD:BA' });

// ---------- OSD menu ----------
add({ id: 'menu', group: 'menu', label: 'Camera menu (OSD)', type: 'toggle', ref: 'Menu On/Off DUS', avail: spec, cmd: (on) => `DUS:${on ? 1 : 0}`, key: 'OUS', decode: (v) => v === '1' });
for (const [id, c, l] of [['menuUp', 'DUP', 'Up'], ['menuDown', 'DDW', 'Down'], ['menuLeft', 'DLT', 'Left'], ['menuRight', 'DRT', 'Right'], ['menuEnter', 'DIT', 'Enter'], ['menuCancel', 'DPG', 'Cancel']])
  add({ id, group: 'menu', label: `Menu ${l}`, ref: `Menu ${l} ${c}`, avail: spec, cmd: () => c });

// ---------- 0.9.8: lens extras, pan/tilt limits, tally setup, tracking data (UE150 / HE145 spec v2.94) ----------
// absolute zoom / focus position: #AXZ / #AXF 555h (wide / near) .. FFFh (tele / far), read back from camdata axz / axf
const pos = { enc: (v) => H(0x555 + Math.round((Number(v) / 100) * 0xAAA), 3), dec: (s) => Math.round(((hx(s) - 0x555) / 0xAAA) * 1000) / 10 };
add({ id: 'zoomPos', group: 'lens', label: 'Zoom position (%; 0 wide .. 100 tele)', type: 'range', path: 'ptz', ref: 'Zoom Position Control #AXZ (555h wide .. FFFh tele)', avail: spec, range: { min: 0, max: 100, step: 0.5 }, cmd: (v) => `AXZ${pos.enc(v)}`, key: 'axz', decode: pos.dec });
add({ id: 'focusPos', group: 'lens', label: 'Focus position (%; 0 near .. 100 far; manual focus only)', type: 'range', path: 'ptz', ref: 'Focus Position Control #AXF (555h near .. FFFh far), available when Focus Mode is Manual', avail: spec, range: { min: 0, max: 100, step: 0.5 }, cmd: (v) => `AXF${pos.enc(v)}`, key: 'axf', decode: pos.dec });
add({ id: 'dExtender', group: 'lens', label: 'Digital extender', type: 'list', ref: 'Digital Extender OSJ:4E (0 OFF, 1 x1.4, 2 x2.0; Opt. zoom mode)', avail: spec, options: () => list([[0, 'OFF'], [1, '×1.4'], [2, '×2.0']]), cmd: (v) => `OSJ:4E:${v}`, key: 'OSJ:4E' });
add({ id: 'digitalZoom', group: 'lens', label: 'Digital zoom', type: 'toggle', ref: 'Digital Zoom OSE:70 (0 disable, 1 enable)', avail: spec, cmd: (on) => `OSE:70:${on ? 1 : 0}`, key: 'OSE:70', decode: (v) => v === '1' });
add({ id: 'ois', group: 'lens', label: 'Image stabilizer (O.I.S.)', type: 'toggle', ref: 'O.I.S. Mode OIS (0 off, 1 on)', avail: spec, cmd: (on) => `OIS:${on ? 1 : 0}`, key: 'OIS', decode: (v) => v === '1' });
add({ id: 'presetDExt', group: 'preset', label: 'Preset digital extender', type: 'toggle', ref: 'Preset D-Extender OSE:7C (0 off, 1 on)', avail: spec, cmd: (on) => `OSE:7C:${on ? 1 : 0}`, key: 'OSE:7C', decode: (v) => v === '1' });
for (const [id, d, l] of [['limitUp', 1, 'up'], ['limitDown', 2, 'down'], ['limitLeft', 3, 'left'], ['limitRight', 4, 'right']])
  add({ id, group: 'limits', label: `Pan/tilt limit ${l} (set at the current position)`, type: 'toggle', path: 'ptz', ref: `Limitation Control #LC${d}<0 release|1 set>`, avail: spec, cmd: (on) => `LC${d}${on ? 1 : 0}`, key: `lC${d}`, decode: (v) => v === '1' });
add({ id: 'tallyEnable', group: 'tally', label: 'Tally lamp enable', type: 'toggle', path: 'ptz', ref: 'TALLY Enable #TAE (0 disable, 1 enable)', avail: spec, cmd: (on) => `TAE${on ? 1 : 0}`, key: 'tAE', decode: (v) => v === '1' });
add({ id: 'tallyBright', group: 'tally', label: 'Tally brightness', type: 'list', ref: 'Tally Brightness OSA:D3 (0 low, 1 mid, 2 high; not in camdata)', avail: spec, options: () => list([[0, 'LOW'], [1, 'MID'], [2, 'HIGH']]), cmd: (v) => `OSA:D3:${v}`, key: 'OSA:D3' });
add({ id: 'tallyLimitR', group: 'tally', label: 'Red tally LED limit', type: 'toggle', ref: 'Tally LED Limit R OSJ:D9 (0 unlimited, 1 limited)', avail: spec, cmd: (on) => `OSJ:D9:${on ? 1 : 0}`, key: 'OSJ:D9', decode: (v) => v === '1' });
add({ id: 'tallyLimitG', group: 'tally', label: 'Green tally LED limit', type: 'toggle', ref: 'Tally LED Limit G OSJ:DA (0 unlimited, 1 limited)', avail: spec, cmd: (on) => `OSJ:DA:${on ? 1 : 0}`, key: 'OSJ:DA', decode: (v) => v === '1' });
add({ id: 'trackSerial', group: 'tracking', label: 'Tracking data out: serial', type: 'toggle', ref: 'Tracking data output Serial Out OSJ:54 (spec: AW-UE150 only)', avail: spec, cmd: (on) => `OSJ:54:${on ? 1 : 0}`, key: 'OSJ:54', decode: (v) => v === '1' });
add({ id: 'trackIP', group: 'tracking', label: 'Tracking data out: IP', type: 'toggle', ref: 'Tracking data output IP Out OSJ:55 (spec: AW-UE150 only)', avail: spec, cmd: (on) => `OSJ:55:${on ? 1 : 0}`, key: 'OSJ:55', decode: (v) => v === '1' });

// Motion and presets have their own driver methods (hold-to-run, queue, deadman); listed here so the catalog is complete.
const MOTION = [
  { id: 'move', group: 'motion', label: 'Pan / tilt (proportional, −49..+49 each)', src: 'module', ref: 'left/right/up/down/upLeft/... (PTS<pp><tt>)', cap: 'panTilt' },
  { id: 'zoom', group: 'motion', label: 'Zoom (−49 wide .. +49 tele)', src: 'module', ref: 'zoomI / zoomO / zoomS (Z<nn>)', cap: 'zoom' },
  { id: 'focus', group: 'motion', label: 'Focus (−49 near .. +49 far)', src: 'module', ref: 'focusN / focusF / focusS (F<nn>)', cap: 'focus' },
  { id: 'stop', group: 'motion', label: 'Stop pan / tilt / zoom / focus', src: 'module', ref: 'stop, zoomS, focusS', cap: 'zoom' },
  { id: 'recall', group: 'preset', label: 'Recall preset 1..100', src: 'module', ref: 'recallPset (R<nn>)', cap: 'preset' },
  { id: 'store', group: 'preset', label: 'Store preset 1..100', src: 'module', ref: 'savePset (M<nn>)', cap: 'preset' },
  { id: 'presetName', group: 'preset', label: 'Preset name on the camera (15 chars)', src: 'spec', ref: 'Save Preset Name OSJ:35', spec: true },
  { id: 'thumbnail', group: 'preset', label: 'Preset thumbnail image', src: 'spec', ref: 'Web CGI supplement 4.16 /cgi-bin/get_preset_thumbnail?preset_number=N', spec: true },
];
MOTION.push({ id: 'snapshot', group: 'view', label: 'Live JPEG snapshot (one frame)', src: 'spec', ref: 'Web CGI supplement 2.6 /cgi-bin/camera?resolution=640', spec: true });
MOTION.push({ id: 'streamInfo', group: 'view', label: 'RTSP stream information', src: 'spec', ref: 'Web CGI supplement 4.17 /cgi-bin/get_rtsp', spec: true });
MOTION.push({ id: 'speeds', group: 'motion', label: 'Session speeds (pan-tilt / zoom / focus, 1..49)', src: 'module', ref: 'ptSpeedS/U/D, pSpeed*, tSpeed*, zSpeed*, fSpeed* (app-side, like the module)', cap: 'panTilt' });
MOTION.push({ id: 'keepalive', group: 'motion', label: 'Hold keep-alive (re-arms the dead-man; sends nothing)', src: 'app', ref: 'app safety', cap: 'zoom' });
const BY_ID = new Map(C.map((x) => [x.id, x]));
// Every action of the Companion module (src/actions.js, v2.6.1) -> the app command that does the same thing.
// test/ptz.test.js reads the module's source (when present) and fails if an action is missing here.
const MODULE_ACTIONS = {
  left: 'move', right: 'move', up: 'move', down: 'move', upLeft: 'move', upRight: 'move', downLeft: 'move', downRight: 'move', stop: 'stop', home: 'home',
  ptSpeedS: 'speeds', ptSpeedU: 'speeds', ptSpeedD: 'speeds', pSpeedU: 'speeds', pSpeedD: 'speeds', tSpeedU: 'speeds', tSpeedD: 'speeds',
  zoomI: 'zoom', zoomO: 'zoom', zoomS: 'stop', zSpeedS: 'speeds', zSpeedU: 'speeds', zSpeedD: 'speeds',
  focusN: 'focus', focusF: 'focus', focusS: 'stop', fSpeedS: 'speeds', fSpeedU: 'speeds', fSpeedD: 'speeds', focusM: 'focusMode', focusOTAF: 'oneTouchAF',
  irisU: 'iris', irisD: 'iris', irisS: 'iris', irisM: 'irisMode', gainU: 'gain', gainD: 'gain', gainS: 'gain', shutU: 'shutter', shutD: 'shutter', shutS: 'shutter',
  pedU: 'pedestal', pedD: 'pedestal', pedS: 'pedestal', colorTemperatureUp: 'colorTemp', colorTemperatureDown: 'colorTemp', colorTemperatureSet: 'colorTemp',
  filterU: 'ndFilter', filterD: 'ndFilter', filterS: 'ndFilter', sceneSelect: 'scene', sceneSet: 'wbMode',
  savePset: 'store', recallPset: 'recall', recallModePset: 'presetScope', speedPset: 'presetSpeed', timePset: 'presetTime', modePset: 'presetSpeedMode',
  powerOff: 'power', powerOn: 'power', tallyOff: 'tallyRed', tallyOn: 'tallyRed', tally2Off: 'tallyGreen', tally2On: 'tallyGreen', insPosition: 'install', sdCardRec: 'sdRec',
  colorBarsOn: 'colorBars', colorBarsOff: 'colorBars', colorBarSetupsOn: 'colorBarsSetup', colorBarsSetupOff: 'colorBarsSetup', colorBarsTitleOn: 'colorBarsTitle', colorBarsTitleOff: 'colorBarsTitle',
  colorBarsTone: 'colorBarsTone', colorBarsType: 'colorBarsType',
};

// 0.11.0: the AW-UE150 profile is the default: a camera whose model is not known yet (never reached, or not read
// yet) gets the UE150 command set; a camera that reports a model gets that model's series ('Other' if unknown).
const DEFAULT_SERIES = 'UE150';
function seriesFor(model, override) {
  if (override && DATA.series[override]) return override;
  const m = String(model || '').toUpperCase();
  if (!m.trim()) return DEFAULT_SERIES;
  let best = null;
  for (const [id, sid] of DATA.models) if (id !== 'Auto' && m.startsWith(id.toUpperCase()) && (!best || id.length > best[0].length)) best = [id, sid];
  return best && DATA.series[best[1]] ? best[1] : 'Other';
}
const seriesSpec = (sid) => ({ id: sid, ...(DATA.series[sid] || DATA.series.Other) });

// What one camera offers: the catalog entries available on its series, with options / ranges resolved.
function catalogFor(sid) {
  const s = seriesSpec(sid);
  const ops = C.filter((o) => o.avail(s)).map((o) => ({ id: o.id, group: o.group, label: o.label, type: o.type, src: o.src, ref: o.ref,
    ...(o.options ? { options: o.options(s) } : {}), ...(o.range ? { range: o.range } : {}) }));
  const motion = MOTION.filter((m) => (m.spec ? spec(s) : s.caps[m.cap])).map(({ cap: _c, spec: _s, ...m }) => m);
  return { series: sid, ops: [...motion, ...ops] };
}
// The command string and path for one operation, or a 4xx error
function build(sid, id, value) {
  const s = seriesSpec(sid); const o = BY_ID.get(id);
  const bad = (m, status = 400) => Object.assign(new Error(m), { status });
  if (!o) throw bad(`Unknown camera command "${id}"`, 404);
  if (!o.avail(s)) throw bad(`${o.label}: not supported on the ${sid} series${o.src === 'spec' ? ' (UE150 / HE145 spec command)' : ''}`, 409);
  let v = value;
  if (o.type === 'toggle') v = value === true || value === 1 || value === '1' || value === 'on' || value === 'true';
  if (o.type === 'list') { v = String(value); if (!o.options(s).some(([k]) => k === v)) throw bad(`${o.label}: "${value}" is not one of ${o.options(s).map(([k]) => k).join(', ')}`); }
  if (o.type === 'range') {
    v = Number(value); const r = o.range;
    if (!Number.isFinite(v) || v < r.min || v > r.max) throw bad(`${o.label}: ${value} is outside ${r.min}..${r.max}`);
  }
  const path = typeof o.path === 'function' ? o.path(s) : o.path;
  return { path, cmd: o.cmd(v, s), value: v, key: o.key, op: o };
}
// Current UI values for one camera from its raw camdata map
function readback(sid, raw) {
  const s = seriesSpec(sid); const out = {};
  for (const o of C) {
    if (!o.key || !o.avail(s) || raw[o.key] === undefined) continue;
    try { out[o.id] = o.decode ? o.decode(raw[o.key]) : String(raw[o.key]).replace(/^0x/i, '').toUpperCase(); } catch { /* unreadable */ }
  }
  return out;
}

module.exports = { DEFAULT_SERIES, SHUTTER_STEPS, COMMANDS: C, MOTION, BY_ID, MODULE_ACTIONS, DATA, seriesFor, seriesSpec, catalogFor, build, readback, SPEC_SERIES, kneeEnc, kneeDec, H, hx };
