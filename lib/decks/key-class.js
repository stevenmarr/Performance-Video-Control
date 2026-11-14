'use strict';
// One key object for every Stream Deck control. The shape follows Companion:
// a style, a list of actions per event, and feedbacks that override the style.
// A page is data (JSON). A role is a preset of style plus the usual feedbacks.

const DARK = {
  program: { bgcolor: '#5c2428', color: '#F4F7FB', bar: '#C42020' },
  preview: { bgcolor: '#1a3d28', color: '#F4F7FB', bar: '#3DDC84' },
  hot: { bgcolor: '#C42020', color: '#FFFFFF', bar: '#E0B030' },
  shift: { bgcolor: '#2a2a2e', color: '#F4F7FB', bar: '#E0B030' },
  'flex-macro': { bgcolor: '#1A4FA0', color: '#FFFFFF', bar: null },
  'flex-memory': { bgcolor: '#A03A8C', color: '#FFFFFF', bar: null },
  // Library names for the same two looks. The + XL page still stores flex-macro and flex-memory.
  macro: { bgcolor: '#1A4FA0', color: '#FFFFFF', bar: null },
  memory: { bgcolor: '#A03A8C', color: '#FFFFFF', bar: null },
  flex: { bgcolor: '#2a2a2e', color: '#C5D0DC', bar: null },
  nav: { bgcolor: '#243044', color: '#F4F7FB', bar: '#5B7C99', os: true },
  tab: { bgcolor: '#141c28', color: '#F4F7FB', bar: '#5B7C99' },
  info: { bgcolor: '#243044', color: '#F4F7FB', bar: '#5B7C99', os: true },
  toggle: { bgcolor: '#2a2a2e', color: '#F4F7FB', bar: '#E0B030' },
  blank: { bgcolor: '#14161A', color: '#14161A', bar: '#14161A' },
};

// Light mode keeps the same meanings: green preview, red only for on-air,
// amber for a key that needs confirmation, slate for an OS key. Fills are
// light and the text is dark so the pair stays high contrast.
const LIGHT = {
  program: { bgcolor: '#F8D7DA', color: '#3B0A0E', bar: '#C42020' },
  preview: { bgcolor: '#D8F6E4', color: '#06321A', bar: '#148F46' },
  hot: { bgcolor: '#C42020', color: '#FFFFFF', bar: '#8A5A00' },
  shift: { bgcolor: '#FBF3D5', color: '#2A2108', bar: '#8A5A00' },
  'flex-macro': { bgcolor: '#1A4FA0', color: '#FFFFFF', bar: null },
  'flex-memory': { bgcolor: '#A03A8C', color: '#FFFFFF', bar: null },
  macro: { bgcolor: '#1A4FA0', color: '#FFFFFF', bar: null },
  memory: { bgcolor: '#A03A8C', color: '#FFFFFF', bar: null },
  flex: { bgcolor: '#E6E8EC', color: '#1A1E24', bar: null },
  nav: { bgcolor: '#E8EEF6', color: '#0C1524', bar: '#3E5C78', os: true },
  tab: { bgcolor: '#F4F7FB', color: '#0C1524', bar: '#3E5C78' },
  info: { bgcolor: '#E8EEF6', color: '#0C1524', bar: '#3E5C78', os: true },
  toggle: { bgcolor: '#EEF1F4', color: '#12161C', bar: '#8A5A00' },
  blank: { bgcolor: '#F4F5F7', color: '#F4F5F7', bar: '#F4F5F7' },
};

const THEMES = { dark: DARK, light: LIGHT };
const ROLES = DARK;

function substitute(text, vars) {
  return String(text == null ? '' : text).replace(/\$\(([^)]+)\)/g, (_, name) => {
    const value = vars && vars[name];
    return value == null ? '' : String(value);
  });
}

function breakLines(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  if (raw.includes('\n')) return raw;
  const words = raw.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word;
    if (next.length > 10 && cur) { lines.push(cur); cur = word; }
    else cur = next;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3).join('\n');
}

function compareFlag(left, op, right) {
  const a = left == null ? '' : String(left);
  const b = right == null ? '' : String(right);
  if (op === 'truthy') return a !== '' && a !== 'false' && a !== '0';
  if (op === 'ne') return a !== b;
  if (op === 'contains') return a.toLowerCase().includes(b.toLowerCase());
  const na = Number(a);
  const nb = Number(b);
  if (op === 'gt') return na > nb;
  if (op === 'lt') return na < nb;
  if (op === 'gte') return na >= nb;
  if (op === 'lte') return na <= nb;
  return a === b;
}

function feedbackOn(fb, flags, vars) {
  if (fb.variable) return compareFlag(vars && (vars[fb.variable] != null ? vars[fb.variable] : vars[fb.variable.replace(':', '.')]), fb.op || 'eq', fb.value);
  if (fb.when) return !!(flags && flags[fb.when] === true);
  return true;
}

function applyFeedbacks(style, feedbacks, flags, vars) {
  const out = { ...style };
  for (const fb of feedbacks || []) {
    if (!fb) continue;
    if (!feedbackOn(fb, flags, vars)) continue;
    const patch = typeof fb.style === 'function' ? fb.style(flags) : fb.style;
    if (patch && typeof patch === 'object') Object.assign(out, patch);
  }
  return out;
}

function themeOf(key, theme) {
  if (theme === 'light' || theme === 'dark') return theme;
  return key && key.theme === 'light' ? 'light' : 'dark';
}

function resolveKey(key, flags, vars, theme) {
  const mode = themeOf(key, theme);
  const roles = THEMES[mode];
  const role = roles[key.role] || roles.flex;
  const base = {
    bgcolor: key.style && key.style.bgcolor || role.bgcolor,
    color: key.style && key.style.color || role.color,
    bar: key.style && key.style.bar !== undefined ? key.style.bar : role.bar,
    os: !!(key.style && key.style.os) || !!role.os,
    border: key.style && key.style.border || (role.os ? (mode === 'light' ? '#243044' : '#8EA0B5') : (mode === 'light' ? '#8A97A8' : null)),
  };
  const style = applyFeedbacks(base, [...(key.feedbacks || [])], flags || {}, vars || {});
  if (key.confirm) {
    style.guard = true;
    style.border = mode === 'light' ? '#8A5A00' : '#E0B030';
  }
  if (style.bar == null) style.bar = style.bgcolor;
  const text = breakLines(substitute(key.text, vars));
  const title = substitute(key.title || '', vars);
  const caption = substitute(key.caption || '', vars);
  return { ...key, theme: mode, style, text, title, caption };
}

function actionList(key, event) {
  const actions = key && key.actions;
  return actions && Array.isArray(actions[event]) ? actions[event].slice() : [];
}

function faceFromKey(resolved) {
  const style = resolved.style || {};
  return {
    fill: style.bgcolor,
    ink: style.color,
    dim: style.color,
    bar: style.bar || style.bgcolor,
    border: style.border || null,
    guard: !!style.guard,
    os: !!style.os,
    title: resolved.title || '',
    value: resolved.text || '',
    caption: resolved.caption || '',
  };
}

module.exports = { ROLES, THEMES, substitute, breakLines, resolveKey, faceFromKey, applyFeedbacks, actionList, themeOf };
