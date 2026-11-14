'use strict';
// PDUs, cameras, graphics and timers whose command line is in a manufacturer document.

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
  if (extra.body != null) {
    execute.body = extra.body;
    execute.contentType = extra.contentType || 'application/json';
  }
  if (extra.headers) execute.headers = extra.headers;
  return act(id, label, role, execute, extra);
}

const systems = [
  defineSystem({
    id: 'apc-rackpdu', label: 'APC switched rack PDU', short: 'APC PDU', category: 'utility', manufacturer: 'APC', bar: '#E85D04',
    status: 'implemented', transport: 'tcp', companion: ['apc-rackpdu'],
    summary: 'Turn an outlet on or off. Log on with the password and -c before these lines.',
    docs: docs('https://www.se.com/us/en/faqs/FA156163/', 'APC switched rack PDU command line', 'The CLI guide\'s outlet commands are on 1 and off 1, then Enter. Telnet is one of the three ways in. The same guide is only for switched rack PDUs, not meter-only PDUs and not the UPS.'),
    connection: hostPort(23),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', ok)],
    actions: [
      line('on', 'Outlet on', 'toggle', 'on $(options:outlet)\r', { text: 'ON', options: [num('outlet', 'Outlet', 1)] }),
      line('off', 'Outlet off', 'toggle', 'off $(options:outlet)\r', { text: 'OFF', confirm: true, options: [num('outlet', 'Outlet', 1)] }),
    ],
  }),
  defineSystem({
    id: 'gude-pdu', label: 'Gude Expert Power Control', short: 'Gude', category: 'utility', manufacturer: 'Gude', bar: '#0B6E4F',
    status: 'implemented', transport: 'http', companion: ['gudesystems-smartpdu'],
    summary: 'Switch one output on or off.',
    docs: docs('https://wiki.gude-systems.com/EPC_HTTP_Interface', 'Gude EPC HTTP interface', 'GET /ov.html?cmd=1&p=1&s=1 switches output 1 on. s=0 switches it off. cmd=1 is the output-switching command.'),
    connection: hostPort(80, [str('username', 'User', ''), str('password', 'Password', ''), str('authType', 'Auth', 'basic')]),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered', ok)],
    actions: [
      httpAct('on', 'Output on', 'toggle', 'GET', '/ov.html?cmd=1&p=$(options:output)&s=1', { text: 'ON', options: [num('output', 'Output', 1)] }),
      httpAct('off', 'Output off', 'toggle', 'GET', '/ov.html?cmd=1&p=$(options:output)&s=0', { text: 'OFF', confirm: true, options: [num('output', 'Output', 1)] }),
    ],
  }),
  defineSystem({
    id: 'neol-epowerswitch', label: 'Neol ePowerSwitch', short: 'ePower', category: 'utility', manufacturer: 'Neol', bar: '#1F4B99',
    status: 'implemented', transport: 'http', companion: ['neol-epowerswitch'],
    summary: 'Turn a hidden-page outlet on, off, or restart it.',
    docs: docs('https://www.kvm-concepts.de/wp-content/uploads/neol_epowerswitch_4iec_manual.pdf', 'ePowerSwitch 4IEC user guide', 'The hidden page command is M0:O1=ON, OFF, or RESTART. The guide\'s example is http://192.168.100.200/hidden.htm?M0:O1=OFF&M0:O3=OFF. The hidden-page account has to be activated first.'),
    connection: hostPort(80),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered', ok)],
    actions: [
      httpAct('on', 'Outlet on', 'toggle', 'GET', '/hidden.htm?M0:O$(options:outlet)=ON', { text: 'ON', options: [num('outlet', 'Outlet 1-4', 1)] }),
      httpAct('off', 'Outlet off', 'toggle', 'GET', '/hidden.htm?M0:O$(options:outlet)=OFF', { text: 'OFF', confirm: true, options: [num('outlet', 'Outlet 1-4', 1)] }),
      httpAct('restart', 'Restart outlet', 'toggle', 'GET', '/hidden.htm?M0:O$(options:outlet)=RESTART', { text: 'RST', confirm: true, options: [num('outlet', 'Outlet 1-4', 1)] }),
    ],
  }),
  defineSystem({
    id: 'dataprobe-iboot', label: 'Dataprobe iBoot PDU', short: 'iBoot', category: 'utility', manufacturer: 'Dataprobe', bar: '#C41230',
    status: 'implemented', transport: 'http', companion: ['dataprobe-iboot-pdu'],
    summary: 'Turn an outlet on or off. The token comes from /services/auth/.',
    docs: docs('https://44852427.fs1.hubspotusercontent-na1.net/hubfs/44852427/Dataprobe_February_2024/Pdf/iboot-pdu_restful_api.pdf', 'iBoot-PDU REST API', 'POST /services/control/ with control outlet, command on or off, and an outlets array. The token is the one returned by /services/auth/.'),
    connection: hostPort(80),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered', ok)],
    actions: [
      httpAct('on', 'Outlet on', 'toggle', 'POST', '/services/control/', { text: 'ON', body: '{"token":"$(options:token)","control":"outlet","command":"on","outlets":[$(options:outlet)]}', options: [str('token', 'Token', ''), num('outlet', 'Outlet', 1)] }),
      httpAct('off', 'Outlet off', 'toggle', 'POST', '/services/control/', { text: 'OFF', confirm: true, body: '{"token":"$(options:token)","control":"outlet","command":"off","outlets":[$(options:outlet)]}', options: [str('token', 'Token', ''), num('outlet', 'Outlet', 1)] }),
    ],
  }),
  defineSystem({
    id: 'aten-pdu', label: 'ATEN PDU', short: 'ATEN PDU', category: 'utility', manufacturer: 'ATEN', bar: '#E85D04',
    status: 'implemented', transport: 'http', companion: ['aten-pdu'],
    summary: 'Switch one outlet. The body is the form the ATEN guide prints.',
    docs: docs('https://assets.aten.com/product/manual/Restful-API-Guide-for-PDU_2022-11-18.pdf', 'ATEN PDU REST API', 'POST /api/outlet/relay with usr, pwd, index and method. method=on turns the outlet on. method=off turns it off. The guide\'s example is outlet 1 off.'),
    connection: { fields: [{ id: 'host', type: 'string', label: 'Host', default: '' }, { id: 'port', type: 'number', label: 'Port', default: 443 }, { id: 'https', type: 'boolean', label: 'HTTPS', default: true }] },
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered', ok)],
    actions: [
      httpAct('on', 'Outlet on', 'toggle', 'POST', '/api/outlet/relay', { text: 'ON', contentType: 'application/x-www-form-urlencoded', body: 'usr=$(options:user)&pwd=$(options:pass)&index=$(options:index)&method=on', options: [str('user', 'User', ''), str('pass', 'Password', ''), num('index', 'Outlet', 1)] }),
      httpAct('off', 'Outlet off', 'toggle', 'POST', '/api/outlet/relay', { text: 'OFF', confirm: true, contentType: 'application/x-www-form-urlencoded', body: 'usr=$(options:user)&pwd=$(options:pass)&index=$(options:index)&method=off', options: [str('user', 'User', ''), str('pass', 'Password', ''), num('index', 'Outlet', 1)] }),
    ],
  }),
  defineSystem({
    id: 'audiotechnica-atdm', label: 'Audio-Technica ATDM', short: 'ATDM', category: 'audio', manufacturer: 'Audio-Technica', bar: '#111111',
    status: 'implemented', transport: 'tcp', companion: ['audiotechnica-digitalmixer'],
    summary: 'Mute an output or the array mic on an ATDM-0604.',
    docs: docs('https://docs.audio-technica.com/us/ATDM-0604_IP_Control_Protcol_Specification_EN_Ver1.1.3_web_200821.pdf', 'ATDM-0604 IP control protocol', 'TCP 17300. Commands are space-separated and end with CR. s_output_mute S 0000 00 NC 0,1 mutes output 1. s_arraymic_mute S 0000 00 NC 1 mutes the array mic. 0 on the mute field is off.'),
    connection: hostPort(17300),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', ok)],
    actions: [
      line('mute', 'Mute output', 'toggle', 's_output_mute S 0000 00 NC $(options:output),1\r', { text: 'MUTE', options: [num('output', 'Output (0 = 1)', 0)] }),
      line('unmute', 'Unmute output', 'toggle', 's_output_mute S 0000 00 NC $(options:output),0\r', { options: [num('output', 'Output (0 = 1)', 0)] }),
      line('mic', 'Mute array mic', 'toggle', 's_arraymic_mute S 0000 00 NC 1\r', { text: 'MIC' }),
      line('micOpen', 'Unmute array mic', 'toggle', 's_arraymic_mute S 0000 00 NC 0\r'),
    ],
  }),
  defineSystem({
    id: 'biamp-audia', label: 'Biamp Audia', short: 'Audia', category: 'audio', manufacturer: 'Biamp', bar: '#5B7C99',
    status: 'implemented', transport: 'tcp', companion: ['biamp-audia'],
    summary: 'Recall a preset. The string ends with a line feed.',
    docs: docs('https://support.biamp.com/Audia-Nexia/Control/Audia-Nexia_Text_Protocol', 'Audia/Nexia text protocol', 'Telnet. Each string ends with line feed. The worked recall is RECALL 0 PRESET 1004. The worked level bump is INC 3 FDRLVL 2 4 2. Tesira is a different protocol and stays on its own system.'),
    connection: hostPort(23),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', ok)],
    actions: [
      line('preset', 'Recall preset', 'memory', 'RECALL 0 PRESET $(options:preset)\n', { text: 'PRE', confirm: true, options: [num('preset', 'Preset', 1004)] }),
      line('bump', 'Bump level', 'toggle', 'INC $(options:device) FDRLVL $(options:instance) $(options:index) $(options:amount)\n', { text: 'LVL', options: [num('device', 'Device', 3), num('instance', 'Instance', 2), num('index', 'Index', 4), num('amount', 'dB', 2)] }),
    ],
  }),
  defineSystem({
    id: 'sony-bravia', label: 'Sony Bravia', short: 'Bravia', category: 'display', manufacturer: 'Sony', bar: '#111111',
    status: 'implemented', transport: 'http', companion: ['sony-bravia'],
    summary: 'Select an HDMI input. Simple IP control stays on its own system.',
    docs: docs('https://pro-bravia.sony.net/remote-display-control/rest-api/guide/', 'Bravia professional REST API', 'POST /sony/avContent with method setPlayContent, version 1.0, and params uri extInput:hdmi?port=2. The pre-shared key goes in the X-Auth-PSK header. This is the professional REST call, not the Simple IP packet already used for Bravia Simple IP.'),
    connection: hostPort(80, [str('psk', 'Pre-shared key', '')]),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered', ok)],
    actions: [
      httpAct('hdmi', 'HDMI', 'toggle', 'POST', '/sony/avContent', { text: 'HDMI', headers: 'X-Auth-PSK: $(conn:psk)', body: '{"method":"setPlayContent","version":"1.0","id":1,"params":[{"uri":"extInput:hdmi?port=$(options:port)}"]}', options: [num('port', 'HDMI port', 2)] }),
    ],
  }),
  defineSystem({
    id: 'denon-dn500', label: 'Denon DN-500BD MKII', short: 'DN-500', category: 'playback', manufacturer: 'Denon', bar: '#111111',
    status: 'implemented', transport: 'tcp', companion: ['denon-dn-500bd-mkii'],
    summary: 'Power, mute and eject. The packet is the host command from the protocol guide.',
    docs: docs('https://cdn.inmusicbrands.com/DenonPro/cdn/1841/documents/DN-500BD_MKII_Protocol_Guide_v1.1.pdf', 'DN-500BD MKII protocol guide', 'Power on is @0PW00 and power off is @0PW01, each ending in CR. Mute on is @0mt00 and mute off is @0mt01. Eject is @0PCDTRYOP. The guide describes the host packet. Set the port to the player\'s IP control socket; the guide itself prints the RS-232 form and does not print a TCP port.'),
    connection: hostPort(9030),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', ok)],
    actions: [
      line('on', 'Power on', 'toggle', '@0PW00\r', { text: 'ON' }),
      line('off', 'Power off', 'toggle', '@0PW01\r', { text: 'OFF', confirm: true }),
      line('mute', 'Mute', 'toggle', '@0mt00\r', { text: 'MUTE' }),
      line('unmute', 'Unmute', 'toggle', '@0mt01\r'),
      line('eject', 'Eject', 'toggle', '@0PCDTRYOP\r', { text: 'EJ', confirm: true }),
    ],
  }),
  defineSystem({
    id: 'foscam-ptz', label: 'Foscam PTZ', short: 'Foscam', category: 'camera', manufacturer: 'Foscam', bar: '#0B6E4F',
    status: 'implemented', transport: 'http', companion: ['foscam-ptz'],
    summary: 'Move, stop, and recall a named preset.',
    docs: docs('https://www.alarmforum.de/attachment.php?aid=2467', 'Foscam IP camera CGI user guide', 'The guide is copyright Shenzhen Foscam. ptzMoveUp, ptzStopRun and ptzGotoPresetPoint are CGIProxy.fcgi commands. The preset example is name=test. The user and password travel in the query, which is the form the guide prints. One of its examples uses port 88.'),
    connection: hostPort(88, [str('username', 'User', 'admin'), str('password', 'Password', '')]),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered', ok)],
    actions: [
      httpAct('up', 'Tilt up', 'toggle', 'GET', '/cgi-bin/CGIProxy.fcgi?cmd=ptzMoveUp&usr=$(conn:username)&pwd=$(conn:password)', { text: 'UP' }),
      httpAct('stop', 'Stop', 'toggle', 'GET', '/cgi-bin/CGIProxy.fcgi?cmd=ptzStopRun&usr=$(conn:username)&pwd=$(conn:password)', { text: 'STOP' }),
      httpAct('preset', 'Preset', 'memory', 'GET', '/cgi-bin/CGIProxy.fcgi?cmd=ptzGotoPresetPoint&name=$(options:name)&usr=$(conn:username)&pwd=$(conn:password)', { text: 'PRE', options: [str('name', 'Preset name', 'test')] }),
    ],
  }),
  defineSystem({
    id: 'zoneminder', label: 'ZoneMinder', short: 'ZM', category: 'camera', manufacturer: 'ZoneMinder', bar: '#7C3AED',
    status: 'implemented', transport: 'http', companion: ['zoneminder-camera'],
    summary: 'Force a monitor alarm on or off.',
    docs: docs('https://zoneminder.readthedocs.io/en/stable/api.html', 'ZoneMinder API', 'GET /zm/api/monitors/alarm/id:1/command:on.json forces monitor 1 into alarm. command:off.json clears it. The path uses colons the way the API page prints them.'),
    connection: hostPort(80),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered', ok)],
    actions: [
      httpAct('on', 'Alarm on', 'program', 'GET', '/zm/api/monitors/alarm/id:$(options:monitor)/command:on.json', { text: 'ALM', confirm: true, options: [num('monitor', 'Monitor', 1)] }),
      httpAct('off', 'Alarm off', 'toggle', 'GET', '/zm/api/monitors/alarm/id:$(options:monitor)/command:off.json', { text: 'CLR', options: [num('monitor', 'Monitor', 1)] }),
    ],
  }),
  defineSystem({
    id: 'lilliput-matrix', label: 'Lilliput matrix', short: 'Lilliput', category: 'router', manufacturer: 'Lilliput', bar: '#E85D4C',
    status: 'implemented', transport: 'udp', companion: ['lilliput-monitor'],
    summary: 'Route an input to an output. The line ends with a period.',
    docs: docs('https://www.lilliputuk.com/assets/downloads/MSS0811-API-Guide.pdf', 'Lilliput matrix API guide', 'UDP port 7000. The ASCII command 1v2. routes input 1 to output 2. Every instruction ends with a period.'),
    connection: hostPort(7000),
    variables: [v('connected', 'Connected')],
    feedbacks: [fb('connected', 'Sent', ok)],
    actions: [
      act('route', 'Route', 'toggle', { type: 'udp', payload: '$(options:input)v$(options:output).', encoding: 'ascii' }, { text: 'RTE', options: [num('input', 'Input', 1), num('output', 'Output', 2)] }),
    ],
  }),
  defineSystem({
    id: 'h2r-graphics', label: 'H2R Graphics', short: 'H2R', category: 'graphics', manufacturer: 'H2R Graphics', bar: '#7C3AED',
    status: 'implemented', transport: 'http', companion: ['h2r-graphics'],
    summary: 'Run the rundown, show a graphic, or start its timer.',
    docs: docs('https://h2r.graphics/docs/api/http/', 'H2R Graphics HTTP API', 'Port 4001. If the rundown URL ends in /rundown/ABCD/, the API base is /api/ABCD/. POST /run runs the rundown. POST /clear clears it. POST /graphic/<id>/show shows that graphic. POST /graphic/<id>/timer/run starts its speaker timer.'),
    connection: hostPort(4001, [str('project', 'Project id', '')]),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered', ok)],
    actions: [
      httpAct('run', 'Run', 'program', 'POST', '/api/$(conn:project)/run', { text: 'RUN' }),
      httpAct('clear', 'Clear', 'toggle', 'POST', '/api/$(conn:project)/clear', { text: 'CLR', confirm: true }),
      httpAct('show', 'Show graphic', 'program', 'POST', '/api/$(conn:project)/graphic/$(options:graphic)/show', { text: 'SHOW', options: [str('graphic', 'Graphic id', '')] }),
      httpAct('timer', 'Timer run', 'toggle', 'POST', '/api/$(conn:project)/graphic/$(options:graphic)/timer/run', { text: 'TIME', options: [str('graphic', 'Graphic id', '')] }),
    ],
  }),
  defineSystem({
    id: 'viz-mosart', label: 'Viz Mosart', short: 'Mosart', category: 'graphics', manufacturer: 'Vizrt', bar: '#00A3E0',
    status: 'implemented', transport: 'http', companion: ['vizrt-mosart'],
    summary: 'Take the next story, or take a graphic by name.',
    docs: docs('https://documentation.vizrt.com/viz-mosart-admin-guide/5.13/Mosart_Remote_Control_REST_API.html', 'Mosart remote control REST API', 'The service listens on port 55167. GET /api/v1/command/start-continue takes the next item. POST /api/v1/assets/graphics/take?name= takes a graphic by its slug. The curl example sends X-API-Key.'),
    connection: hostPort(55167, [str('key', 'API key', '')]),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered', ok)],
    actions: [
      httpAct('next', 'Take next', 'hot', 'GET', '/api/v1/command/start-continue', { text: 'NEXT', headers: 'X-API-Key: $(conn:key)' }),
      httpAct('take', 'Take graphic', 'program', 'POST', '/api/v1/assets/graphics/take?name=$(options:name)', { text: 'TAKE', headers: 'X-API-Key: $(conn:key)', options: [str('name', 'Graphic name', '')] }),
      httpAct('out', 'Take out graphic', 'toggle', 'POST', '/api/v1/assets/graphics/take-out?name=$(options:name)', { text: 'OUT', confirm: true, headers: 'X-API-Key: $(conn:key)', options: [str('name', 'Graphic name', '')] }),
    ],
  }),
  defineSystem({
    id: 'cuetimer', label: 'CueTimer', short: 'CueTimer', category: 'show', manufacturer: 'PresentationTools', bar: '#F4A261',
    status: 'implemented', transport: 'udp', companion: ['presentationtools-cuetimer'],
    summary: 'Start, stop, pause, or fire one timer.',
    docs: docs('https://cuetimer.com/userguide/', 'CueTimer user guide', 'Incoming OSC is UDP 4779. /global/fire starts. /global/cue stops. /global/pause pauses. /global/restart restarts. /timer/fire with the timer id string fires that timer. Incoming OSC has to be enabled in the app.'),
    connection: hostPort(4779),
    variables: [v('connected', 'Connected'), v('last', 'Last address')],
    feedbacks: [fb('connected', 'Sent', ok)],
    actions: [
      act('fire', 'Start', 'program', { type: 'osc', address: '/global/fire', args: [] }, { text: 'GO' }),
      act('stop', 'Stop', 'toggle', { type: 'osc', address: '/global/cue', args: [] }, { text: 'STOP' }),
      act('pause', 'Pause', 'toggle', { type: 'osc', address: '/global/pause', args: [] }, { text: 'PAUSE' }),
      act('restart', 'Restart', 'toggle', { type: 'osc', address: '/global/restart', args: [] }, { text: 'RST', confirm: true }),
      act('one', 'Fire timer', 'program', { type: 'osc', address: '/timer/fire', args: ['$(options:id)'] }, { text: 'FIRE', options: [str('id', 'Timer id', 'timer1')] }),
    ],
  }),
  defineSystem({
    id: 'irisdown-timer', label: 'Irisdown countdown', short: 'Irisdown', category: 'show', manufacturer: 'Irisdown', bar: '#F4A261',
    status: 'implemented', transport: 'tcp', companion: ['irisdown-countdowntimer'],
    summary: 'Start, pause, or reset the countdown.',
    docs: docs('https://release.irisdown.co.uk/Countdown%20Timer%20v2.0%20-%20Remote%20Control%20Protocol.pdf', 'Irisdown countdown remote protocol', 'TCP 61002. GO starts or resumes. PAUSE pauses. RESET resets to the last duration. A command ends with CR, LF, or CR LF. A reply of OK means the command was accepted.'),
    connection: hostPort(61002),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', ok)],
    actions: [
      line('go', 'Go', 'program', 'GO\r\n', { text: 'GO' }),
      line('pause', 'Pause', 'toggle', 'PAUSE\r\n', { text: 'PAUSE' }),
      line('reset', 'Reset', 'toggle', 'RESET\r\n', { text: 'RST', confirm: true }),
    ],
  }),
];

module.exports = { systems };
