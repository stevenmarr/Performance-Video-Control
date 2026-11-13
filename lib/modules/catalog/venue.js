'use strict';
// Audio, display and DSP systems with a public manufacturer protocol.

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
    id: 'qsys-qrc', label: 'Q-SYS QRC', short: 'Q-SYS', category: 'audio', manufacturer: 'Q-SYS', bar: '#4C6EF5',
    status: 'implemented', transport: 'tcp', companion: ['qsys-remote-control'],
    summary: 'Set or read a named control. The Core must be running a design.',
    docs: docs('https://help.qsys.com/content/External_Control_APIs/QRC/QRC_Commands.htm', 'Q-SYS QRC commands', 'TCP 1710. Each command is JSON-RPC 2.0 and ends with a null byte. Control.Set takes a named control and a value. Control.Get reads one. The Core closes the socket after 60 seconds without a command. Logon is required when access control is on.'),
    connection: hostPort(1710, [str('delimiter', 'Delimiter', '\\0')]),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', { border: '#3DDC84' })],
    actions: [
      line('set', 'Set control', 'toggle', '{"jsonrpc":"2.0","id":1,"method":"Control.Set","params":{"Name":"$(options:name)","Value":$(options:value)}}\0', { options: [str('name', 'Named control', 'MainGain'), str('value', 'Value', '-12')], element: 'encoder', event: 'turn' }),
      line('get', 'Read control', 'info', '{"jsonrpc":"2.0","id":1,"method":"Control.Get","params":["$(options:name)"]}\0', { text: 'GET', options: [str('name', 'Named control', 'MainGain')] }),
    ],
  }),
  defineSystem({
    id: 'biamp-tesira', label: 'Biamp Tesira', short: 'Tesira', category: 'audio', manufacturer: 'Biamp', bar: '#5B7C99',
    status: 'implemented', transport: 'tcp', companion: ['biamp-tesira'],
    summary: 'Recall a preset, mute a block, and start or stop audio.',
    docs: docs('https://downloads.biamp.com/assets/docs/default-source/control/tesira_text_protocol_v4-2_jan22.pdf?sfvrsn=100c2497_46', 'Tesira Text Protocol 4.2', 'Telnet TCP 23. A line feed ends each command. DEVICE recallPreset 1001 recalls preset 1001. Level1 set mute 1 true mutes channel 1 of that block. A success reply starts with +OK. Audia and Qt X are not this protocol.'),
    connection: hostPort(23, [str('delimiter', 'Delimiter', '\\n')]),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', { border: '#3DDC84' })],
    actions: [
      line('preset', 'Recall preset', 'memory', 'DEVICE recallPreset $(options:preset)\n', { text: 'PRST', confirm: true, options: [num('preset', 'Preset id', 1001)] }),
      line('mute', 'Mute', 'toggle', '$(options:tag) set mute $(options:index) true\n', { text: 'MUTE', options: [str('tag', 'Instance tag', 'Level1'), num('index', 'Channel', 1)] }),
      line('unmute', 'Unmute', 'toggle', '$(options:tag) set mute $(options:index) false\n', { options: [str('tag', 'Instance tag', 'Level1'), num('index', 'Channel', 1)] }),
      line('start', 'Start audio', 'toggle', 'DEVICE startAudio\n', { text: 'START' }),
      line('stop', 'Stop audio', 'toggle', 'DEVICE stopAudio\n', { text: 'STOP', confirm: true }),
    ],
  }),
  defineSystem({
    id: 'shure-mxa910', label: 'Shure MXA910', short: 'MXA910', category: 'audio', manufacturer: 'Shure', bar: '#6C757D',
    status: 'implemented', transport: 'tcp', companion: ['shure-mxa910'],
    summary: 'Mute a channel or the whole mic, and set gain in tenths of a dB.',
    docs: docs('https://www.shure.com/en-US/docs/commandstrings/MXA910', 'MXA910 command strings', 'TCP 2202. < SET 1 AUDIO_MUTE ON > mutes channel 1. Channel 0 is all channels and 9 is the automix output. < SET DEVICE_AUDIO_MUTE ON > is the post-meter mute. Gain uses AUDIO_GAIN_HI_RES from 0000 to 1400, in steps of 0.1 dB. Other Shure models publish their own string lists.'),
    connection: hostPort(2202, [str('delimiter', 'Delimiter', '\\r')]),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', { border: '#3DDC84' })],
    actions: [
      line('mute', 'Mute channel', 'toggle', '< SET $(options:channel) AUDIO_MUTE ON >\r', { text: 'MUTE', options: [str('channel', '0 all, 1-8, 9 mix', '1')] }),
      line('unmute', 'Unmute channel', 'toggle', '< SET $(options:channel) AUDIO_MUTE OFF >\r', { options: [str('channel', '0 all, 1-8, 9 mix', '1')] }),
      line('deviceMute', 'Mute mic', 'toggle', '< SET DEVICE_AUDIO_MUTE ON >\r', { text: 'MIC', confirm: true }),
      line('deviceUnmute', 'Unmute mic', 'toggle', '< SET DEVICE_AUDIO_MUTE OFF >\r', { text: 'OPEN' }),
      line('gain', 'Gain', 'toggle', '< SET $(options:channel) AUDIO_GAIN_HI_RES $(options:gain) >\r', { options: [str('channel', 'Channel', '1'), str('gain', '0000-1400', '0700')], element: 'encoder', event: 'turn' }),
    ],
  }),
  defineSystem({
    id: 'sony-bravia-simple', label: 'Sony Bravia Simple IP', short: 'Bravia', category: 'display', manufacturer: 'Sony', bar: '#E85D4C',
    status: 'implemented', transport: 'tcp', companion: ['sony-bravia-simpleip'],
    summary: 'Power, volume, mute and HDMI input. Simple IP control has to be enabled on the display.',
    docs: docs('https://pro-bravia.sony.net/remote-display-control/simple-ip-control/', 'Sony Simple IP control', 'TCP 20060. A command is 24 bytes: *SC, a four-character code, 16 parameter characters, and a line feed. *SCPOWR followed by 15 zeros and 1 turns the panel on. *SCVOLU sets the volume. *SCAMUT mutes. *SCINPT with 0000000100000001 selects HDMI 1. The REST and IRCC APIs are a different system.'),
    connection: hostPort(20060),
    variables: [v('connected', 'Connected'), v('last', 'Last command')],
    feedbacks: [fb('connected', 'Connected', { border: '#3DDC84' })],
    actions: [
      act('on', 'Power on', 'toggle', { type: 'bravia', fourcc: 'POWR', param: '1' }, { text: 'ON' }),
      act('off', 'Power off', 'toggle', { type: 'bravia', fourcc: 'POWR', param: '0' }, { text: 'OFF', confirm: true }),
      act('volume', 'Volume', 'toggle', { type: 'bravia', fourcc: 'VOLU', param: '$(options:level)' }, { options: [num('level', 'Volume', 20)], element: 'encoder', event: 'turn' }),
      act('mute', 'Mute', 'toggle', { type: 'bravia', fourcc: 'AMUT', param: '1' }, { text: 'MUTE' }),
      act('unmute', 'Unmute', 'toggle', { type: 'bravia', fourcc: 'AMUT', param: '0' }),
      act('hdmi', 'HDMI input', 'toggle', { type: 'bravia', fourcc: 'INPT', param: '000000010000$(options:input)' }, { text: 'HDMI', options: [str('input', 'HDMI 0001-0099', '0001')] }),
    ],
  }),
  defineSystem({
    id: 'allenheath-ahm', label: 'Allen & Heath AHM', short: 'AHM', category: 'audio', manufacturer: 'Allen & Heath', bar: '#5B7C99',
    status: 'implemented', transport: 'tcp', companion: ['allenheath-ahm'],
    summary: 'Mute an input or a zone. Input 1 is MIDI channel 1, note 0.',
    docs: docs('https://www.allen-heath.com/content/uploads/2024/10/AHM-TCP-Protocol-V1.5.pdf', 'AHM TCP/IP protocol', 'TCP 51325. Mute on is note on, velocity 7F, then note off. Mute off uses velocity 3F. Inputs 1–64 are MIDI channel 1, notes 0–63. Zones 1–64 are MIDI channel 2. TLS on 51327 wants a profile and password first and is not this socket.'),
    connection: hostPort(51325),
    variables: [v('connected', 'Connected'), v('channel', 'Last channel')],
    feedbacks: [fb('connected', 'Connected', { border: '#3DDC84' })],
    actions: [
      act('mute', 'Mute input', 'toggle', { type: 'dlive', op: 'mute', on: 1, channel: '$(options:channel)', midiChannel: 1 }, { text: 'MUTE', options: [num('channel', 'Input 1-64', 1)] }),
      act('unmute', 'Unmute input', 'toggle', { type: 'dlive', op: 'mute', on: 0, channel: '$(options:channel)', midiChannel: 1 }, { options: [num('channel', 'Input 1-64', 1)] }),
      act('zoneMute', 'Mute zone', 'toggle', { type: 'dlive', op: 'mute', on: 1, channel: '$(options:zone)', midiChannel: 2 }, { text: 'ZONE', options: [num('zone', 'Zone 1-64', 1)] }),
      act('zoneUnmute', 'Unmute zone', 'toggle', { type: 'dlive', op: 'mute', on: 0, channel: '$(options:zone)', midiChannel: 2 }, { options: [num('zone', 'Zone 1-64', 1)] }),
    ],
  }),
];

module.exports = { systems };
