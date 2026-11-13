'use strict';

const { systems: native } = require('./native');
const { systems: protocols } = require('./protocols');
const { systems: switchers } = require('./switchers');
const { systems: graphics } = require('./graphics');
const { systems: led } = require('./led');

const ALL = [...native, ...protocols, ...switchers, ...graphics, ...led];
const byId = new Map(ALL.map((s) => [s.id, s]));

function systems() { return ALL.slice(); }
function get(id) { return byId.get(id) || null; }
function byNative(nativeId) { return ALL.find((s) => s.nativeId === nativeId) || null; }

module.exports = { systems, get, byNative, ALL };
