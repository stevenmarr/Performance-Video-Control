'use strict';
// Paint one layout against the gathered state. Pure: same inputs, same board.

const { findSystem, blank } = require('./gather');
const {
  formatClock, formatDuration, formatAge, countdownRemaining, parseTimecode, warnLevel, resolveZone,
} = require('./time');

const COVERAGE = {
  covered: [
    'Time of day, in the time zone and 12-hour or 24-hour clock you set',
    'A countdown to a clock time you type, or to a time a Companion variable holds',
    'Time remaining on a player when that connection reports a length and a position, or a remaining time',
    'Amber under 30 seconds and red under 10 seconds, or the numbers you set on that tile',
    'RS6, E2 and PixelHue presets on program, on preview, and the last one recalled that has not been taken',
    'The cue stack: the loaded cue and the next cue. The show cue list works the same way',
    'ATEM program and preview on each mix effect',
    'ATEM media players when one is on program or preview (the name only)',
    'HyperDeck clip number, timecode, and record, play or stop',
    'Pixera timeline and cue, and play, pause or stop',
    'Millumin column or media, and whether it is running',
    'Mitti cue, and play, pause or stop',
    'Each system: online or offline, its address, and when it last answered',
    'PTZ cameras: live tally, preview tally, pan, tilt, zoom, and whether the head is moving',
    'Record and stream when a HyperDeck is recording, or when a module connection such as vMix or OBS says so',
    'Companion: the web connection, the live link, and the custom variables you name',
  ],
  notYet: [
    'ATEM media player clip time. This switcher connection does not read the media pool clock',
    'HyperDeck clip name and clip length. The deck connection reports the clip number and the timecode',
    'Pixera, Millumin and Mitti time remaining, unless that connection starts reporting a position and a length',
    'A countdown that follows the show file by itself. You set each countdown, or point it at a Companion variable',
    'Companion variables you have not named. Companion does not hand over the whole list',
    'Anything that changes a device. This screen never recalls, takes, records, or writes a variable',
  ],
};

function systemOrStub(state, id) {
  if (!id) return blank('system', 'No system chosen', 'system');
  return findSystem(state, id) || blank(id, id, id);
}

function variableOf(state, name) {
  const bag = state && state.companion && state.companion.variables;
  const row = bag && bag[name];
  if (!row || row.found === false) return { found: false, value: '' };
  const value = row.value == null ? '' : (typeof row.value === 'string' ? row.value : JSON.stringify(row.value));
  return { found: true, value };
}

function zoneFor(tile, layout) {
  return resolveZone((tile && tile.timeZone) || (layout && layout.timeZone) || 'America/Chicago');
}

function hourFor(tile, layout) {
  if (tile && tile.hour12 === true) return true;
  if (tile && tile.hour12 === false) return false;
  return !layout || layout.hour12 !== false;
}

function deg(n) {
  if (n == null || !Number.isFinite(Number(n))) return '';
  return `${Number(n).toFixed(1)}°`;
}

function renderTile(tile, ctx) {
  const layout = ctx.layout || {};
  const state = ctx.state || { systems: [], companion: {} };
  const now = ctx.now;
  const zone = zoneFor(tile, layout);
  const out = {
    id: tile.id, type: tile.type, label: tile.label || defaultLabel(tile),
    col: tile.col, row: tile.row, w: tile.w, h: tile.h, fontSize: tile.fontSize,
    color: tile.color || '', background: tile.background || '',
    warn: 'none', primary: '', secondary: '', kicker: '', note: '', items: [], live: false,
  };
  if (tile.type === 'clock') return renderClock(out, now, zone, hourFor(tile, layout));
  if (tile.type === 'countdown') return renderCountdown(out, tile, state, now, zone);
  if (tile.type === 'timer') return renderTimer(out, tile, state, now);
  if (tile.type === 'text') return renderText(out, tile, state, now, zone, layout);
  if (tile.type === 'tally') return renderTally(out, tile, state);
  if (tile.type === 'online') return renderOnline(out, tile, state, now);
  if (tile.type === 'preset') return renderPreset(out, tile, state);
  out.note = 'This tile has a type the screen does not show.';
  return out;
}

function defaultLabel(tile) {
  const names = { clock: 'Clock', countdown: 'Countdown', timer: 'Time remaining', text: 'Text', tally: 'Tally', online: 'Online', preset: 'Preset' };
  return names[tile.type] || 'Tile';
}

function renderClock(out, now, zone, hour12) {
  const clock = formatClock(now, { timeZone: zone.timeZone, hour12 });
  out.primary = clock.time;
  out.secondary = clock.date;
  out.note = zone.fallback ? 'That time zone is not known. Showing America/Chicago.' : clock.timeZone.replace(/_/g, ' ');
  out.kicker = hour12 ? '12-hour' : '24-hour';
  return out;
}

function renderCountdown(out, tile, state, now, zone) {
  out.kicker = 'TIME REMAINING';
  const warn = tile.warn || {};
  let remaining = null;
  const source = tile.source || {};
  if (source.kind === 'companion') {
    const variable = variableOf(state, source.variable);
    if (!source.variable) out.note = 'Type the Companion variable name.';
    else if (!variable.found) out.note = 'Companion does not have this variable yet.';
    else if (tile.countMode === 'remaining') remaining = parseTimecode(variable.value);
    else {
      const hit = countdownRemaining(variable.value, now, zone.timeZone);
      remaining = hit ? hit.remainingSec : parseTimecode(variable.value);
      if (remaining == null) out.note = 'This value is not a time.';
    }
  } else {
    const at = source.at || '';
    if (!at) out.note = 'Set the clock time for this countdown.';
    else {
      const hit = countdownRemaining(at, now, zone.timeZone);
      if (!hit) out.note = 'That time is not one this screen understands. Try 7:00 PM or 19:00.';
      else remaining = hit.remainingSec;
    }
  }
  out.primary = remaining == null ? '—' : formatDuration(remaining);
  out.warn = warnLevel(remaining, warn);
  if (out.warn === 'over') out.secondary = 'OVER';
  else if (source.at && source.kind !== 'companion') out.secondary = `Until ${source.at}`;
  return out;
}

function renderTimer(out, tile, state, now) {
  out.kicker = 'TIME REMAINING';
  const source = tile.source || {};
  let remaining = null;
  let clip = '';
  let elapsed = null;
  let transport = '';
  let note = '';
  if (source.kind === 'companion') {
    const variable = variableOf(state, source.variable);
    if (!variable.found) note = source.variable ? 'Companion does not have this variable yet.' : 'Type the Companion variable name.';
    else {
      remaining = parseTimecode(variable.value);
      clip = variable.value;
      if (remaining == null) note = 'This value is not a time remaining.';
    }
  } else if (source.kind === 'companion-link') {
    note = 'Point time remaining at a player or a variable.';
  } else {
    const sys = systemOrStub(state, source.system);
    remaining = sys.remainingSec;
    elapsed = sys.elapsedSec;
    clip = sys.clip;
    transport = sys.transport;
    if (!sys.online && remaining == null && !clip) note = sys.stateText === 'NOT SET UP' ? 'Not set up.' : (sys.stateText === 'CONNECTING' ? 'Connecting.' : 'Offline.');
    else if (remaining == null) note = sys.playNote || 'Time remaining is not reported yet.';
  }
  out.primary = remaining == null ? '—' : formatDuration(remaining);
  out.warn = warnLevel(remaining, tile.warn || {});
  const bits = [];
  if (clip) bits.push(clip);
  if (transport) bits.push(transport);
  if (elapsed != null) bits.push(`Elapsed ${formatDuration(elapsed)}`);
  out.secondary = bits.join(' · ');
  out.note = note;
  void now;
  return out;
}

function renderText(out, tile, state, now, zone, layout) {
  const source = tile.source || {};
  if (source.kind === 'clock' || tile.type === 'clock') {
    out.primary = formatClock(now, { timeZone: zone.timeZone, hour12: hourFor(tile, layout) }).time;
    return out;
  }
  if (source.kind === 'companion') {
    const variable = variableOf(state, source.variable);
    out.primary = !source.variable ? '—' : variable.found ? (variable.value || '—') : 'Not set';
    out.note = source.variable ? '' : 'Type the Companion variable name.';
    return out;
  }
  if (source.kind === 'companion-link') {
    const link = state.companion || {};
    out.primary = link.httpOnline ? 'Online' : 'Offline';
    out.secondary = [link.version, link.wsOnline ? 'Live link up' : 'Live link down'].filter(Boolean).join(' · ');
    out.note = link.error || '';
    return out;
  }
  if (source.kind === 'countdown') {
    const hit = source.at ? countdownRemaining(source.at, now, zone.timeZone) : null;
    out.primary = hit ? formatDuration(hit.remainingSec) : '—';
    out.warn = warnLevel(hit && hit.remainingSec, tile.warn || {});
    return out;
  }
  const sys = systemOrStub(state, source.system);
  out.primary = sys.summary || sys.stateText || '—';
  const bits = [];
  if (sys.transport) bits.push(sys.transport);
  if (sys.clip && sys.clip !== sys.summary) bits.push(sys.clip);
  out.secondary = bits.join(' · ');
  if (sys.stateText === 'OFFLINE' || sys.stateText === 'NOT SET UP') out.note = sys.stateText === 'NOT SET UP' ? 'Not set up.' : 'Offline.';
  return out;
}

function renderTally(out, tile, state) {
  const source = tile.source || {};
  if (source.kind === 'companion') {
    const variable = variableOf(state, source.variable);
    const value = variable.value || '';
    const live = /^(1|true|live|pgm|program|red)$/i.test(value.trim());
    out.items = variable.found ? [{ name: source.variable || 'Variable', live, preview: false, text: value }] : [];
    out.primary = live ? 'LIVE' : (variable.found ? (value || '—') : 'Not set');
    out.live = live;
    return out;
  }
  const sys = systemOrStub(state, source.system);
  const items = (sys.tally || []).map((row) => ({
    name: row.name,
    live: !!row.live,
    preview: !!row.preview && !row.live,
    online: row.online !== false,
    moving: !!row.moving,
    meta: [deg(row.pan) && `Pan ${deg(row.pan)}`, deg(row.tilt) && `Tilt ${deg(row.tilt)}`, row.zoom != null && Number.isFinite(Number(row.zoom)) ? `Zoom ${Number(row.zoom).toFixed(0)}%` : ''].filter(Boolean).join(' · '),
  }));
  out.items = items;
  const live = items.filter((row) => row.live);
  out.live = live.length > 0;
  out.primary = live.length ? live.map((row) => row.name).join(', ') : (items.length ? 'None live' : 'No tally');
  out.note = items.length ? '' : (sys.stateText === 'ONLINE' ? 'Nothing is reporting tally.' : sys.stateText);
  return out;
}

function renderOnline(out, tile, state, now) {
  const source = tile.source || {};
  if (source.kind === 'companion' || source.kind === 'companion-link') {
    const link = state.companion || {};
    out.primary = link.httpOnline ? 'ONLINE' : 'OFFLINE';
    out.secondary = link.wsOnline ? 'Live link up' : 'Live link down';
    out.note = link.error || link.version || '';
    out.live = false;
    return out;
  }
  const sys = systemOrStub(state, source.system);
  if (sys.type === 'desk' && Array.isArray(sys.children)) {
    out.primary = sys.children.some((row) => row.online) ? 'ONLINE' : 'OFFLINE';
    out.items = sys.children.map((row) => ({
      name: row.name,
      online: !!row.online,
      stateText: row.stateText,
      ip: row.ip || '',
      age: formatAge(row.lastSeen, now),
      record: row.record === true,
      stream: row.stream === true,
    }));
    out.note = out.items.length ? '' : 'No systems on the desk.';
    return out;
  }
  out.primary = sys.stateText || 'OFFLINE';
  const bits = [sys.ip, formatAge(sys.lastSeen, now)].filter(Boolean);
  if (sys.record === true) bits.push('Recording');
  if (sys.stream === true) bits.push('Streaming');
  out.secondary = bits.join(' · ');
  return out;
}

function renderPreset(out, tile, state) {
  const source = tile.source || {};
  if (source.kind === 'companion') {
    const variable = variableOf(state, source.variable);
    out.primary = variable.found ? (variable.value || '—') : 'Not set';
    out.items = variable.found && variable.value ? [{ role: 'program', name: variable.value, detail: 'Companion' }] : [];
    return out;
  }
  const sys = systemOrStub(state, source.system);
  const items = [];
  for (const row of sys.program || []) items.push({ role: 'program', name: row.name, detail: row.detail || sys.name });
  for (const row of sys.preview || []) items.push({ role: 'preview', name: row.name, detail: row.detail || '' });
  for (const row of sys.standby || []) items.push({ role: 'standby', name: row.name, detail: row.detail || 'Recalled, not taken' });
  out.items = items;
  const pgm = items.filter((row) => row.role === 'program');
  out.primary = pgm.length ? pgm.map((row) => row.name).join(' · ') : 'Nothing on program';
  out.live = pgm.length > 0;
  if (!items.length && (sys.stateText === 'OFFLINE' || sys.stateText === 'NOT SET UP')) out.note = sys.stateText === 'NOT SET UP' ? 'Not set up.' : 'Offline.';
  return out;
}

function renderBoard({ now, layout, state }) {
  const tiles = (layout.tiles || []).map((tile) => renderTile(tile, { now, layout, state }));
  const link = state.companion || {};
  return {
    at: now,
    layout: {
      id: layout.id, name: layout.name, timeZone: layout.timeZone, hour12: layout.hour12 !== false,
      notes: layout.notes !== false, editLink: layout.editLink !== false,
    },
    tiles,
    companion: {
      httpOnline: !!link.httpOnline, wsOnline: !!link.wsOnline,
      version: link.version || '', apiVersion: link.apiVersion || '', error: link.error || '',
      connections: Array.isArray(link.connections) ? link.connections : [],
    },
    coverage: layout.notes === false ? { covered: [], notYet: [] } : COVERAGE,
  };
}

module.exports = { renderBoard, renderTile, COVERAGE };
