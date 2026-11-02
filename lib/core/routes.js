'use strict';
// HTTP for the core. Existing /api/sys and /api/deck routes stay as they are.
// These are the extra reads and the one command path the console deck uses.

function mount(route, systems) {
  const os = systems && systems.os;
  if (!os) return;
  route('GET', /^\/api\/core$/, () => os.snapshot());
  route('GET', /^\/api\/core\/modules$/, () => ({ modules: os.catalog.list() }));
  route('GET', /^\/api\/core\/feedbacks$/, () => os.feedbacks());
  route('GET', /^\/api\/core\/transitions$/, () => ({ transitions: os.log.transitions(80) }));
  route('GET', /^\/api\/core\/actions$/, () => {
    const mod = os.catalog.get('console');
    return { actions: mod.actions, feedbacks: mod.feedbacks, values: os.feedbacks().flat };
  });
  route('GET', /^\/api\/core\/surfaces$/, () => os.surfaces.snapshot());
  route('POST', /^\/api\/core\/surfaces\/bind$/, (b) => os.surfaces.bind(b || {}));
  route('POST', /^\/api\/core\/surfaces\/focus$/, (b) => os.surfaces.setFocus(b && b.surfaceId, b && b.instanceId));
  route('POST', /^\/api\/core\/surfaces\/profiles$/, (b) => os.surfaces.saveAs((b && b.id) || '', (b && b.name) || 'Show'));
  route('POST', /^\/api\/core\/surfaces\/profiles\/([^/]+)\/load$/, (b, m) => os.surfaces.activate(m[1]));
  route('DELETE', /^\/api\/core\/surfaces\/bind\/([^/]+)$/, (b, m) => os.surfaces.unbind(m[1]));
  route('GET', /^\/api\/core\/companion$/, () => os.companionSnapshot());
  route('POST', /^\/api\/core\/companion\/connections$/, (b) => os.addCompanion(b || {}));
  route('DELETE', /^\/api\/core\/companion\/connections\/([^/]+)$/, (b, m) => os.removeCompanion(m[1]));
  route('POST', /^\/api\/core\/companion\/feedback$/, (b) => { const r = os.companionFeedback(b || {}); systems.changed(); return r; });
  route('POST', /^\/api\/core\/companion\/satellite$/, (b) => os.setSatellite(b || {}));
  route('POST', /^\/api\/core\/companion\/satellite\/keys$/, (b) => os.satelliteKeys(b || {}));
  route('POST', /^\/api\/core\/cmd\/([a-z][\w.]*)$/, (b, m) => os.command(m[1], b || {}));
}

module.exports = { mount };
