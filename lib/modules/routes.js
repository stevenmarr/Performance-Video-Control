'use strict';

const { ModuleDesk } = require('./runtime');
const { catalogPayload, buttonView } = require('./index');
const { get } = require('./catalog');
const { feedbackFlags } = require('./framework');
const { previewSvg } = require('../decks/button-preview');

function attach(route, { dataDir } = {}) {
  const desk = new ModuleDesk({ dataDir });
  route('GET', /^\/api\/modules$/, (b, m, url) => {
    const theme = url && url.searchParams.get('theme') === 'light' ? 'light' : '';
    return { ...catalogPayload(theme), ...desk.view() };
  });
  route('GET', /^\/api\/modules\/coverage$/, () => require('./coverage').summary());
  route('POST', /^\/api\/modules\/instances$/, (b) => desk.create(String((b && b.system) || ''), b || {}));
  route('POST', /^\/api\/modules\/instances\/([\w.-]+)\/connection$/, (b, m) => desk.update(m[1], b || {}));
  route('POST', /^\/api\/modules\/instances\/([\w.-]+)\/connect$/, (b, m) => desk.connect(m[1]));
  route('POST', /^\/api\/modules\/instances\/([\w.-]+)\/disconnect$/, (b, m) => desk.disconnect(m[1]));
  route('DELETE', /^\/api\/modules\/instances\/([\w.-]+)$/, (b, m) => desk.remove(m[1]));
  route('POST', /^\/api\/modules\/instances\/([\w.-]+)\/actions\/([\w.-]+)$/, (b, m) => desk.run(m[1], m[2], b || {}));
  route('POST', /^\/api\/modules\/instances\/([\w.-]+)\/run$/, (b, m) => desk.runSteps(m[1], (b && b.steps) || []));
  route('POST', /^\/api\/modules\/cmd\/([\w.-]+)\/([\w.-]+)$/, (b, m) => {
    const system = m[1];
    const instance = (b && b.instance) || desk.view().instances.find((i) => i.system === system);
    const id = typeof instance === 'string' ? instance : instance && instance.id;
    if (!id) {
      const err = new Error(`No ${system} connection is open`);
      err.status = 404;
      throw err;
    }
    const body = { ...(b || {}) };
    delete body.instance;
    return desk.run(id, m[2], body);
  });
  route('POST', /^\/api\/modules\/preview$/, (b) => {
    const system = get(b && b.system);
    if (!system) {
      const err = new Error('No system');
      err.status = 404;
      throw err;
    }
    const action = system.actionMap.get(b && b.action);
    if (!action) {
      const err = new Error('No action');
      err.status = 404;
      throw err;
    }
    const button = buttonView(system, b && b.theme).find((row) => row.action === action.id);
    const flags = b && b.flags ? b.flags : feedbackFlags(system, b && b.vars);
    return previewSvg(button, flags, b && b.vars, b && b.theme);
  });
  return desk;
}

module.exports = { attach };
