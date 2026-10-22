'use strict';
// Mock Barco Event Master (E2) JSON-RPC server for tests and --mock. Implements the methods of R5919184/02
// chapter 2.2 that the app uses, with the documented request / response shapes. A test double, not an emulator:
// it keeps a simple model (destinations with a preview / program preset, armed flags, sources, stills, cues,
// backups) and records every call in `history`. Unknown methods answer a JSON-RPC "method not found".
const http = require('http');

const SCREENS = ['Main LED', 'IMAG Left', 'IMAG Right', 'Stage Floor'];
const AUXES = ['Confidence', 'Record', 'Stream'];
const INPUTS = ['Cam 1 Wide', 'Cam 2 Tight', 'Cam 3 Jib', 'PPT Main', 'PPT Backup', 'Playback A', 'Playback B', 'Walk-in Loop', 'Zoom', 'Graphics'];
const STILLS = ['Logo.png', 'Hold Slide.png', 'Sponsors.png'];
// [presetSno, name, screens (0-based), auxes]
const PRESETS = [
  [1, 'Walk-in', [0, 1, 2, 3], [0]], [2, 'Keynote Full', [0], []], [3, 'IMAG Pair', [1, 2], []], [4, 'Panel 4-up', [0, 1, 2], [0]],
  [5, 'Floor Logo', [3], []], [6, 'Conf PPT', [], [0]], [7, 'Record Clean', [], [1]], [8, 'Awards Stinger', [0, 1, 2, 3], []],
  [9, 'Sponsor Loop', [0, 3], []], [10, 'Q&A', [0, 1, 2], [0, 1]], [11, 'Break', [0, 1, 2, 3], [0, 1, 2]], [12, 'Stream Program', [], [2]],
  [12.01, 'Stream Program alt', [], [2]], [15, 'Video Roll', [0], [1]], [20, 'Show Close', [0, 1, 2, 3], [0, 1, 2]],
];
const CUES = ['Show Open', 'Keynote Walk-up', 'Awards Sequence', 'Close'];

class MockE2 {
  constructor() {
    this.history = []; this.server = null;
    this.screens = SCREENS.map((Name, id) => ({ id, Name, armed: false, pvw: null, pgm: null, frozen: false }));
    this.auxes = AUXES.map((Name, id) => ({ id, Name, armed: false, pvw: null, pgm: null, pvwSrc: 0, pgmSrc: 0, frozen: false }));
    this.sources = INPUTS.map((Name, id) => ({ id, Name, SrcType: 0, InputCfgIndex: id, StillIndex: -1, DestIndex: -1, Freeze: 0, InputCfgVideoStatus: id === 8 ? 4 : 1, HSize: 1920, VSize: 1080 }))
      .concat(STILLS.map((Name, i) => ({ id: INPUTS.length + i, Name, SrcType: 1, InputCfgIndex: -1, StillIndex: i, DestIndex: -1, Freeze: 0, InputCfgVideoStatus: 1, HSize: 3840, VSize: 2160 })));
    this.stills = STILLS.map((Name, id) => ({ id, Name }));
    this.presets = PRESETS.map(([sno, Name, s, a], id) => ({ id, Name, presetSno: sno, LockMode: 0, s, a }));
    this.cues = CUES.map((Name, id) => ({ id, Name, state: 'stopped' }));
    this.backups = [ // inputs with at least one backup configured
      { id: 3, Name: 'PPT Main', state: -1, Backup: [{ id: 0, inputId: 4, stillId: null, destId: null, Name: 'PPT Backup' }, { id: 1, inputId: null, stillId: 1, destId: null, Name: 'Hold Slide.png' }] },
      { id: 5, Name: 'Playback A', state: -1, Backup: [{ id: 0, inputId: 6, stillId: null, destId: null, Name: 'Playback B' }] },
    ];
  }
  ok(response = null) { return { success: 0, response }; }
  handle(method, p = {}) {
    const S = this.screens; const A = this.auxes;
    switch (method) {
      case 'getFrameSettings': return this.ok({ System: { id: 0, Name: 'Mock System', Simulator: 1, FrameCollection: { id: 0, Frame: { id: '00:00:00:00:00:e2', Name: 'E2 Mock', Version: '10.0.0 mock', FrameType: 5, FrameTypeName: 'E2-Gen2', isHost: true, Enet: { IP: '127.0.0.1' } } } }, VpCount: 1 });
      case 'powerStatus': return this.ok({ FrameId0: { PwrStatus1: 3, PwrStatus2: 3 } });
      case 'listDestinations': {
        const t = Number(p.type || 0);
        const out = {};
        if (t !== 2) out.ScreenDestination = S.map((d) => ({ id: d.id, Name: d.Name, HSize: 3840, VSize: 2160, Layers: null, DestOutMapColl: [] }));
        if (t !== 1) out.AuxDestination = A.map((d) => ({ id: d.id, AuxStreamMode: 4 })); // per the guide: no Name here
        return this.ok(out);
      }
      case 'listAuxContent': { const a = A[p.id]; if (!a) return { success: 2, response: null }; return this.ok({ id: a.id, Name: a.Name, PvwLastSrcIndex: a.pvwSrc, PgmLastSrcIndex: a.pgmSrc }); }
      case 'changeAuxContent': { const a = A[p.id]; if (!a) return { success: 2, response: null }; if (p.PvwLastSrcIndex !== undefined) a.pvwSrc = p.PvwLastSrcIndex; if (p.PgmLastSrcIndex !== undefined) a.pgmSrc = p.PgmLastSrcIndex; return this.ok(); }
      case 'listPresets': return this.ok(this.presets.map(({ id, Name, LockMode, presetSno }) => ({ id, Name, LockMode, presetSno })));
      case 'listDestinationsForPreset': {
        const sel = p.id === undefined || p.id === -1 ? this.presets : this.presets.filter((x) => x.id === p.id);
        return this.ok(sel.map((x) => ({ id: x.id, Name: x.Name, LockMode: 0, presetSno: x.presetSno, ScreenDest: x.s.map((id) => ({ id })), AuxDest: x.a.map((id) => ({ id })) })));
      }
      case 'activatePreset': {
        const x = this.presets.find((q) => (p.id !== undefined && q.id === p.id) || (p.presetSno !== undefined && q.presetSno === p.presetSno) || (p.presetName !== undefined && q.Name === p.presetName));
        if (!x) return { success: 1, response: null };
        const prog = Number(p.type) === 1;
        for (const i of x.s) S[i][prog ? 'pgm' : 'pvw'] = x.id;
        for (const i of x.a) A[i][prog ? 'pgm' : 'pvw'] = x.id;
        return this.ok();
      }
      case 'armUnarmDestination': {
        for (const d of p.ScreenDestination || []) if (S[d.id]) S[d.id].armed = !!p.arm;
        for (const d of p.AuxDestination || []) if (A[d.id]) A[d.id].armed = !!p.arm;
        return this.ok();
      }
      case 'allTrans': case 'cut': for (const d of [...S, ...A]) if (d.armed) { d.pgm = d.pvw; d.pgmSrc = d.pvwSrc; } return this.ok();
      case 'listSources': return this.ok(this.sources.map((s) => ({ ...s })));
      case 'listInputs': return this.ok(this.sources.filter((s) => s.SrcType === 0).map((s) => ({ id: s.id, Name: s.Name, VideoStatus: s.InputCfgVideoStatus === 1 ? 'OK' : 'No Sync' })));
      case 'freezeDestSource': {
        const on = Number(p.mode) === 1;
        if (p.type === 0) { const s = this.sources.find((x) => x.InputCfgIndex === p.id); if (!s) return { success: 2, response: null }; s.Freeze = on ? 1 : 0; }
        else if (p.type === 2) { if (!S[p.id]) return { success: 2, response: null }; S[p.id].frozen = on; }
        else if (p.type === 3) { if (!A[p.id]) return { success: 2, response: null }; A[p.id].frozen = on; }
        else return { success: 2, response: null };
        return this.ok();
      }
      case 'listStill': return this.ok(this.stills.map((s) => ({ id: s.id, Name: s.Name, LockMode: { Min: 0, Max: 1, $t: 0 }, HSize: { Min: 0, Max: 99999, $t: 3840 }, VSize: { Min: 0, Max: 99999, $t: 2160 }, StillState: { Min: 0, Max: 4, $t: 0 }, PngState: { Min: 0, Max: 2, $t: 0 }, FileSize: { Min: 0, Max: 100000, $t: 33177.6 } })));
      case 'takeStill': {
        const src = this.sources.find((x) => x.id === p.id && x.SrcType === 0); if (!src) return { success: 3, response: null };
        const ex = this.stills.find((s) => s.id === p.file); if (ex) ex.Name = `StillStore${p.file + 1}`; else this.stills.push({ id: p.file, Name: `StillStore${p.file + 1}` });
        this.stills.sort((a, b) => a.id - b.id); return this.ok();
      }
      case 'deleteStill': { const i = this.stills.findIndex((s) => s.id === p.id); if (i < 0) return { success: 2, response: null }; this.stills.splice(i, 1); return this.ok(); }
      case 'listCues': return this.ok(this.cues.map(({ id, Name }) => ({ id, Name })));
      case 'activateCue': { const c = this.cues[p.id]; if (!c) return { success: 2, response: null }; c.state = ['playing', 'paused', 'stopped'][Number(p.type || 0)]; return this.ok(); }
      case 'listSourceMainBackup': return this.ok(this.backups.map(({ state, ...b }) => ({ ...b, VideoStatus: 1, BackUpState: state })));
      case 'activateSourceMainBackup': { const b = this.backups.find((x) => x.id === p.inputId); if (!b) return { success: 2, response: null }; b.state = p.BackUpState === undefined ? -1 : Number(p.BackUpState); return this.ok(); }
      case 'resetSourceMainBackup': { const b = this.backups.find((x) => x.id === p.id); if (!b) return { success: 2, response: null }; b.state = -1; return this.ok(); }
      default: return null;
    }
  }
  start(port = 0, host = '127.0.0.1') {
    this.server = http.createServer((req, res) => {
      let raw = ''; req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const send = (code, j) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
        if (req.method !== 'POST') return send(405, { error: 'POST JSON-RPC 2.0 to this port' });
        let msg; try { msg = JSON.parse(raw); } catch { return send(200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
        this.history.push({ method: msg.method, params: msg.params, t: Date.now() });
        const r = this.handle(msg.method, msg.params || {});
        if (!r) return send(200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
        send(200, { jsonrpc: '2.0', id: msg.id, result: r });
      });
    });
    return new Promise((resolve) => this.server.listen(port, host, () => resolve(this.server.address().port)));
  }
  stop() { return new Promise((r) => { if (!this.server) return r(); this.server.close(() => r()); if (this.server.closeAllConnections) this.server.closeAllConnections(); }); }
  calls(method) { return this.history.filter((h) => h.method === method); }
}
module.exports = { MockE2 };
