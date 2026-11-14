'use strict';
// Image processors whose published command was checked in this pass.
// LivePremier and Event Master stay on the existing RS6 and E2 systems.

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
    id: 'panasonic-hs6000', label: 'Panasonic AV-HS6000', short: 'HS6000', category: 'switcher', manufacturer: 'Panasonic', bar: '#4C6EF5',
    status: 'implemented', transport: 'tcp', companion: ['panasonic-av-hs6000'],
    summary: 'Select a source on a bus. Bus 01 is ME1 program in the protocol table.',
    docs: docs('https://eww.pass.panasonic.co.jp/pro-av/support/dload/hs6000_3ext/AV-HS6000%20external%20IF_protocol-E.pdf', 'AV-HS6000 external interface protocol', 'TCP 62000. A command is STX, four letters, colon parameters, ETX. SBUS:01:01 selects source 01 on bus 01 and the switcher answers ABUS. The external-control plug-in has to be installed. AV-HS and AV-HSW10 are not this protocol.'),
    connection: hostPort(62000),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', { border: '#3DDC84' })],
    actions: [
      line('bus', 'Bus source', 'program', '\x02SBUS:$(options:bus):$(options:source)\x03', { text: 'BUS', options: [str('bus', 'Bus', '01'), str('source', 'Source', '01')] }),
      line('query', 'Read bus', 'info', '\x02QBSC:$(options:bus)\x03', { text: 'READ', options: [str('bus', 'Bus', '01')] }),
    ],
  }),
  defineSystem({
    id: 'christie-spyder', label: 'Christie Spyder', short: 'Spyder', category: 'processor', manufacturer: 'Christie', bar: '#E85D4C',
    status: 'implemented', transport: 'udp', companion: ['christie-spyder'],
    summary: 'Load a Mix Effect source and transition it. The UDP header is the ten bytes the guide specifies.',
    docs: docs('https://www.christiedigital.com/globalassets/resources/public/spyder-s-api-commands-version-6.1.3.pdf', 'Spyder-S API commands 6.1.3', 'UDP 11116. Each datagram starts with the ASCII word spyder and four zero bytes, then the command with no extra space. METR 3 D1 cuts Mix Effect 3. MESR 3 T Camera%201 loads a source onto the top input. Layer and Mix Effect numbers are the API indexes, not the Studio numbers.'),
    connection: hostPort(11116),
    variables: [v('connected', 'Sent'), v('last', 'Last command')],
    feedbacks: [fb('connected', 'A packet was sent', { border: '#3DDC84' })],
    actions: [
      act('load', 'Load source', 'preview', { type: 'spyder', command: 'MESR $(options:mix) $(options:input) $(options:source)' }, { text: 'LOAD', options: [num('mix', 'Mix Effect', 1), str('input', 'T or B', 'T'), str('source', 'Source', 'Camera%201')] }),
      act('transition', 'Transition', 'program', { type: 'spyder', command: 'METR $(options:mix) D$(options:frames)' }, { text: 'TAKE', confirm: true, options: [num('mix', 'Mix Effect', 1), num('frames', 'Frames', 1)] }),
    ],
  }),
  defineSystem({
    id: 'barco-pds', label: 'Barco PDS-4K', short: 'PDS', category: 'processor', manufacturer: 'Barco', bar: '#F4A261',
    status: 'implemented', transport: 'tcp', companion: ['barco-pds'],
    summary: 'Recall a preset and auto-transition preview to program.',
    docs: docs('https://www.fullcompass.com/common/files/83820-PDS4KUserGuide.pdf', 'Barco PDS-4K User Guide R5912621', 'Telnet TCP 9878. Commands end with carriage return. PRESET -r 10 recalls preset 10. PRESET -a 10 recalls it and transitions. ATRN 0 cuts preview to program. ImagePRO is not this command set.'),
    connection: hostPort(9878, [str('delimiter', 'Delimiter', '\\r\\n')]),
    variables: [v('connected', 'Connected'), v('tcp.reply', 'Last reply')],
    feedbacks: [fb('connected', 'Connected', { border: '#3DDC84' })],
    actions: [
      line('recall', 'Recall preset', 'memory', 'PRESET -r $(options:preset)\r', { text: 'RCL', confirm: true, options: [num('preset', 'Preset 1-1000', 1)] }),
      line('take', 'Recall and transition', 'program', 'PRESET -a $(options:preset)\r', { text: 'TAKE', confirm: true, options: [num('preset', 'Preset 1-1000', 1)] }),
      line('cut', 'Cut', 'program', 'ATRN 0\r', { text: 'CUT', confirm: true }),
    ],
  }),
];

module.exports = { systems };
