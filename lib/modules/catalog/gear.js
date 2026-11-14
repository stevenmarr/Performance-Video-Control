'use strict';
// Matrices, displays, audio routers and show control whose command
// line is in a manufacturer document.

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
    id: 'wyrestorm-matrix', label: 'WyreStorm matrix', short: 'WyreStorm', category: 'router', manufacturer: 'WyreStorm', bar: '#E85D04',
    status: 'implemented', transport: 'tcp', companion: ['wyrestorm-matrix'],
    summary: 'Route a video input to an output on an SCL matrix.',
    docs: docs('https://downloads.wyrestorm.cloud/switchers/matrix-switchers/documents/MX-0404-SCL%20API%20092225.pdf', 'WyreStorm SCL matrix API', 'Telnet port 23. SET SW in4 out1 routes input 4 to output 1. The line must end in a line feed. in0 powers the output down.'),
    connection: hostPort(23),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected')],
    actions: [
      line('route', 'Route', 'toggle', 'SET SW in$(options:input) out$(options:output)\n', { text: 'RTE', options: [num('input', 'Input', 4), num('output', 'Output', 1)] }),
      line('query', 'Query output', 'info', 'GET MP out$(options:output)\n', { text: 'QRY', options: [num('output', 'Output', 1)] }),
    ],
  }),
  defineSystem({
    id: 'blustream-matrix', label: 'Blustream matrix', short: 'Blustream', category: 'router', manufacturer: 'Blustream', bar: '#1F4B99',
    status: 'implemented', transport: 'tcp', companion: ['blustream-hdmimatrix'],
    summary: 'Route a source to a zone. Output and input are two digits.',
    docs: docs('https://www.blustream.co.uk/Attachment/DownloadFile?downloadId=1250', 'Blustream HMXL44CS manual', 'Telnet. OUT01FR04 switches output 1 to input 4. OUT01ON turns output 1 on. PON and POFF are the system power commands. The manual\'s later NET TN command can move the telnet port; 23 is the port used when that command has not changed it.'),
    connection: hostPort(23),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected')],
    actions: [
      line('route', 'Route', 'toggle', 'OUT$(options:output)FR$(options:input)\r', { text: 'RTE', options: [str('output', 'Output', '01'), str('input', 'Input', '04')] }),
      line('on', 'Output on', 'toggle', 'OUT$(options:output)ON\r', { text: 'ON', options: [str('output', 'Output', '01')] }),
      line('power', 'Power on', 'toggle', 'PON\r', { text: 'PWR' }),
    ],
  }),
  defineSystem({
    id: 'tesmart-matrix', label: 'TESmart matrix', short: 'TESmart', category: 'router', manufacturer: 'TESmart', bar: '#0B6E4F',
    status: 'implemented', transport: 'tcp', companion: ['tesmart-hdmimatrix'],
    summary: 'Connect one input to one output.',
    docs: docs('https://support.tesmart.com/hc/en-us/articles/10270214101913-LAN-RS232-Control-Protocols', 'TESmart LAN and RS-232 protocols', 'The 8x8 HDMI matrix protocol uses TCP port 5000. MT00SW0102NT connects input 01 to output 02. Input and output are two digits.'),
    connection: hostPort(5000),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected')],
    actions: [
      line('route', 'Route', 'toggle', 'MT00SW$(options:input)$(options:output)NT\r', { text: 'RTE', options: [str('input', 'Input', '01'), str('output', 'Output', '02')] }),
      line('preset', 'Load preset', 'memory', 'MT00RD01$(options:preset)NT\r', { text: 'PRE', options: [str('preset', 'Preset', '01')] }),
    ],
  }),
  defineSystem({
    id: 'gefen-matrix', label: 'Gefen DVI matrix', short: 'Gefen', category: 'router', manufacturer: 'Gefen', bar: '#C41230',
    status: 'implemented', transport: 'tcp', companion: ['gefen-dvimatrix'],
    summary: 'Route an input and recall a preset.',
    docs: docs('https://www.fullcompass.com/common/files/28025-GefenIncGEFDVI16416PBManual.pdf', 'GefenPRO 16x16 DVI matrix manual', 'Telnet port 23. A carriage return ends every command. r 7 3 routes input 7 to output 3. Output 0 routes that input to every output. #callpreset 2 recalls preset 2.'),
    connection: hostPort(23),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected')],
    actions: [
      line('route', 'Route', 'toggle', 'r $(options:input) $(options:output)\r', { text: 'RTE', options: [num('input', 'Input', 7), num('output', 'Output', 3)] }),
      line('preset', 'Recall preset', 'memory', '#callpreset $(options:preset)\r', { text: 'PRE', options: [num('preset', 'Preset 1-16', 2)] }),
    ],
  }),
  defineSystem({
    id: 'directout', label: 'DirectOut', short: 'DirectOut', category: 'audio', manufacturer: 'DirectOut', bar: '#5B7C99',
    status: 'implemented', transport: 'tcp', companion: ['directout-audioprocessors'],
    summary: 'Make one audio crosspoint on the online matrix.',
    docs: docs('https://www.directout.eu/wp-content/uploads/m1k2/www_ship/en/help/telnet.html', 'DirectOut telnet command reference', 'TCP 23. audioxp 1 65 66 connects destination 65 to source 66 on the online matrix. Source 0 clears the destination. The dollar sign in the guide is the prompt, not part of the command.'),
    connection: hostPort(23),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected')],
    actions: [
      line('route', 'Crosspoint', 'toggle', 'audioxp 1 $(options:dest) $(options:src)\r', { text: 'XP', options: [num('dest', 'Destination', 65), num('src', 'Source', 66)] }),
      line('clear', 'Clear destination', 'toggle', 'audioxp 1 $(options:dest) 0\r', { text: 'CLR', options: [num('dest', 'Destination', 65)] }),
    ],
  }),
  defineSystem({
    id: 'panasonic-th', label: 'Panasonic TH display', short: 'TH display', category: 'display', manufacturer: 'Panasonic', bar: '#111111',
    status: 'implemented', transport: 'tcp', companion: ['panasonic-tv-th'],
    summary: 'Power and HDMI for a professional TH display.',
    docs: docs('https://docs.connect.panasonic.com/prodisplays/support/download/pdf/BQ1_SerialCommandList.pdf', 'Panasonic TH-BQ1 RS-232/LAN command list', 'Default command port 1024. The frame is STX, the command, then ETX. PON turns the display on. POF turns it off. IMS:HM1 selects HDMI 1. A command with no parameter does not include the colon.'),
    connection: hostPort(1024),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected')],
    actions: [
      line('on', 'Power on', 'toggle', '\x02PON\x03', { text: 'ON' }),
      line('off', 'Power off', 'toggle', '\x02POF\x03', { text: 'OFF', confirm: true }),
      line('hdmi', 'HDMI 1', 'toggle', '\x02IMS:HM1\x03', { text: 'HDMI' }),
    ],
  }),
  defineSystem({
    id: 'cueserver', label: 'CueServer', short: 'CueServer', category: 'lighting', manufacturer: 'Interactive Technologies', bar: '#F4A261',
    status: 'implemented', transport: 'udp', companion: ['interactivetechnologies-cueserver'],
    summary: 'Fire a cue or a macro.',
    docs: docs('https://www.interactive-online.com/manuals/cueserver/cuescript-via-udp', 'CueServer CueScript via UDP', 'UDP port 52737. The packet is the CueScript text. Cue 1 Go fires cue 1. Macro 7 runs macro 7. Unicast to the CueServer address.'),
    connection: hostPort(52737),
    variables: [v('connected', 'Connected')],
    feedbacks: [fb('connected', 'Sent')],
    actions: [
      act('go', 'Cue go', 'program', { type: 'udp', payload: 'Cue $(options:cue) Go', encoding: 'ascii' }, { text: 'GO', options: [num('cue', 'Cue', 1)] }),
      act('macro', 'Macro', 'macro', { type: 'udp', payload: 'Macro $(options:macro)', encoding: 'ascii' }, { text: 'MAC', options: [num('macro', 'Macro', 7)] }),
    ],
  }),
  defineSystem({
    id: 'avmatrix-switcher', label: 'AVMatrix switcher', short: 'AVMatrix', category: 'router', manufacturer: 'AVMatrix', bar: '#E85D4C',
    status: 'implemented', transport: 'udp', companion: ['avmatrix-switcher'],
    summary: 'Route an input to an output. The line ends with a period.',
    docs: docs('https://www.vuetec.de/SW53/media/pdf/39/26/f6/API-Guide-for-MSS0811-V1-0.pdf', 'AVMatrix matrix switch API', 'UDP port 7000. 1v2. connects input 1 to output 2. The guide says every instruction ends with a period and the commands are ASCII.'),
    connection: hostPort(7000),
    variables: [v('connected', 'Connected')],
    feedbacks: [fb('connected', 'Sent')],
    actions: [
      act('route', 'Route', 'toggle', { type: 'udp', payload: '$(options:input)v$(options:output).', encoding: 'ascii' }, { text: 'RTE', options: [num('input', 'Input', 1), num('output', 'Output', 2)] }),
    ],
  }),
  defineSystem({
    id: 'atlona-omega', label: 'Atlona Omega', short: 'Omega', category: 'router', manufacturer: 'Atlona', bar: '#7C3AED',
    status: 'implemented', transport: 'tcp', companion: ['atlona-omega'],
    summary: 'Select an input on an Omega receiver.',
    docs: docs('https://ts.atlona.com/pdf/AT-OME-RX21_API.pdf', 'Atlona AT-OME-RX21 API', 'Telnet port 23. Each command ends with CR. x2AVx1 selects input 2. The number after x is the input.'),
    connection: hostPort(23),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected')],
    actions: [
      line('input', 'Select input', 'toggle', 'x$(options:input)AVx1\r', { text: 'IN', options: [num('input', 'Input', 2)] }),
    ],
  }),
  defineSystem({
    id: 'atlona-clso', label: 'Atlona CLSO', short: 'CLSO', category: 'switcher', manufacturer: 'Atlona', bar: '#7C3AED',
    status: 'implemented', transport: 'tcp', companion: ['atlona-clso'],
    summary: 'Power the switcher and select an HDMI input.',
    docs: docs('https://ts.atlona.com/pdf/AT-UHD-CLSO-601_API.pdf', 'Atlona AT-UHD-CLSO-601 API', 'Telnet port 23. Each command ends with CR. PWON powers the unit on. Input HDMI 2 selects HDMI input 2.'),
    connection: hostPort(23),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected')],
    actions: [
      line('on', 'Power on', 'toggle', 'PWON\r', { text: 'ON' }),
      line('off', 'Power off', 'toggle', 'PWOFF\r', { text: 'OFF', confirm: true }),
      line('hdmi', 'HDMI input', 'toggle', 'Input HDMI $(options:input)\r', { text: 'HDMI', options: [num('input', 'HDMI input', 2)] }),
    ],
  }),
  defineSystem({
    id: 'wattbox', label: 'WattBox', short: 'WattBox', category: 'utility', manufacturer: 'Snap One', bar: '#E85D04',
    status: 'implemented', transport: 'http', companion: ['snapav-wattbox'],
    summary: 'Turn one outlet on or off.',
    docs: docs('https://www.snapav.com/wcsstore/ExtendedSitesCatalogAssetStore/attachments/documents/PowerManagement/SupportDocuments/Wattbox%20API%20v2.0.pdf', 'WattBox API v2.0', 'GET /control.cgi?outlet=1&command=1 turns outlet 1 on. command=0 turns it off. The request uses HTTP basic authorization. Outlet 0 is all outlets and only supports reset.'),
    connection: hostPort(80, [str('username', 'User', ''), str('password', 'Password', ''), str('authType', 'Auth', 'basic')]),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status')],
    feedbacks: [fb('connected', 'Answered')],
    actions: [
      httpAct('on', 'Outlet on', 'toggle', 'GET', '/control.cgi?outlet=$(options:outlet)&command=1', { text: 'ON', options: [num('outlet', 'Outlet', 1)] }),
      httpAct('off', 'Outlet off', 'toggle', 'GET', '/control.cgi?outlet=$(options:outlet)&command=0', { text: 'OFF', confirm: true, options: [num('outlet', 'Outlet', 1)] }),
    ],
  }),
  defineSystem({
    id: 'atnd1061', label: 'Audio-Technica ceiling array', short: 'ATND', category: 'audio', manufacturer: 'Audio-Technica', bar: '#111111',
    status: 'implemented', transport: 'tcp', companion: ['audiotechnica-ceilingarray'],
    summary: 'Mute the analog output or the whole ceiling mic.',
    docs: docs('https://www.audio-technica.com.tw/index.php?attachment_id=658&dispatch=attachments.getfile', 'ATND1061 IP control specifications', 'TCP 17300. s_output_mute S 0000 00 NC 0,1 mutes the analog output. s_mute S 0000 00 NC 1 mutes the device. A 0 in the mute field clears it. Each command ends with CR.'),
    connection: hostPort(17300),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected')],
    actions: [
      line('mute', 'Mute output', 'toggle', 's_output_mute S 0000 00 NC 0,1\r', { text: 'MUTE' }),
      line('unmute', 'Unmute output', 'toggle', 's_output_mute S 0000 00 NC 0,0\r'),
      line('device', 'Mute device', 'toggle', 's_mute S 0000 00 NC 1\r', { text: 'ALL', confirm: true }),
      line('deviceOpen', 'Unmute device', 'toggle', 's_mute S 0000 00 NC 0\r'),
    ],
  }),
  defineSystem({
    id: 'vidblaster', label: 'VidBlasterX', short: 'VidBlaster', category: 'switcher', manufacturer: 'CombiTech', bar: '#00A3E0',
    status: 'implemented', transport: 'tcp', companion: ['combitech-vidblasterx'],
    summary: 'Set a tally and start a recorder. Match the port on the TCP Server module.',
    docs: docs('https://vidblaster.com/help/x6/API.html', 'VidBlasterX API', 'The TCP Server module shows its port; the help page does not print a factory port. apiwrite Camera 1, tally, program sets that tally. apiwrite recorder 1, record, true starts Recorder 1. A recognized command returns 200 Ok.'),
    connection: hostPort(80),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected')],
    actions: [
      line('program', 'Program tally', 'program', 'apiwrite Camera $(options:camera), tally, program\r\n', { text: 'PGM', options: [num('camera', 'Camera', 1)] }),
      line('preview', 'Preview tally', 'preview', 'apiwrite Camera $(options:camera), tally, preview\r\n', { text: 'PVW', options: [num('camera', 'Camera', 1)] }),
      line('record', 'Record', 'program', 'apiwrite recorder $(options:recorder), record, true\r\n', { text: 'REC', confirm: true, options: [num('recorder', 'Recorder', 1)] }),
    ],
  }),
  defineSystem({
    id: 'blackbird-matrix', label: 'Blackbird matrix', short: 'Blackbird', category: 'router', manufacturer: 'Monoprice', bar: '#111111',
    status: 'implemented', transport: 'tcp', companion: ['blackbird-hdmimatrix'],
    summary: 'Route an input and power the matrix.',
    docs: docs('https://downloads.monoprice.com/files/manuals/27841_Manual_180419.pdf', 'Blackbird 4K HDBaseT matrix manual', 'The ASCII command 1V2. routes input 1 to output 2. PWON. powers the system on. The manual lists TCP/IP control on the RJ45 and prints these commands in the RS-232 table. It does not print the TCP port, so set the port the unit\'s network control uses.'),
    connection: hostPort(23),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected')],
    actions: [
      line('route', 'Route', 'toggle', '$(options:input)V$(options:output).\r', { text: 'RTE', options: [num('input', 'Input', 1), num('output', 'Output', 2)] }),
      line('on', 'Power on', 'toggle', 'PWON.\r', { text: 'ON' }),
    ],
  }),
  defineSystem({
    id: 'cyp-matrix', label: 'CYP matrix', short: 'CYP', category: 'router', manufacturer: 'CYP', bar: '#5B7C99',
    status: 'implemented', transport: 'tcp', companion: ['cyp-matrix'],
    summary: 'Route an input to an output and set power.',
    docs: docs('https://cypeurope.com/wp-content/uploads/2023/04/EL-42M-PIP_PDF-Manual_v1.02_Web.pdf', 'CYP EL-42M-PIP manual', 'Telnet. The default address in the manual is 192.168.1.50 and the port is the standard telnet port unless it has been changed. set out A route 1 routes input 1 to output A. set power ON and set power OFF set the power state. Each command ends with Enter.'),
    connection: hostPort(23),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected')],
    actions: [
      line('route', 'Route', 'toggle', 'set out $(options:output) route $(options:input)\r', { text: 'RTE', options: [str('output', 'Output', 'A'), num('input', 'Input', 1)] }),
      line('on', 'Power on', 'toggle', 'set power ON\r', { text: 'ON' }),
      line('off', 'Power off', 'toggle', 'set power OFF\r', { text: 'OFF', confirm: true }),
    ],
  }),
];

module.exports = { systems };
