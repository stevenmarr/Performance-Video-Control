'use strict';
// Cameras, switchers and playback whose published command was checked
// after the processor pass.

const { defineSystem } = require('../framework');

const docs = (url, title, note = '') => ({ url, title, basis: 'official', note });
const v = (id, label) => ({ id, label });
const fb = (id, label, style, extra = {}) => ({ id, label, variable: extra.variable || id, op: extra.op || 'eq', value: extra.value == null ? 'true' : extra.value, style });
const num = (id, label, def) => ({ id, type: 'number', label, default: def });
const str = (id, label, def = '') => ({ id, type: 'string', label, default: def });
const hostPort = (port, extra = []) => ({ fields: [{ id: 'host', type: 'string', label: 'Host', default: '' }, { id: 'port', type: 'number', label: 'Port', default: port }, ...extra] });

function act(id, label, role, execute, extra = {}) {
  return {
    id, label, role, text: extra.text || label, description: extra.description || label,
    confirm: !!extra.confirm, element: extra.element, event: extra.event,
    options: extra.options || [], execute,
  };
}
function line(id, label, role, payload, extra = {}) {
  return act(id, label, role, { type: 'line', payload }, extra);
}

const systems = [
  defineSystem({
    id: 'canon-xc', label: 'Canon XC', short: 'Canon', category: 'camera', manufacturer: 'Canon', bar: '#E85D4C',
    status: 'implemented', transport: 'http', companion: ['canon-ptz'],
    summary: 'Recall a saved preset and stop a preset move. Sessionless control.cgi.',
    docs: docs('https://output.nl/u/images/canon-xc-control-protocol-specifications-005.pdf', 'Canon XC Control Protocol BPE-7216-005', 'GET /-wvhttp-01-/control.cgi?p=1 recalls preset 1. p.action=stop stops a running preset. The session parameter is optional for sessionless control. Canon publishes the XC protocol for CR-N and supported Cinema EOS cameras. The controller and XF modules are not this camera command.'),
    connection: hostPort(80),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered', { border: '#3DDC84' })],
    actions: [
      act('preset', 'Recall preset', 'memory', { type: 'http', method: 'GET', path: '/-wvhttp-01-/control.cgi?p=$(options:preset)' }, { text: 'PRE', options: [num('preset', 'Preset 1-100', 1)] }),
      act('stop', 'Stop preset', 'toggle', { type: 'http', method: 'GET', path: '/-wvhttp-01-/control.cgi?p.action=stop' }, { text: 'STOP' }),
    ],
  }),
  defineSystem({
    id: 'roland-v60hd', label: 'Roland V-60HD', short: 'V-60HD', category: 'switcher', manufacturer: 'Roland', bar: '#F4A261',
    status: 'implemented', transport: 'tcp', companion: ['roland-v60hd'],
    summary: 'Program, preset, cut and auto. Input numbers in the manual start at 0 for SDI 1.',
    docs: docs('https://static.roland.com/assets/media/pdf/V-60HD_reference_v31_eng04_W.pdf', 'Roland V-60HD Reference', 'TCP 8023. A command is STX, a three-letter code, parameters, and a semicolon. stxPGM:0; selects SDI IN 1 on program. stxPST:0; selects the preset bus. stxCUT; and stxATO; press cut and auto. The switcher answers ACK (06h). Other Roland models are not this command table.'),
    connection: hostPort(8023),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', { border: '#3DDC84' })],
    actions: [
      line('program', 'Program', 'program', '\x02PGM:$(options:input);', { text: 'PGM', options: [num('input', '0 = SDI 1', 0)] }),
      line('preset', 'Preset bus', 'preview', '\x02PST:$(options:input);', { text: 'PST', options: [num('input', '0 = SDI 1', 0)] }),
      line('cut', 'Cut', 'program', '\x02CUT;', { text: 'CUT', confirm: true }),
      line('auto', 'Auto transition', 'toggle', '\x02ATO;', { text: 'AUTO' }),
    ],
  }),
  defineSystem({
    id: 'dataton-watchout', label: 'Dataton WATCHOUT', short: 'WATCHOUT', category: 'playback', manufacturer: 'Dataton', bar: '#90BE6D',
    status: 'implemented', transport: 'tcp', companion: ['dataton-watchout'],
    summary: 'Run, halt, jump to a cue and reset. A cue name with a space needs quotes in the field.',
    docs: docs('https://docs.dataton.com/guide/watchout/external-control/watchout-6-protocol.html', 'WATCHOUT 6 external protocol', 'TCP 3039, the WATCHPOINT port in the WATCHOUT 7 guide. 3040 is the WATCHMAKER port and uses the same commands. Lines end with CR LF. run and halt with no name control Main Timeline. gotoControlCue Cue1 jumps to that cue. reset stops auxiliary timelines and parks the main timeline. The JSON and director-control modules are not this text protocol.'),
    connection: hostPort(3039, [str('delimiter', 'Delimiter', '\\r\\n')]),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', { border: '#3DDC84' })],
    actions: [
      line('run', 'Run', 'toggle', 'run\r\n', { text: 'RUN' }),
      line('halt', 'Halt', 'toggle', 'halt\r\n', { text: 'HALT' }),
      line('cue', 'Go to cue', 'memory', 'gotoControlCue $(options:cue)\r\n', { text: 'CUE', options: [str('cue', 'Cue', 'Cue1')] }),
      line('time', 'Go to time', 'toggle', 'gotoTime $(options:time)\r\n', { options: [str('time', 'Time', '0')] }),
      line('reset', 'Reset', 'toggle', 'reset\r\n', { text: 'RESET', confirm: true }),
    ],
  }),
  defineSystem({
    id: 'roland-basic', label: 'Roland basic LAN', short: 'Roland', category: 'switcher', manufacturer: 'Roland', bar: '#F4A261',
    status: 'implemented', transport: 'tcp', companion: ['roland-v160hd', 'roland-v80hd', 'roland-vr120hd', 'roland-v1-4k'],
    summary: 'Program, preset and cut by channel name. The V-60HD command table is a different system.',
    docs: docs('https://static.roland.com/assets/media/pdf/LAN_RS-232_Basic_Control_Commands_eng02_W.pdf', 'Roland LAN/RS-232 basic control commands', 'The basic command set covers V-160HD, V-80HD, VR-120HD, VR-6HD and V-1-4K. PGM:INPUT2; selects program. PST:INPUT1; selects preset. CUT; cuts. The V-160HD LAN port is TCP 8023, and LAN may omit the STX byte. A V-160HD needs the four-character network password configured on the unit. Channel names differ by model. XS, V-1200HD, V-600UHD and the audio products are not this table.'),
    connection: hostPort(8023, [str('delimiter', 'Delimiter', '\\n')]),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', { border: '#3DDC84' })],
    actions: [
      line('program', 'Program', 'program', 'PGM:$(options:channel);', { text: 'PGM', options: [str('channel', 'Channel', 'INPUT1')] }),
      line('preset', 'Preset', 'preview', 'PST:$(options:channel);', { text: 'PST', options: [str('channel', 'Channel', 'INPUT1')] }),
      line('cut', 'Cut', 'program', 'CUT;', { text: 'CUT', confirm: true }),
      line('auto', 'Auto', 'toggle', 'ATO;', { text: 'AUTO' }),
    ],
  }),
];

module.exports = { systems };
