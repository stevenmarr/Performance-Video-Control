'use strict';
// 0.9.0 Companion pages: .companionconfig files with ready-made Stream Deck pages for the configured systems,
// for Steven's Companion fork (stevenmarr/companion feat/lcars-gui: page surface layouts, knob $(this:delta)).
// See lib/companion/README.md.
const S = require('./surfaces');
const M = require('./model');
const PS = require('./pageset');

const DEFAULT_CONNECTION = { id: 'pv_control_center', label: 'rs6presets', host: '127.0.0.1', port: 8080 };

// state: RS6 state, views: systems' views. o.surfaces: list or 'xl,plus'; o.combined: one file for all of them.
// Returns { files: [{ name, surfaces, pages, warnings, json }], catalogue }
function generate(state, views, o = {}) {
  const surfaces = S.parseSurfaces(o.surfaces);
  const conn = { ...DEFAULT_CONNECTION, ...(o.connection || {}) };
  conn.port = Number(conn.port) || DEFAULT_CONNECTION.port;
  const cat = PS.catalogue(state, views, o);
  if (!cat.systems.length) { const e = new Error('No configured system to make pages for'); e.status = 409; throw e; }
  const ids = o.seed !== undefined ? M.idMaker(o.seed) : M.idMaker();
  const build = o.build || 'pv-control-center';
  const sets = surfaces.map((sid) => PS.buildSurface(sid, cat, { ids, connectionId: conn.id, prefix: `${S.PROFILES[sid].short} ` }));
  const asPages = (set) => set.pages.map((p) => M.page(p.id, p.name, p.cells, set.profile.layout, set.grid));
  const d = o.now || new Date(); const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; // local date
  const file = (list, name) => ({
    name, surfaces: list.map((x) => x.profile.id), pages: list.reduce((n, x) => n + x.pages.length, 0),
    warnings: list.flatMap((x) => x.warnings),
    json: M.fullExport(list.flatMap(asPages), conn, { build }),
  });
  const files = o.combined || sets.length === 1
    ? [file(sets, `control-center-${sets.length === 1 ? sets[0].profile.id : 'pages'}-${stamp}.companionconfig`)]
    : sets.map((x) => file([x], `control-center-${x.profile.id}-${stamp}.companionconfig`));
  return { files, catalogue: cat };
}

// what the UI shows before downloading
function describe(state, views, o = {}) {
  const cat = PS.catalogue(state, views, o);
  return {
    surfaces: S.ORDER.map((id) => {
      const p = S.PROFILES[id];
      let pages = []; let warnings = [];
      if (cat.systems.length) { const set = PS.buildSurface(id, cat, { connectionId: 'x', prefix: '' }); pages = set.pages.map((x) => x.name); warnings = set.warnings; }
      return { id, label: p.label, layout: p.layout, cols: p.cols, rows: p.rows, knobs: p.knobCols.length, pages, warnings };
    }),
    systems: cat.systems.map((s) => s.id),
    connection: DEFAULT_CONNECTION,
  };
}

module.exports = { generate, describe, DEFAULT_CONNECTION, PROFILES: S.PROFILES, parseSurfaces: S.parseSurfaces };
