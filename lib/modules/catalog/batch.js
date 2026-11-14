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
  defineSystem({
    id: 'onyx-osc', label: 'Obsidian ONYX', short: 'ONYX', category: 'lighting', manufacturer: 'Obsidian Control Systems', bar: '#4DF7FF',
    status: 'implemented', transport: 'udp', companion: ['obsidiancontrol-onyx-osc'],
    summary: 'Go or release a playback-page button, or press the console Go key.',
    docs: docs('https://files.obsidiancontrol.com/s/yndNn7FsaB9Fyay/download', 'ONYX OSC mapping V1.20 revision 5', 'The PDF example /Mx/playback/page1/0/go 1 is a key down, go, on page 1 button 1. Button index 0 is button 1. /Mx/playback/page5/9/release 1 releases page 5 button 10. /Mx/button/5513 with 1 presses the console Go key. Playback-page messages require a license. The OSC page assigns the incoming port on the console, so the port field starts at 0 until that value is entered.'),
    connection: hostPort(0),
    variables: [v('connected', 'Connected'), v('last', 'Last address')],
    feedbacks: [fb('connected', 'Sent')],
    actions: [
      act('go', 'Go page', 'hot', { type: 'osc', address: '/Mx/playback/page$(options:page)/$(options:button)/go', args: [1] }, { text: 'GO', options: [num('page', 'Page', 1), num('button', 'Button', 0)] }),
      act('release', 'Release page', 'toggle', { type: 'osc', address: '/Mx/playback/page$(options:page)/$(options:button)/release', args: [1] }, { text: 'REL', confirm: true, options: [num('page', 'Page', 5), num('button', 'Button', 9)] }),
      act('console', 'Console go', 'hot', { type: 'osc', address: '/Mx/button/5513', args: [1] }, { text: 'KEY' }),
    ],
  }),
  defineSystem({
    id: 'dugan-automixer', label: 'Dan Dugan automixer', short: 'Dugan', category: 'audio', manufacturer: 'Dan Dugan Sound Design', bar: '#C41230',
    status: 'implemented', transport: 'tcp', companion: ['dan-dugan-automixer'],
    summary: 'Set a channel to auto or mute, and clear the system mute.',
    docs: docs('https://www.dandugan.com/Assets/manuals/Model-E-User-Guide.pdf', 'Dugan Model E user guide', 'Telnet ASCII. Each command ends with CR. CM 2, 1 sets channel 2 to auto. Channel mode 2 is mute, so CM 2, 2 mutes channel 2. SM 0 clears the system mute. The guide says to open Telnet to the Model E and does not print that port. Port 9776 is named for internet access in the web-panel section.'),
    connection: hostPort(23),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected')],
    actions: [
      line('auto', 'Channel auto', 'toggle', 'CM $(options:channel), 1\r', { text: 'AUTO', options: [num('channel', 'Channel', 2)] }),
      line('mute', 'Channel mute', 'toggle', 'CM $(options:channel), 2\r', { text: 'MUTE', options: [num('channel', 'Channel', 2)] }),
      line('open', 'System unmute', 'toggle', 'SM 0\r', { text: 'OPEN' }),
    ],
  }),
  defineSystem({
    id: 'bosch-hd-camera', label: 'Bosch HD camera', short: 'Bosch HD', category: 'camera', manufacturer: 'Bosch', bar: '#0B6E4F',
    status: 'implemented', transport: 'http', companion: ['bosch-hd-cameracontrol'],
    summary: 'Move an HD camera to the printed absolute position.',
    docs: docs('https://media.boschsecurity.com/fs/media/pb/media/partners_1/integration_tools_1/developer/absolute-positioning-ip-1-9.pdf', 'Bosch Autodome absolute positioning', 'GET /rcp.xml?command=0x09A5&type=P_OCTET&direction=WRITE&num=1&payload=0x80000601d0022328232801ae0000 pans to 90, tilts to 90 and zooms wide. The PDF wraps that payload. This is the HD BICOM command. It is not the analog OSRD command, and it is not Dicentis.'),
    connection: hostPort(80),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered')],
    actions: [
      httpAct('wide', 'Pan 90 tilt 90 wide', 'hot', 'GET', '/rcp.xml?command=0x09A5&type=P_OCTET&direction=WRITE&num=1&payload=0x80000601d0022328232801ae0000', { text: 'PTZ' }),
    ],
  }),
  defineSystem({
    id: 'matrox-monarch', label: 'Matrox Monarch', short: 'Monarch', category: 'recorder', manufacturer: 'Matrox', bar: '#C41230',
    status: 'implemented', transport: 'http', companion: ['matrox-monarch'],
    summary: 'Start or stop a Monarch HD recording.',
    docs: docs('https://video.matrox.com/wp-content/uploads/2026/08/en_monarch_hd_dev_tools_reference_guide.pdf', 'Monarch HD dev tools reference', 'GET /Monarch/syncconnect/sdk.aspx?command=StartRecording starts recording. StopRecording stops it. The guide uses HTTP basic authorization and says the default user and password are both admin.'),
    connection: hostPort(80, [str('username', 'User', 'admin'), str('password', 'Password', 'admin'), str('authType', 'Auth', 'basic')]),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered')],
    actions: [
      httpAct('record', 'Start recording', 'program', 'GET', '/Monarch/syncconnect/sdk.aspx?command=StartRecording', { text: 'REC', confirm: true }),
      httpAct('stop', 'Stop recording', 'toggle', 'GET', '/Monarch/syncconnect/sdk.aspx?command=StopRecording', { text: 'STOP' }),
    ],
  }),
  defineSystem({
    id: 'tvone-corio', label: 'tvONE CORIOmaster', short: 'CORIOmaster', category: 'processor', manufacturer: 'tvONE', bar: '#1F4B99',
    status: 'implemented', transport: 'tcp', companion: ['tvone-corio'],
    summary: 'Log in and take a preset.',
    docs: docs('https://tvone.com/filestore/downloads/tvONE-CORIOmaster-Commands-v1.7.0.pdf', 'tvONE CORIOmaster commands', 'Ethernet command port 10001. login(admin,adminpw) is the printed login example. Preset.Take = 1 takes preset 1. The command list does not print a line ending; the button ends the line with CR, the end of a line on the RS-232 settings printed with this port. Calico is not this list.'),
    connection: hostPort(10001),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected')],
    actions: [
      line('login', 'Log in', 'info', 'login(admin,adminpw)\r', { text: 'LOGIN' }),
      line('preset', 'Take preset', 'memory', 'Preset.Take = $(options:preset)\r', { text: 'TAKE', options: [num('preset', 'Preset', 1)] }),
    ],
  }),
  defineSystem({
    id: 'netio-powerbox', label: 'NETIO PowerBOX', short: 'NETIO', category: 'utility', manufacturer: 'NETIO', bar: '#E85D04',
    status: 'implemented', transport: 'http', companion: ['netio-powerbox'],
    summary: 'Turn one output on or off.',
    docs: docs('https://www.netio-products.com/files/NETIO-M2M-API-Protocol-JSON.pdf', 'NETIO JSON M2M API', 'POST /netio.json with {"Outputs":[{"ID":1,"Action":1}]} turns output 1 on. Action 0 turns it off. The port is the device web port.'),
    connection: hostPort(80),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered')],
    actions: [
      httpAct('on', 'Output on', 'toggle', 'POST', '/netio.json', { text: 'ON', contentType: 'application/json', body: '{"Outputs":[{"ID":$(options:output),"Action":1}]}', options: [num('output', 'Output', 1)] }),
      httpAct('off', 'Output off', 'toggle', 'POST', '/netio.json', { text: 'OFF', confirm: true, contentType: 'application/json', body: '{"Outputs":[{"ID":$(options:output),"Action":0}]}', options: [num('output', 'Output', 1)] }),
    ],
  }),
  defineSystem({
    id: 'iiyama-prolite', label: 'iiyama ProLite', short: 'iiyama', category: 'display', manufacturer: 'iiyama', bar: '#111111',
    status: 'implemented', transport: 'tcp', companion: ['iiyama-prolite'],
    summary: 'Turn a ProLite display on or off.',
    docs: docs('https://iiyama.com/f/2745ee2456421dcc5459a549095c2d11_rs232-lan-commands-2026-08-txx29as-lhxx66-lhxx81.pdf', 'iiyama RS-232 and LAN commands', 'LAN port 5000. Power on for display address 01 is A60100000004011802B8. Power off is A60100000004011801BB. The bytes are the hex command, not the hex text.'),
    connection: hostPort(5000),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected')],
    actions: [
      act('on', 'Power on', 'toggle', { type: 'line', encoding: 'hex', payload: 'A60100000004011802B8' }, { text: 'ON' }),
      act('off', 'Power off', 'toggle', { type: 'line', encoding: 'hex', payload: 'A60100000004011801BB' }, { text: 'OFF', confirm: true }),
    ],
  }),
  defineSystem({
    id: 'vlc-http', label: 'VLC', short: 'VLC', category: 'playback', manufacturer: 'VideoLAN', bar: '#E85D04',
    status: 'implemented', transport: 'http', companion: ['videolan-vlc'],
    summary: 'Play the next item or stop.',
    docs: docs('https://wiki.videolan.org/VLC_HTTP_requests', 'VLC HTTP requests', 'GET /requests/status.xml?command=pl_next jumps to the next item. pl_stop stops playback. The wiki example listens on port 9090.'),
    connection: hostPort(9090),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered')],
    actions: [
      httpAct('next', 'Next', 'hot', 'GET', '/requests/status.xml?command=pl_next', { text: 'NEXT' }),
      httpAct('stop', 'Stop', 'toggle', 'GET', '/requests/status.xml?command=pl_stop', { text: 'STOP' }),
    ],
  }),
  defineSystem({
    id: 'cisco-roomos', label: 'Cisco RoomOS', short: 'RoomOS', category: 'switcher', manufacturer: 'Cisco', bar: '#0B6E4F',
    status: 'implemented', transport: 'websocket', companion: ['cisco-roomos'],
    summary: 'Start the presentation from the printed example.',
    docs: docs('https://www.cisco.com/c/dam/en/us/td/docs/telepresence/endpoint/api/collaboration-endpoint-software-api-transport.pdf', 'Cisco xAPI over WebSocket', 'The unencrypted URL is ws://host/ws. The printed start is the JSON-RPC method xCommand/Presentation/Start with ConnectorId 2 and 3, Layout Equal, and SendingMode LocalRemote. The guide also describes an Authorization header on the upgrade. This button sends the JSON after the socket opens.'),
    connection: hostPort(80, [str('path', 'Path', '/ws')]),
    variables: [v('connected', 'Connected'), v('last', 'Last message')],
    feedbacks: [fb('connected', 'Sent')],
    actions: [
      act('present', 'Start presentation', 'program', { type: 'websocket', text: '{"jsonrpc":"2.0","id":115,"method":"xCommand/Presentation/Start","params":{"Layout":"Equal","ConnectorId":[2,3],"SendingMode":"LocalRemote"}}' }, { text: 'PVW' }),
    ],
  }),
  defineSystem({
    id: 'qlcplus', label: 'QLC+', short: 'QLC+', category: 'lighting', manufacturer: 'QLC+', bar: '#5C4D7A',
    status: 'implemented', transport: 'websocket', companion: ['massimo-callegari-qlcplus'],
    summary: 'Start or stop a function.',
    docs: docs('https://docs.qlcplus.org/v5/advanced/web-interface/web-api', 'QLC+ web API', 'WebSocket ws://host:9999/qlcplusWS. QLC+API|setFunctionStatus|id|1 starts that function. A status of 0 stops it. The function id comes from QLC+API|getFunctionsList.'),
    connection: hostPort(9999, [str('path', 'Path', '/qlcplusWS')]),
    variables: [v('connected', 'Connected'), v('last', 'Last message')],
    feedbacks: [fb('connected', 'Sent')],
    actions: [
      act('start', 'Start function', 'hot', { type: 'websocket', text: 'QLC+API|setFunctionStatus|$(options:fn)|1' }, { text: 'GO', options: [num('fn', 'Function', 1)] }),
      act('stop', 'Stop function', 'toggle', { type: 'websocket', text: 'QLC+API|setFunctionStatus|$(options:fn)|0' }, { text: 'STOP', options: [num('fn', 'Function', 1)] }),
    ],
  }),
  defineSystem({
    id: 'cuety', label: 'Visual Productions Cuety', short: 'Cuety', category: 'lighting', manufacturer: 'Visual Productions', bar: '#F4A261',
    status: 'implemented', transport: 'udp', companion: ['visualproductions-cuety'],
    summary: 'Go or release a playback on an LPU-2.',
    docs: docs('https://ltb.no/media/multicase/documents/visual%20productions/manual%20visual%20cuety_en_11.pdf', 'Cuety manual', 'The LPU-2 listens on UDP port 7000. pb21/go+ goes forward on playback 21. pb10/re releases playback 10. The LPU-1 does not have this port.'),
    connection: hostPort(7000),
    variables: [v('connected', 'Connected'), v('udp.last', 'Last command')],
    feedbacks: [fb('connected', 'Sent')],
    actions: [
      act('go', 'Go playback', 'hot', { type: 'udp', payload: 'pb$(options:playback)/go+' }, { text: 'GO', options: [str('playback', 'Playback', '21')] }),
      act('release', 'Release playback', 'toggle', { type: 'udp', payload: 'pb$(options:playback)/re' }, { text: 'REL', options: [str('playback', 'Playback', '10')] }),
    ],
  }),
  defineSystem({
    id: 'racklink', label: 'Middle Atlantic RackLink', short: 'RackLink', category: 'utility', manufacturer: 'Middle Atlantic', bar: '#111111',
    status: 'implemented', transport: 'tcp', companion: ['middleatlantic-racklink'],
    summary: 'Log in, then turn outlet 1 on.',
    docs: docs('https://assets.grandandtoy.com/assets/Additional-pdf4/10/35/1035249455.pdf', 'RackLink control protocol', 'TCP port 60000. The protocol is off until it is enabled. The printed login frame is for user|password. The printed outlet frame 0xfe090020010101303030306aff turns outlet 1 on. 0xfe090020010200303030306aff turns outlet 2 off.'),
    connection: hostPort(60000),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected')],
    actions: [
      act('login', 'Log in', 'info', { type: 'line', encoding: 'hex', payload: 'fe10000201757365727c70617373776f72643fff' }, { text: 'LOGIN' }),
      act('on', 'Outlet 1 on', 'toggle', { type: 'line', encoding: 'hex', payload: 'fe090020010101303030306aff' }, { text: 'ON' }),
      act('off', 'Outlet 2 off', 'toggle', { type: 'line', encoding: 'hex', payload: 'fe090020010200303030306aff' }, { text: 'OFF', confirm: true }),
    ],
  }),
];

module.exports = { systems };
