'use strict';

const catalog = require('./catalog');
const { buttonFor, feedbackFlags } = require('./framework');
const { summary } = require('./coverage');
const { actionToRequest } = require('../decks/page-push');

function buttonView(system, theme) {
  return system.actions.map((action) => {
    const button = buttonFor(system, action);
    if (theme) button.theme = theme;
    const request = requestFor(system, action);
    return { ...button, description: action.description, request, flags: {} };
  });
}

function requestFor(system, action) {
  if (action.fixedRequest) return { method: action.fixedRequest.method, path: action.fixedRequest.path, body: { ...(action.fixedRequest.body || {}) } };
  if (system.nativeId) {
    const request = actionToRequest({ action: `${system.nativeId}.${action.id}`, options: (action.native && action.native.defaults) || {} });
    return request || null;
  }
  return { method: 'POST', path: `/api/modules/instances/INSTANCE/actions/${action.id}`, body: {} };
}

function catalogPayload(theme) {
  return {
    systems: catalog.systems().map((system) => ({
      id: system.id,
      label: system.label,
      short: system.short,
      category: system.category,
      manufacturer: system.manufacturer,
      bar: system.bar,
      summary: system.summary,
      status: system.status,
      nativeId: system.nativeId,
      groupTab: system.groupTab || system.nativeId || '',
      transport: system.transport,
      docs: system.docs,
      connection: system.connection,
      variables: system.variables,
      feedbacks: system.feedbacks,
      counts: { buttons: system.actions.length, variables: system.variables.length, feedbacks: system.feedbacks.length },
      buttons: buttonView(system, theme),
    })),
    summary: summary(),
  };
}

module.exports = { catalog, buttonFor, feedbackFlags, buttonView, requestFor, catalogPayload };
