'use strict';
// 0.9.0 Page sets for Stream Deck surfaces, built from what the app knows about its systems.
// A page set is surface-independent data (sections and their buttons) laid out for one surface profile.
// Every content button is a module preset id of companion-module-rs6-presets (0.7.0+); the ids follow
// the module's own (stable) naming, and its contract test checks every id used here against the module.
const { PROFILES, gridSize, hasKnobs } = require('./surfaces');
const M = require('./model');

const MAX_TILES = 96;
const safeId = (s) => String(s).replace(/[^A-Za-z0-9_]/g, '_');
const SYS = { rs6: 'RS6', e2: 'E2', pixelhue: 'PixelHue', atem: 'ATEM', ptz: 'PTZ' };
const PRESET_SYSTEMS = ['rs6', 'e2', 'pixelhue'];
const chunk = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out.length ? out : [[]]; };
const upper = (s) => String(s).toUpperCase();

// ---------- what the systems offer (presets, destinations, inputs, cameras) ----------
// state = the RS6 state (/api/state), views = the systems' views (/api/sys/views .views); both optional.
function catalogue(state, views, o = {}) {
  const want = (k) => !o.systems || o.systems.includes(k);
  const V = views || {};
  const cat = { systems: [] };
  if (want('rs6') && state && (state.connected || (state.presets || []).length)) {
    const used = (state.presets || []).map((p) => Number(p.number) || 0).filter((n) => n >= 1 && n <= MAX_TILES);
    const tileCount = Math.min(MAX_TILES, Number(state.tileCount) || 24);
    const last = o.allTiles ? Math.max(tileCount, ...used) : Math.max(1, ...used);
    cat.systems.push({
      id: 'rs6', kind: 'presets', name: 'RS6',
      tiles: Array.from({ length: last }, (_, i) => `preset_${i + 1}`),
      dests: (state.destinations || []).map((d) => `dest_${d.key}`),
      take: 'take', cut: 'cut', auto: 'auto_take', status: 'last',
      extra: [{ key: 'rs6_inputs', name: 'RS6 FREEZE', nav: 'RS6\\nFREEZE', items: ((state.live && state.live.inputs) || []).map((i) => `input_freeze_${i.number}`) },
        { key: 'rs6_masters', name: 'RS6 MASTER', nav: 'RS6\\nMASTER', items: ((state.memories && state.memories.items && state.memories.items.master) || []).map((m) => `master_mem_${m.slot}`) }],
    });
  }
  for (const sys of ['e2', 'pixelhue']) {
    const v = V[sys]; if (!want(sys) || !v) continue;
    const ps = (v.presets || []).filter((p) => p.tile >= 1 && p.tile <= MAX_TILES);
    const last = Math.max(1, ...ps.map((p) => p.tile));
    const byTile = new Set(ps.map((p) => p.tile));
    cat.systems.push({
      id: sys, kind: 'presets', name: SYS[sys],
      tiles: Array.from({ length: last }, (_, i) => (byTile.has(i + 1) ? `${sys}_preset_${i + 1}` : null)),
      dests: (v.destinations || []).map((d) => `${sys}_dest_${d.key}`),
      take: `${sys}_take`, cut: `${sys}_cut`, auto: `${sys}_auto_take`, status: `${sys}_status`,
      extra: sys === 'e2' ? [{ key: 'e2_cues', name: 'E2 CUES', nav: 'E2\\nCUES', items: (v.cues || []).map((c) => `e2_cue_${c.id}`) }] : [],
    });
  }
  if (want('atem') && V.atem) {
    const a = V.atem;
    const keys = [];
    for (const k of a.keyers || []) keys.push(`atem_usk_${k.index}_air`, `atem_usk_${k.index}_tie`);
    for (const k of a.dsk || []) keys.push(`atem_dsk_${k.index}_air`, `atem_dsk_${k.index}_tie`, `atem_dsk_${k.index}_auto`);
    const styles = ['MIX', 'DIP', 'WIPE', 'DVE', 'STING'].filter((s) => !a.styles || a.styles.map(upper).includes(s)).map((s) => `atem_style_${s}`);
    cat.systems.push({
      id: 'atem', kind: 'atem', name: 'ATEM', sources: (a.bus || []).map((i) => i.id),
      keys: [...keys, 'atem_ftb', ...styles],
      onAir: [...(a.keyers || []).map((k) => `atem_usk_${k.index}_air`), ...(a.dsk || []).map((k) => `atem_dsk_${k.index}_air`), 'atem_ftb'],
      macros: [...(a.macros || []).map((m) => `atem_macro_${m.index}`), ...((a.macros || []).length ? ['atem_macro_stop'] : [])],
      cut: 'atem_cut', auto: 'atem_auto', status: 'atem_status',
    });
  }
  if (want('ptz') && V.ptz && (V.ptz.cameras || []).length) {
    cat.systems.push({ id: 'ptz', kind: 'ptz', name: 'PTZ', status: 'ptz_status', cams: V.ptz.cameras.map((c) => ({ id: c.id, sid: safeId(c.id), name: c.name || c.id })) });
  }
  return cat;
}

// ---------- surface regions ----------
const cellsOf = (rows, cols) => rows.flatMap((r) => cols.map((c) => `${r}/${c}`));
const range = (n) => Array.from({ length: n }, (_, i) => i);
function regions(p) {
  const keyCols = range(p.cols);
  if (p.id === 'plus') {
    // 8 keys hold content; the touch strip is the footer; knobs below the strip
    return { content: cellsOf([0, 1], keyCols), footer: cellsOf([p.stripRow], p.knobCols), strip: [], knobs: cellsOf([p.knobRow], p.knobCols), pagingOnKnob: true };
  }
  return {
    content: cellsOf(range(p.rows - 1), keyCols), footer: cellsOf([p.rows - 1], keyCols),
    strip: hasKnobs(p) ? cellsOf([p.stripRow], p.knobCols) : [], knobs: hasKnobs(p) ? cellsOf([p.knobRow], p.knobCols) : [], pagingOnKnob: false,
  };
}

// left items, then optional middle items while there is room, right items last
function footerRow(slots, left, middle, right) {
  const out = new Array(slots.length).fill(null);
  const L = left.filter((x) => x !== undefined); const R = right.filter(Boolean);
  L.slice(0, slots.length - R.length).forEach((x, i) => { out[i] = x; });
  R.forEach((x, i) => { out[slots.length - R.length + i] = x; });
  let i = Math.min(L.length, slots.length - R.length);
  for (const m of middle) { if (!m) continue; if (i >= slots.length - R.length) break; out[i++] = m; }
  return out;
}

// ---------- building one surface ----------
// returns [{ key, name, cells: Map('r/c' -> control) }] with nav links resolved to page ids
function buildSurface(profileId, cat, o = {}) {
  const P = PROFILES[profileId]; if (!P) throw new Error(`unknown surface ${profileId}`);
  const R = regions(P);
  const ids = o.ids || M.idMaker();
  const conn = o.connectionId;
  const prefix = o.prefix === undefined ? '' : o.prefix;
  const N = R.content.length;
  const specs = []; // {key, name, fill(ctx)}
  const add = (key, name, fill, extra = {}) => specs.push({ key, name: `${prefix}${name}`, fill, ...extra });

  // sections first, so their page counts are known before anything links to them
  const sections = []; // {key, nav, fam, first, pages:[keys]}
  for (const s of cat.systems) {
    if (s.kind === 'presets') {
      const pages = chunk(s.tiles, N);
      const keys = pages.map((_, i) => `${s.id}_p${i + 1}`);
      sections.push({ key: s.id, nav: `${upper(s.name)}\\nPRESETS`, fam: s.id === 'rs6' ? 'preset' : s.id, pages: keys });
      const destKey = s.dests.length ? `${s.id}_dest` : null;
      pages.forEach((tiles, i) => add(keys[i], `${s.name} PRESETS${pages.length > 1 ? ` ${i + 1}/${pages.length}` : ''}`, (c) => {
        c.content(tiles.map((t) => t && c.ref(t)));
        c.footer(c.homeBtn(), c.pager(keys, i), [destKey && c.nav(destKey, `${upper(s.name)}\\nDEST`, 'dest'), c.ref(s.auto), c.ref(s.status)], [c.ref(s.cut), c.ref(s.take)]);
      }, { ring: keys }));
      if (destKey) {
        // on HOME too when a footer may have no room for the DEST key (MK.2)
        sections.push({ key: destKey, nav: `${upper(s.name)}\\nDEST`, fam: 'dest', pages: [destKey], hidden: R.footer.length >= 8 || R.pagingOnKnob });
        add(destKey, `${s.name} DEST`, (c) => {
          c.content(s.dests.slice(0, N).map((d) => c.ref(d)));
          c.footer(c.homeBtn(), [c.nav(keys[0], `${upper(s.name)}\\nPRESETS`, sections.find((x) => x.key === s.id).fam)], [c.ref(s.auto), c.ref(s.status)], [c.ref(s.cut), c.ref(s.take)]);
        });
      }
      for (const x of s.extra || []) {
        if (!x.items.length) continue;
        const xp = chunk(x.items, N); const xk = xp.map((_, i) => `${x.key}_${i + 1}`);
        sections.push({ key: x.key, nav: x.nav, fam: s.id === 'rs6' ? 'preset' : s.id, pages: xk, });
        xp.forEach((items, i) => add(xk[i], `${x.name}${xp.length > 1 ? ` ${i + 1}/${xp.length}` : ''}`, (c) => {
          c.content(items.map((t) => c.ref(t)));
          c.footer(c.homeBtn(), c.pager(xk, i), [c.nav(keys[0], `${upper(s.name)}\\nPRESETS`, s.id === 'rs6' ? 'preset' : s.id), c.ref(s.status)], [c.ref(s.cut), c.ref(s.take)]);
        }, { ring: xk }));
      }
    } else if (s.kind === 'atem') {
      const w = P.cols;
      const banks = chunk(s.sources, w);
      const keys = banks.map((_, i) => `atem_p${i + 1}`);
      const keysPage = s.keys.length || s.macros.length ? 'atem_keys' : null;
      sections.push({ key: 'atem', nav: 'ATEM\\nSWITCHER', fam: 'atem', pages: keys });
      banks.forEach((src, i) => add(keys[i], `ATEM PGM/PVW${banks.length > 1 ? ` ${i + 1}/${banks.length}` : ''}`, (c) => {
        // row 0 program, row 1 preview, then the on-air keys when the surface has a third row
        const cells = []; for (let k = 0; k < w; k++) cells.push(src[k] !== undefined ? c.ref(`atem_pgm_${src[k]}`) : null);
        for (let k = 0; k < w; k++) cells.push(src[k] !== undefined ? c.ref(`atem_pvw_${src[k]}`) : null);
        if (N > 2 * w) for (let k = 0; k < w; k++) cells.push(s.onAir[k] ? c.ref(s.onAir[k]) : null);
        c.content(cells);
        c.footer(c.homeBtn(), c.pager(keys, i), [keysPage && c.nav(keysPage, 'ATEM\\nKEYS', 'atem'), c.ref(s.status)], [c.ref(s.cut), c.ref(s.auto)]);
      }, { ring: keys }));
      if (keysPage) {
        const items = [...s.keys, ...s.macros];
        const kp = chunk(items, N); const kk = kp.map((_, i) => (i ? `atem_keys_${i + 1}` : 'atem_keys'));
        sections.push({ key: 'atem_keys', nav: 'ATEM\\nKEYS', fam: 'atem', pages: kk });
        kp.forEach((list, i) => add(kk[i], `ATEM KEYS${kp.length > 1 ? ` ${i + 1}/${kp.length}` : ''}`, (c) => {
          c.content(list.map((t) => c.ref(t)));
          c.footer(c.homeBtn(), c.pager(kk, i), [c.nav(keys[0], 'ATEM\\nPGM/PVW', 'atem'), c.ref(s.status)], [c.ref(s.cut), c.ref(s.auto)]);
        }, { ring: kk }));
      }
    } else if (s.kind === 'ptz') {
      const keys = s.cams.map((cm) => `cam_${cm.sid}`);
      s.cams.forEach((cm, i) => {
        sections.push({ key: keys[i], nav: cm.name, fam: 'ptz', pages: [keys[i]], cam: cm.id });
        add(keys[i], `${cm.name}`.slice(0, 32), (c) => camPage(c, P, R, cm, keys, i), { ring: keys, cam: cm.id });
      });
    }
  }

  // home: every section, then the status buttons
  const statuses = cat.systems.map((s) => s.status).filter(Boolean);
  specs.unshift({ key: 'home', name: `${prefix}HOME`, fill: (c) => {
    const navs = sections.filter((x) => !x.hidden).map((x) => c.nav(x.pages[0], x.nav, x.fam, x.cam));
    const cells = [...R.content, ...R.footer];
    const all = [...navs, ...statuses.map((st) => c.ref(st))].slice(0, Math.max(cells.length, navs.length));
    if (navs.length > cells.length) c.warn(`HOME on ${P.label}: ${navs.length - cells.length} section link(s) left off (only ${cells.length} keys); the knob still pages through every section`);
    all.slice(0, cells.length).forEach((b, i) => c.put(cells[i], b));
    if (R.knobs.length) { const firsts = sections.filter((x) => !x.hidden).map((x) => x.pages[0]); c.put(R.knobs[0], M.pageKnob(ids, c.pid(firsts[firsts.length - 1]), c.pid(firsts[0]), null, 'SECTIONS\\n◀ turn ▶')); }
  } });

  // ids, then fill
  const pid = new Map(specs.map((s) => [s.key, o.pageIds ? o.pageIds(s.key) : ids()]));
  const warnings = [];
  const camOf = new Map(specs.filter((s) => s.cam).map((s) => [s.key, s.cam]));
  const pages = specs.map((s) => {
    const cells = new Map();
    const ctx = {
      put: (cell, b) => { if (b && cell) cells.set(cell, b); },
      pid: (key) => pid.get(key) || null,
      ref: (presetId, rotary) => presetId && M.presetRef(ids, conn, presetId, rotary),
      nav: (key, text, fam, cam) => {
        if (!pid.has(key)) return null;
        const camId = cam || camOf.get(key);
        return M.navButton(ids, pid.get(key), text, fam, camId ? [M.action(ids, conn, 'ptz_select_camera', { cam: camId })] : []);
      },
      homeBtn: () => M.navButton(ids, pid.get('home'), '⌂\\nHOME', 'utility'),
      // [prev, next] for a page ring (blank when the section has one page)
      pager: (ring, i) => (ring.length > 1 ? [ctx.nav(ring[(i - 1 + ring.length) % ring.length], '◀\\nPAGE'), ctx.nav(ring[(i + 1) % ring.length], 'PAGE\\n▶')] : (R.footer.length >= 8 ? [null, null] : [])), // wide footers keep their keys in place
      content: (list) => list.slice(0, R.content.length).forEach((b, i) => ctx.put(R.content[i], b)),
      footer: (home, pager, middle, right) => {
        const left = R.pagingOnKnob ? [home] : [home, ...pager];
        footerRow(R.footer, left, middle, right).forEach((b, i) => ctx.put(R.footer[i], b));
      },
      warn: (m) => warnings.push(m),
    };
    s.fill(ctx);
    // the first knob pages through the section (or the cameras) and jumps HOME when pushed, unless the page uses it
    if (R.knobs.length && s.ring && s.ring.length > 1 && !cells.has(R.knobs[0])) {
      const i = s.ring.indexOf(s.key);
      const prev = s.ring[(i - 1 + s.ring.length) % s.ring.length]; const next = s.ring[(i + 1) % s.ring.length];
      ctx.put(R.knobs[0], M.pageKnob(ids, pid.get(prev), pid.get(next), pid.get('home')));
    } else if (R.knobs.length && s.key !== 'home' && !cells.has(R.knobs[0])) {
      ctx.put(R.knobs[0], M.pageKnob(ids, null, null, pid.get('home'), 'push:\\nHOME'));
    }
    return { key: s.key, id: pid.get(s.key), name: s.name.slice(0, 40), cells };
  });
  return { profile: P, pages, warnings, grid: gridSize(P) };
}

// one camera: its presets, pan/tilt and lens keys, and on + / + XL the knobs (with readouts on the strip)
function camPage(c, P, R, cm, ring, i) {
  const p = `ptz_${cm.sid}`;
  const pre = (n) => c.ref(`${p}_preset_${n}`);
  const r = (x) => c.ref(`${p}_${x}`);
  const prevCam = ring.length > 1 ? c.nav(ring[(i - 1 + ring.length) % ring.length], '◀\\nCAM', 'ptz') : null;
  const nextCam = ring.length > 1 ? c.nav(ring[(i + 1) % ring.length], 'CAM\\n▶', 'ptz') : null;
  const knob = (k) => c.ref(`${p}_enc_${k}`, true);
  const lcd = (k) => c.ref(`${p}_lcd_${k}`);
  const KN = P.knobCols.length === 6 ? ['zoom', 'focus', 'iris', 'ptspeed', 'gain', 'zoomspeed'] : ['zoom', 'focus', 'iris', 'ptspeed'];
  let content; let footer;
  if (P.id === 'xl') {
    content = [...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map(pre), ...['move_up', 'move_down', 'move_left', 'move_right', 'tele', 'wide', 'near', 'far'].map(r)];
    footer = [c.homeBtn(), prevCam, nextCam, r('readout'), r('otaf'), r('iris_auto'), r('home'), r('stop')];
  } else if (P.id === 'mk2') {
    content = [...[1, 2, 3, 4, 5].map(pre), ...['move_left', 'move_up', 'move_down', 'move_right', 'otaf'].map(r)];
    footer = [c.homeBtn(), prevCam, nextCam, r('tele'), r('wide')];
  } else if (P.id === 'plus') {
    content = [...[1, 2, 3, 4].map(pre), c.homeBtn(), prevCam, nextCam, r('otaf')];
    footer = null; // the strip shows the knob readouts
  } else {
    content = [...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map(pre), r('readout'), r('otaf'),
      ...['move_up', 'move_down', 'move_left', 'move_right', 'tele', 'wide', 'near', 'far', 'iris_auto'].map(r)];
    footer = [c.homeBtn(), prevCam, nextCam, c.ref(`ptz_cam_${cm.sid}`), r('af'), r('home'), null, null, r('stop')];
  }
  c.content(content);
  if (footer) footer.forEach((b, k) => c.put(R.footer[k], b));
  const stripCells = P.id === 'plus' ? R.footer : R.strip;
  if (R.knobs.length) KN.forEach((k, j) => { c.put(stripCells[j], lcd(k)); c.put(R.knobs[j], knob(k)); });
}

module.exports = { catalogue, buildSurface, regions, footerRow, safeId };
