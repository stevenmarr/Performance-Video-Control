'use strict';
// 0.11.0 auto recall ("bail to"): after a TAKE / CUT puts preset P on Program, a follow-up preset is recalled to
// Preview once the transition is done, ready for the next TAKE (it never takes by itself).
// Which one, in order of precedence, all gated by the universal switch (`enabled`):
//   1. the preset's own setting  {enabled?: true | false, target?: id}   (enabled false = never for this preset)
//   2. the first group it belongs to (by preset, or by sharing a destination)  {enabled, target}
//   3. the show-wide default target (`default`, 0 = none)
// A target equal to P, or one that no longer exists, means none. Ids are RS6 preset numbers or E2 / PixelHue keys.
const MAX_GROUPS = 32;

const cleanId = (v, num) => {
  if (num) { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 9999 ? n : 0; }
  return typeof v === 'string' && v && v.length <= 80 ? v : 0;
};
// a preset's own setting; legacy numbers (0 = off, N = target N) are read too. null = inherit everything.
function cleanOwn(raw, num) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') { if (raw === 0 || raw === '0' || raw === false) return { enabled: false }; const t = cleanId(raw, num); return t ? { target: t } : null; }
  const o = {}; if (raw.enabled === true || raw.enabled === false) o.enabled = raw.enabled;
  const t = cleanId(raw.target, num); if (t) o.target = t;
  return Object.keys(o).length ? o : null;
}
function cleanGroups(raw, num) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((g) => g && typeof g === 'object').slice(0, MAX_GROUPS).map((g, i) => ({
    id: typeof g.id === 'string' && /^[\w-]{1,40}$/.test(g.id) ? g.id : `g${i + 1}`,
    name: String(g.name || `Group ${i + 1}`).trim().slice(0, 40) || `Group ${i + 1}`,
    enabled: g.enabled !== false,
    target: cleanId(g.target, num),
    presets: [...new Set((Array.isArray(g.presets) ? g.presets : []).map((x) => cleanId(x, num)).filter(Boolean))].slice(0, 500),
    dests: [...new Set((Array.isArray(g.dests) ? g.dests : []).map(String).filter((d) => /^[SA]\d{1,3}$/.test(d)))],
  }));
}
function cleanDelay(v, d = 1000) { const n = Number(v); return v !== null && v !== '' && Number.isFinite(n) ? Math.max(0, Math.min(60000, Math.round(n))) : d; }

// cfg: {enabled, default, groups}; p: {id, dests}; own: cleanOwn(); exists(id) → bool
function resolve(cfg, p, own, exists) {
  const none = (reason, source = null, group = null) => ({ target: 0, source, group, reason });
  if (!cfg.enabled) return none('auto recall is off');
  const o = own || {};
  if (o.enabled === false) return none('off for this preset', 'preset');
  const dests = p.dests || [];
  const g = (cfg.groups || []).find((x) => x.presets.includes(p.id) || (x.dests.length && dests.some((d) => x.dests.includes(d)))) || null;
  if (o.enabled !== true && g && !g.enabled) return none(`off for group "${g.name}"`, 'group', g.name);
  let target = 0; let source = null;
  if (o.target) { target = o.target; source = 'preset'; } else if (g && g.target) { target = g.target; source = 'group'; } else if (cfg.default) { target = cfg.default; source = 'default'; }
  if (!target) return none('no target', null, g ? g.name : null);
  if (target === p.id) return none('target is this preset', source, g ? g.name : null);
  if (!exists(target)) return none('target preset is missing', source, g ? g.name : null);
  return { target, source, group: source === 'group' ? g.name : g ? g.name : null, reason: '' };
}
module.exports = { cleanOwn, cleanGroups, cleanId, cleanDelay, resolve, MAX_GROUPS };
