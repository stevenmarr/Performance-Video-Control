'use strict';
// Audio, lighting and playback systems whose command line is in a
// manufacturer document.

const { defineSystem } = require('../framework');

const docs = (url, title, note = '') => ({ url, title, basis: 'official', note });
const v = (id, label) => ({ id, label });
const fb = (id, label) => ({ id, label, variable: 'connected', op: 'eq', value: 'true', style: { border: '#3DDC84' } });
const num = (id, label, def) => ({ id, type: 'number', label, default: def });
const str = (id, label, def = '') => ({ id, type: 'string', label, default: def });
const hostPort = (port, extra = []) => ({ fields: [{ id: 'host', type: 'string', label: 'Host', default: '' }, { id: 'port', type: 'number', label: 'Port', default: port }, ...extra] });

function act(id, label, role, execute, extra = {}) {
  return {
    id, label, role, text: extra.text || label, description: extra.description || label,
    confirm: !!extra.confirm, options: extra.options || [], execute,
  };
}
function line(id, label, role, payload, extra = {}) {
  return act(id, label, role, { type: 'line', payload }, extra);
}
function httpAct(id, label, role, method, path, extra = {}) {
  const execute = { type: 'http', method, path };
  if (extra.body != null) {
    execute.body = extra.body;
    execute.contentType = extra.contentType || 'application/json';
  }
  return act(id, label, role, execute, extra);
}

const systems = [
  defineSystem({
    id: 'audac-mtx', label: 'Audac MTX', short: 'MTX', category: 'audio', manufacturer: 'AUDAC', bar: '#E85D04',
    status: 'implemented', transport: 'tcp', companion: ['audac-mtx'],
    summary: 'Set a zone route, volume and mute on an MTX matrix.',
    docs: docs('https://downloads.pvs.global/downloads/audac/products/manuals/MTX_Commands_Manual.pdf', 'AUDAC MTX commands user manual', 'TCP port 5001, also listed for the MTX on the AUDAC required-ports page. The address is fixed at X001 and U is accepted as the checksum. The line ends with CR LF. #|X001|web|SR1|3|U| selects input 3 on zone 1. #|X001|web|SV1|30|U| sets zone 1 to -30 dB. #|X001|web|SM01|1|U| mutes zone 1. Volume and route use SVx and SRx. Mute uses SM0x.'),
    connection: hostPort(5001),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected')],
    actions: [
      line('route', 'Route zone', 'toggle', '#|X001|web|SR$(options:zone)|$(options:input)|U|\r\n', { text: 'RTE', options: [num('zone', 'Zone', 1), num('input', 'Input', 3)] }),
      line('volume', 'Zone volume', 'toggle', '#|X001|web|SV$(options:zone)|$(options:level)|U|\r\n', { text: 'VOL', options: [num('zone', 'Zone', 1), num('level', '-dB', 30)] }),
      line('mute', 'Mute zone', 'toggle', '#|X001|web|SM0$(options:zone)|1|U|\r\n', { text: 'MUTE', options: [num('zone', 'Zone', 1)] }),
      line('unmute', 'Unmute zone', 'toggle', '#|X001|web|SM0$(options:zone)|0|U|\r\n', { options: [num('zone', 'Zone', 1)] }),
    ],
  }),
  defineSystem({
    id: 'atlasied-atmosphere', label: 'AtlasIED Atmosphere', short: 'Atmosphere', category: 'audio', manufacturer: 'AtlasIED', bar: '#1F4B99',
    status: 'implemented', transport: 'tcp', companion: ['atlasied-atmosphere'],
    summary: 'Send the published zone-gain set and the keep-alive.',
    docs: docs('https://www.atlasied.com/ATS006993-B-AZM4-AZM8-3rd-Party-Control.pdf', 'AZM4/AZM8 third-party control', 'TCP port 5321. Each message ends with a newline. The worked set is {"jsonrpc":"2.0","method":"set","params":[{"param":"ZoneGain_0","pct":50},{"param":"ZoneGain_1","val":-20}]}. The keep-alive get uses param KeepAlive. Parameter names are assigned on the unit under Settings, Third Party Control, Message Table, so a renamed zone needs the name from that table.'),
    connection: hostPort(5321),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected')],
    actions: [
      line('gain', 'Set zone gain', 'toggle', '{"jsonrpc":"2.0","method":"set","params":[{"param":"ZoneGain_0","pct":50},{"param":"ZoneGain_1","val":-20}]}\n', { text: 'GAIN' }),
      line('alive', 'Keep alive', 'info', '{"jsonrpc":"2.0","method":"get","params":{"param":"KeepAlive","fmt":"str"}}\n', { text: 'ALIVE' }),
    ],
  }),
  defineSystem({
    id: 'axia-livewire', label: 'Axia Livewire', short: 'Livewire', category: 'audio', manufacturer: 'Telos Alliance', bar: '#0B6E4F',
    status: 'implemented', transport: 'tcp', companion: ['axia-livewire-lwrp'],
    summary: 'Log in, then point a destination at an address.',
    docs: docs('https://docs.telosalliance.com/docs/axia-ip-driver-and-aes67', 'Axia IP-Audio driver and AES67', 'Livewire Routing Protocol is TCP port 93. Commands are uppercase and each one is entered on its own line. LOGIN is required before a change. DST 1 ADDR:"239.190.1.1" points destination 1 at that multicast address. The quotation marks around the address are ASCII quotes.'),
    connection: hostPort(93),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected')],
    actions: [
      line('login', 'Log in', 'info', 'LOGIN\r\n', { text: 'LOGIN' }),
      line('route', 'Set destination', 'toggle', 'DST $(options:destination) ADDR:"$(options:address)"\r\n', { text: 'DST', options: [num('destination', 'Destination', 1), str('address', 'Address', '239.190.1.1')] }),
    ],
  }),
  defineSystem({
    id: 'avolites-titan', label: 'Avolites Titan', short: 'Titan', category: 'lighting', manufacturer: 'Avolites', bar: '#C41230',
    status: 'implemented', transport: 'http', companion: ['avolites-titan'],
    summary: 'Fire a playback at a level and release it.',
    docs: docs('https://api.avolites.com/12.0/Playbacks.FirePlaybackAtLevel.html', 'Avolites Titan FirePlaybackAtLevel', 'HTTP port 4430. FirePlaybackAtLevel?handle_userNumber=6&level_level=1&alwaysRefire=true fires user number 6 at full. ReleasePlayback?handle_userNumber=6&fadeTime=5&useMasterReleaseTime=true releases that playback. Ai is not this API.'),
    connection: hostPort(4430),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered')],
    actions: [
      httpAct('fire', 'Fire playback', 'hot', 'GET', '/titan/script/2/Playbacks/FirePlaybackAtLevel?handle_userNumber=$(options:user)&level_level=$(options:level)&alwaysRefire=true', { text: 'FIRE', options: [num('user', 'User number', 6), num('level', 'Level', 1)] }),
      httpAct('release', 'Release playback', 'toggle', 'GET', '/titan/script/2/Playbacks/ReleasePlayback?handle_userNumber=$(options:user)&fadeTime=$(options:fade)&useMasterReleaseTime=true', { text: 'REL', confirm: true, options: [num('user', 'User number', 6), num('fade', 'Fade', 5)] }),
    ],
  }),
  defineSystem({
    id: 'highend-hog4', label: 'High End Hog 4', short: 'Hog 4', category: 'lighting', manufacturer: 'High End Systems', bar: '#F4A261',
    status: 'implemented', transport: 'udp', companion: ['highend-hog4'],
    summary: 'Go, halt or release a cuelist.',
    docs: docs('https://www.etcconnect.com/webdocs/Controls/HOG/HTML/en/sect-osc_mappings.htm', 'Hog 4 OSC mappings', 'Go a cuelist is /hog/playback/go/0 with the cuelist number. Halt is /hog/playback/halt/0 and release is /hog/playback/release/0. The manual prints spaces around the slashes; the address sent is that path without the spaces. OSC In is enabled in Setup, Network, Settings, and that pane assigns the port. The port field starts at 0 until that value is entered.'),
    connection: hostPort(0),
    variables: [v('connected', 'Connected'), v('last', 'Last address')],
    feedbacks: [fb('connected', 'Sent')],
    actions: [
      act('go', 'Go cuelist', 'hot', { type: 'osc', address: '/hog/playback/go/0', args: ['$(options:list)'] }, { text: 'GO', options: [num('list', 'Cuelist', 1)] }),
      act('halt', 'Halt cuelist', 'toggle', { type: 'osc', address: '/hog/playback/halt/0', args: ['$(options:list)'] }, { text: 'HALT', options: [num('list', 'Cuelist', 1)] }),
      act('release', 'Release cuelist', 'toggle', { type: 'osc', address: '/hog/playback/release/0', args: ['$(options:list)'] }, { text: 'REL', confirm: true, options: [num('list', 'Cuelist', 1)] }),
    ],
  }),
  defineSystem({
    id: 'dataton-watchout-json', label: 'Dataton WATCHOUT HTTP', short: 'WATCHOUT HTTP', category: 'playback', manufacturer: 'Dataton', bar: '#90BE6D',
    status: 'implemented', transport: 'http', companion: ['dataton-watchout-json'],
    summary: 'Play, pause or stop one timeline.',
    docs: docs('https://docs.dataton.com/watchout-7-new/watchout/external-control/http-rest-api.html', 'WATCHOUT 7 HTTP REST API', 'The operative API is HTTP port 3019. POST /v0/play/1 plays timeline 1. POST /v0/pause/1 pauses it and POST /v0/stop/1 stops it and resets to the start. This is not the TCP text protocol and not the director-control module.'),
    connection: hostPort(3019),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered')],
    actions: [
      httpAct('play', 'Play timeline', 'hot', 'POST', '/v0/play/$(options:timeline)', { text: 'PLAY', options: [num('timeline', 'Timeline', 1)] }),
      httpAct('pause', 'Pause timeline', 'toggle', 'POST', '/v0/pause/$(options:timeline)', { text: 'PAUSE', options: [num('timeline', 'Timeline', 1)] }),
      httpAct('stop', 'Stop timeline', 'toggle', 'POST', '/v0/stop/$(options:timeline)', { text: 'STOP', confirm: true, options: [num('timeline', 'Timeline', 1)] }),
    ],
  }),
  defineSystem({
    id: 'delta-media', label: '7thSense Delta', short: 'Delta', category: 'playback', manufacturer: '7thSense', bar: '#5C4D7A',
    status: 'implemented', transport: 'tcp', companion: ['7thsensedesign-delta'],
    summary: 'Cue, play or stop a timeline.',
    docs: docs('https://portal.7thsense.one/user-guides/MC255-managing-servers/deltagui_external_control.html', '7thSense Delta external control', 'Commands are not case sensitive and each one ends with CR. PLAY plays the show, CUE cues it, and STOP stops it. TL=1 selects timeline 1. TCP port 23 is the multi-telnet port in the managing-servers port list.'),
    connection: hostPort(23),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected')],
    actions: [
      line('cue', 'Cue timeline', 'memory', 'CUE TL=$(options:timeline)\r', { text: 'CUE', options: [num('timeline', 'Timeline', 1)] }),
      line('play', 'Play timeline', 'hot', 'PLAY TL=$(options:timeline)\r', { text: 'PLAY', options: [num('timeline', 'Timeline', 1)] }),
      line('stop', 'Stop timeline', 'toggle', 'STOP TL=$(options:timeline)\r', { text: 'STOP', confirm: true, options: [num('timeline', 'Timeline', 1)] }),
    ],
  }),
  defineSystem({
    id: 'magicq-udp', label: 'ChamSys MagicQ UDP', short: 'MagicQ UDP', category: 'lighting', manufacturer: 'ChamSys', bar: '#E85D04',
    status: 'implemented', transport: 'udp', companion: ['chamsys-magicq-udp'],
    summary: 'Go or release a playback with the text remote command.',
    docs: docs('https://docs.chamsys.co.uk/magicq/1.9.9.x/manual/remote_control_commands.html', 'ChamSys remote protocol commands', '1G goes on playback 1. 1R releases it. The same form is in the example 1A2A1S2G. UDP port 6553. Spaces, tabs and carriage returns are ignored. Reception without the CREP header needs Ethernet remote protocol set to ChamSys Rem (rx no header). This is not the OSC system.'),
    connection: hostPort(6553),
    variables: [v('connected', 'Connected'), v('udp.last', 'Last command')],
    feedbacks: [fb('connected', 'Sent')],
    actions: [
      act('go', 'Go playback', 'hot', { type: 'udp', payload: '$(options:playback)G' }, { text: 'GO', options: [num('playback', 'Playback', 1)] }),
      act('release', 'Release playback', 'toggle', { type: 'udp', payload: '$(options:playback)R' }, { text: 'REL', confirm: true, options: [num('playback', 'Playback', 1)] }),
    ],
  }),
  defineSystem({
    id: 'mimolive', label: 'mimoLive', short: 'mimoLive', category: 'playback', manufacturer: 'Boinx', bar: '#1F4B99',
    status: 'implemented', transport: 'http', companion: ['boinx-mimolive'],
    summary: 'Set a layer live or off.',
    docs: docs('https://mimolive.com/user-manual/remote-control-automation/http-api/examples-of-api-usage/', 'mimoLive HTTP API examples', 'The HTTP server is port 8989. GET /api/v1/documents/458706932/layers/BA868701-8131-49CB-8EDD-8C7E6E7CD60B/setLive sets that layer live. setOff takes it off. The document and layer ids are the ones in the example, and a show uses its own ids from the layer context menu.'),
    connection: hostPort(8989),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered')],
    actions: [
      httpAct('live', 'Layer live', 'program', 'GET', '/api/v1/documents/$(options:document)/layers/$(options:layer)/setLive', { text: 'LIVE', options: [str('document', 'Document', '458706932'), str('layer', 'Layer', 'BA868701-8131-49CB-8EDD-8C7E6E7CD60B')] }),
      httpAct('off', 'Layer off', 'toggle', 'GET', '/api/v1/documents/$(options:document)/layers/$(options:layer)/setOff', { text: 'OFF', options: [str('document', 'Document', '458706932'), str('layer', 'Layer', 'BA868701-8131-49CB-8EDD-8C7E6E7CD60B')] }),
    ],
  }),
  defineSystem({
    id: 'aten-matrix', label: 'ATEN matrix', short: 'ATEN matrix', category: 'router', manufacturer: 'ATEN', bar: '#C41230',
    status: 'implemented', transport: 'tcp', companion: ['aten-matrix'],
    summary: 'Switch an input to an output.',
    docs: docs('https://assets.aten.com/product/manual/vm0404hb-vm0808hb_um_w_2021-06-18.pdf', 'ATEN VM0404HB / VM0808HB manual', 'Telnet port 23. sw i02 o05 routes input 02 to output 05. Input and output are two digits. If telnet login is enabled, the username and password are entered at the login screen before this command.'),
    connection: hostPort(23),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected')],
    actions: [
      line('route', 'Route', 'toggle', 'sw i$(options:input) o$(options:output)\r', { text: 'RTE', options: [str('input', 'Input', '02'), str('output', 'Output', '05')] }),
      line('off', 'Output off', 'toggle', 'sw o$(options:output) off\r', { text: 'OFF', confirm: true, options: [str('output', 'Output', '03')] }),
    ],
  }),
  defineSystem({
    id: 'scs-show', label: 'Show Cue Systems', short: 'SCS', category: 'playback', manufacturer: 'Show Cue Systems', bar: '#0B6E4F',
    status: 'implemented', transport: 'udp', companion: ['showcuesystems-scs'],
    summary: 'Fire the Go button or stop every cue.',
    docs: docs('https://showcuesystems.com/scs11help/topics/prod-cc-network.htm', 'SCS network cue control', 'scsGo("0") fires the Go button. scsStopAll stops every cue. A command ends with CR. The production properties choose TCP or UDP and the port, so the port field starts at 0 until that port is entered. This button sends UDP.'),
    connection: hostPort(0),
    variables: [v('connected', 'Connected'), v('udp.last', 'Last command')],
    feedbacks: [fb('connected', 'Sent')],
    actions: [
      act('go', 'Go', 'hot', { type: 'udp', payload: 'scsGo("$(options:cue)")\r' }, { text: 'GO', options: [str('cue', 'Cue', '0')] }),
      act('stop', 'Stop all', 'toggle', { type: 'udp', payload: 'scsStopAll\r' }, { text: 'STOP', confirm: true }),
    ],
  }),
  defineSystem({
    id: 'aximmetry', label: 'Aximmetry Composer', short: 'Aximmetry', category: 'playback', manufacturer: 'Aximmetry', bar: '#5C4D7A',
    status: 'implemented', transport: 'http', companion: ['aximmetry-composer'],
    summary: 'Press a control-board button.',
    docs: docs('https://aximmetry.com/learn/virtual-production-workflow/setting-up-inputs-outputs-for-virtual-production/external-controllers/external-control-of-aximmetry-via-http/network-setup-and-sending-actions/', 'Aximmetry HTTP control', 'POST the action XML to port 21463, the port in the published example. The worked action is ComposerCtrBoardPressButtonAction for CAM 2 on the VirtualCam SELECT CAMERA board. The body is sent as text/plain. HTTP control has to be enabled in Edit, Preferences.'),
    connection: hostPort(21463),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered')],
    actions: [
      httpAct('camera', 'Camera 2', 'hot', 'POST', '/', { text: 'CAM', contentType: 'text/plain', body: '<action type="ComposerCtrBoardPressButtonAction" Module="Root\\VirtualCam_3-Cam\\CAMERAS\\SELECT CAMERA" Button="CAM 2" />' }),
    ],
  }),
  defineSystem({
    id: 'capture-visualiser', label: 'Capture', short: 'Capture', category: 'lighting', manufacturer: 'Capture', bar: '#F4A261',
    status: 'implemented', transport: 'udp', companion: ['capture-visualiser'],
    summary: 'Ping Capture and recall a camera position.',
    docs: docs('https://www.capture.se/Manual/en-UK/2026/Appendix.html', 'Capture 2026 OSC appendix', 'OSC over UDP on port 4004. /ping asks for the product name. /view/live/position with catalog number and position number recalls that camera. Both numbers are integers.'),
    connection: hostPort(4004),
    variables: [v('connected', 'Connected'), v('last', 'Last address')],
    feedbacks: [fb('connected', 'Sent')],
    actions: [
      act('ping', 'Ping', 'info', { type: 'osc', address: '/ping', args: [] }, { text: 'PING' }),
      act('camera', 'Camera position', 'memory', { type: 'osc', address: '/view/live/position', args: ['$(options:catalog)', '$(options:position)'] }, { text: 'CAM', options: [num('catalog', 'Catalog', 1), num('position', 'Position', 1)] }),
    ],
  }),
  defineSystem({
    id: 'showtec-lampy', label: 'Showtec Lampy', short: 'Lampy', category: 'lighting', manufacturer: 'Showtec', bar: '#111111',
    status: 'implemented', transport: 'udp', companion: ['showtec-lampy'],
    summary: 'Press a playback-fader button.',
    docs: docs('https://www.showtec-lights.com/en/mwdownloads/download/link/id/17455196', 'LAMPY 20/40 user manual', 'The OSC command path is /lampy/pbf/1/flash. Data 1 is press and 0 is release. The manual prints spaces around the slashes; the address sent is that path without the spaces. The console shows the OSC port after OSC input is enabled, so the port field starts at 0 until that value is entered.'),
    connection: hostPort(0),
    variables: [v('connected', 'Connected'), v('last', 'Last address')],
    feedbacks: [fb('connected', 'Sent')],
    actions: [
      act('press', 'Press fader', 'hot', { type: 'osc', address: '/lampy/pbf/$(options:fader)/flash', args: [1] }, { text: 'GO', options: [num('fader', 'Fader 1-10', 1)] }),
      act('release', 'Release fader', 'toggle', { type: 'osc', address: '/lampy/pbf/$(options:fader)/flash', args: [0] }, { text: 'REL', options: [num('fader', 'Fader 1-10', 1)] }),
    ],
  }),
];

module.exports = { systems };
