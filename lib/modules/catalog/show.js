'use strict';
// Live-event consoles, multiview, recorders, PTZ, graphics and playout
// whose command line is in a manufacturer document.

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
function httpAct(id, label, role, method, path, extra = {}) {
  const execute = { type: 'http', method, path };
  if (extra.body != null) { execute.body = extra.body; execute.contentType = extra.contentType || 'application/json'; }
  return act(id, label, role, execute, extra);
}

const systems = [
  defineSystem({
    id: 'allenheath-avantis', label: 'Allen & Heath Avantis', short: 'Avantis', category: 'audio', manufacturer: 'Allen & Heath', bar: '#1F4B99',
    status: 'implemented', transport: 'tcp', companion: ['allenheath-avantis'],
    summary: 'Mute an input. The base MIDI channel on the desk is 12 unless you change it.',
    docs: docs('https://support.allen-heath.com/hc/en-gb/articles/45146889174801-Avantis-MIDI-TCP-IP-Protocol', 'Avantis MIDI TCP/IP protocol', 'TCP 51325. Mute on is note on, velocity 7F, then note off. Mute off is the same with velocity 3F. Input 1 is note 00 on the base MIDI channel. The article\'s default base channel is 12.'),
    connection: hostPort(51325, [num('midiChannel', 'Base MIDI channel', 12)]),
    variables: [v('connected', 'Connected'), v('channel', 'Last channel')],
    feedbacks: [fb('connected', 'Connected', ok)],
    actions: [
      act('mute', 'Mute input', 'toggle', { type: 'dlive', op: 'mute', on: 1, channel: '$(options:channel)' }, { text: 'MUTE', options: [num('channel', 'Input 1-96', 1)] }),
      act('unmute', 'Unmute input', 'toggle', { type: 'dlive', op: 'mute', on: 0, channel: '$(options:channel)' }, { options: [num('channel', 'Input 1-96', 1)] }),
    ],
  }),
  defineSystem({
    id: 'allenheath-cq', label: 'Allen & Heath CQ', short: 'CQ', category: 'audio', manufacturer: 'Allen & Heath', bar: '#1F4B99',
    status: 'implemented', transport: 'tcp', companion: ['allenheath-cq'],
    summary: 'Mute an input. CQ MIDI channel is 1.',
    docs: docs('https://www.allen-heath.com/content/uploads/2024/10/CQ_MIDI_Protocol_V1_2_0_iss4.pdf', 'CQ MIDI protocol V1.2', 'TCP 51325. Input 1 mute on is B0 63 00 B0 62 00 B0 06 00 B0 26 01. Mute off ends in B0 26 00. The input number is the LSB, so input 3 is LSB 02.'),
    connection: hostPort(51325, [num('midiChannel', 'MIDI channel', 1)]),
    variables: [v('connected', 'Connected'), v('last', 'Last bytes')],
    feedbacks: [fb('connected', 'Connected', ok)],
    actions: [
      act('mute', 'Mute input', 'toggle', { type: 'sq-mute', on: true }, { text: 'MUTE', options: [num('channel', 'Input', 1)] }),
      act('unmute', 'Unmute input', 'toggle', { type: 'sq-mute', on: false }, { options: [num('channel', 'Input', 1)] }),
    ],
  }),
  defineSystem({
    id: 'bmd-multiview', label: 'Blackmagic MultiView', short: 'MultiView', category: 'router', manufacturer: 'Blackmagic Design', bar: '#FF6A00',
    status: 'implemented', transport: 'tcp', companion: ['bmd-multiview4', 'bmd-multiview16'],
    summary: 'Route a view. Port numbers in the command start at 0.',
    docs: docs('https://documents.blackmagicdesign.com/UserManuals/BlackmagicMultiViewManual.pdf', 'Blackmagic MultiView manual', 'TCP 9990. The manual\'s example that routes output port 8 to input port 3 is the block VIDEO OUTPUT ROUTING, then 7 2, then a blank line. Lines end with a newline.'),
    connection: hostPort(9990),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', ok)],
    actions: [
      line('route', 'Route view', 'toggle', 'VIDEO OUTPUT ROUTING:\n$(options:output) $(options:input)\n\n', { text: 'ROUTE', options: [num('output', 'Output (0 = first)', 0), num('input', 'Input (0 = first)', 0)] }),
    ],
  }),
  defineSystem({
    id: 'bmd-cameras', label: 'Blackmagic camera', short: 'BMD cam', category: 'camera', manufacturer: 'Blackmagic Design', bar: '#FF6A00',
    status: 'implemented', transport: 'http', companion: ['bmd-cameras'],
    summary: 'Record and stop. The camera\'s web media manager has to be enabled.',
    docs: docs('https://documents.blackmagicdesign.com/DeveloperManuals/BlackmagicCameraControl.pdf', 'Blackmagic Camera Control REST API', 'POST /control/api/v1/transports/0/record starts a recording. POST /control/api/v1/transports/0/stop stops the transport. PUT /control/api/v1/livestreams/0/start and /stop start and stop the livestream. The base path is the camera address plus /control/api/v1/.'),
    connection: { fields: [{ id: 'host', type: 'string', label: 'Host', default: '' }, { id: 'port', type: 'number', label: 'Port', default: 443 }, { id: 'https', type: 'boolean', label: 'HTTPS', default: true }] },
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered', ok)],
    actions: [
      httpAct('record', 'Record', 'program', 'POST', '/control/api/v1/transports/0/record', { text: 'REC', confirm: true }),
      httpAct('stop', 'Stop', 'toggle', 'POST', '/control/api/v1/transports/0/stop', { text: 'STOP' }),
      httpAct('live', 'Stream start', 'toggle', 'PUT', '/control/api/v1/livestreams/0/start', { text: 'LIVE', confirm: true }),
      httpAct('liveStop', 'Stream stop', 'toggle', 'PUT', '/control/api/v1/livestreams/0/stop', { text: 'END' }),
    ],
  }),
  defineSystem({
    id: 'extron-smp351', label: 'Extron SMP 351', short: 'SMP 351', category: 'playback', manufacturer: 'Extron', bar: '#C41230',
    status: 'implemented', transport: 'tcp', companion: ['extron-smp351'],
    summary: 'Start, stop and pause the recording.',
    docs: docs('https://aca.im/driver_docs/Extron/extron_smp300_Series.pdf', 'Extron SMP 300 series user guide', 'Telnet TCP 23. The command table lists EY1RCDR} to start, EY0RCDR} to stop and EY2RCDR} to pause. The guide\'s examples name the SMP 351. A password, if one is set, is entered before these commands.'),
    connection: hostPort(23),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', ok)],
    actions: [
      line('record', 'Record', 'program', 'EY1RCDR}', { text: 'REC', confirm: true }),
      line('stop', 'Stop', 'toggle', 'EY0RCDR}', { text: 'STOP' }),
      line('pause', 'Pause', 'toggle', 'EY2RCDR}', { text: 'PAUSE' }),
    ],
  }),
  defineSystem({
    id: 'extron-pcs4', label: 'Extron IPL T PCS4', short: 'PCS4', category: 'utility', manufacturer: 'Extron', bar: '#C41230',
    status: 'implemented', transport: 'tcp', companion: ['extron-ipl-t-pcs4'],
    summary: 'Turn one receptacle on or off.',
    docs: docs('https://media.extron.com/public/download/files/userman/68-738-07_C_IPL_T_PCS4_UG.pdf', 'IPL T PCS4 user guide', 'Telnet TCP 23. Turn receptacle 1 on with W1*1PC| and off with W1*0PC|. The guide says a Telnet session may use the W form and the pipe in place of Escape and carriage return. The factory password is the serial number.'),
    connection: hostPort(23),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', ok)],
    actions: [
      line('on', 'Receptacle on', 'toggle', 'W$(options:port)*1PC|', { text: 'ON', options: [num('port', 'Receptacle 1-4', 1)] }),
      line('off', 'Receptacle off', 'toggle', 'W$(options:port)*0PC|', { text: 'OFF', confirm: true, options: [num('port', 'Receptacle 1-4', 1)] }),
    ],
  }),
  defineSystem({
    id: 'vaddio-ptz', label: 'Vaddio PTZ', short: 'Vaddio', category: 'camera', manufacturer: 'Vaddio', bar: '#0B6E4F',
    status: 'implemented', transport: 'tcp', companion: ['vaddio-ptz'],
    summary: 'Recall a preset or go home. The Telnet session has to be logged in first.',
    docs: docs('https://assetserver.net/_assets/vaddio/pdf/99999437000w-manual.pdf', 'Vaddio RoboSHOT NDI complete manual', 'Telnet TCP 23. camera preset recall 3 moves to preset 3. camera home returns home. Command lines end with a carriage return. The manual says the session requires the administrator login before commands are accepted.'),
    connection: hostPort(23),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', ok)],
    actions: [
      line('preset', 'Recall preset', 'memory', 'camera preset recall $(options:preset)\r', { text: 'PRE', options: [num('preset', 'Preset 1-16', 3)] }),
      line('home', 'Home', 'toggle', 'camera home\r', { text: 'HOME' }),
    ],
  }),
  defineSystem({
    id: 'aver-ptz', label: 'AVer PTZ', short: 'AVer', category: 'camera', manufacturer: 'AVer', bar: '#E10600',
    status: 'implemented', transport: 'visca', companion: ['aver-ptz'],
    summary: 'Power and preset 1. Preset 1 is the byte the guide prints.',
    docs: docs('https://www.averusa.com/pro-av/downloads/control-codes/AVer%20Pro-AV%20PTZ%20Visca%20over%20IP-UDP%20and%20RS-232%20Guide.pdf', 'AVer VISCA over IP guide', 'UDP 52381. Power on is 81 01 04 00 02 FF. Power off is 81 01 04 00 03 FF. Recall preset 1 is 81 01 04 3F 02 01 FF. The guide sends those bodies after the 8-byte VISCA-over-IP header.'),
    connection: hostPort(52381),
    variables: [v('connected', 'Connected')],
    feedbacks: [fb('connected', 'Connected', ok)],
    actions: [
      act('on', 'Power on', 'toggle', { type: 'visca', bytes: [0x81, 0x01, 0x04, 0x00, 0x02, 0xFF] }, { text: 'ON' }),
      act('off', 'Power off', 'toggle', { type: 'visca', bytes: [0x81, 0x01, 0x04, 0x00, 0x03, 0xFF] }, { text: 'OFF', confirm: true }),
      act('preset', 'Preset 1', 'memory', { type: 'visca', bytes: [0x81, 0x01, 0x04, 0x3F, 0x02, 0x01, 0xFF] }, { text: 'PRE' }),
    ],
  }),
  defineSystem({
    id: 'yamaha-dm', label: 'Yamaha DM3', short: 'DM3', category: 'audio', manufacturer: 'Yamaha', bar: '#4C1D95',
    status: 'implemented', transport: 'udp', companion: ['yamaha-dm'],
    summary: 'Turn an input on or off, and recall a Scene A.',
    docs: docs('https://usa.yamaha.com/files/download/other_assets/2/2063222/DM3_osc_specs_v100_en.pdf', 'DM3 series OSC specifications', 'UDP 49900. Channel 1 on is /yosc:req/set/MIXER:Current/InCh/Fader/On/1/1 with integer 1. Off is the same address with integer 0. Scene A05 is /yosc:req/ssrecall_ex with the string scene_a and the integer 5.'),
    connection: hostPort(49900),
    variables: [v('connected', 'Connected'), v('last', 'Last address')],
    feedbacks: [fb('connected', 'Sent', ok)],
    actions: [
      act('on', 'Input on', 'toggle', { type: 'osc', address: '/yosc:req/set/MIXER:Current/InCh/Fader/On/$(options:channel)/1', args: [1] }, { options: [num('channel', 'Input', 1)] }),
      act('off', 'Input off', 'toggle', { type: 'osc', address: '/yosc:req/set/MIXER:Current/InCh/Fader/On/$(options:channel)/1', args: [0] }, { options: [num('channel', 'Input', 1)] }),
      act('scene', 'Recall scene A', 'memory', { type: 'osc', address: '/yosc:req/ssrecall_ex', args: ['scene_a', '$(options:scene)'] }, { text: 'SCENE', confirm: true, options: [num('scene', 'Scene A 0-99', 5)] }),
    ],
  }),
  defineSystem({
    id: 'sennheiser-tcc2', label: 'Sennheiser TeamConnect Ceiling 2', short: 'TCC2', category: 'audio', manufacturer: 'Sennheiser', bar: '#111111',
    status: 'implemented', transport: 'udp', companion: ['sennheiser-teamconnect-ceiling'],
    summary: 'Mute one output or every output on the ceiling mic.',
    docs: docs('https://assets.sennheiser.com/download/assets/TI_1245_v1.8.0_Sennheiser_Sound_Control_Protocol_TCC2_EN.pdf/c204169ce7bb11f0a354ea55b5d2fb86', 'Sennheiser SSC for TeamConnect Ceiling 2', 'UDP port 45, one JSON message per datagram. Mute XLR 1 with {"out1":{"xlr1":{"mute":true}}}. Mute every output with {"out1":{"*":{"mute":true}}}. The same document\'s false value clears the mute.'),
    connection: hostPort(45),
    variables: [v('connected', 'Connected')],
    feedbacks: [fb('connected', 'Sent', ok)],
    actions: [
      act('mute', 'Mute XLR 1', 'toggle', { type: 'udp', payload: '{"out1":{"xlr1":{"mute":true}}}', encoding: 'ascii' }, { text: 'MUTE' }),
      act('unmute', 'Unmute XLR 1', 'toggle', { type: 'udp', payload: '{"out1":{"xlr1":{"mute":false}}}', encoding: 'ascii' }),
      act('muteAll', 'Mute all', 'toggle', { type: 'udp', payload: '{"out1":{"*":{"mute":true}}}', encoding: 'ascii' }, { text: 'ALL', confirm: true }),
    ],
  }),
  defineSystem({
    id: 'sennheiser-ewdx', label: 'Sennheiser EW-DX', short: 'EW-DX', category: 'audio', manufacturer: 'Sennheiser', bar: '#111111',
    status: 'implemented', transport: 'udp', companion: ['sennheiser-ewdx'],
    summary: 'Mute receiver channel 1 or 2.',
    docs: docs('https://docs.cloud.sennheiser.com/en-us/api-docs/resources/ew-dx-sound-control-protocol-3-0-x.pdf', 'EW-DX SSC developer guide', 'UDP port 45. /rx1/mute and /rx2/mute are booleans. The guide\'s JSON form for a receiver value is {"rx1":{"mute":true}}. EW-DX in this guide speaks UDP only.'),
    connection: hostPort(45),
    variables: [v('connected', 'Connected')],
    feedbacks: [fb('connected', 'Sent', ok)],
    actions: [
      act('mute1', 'Mute RX 1', 'toggle', { type: 'udp', payload: '{"rx1":{"mute":true}}', encoding: 'ascii' }, { text: 'RX1' }),
      act('unmute1', 'Unmute RX 1', 'toggle', { type: 'udp', payload: '{"rx1":{"mute":false}}', encoding: 'ascii' }),
      act('mute2', 'Mute RX 2', 'toggle', { type: 'udp', payload: '{"rx2":{"mute":true}}', encoding: 'ascii' }, { text: 'RX2' }),
      act('unmute2', 'Unmute RX 2', 'toggle', { type: 'udp', payload: '{"rx2":{"mute":false}}', encoding: 'ascii' }),
    ],
  }),
  defineSystem({
    id: 'ross-videoserver', label: 'Ross video server', short: 'Ross server', category: 'playback', manufacturer: 'Ross Video', bar: '#C8102E',
    status: 'implemented', transport: 'tcp', companion: ['rossvideo-videoserver'],
    summary: 'Cue, play and stop a channel on Mira, Tria or Kiva.',
    docs: docs('https://documentation.rossvideo.com/files/Manuals/Protocol%20Documents/RossTalk-Commands(4802DR-403).pdf', 'RossTalk commands, video server section', 'TCP 7788. Each command ends with CR LF. PLAY B plays channel B. CUE D:crime-report loads that clip. STOP F stops channel F.'),
    connection: hostPort(7788),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', ok)],
    actions: [
      line('cue', 'Cue clip', 'preview', 'CUE $(options:channel):$(options:clip)\r\n', { text: 'CUE', options: [str('channel', 'Channel', 'D'), str('clip', 'Clip', 'crime-report')] }),
      line('play', 'Play', 'program', 'PLAY $(options:channel)\r\n', { text: 'PLAY', options: [str('channel', 'Channel', 'B')] }),
      line('stop', 'Stop', 'toggle', 'STOP $(options:channel)\r\n', { text: 'STOP', options: [str('channel', 'Channel', 'F')] }),
    ],
  }),
  defineSystem({
    id: 'ross-caprica', label: 'Ross Caprica', short: 'Caprica', category: 'switcher', manufacturer: 'Ross Video', bar: '#C8102E',
    status: 'implemented', transport: 'tcp', companion: ['rossvideo-caprica'],
    summary: 'Cut the switcher, run a custom control, and mute audio.',
    docs: docs('https://documentation.rossvideo.com/files/Manuals/Automation%20&%20Control/Caprica/Device%20Setup%20Sheets/RossTalk/RossTalk-IN.pdf', 'Caprica RossTalk-IN', 'TCP 7788. Commands end with CR LF. SW MECUT : ME : 0 cuts program, where 0 is the program ME. CC : 1 : 5 runs bank 1 button 5. AM MUTE : ALL : MUTE : On mutes every audio channel.'),
    connection: hostPort(7788),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', ok)],
    actions: [
      line('cut', 'Cut', 'hot', 'SW MECUT : ME : $(options:me)\r\n', { text: 'CUT', options: [str('me', 'ME (0 = program)', '0')] }),
      line('cc', 'Custom control', 'macro', 'CC : $(options:bank) : $(options:button)\r\n', { text: 'CC', options: [str('bank', 'Bank', '1'), str('button', 'Button', '5')] }),
      line('mute', 'Mute all audio', 'toggle', 'AM MUTE : ALL : MUTE : On\r\n', { text: 'MUTE', confirm: true }),
      line('unmute', 'Unmute all audio', 'toggle', 'AM MUTE : ALL : MUTE : Off\r\n'),
    ],
  }),
  defineSystem({
    id: 'viz-trio', label: 'Viz Trio', short: 'Trio', category: 'graphics', manufacturer: 'Vizrt', bar: '#00A3E0',
    status: 'implemented', transport: 'tcp', companion: ['vizrt-tcp-engine-trio'],
    summary: 'Read, take and take out a page. Trio has to be a socket server on 6200.',
    docs: docs('https://documentation.vizrt.com/viz-trio-guide-4.4.pdf', 'Viz Trio user guide', 'TCP 6200. The guide\'s telnet example is page:read 1000 followed by Enter. page:take 1000 plays that page. page:takeout 1000 takes it out. Enter on the socket is CR LF.'),
    connection: hostPort(6200),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', ok)],
    actions: [
      line('read', 'Read page', 'preview', 'page:read $(options:page)\r\n', { text: 'READ', options: [str('page', 'Page', '1000')] }),
      line('take', 'Take page', 'program', 'page:take $(options:page)\r\n', { text: 'TAKE', options: [str('page', 'Page', '1000')] }),
      line('takeout', 'Take out', 'toggle', 'page:takeout $(options:page)\r\n', { text: 'OUT', confirm: true, options: [str('page', 'Page', '1000')] }),
    ],
  }),
  defineSystem({
    id: 'picturall', label: 'Analog Way Picturall', short: 'Picturall', category: 'playback', manufacturer: 'Analog Way', bar: '#E85D04',
    status: 'implemented', transport: 'tcp', companion: ['analogway-picturall'],
    summary: 'Select a media slot and set a layer.',
    docs: docs('https://s3.eu-west-3.amazonaws.com/aw.store01/Site+Internet/Series/Picturall+Mark+I/Common/User+Manual/user-manual-picturall-media-server-3.5.3.pdf', 'Picturall series user manual', 'TCP 11000. wait_startup waits for the show to finish loading. set source1 selection slot=3,collection=2 selects that media. set layer1 composition time=1.5 intensity=1.0,x=1.0 is the manual\'s layer example.'),
    connection: hostPort(11000),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', ok)],
    actions: [
      line('wait', 'Wait for startup', 'toggle', 'wait_startup\r\n', { text: 'WAIT' }),
      line('select', 'Select media', 'preview', 'set source$(options:layer) selection slot=$(options:slot),collection=$(options:collection)\r\n', { text: 'SEL', options: [num('layer', 'Layer', 1), num('slot', 'Slot', 3), num('collection', 'Collection', 2)] }),
      line('layer', 'Set layer', 'program', 'set layer$(options:layer) composition time=$(options:time) intensity=$(options:level),x=$(options:x)\r\n', { text: 'LAY', options: [num('layer', 'Layer', 1), str('time', 'Time', '1.5'), str('level', 'Intensity', '1.0'), str('x', 'X', '1.0')] }),
    ],
  }),
  defineSystem({
    id: 'disguise-osc', label: 'disguise', short: 'disguise', category: 'playback', manufacturer: 'disguise', bar: '#111111',
    status: 'implemented', transport: 'udp', companion: ['disguise-osc'],
    summary: 'Play, stop, cue and hold the timeline.',
    docs: docs('https://help.disguise.one/designer/timeline-tracks-transports/osc/controlling', 'disguise OSC transport control', 'The OSC device receive port defaults to 7401. /d3/showcontrol/play starts playback. /d3/showcontrol/stop stops it. /d3/showcontrol/cue takes one cue number. /d3/showcontrol/hold freezes the outputs. /d3/showcontrol/fadedown fades the master brightness down.'),
    connection: hostPort(7401),
    variables: [v('connected', 'Connected'), v('last', 'Last address')],
    feedbacks: [fb('connected', 'Sent', ok)],
    actions: [
      act('play', 'Play', 'program', { type: 'osc', address: '/d3/showcontrol/play', args: [] }, { text: 'PLAY' }),
      act('stop', 'Stop', 'toggle', { type: 'osc', address: '/d3/showcontrol/stop', args: [] }, { text: 'STOP' }),
      act('cue', 'Cue', 'memory', { type: 'osc', address: '/d3/showcontrol/cue', args: ['$(options:cue)'] }, { text: 'CUE', options: [num('cue', 'Cue', 1)] }),
      act('hold', 'Hold', 'toggle', { type: 'osc', address: '/d3/showcontrol/hold', args: [] }, { text: 'HOLD', confirm: true }),
      act('down', 'Fade down', 'toggle', { type: 'osc', address: '/d3/showcontrol/fadedown', args: [] }, { text: 'DOWN', confirm: true }),
    ],
  }),
  defineSystem({
    id: 'spx-graphics', label: 'SPX Graphics', short: 'SPX', category: 'graphics', manufacturer: 'SPX Graphics', bar: '#7C3AED',
    status: 'implemented', transport: 'http', companion: ['spx-graphics-controller'],
    summary: 'Play the current item, read status, or clear the output.',
    docs: docs('https://docs.spxgraphics.com/Documentation/Control+Interfaces/REST/Overview+of+SPX+API', 'SPX API overview', 'The documented play request is GET http://localhost:5656/api/v1/rundown/play. Status is GET /api/v1/rundown/status. Clear is GET /api/v1/panic. An API key, when set, is the apikey query.'),
    connection: hostPort(5656),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered', ok)],
    actions: [
      httpAct('play', 'Play', 'program', 'GET', '/api/v1/rundown/play', { text: 'PLAY' }),
      httpAct('status', 'Status', 'info', 'GET', '/api/v1/rundown/status', { text: 'STAT' }),
      httpAct('panic', 'Clear', 'toggle', 'GET', '/api/v1/panic', { text: 'CLR', confirm: true }),
    ],
  }),
  defineSystem({
    id: 'viz-flowics', label: 'Viz Flowics', short: 'Flowics', category: 'graphics', manufacturer: 'Vizrt', bar: '#00A3E0',
    status: 'implemented', transport: 'http', companion: ['vizrt-flowics'],
    summary: 'Read a graphics output and its overlays. The package token is in the path.',
    docs: docs('https://postman.flowics.com/', 'Viz Flowics control API', 'GET https://api.flowics.com/graphics/:graphicsToken/control reads the output. GET .../control/overlays lists the overlays. The take request is described on that page without a path that was safe to copy, so these buttons only send the two published GETs.'),
    connection: { fields: [{ id: 'host', type: 'string', label: 'Host', default: 'api.flowics.com' }, { id: 'port', type: 'number', label: 'Port', default: 443 }, { id: 'https', type: 'boolean', label: 'HTTPS', default: true }] },
    variables: [v('connected', 'Connected'), v('http.status', 'Last status'), v('http.body', 'Last body')],
    feedbacks: [fb('connected', 'Answered', ok)],
    actions: [
      httpAct('output', 'Read output', 'info', 'GET', '/graphics/$(options:token)/control', { text: 'OUT', options: [str('token', 'Graphics token', '')] }),
      httpAct('overlays', 'List overlays', 'info', 'GET', '/graphics/$(options:token)/control/overlays', { text: 'LIST', options: [str('token', 'Graphics token', '')] }),
    ],
  }),
  defineSystem({
    id: 'wled', label: 'WLED', short: 'WLED', category: 'lighting', manufacturer: 'WLED', bar: '#F59E0B',
    status: 'implemented', transport: 'http', companion: ['wled-websocket'],
    summary: 'Turn the light on, set brightness, or recall a preset.',
    docs: docs('https://kno.wled.ge/interfaces/json-api/', 'WLED JSON API', 'POST /json/state with {"on":true,"bri":255} turns the light on at full brightness. {"on":false} turns it off. {"ps":1} recalls preset 1. The same state is what the websocket carries; these buttons use the JSON HTTP call the API page prints.'),
    connection: hostPort(80),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered', ok)],
    actions: [
      httpAct('on', 'On', 'toggle', 'POST', '/json/state', { text: 'ON', body: '{"on":true,"bri":$(options:bri)}', options: [num('bri', 'Brightness 1-255', 255)] }),
      httpAct('off', 'Off', 'toggle', 'POST', '/json/state', { text: 'OFF', body: '{"on":false}', confirm: true }),
      httpAct('preset', 'Preset', 'memory', 'POST', '/json/state', { text: 'PRE', body: '{"ps":$(options:preset)}', options: [num('preset', 'Preset', 1)] }),
    ],
  }),
];

module.exports = { systems };
