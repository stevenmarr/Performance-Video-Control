'use strict';
// One definition for every Control Center system module: connection fields,
// actions (each one is a button), variables and feedbacks. The desk and the
// tab render from this object. A native system keeps using its existing driver.

const { fill, bagFrom } = require('./encode');

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const ROLES = new Set(['program', 'preview', 'hot', 'shift', 'memory', 'macro', 'nav', 'tab', 'info', 'toggle']);
const STATUSES = new Set(['implemented', 'partial', 'not yet']);

function cleanField(f) {
  if (!f || !f.id) throw fail('A connection field needs an id');
  return {
    id: String(f.id),
    type: f.type === 'number' || f.type === 'boolean' ? f.type : 'string',
    label: String(f.label || f.id),
    default: f.default == null ? '' : f.default,
    secret: !!f.secret,
  };
}

function cleanOption(o) {
  return {
    id: String(o.id),
    type: o.type === 'number' || o.type === 'boolean' ? o.type : 'string',
    label: String(o.label || o.id),
    default: o.default == null ? '' : o.default,
  };
}

function defineSystem(raw) {
  if (!raw || typeof raw !== 'object') throw fail('A system module is an object');
  const id = String(raw.id || '');
  if (!/^[a-z][\w.-]{0,48}$/.test(id)) throw fail(`Bad system id "${id}"`);
  if (!raw.label) throw fail(`System "${id}" needs a label`);
  const status = raw.status || 'implemented';
  if (!STATUSES.has(status)) throw fail(`Bad status "${status}"`);
  const actions = (raw.actions || []).map((a) => {
    if (!a || !a.id) throw fail(`System "${id}" has an action without an id`);
    const role = ROLES.has(a.role) ? a.role : 'toggle';
    return {
      id: String(a.id),
      label: String(a.label || a.id),
      description: String(a.description || a.label || a.id),
      role,
      text: String(a.text || a.label || a.id),
      caption: a.caption ? String(a.caption) : '',
      confirm: !!a.confirm,
      confirmMode: a.confirmMode || '',
      element: a.element === 'encoder' || a.element === 'touch-segment' ? a.element : 'button',
      event: a.event || (a.element === 'encoder' ? 'turn' : a.element === 'touch-segment' ? 'touch' : 'press'),
      options: (a.options || []).map(cleanOption),
      execute: a.execute || null,
      native: a.native || null,
      fixedRequest: a.fixedRequest || null,
      bar: a.bar || null,
    };
  });
  const seen = new Set();
  for (const a of actions) {
    if (seen.has(a.id)) throw fail(`System "${id}" repeats action "${a.id}"`);
    seen.add(a.id);
  }
  const variables = (raw.variables || []).map((v) => ({ id: String(v.id), label: String(v.label || v.id) }));
  const feedbacks = (raw.feedbacks || []).map((f) => ({
    id: String(f.id),
    label: String(f.label || f.id),
    variable: String(f.variable || f.id),
    op: f.op || 'eq',
    value: f.value == null ? 'true' : String(f.value),
    style: f.style && typeof f.style === 'object' ? { ...f.style } : {},
  }));
  const companion = Array.isArray(raw.companion) ? raw.companion.map(String) : (raw.companion ? [String(raw.companion)] : []);
  return Object.freeze({
    id,
    label: String(raw.label),
    short: String(raw.short || raw.label).slice(0, 16),
    category: String(raw.category || 'general'),
    manufacturer: String(raw.manufacturer || ''),
    bar: String(raw.bar || '#5c6570'),
    summary: String(raw.summary || ''),
    status,
    nativeId: raw.nativeId ? String(raw.nativeId) : '',
    groupTab: raw.groupTab || '',
    companion,
    docs: {
      url: raw.docs && raw.docs.url ? String(raw.docs.url) : '',
      title: raw.docs && raw.docs.title ? String(raw.docs.title) : '',
      basis: raw.docs && raw.docs.basis ? String(raw.docs.basis) : 'official',
      note: raw.docs && raw.docs.note ? String(raw.docs.note) : '',
    },
    connection: { fields: (raw.connection && raw.connection.fields || []).map(cleanField) },
    transport: String(raw.transport || (raw.nativeId ? 'native' : 'none')),
    variables,
    feedbacks,
    actions,
    actionMap: new Map(actions.map((a) => [a.id, a])),
    poll: raw.poll || null,
  });
}

const SEMANTIC = new Set(['program', 'preview', 'hot', 'nav', 'info']);

function optionDefaults(action) {
  const out = {};
  for (const o of action.options || []) if (o.default !== '' && o.default != null) out[o.id] = o.default;
  if (action.native && action.native.defaults) Object.assign(out, action.native.defaults);
  return out;
}

function buttonFor(system, action) {
  const role = action.role;
  const style = {};
  if (!SEMANTIC.has(role)) style.bar = action.bar || system.bar;
  if (role === 'nav' || role === 'info') style.os = true;
  const event = action.event || 'press';
  const actionId = system.nativeId ? `${system.nativeId}.${action.id}` : `${system.id}.${action.id}`;
  return {
    name: `${system.short} ${action.label}`.slice(0, 60),
    element: action.element,
    role,
    text: action.text,
    title: system.short,
    caption: action.caption || system.category,
    confirm: !!action.confirm,
    confirmMode: action.confirmMode || '',
    style,
    target: { mode: 'fixed', system: system.nativeId || system.id, instance: '' },
    actions: { [event]: [{ action: actionId, options: optionDefaults(action) }] },
    feedbacks: (action.feedbacks && action.feedbacks.length) ? action.feedbacks : feedbackStyles(system),
    system: system.id,
    action: action.id,
  };
}

function feedbackStyles(system) {
  return (system.feedbacks || []).filter((f) => f.id === 'connected').map((f) => ({ when: f.id, style: f.style || {} }));
}

function compare(left, op, right) {
  const a = left == null ? '' : String(left);
  const b = right == null ? '' : String(right);
  if (op === 'truthy') return a !== '' && a !== 'false' && a !== '0' && a !== 'off';
  if (op === 'ne') return a !== b;
  if (op === 'contains') return a.toLowerCase().includes(b.toLowerCase());
  const na = Number(a);
  const nb = Number(b);
  if (op === 'gt' || op === 'lt' || op === 'gte' || op === 'lte') {
    if (!Number.isFinite(na) || !Number.isFinite(nb)) return false;
    if (op === 'gt') return na > nb;
    if (op === 'lt') return na < nb;
    if (op === 'gte') return na >= nb;
    return na <= nb;
  }
  return a === b;
}

function feedbackFlags(system, vars) {
  const flags = {};
  for (const f of system.feedbacks || []) flags[f.id] = compare(vars && vars[f.variable], f.op, f.value);
  return flags;
}

function interpolateAction(action, conn, options, vars) {
  const bag = bagFrom(conn, options, vars);
  const walk = (v) => {
    if (typeof v === 'string') return fill(v, bag);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(action.execute || {});
}

module.exports = {
  defineSystem, buttonFor, feedbackFlags, compare, interpolateAction, optionDefaults, feedbackStyles, SEMANTIC,
};
