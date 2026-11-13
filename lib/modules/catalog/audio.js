'use strict';
// Behringer X32 / Midas M32. The addresses and the port are the ones Behringer
// published in the X32 OSC remote protocol.

const { defineSystem } = require('../framework');

const docs = (url, title, note = '') => ({ url, title, basis: 'official', note });
const v = (id, label) => ({ id, label });
const fb = (id, label, style, extra = {}) => ({ id, label, variable: extra.variable || id, op: extra.op || 'eq', value: extra.value == null ? 'true' : extra.value, style });
const num = (id, label, def) => ({ id, type: 'number', label, default: def });
const str = (id, label, def = '') => ({ id, type: 'string', label, default: def });

function act(id, label, role, execute, extra = {}) {
  return {
    id, label, role, text: extra.text || label, description: extra.description || label,
    confirm: !!extra.confirm, element: extra.element, event: extra.event,
    options: extra.options || [], execute,
  };
}

const ch = [str('channel', 'Channel 01-32', '01')];

const systems = [
  defineSystem({
    id: 'behringer-x32', label: 'Behringer X32', short: 'X32', category: 'audio', manufacturer: 'Behringer', bar: '#6C757D',
    status: 'implemented', transport: 'osc', companion: ['behringer-x32'],
    summary: 'Channel fader, on and main fader. Midas M32 uses the same protocol.',
    docs: docs('http://www.behringer.com/assets/X32_OSC_Remote_Protocol.pdf', 'Behringer X32 OSC remote protocol', 'UDP 10023. /ch/01/mix/fader is a float 0.0–1.0. /ch/01/mix/on is 0 or 1. /main/st/mix/fader is the main fader. The console replies to the sender. Later community PDFs restate this protocol and add more addresses; these buttons use the published fader and on messages.'),
    connection: { fields: [{ id: 'host', type: 'string', label: 'Host', default: '' }, { id: 'port', type: 'number', label: 'Port', default: 10023 }] },
    variables: [v('connected', 'Socket open'), v('last', 'Last address'), v('fader', 'Last fader')],
    feedbacks: [fb('connected', 'Socket open', { border: '#3DDC84' }), fb('on', 'Channel was turned on', { border: '#3DDC84' }, { variable: 'on', value: '1' })],
    actions: [
      act('fader', 'Channel fader', 'toggle', { type: 'osc', address: '/ch/$(options:channel)/mix/fader', args: ['$(options:level)'] }, { options: [...ch, str('level', '0.0-1.0', '0.75')], element: 'encoder', event: 'turn' }),
      act('on', 'Channel on', 'toggle', { type: 'osc', address: '/ch/$(options:channel)/mix/on', args: [1] }, { options: ch }),
      act('off', 'Channel off', 'toggle', { type: 'osc', address: '/ch/$(options:channel)/mix/on', args: [0] }, { options: ch }),
      act('main', 'Main fader', 'toggle', { type: 'osc', address: '/main/st/mix/fader', args: ['$(options:level)'] }, { options: [str('level', '0.0-1.0', '0.75')], element: 'encoder', event: 'turn' }),
    ],
  }),
  defineSystem({
    id: 'behringer-xair', label: 'Behringer X Air', short: 'X Air', category: 'audio', manufacturer: 'Behringer', bar: '#6C757D',
    status: 'implemented', transport: 'osc', companion: ['behringer-xair'],
    summary: 'Channel fader, mixer info and the remote subscription. X18, XR18, XR16 and XR12 use this port.',
    docs: docs('https://www.manualshelf.com/manual/behringer/x18/air-series-osc-documentation-english.html', 'X AIR Mixer Series Remote Control Protocol', 'UDP 10024. The protocol\'s example parameter is /ch/01/mix/fader, a float 0.0–1.0. /xinfo asks for the mixer identity and /xremote subscribes to parameter changes for about 10 seconds. Wing uses a different protocol.'),
    connection: { fields: [{ id: 'host', type: 'string', label: 'Host', default: '' }, { id: 'port', type: 'number', label: 'Port', default: 10024 }] },
    variables: [v('connected', 'Socket open'), v('last', 'Last address'), v('fader', 'Last fader')],
    feedbacks: [fb('connected', 'Socket open', { border: '#3DDC84' })],
    actions: [
      act('fader', 'Channel fader', 'toggle', { type: 'osc', address: '/ch/$(options:channel)/mix/fader', args: ['$(options:level)'] }, { options: [...ch, str('level', '0.0-1.0', '0.75')], element: 'encoder', event: 'turn' }),
      act('info', 'Mixer info', 'info', { type: 'osc', address: '/xinfo', args: [] }, { text: 'INFO' }),
      act('remote', 'Subscribe', 'toggle', { type: 'osc', address: '/xremote', args: [] }, { text: 'SUB' }),
    ],
  }),
];

module.exports = { systems };
