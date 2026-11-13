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
];

module.exports = { systems };
