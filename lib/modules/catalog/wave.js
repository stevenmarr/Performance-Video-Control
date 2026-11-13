'use strict';
// The next coverage pass: displays, cameras, consoles, timers and open protocols.

const { defineSystem } = require('../framework');

const docs = (url, title, note = '') => ({ url, title, basis: 'official', note });
const v = (id, label) => ({ id, label });
const fb = (id, label, style) => ({ id, label, variable: 'connected', op: 'eq', value: 'true', style });
const num = (id, label, def) => ({ id, type: 'number', label, default: def });
const str = (id, label, def = '') => ({ id, type: 'string', label, default: def });
const hostPort = (port, extra = []) => ({ fields: [{ id: 'host', type: 'string', label: 'Host', default: '' }, { id: 'port', type: 'number', label: 'Port', default: port }, ...extra] });
const ok = { border: '#3DDC84' };

function act(id, label, role, execute, extra = {}) {
  return {
    id, label, role, text: extra.text || label, description: extra.description || label,
    confirm: !!extra.confirm, options: extra.options || [], execute,
  };
}
function line(id, label, role, payload, extra = {}) {
  return act(id, label, role, { type: 'line', payload }, extra);
}
function httpGet(id, label, role, path, extra = {}) {
  return act(id, label, role, { type: 'http', method: 'GET', path }, extra);
}

function pj(id, label, manufacturer, companion, note) {
  return defineSystem({
    id, label, short: label.slice(0, 16), category: 'display', manufacturer, bar: '#4C6EF5',
    status: 'implemented', transport: 'pjlink', companion,
    summary: 'PJLink Class 1 power, shutter and input. Use it when the model manual lists PJLink.',
    docs: docs('https://pjlink.jbmia.or.jp/english/data_cl2.html', 'PJLink specifications (JBMIA)', note),
    connection: { fields: [{ id: 'host', type: 'string', label: 'Host', default: '' }, { id: 'port', type: 'number', label: 'Port', default: 4352 }, { id: 'password', type: 'string', label: 'Password', default: '' }] },
    variables: [v('connected', 'Connected'), v('last', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', ok)],
    actions: [
      act('on', 'Power on', 'toggle', { type: 'pjlink', command: '%1POWR 1\r' }, { text: 'ON', confirm: true }),
      act('off', 'Power off', 'toggle', { type: 'pjlink', command: '%1POWR 0\r' }, { text: 'OFF', confirm: true }),
      act('mute', 'Shutter close', 'toggle', { type: 'pjlink', command: '%1AVMT 31\r' }, { text: 'SHUT', confirm: true }),
      act('open', 'Shutter open', 'toggle', { type: 'pjlink', command: '%1AVMT 30\r' }, { text: 'OPEN' }),
    ],
  });
}

const pjNote = 'TCP 4352. %1POWR 1 turns the projector on and %1POWR 0 turns it off. %1AVMT 31 closes the shutter. These are the JBMIA Class 1 commands. Send them when this model\'s manual lists PJLink.';

const systems = [
  defineSystem({
    id: 'lg-signage', label: 'LG signage', short: 'LG', category: 'display', manufacturer: 'LG', bar: '#E85D4C',
    status: 'implemented', transport: 'tcp', companion: ['lgtv-prodisplay'],
    summary: 'Power and HDMI for an LG signage set. Set ID 01 is the first set.',
    docs: docs('https://gscs-b2c.lge.com/open/downloadFile?fileId=KROWM000594321.pdf', 'LG signage external control', 'The manual\'s power command is ka, a space, the set id, a space, and 00 off or 01 on, then CR. The same chapter is the RS-232 command set. The port field is the set\'s network control port; LG signage that accepts this command on the network commonly uses 9761.'),
    connection: hostPort(9761),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', ok)],
    actions: [
      line('on', 'Power on', 'toggle', 'ka $(options:id) 01\r', { text: 'ON', options: [str('id', 'Set ID', '01')] }),
      line('off', 'Power off', 'toggle', 'ka $(options:id) 00\r', { text: 'OFF', confirm: true, options: [str('id', 'Set ID', '01')] }),
    ],
  }),
  defineSystem({
    id: 'sharp-ascii', label: 'Sharp display', short: 'Sharp', category: 'display', manufacturer: 'Sharp', bar: '#E85D4C',
    status: 'implemented', transport: 'tcp', companion: ['sharp-tv'],
    summary: 'Power, HDMI and AV mute with the common ASCII commands.',
    docs: docs('https://sharp-displays.jp.sharp/support/webdl/dl_service/data/projector/manual/common_ascii/common_ascii_e.pdf', 'Sharp NEC common ASCII control', 'TCP 7142, from the Sharp projector command manual that uses this command set. power on, input hdmi and avmute on each end with a line feed. The same manual covers Sharp NEC projectors; those are a separate system so the tab matches the product.'),
    connection: hostPort(7142, [str('delimiter', 'Delimiter', '\\r')]),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', ok)],
    actions: [
      line('on', 'Power on', 'toggle', 'power on\r', { text: 'ON' }),
      line('off', 'Power off', 'toggle', 'power off\r', { text: 'OFF', confirm: true }),
      line('hdmi', 'HDMI', 'toggle', 'input hdmi\r', { text: 'HDMI' }),
      line('mute', 'AV mute', 'toggle', 'avmute on\r', { text: 'MUTE', confirm: true }),
      line('unmute', 'AV mute off', 'toggle', 'avmute off\r', { text: 'SHOW' }),
    ],
  }),
  defineSystem({
    id: 'nec-projector-ascii', label: 'NEC projector ASCII', short: 'NEC PJ', category: 'display', manufacturer: 'NEC', bar: '#5B7C99',
    status: 'implemented', transport: 'tcp', companion: ['nec-projectors'],
    summary: 'Power and AV mute for a Sharp NEC projector that speaks the common ASCII set.',
    docs: docs('https://business.sharpusa.com/Portals/0/downloads/Manuals/sharp-pj-control-command-codes.pdf', 'Sharp NEC projector command manual', 'TCP 7142. power on and avmute on are the common ASCII commands, each ended with a line feed. The older NEC monitor packet (C203D6) stays on the NEC display system.'),
    connection: hostPort(7142, [str('delimiter', 'Delimiter', '\\r')]),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', ok)],
    actions: [
      line('on', 'Power on', 'toggle', 'power on\r', { text: 'ON' }),
      line('off', 'Power off', 'toggle', 'power off\r', { text: 'OFF', confirm: true }),
      line('mute', 'AV mute', 'toggle', 'avmute on\r', { text: 'MUTE', confirm: true }),
      line('unmute', 'AV mute off', 'toggle', 'avmute off\r', { text: 'SHOW' }),
    ],
  }),
  pj('panasonic-projector', 'Panasonic projector', 'Panasonic', ['panasonic-projector'], pjNote),
  pj('digital-projection', 'Digital Projection', 'Digital Projection', ['digital-projection', 'digitalprojection-projectors'], pjNote),
  pj('optoma-projector', 'Optoma projector', 'Optoma', ['optoma-z28s'], pjNote),
  pj('vivitek-projector', 'Vivitek projector', 'Vivitek', ['vivitek-projector'], pjNote),
  pj('sanyo-projector', 'Sanyo projector', 'Sanyo', ['sanyo-projector'], pjNote),
  pj('eiki-projector', 'Eiki projector', 'Eiki', ['eiki-wspprojector'], pjNote),
  defineSystem({
    id: 'panasonic-aw', label: 'Panasonic AW camera', short: 'AW cam', category: 'camera', manufacturer: 'Panasonic', bar: '#4C6EF5',
    status: 'implemented', transport: 'http', companion: ['panasonic-cameras'],
    summary: 'Recall a preset. 00 is the first preset in the interface specification.',
    docs: docs('https://eww.pass.panasonic.co.jp/pro-av/support/content/guide/DEF/UE80/AW-UE80UE50UE40_InterfaceSpecification_E.pdf', 'Panasonic AW-UE interface specification', 'GET /cgi-bin/aw_ptz?cmd=%23R00&res=1. The # is percent-encoded. The specification\'s playback example is #R07. Data 00 through 99 selects preset 1 through 100.'),
    connection: hostPort(80),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered', ok)],
    actions: [
      httpGet('preset', 'Recall preset', 'memory', '/cgi-bin/aw_ptz?cmd=%23R$(options:data)&res=1', { text: 'PRE', options: [str('data', '00-99', '00')] }),
    ],
  }),
  defineSystem({
    id: 'jvc-ptz', label: 'JVC PTZ', short: 'JVC', category: 'camera', manufacturer: 'JVC', bar: '#E85D4C',
    status: 'implemented', transport: 'http', companion: ['jvc-ptz', 'jvc-camera'],
    summary: 'Call a preset or go home through the HTTP-CGI sheet.',
    docs: docs('https://www.jvc.com/content/dam/jvc/usa/pro/professional-video/documents/manuals/pdf/HTTP-CGI-Command-support-table_001.pdf', 'JVC HTTP-CGI command sheet', 'GET /cgi-bin/ptzctrl.cgi?ptzcmd&poscall&3 calls preset 3. ptzcmd&home moves to the home position. Preset numbers in the sheet run from 0.'),
    connection: hostPort(80),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered', ok)],
    actions: [
      httpGet('preset', 'Call preset', 'memory', '/cgi-bin/ptzctrl.cgi?ptzcmd&poscall&$(options:preset)', { text: 'PRE', options: [num('preset', 'Preset 0-254', 1)] }),
      httpGet('home', 'Home', 'toggle', '/cgi-bin/ptzctrl.cgi?ptzcmd&home', { text: 'HOME' }),
    ],
  }),
  defineSystem({
    id: 'axis-ptz', label: 'Axis PTZ', short: 'Axis', category: 'camera', manufacturer: 'Axis', bar: '#F4A261',
    status: 'implemented', transport: 'http', companion: ['axis-ptz'],
    summary: 'Go to a server preset or home with VAPIX.',
    docs: docs('https://developer.axis.com/vapix/network-video/pantiltzoom-api/', 'Axis VAPIX PTZ API', 'GET /axis-cgi/com/ptz.cgi?gotoserverpresetno=1 moves to preset 1. move=home uses the home preset. The camera may require a viewer login.'),
    connection: hostPort(80),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered', ok)],
    actions: [
      httpGet('preset', 'Go to preset', 'memory', '/axis-cgi/com/ptz.cgi?gotoserverpresetno=$(options:preset)', { text: 'PRE', options: [num('preset', 'Preset', 1)] }),
      httpGet('home', 'Home', 'toggle', '/axis-cgi/com/ptz.cgi?move=home', { text: 'HOME' }),
    ],
  }),
  defineSystem({
    id: 'epiphan-pearl', label: 'Epiphan Pearl', short: 'Pearl', category: 'playback', manufacturer: 'Epiphan', bar: '#E85D4C',
    status: 'implemented', transport: 'http', companion: ['epiphan-pearl'],
    summary: 'Start and stop a channel recording with the legacy HTTP API.',
    docs: docs('https://www.epiphan.com/userguides/pdfs/Epiphan-Pearl-API-Guide.pdf', 'Epiphan Pearl legacy API', 'GET /admin/channel1/set_params.cgi?rec_enabled=on starts channel 1. An empty rec_enabled value stops it. The guide also points at the newer REST API; these buttons use the legacy keys it still documents.'),
    connection: hostPort(80),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered', ok)],
    actions: [
      httpGet('record', 'Record', 'program', '/admin/channel$(options:channel)/set_params.cgi?rec_enabled=on', { text: 'REC', confirm: true, options: [num('channel', 'Channel', 1)] }),
      httpGet('stop', 'Stop', 'toggle', '/admin/channel$(options:channel)/set_params.cgi?rec_enabled=', { text: 'STOP', options: [num('channel', 'Channel', 1)] }),
    ],
  }),
  defineSystem({
    id: 'etc-paradigm', label: 'ETC Paradigm', short: 'Paradigm', category: 'lighting', manufacturer: 'ETC', bar: '#E9C46A',
    status: 'implemented', transport: 'udp', companion: ['etc-paradigm'],
    summary: 'Activate a preset by its PSAP name.',
    docs: docs('https://www.etcconnect.com/WorkArea/DownloadAsset.aspx?id=10737514967', 'Paradigm Serial Access Protocol', 'UDP, ETC\'s recommended input ports are 4703–4727. pst act followed by the preset name and a carriage return is the preset activate command. The processor must have the PSAP input handler enabled.'),
    connection: hostPort(4703),
    variables: [v('connected', 'Sent'), v('last', 'Last command')],
    feedbacks: [fb('connected', 'A packet was sent', ok)],
    actions: [
      act('preset', 'Activate preset', 'memory', { type: 'udp', payload: 'pst act $(options:name)\r', encoding: 'ascii' }, { text: 'PST', confirm: true, options: [str('name', 'Preset name', 'P1')] }),
    ],
  }),
  defineSystem({
    id: 'allenheath-qu', label: 'Allen & Heath Qu', short: 'Qu', category: 'audio', manufacturer: 'Allen & Heath', bar: '#5B7C99',
    status: 'implemented', transport: 'tcp', companion: ['allenheath-qu'],
    summary: 'Mute an input and recall a scene. Input 1 is note 0x20.',
    docs: docs('https://www.allen-heath.com/content/uploads/2023/06/Qu_MIDI_Protocol_V1.9.pdf', 'Qu MIDI protocol', 'TCP 51325. Mute on is note on, velocity 7F, then note off. Inputs 1–32 are notes 0x20–0x3F. Scene 1 is bank 0 and program 0. Qu allows one TCP MIDI connection.'),
    connection: hostPort(51325),
    variables: [v('connected', 'Connected'), v('channel', 'Last channel'), v('scene', 'Last scene')],
    feedbacks: [fb('connected', 'Connected', ok)],
    actions: [
      act('mute', 'Mute', 'toggle', { type: 'qu', op: 'mute', on: 1, channel: '$(options:channel)' }, { text: 'MUTE', options: [num('channel', 'Input 1-32', 1)] }),
      act('unmute', 'Unmute', 'toggle', { type: 'qu', op: 'mute', on: 0, channel: '$(options:channel)' }, { options: [num('channel', 'Input 1-32', 1)] }),
      act('scene', 'Recall scene', 'memory', { type: 'qu', op: 'scene', scene: '$(options:scene)' }, { text: 'SCENE', confirm: true, options: [num('scene', 'Scene 1-100', 1)] }),
    ],
  }),
  defineSystem({
    id: 'symetrix-dsp', label: 'Symetrix Composer', short: 'Symetrix', category: 'audio', manufacturer: 'Symetrix', bar: '#6C757D',
    status: 'implemented', transport: 'tcp', companion: ['symetrix-dsp'],
    summary: 'Set a Composer controller number.',
    docs: docs('https://www.symetrix.co/tech-tips/basic-remote-terminal-commands', 'Symetrix Composer control protocol', 'TCP 48631. CS 100 32768 sets controller 100 to position 32768 and ends with CR. Controller numbers are assigned in Composer. The same command is accepted on UDP 48631; this system uses TCP.'),
    connection: hostPort(48631, [str('delimiter', 'Delimiter', '\\r')]),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', ok)],
    actions: [
      line('set', 'Set controller', 'toggle', 'CS $(options:controller) $(options:position)\r', { text: 'CS', options: [num('controller', 'Controller', 1), num('position', '0-65535', 32768)], element: 'encoder', event: 'turn' }),
    ],
  }),
  defineSystem({
    id: 'clock-8001', label: 'Clock-8001', short: 'Clock', category: 'show', manufacturer: 'Depili', bar: '#90BE6D',
    status: 'implemented', transport: 'osc', companion: ['depili-clock-8001'],
    summary: 'Start, pause and stop one of the ten timers.',
    docs: docs('https://gitlab.com/clock-8001/clock-8001/-/blob/master/v4/osc.md', 'clock-8001 OSC', 'UDP 1245. /clock/timer/0/countdown with an integer starts timer 0. /clock/timer/0/countup starts a count-up. /clock/timer/0/pause and /clock/timer/0/stop pause and stop it. Timer numbers are 0–9.'),
    connection: hostPort(1245),
    variables: [v('connected', 'Socket open'), v('last', 'Last address')],
    feedbacks: [fb('connected', 'Socket open', ok)],
    actions: [
      act('down', 'Countdown', 'toggle', { type: 'osc', address: '/clock/timer/$(options:timer)/countdown', args: ['$(options:seconds)'] }, { text: 'DOWN', options: [num('timer', 'Timer 0-9', 0), num('seconds', 'Seconds', 60)] }),
      act('up', 'Count up', 'toggle', { type: 'osc', address: '/clock/timer/$(options:timer)/countup', args: [] }, { text: 'UP', options: [num('timer', 'Timer 0-9', 0)] }),
      act('pause', 'Pause', 'toggle', { type: 'osc', address: '/clock/timer/$(options:timer)/pause', args: [] }, { options: [num('timer', 'Timer 0-9', 0)] }),
      act('stop', 'Stop', 'toggle', { type: 'osc', address: '/clock/timer/$(options:timer)/stop', args: [] }, { text: 'STOP', options: [num('timer', 'Timer 0-9', 0)] }),
    ],
  }),
  defineSystem({
    id: 'stagetimer', label: 'Stagetimer', short: 'Stage timer', category: 'show', manufacturer: 'Stagetimer', bar: '#F4A261',
    status: 'implemented', transport: 'http', companion: ['stagetimerio-api'],
    summary: 'Start, stop and reset the selected timer in a room.',
    docs: docs('https://stagetimer.io/docs/api-v1/', 'Stagetimer API v1', 'HTTPS GET https://api.stagetimer.io/v1/start with room_id and api_key. /v1/stop and /v1/reset use the same query. The room key is created on the controller page.'),
    connection: { fields: [{ id: 'host', type: 'string', label: 'Host', default: 'api.stagetimer.io' }, { id: 'port', type: 'number', label: 'Port', default: 443 }, { id: 'https', type: 'boolean', label: 'HTTPS', default: true }] },
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered', ok)],
    actions: [
      httpGet('start', 'Start', 'toggle', '/v1/start?room_id=$(options:room)&api_key=$(options:key)', { text: 'START', options: [str('room', 'Room id', ''), str('key', 'API key', '')] }),
      httpGet('stop', 'Stop', 'toggle', '/v1/stop?room_id=$(options:room)&api_key=$(options:key)', { text: 'STOP', options: [str('room', 'Room id', ''), str('key', 'API key', '')] }),
      httpGet('reset', 'Reset', 'toggle', '/v1/reset?room_id=$(options:room)&api_key=$(options:key)', { text: 'RESET', confirm: true, options: [str('room', 'Room id', ''), str('key', 'API key', '')] }),
    ],
  }),
  defineSystem({
    id: 'generic-mqtt', label: 'MQTT', short: 'MQTT', category: 'utility', manufacturer: '', bar: '#5c6570',
    status: 'implemented', transport: 'tcp', companion: ['generic-mqtt'],
    summary: 'Publish one message. The packet starts with a CONNECT so a fresh socket can accept it.',
    docs: docs('https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/os/mqtt-v3.1.1-os.html', 'MQTT 3.1.1', 'TCP 1883. The button sends a CONNECT with a clean session and then a PUBLISH of the topic and payload, which MQTT 3.1.1 allows the client to pipeline. QoS is 0.'),
    connection: hostPort(1883, [str('clientId', 'Client id', 'cc')]),
    variables: [v('connected', 'Connected'), v('last', 'Last topic')],
    feedbacks: [fb('connected', 'Connected', ok)],
    actions: [
      act('publish', 'Publish', 'toggle', { type: 'mqtt', topic: '$(options:topic)', payload: '$(options:payload)' }, { text: 'PUB', options: [str('topic', 'Topic', 'cc/state'), str('payload', 'Payload', '1')] }),
    ],
  }),
  defineSystem({
    id: 'generic-modbus', label: 'Modbus TCP', short: 'Modbus', category: 'utility', manufacturer: '', bar: '#5c6570',
    status: 'implemented', transport: 'tcp', companion: ['generic-modbus'],
    summary: 'Write one holding register.',
    docs: docs('https://modbus.org/docs/Modbus_Application_Protocol_V1_1b3.pdf', 'Modbus application protocol', 'TCP 502. Function 06 writes a single holding register. The MBAP header carries the unit id, then the address and the 16-bit value.'),
    connection: hostPort(502, [num('unit', 'Unit id', 1)]),
    variables: [v('connected', 'Connected')],
    feedbacks: [fb('connected', 'Connected', ok)],
    actions: [
      act('write', 'Write register', 'toggle', { type: 'modbus', unit: '$(options:unit)', address: '$(options:address)', value: '$(options:value)' }, { text: 'REG', options: [num('unit', 'Unit', 1), num('address', 'Address', 0), num('value', 'Value', 1)] }),
    ],
  }),
  defineSystem({
    id: 'generic-snmp', label: 'SNMP', short: 'SNMP', category: 'utility', manufacturer: '', bar: '#5c6570',
    status: 'implemented', transport: 'udp', companion: ['generic-snmp'],
    summary: 'Set one integer with SNMP version 1.',
    docs: docs('https://www.rfc-editor.org/rfc/rfc1157', 'RFC 1157 SNMP', 'UDP 161. A SetRequest with version 0, the community string, and one integer varbind. The OID is dotted decimal.'),
    connection: hostPort(161, [str('community', 'Community', 'public')]),
    variables: [v('connected', 'Sent'), v('last', 'Last OID')],
    feedbacks: [fb('connected', 'A packet was sent', ok)],
    actions: [
      act('set', 'Set integer', 'toggle', { type: 'snmp', oid: '$(options:oid)', value: '$(options:value)', community: '$(options:community)' }, { text: 'SET', options: [str('oid', 'OID', '1.3.6.1.2.1.1.1.0'), num('value', 'Value', 1), str('community', 'Community', 'public')] }),
    ],
  }),
  defineSystem({
    id: 'generic-websocket', label: 'WebSocket', short: 'WebSocket', category: 'utility', manufacturer: '', bar: '#5c6570',
    status: 'implemented', transport: 'websocket', companion: ['generic-websocket'],
    summary: 'Open a socket, send one text frame, and close it.',
    docs: docs('https://www.rfc-editor.org/rfc/rfc6455', 'RFC 6455 The WebSocket Protocol', 'The button performs the HTTP upgrade and sends one masked text frame. The path is the resource on the host.'),
    connection: hostPort(80, [str('path', 'Path', '/')]),
    variables: [v('connected', 'Sent'), v('last', 'Last text')],
    feedbacks: [fb('connected', 'A frame was sent', ok)],
    actions: [
      act('send', 'Send text', 'toggle', { type: 'websocket', text: '$(options:text)' }, { text: 'SEND', options: [str('text', 'Text', 'go')] }),
    ],
  }),
  defineSystem({
    id: 'generic-onvif', label: 'ONVIF', short: 'ONVIF', category: 'camera', manufacturer: '', bar: '#5B7C99',
    status: 'implemented', transport: 'http', companion: ['generic-onvif'],
    summary: 'Read the device clock. Many cameras answer this without a login.',
    docs: docs('https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf', 'ONVIF core specification', 'POST /onvif/device_service with a GetSystemDateAndTime body. The core specification defines this device-service call. A camera that requires WS-Security will reject it until credentials are added on that camera.'),
    connection: hostPort(80),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered', ok)],
    actions: [
      act('time', 'Read clock', 'info', { type: 'http', method: 'POST', path: '/onvif/device_service', contentType: 'application/soap+xml', body: '<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><GetSystemDateAndTime xmlns="http://www.onvif.org/ver10/device/wsdl"/></s:Body></s:Envelope>' }, { text: 'TIME' }),
    ],
  }),
  defineSystem({
    id: 'midi-show-control', label: 'MIDI Show Control', short: 'MSC', category: 'show', manufacturer: '', bar: '#E9C46A',
    status: 'implemented', transport: 'udp', companion: ['malighting-msc'],
    summary: 'Send a Go or Stop to every MSC device on the target.',
    docs: docs('https://www.midi.org/specifications/midi1-specifications/midi-show-control-1-0', 'MIDI Show Control 1.0', 'A UDP payload of the MSC sysex. F0 7F 7F 02 01 F7 is Go to device 7F, the all-call id. Command 02 is Stop. Point the host at the console or an IP MIDI port that accepts the sysex.'),
    connection: hostPort(6004),
    variables: [v('connected', 'Sent'), v('last', 'Last command')],
    feedbacks: [fb('connected', 'A packet was sent', ok)],
    actions: [
      act('go', 'Go', 'toggle', { type: 'msc', command: 1 }, { text: 'GO' }),
      act('stop', 'Stop', 'toggle', { type: 'msc', command: 2 }, { text: 'STOP', confirm: true }),
    ],
  }),
  defineSystem({
    id: 'generic-ping', label: 'Ping', short: 'Ping', category: 'utility', manufacturer: '', bar: '#90BE6D',
    status: 'implemented', transport: 'ping', companion: ['generic-ping'],
    summary: 'Send one ICMP echo and keep the first line of the reply.',
    docs: docs('https://www.rfc-editor.org/rfc/rfc792', 'RFC 792 Internet Control Message Protocol', 'One ICMP echo request to the host. The button uses the system ping command with a one-second wait.'),
    connection: { fields: [{ id: 'host', type: 'string', label: 'Host', default: '' }] },
    variables: [v('connected', 'Replied'), v('ping.reply', 'Reply')],
    feedbacks: [fb('connected', 'Replied', ok)],
    actions: [
      act('ping', 'Ping', 'info', { type: 'ping' }, { text: 'PING' }),
    ],
  }),
];

module.exports = { systems };
