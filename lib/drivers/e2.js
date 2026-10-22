'use strict';
// Barco Event Master (E2 / S3-4K / Ex / ...) driver over the documented JSON-RPC API.
// Reference: "Event Master series remote control protocol Reference guide", Barco R5919184 v02 (12 Feb 2026),
// chapter 2 "JSON RPC" (Toolset 10.x commands, §2.2; Toolset 9.x, §2.3). HTTP POST of JSON-RPC 2.0 to
// http://<ip>:9999 (fixed port; send to the host unit of a multi-frame system). Requests are case sensitive.
// Every response is {"jsonrpc":"2.0","id":..,"result":{"success":0,"response":...}}, success 0 = OK.
// Page numbers below are the printed page numbers of R5919184/02.
const { httpJson, destKey, parseKey } = require('./common');

const val = (x) => (x && typeof x === 'object' && '$t' in x ? x.$t : x); // listStill wraps values as {Min,Max,$t}

class E2Driver {
  constructor(conn = {}, log = () => {}) {
    this.system = 'e2';
    this.log = log;
    this.capabilities = { presets: true, recallPreview: true, recallProgram: true, take: true, cut: true, destinations: true, armDestinations: true,
      sources: true, freeze: true, auxRoute: true, stills: true, cues: true, backups: true, destFilteredRecall: false };
    this.configure(conn);
    this.st = { connected: false, info: null, error: null, lastSeen: 0 };
    this.seq = 0;
  }
  configure(conn) { this.conn = { host: '', port: 9999, operatorId: null, transTime: null, timeout: 4000, ...conn }; }
  close() { this.st.connected = false; }
  status() { return { ...this.st }; }

  // One JSON-RPC call. Throws on transport errors, JSON-RPC errors and success != 0.
  async rpc(method, params = {}) {
    if (!this.conn.host) throw new Error('E2: no IP address set (System tab)');
    const id = String(++this.seq);
    let r;
    try {
      r = await httpJson({ host: this.conn.host, port: Number(this.conn.port) || 9999, method: 'POST', path: '/', body: { jsonrpc: '2.0', method, params, id }, timeout: this.conn.timeout });
    } catch (e) { this.st.connected = false; this.st.error = e.message; throw e; }
    this.st.lastSeen = Date.now();
    if (!r) throw new Error(`E2 ${method}: empty response`);
    if (r.error) throw new Error(`E2 ${method}: ${r.error.message || JSON.stringify(r.error)}`);
    const res = r.result;
    if (res && typeof res === 'object' && 'success' in res) {
      if (Number(res.success) !== 0) throw new Error(`E2 ${method}: error ${res.success}${res.response && typeof res.response === 'string' ? ` (${res.response})` : ''}`);
      return res.response;
    }
    return res;
  }
  _op(params) { // multi-operator mode (p.25, p.29, p.30): only when an operator is configured
    const op = this.conn.operatorId;
    return op === null || op === undefined || op === '' ? params : { ...params, operatorId: Number(op) };
  }

  async connect() {
    const fs = await this.rpc('getFrameSettings', {}); // p.13
    const sys = (fs && fs.System) || {};
    const frame = (sys.FrameCollection && sys.FrameCollection.Frame) || {};
    const frames = Array.isArray(frame) ? frame : [frame];
    const host = frames.find((f) => f && f.isHost) || frames[0] || {};
    const info = { model: host.FrameTypeName || host.Name || 'Event Master', frameType: host.FrameType, name: sys.Name || host.Name || '', version: host.Version || '', frames: frames.length };
    this.st = { connected: true, info, error: null, lastSeen: Date.now() };
    return info;
  }
  async heartbeat() { // powerStatus is the lightest documented read (p.14)
    try { await this.rpc('powerStatus', {}); this.st.connected = true; this.st.error = null; } catch (e) { this.st.connected = false; this.st.error = e.message; throw e; }
  }

  // ---------- destinations (listDestinations p.19, listAuxContent p.20) ----------
  async listDestinations() {
    const r = (await this.rpc('listDestinations', { type: 0 })) || {};
    const out = [];
    for (const s of r.ScreenDestination || []) out.push({ key: destKey('screen', s.id + 1), kind: 'screen', id: s.id, label: s.Name || `Screen ${s.id + 1}`, size: s.HSize ? `${s.HSize}×${s.VSize}` : '' });
    for (const a of r.AuxDestination || []) {
      let name = a.Name;
      if (!name) { try { const c = await this.rpc('listAuxContent', { id: a.id }); name = c && c.Name; } catch { /* name stays generic */ } }
      out.push({ key: destKey('aux', a.id + 1), kind: 'aux', id: a.id, label: name || `Aux ${a.id + 1}` });
    }
    return out;
  }
  _destParams(keys) {
    const scr = []; const aux = [];
    for (const k of keys) { const p = parseKey(k); if (!p) continue; (p.kind === 'screen' ? scr : aux).push({ id: p.n - 1 }); }
    return { ScreenDestination: scr, AuxDestination: aux };
  }

  // ---------- presets (listPresets p.24, listDestinationsForPreset p.27, activatePreset p.26) ----------
  async listPresets() {
    const list = (await this.rpc('listPresets', { ScreenDest: -1, AuxDest: -1 })) || [];
    let dests = null;
    try { dests = await this.rpc('listDestinationsForPreset', { id: -1 }); } catch (e) { this.log('warn', `E2 listDestinationsForPreset failed (${e.message}); preset tiles show no destinations`); }
    const byId = new Map((Array.isArray(dests) ? dests : []).map((d) => [d.id, d]));
    return (Array.isArray(list) ? list : []).map((p) => {
      const d = byId.get(p.id);
      const keys = d ? [...(d.ScreenDest || []).map((x) => destKey('screen', x.id + 1)), ...(d.AuxDest || []).map((x) => destKey('aux', x.id + 1))] : null;
      const sno = Number(p.presetSno);
      return { key: `e2:${p.id}`, id: p.id, number: Number.isFinite(sno) ? sno : p.id + 1, sno: Number.isFinite(sno) ? sno.toFixed(2) : '', name: p.Name || `Preset ${p.id}`, locked: !!val(p.LockMode), dests: keys };
    });
  }
  // The API has no destination argument on activatePreset: a recall always affects the destinations stored in
  // the preset. type 0 = preview (default), 1 = program.
  async recall(preset, { target = 'preview' } = {}) {
    return this.rpc('activatePreset', this._op({ id: preset.id, type: target === 'program' ? 1 : 0 }));
  }

  // ---------- transitions (armUnarmDestination p.28, allTrans p.29, cut p.30) ----------
  // allTrans / cut act on the ARMED destinations, so the app arms exactly the selected ones first.
  async select(keys, allKeys = []) {
    const on = this._destParams(keys);
    const off = this._destParams(allKeys.filter((k) => !keys.includes(k)));
    if (off.ScreenDestination.length || off.AuxDestination.length) await this.rpc('armUnarmDestination', { arm: 0, ...off });
    if (on.ScreenDestination.length || on.AuxDestination.length) await this.rpc('armUnarmDestination', { arm: 1, ...on });
  }
  async take(keys, { allKeys = [], transTime } = {}) {
    if (keys) await this.select(keys, allKeys);
    const t = transTime ?? this.conn.transTime;
    return this.rpc('allTrans', this._op(t === null || t === undefined || t === '' ? {} : { transTime: Number(t) }));
  }
  async cut(keys, { allKeys = [] } = {}) {
    if (keys) await this.select(keys, allKeys);
    return this.rpc('cut', this._op({}));
  }

  // ---------- sources, freeze, aux routing (listSources p.17, freezeDestSource p.27, changeAuxContent p.20) ----------
  async listSources() {
    const r = await this.rpc('listSources', {});
    const list = Array.isArray(r) ? r : r ? [r] : [];
    const STATUS = { 0: 'invalid', 1: 'ok', 2: 'format mismatch', 3: 'out of range', 4: 'no sync' };
    return list.map((s) => {
      const kind = s.SrcType === 1 ? 'still' : s.SrcType === 0 ? 'input' : s.DestIndex >= 0 ? 'dest' : 'other';
      return { key: `src:${s.id}`, id: s.id, name: s.Name || `Source ${s.id + 1}`, kind, inputCfg: s.InputCfgIndex, stillIndex: s.StillIndex, frozen: !!s.Freeze,
        status: s.InputCfgVideoStatus !== undefined ? STATUS[s.InputCfgVideoStatus] || String(s.InputCfgVideoStatus) : '', size: s.HSize ? `${s.HSize}×${s.VSize}` : '' };
    });
  }
  // type 0 input (id = input config index), 2 screen destination, 3 aux destination; mode 1 freeze / 0 unfreeze
  async freeze(kind, id, on) {
    const type = { input: 0, screen: 2, aux: 3 }[kind];
    if (type === undefined) throw new Error(`E2 freeze: unknown kind ${kind}`);
    return this.rpc('freezeDestSource', { type, id: Number(id), screengroup: 0, mode: on ? 1 : 0 });
  }
  async routeAux(auxKey, sourceId, target = 'preview') {
    const p = parseKey(auxKey); if (!p || p.kind !== 'aux') throw new Error(`Not an aux destination: ${auxKey}`);
    return this.rpc('changeAuxContent', { id: p.n - 1, [target === 'program' ? 'PgmLastSrcIndex' : 'PvwLastSrcIndex']: Number(sourceId) });
  }

  // ---------- cues (listCues / activateCue p.30) ----------
  async listCues() {
    const r = await this.rpc('listCues', {});
    return (Array.isArray(r) ? r : r ? [r] : []).map((c) => ({ key: `cue:${c.id}`, id: c.id, name: c.Name || c.name || `Cue ${c.id + 1}`, number: c.cueSno ?? c.CueSno ?? c.id + 1 }));
  }
  async activateCue(id, action = 'play') { return this.rpc('activateCue', { id: Number(id), type: { play: 0, pause: 1, stop: 2 }[action] ?? 0 }); }

  // ---------- stills (listStill p.17, takeStill p.18, deleteStill p.18) ----------
  async listStills() {
    const r = await this.rpc('listStill', {});
    return (Array.isArray(r) ? r : []).map((s) => ({ key: `still:${s.id}`, id: s.id, name: s.Name || `Still ${s.id + 1}`, size: val(s.HSize) ? `${val(s.HSize)}×${val(s.VSize)}` : '', state: val(s.StillState), fileKB: val(s.FileSize) }));
  }
  async takeStill(inputId, file) { return this.rpc('takeStill', { type: 0, id: Number(inputId), file: Number(file) }); }
  async deleteStill(id) { return this.rpc('deleteStill', { id: Number(id) }); }

  // ---------- input backups (listSourceMainBackup p.18, activateSourceMainBackup p.19, resetSourceMainBackup p.19) ----------
  async listBackups() {
    const r = await this.rpc('listSourceMainBackup', { inputType: -1 });
    const list = Array.isArray(r) ? r : r ? [r] : [];
    return list.map((x) => ({ key: `bk:${x.id}`, id: x.id, name: x.Name || `Input ${x.id + 1}`, videoStatus: x.VideoStatus, active: x.BackUpState ?? x.BackupState ?? -1,
      backups: (x.Backup || []).map((b) => ({ id: b.id, inputId: b.inputId, stillId: b.stillId, destId: b.destId, name: b.Name || '' })) }));
  }
  // slot -1 = primary (resetSourceMainBackup); 0..2 = that backup (activateSourceMainBackup with the existing config)
  async selectBackup(inputId, slot) {
    if (Number(slot) < 0) return this.rpc('resetSourceMainBackup', { id: Number(inputId) });
    const all = await this.listBackups();
    const row = all.find((x) => x.id === Number(inputId));
    if (!row) throw new Error(`E2: input ${inputId} has no backups configured`);
    const params = { inputId: Number(inputId), BackUpState: Number(slot) };
    for (const b of row.backups) {
      if (b.inputId !== null && b.inputId !== undefined) params[`Backup${b.id + 1}`] = { SrcType: 0, SourceId: b.inputId };
      else if (b.stillId !== null && b.stillId !== undefined) params[`Backup${b.id + 1}`] = { SrcType: 1, SourceId: b.stillId };
    }
    return this.rpc('activateSourceMainBackup', params);
  }
}

module.exports = { E2Driver };
