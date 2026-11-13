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
];

module.exports = { systems };
