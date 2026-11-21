'use strict';
// 0.33.0 (0.34.1: module 0.14.0 lists only Control Center presets): what the COMPANION tab says about the Control Center deck pages in Companion (CC deck: ... presets): how
// many the module publishes, or why there are none and how to turn them on. Pure, so test/companion-advice.test.js
// can run it; the tab uses window.CCAdvice.
(function (root) {
  const SIZES = { plusxl: 'Stream Deck + XL', plus: 'Stream Deck +', xl: 'Stream Deck XL', mk2: 'Stream Deck MK.2' };
  function atLeast(v, min) {
    const a = String(v || '').split('.').map((n) => parseInt(n, 10) || 0);
    const b = String(min).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); }
    return true;
  }
  const ENABLE = (label) => `To turn them on: in Companion open Connections → ${label || 'the Control Center connection'} → its settings, set "Control Center deck pages for" to Stream Deck + XL (or your deck sizes), and Save. Then press SYNC here.`;

  // v: GET /api/companion. Returns [{ cls: 'ok' | 'warn' | 'off', text }]
  function deckAdvice(v) {
    const out = [];
    const deckMin = v.deckMinVersion || '0.12.0';
    const reportMin = v.deckReportVersion || '0.13.0';
    const conns = (v.status && v.status.connections) || [];
    for (const c of conns.filter((x) => x.oldImport)) {
      out.push({ cls: 'off', text: `Connection "${c.label || c.id}" runs an imported copy of the module (v${c.versionId}), which has no deck pages. PV Companion moves it to its newer built-in copy at start-up (update PV Companion and restart it). Or in Companion edit the connection and set its module version to Builtin. Then remove v${c.versionId} under Modules → Performance Video Control Center.` });
    }
    const m = v.module;
    if (!m) return out;
    const label = m.label || (conns[0] && conns[0].label) || '';
    if (!atLeast(m.version, deckMin)) {
      out.push({ cls: 'off', text: `Module ${m.version || '?'} has no deck pages (PTZ, ATEM, HOME and CONSOLE with the knobs and touch strip). They need module ${deckMin} or newer: PV Companion has it built in.` });
      return out;
    }
    if (!atLeast(m.version, reportMin) || m.deckPresets == null) {
      out.push({ cls: 'warn', text: `Module ${m.version} has the deck pages but does not report them here, so this tab cannot tell whether they are published. In Companion they are Presets → Performance Video Control Center → "CC deck: …", after the module's other sections in this version (module ${reportMin} and newer list them first; 0.14.0 lists only Control Center presets). If there is no "CC deck:" section: ${ENABLE(label)}` });
      return out;
    }
    const sizes = (m.deckSurfaces || []).map((s) => SIZES[s] || s).join(', ') || 'no deck size';
    if (m.deckPresets > 0) {
      out.push({ cls: 'ok', text: `Deck pages: ${m.deckPresets} presets for ${sizes}. In Companion: Presets → Performance Video Control Center → "CC deck: …" (listed first).` });
      return out;
    }
    if (m.deckState === 'error') out.push({ cls: 'off', text: `Deck pages: 0 presets. The module cannot read them from this app (${m.deckError || 'no answer'}). Check that its host and port point at this app. ${ENABLE(label)}` });
    else if (m.deckState === 'loading') out.push({ cls: 'warn', text: 'Deck pages: loading. The module is fetching them from this app; this updates within 30 seconds.' });
    else if (!(m.deckSurfaces || []).length) out.push({ cls: 'off', text: `Deck pages are off: "Control Center deck pages for" is empty on this connection. ${ENABLE(label)}` });
    else out.push({ cls: 'off', text: `Deck pages: 0 presets for ${sizes}. The module has not started them. ${ENABLE(label)}` });
    return out;
  }

  const api = { deckAdvice, atLeast };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CCAdvice = api;
})(typeof window !== 'undefined' ? window : this);
