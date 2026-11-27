'use strict';
// Turn Control Center's live state into a flat list of systems the status
// wall can read. One system is one switcher, player, camera desk, cue stack,
// or module connection (vMix, OBS, and the rest).

const { parseTimecode, remainingSeconds } = require('./time');

const CATALOG = [
  ['rs6', 'RS6'],
  ['e2', 'E2'],
  ['pixelhue', 'PixelHue'],
  ['atem', 'ATEM'],
  ['ptz', 'PTZ cameras'],
  ['pixera', 'Pixera'],
  ['millumin', 'Millumin'],
  ['videohub', 'Videohub'],
  ['hyperdeck', 'HyperDeck'],
  ['mitti', 'Mitti'],
  ['cues', 'Cue stack'],
  ['show-cues', 'Show cues'],
  ['desk', 'All systems'],
];

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

function onOff(value) {
  if (value == null || value === '') return null;
  if (value === true || /^(true|1|on|yes)$/i.test(String(value))) return true;
  if (value === false || /^(false|0|off|no)$/i.test(String(value))) return false;
  return null;
}

function word(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return '';
  if (s === 'play' || s === 'playing') return 'Playing';
  if (s === 'stop' || s === 'stopped') return 'Stopped';
  if (s === 'pause' || s === 'paused') return 'Paused';
  if (s === 'record' || s === 'recording') return 'Recording';
  if (s === 'preview') return 'Preview';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function uniqRoles(list) {
  const out = [];
  const seen = new Set();
  for (const row of list || []) {
    if (!row || !row.name) continue;
    const key = `${row.detail || ''}|${row.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: String(row.name), detail: row.detail || '' });
  }
  return out;
}

function blank(id, name, type) {
  return {
    id, name: name || id, type: type || id, online: false, stateText: 'NOT SET UP',
    ip: '', lastSeen: 0, program: [], preview: [], standby: [],
    clip: '', elapsedSec: null, remainingSec: null, transport: '', playNote: 'Not connected.',
    record: null, stream: null, tally: [], summary: 'Not set up',
  };
}

function addressOf(conn, type) {
  const c = conn || {};
  if (type === 'ptz' && Array.isArray(c.cameras)) {
    const hosts = c.cameras.map((cam) => cam && cam.host).filter(Boolean);
    if (hosts.length) return hosts.join(', ');
  }
  const host = c.host || (c.saved && c.saved.host) || '';
  if (!host) return '';
  const port = c.port || c.restPort || '';
  return port ? `${host}:${port}` : String(host);
}

function onlineOf(status) {
  const s = status || {};
  if (s.connected === true || s.link === 'ok') return true;
  if (s.fsm === 'connected' || s.fsm === 'degraded') return true;
  if (s.status === 'online') return true;
  return false;
}

function stateWord(status, online, ip) {
  const s = status || {};
  const fsm = s.fsm || s.link || '';
  if (!online && !ip && fsm !== 'connecting' && fsm !== 'reconnecting') return 'NOT SET UP';
  if (fsm === 'degraded') return 'DEGRADED';
  if (fsm === 'connecting' || fsm === 'reconnecting' || s.status === 'connecting') return 'CONNECTING';
  return online ? 'ONLINE' : 'OFFLINE';
}

function rolesFrom(view) {
  const program = [];
  const preview = [];
  const standby = [];
  if (!view) return { program, preview, standby };
  if (view.programPreset && view.programPreset.name) program.push({ name: view.programPreset.name, detail: 'On program' });
  if (view.previewPreset && view.previewPreset.name) preview.push({ name: view.previewPreset.name, detail: 'Preview' });
  if (view.lastRecalled && view.lastRecalled.name && (!view.programPreset || view.lastRecalled.key !== view.programPreset.key)) {
    standby.push({ name: view.lastRecalled.name, detail: 'Recalled, not taken' });
  }
  const mes = Array.isArray(view.mes) ? view.mes : [];
  for (const me of mes) {
    const bus = Array.isArray(me.bus) ? me.bus : [];
    const label = mes.length > 1 ? `ME ${(me.index || 0) + 1}` : 'ME 1';
    const pgm = bus.find((row) => row && row.pgm);
    const pvw = bus.find((row) => row && row.pvw);
    if (pgm) program.push({ name: pgm.long || pgm.short || String(pgm.id), detail: label });
    if (pvw) preview.push({ name: pvw.long || pvw.short || String(pvw.id), detail: label });
  }
  for (const preset of Array.isArray(view.presets) ? view.presets : []) {
    const tally = preset.tally || {};
    const name = preset.name || (preset.number != null ? `Preset ${preset.number}` : '');
    if (!name) continue;
    if (preset.onProgram || tally.pgm === 'full') program.push({ name, detail: preset.number != null ? `Preset ${preset.number}` : 'On program' });
    else if (preset.onPreview || tally.pvw === 'full') preview.push({ name, detail: preset.number != null ? `Preset ${preset.number}` : 'Preview' });
    else if (preset.lastRecalled) standby.push({ name, detail: 'Recalled, not taken' });
  }
  return { program: uniqRoles(program), preview: uniqRoles(preview), standby: uniqRoles(standby) };
}

function mediaOnAir(view) {
  const sources = Array.isArray(view && view.sources) ? view.sources : [];
  const media = sources.filter((row) => row && row.kind === 'media');
  const mes = Array.isArray(view && view.mes) ? view.mes : [];
  for (const me of mes) {
    const onPgm = media.find((row) => row.id === me.program);
    const onPvw = media.find((row) => row.id === me.preview);
    const hit = onPgm || onPvw;
    if (hit) {
      return {
        clip: hit.long || hit.short || 'Media player',
        transport: onPgm ? 'On program' : 'On preview',
        elapsedSec: null, remainingSec: null,
        playNote: 'This switcher connection does not report clip time.',
        record: null,
      };
    }
  }
  return null;
}

function playbackOf(view, type) {
  const empty = { clip: '', elapsedSec: null, remainingSec: null, transport: '', playNote: '', record: null };
  if (!view) return empty;
  const transport = view.transport;
  if (transport && (type === 'hyperdeck' || transport.timecode != null || transport.clip != null || transport.status)) {
    const elapsed = parseTimecode(transport.timecode);
    const remaining = remainingSeconds({
      elapsed: transport.timecode,
      duration: transport.duration != null ? transport.duration : transport.clipDuration,
      remaining: transport.remaining,
    });
    const status = String(transport.status || '').toLowerCase();
    return {
      clip: transport.clipName || transport.name || (transport.clip != null && transport.clip !== '' ? `Clip ${transport.clip}` : ''),
      elapsedSec: elapsed,
      remainingSec: remaining,
      transport: word(transport.status),
      playNote: remaining == null ? 'Time remaining is not reported by this deck.' : '',
      record: status === 'record' || status === 'recording',
    };
  }
  if (Array.isArray(view.timelines)) {
    const row = view.timelines.find((item) => item && item.selected) || view.timelines.find((item) => item && item.transport === 'play') || view.timelines[0];
    if (!row) return empty;
    const elapsed = parseTimecode(row.position != null ? row.position : row.elapsed);
    const remaining = remainingSeconds({ elapsed: row.position != null ? row.position : row.elapsed, duration: row.duration, remaining: row.remaining });
    return {
      clip: [row.name, row.cue].filter(Boolean).join(' · '),
      elapsedSec: elapsed, remainingSec: remaining, transport: word(row.transport),
      playNote: remaining == null ? 'Time remaining is not reported by this player.' : '',
      record: null,
    };
  }
  if (type === 'millumin' || view.column != null || view.columnName != null || view.media != null) {
    const elapsed = parseTimecode(view.time != null ? view.time : view.position);
    const remaining = remainingSeconds({ elapsed: view.time != null ? view.time : view.position, duration: view.duration, remaining: view.remaining });
    return {
      clip: view.media || view.columnName || (view.column != null ? `Column ${view.column}` : ''),
      elapsedSec: elapsed, remainingSec: remaining, transport: view.running ? 'Playing' : (view.lastCommand ? 'Stopped' : ''),
      playNote: remaining == null ? 'Time remaining is not reported by this player.' : '',
      record: null,
    };
  }
  if (type === 'mitti' || (view.mode && view.cue != null)) {
    return {
      clip: view.cue != null ? String(view.cue) : '', elapsedSec: null, remainingSec: null,
      transport: word(view.mode), playNote: 'Time remaining is not reported by this player.', record: null,
    };
  }
  return mediaOnAir(view) || empty;
}

function tallyOf(view) {
  const items = [];
  for (const cam of Array.isArray(view && view.cameras) ? view.cameras : []) {
    items.push({
      name: cam.name || cam.id || 'Camera',
      live: !!cam.tally, preview: !!cam.tallyGreen, online: cam.connected !== false,
      pan: cam.pos ? cam.pos.pan : null, tilt: cam.pos ? cam.pos.tilt : null, zoom: cam.pos ? cam.pos.zoom : null,
      moving: !!cam.moving,
    });
  }
  const tally = view && view.tally;
  if (tally && Array.isArray(tally.program)) {
    const live = new Set(tally.program.map(String));
    for (const name of tally.program) items.push({ name: String(name), live: true, preview: false });
    for (const name of tally.preview || []) if (!live.has(String(name))) items.push({ name: String(name), live: false, preview: true });
  }
  return items;
}

function finish(base, roles, play, tally) {
  const summary = roles.program.length
    ? roles.program.map((row) => row.name).join(' · ')
    : (play.clip || base.stateText);
  return { ...base, ...roles, ...play, tally, summary };
}

function fromEngine(state, view, inst) {
  const conn = (view && view.connection) || {};
  const settings = state.settings || {};
  const ip = addressOf({ host: conn.host || settings.host, restPort: conn.restPort || settings.restPort }, 'rs6');
  const status = { ...(view && view.status), connected: !!(state.connected || (view && view.status && view.status.connected)) };
  const online = onlineOf(status);
  const play = playbackOf({ presets: state.presets }, 'rs6');
  const roles = rolesFrom({ presets: state.presets, programPreset: view && view.programPreset, previewPreset: view && view.previewPreset, lastRecalled: view && view.lastRecalled });
  const lastSeen = state.live && state.live.lastUpdate ? Date.parse(state.live.lastUpdate) : 0;
  return finish({
    id: 'rs6', name: (inst && inst.name) || 'RS6', type: 'rs6', online,
    stateText: stateWord(status, online, ip), ip, lastSeen: Number.isFinite(lastSeen) ? lastSeen : 0,
    record: null, stream: null,
  }, roles, play.clip ? play : { clip: '', elapsedSec: null, remainingSec: null, transport: '', playNote: '', record: null }, tallyOf(view));
}

function fromView(inst, view) {
  const type = (view && view.type) || (inst && inst.type) || 'system';
  const id = (inst && inst.id) || (view && view.instance) || type;
  const name = (inst && (inst.name || inst.label)) || (view && (view.label || view.short)) || id;
  const conn = (view && view.connection) || (inst && inst.connection) || {};
  const status = (view && view.status) || (inst && inst.status) || {};
  const ip = addressOf(conn, type);
  const online = onlineOf(status);
  const roles = rolesFrom(view);
  const play = playbackOf(view, type);
  return finish({
    id, name, type, online, stateText: stateWord(status, online, ip), ip,
    lastSeen: Number(status.lastSeen) || 0,
    record: play.record, stream: null,
  }, roles, play, tallyOf(view));
}

function fromModule(row) {
  const vars = row.vars || {};
  const online = row.status === 'online' || vars.connected === 'true';
  const host = row.connection && row.connection.host;
  const port = row.connection && row.connection.port;
  const ip = host ? `${host}${port ? `:${port}` : ''}` : '';
  const programName = vars.program || vars.programScene || '';
  const previewName = vars.preview || vars.previewScene || '';
  const remaining = remainingSeconds({
    remaining: vars.remaining != null ? vars.remaining : vars.timeRemaining,
    elapsed: vars.position != null ? vars.position : vars.elapsed,
    duration: vars.duration,
  });
  const elapsed = parseTimecode(vars.position != null ? vars.position : vars.elapsed);
  const roles = {
    program: programName ? [{ name: String(programName), detail: 'Program' }] : [],
    preview: previewName ? [{ name: String(previewName), detail: 'Preview' }] : [],
    standby: [],
  };
  return finish({
    id: row.id, name: row.name || row.label || row.system, type: row.system || 'module',
    online, stateText: online ? 'ONLINE' : 'OFFLINE', ip, lastSeen: Number(row.lastSeen) || 0,
    record: onOff(vars.recording), stream: onOff(vars.streaming),
  }, roles, {
    clip: vars.clip || vars.clipName || programName || '',
    elapsedSec: elapsed, remainingSec: remaining, transport: '',
    playNote: remaining == null ? '' : '', record: onOff(vars.recording),
  }, []);
}

function fromCues(cues, id, name) {
  if (!cues) return null;
  const list = Array.isArray(cues.cues) ? cues.cues : [];
  const machine = cues.machine || null;
  let current = null;
  let next = null;
  if (machine) {
    current = list.find((cue) => cue.id === machine.cueId) || null;
    const idx = current ? list.indexOf(current) : -1;
    next = idx >= 0 ? list.slice(idx + 1).find((cue) => cue && (cue.assigned || (cue.actions && cue.actions.length))) : null;
  } else {
    current = list[cues.index || 0] || null;
    for (let i = (cues.index || 0) + 1; i < list.length; i++) {
      const cue = list[i];
      if (cue && ((cue.steps && cue.steps.length) || cue.name)) { next = cue; break; }
    }
  }
  const run = machine ? machine.state : cues.runState;
  const running = run === 'running';
  const loaded = run === 'loaded' || running;
  const title = current ? (current.name || current.id) : '';
  const roles = {
    program: running && title ? [{ name: title, detail: 'Running' }] : [],
    preview: loaded && !running && title ? [{ name: title, detail: 'Loaded' }] : [],
    standby: next ? [{ name: next.name || next.id, detail: 'Next' }] : [],
  };
  return finish({
    id, name, type: id, online: true,
    stateText: running ? 'RUNNING' : loaded ? 'LOADED' : 'IDLE',
    ip: '', lastSeen: 0, record: null, stream: null,
  }, roles, { clip: '', elapsedSec: null, remainingSec: null, transport: '', playNote: '', record: null }, []);
}

function gather(ctx = {}) {
  const systems = [];
  const seen = new Set();
  const engineState = safe(() => ctx.engine && ctx.engine.getState && ctx.engine.getState(), null);
  const instances = safe(() => (ctx.systems && ctx.systems.listInstances && ctx.systems.listInstances()) || [], []);
  const armed = instances.filter((row) => row && (row.armed || row.configured));
  for (const inst of armed) {
    const view = safe(() => ctx.systems.view(inst.id), null);
    let row;
    if (inst.id === 'rs6' && engineState && !(view && Array.isArray(view.presets) && view.presets.length)) row = fromEngine(engineState, view, inst);
    else row = fromView(inst, view);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    systems.push(row);
  }
  if (engineState && !seen.has('rs6') && (engineState.connected || (engineState.presets || []).some((p) => p.onProgram || p.onPreview))) {
    systems.unshift(fromEngine(engineState, null, { name: 'RS6' }));
    seen.add('rs6');
  }
  const modules = safe(() => ctx.modules && ctx.modules.view && ctx.modules.view(), null);
  for (const row of (modules && modules.instances) || []) {
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    systems.push(fromModule(row));
  }
  const cues = fromCues(safe(() => ctx.cues && ctx.cues.status && ctx.cues.status(), null), 'cues', 'Cue stack');
  if (cues && !seen.has('cues')) systems.push(cues);
  const masters = fromCues(safe(() => ctx.masters && ctx.masters.status && ctx.masters.status(), null), 'show-cues', 'Show cues');
  if (masters && !seen.has('show-cues')) systems.push(masters);
  const gear = systems.filter((row) => row.type !== 'cues' && row.type !== 'show-cues');
  const anyOnline = gear.some((row) => row.online);
  systems.push(finish({
    id: 'desk', name: 'All systems', type: 'desk', online: anyOnline,
    stateText: gear.length ? (anyOnline ? 'ONLINE' : 'OFFLINE') : 'NOT SET UP',
    ip: '', lastSeen: 0, record: gear.some((row) => row.record === true), stream: gear.some((row) => row.stream === true),
  }, {
    program: gear.flatMap((row) => row.program.map((item) => ({ name: item.name, detail: row.name }))),
    preview: gear.flatMap((row) => row.preview.map((item) => ({ name: item.name, detail: row.name }))),
    standby: gear.flatMap((row) => row.standby.map((item) => ({ name: item.name, detail: row.name }))),
  }, { clip: '', elapsedSec: null, remainingSec: null, transport: '', playNote: '', record: null }, gear.flatMap((row) => row.tally.map((item) => ({ ...item, name: gear.length > 1 && row.type !== 'ptz' ? `${row.name} ${item.name}` : item.name })))));
  systems[systems.length - 1].children = gear.map((row) => ({
    id: row.id, name: row.name, online: row.online, stateText: row.stateText, ip: row.ip, lastSeen: row.lastSeen,
    record: row.record, stream: row.stream,
  }));
  return {
    systems,
    companion: ctx.companion || { httpOnline: false, wsOnline: false, version: '', apiVersion: '', error: '', connections: [], variables: {} },
  };
}

function findSystem(state, id) {
  const systems = (state && state.systems) || [];
  return systems.find((row) => row.id === id) || null;
}

function sourceCatalog(state) {
  const have = new Set(((state && state.systems) || []).map((row) => row.id));
  const out = [
    { id: 'clock', kind: 'clock', label: 'House clock', group: 'Clock' },
    { id: 'countdown', kind: 'countdown', label: 'A time you type', group: 'Clock' },
    { id: 'companion-link', kind: 'companion-link', label: 'Companion connection', group: 'Companion' },
    { id: 'companion', kind: 'companion', label: 'A Companion variable', group: 'Companion' },
  ];
  for (const [id, label] of CATALOG) {
    if (have.has(id)) continue;
    out.push({ id, kind: 'system', system: id, label, group: 'Systems' });
  }
  for (const row of (state && state.systems) || []) {
    out.push({ id: row.id, kind: 'system', system: row.id, label: row.name, group: 'On the desk', type: row.type });
  }
  return out;
}

module.exports = { gather, findSystem, sourceCatalog, CATALOG, blank };
