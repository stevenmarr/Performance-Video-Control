'use strict';
// Ross XPression over RossTalk. The command names and the framebuffer numbering
// are the ones in the RossTalk command document.

const { defineSystem } = require('../framework');

const docs = (url, title, note = '') => ({ url, title, basis: 'official', note });
const v = (id, label) => ({ id, label });
const fb = (id, label, style, extra = {}) => ({ id, label, variable: extra.variable || id, op: extra.op || 'eq', value: extra.value == null ? 'true' : extra.value, style });
const num = (id, label, def) => ({ id, type: 'number', label, default: def });
const str = (id, label, def = '') => ({ id, type: 'string', label, default: def });

function line(id, label, role, payload, extra = {}) {
  return {
    id, label, role, text: extra.text || label, description: extra.description || label,
    confirm: !!extra.confirm, options: extra.options || [],
    execute: { type: 'line', payload },
  };
}

const fbNum = [num('buffer', 'Framebuffer (0 = first)', 0), num('layer', 'Layer', 0)];

const systems = [
  defineSystem({
    id: 'ross-xpression', label: 'Ross XPression', short: 'XPression', category: 'graphics', manufacturer: 'Ross Video', bar: '#C8102E',
    status: 'implemented', transport: 'tcp', companion: ['rossvideo-xpression'],
    summary: 'Take, cue, read and clear. Framebuffer 0 is the first framebuffer.',
    docs: docs('https://documentation.rossvideo.com/files/Manuals/Protocol%20Documents/RossTalk-Commands(4802DR-403).pdf', 'RossTalk commands, XPression section', 'TCP 7788. Commands are case sensitive and end with CR LF. TAKE takeid:buffer:layer loads a template. READ takes the current sequencer selection. Framebuffer 0 is framebuffer 1 in the XPression UI.'),
    connection: { fields: [{ id: 'host', type: 'string', label: 'Host', default: '' }, { id: 'port', type: 'number', label: 'Port', default: 7788 }] },
    variables: [v('connected', 'Connected'), v('last', 'Last command')],
    feedbacks: [fb('connected', 'Connected', { border: '#3DDC84' })],
    actions: [
      line('take', 'Take', 'hot', 'TAKE $(options:take):$(options:buffer):$(options:layer)\r\n', { text: 'TAKE', options: [str('take', 'Take ID', '1'), ...fbNum] }),
      line('read', 'Read', 'toggle', 'READ\r\n', { text: 'READ' }),
      line('next', 'Next', 'hot', 'NEXT\r\n', { text: 'NEXT' }),
      line('cue', 'Cue', 'preview', 'CUE $(options:take):$(options:buffer):$(options:layer)\r\n', { options: [str('take', 'Take ID', '1'), ...fbNum] }),
      line('up', 'Sequencer up', 'toggle', 'UP\r\n', { text: 'UP' }),
      line('down', 'Sequencer down', 'toggle', 'DOWN\r\n', { text: 'DOWN' }),
      line('focus', 'Focus take', 'info', 'FOCUS $(options:take)\r\n', { options: [str('take', 'Take ID', '1')] }),
      line('layerOff', 'Layer off', 'toggle', 'LAYEROFF $(options:buffer):$(options:layer)\r\n', { confirm: true, options: fbNum }),
      line('clearLayer', 'Clear layer', 'toggle', 'CLFB $(options:buffer):$(options:layer)\r\n', { confirm: true, options: fbNum }),
      line('clearAll', 'Clear all', 'hot', 'CLRA\r\n', { text: 'CLRA', confirm: true }),
      line('seqIn', 'Sequencer in', 'toggle', 'SEQI $(options:take):$(options:layer)\r\n', { options: [str('take', 'Take ID', '1'), num('layer', 'Layer', 0)] }),
      line('seqOut', 'Sequencer out', 'toggle', 'SEQO $(options:take)\r\n', { confirm: true, options: [str('take', 'Take ID', '1')] }),
      line('swap', 'Swap cued', 'hot', 'SWAP $(options:buffer)\r\n', { options: [num('buffer', 'Framebuffer', 0)] }),
      line('resume', 'Resume', 'toggle', 'RESUME $(options:buffer)\r\n', { options: [num('buffer', 'Framebuffer', 0)] }),
      line('uncue', 'Uncue all', 'toggle', 'UNCUEALL\r\n', { confirm: true }),
    ],
  }),
];

module.exports = { systems };
