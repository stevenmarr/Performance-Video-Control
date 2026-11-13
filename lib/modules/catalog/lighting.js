'use strict';
// Art-Net and generic sACN. The packet layouts are the published standards.
// HELIOS keeps its own channel map.

const { defineSystem } = require('../framework');

const docs = (url, title, note = '') => ({ url, title, basis: 'official', note });
const v = (id, label) => ({ id, label });
const fb = (id, label, style, extra = {}) => ({ id, label, variable: extra.variable || id, op: extra.op || 'eq', value: extra.value == null ? 'true' : extra.value, style });
const num = (id, label, def) => ({ id, type: 'number', label, default: def });

function act(id, label, role, execute, extra = {}) {
  return {
    id, label, role, text: extra.text || label, description: extra.description || label,
    confirm: !!extra.confirm, element: extra.element, event: extra.event,
    options: extra.options || [], execute,
  };
}

const slot = [num('channel', 'Channel 1-512', 1), num('value', '0-255', 255), num('universe', 'Universe', 1)];

const systems = [
  defineSystem({
    id: 'artnet', label: 'Art-Net', short: 'Art-Net', category: 'lighting', manufacturer: 'Artistic Licence', bar: '#F4A261',
    status: 'implemented', transport: 'udp', companion: ['generic-artnet'],
    summary: 'One DMX slot in an ArtDmx packet. The host is the node, or the broadcast address.',
    docs: docs('https://art-net.org.uk/how-it-works/streaming-packets/art-dmx-packet-definition/', 'Art-Net ArtDmx', 'UDP 6454. The packet is Art-Net, opcode 0x5000 little-endian, protocol version 14, then the 15-bit universe and the DMX slots. Set broadcast on the connection when the node listens on the subnet.'),
    connection: { fields: [{ id: 'host', type: 'string', label: 'Host', default: '' }, { id: 'port', type: 'number', label: 'Port', default: 6454 }, { id: 'universe', type: 'number', label: 'Universe', default: 0 }, { id: 'broadcast', type: 'boolean', label: 'Broadcast', default: false }] },
    variables: [v('connected', 'Sent'), v('channel', 'Channel'), v('value', 'Value')],
    feedbacks: [fb('connected', 'A packet was sent', { border: '#3DDC84' })],
    actions: [
      act('slot', 'DMX slot', 'toggle', { type: 'artnet', channel: '$(options:channel)', value: '$(options:value)', universe: '$(options:universe)' }, { options: [num('channel', 'Channel 1-512', 1), num('value', '0-255', 255), num('universe', 'Universe', 0)], element: 'encoder', event: 'turn' }),
    ],
  }),
  defineSystem({
    id: 'sacn', label: 'sACN', short: 'sACN', category: 'lighting', manufacturer: 'ESTA', bar: '#90BE6D',
    status: 'implemented', transport: 'udp', companion: ['generic-sacn'],
    summary: 'One DMX slot in an E1.31 packet. A host sends unicast. An empty host sends the universe multicast.',
    docs: docs('https://tsp.esta.org/tsp/documents/published_docs.php', 'ANSI E1.31 sACN', 'UDP 5568. The packet is the E1.31 root, framing and DMP layers with a start code and 512 slots. Universe 1 multicasts to 239.255.0.1.'),
    connection: { fields: [{ id: 'host', type: 'string', label: 'Host', default: '' }, { id: 'port', type: 'number', label: 'Port', default: 5568 }, { id: 'universe', type: 'number', label: 'Universe', default: 1 }] },
    variables: [v('connected', 'Sent'), v('brightness', 'Last level')],
    feedbacks: [fb('connected', 'A packet was sent', { border: '#3DDC84' })],
    actions: [
      act('slot', 'DMX slot', 'toggle', { type: 'sacn', channel: '$(options:channel)', value: '$(options:value)', universe: '$(options:universe)' }, { options: slot, element: 'encoder', event: 'turn' }),
    ],
  }),
];

module.exports = { systems };
