'use strict';
// Live-event playback, routing and monitors. Commands are the ones the
// manufacturer documents. Companion ids are only so the coverage list can match.

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
function kipro(value, label, role, extra = {}) {
  return act(idOf(label), label, role, {
    type: 'http', method: 'GET',
    path: `/config?action=set&paramid=eParamID_TransportCommand&value=${value}`,
  }, extra);
}
function helo(param, value, label, role, extra = {}) {
  return act(idOf(label), label, role, {
    type: 'http', method: 'GET',
    path: `/config?action=set&paramid=${param}&value=${value}`,
  }, extra);
}
function idOf(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24);
}

const systems = [
  defineSystem({
    id: 'aja-kipro', label: 'AJA Ki Pro', short: 'Ki Pro', category: 'playback', manufacturer: 'AJA', bar: '#E85D4C',
    status: 'implemented', transport: 'http', companion: ['aja-kipro'],
    summary: 'Record, play, stop and clip step through the AJA REST parameter eParamID_TransportCommand.',
    docs: docs('https://www.aja.com/support/item/4184', 'AJA REST API Developer Guide', 'GET /config?action=set&paramid=eParamID_TransportCommand. The guide\'s transport enum is 1 play, 3 record, 4 stop, 9 next clip, 10 previous clip. The first stop pauses and the second stop idles. Ki Pro Ultra, Ultra Plus, Ultra 12G, GO and Rack use this parameter where the guide lists it.'),
    connection: hostPort(80),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered', { border: '#3DDC84' })],
    actions: [
      kipro(3, 'Record', 'program', { text: 'REC', confirm: true }),
      kipro(1, 'Play', 'toggle', { text: 'PLAY' }),
      kipro(4, 'Stop', 'toggle', { text: 'STOP' }),
      kipro(9, 'Next clip', 'memory', { text: 'NEXT' }),
      kipro(10, 'Previous clip', 'memory', { text: 'PREV' }),
    ],
  }),
  defineSystem({
    id: 'aja-kumo', label: 'AJA KUMO', short: 'KUMO', category: 'router', manufacturer: 'AJA', bar: '#F4A261',
    status: 'implemented', transport: 'http', companion: ['aja-kumo'],
    summary: 'Take a crosspoint or a salvo. Destination and source numbers start at 1.',
    docs: docs('https://www.aja.com/support/item/9616', 'AJA KUMO REST automation', 'GET /config?action=set&configid=0&paramid=eParamID_XPT_Destination<N>_Status&value=<source>. Salvos use eParamID_TakeSalvo. Numbers start at 1, up to the router size (16, 32 or 64).'),
    connection: hostPort(80),
    variables: [v('connected', 'Connected'), v('destination', 'Last destination'), v('source', 'Last source')],
    feedbacks: [fb('connected', 'Answered', { border: '#3DDC84' })],
    actions: [
      act('crosspoint', 'Crosspoint', 'toggle', {
        type: 'http', method: 'GET',
        path: '/config?action=set&configid=0&paramid=eParamID_XPT_Destination$(options:destination)_Status&value=$(options:source)',
      }, { text: 'XPT', options: [num('destination', 'Destination', 1), num('source', 'Source', 1)] }),
      act('salvo', 'Take salvo', 'memory', {
        type: 'http', method: 'GET',
        path: '/config?action=set&configid=0&paramid=eParamID_TakeSalvo&value=$(options:salvo)',
      }, { confirm: true, options: [num('salvo', 'Salvo', 1)] }),
    ],
  }),
  defineSystem({
    id: 'bmd-smartview', label: 'Blackmagic SmartView', short: 'SmartView', category: 'monitor', manufacturer: 'Blackmagic Design', bar: '#5B7C99',
    status: 'implemented', transport: 'tcp', companion: ['bmd-smartview'],
    summary: 'Brightness, identify and widescreen for one LCD. TCP blocks, the same shape as Videohub.',
    docs: docs('https://documents.blackmagicdesign.com/UserManuals/SmartViewManual.pdf', 'SmartView Ethernet Protocol', 'TCP 9992. A block is a header, lines, and a blank line. MONITOR A:\\nBrightness: 127\\n\\n is the manual\'s brightness example. Identify: true draws the white border for 15 seconds. Values are 0–255.'),
    connection: hostPort(9992, [str('delimiter', 'Delimiter', '\\n\\n')]),
    variables: [v('connected', 'Connected'), v('model', 'Model'), v('brightness', 'Brightness')],
    feedbacks: [fb('connected', 'Connected', { border: '#3DDC84' })],
    actions: [
      line('brightness', 'Brightness', 'toggle', 'MONITOR $(options:monitor):\nBrightness: $(options:value)\n\n', { options: [str('monitor', 'Monitor', 'A'), num('value', '0-255', 127)], element: 'encoder', event: 'turn' }),
      line('identify', 'Identify', 'info', 'MONITOR $(options:monitor):\nIdentify: true\n\n', { text: 'ID', options: [str('monitor', 'Monitor', 'A')] }),
      line('widescreen', 'Widescreen SD', 'toggle', 'MONITOR $(options:monitor):\nWidescreenSD: $(options:on)\n\n', { options: [str('monitor', 'Monitor', 'A'), str('on', 'ON or OFF', 'ON')] }),
    ],
  }),
  defineSystem({
    id: 'lightware-lw3', label: 'Lightware LW3', short: 'LW3', category: 'router', manufacturer: 'Lightware', bar: '#F4A261',
    status: 'implemented', transport: 'tcp', companion: ['lightware-lw3'],
    summary: 'Switch a video crosspoint and mute an input. Port numbers are the device\'s I and O indexes.',
    docs: docs('https://www.lightware.com/en/support/open-api', 'Lightware Protocol #3', 'TCP 6107. Lines end with CR LF. CALL /MEDIA/VIDEO/XP:switch(I4:O1) takes input 4 to output 1. CALL /MEDIA/VIDEO/XP:muteSource(I1) mutes input 1. GET /MEDIA/VIDEO/XP.DestinationConnectionList reads the current ties. LW2 is a different protocol and is not this system.'),
    connection: hostPort(6107, [str('delimiter', 'Delimiter', '\\r\\n')]),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', { border: '#3DDC84' })],
    actions: [
      line('switch', 'Switch', 'toggle', 'CALL /MEDIA/VIDEO/XP:switch(I$(options:input):O$(options:output))\r\n', { text: 'XPT', options: [num('input', 'Input', 1), num('output', 'Output', 1)] }),
      line('mute', 'Mute input', 'toggle', 'CALL /MEDIA/VIDEO/XP:muteSource(I$(options:input))\r\n', { text: 'MUTE', confirm: true, options: [num('input', 'Input', 1)] }),
      line('read', 'Read ties', 'info', 'GET /MEDIA/VIDEO/XP.DestinationConnectionList\r\n', { text: 'READ' }),
    ],
  }),
  defineSystem({
    id: 'extron-sis', label: 'Extron SIS matrix', short: 'Extron', category: 'router', manufacturer: 'Extron', bar: '#5B7C99',
    status: 'implemented', transport: 'tcp', companion: ['extron-matrix', 'extron-dxp', 'extron-dxp-hd-4k-plus', 'extron-smx', 'extron-mmx-tcp', 'extron-xtp-3200'],
    summary: 'Tie an input to an output, with video or audio breakaway, and mute one output.',
    docs: docs('https://media.extron.com/public/download/files/userman/68-2368-51_B.pdf', 'Extron DTP CrossPoint SIS', 'TCP 23. 1*3! ties input 1 video and audio to output 3. % is video only, $ is audio only. 3*1B mutes output 3 video and 3*0B unmutes it. The same tie characters are the SIS matrix form Extron publishes for CrossPoint, DXP, MAV, SMX, MMX and XTP. Scalers and IPL controllers are not this system.'),
    connection: hostPort(23, [str('delimiter', 'Delimiter', '\\r\\n')]),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', { border: '#3DDC84' })],
    actions: [
      line('tie', 'Tie video and audio', 'toggle', '$(options:input)*$(options:output)!\r', { text: 'TIE', options: [num('input', 'Input', 1), num('output', 'Output', 1)] }),
      line('video', 'Tie video', 'toggle', '$(options:input)*$(options:output)%\r', { text: 'VID', options: [num('input', 'Input', 1), num('output', 'Output', 1)] }),
      line('audio', 'Tie audio', 'toggle', '$(options:input)*$(options:output)$\r', { text: 'AUD', options: [num('input', 'Input', 1), num('output', 'Output', 1)] }),
      line('mute', 'Mute output', 'toggle', '$(options:output)*1B\r', { text: 'MUTE', confirm: true, options: [num('output', 'Output', 1)] }),
      line('unmute', 'Unmute output', 'toggle', '$(options:output)*0B\r', { text: 'UNMUTE', options: [num('output', 'Output', 1)] }),
    ],
  }),
  defineSystem({
    id: 'kramer-p3000', label: 'Kramer Protocol 3000', short: 'Kramer', category: 'router', manufacturer: 'Kramer', bar: '#E9C46A',
    status: 'implemented', transport: 'tcp', companion: ['kramer-matrix'],
    summary: 'Route one layer and recall a preset. Output is the destination, then the source.',
    docs: docs('https://k.kramerav.com/downloads/protocols/protocol_3000_3.0_master_user.pdf', 'Kramer Protocol 3000', 'TCP 5000. Each command ends with CR. #ROUTE 1,4,2 routes layer 1 (video) from input 2 to output 4. Layer 2 is audio. #PRST-RCL 3 recalls preset 3. Older Protocol 2000 switchers are not this system.'),
    connection: hostPort(5000, [str('delimiter', 'Delimiter', '\\r')]),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', { border: '#3DDC84' })],
    actions: [
      line('route', 'Route', 'toggle', '#ROUTE $(options:layer),$(options:output),$(options:input)\r', { text: 'ROUTE', options: [num('layer', 'Layer 1 video', 1), num('output', 'Output', 1), num('input', 'Input', 1)] }),
      line('preset', 'Recall preset', 'memory', '#PRST-RCL $(options:preset)\r', { text: 'PRST', confirm: true, options: [num('preset', 'Preset', 1)] }),
    ],
  }),
  defineSystem({
    id: 'aja-helo', label: 'AJA HELO', short: 'HELO', category: 'playback', manufacturer: 'AJA', bar: '#E85D4C',
    status: 'implemented', transport: 'http', companion: ['aja-helo'],
    summary: 'Record, stream, pick a profile and recall a preset through the Replicator parameter.',
    docs: docs('https://gitlab.aja.com/pub/rest_api/-/blob/master/HELO/03_HELO_Commands.md', 'AJA HELO REST commands', 'GET /config?action=set&paramid=eParamID_ReplicatorCommand. 1 records, 2 stops recording, 3 streams, 4 stops streaming, 5 shuts down. Recording profiles are eParamID_RecordingProfileSel 0–9. eParamID_RegisterRecall recalls a preset. When web authentication is enabled the device expects a session cookie, which these buttons do not log in for.'),
    connection: hostPort(80),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered', { border: '#3DDC84' })],
    actions: [
      helo('eParamID_ReplicatorCommand', 1, 'Record', 'program', { text: 'REC', confirm: true }),
      helo('eParamID_ReplicatorCommand', 2, 'Stop recording', 'toggle', { text: 'STOP' }),
      helo('eParamID_ReplicatorCommand', 3, 'Stream', 'program', { text: 'LIVE', confirm: true }),
      helo('eParamID_ReplicatorCommand', 4, 'Stop streaming', 'toggle', { text: 'END' }),
      helo('eParamID_RecordingProfileSel', '$(options:profile)', 'Recording profile', 'memory', { text: 'PROF', options: [num('profile', 'Profile 0-9', 0)] }),
      helo('eParamID_RegisterRecall', '$(options:preset)', 'Recall preset', 'memory', { text: 'PRST', confirm: true, options: [num('preset', 'Preset', 1)] }),
      helo('eParamID_ReplicatorCommand', 5, 'Shutdown', 'toggle', { text: 'OFF', confirm: true }),
    ],
  }),
  defineSystem({
    id: 'bmd-teranex', label: 'Blackmagic Teranex', short: 'Teranex', category: 'processor', manufacturer: 'Blackmagic Design', bar: '#5B7C99',
    status: 'implemented', transport: 'tcp', companion: ['bmd-teranex'],
    summary: 'Set the output video mode. The block is the manual\'s Ethernet example.',
    docs: docs('https://documents.blackmagicdesign.com/UserManuals/TeranexManual.pdf', 'Teranex Ethernet Protocol', 'TCP 9800. A block is a header, one command line, and a blank line. VIDEO OUTPUT:\\nVideo mode: 1080i5994\\n\\n is the manual\'s example for 1080i59.94. Teranex Mini uses a different manual and is not this system.'),
    connection: hostPort(9800, [str('delimiter', 'Delimiter', '\\n')]),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', { border: '#3DDC84' })],
    actions: [
      line('output', 'Output mode', 'toggle', 'VIDEO OUTPUT:\nVideo mode: $(options:mode)\n\n', { text: 'MODE', options: [str('mode', 'Video mode', '1080i5994')] }),
    ],
  }),
  defineSystem({
    id: 'bmd-streaming', label: 'Blackmagic Streaming Encoder', short: 'Stream', category: 'playback', manufacturer: 'Blackmagic Design', bar: '#E85D4C',
    status: 'implemented', transport: 'tcp', companion: ['bmd-webpresenter'],
    summary: 'Start and stop the stream, and set the input video mode.',
    docs: docs('https://documents.blackmagicdesign.com/DeveloperManuals/WebPresenterEthernetProtocol.pdf', 'Blackmagic Streaming Encoder Ethernet Protocol', 'TCP 9977. STREAM STATE:\\nAction: Start\\n\\n starts the stream and Action: Stop ends it. STREAM SETTINGS:\\nVideo Mode: 1080p59.94\\n\\n sets the input format. SHUTDOWN:\\nAction: Reboot\\n\\n reboots. The January 2026 protocol names the product Streaming Encoder HD and 4K. Companion still lists this family as bmd-webpresenter.'),
    connection: hostPort(9977, [str('delimiter', 'Delimiter', '\\n')]),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', { border: '#3DDC84' })],
    actions: [
      line('start', 'Start stream', 'program', 'STREAM STATE:\nAction: Start\n\n', { text: 'LIVE', confirm: true }),
      line('stop', 'Stop stream', 'toggle', 'STREAM STATE:\nAction: Stop\n\n', { text: 'STOP' }),
      line('mode', 'Video mode', 'toggle', 'STREAM SETTINGS:\nVideo Mode: $(options:mode)\n\n', { text: 'MODE', options: [str('mode', 'Video mode', '1080p59.94')] }),
      line('reboot', 'Reboot', 'toggle', 'SHUTDOWN:\nAction: Reboot\n\n', { text: 'BOOT', confirm: true }),
    ],
  }),
  defineSystem({
    id: 'lightware-lw2', label: 'Lightware LW2', short: 'LW2', category: 'router', manufacturer: 'Lightware', bar: '#F4A261',
    status: 'implemented', transport: 'tcp', companion: ['lightware-lw2'],
    summary: 'Switch a crosspoint, unmute an input, and load a preset. LW3 is a different system.',
    docs: docs('https://www.lightware.com/en/support/open-api', 'Lightware Protocol #2', 'TCP 10001. Commands sit in curly brackets. {1@5} switches input 1 to output 5 and the router answers (O05 I01). {+06} unmutes input 6. {%4} loads preset 4. {vc} reads the crosspoint. Responses end with CR LF.'),
    connection: hostPort(10001, [str('delimiter', 'Delimiter', '\\r\\n')]),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', { border: '#3DDC84' })],
    actions: [
      line('switch', 'Switch', 'toggle', '{$(options:input)@$(options:output)}', { text: 'XPT', options: [num('input', 'Input', 1), num('output', 'Output', 5)] }),
      line('unmute', 'Unmute input', 'toggle', '{+$(options:input)}', { text: 'UNMUTE', options: [num('input', 'Input', 1)] }),
      line('preset', 'Load preset', 'memory', '{%$(options:preset)}', { text: 'PRST', confirm: true, options: [num('preset', 'Preset', 1)] }),
      line('read', 'Read ties', 'info', '{vc}', { text: 'READ' }),
    ],
  }),
  defineSystem({
    id: 'kramer-p2000', label: 'Kramer Protocol 2000', short: 'P2000', category: 'router', manufacturer: 'Kramer', bar: '#E9C46A',
    status: 'implemented', transport: 'tcp', companion: ['kramer-vs41h', 'kramer-vp727'],
    summary: 'Four-byte switch and setup recall. Protocol 3000 matrices stay on the other Kramer system.',
    docs: docs('https://cdn.kramerav.com/web/downloads/manuals/protocol_2000_rev0_51.pdf', 'Kramer Protocol 2000', 'Four bytes. Instruction 1 switches video and instruction 2 switches audio. The input and output bytes set bit 7, and the machine byte sets bit 7 with the machine number in the low bits. 01 85 88 83 is the manual\'s example: input 5 to output 8 on machine 3. Instruction 4 recalls a setup. The VS-88HN manual publishes TCP 5000 for the Ethernet port that carries this protocol. VP-734 and VP-773A are not mapped until their own manuals confirm Protocol 2000.'),
    connection: hostPort(5000),
    variables: [v('connected', 'Connected')],
    feedbacks: [fb('connected', 'Connected', { border: '#3DDC84' })],
    actions: [
      act('video', 'Switch video', 'toggle', { type: 'p2000', instruction: 1, input: '$(options:input)', output: '$(options:output)', machine: '$(options:machine)' }, { text: 'VID', options: [num('input', 'Input', 1), num('output', 'Output', 1), num('machine', 'Machine', 1)] }),
      act('audio', 'Switch audio', 'toggle', { type: 'p2000', instruction: 2, input: '$(options:input)', output: '$(options:output)', machine: '$(options:machine)' }, { text: 'AUD', options: [num('input', 'Input', 1), num('output', 'Output', 1), num('machine', 'Machine', 1)] }),
      act('recall', 'Recall setup', 'memory', { type: 'p2000', instruction: 4, input: '$(options:setup)', output: 0, machine: '$(options:machine)' }, { text: 'RCL', confirm: true, options: [num('setup', 'Setup', 1), num('machine', 'Machine', 1)] }),
    ],
  }),
];

module.exports = { systems };
