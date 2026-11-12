'use strict';
// Action ids the button editor can offer. Module ids come from the OS catalog
// (lib/core/sdk.js). Page ids are the ones already stored on the + XL switcher.
// A page id that is not in the catalog is marked bound:false. The editor must
// not ask the operator to type a URL.

const { BUILTIN } = require('../core/sdk');
const { PUBLIC_ROLES, ELEMENTS } = require('./button-library');
const { actionToRequest } = require('./page-push');

const PAGE_ONLY = [
  ['nav.home', 'Home'],
  ['nav.page', 'Open page'],
  ['atem.info', 'Switcher name'],
  ['atem.config', 'Hold for config'],
  ['atem.transSelect', 'Transition select'],
  ['atem.flexBank', 'Memory bank'],
  ['atem.mes', 'M/E select'],
  ['atem.shift', 'Shift'],
  ['atem.me', 'M/E encoder'],
  ['atem.effect', 'Effect encoder'],
  ['atem.wipe', 'Wipe encoder'],
  ['atem.time', 'Auto rate'],
  ['atem.tbar', 'T-bar'],
  ['atem.map', 'Map encoder'],
];

const EVENTS = {
  button: ['press', 'release', 'hold'],
  encoder: ['turn', 'push'],
  'touch-segment': ['touch'],
};

const SAMPLE_FLAGS = ['onProgram', 'onPreview', 'transition', 'shift', 'bankOn', 'held'];

function catalog() {
  const actions = [];
  const seen = new Set();
  for (const mod of BUILTIN) {
    for (const raw of mod.actions || []) {
      const short = typeof raw === 'string' ? raw : raw.id;
      if (!short) continue;
      const id = `${mod.id}.${short}`;
      if (seen.has(id)) continue;
      seen.add(id);
      actions.push({
        id,
        group: mod.label || mod.id,
        label: (typeof raw === 'object' && raw.description) || short,
        bound: true,
        request: actionToRequest({ action: id }),
      });
    }
  }
  for (const pair of PAGE_ONLY) {
    if (seen.has(pair[0])) continue;
    seen.add(pair[0]);
    actions.push({ id: pair[0], group: 'Page', label: pair[1], bound: false, request: actionToRequest({ action: pair[0] }) });
  }
  return {
    actions,
    roles: PUBLIC_ROLES.slice(),
    elements: ELEMENTS.slice(),
    events: EVENTS,
    flags: SAMPLE_FLAGS.slice(),
  };
}

module.exports = { catalog, EVENTS, SAMPLE_FLAGS, PAGE_ONLY };
