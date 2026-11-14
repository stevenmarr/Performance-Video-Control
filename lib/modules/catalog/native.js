'use strict';
// Button, variable and feedback catalogs for the systems Control Center already
// drives. The commands are the ones lib/systems.js and the core console already
// accept. Nothing here opens a second connection.

const PTZ = require('../../drivers/ptz-commands');
const { defineSystem } = require('../framework');

const docs = (url, title, note = '') => ({ url, title, basis: 'official', note });
const v = (id, label) => ({ id, label });
const fb = (id, label, style, extra = {}) => ({ id, label, variable: extra.variable || id, op: extra.op || 'eq', value: extra.value == null ? 'true' : extra.value, style });
const onAir = { bgcolor: '#C42020', color: '#FFFFFF', bar: '#C42020' };
const previewOn = { bgcolor: '#148F46', color: '#FFFFFF', bar: '#3DDC84' };
const hotRun = { bgcolor: '#E85A5A', color: '#FFFFFF' };
const connected = fb('connected', 'Link is up', { border: '#3DDC84' });

function native(row) {
  return defineSystem({ ...row, transport: 'native' });
}

function acts(list) {
  return list.map(([id, label, role, extra]) => ({
    id, label, role: role || 'toggle', text: (extra && extra.text) || label,
    confirm: !!(extra && extra.confirm), confirmMode: (extra && extra.confirmMode) || '',
    element: extra && extra.element, event: extra && extra.event, caption: extra && extra.caption,
    options: (extra && extra.options) || [],
    native: { command: (extra && extra.command) || id, defaults: (extra && extra.defaults) || null },
    description: (extra && extra.description) || label,
  }));
}

const num = (id, label, def) => ({ id, type: 'number', label, default: def });
const str = (id, label, def = '') => ({ id, type: 'string', label, default: def });

const atemActions = acts([
  ['cut', 'Cut', 'hot', { text: 'CUT' }],
  ['auto', 'Auto transition', 'hot', { text: 'TRANS' }],
  ['program', 'Program source', 'program', { options: [num('source', 'Source', 1), num('me', 'M/E', 1)] }],
  ['preview', 'Preview source', 'preview', { options: [num('source', 'Source', 1), num('me', 'M/E', 1)] }],
  ['ftb', 'Fade to black', 'hot', { text: 'FTB', confirm: true }],
  ['style', 'Transition style', 'toggle', { options: [str('style', 'Style', 'mix'), num('me', 'M/E', 1)] }],
  ['mixRate', 'Mix rate', 'toggle', { options: [num('rate', 'Frames', 30), num('me', 'M/E', 1)], element: 'encoder', event: 'turn' }],
  ['transitionPosition', 'T-bar', 'toggle', { options: [num('position', 'Position', 0), num('me', 'M/E', 1)], element: 'encoder', event: 'turn' }],
  ['wipePattern', 'Wipe pattern', 'toggle', { options: [num('pattern', 'Pattern', 0), num('me', 'M/E', 1)] }],
  ['ftbRate', 'Fade to black rate', 'toggle', { options: [num('rate', 'Frames', 30)] }],
  ['nextSelection', 'Next transition', 'toggle', { options: [str('selection', 'Selection', 'background')] }],
  ['uskOnAir', 'Upstream key on air', 'program', { text: 'KEY', options: [num('key', 'Key', 0), num('me', 'M/E', 1)] }],
  ['uskTie', 'Upstream key tie', 'preview', { text: 'TIE', options: [num('key', 'Key', 0)] }],
  ['dskOnAir', 'Downstream key on air', 'program', { text: 'DSK', options: [num('key', 'Key', 0)] }],
  ['dskTie', 'Downstream key tie', 'preview', { options: [num('key', 'Key', 0)] }],
  ['dskAuto', 'Downstream key auto', 'hot', { text: 'DSK\nAUTO', options: [num('key', 'Key', 0)] }],
  ['aux', 'Aux source', 'toggle', { options: [num('aux', 'Aux', 0), num('source', 'Source', 1)] }],
  ['route', 'Route output', 'toggle', { options: [str('output', 'Output', '1'), num('source', 'Source', 1)] }],
  ['macroRun', 'Run macro', 'macro', { options: [num('macro', 'Macro', 0)] }],
  ['macroStop', 'Stop macro', 'macro', { text: 'STOP' }],
  ['macroRecord', 'Record macro', 'macro', { confirm: true, options: [num('macro', 'Macro', 0)] }],
  ['macroStopRecord', 'Stop macro record', 'macro'],
  ['macroContinue', 'Continue macro', 'macro'],
  ['macroUserWait', 'Macro user wait', 'macro'],
  ['audioMute', 'Audio mute', 'toggle', { options: [num('input', 'Input', 1)] }],
  ['audioMuteAll', 'Mute all audio', 'toggle', { confirm: true, text: 'MUTE\nALL' }],
  ['audioDeskZero', 'Desk zero', 'hot', { confirm: true, confirmMode: 'body', text: 'DESK\nZERO', defaults: {} }],
  ['audioSolo', 'Audio solo', 'toggle', { options: [num('input', 'Input', 1)] }],
  ['mvSource', 'Multiview window', 'toggle', { options: [num('mv', 'Multiview', 0), num('window', 'Window', 0), num('source', 'Source', 1)] }],
  ['ssLayoutRecall', 'SuperSource layout', 'memory', { options: [str('layout', 'Layout', 'quad')] }],
  ['layoutRecall', 'Recall layout', 'memory', { options: [str('preset', 'Layout', '')] }],
  ['mvSalvoRecall', 'Multiview salvo', 'memory', { options: [str('salvo', 'Salvo', '')] }],
]);

const PTZ_DIRECT = {
  move: { label: 'Pan / tilt', role: 'toggle', options: [num('pan', 'Pan', 0), num('tilt', 'Tilt', 0)] },
  zoom: { label: 'Zoom', role: 'toggle', options: [num('dir', 'Direction', 0)], element: 'encoder', event: 'turn' },
  focus: { label: 'Focus', role: 'toggle', options: [num('dir', 'Direction', 0)], element: 'encoder', event: 'turn' },
  stop: { label: 'Stop move', role: 'toggle', text: 'STOP' },
  stopAll: { label: 'All stop', role: 'hot', text: 'ALL\nSTOP', confirm: true },
  home: { label: 'Home', role: 'toggle' },
  recall: { label: 'Recall preset', role: 'memory', options: [num('preset', 'Preset', 1)] },
  store: { label: 'Store preset', role: 'memory', confirm: true, options: [num('preset', 'Preset', 1)] },
  iris: { label: 'Iris', role: 'toggle', options: [str('value', 'Value', '')], element: 'encoder', event: 'turn' },
  gain: { label: 'Gain', role: 'toggle', options: [str('value', 'Value', '')] },
  shutter: { label: 'Shutter', role: 'toggle', options: [str('value', 'Value', '')] },
  power: { label: 'Power', role: 'toggle', confirm: true, options: [{ id: 'on', type: 'boolean', label: 'On', default: true }] },
  select: { label: 'Select camera', role: 'info', options: [str('cam', 'Camera', '')] },
  speeds: { label: 'Speeds', role: 'toggle', options: [num('pt', 'Pan/tilt', 25), num('zoom', 'Zoom', 25), num('focus', 'Focus', 15)] },
  oneTouchAF: { label: 'One-touch AF', role: 'toggle', text: 'OTAF' },
  lock: { label: 'Paint lock', role: 'toggle', text: 'LOCK' },
  refresh: { label: 'Refresh camera', role: 'nav', text: 'READ' },
};

function ptzActions() {
  const out = [];
  const seen = new Set();
  for (const [id, spec] of Object.entries(PTZ_DIRECT)) {
    seen.add(id);
    out.push({
      id, label: spec.label, role: spec.role, text: spec.text || spec.label, confirm: !!spec.confirm,
      element: spec.element, event: spec.event, options: spec.options || [],
      native: { command: id, defaults: spec.defaults || null },
      description: spec.label,
    });
  }
  const rows = [...PTZ.MOTION, ...PTZ.COMMANDS];
  for (const row of rows) {
    if (!row || !row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push({
      id: row.id, label: row.label || row.id, role: 'toggle', text: row.label || row.id,
      description: row.label || row.id,
      native: { command: 'op', defaults: { op: row.id } },
    });
  }
  return out;
}

const pixera = acts([
  ['play', 'Play', 'toggle', { text: 'PLAY', command: 'transport', defaults: { mode: 'play' } }],
  ['pause', 'Pause', 'toggle', { text: 'PAUSE', command: 'transport', defaults: { mode: 'pause' } }],
  ['stop', 'Stop', 'toggle', { text: 'STOP', command: 'transport', defaults: { mode: 'stop' } }],
  ['nextCue', 'Next cue', 'memory', { text: 'NEXT' }],
  ['prevCue', 'Previous cue', 'memory', { text: 'PREV' }],
  ['applyCue', 'Apply cue', 'memory', { options: [str('timeline', 'Timeline', ''), str('cue', 'Cue', '')] }],
  ['select', 'Select timeline', 'info', { options: [num('handle', 'Handle', 0)] }],
  ['refresh', 'Refresh timelines', 'nav', { text: 'READ' }],
]);

const millumin = acts([
  ['launchColumn', 'Launch column', 'toggle', { options: [str('value', 'Column', '1')] }],
  ['launchOrStopColumn', 'Launch or stop column', 'toggle', { options: [str('value', 'Column', '1')] }],
  ['stopColumn', 'Stop column', 'toggle', { text: 'STOP' }],
  ['nextColumn', 'Next column', 'toggle', { text: 'NEXT' }],
  ['previousColumn', 'Previous column', 'toggle', { text: 'PREV' }],
  ['play', 'Play', 'toggle', { text: 'PLAY' }],
  ['pause', 'Pause', 'toggle', { text: 'PAUSE' }],
  ['playOrPause', 'Play or pause', 'toggle'],
  ['goToTime', 'Go to time', 'toggle', { options: [str('value', 'Time', '0')] }],
  ['selectLayer', 'Select layer', 'info', { options: [str('value', 'Layer', '1')] }],
  ['opacity', 'Layer opacity', 'toggle', { options: [num('value', 'Opacity', 1)], element: 'encoder', event: 'turn' }],
  ['enterFullscreen', 'Enter fullscreen', 'toggle'],
  ['exitFullscreen', 'Exit fullscreen', 'toggle'],
]);

const hyperdeck = acts([
  ['record', 'Record', 'program', { text: 'REC', confirm: true }],
  ['play', 'Play', 'toggle', { text: 'PLAY' }],
  ['stop', 'Stop', 'toggle', { text: 'STOP' }],
  ['preview', 'Preview enable', 'preview', { text: 'PVW' }],
  ['previewOff', 'Preview disable', 'preview', { text: 'PVW\nOFF' }],
  ['goto', 'Go to clip', 'memory', { options: [num('clip', 'Clip', 1)] }],
  ['slot', 'Select slot', 'toggle', { options: [num('slot', 'Slot', 1)] }],
  ['speed', 'Play speed', 'toggle', { options: [num('speed', 'Speed', 100)], element: 'encoder', event: 'turn' }],
  ['clips', 'Read clips', 'nav', { text: 'CLIPS' }],
]);

const mitti = acts([
  ['play', 'Play', 'toggle', { text: 'PLAY' }],
  ['pause', 'Pause', 'toggle', { text: 'PAUSE' }],
  ['stop', 'Stop', 'toggle', { text: 'STOP' }],
  ['toggle', 'Play or pause', 'toggle'],
  ['next', 'Next cue', 'memory', { text: 'NEXT' }],
  ['prev', 'Previous cue', 'memory', { text: 'PREV' }],
  ['cue', 'Cue by index', 'memory', { options: [num('value', 'Index', 1)] }],
  ['cueName', 'Cue by name', 'memory', { options: [str('value', 'Name', '')] }],
]);

const preset = (id, label, short, companion, url, title) => native({
  id, label, short, category: 'switcher', manufacturer: label.split(' ')[0], bar: id === 'e2' ? '#E0B030' : '#7A5AF8',
  nativeId: id, companion, status: 'implemented',
  summary: 'Presets to preview, then take or cut. The existing driver sends the command.',
  docs: docs(url, title),
  connection: { fields: [] },
  variables: [v('connected', 'Connected'), v('preset', 'Last preset'), v('preview', 'Preview preset'), v('program', 'Program preset')],
  feedbacks: [connected, fb('preview', 'Preset on preview', previewOn, { variable: 'preview', op: 'truthy', value: 'true' }), fb('program', 'Preset on program', onAir, { variable: 'program', op: 'truthy' })],
  actions: acts([
    ['recall', 'Recall to preview', 'preview', { options: [str('preset', 'Preset', '')] }],
    ['take', 'Take', 'hot', { text: 'TAKE' }],
    ['cut', 'Cut', 'hot', { text: 'CUT' }],
  ]),
});

const consoleActions = [
  ['focus', 'Focus system', 'nav'],
  ['focus.next', 'Focus next', 'nav', { text: 'NEXT' }],
  ['profile.load', 'Load profile', 'nav'],
  ['profile.save', 'Save profile', 'nav'],
  ['show.save', 'Save show', 'nav', { text: 'SAVE' }],
  ['show.stage', 'Stage show', 'nav'],
  ['show.load', 'Load show', 'nav', { text: 'LOAD', confirm: true }],
  ['connection.reconnect', 'Reconnect', 'nav', { text: 'RELINK' }],
  ['connection.disconnect', 'Disconnect', 'nav', { confirm: true }],
  ['module.enable', 'Enable module', 'nav'],
  ['module.restart', 'Restart module', 'nav'],
  ['health.ack', 'Ack health', 'nav', { text: 'ACK' }],
  ['service.refresh', 'Refresh services', 'nav'],
  ['service.enable', 'Enable service', 'nav'],
  ['host.shutdown', 'Shut down', 'nav', { text: 'SHUTDN', confirm: true }],
  ['host.reboot', 'Reboot', 'nav', { text: 'REBOOT', confirm: true }],
  ['host.cancel', 'Cancel power', 'nav', { text: 'CANCEL' }],
  ['panel.lock', 'Lock panel', 'nav', { text: 'LOCK' }],
  ['panel.unlock', 'Unlock panel', 'nav', { text: 'UNLOCK' }],
  ['panel.safe', 'Safe mode', 'nav', { text: 'SAFE' }],
  ['panel.pin', 'Set PIN', 'nav'],
].map(([id, label, role, extra]) => ({
  id, label, role, text: (extra && extra.text) || label, confirm: !!(extra && extra.confirm),
  description: label, native: { command: id },
}));

const systems = [
  native({
    id: 'rs6', label: 'Analog Way Aquilon RS6', short: 'RS6', category: 'switcher', manufacturer: 'Analog Way', bar: '#E0B030',
    nativeId: 'rs6', companion: ['analogway-livepremier', 'analogway-awj'], status: 'implemented',
    summary: 'Presets, take and cut through the existing AWJ / REST engine.',
    docs: docs('https://www.analogway.com/americas/products/aquilon-rs6/', 'Analog Way LivePremier / AWJ', 'Aquilon is controlled with Analog Way JSON (AWJ). LivePremier uses the same family. This desk already speaks it.'),
    connection: { fields: [] },
    variables: [v('connected', 'Connected'), v('preview', 'Preview'), v('program', 'Program')],
    feedbacks: [connected, fb('preview', 'Preview tally', previewOn, { variable: 'preview', op: 'truthy' }), fb('program', 'Program tally', onAir, { variable: 'program', op: 'truthy' })],
    actions: acts([['recall', 'Recall preset', 'preview', { options: [num('preset', 'Preset', 1)] }], ['take', 'Take', 'hot', { text: 'TAKE' }], ['cut', 'Cut', 'hot', { text: 'CUT' }]]),
  }),
  preset('e2', 'Barco Event Master', 'E2', ['barco-eventmaster', 'barco-eventmaster-xml'], 'https://www.barco.com/en/support', 'Event Master JSON-RPC API'),
  preset('pixelhue', 'PixelHue', 'PixelHue', ['pixelhue-switcher', 'pixelhue-liveproductionswitcher'], 'https://www.pixelhue.com/', 'PixelHue switcher HTTP API'),
  native({
    id: 'atem', label: 'Blackmagic ATEM', short: 'ATEM', category: 'switcher', manufacturer: 'Blackmagic Design', bar: '#FF6A00',
    nativeId: 'atem', companion: ['bmd-atem'], status: 'implemented',
    summary: 'Program, preview, transition, keys, audio, macros and routing. The native UDP driver sends them.',
    docs: docs('https://www.blackmagicdesign.com/developer', 'ATEM Switchers SDK', 'The public interface is the ATEM Switchers SDK. This desk speaks that switcher protocol over UDP 9910. The SDK manual is the authority; the wire layout ships in the SDK headers.'),
    connection: { fields: [] },
    variables: [v('connected', 'Connected'), v('program', 'Program source'), v('preview', 'Preview source'), v('transition', 'Transition running'), v('ftb', 'Fade to black')],
    feedbacks: [
      connected,
      fb('program', 'Source is on program', onAir, { variable: 'program' }),
      fb('preview', 'Source is on preview', previewOn, { variable: 'preview' }),
      fb('transition', 'Transition running', hotRun, { variable: 'transition' }),
    ],
    actions: atemActions,
  }),
  native({
    id: 'ptz', label: 'Panasonic PTZ', short: 'PTZ', category: 'camera', manufacturer: 'Panasonic', bar: '#3DDC84',
    nativeId: 'ptz', companion: ['panasonic-ptz'], status: 'implemented',
    summary: 'Every Panasonic CGI command the camera catalog already builds, as a button.',
    docs: docs('https://eww.pass.panasonic.co.jp/pro-av/support/content/guide/DEF/AW-UE150/HD/HD_OperationManual_English.pdf', 'Panasonic AW-UE150 interface / HTTP CGI', 'Commands follow the AW-UE150 / AW-HE interface specifications. The app catalog in lib/drivers/ptz-commands.js is that set. See docs/ptz-commands.md.'),
    connection: { fields: [] },
    variables: [v('connected', 'Connected'), v('tally', 'Red tally'), v('power', 'Power'), v('selected', 'Selected camera'), v('iris', 'Iris'), v('gain', 'Gain')],
    feedbacks: [connected, fb('tally', 'Camera on program', onAir, { variable: 'tally' }), fb('power', 'Power on', { border: '#3DDC84' }, { variable: 'power' })],
    actions: ptzActions(),
  }),
  native({
    id: 'pixera', label: 'AV Stumpfl Pixera', short: 'Pixera', category: 'playback', manufacturer: 'AV Stumpfl', bar: '#4CC9F0',
    nativeId: 'pixera', companion: ['avstumpfl-pixera'], status: 'implemented',
    summary: 'Timeline transport and cues over Pixera JSON-RPC.',
    docs: docs('https://help.pixera.one/api/', 'Pixera API (JSON-RPC)', 'The driver frames JSON-RPC 2.0 the way Pixera\'s API describes: magic pxr1, then the JSON body, on the API port (default 1400).'),
    connection: { fields: [] },
    variables: [v('connected', 'Connected'), v('transport', 'Transport'), v('cue', 'Cue'), v('timeline', 'Timeline')],
    feedbacks: [connected, fb('playing', 'Playing', { border: '#3B8CFF' }, { variable: 'transport', value: 'play' }), fb('cue', 'Cue armed', { border: '#A03A8C' }, { variable: 'cue', op: 'truthy' })],
    actions: pixera,
  }),
  native({
    id: 'millumin', label: 'Millumin', short: 'Millumin', category: 'playback', manufacturer: 'Anomes', bar: '#9B5DE5',
    nativeId: 'millumin', companion: ['anomes-millumin'], status: 'implemented',
    summary: 'Columns, transport and the selected layer over Millumin OSC.',
    docs: docs('https://www.millumin.com/documentation/', 'Millumin OSC API', 'Millumin publishes its OSC addresses under Interactions. The driver sends those addresses. There is no separate HTTP API.'),
    connection: { fields: [] },
    variables: [v('connected', 'Connected'), v('column', 'Column'), v('running', 'Running')],
    feedbacks: [connected, fb('running', 'Column running', { border: '#3B8CFF' }, { variable: 'running' })],
    actions: millumin,
  }),
  native({
    id: 'videohub', label: 'Blackmagic Videohub', short: 'Videohub', category: 'router', manufacturer: 'Blackmagic Design', bar: '#FF8C42',
    nativeId: 'videohub', companion: ['bmd-videohub'], status: 'implemented',
    summary: 'A crosspoint is one button. Labels and the current route are variables.',
    docs: docs('https://documents.blackmagicdesign.com/DeveloperManuals/VideohubDeveloperInformation.pdf', 'Videohub Developer Information', 'TCP 9990 text blocks. VIDEO OUTPUT ROUTING sets a crosspoint. Output and input numbers are 0-based, as the protocol numbers them.'),
    connection: { fields: [] },
    variables: [v('connected', 'Connected'), v('model', 'Model'), v('lastOutput', 'Last output'), v('lastInput', 'Last input')],
    feedbacks: [connected, fb('routed', 'Last route matches', { border: '#3B8CFF' }, { variable: 'lastOutput', op: 'truthy' })],
    actions: acts([['crosspoint', 'Crosspoint', 'toggle', { text: 'XPT', options: [num('output', 'Output', 0), num('input', 'Input', 0)] }]]),
  }),
  native({
    id: 'hyperdeck', label: 'Blackmagic HyperDeck', short: 'HyperDeck', category: 'playback', manufacturer: 'Blackmagic Design', bar: '#E85D4C',
    nativeId: 'hyperdeck', companion: ['bmd-hyperdeck'], status: 'implemented',
    summary: 'Record, play, stop, preview, clip and slot, from the Ethernet protocol.',
    docs: docs('https://documents.blackmagicdesign.com/DeveloperManuals/HyperDeckEthernetProtocol.pdf', 'HyperDeck Ethernet Protocol', 'TCP 9993, one command per line. Record is styled as on-air because it puts the deck into record.'),
    connection: { fields: [] },
    variables: [v('connected', 'Connected'), v('transport', 'Transport'), v('timecode', 'Timecode'), v('slot', 'Slot'), v('clip', 'Clip')],
    feedbacks: [connected, fb('record', 'Recording', onAir, { variable: 'transport', value: 'record' }), fb('play', 'Playing', { border: '#3B8CFF' }, { variable: 'transport', value: 'play' })],
    actions: hyperdeck,
  }),
  native({
    id: 'mitti', label: 'Mitti', short: 'Mitti', category: 'playback', manufacturer: 'Imimot', bar: '#F15BB5',
    nativeId: 'mitti', companion: ['imimot-mitti'], status: 'implemented',
    summary: 'Play, pause, stop and cues over the OSC addresses Mitti lists in its settings.',
    docs: docs('https://imimot.com/mitti/', 'Mitti OSC', 'Mitti lists the addresses under Settings, OSC. The driver sends /mitti/play, /mitti/stop, /mitti/pause, /mitti/togglePlay, /mitti/cue and /mitti/gotoCueByName.'),
    connection: { fields: [] },
    variables: [v('connected', 'Connected'), v('transport', 'Transport'), v('cue', 'Cue')],
    feedbacks: [connected, fb('playing', 'Playing', { border: '#3B8CFF' }, { variable: 'transport', value: 'play' }), fb('cue', 'Cue', { border: '#A03A8C' }, { variable: 'cue', op: 'truthy' })],
    actions: mitti,
  }),
  native({
    id: 'tsl', label: 'TSL tally', short: 'TSL', category: 'tally', manufacturer: 'TSL', bar: '#C42020',
    nativeId: '', companion: ['tslproducts-umd'], status: 'implemented',
    summary: 'TSL 5.0 UDP tally. The buttons read status and send one tally tick. The map stays on the SYSTEMS card.',
    docs: docs('https://tslproducts.com/', 'TSL UMD protocol 5.0', 'Display control bits are the TSL 5.0 tally colours: off, red, green, amber. See docs/tsl-tally.md.'),
    connection: { fields: [] },
    variables: [v('enabled', 'Enabled'), v('lastSend', 'Last send'), v('destinations', 'Destinations')],
    feedbacks: [fb('enabled', 'Tally output on', { border: '#3DDC84' }), fb('lastSend', 'A packet was sent', { border: '#5B7C99' }, { variable: 'lastSend', op: 'truthy' })],
    actions: [
      { id: 'tick', label: 'Send tally', role: 'program', text: 'TALLY', description: 'Send one TSL tick', fixedRequest: { method: 'POST', path: '/api/tsl/tick', body: {} } },
      { id: 'status', label: 'Read tally status', role: 'nav', text: 'READ', description: 'Read the TSL service', fixedRequest: { method: 'GET', path: '/api/tsl', body: {} } },
    ],
  }),
  native({
    id: 'scopes', label: 'Scopes', short: 'Scopes', category: 'engineering', manufacturer: 'Control Center', bar: '#5B7C99',
    nativeId: '', companion: [], status: 'implemented',
    summary: 'Waveform, parade, vectorscope and Lightning. Buttons read the scopes service. The picture stays on the SCOPES tab.',
    docs: docs('https://www.blackmagicdesign.com/developer', 'Desktop Video / DeckLink', 'Live video is a Desktop Video input. The buttons call the scopes service that is already in this app. See docs/scopes.md.'),
    connection: { fields: [] },
    variables: [v('sources', 'Source count'), v('relays', 'Relays')],
    feedbacks: [fb('sources', 'A source is available', { border: '#3DDC84' }, { variable: 'sources', op: 'gt', value: '0' })],
    actions: [
      { id: 'sources', label: 'Read sources', role: 'nav', text: 'SOURCES', description: 'List scope sources', fixedRequest: { method: 'GET', path: '/api/scopes/sources', body: {} } },
      { id: 'status', label: 'Read status', role: 'info', text: 'STATUS', description: 'Relay status', fixedRequest: { method: 'GET', path: '/api/scopes/status', body: {} } },
    ],
  }),
  native({
    id: 'console', label: 'Control Center', short: 'OS', category: 'os', manufacturer: 'Control Center', bar: '#8EA0B5',
    nativeId: 'console', companion: [], status: 'implemented',
    summary: 'Show, connection, health and guarded power. Slate keys with an inner frame. Shutdown and reboot stay confirmed.',
    docs: docs('', 'Control Center console', 'These keys call the core console that already runs the desk.'),
    connection: { fields: [] },
    variables: [v('health.ok', 'Health'), v('show.name', 'Show'), v('panel.locked', 'Panel locked'), v('host.pending', 'Power pending')],
    feedbacks: [
      fb('health.ok', 'Health is ok', { border: '#3DDC84' }, { variable: 'health.ok' }),
      fb('panel.locked', 'Panel locked', { border: '#E0B030' }, { variable: 'panel.locked' }),
      fb('host.pending', 'Power is pending', { border: '#E0B030' }, { variable: 'host.pending' }),
    ],
    actions: consoleActions,
  }),
];

module.exports = { systems };
