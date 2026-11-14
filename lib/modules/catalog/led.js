'use strict';
// LED processors. Brompton HTTP, NovaStar VX Pro binary, HELIOS sACN channels.

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
function put(id, label, role, path, body, extra = {}) {
  return act(id, label, role, { type: 'http', method: 'PUT', path, body, contentType: 'application/json' }, extra);
}
function post(id, label, role, path, body, extra = {}) {
  return act(id, label, role, { type: 'http', method: 'POST', path, body, contentType: 'application/json' }, extra);
}

const systems = [
  defineSystem({
    id: 'brompton-tessera', label: 'Brompton Tessera', short: 'Tessera', category: 'led', manufacturer: 'Brompton', bar: '#7C5CBF',
    status: 'implemented', transport: 'http', companion: ['brompton-tessera'],
    summary: 'Brightness, input, blackout and freeze. IP control has to be enabled on the processor.',
    docs: docs('https://dl.bromptontech.com/tessera/docs/TesseraIPControlAPI3_1_0_Beta4.pdf', 'Tessera IP Control API', 'HTTP port 80 under /api. PUT a JSON body {"data": ...}. Brightness is 0–10000 on output/global-colour/brightness. Input source is port-type and port-index. Blackout and freeze are override flags. A value of -1 resets brightness to the common maximum.'),
    connection: hostPort(80),
    variables: [v('connected', 'Connected'), v('brightness', 'Brightness'), v('blackout', 'Blackout'), v('input', 'Input')],
    feedbacks: [fb('connected', 'Answered', { border: '#3DDC84' }), fb('blackout', 'Blackout is on', { border: '#E0B030' }, { variable: 'blackout', value: 'true' })],
    actions: [
      put('brightness', 'Brightness', 'toggle', '/api/output/global-colour/brightness', '{"data":$(options:value)}', { options: [num('value', '0-10000', 5000)], element: 'encoder', event: 'turn' }),
      put('input', 'Input', 'toggle', '/api/input/active/source', '{"data":{"port-type":"$(options:type)","port-index":$(options:index)}}', { options: [str('type', 'dvi, hdmi or sdi', 'sdi'), num('index', 'Port index', 0)] }),
      put('blackout', 'Blackout', 'toggle', '/api/override/blackout/enabled', '{"data":true}', { text: 'BLK', confirm: true }),
      put('blackoutOff', 'Blackout off', 'toggle', '/api/override/blackout/enabled', '{"data":false}', { text: 'SHOW' }),
      put('freeze', 'Freeze', 'toggle', '/api/override/freeze/enabled', '{"data":true}', { text: 'FRZ' }),
      put('freezeOff', 'Freeze off', 'toggle', '/api/override/freeze/enabled', '{"data":false}'),
    ],
  }),
  defineSystem({
    id: 'novastar-vxpro', label: 'NovaStar VX Pro', short: 'VX Pro', category: 'led', manufacturer: 'NovaStar', bar: '#E63946',
    status: 'partial', transport: 'tcp', companion: [],
    summary: 'Screen brightness for the VX Pro protocol. Display mode and presets are not in this set.',
    docs: docs('https://device.report/manuals/novastar-vx2000-pro-control-protocol-v1', 'NovaStar VX Pro Series Control Protocol V1.0.0', 'TCP 15200. Brightness is the documented frame 55 aa 00 00 fe ff … XX plus the checksum of those bytes added to 0x5555. XX is 0–255. This frame is the VX Pro protocol. Older MCTRL controllers use a different port and are not this command.'),
    connection: hostPort(15200),
    variables: [v('connected', 'Connected'), v('brightness', 'Brightness 0-255')],
    feedbacks: [fb('connected', 'Connected', { border: '#3DDC84' })],
    actions: [
      act('brightness', 'Brightness', 'toggle', { type: 'novastar', level: '$(options:level)' }, { options: [num('level', '0-255', 255)], element: 'encoder', event: 'turn' }),
    ],
  }),
  defineSystem({
    id: 'helios', label: 'Megapixel HELIOS', short: 'HELIOS', category: 'led', manufacturer: 'Megapixel', bar: '#52B788',
    status: 'implemented', transport: 'udp', companion: ['mvr-helios'],
    summary: 'Blackout, freeze, brightness and gamma on the published sACN channel map.',
    docs: docs('https://megapixelvr.com/downloads/HELIOS%20Processing%20System-User%20Guide.pdf', 'HELIOS user guide, sACN channels', 'UDP 5568, ANSI E1.31. Channel 1 blackout at 128 or above, channel 2 freeze at 128 or above, channel 3 brightness 0–255, channel 4 gamma 0–255. A host sends unicast. An empty host sends the universe multicast.'),
    connection: hostPort(5568, [num('universe', 'sACN universe', 1)]),
    variables: [v('connected', 'Sent'), v('brightness', 'Brightness'), v('blackout', 'Blackout')],
    feedbacks: [fb('connected', 'A packet was sent', { border: '#3DDC84' }), fb('blackout', 'Blackout is on', { border: '#E0B030' }, { variable: 'blackout', value: 'true' })],
    actions: [
      act('blackout', 'Blackout', 'toggle', { type: 'sacn', channels: { 1: 255 } }, { text: 'BLK', confirm: true }),
      act('blackoutOff', 'Blackout off', 'toggle', { type: 'sacn', channels: { 1: 0 } }, { text: 'SHOW' }),
      act('freeze', 'Freeze', 'toggle', { type: 'sacn', channels: { 2: 255 } }, { text: 'FRZ' }),
      act('freezeOff', 'Freeze off', 'toggle', { type: 'sacn', channels: { 2: 0 } }),
      act('brightness', 'Brightness', 'toggle', { type: 'sacn', channels: { 3: '$(options:level)' } }, { options: [num('level', '0-255', 255)], element: 'encoder', event: 'turn' }),
      act('gamma', 'Gamma', 'toggle', { type: 'sacn', channels: { 4: '$(options:level)' } }, { options: [num('level', '0-255', 119)], element: 'encoder', event: 'turn' }),
    ],
  }),
  defineSystem({
    id: 'colorlight-processor', label: 'Colorlight processor', short: 'Colorlight', category: 'led', manufacturer: 'Colorlight', bar: '#E9C46A',
    status: 'implemented', transport: 'http', companion: ['colorlight-processor'],
    summary: 'Set screen brightness through the CLTPlatform HTTP API. GrandShow is a different product.',
    docs: docs('https://developer.colorlightcloud.com/CLTServer/en/api-reference/sender-device/screen-group/brightness-and-color-temperature/set-screen-brightness.html', 'CLTPlatform set screen brightness', 'POST port 8086 /processor/setBrightness. The JSON body is command processor/setBrightness, data.index, data.groupIndex and data.brightness 0–100. Success code is 20000. GrandShow is not this processor API.'),
    connection: hostPort(8086),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status'), v('brightness', 'Brightness')],
    feedbacks: [fb('connected', 'Answered', { border: '#3DDC84' })],
    actions: [
      post('brightness', 'Brightness', 'toggle', '/processor/setBrightness', '{"command":"processor/setBrightness","data":{"index":$(options:index),"groupIndex":$(options:group),"brightness":$(options:brightness)}}', { options: [num('index', 'Sender index', 0), num('group', 'Screen group', 0), num('brightness', '0-100', 100)], element: 'encoder', event: 'turn' }),
    ],
  }),
  defineSystem({
    id: 'novastar-coex', label: 'NovaStar COEX', short: 'COEX', category: 'led', manufacturer: 'NovaStar', bar: '#E63946',
    status: 'implemented', transport: 'http', companion: ['novastar-coex'],
    summary: 'Cabinet brightness and screen brightness. Cabinet ids come from the controller.',
    docs: docs('https://oss.novastar.tech/uploads/2023/02/COEX-Series-Interface-API-User-Manual.pdf', 'NovaStar COEX Series Interface API', 'HTTP port 8001. PUT /api/v1/device/cabinet/brightness with idList and ratio 0–1. PUT /api/v1/screen/brightness with screenIdList and brightness 0–1. A success code is 0. CX80 Pro, CX40 Pro, MX40 Pro and KU20 are the products named in the manual. VX Pro TCP 15200 and the older MCTRL frame are different protocols.'),
    connection: hostPort(8001),
    variables: [v('connected', 'Connected'), v('http.status', 'Last status'), v('brightness', 'Brightness')],
    feedbacks: [fb('connected', 'Answered', { border: '#3DDC84' })],
    actions: [
      put('cabinet', 'Cabinet brightness', 'toggle', '/api/v1/device/cabinet/brightness', '{"idList":[$(options:cabinet)],"ratio":$(options:ratio)}', { options: [str('cabinet', 'Cabinet id', '1'), str('ratio', '0-1', '1.0')], element: 'encoder', event: 'turn' }),
      put('screen', 'Screen brightness', 'toggle', '/api/v1/screen/brightness', '{"screenIdList":["$(options:screen)"],"brightness":$(options:level)}', { options: [str('screen', 'Screen id', ''), str('level', '0-1', '1.0')], element: 'encoder', event: 'turn' }),
    ],
  }),
];

module.exports = { systems };
