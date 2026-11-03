'use strict';
// One key object for every Stream Deck control. The shape follows Companion:
// a style, a list of actions per event, and feedbacks that override the style.
// A page is data (JSON). A role is a preset of style plus the usual feedbacks.

const ROLES = {
  program: { bgcolor: '#5c2428', color: '#F4F7FB', bar: '#C42020' },
  preview: { bgcolor: '#1a3d28', color: '#F4F7FB', bar: '#3DDC84' },
  hot: { bgcolor: '#C42020', color: '#FFFFFF', bar: '#E0B030' },
  shift: { bgcolor: '#2a2a2e', color: '#F4F7FB', bar: '#E0B030' },
  'flex-macro': { bgcolor: '#1A4FA0', color: '#FFFFFF', bar: null },
  'flex-memory': { bgcolor: '#A03A8C', color: '#FFFFFF', bar: null },
  flex: { bgcolor: '#2a2a2e', color: '#C5D0DC', bar: null },
  nav: { bgcolor: '#243044', color: '#F4F7FB', bar: '#5B7C99', os: true },
  tab: { bgcolor: '#141c28', color: '#F4F7FB', bar: '#5B7C99' },
  info: { bgcolor: '#243044', color: '#F4F7FB', bar: '#5B7C99', os: true },
  toggle: { bgcolor: '#2a2a2e', color: '#F4F7FB', bar: '#E0B030' },
  blank: { bgcolor: '#14161A', color: '#14161A', bar: '#14161A' },
};

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

function applyFeedbacks(style, feedbacks, flags) {
  const out = { ...style };
  for (const fb of feedbacks || []) {
    if (!fb) continue;
    const on = fb.when ? flags && flags[fb.when] === true : true;
    if (!on) continue;
    const patch = typeof fb.style === 'function' ? fb.style(flags) : fb.style;
    if (patch && typeof patch === 'object') Object.assign(out, patch);
  }
  return out;
}

function resolveKey(key, flags, vars) {
  const role = ROLES[key.role] || ROLES.flex;
  const base = {
    bgcolor: key.style && key.style.bgcolor || role.bgcolor,
    color: key.style && key.style.color || role.color,
    bar: key.style && key.style.bar !== undefined ? key.style.bar : role.bar,
    os: !!(key.style && key.style.os) || !!role.os,
  };
  const style = applyFeedbacks(base, [...(key.feedbacks || [])], flags || {});
  if (style.bar == null) style.bar = style.bgcolor;
  const text = breakLines(substitute(key.text, vars));
  const title = substitute(key.title || '', vars);
  const caption = substitute(key.caption || '', vars);
  return { ...key, style, text, title, caption };
}

function faceFromKey(resolved) {
  const style = resolved.style || {};
  return {
    fill: style.bgcolor,
    ink: style.color,
    dim: style.color,
    bar: style.bar || style.bgcolor,
    border: style.border || null,
    os: !!style.os,
    title: resolved.title || '',
    value: resolved.text || '',
    caption: resolved.caption || '',
  };
}

module.exports = { ROLES, substitute, breakLines, resolveKey, faceFromKey, applyFeedbacks };
