'use strict';
// 0.12.0 Page sets for Stream Deck surfaces (PTZ LIVE/PAINT/FUNC/MOVE need module 0.9.0), built from what the app knows about its systems.
// A page set is surface-independent data (sections and their buttons) laid out for one surface profile.
// Every content button is a module preset id of companion-module-rs6-presets (0.9.0+ for PTZ deck pages); the ids follow
// the module's own (stable) naming, and its contract test checks every id used here against the module.
const { PROFILES, gridSize, hasKnobs } = require('./surfaces');
const M = require('./model');

const MAX_TILES = 96;
const safeId = (s) => String(s).replace(/[^A-Za-z0-9_]/g, '_');
const SYS = { rs6: 'RS6', e2: 'E2', pixelhue: 'PixelHue', atem: 'ATEM', ptz: 'PTZ' };
const PRESET_SYSTEMS = ['rs6', 'e2', 'pixelhue'];
const chunk = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out.length ? out : [[]]; };
const upper = (s) => String(s).toUpperCase();

function rs6BackupItems(state) {
  const bk = (state && state.live && state.live.backup) || {};
  const slots = ['NONE', '1', '2'];
  const items = [];
  for (const b of bk.inputs || []) for (const slot of slots) items.push(`input_backup_${b.number}_${slot}`);
  for (const g of bk.groups || []) for (const slot of slots) items.push(`group_backup_${g.group}_${slot}`);
  for (const b of bk.backgrounds || []) for (const slot of slots) items.push(`bg_backup_${b.screen}_${b.set}_${slot}`);
  return items;
}


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
        { key: 'rs6_masters', name: 'RS6 MASTER', nav: 'RS6\\nMASTER', items: ((state.memories && state.memories.items && state.memories.items.master) || []).map((m) => `master_mem_${m.slot}`) },
        { key: 'rs6_backups', name: 'RS6 BACKUP', nav: 'RS6\\nBACKUP', fam: 'backup', items: rs6BackupItems(state) }],
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
        sections.push({ key: x.key, nav: x.nav, fam: x.fam || (s.id === 'rs6' ? 'preset' : s.id), pages: xk, });
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
      // 0.12.0 / module 0.9.0: LIVE · PAINT · FUNCTIONS · MOVE for the selected camera (+ per-camera bank on XL / + XL).
      // Design: research/notes/10-streamdeck-ptz.md. Needs module presets deck_*.
      const tabs = ptzTabKeys(P);
      sections.push({ key: 'ptz', nav: 'PTZ\\nCAMERAS', fam: 'ptz', pages: [tabs[0]] });
      for (const t of tabs) {
        add(t, ptzTabName(t), (c) => ptzDeckPage(c, P, R, s.cams, t, tabs), { ring: tabs });
      }
      if (P.id === 'xl' || P.id === 'plusxl') {
        const keys = s.cams.map((cm) => `cam_${cm.sid}`);
        s.cams.forEach((cm, i) => {
          sections.push({ key: keys[i], nav: cm.name, fam: 'ptz', pages: [keys[i]], cam: cm.id });
          add(keys[i], `${cm.name}`.slice(0, 32), (c) => camBankPage(c, P, R, cm, keys, i, tabs[0]), { ring: keys, cam: cm.id });
        });
      }
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

// ---------- 0.12.0 PTZ deck pages (module 0.9.0 deck_* presets) ----------
// Skeleton on every page: (0,0) HOME, row 0 = camera select, bottom-left = LIVE · PAINT · FUNC · MOVE tabs.
function ptzTabKeys(P) {
  if (P.id === 'mk2' || P.id === 'plus') return ['ptz_live', 'ptz_paint', 'ptz_paint2', 'ptz_func', 'ptz_func2', 'ptz_move'];
  return ['ptz_live', 'ptz_paint', 'ptz_func', 'ptz_move'];
}
function ptzTabName(key) {
  return ({ ptz_live: 'PTZ LIVE', ptz_paint: 'PTZ PAINT', ptz_paint2: 'PTZ PAINT 2', ptz_func: 'PTZ FUNCTIONS', ptz_func2: 'PTZ FUNCTIONS 2', ptz_move: 'PTZ MOVE' })[key] || key;
}
function putCell(c, cell, b) { if (cell && b) c.put(cell, b); }
function camRow(c, P, cams) {
  const cols = P.cols;
  putCell(c, '0/0', c.homeBtn());
  const guard = (P.id === 'xl' || P.id === 'plusxl');
  const slots = cols - 1 - (guard ? 1 : 0);
  const overflow = cams.length > slots;
  const list = cams.slice(0, overflow ? Math.max(0, slots - 1) : slots);
  list.forEach((cm, i) => putCell(c, `0/${i + 1}`, c.ref(`deck_cam_${cm.sid}`)));
  if (overflow) putCell(c, `0/${list.length + 1}`, c.ref('deck_cam_next'));
  if (guard) putCell(c, `0/${cols - 1}`, c.ref('deck_guard'));
}
function tabFooter(c, P, R, tabs, cur, right = []) {
  const names = { ptz_live: 'LIVE', ptz_paint: 'PAINT', ptz_paint2: 'PAINT·2', ptz_func: 'FUNC', ptz_func2: 'FUNC·2', ptz_move: 'MOVE' };
  if (P.id === 'plus') {
    const i = tabs.indexOf(cur);
    putCell(c, '1/0', c.nav(tabs[(i + 1) % tabs.length], 'MORE\\n▸', 'ptz'));
    right.slice(0, 3).forEach((b, k) => putCell(c, `1/${k + 1}`, b));
    return;
  }
  if (P.id === 'mk2') {
    const i = tabs.indexOf(cur);
    const mid = [c.nav(tabs[(i - 1 + tabs.length) % tabs.length], '◂\\nMORE', 'ptz'), c.nav(tabs[(i + 1) % tabs.length], 'MORE\\n▸', 'ptz'), c.ref('deck_sel_readout')];
    footerRow(R.footer, [c.homeBtn()], mid, right).forEach((b, k) => putCell(c, R.footer[k], b));
    return;
  }
  const tabBtns = tabs.map((t) => c.nav(t, names[t] || t, 'ptz'));
  footerRow(R.footer, [c.homeBtn(), ...tabBtns], [], right).forEach((b, k) => putCell(c, R.footer[k], b));
}
function placeDials(c, P, R, dials) {
  const stripCells = P.id === 'plus' ? R.footer : R.strip;
  if (!R.knobs.length) return;
  dials.forEach((k, j) => {
    if (!R.knobs[j]) return;
    putCell(c, stripCells[j], c.ref(`deck_strip_${k}`));
    putCell(c, R.knobs[j], c.ref(`deck_dial_${k}`, true));
  });
}
function ptzDeckPage(c, P, R, cams, tab, tabs) {
  const ref = (id) => c.ref(id);
  const pair = (k) => [ref(`deck_${k}_down`), ref(`deck_${k}_up`)];
  let body = []; let right = []; let dials = [];
  if (tab === 'ptz_live') {
    const n = P.id === 'mk2' ? 6 : P.id === 'plus' ? 3 : P.id === 'xl' ? 16 : 18;
    body = Array.from({ length: n }, (_, i) => ref(`deck_sel_preset_${i + 1}`));
    if (P.id === 'xl' || P.id === 'plusxl') body = body.concat(pair('iris'), pair('mped'), [ref('deck_fn_otaf'), ref('deck_iris_auto')]);
    else if (P.id === 'mk2') body = body.concat(pair('iris'), [ref('deck_fn_otaf')]);
    right = (P.id === 'plusxl' || P.id === 'xl') ? [ref('deck_stop_all')] : [];
    dials = P.id === 'plus' ? ['iris', 'mped', 'zoom', 'focus'] : P.id === 'plusxl' ? ['iris', 'mped', 'rgain', 'bgain', 'zoom', 'focus'] : [];
  } else if (tab === 'ptz_paint') {
    if (P.id === 'mk2') body = [ref('deck_iris_auto'), ...pair('iris'), ...pair('mped'), ...pair('rgain'), ...pair('bgain')];
    else if (P.id === 'plus') body = [ref('deck_wb'), ref('deck_awb'), ...pair('gain')];
    else body = [
      ref('deck_iris_auto'), ...pair('iris'), ...pair('gain'), ...pair('shutter'), ref('deck_nd'),
      ref('deck_wb'), ref('deck_awb'), ...pair('rgain'), ...pair('bgain'), ...pair('rped'), ...pair('bped'),
      ...pair('mped'), ref('deck_detail_on'), ...pair('detail'), ref('deck_gamma_mode'), ...pair('gamma'),
      ref('deck_knee_mode'), ...pair('knee'), ref('deck_matrix'), ...pair('chroma'),
    ];
    dials = P.id === 'plus' ? ['rgain', 'bgain', 'rped', 'bped'] : P.id === 'plusxl' ? ['rped', 'bped', 'detail', 'gamma', 'chroma', 'knee'] : [];
    right = [ref('deck_awb')];
  } else if (tab === 'ptz_paint2') {
    body = P.id === 'mk2'
      ? [ref('deck_wb'), ref('deck_awb'), ...pair('gain'), ref('deck_nd'), ...pair('shutter'), ...pair('rped'), ...pair('bped')]
      : [ref('deck_detail_on'), ...pair('detail'), ref('deck_gamma_mode'), ...pair('gamma'), ref('deck_knee_mode'), ...pair('knee'), ref('deck_matrix'), ...pair('chroma')];
    dials = P.id === 'plus' ? ['detail', 'gamma', 'chroma', 'knee'] : [];
  } else if (tab === 'ptz_func') {
    const fn = ['tally', 'power', 'af', 'otaf', 'ois', 'bars', 'dext', 'freeze', 'pspeed', 'autoiris', 'drs', 'night'];
    body = (P.id === 'mk2' || P.id === 'plus') ? fn.slice(0, 6).map((k) => ref(`deck_fn_${k}`)) : [...fn.map((k) => ref(`deck_fn_${k}`)), ref('deck_guard'), ref('deck_msg')];
    right = [ref('deck_guard')];
  } else if (tab === 'ptz_func2') {
    body = ['dext', 'freeze', 'pspeed', 'autoiris', 'drs', 'night'].map((k) => ref(`deck_fn_${k}`)).concat([ref('deck_guard'), ref('deck_msg')]);
  } else if (tab === 'ptz_move') {
    body = [
      ref('deck_move_up'), ref('deck_move_down'), ref('deck_move_left'), ref('deck_move_right'),
      ref('deck_move_upLeft'), ref('deck_move_upRight'), ref('deck_move_downLeft'), ref('deck_move_downRight'),
      ref('deck_tele'), ref('deck_wide'), ref('deck_far'), ref('deck_near'), ref('deck_home'), ref('deck_fn_otaf'),
    ];
    right = [ref('deck_stop_all')];
    dials = (P.id === 'plus' || P.id === 'plusxl') ? ['zoom', 'focus', 'iris', 'mped'] : [];
  }
  if (P.id === 'plus') {
    putCell(c, '0/0', c.homeBtn());
    if (tab === 'ptz_live') {
      cams.slice(0, 3).forEach((cm, i) => putCell(c, `0/${i + 1}`, c.ref(`deck_cam_${cm.sid}`)));
      body.slice(0, 3).forEach((b, i) => putCell(c, `1/${i + 1}`, b));
    } else {
      body.slice(0, 3).forEach((b, i) => putCell(c, `0/${i + 1}`, b));
      body.slice(3, 6).forEach((b, i) => putCell(c, `1/${i + 1}`, b));
    }
  } else {
    camRow(c, P, cams);
    const free = R.content.filter((cell) => cell.split('/')[0] !== '0');
    body.forEach((b, i) => { if (free[i]) putCell(c, free[i], b); });
  }
  tabFooter(c, P, R, tabs, tab, right);
  placeDials(c, P, R, dials);
}
function camBankPage(c, P, R, cm, ring, i, liveKey) {
  const n = P.id === 'plusxl' ? 18 : 16;
  putCell(c, '0/0', c.homeBtn());
  putCell(c, '0/1', c.ref(`deck_cam_${cm.sid}`));
  putCell(c, '0/2', c.nav(liveKey, 'LIVE', 'ptz'));
  const free = R.content.filter((cell) => cell.split('/')[0] !== '0');
  const content = Array.from({ length: n }, (_, k) => c.ref(`deck_${cm.sid}_preset_${k + 1}`));
  content.push(c.ref('deck_fn_otaf'), c.ref('deck_home'), c.ref('deck_stop_all'));
  content.forEach((b, k) => { if (free[k]) putCell(c, free[k], b); });
  const prev = ring.length > 1 ? c.nav(ring[(i - 1 + ring.length) % ring.length], '◀\\nCAM', 'ptz', cm.id) : null;
  const next = ring.length > 1 ? c.nav(ring[(i + 1) % ring.length], 'CAM\\n▶', 'ptz', cm.id) : null;
  footerRow(R.footer, [c.homeBtn(), prev, next, c.nav(liveKey, 'LIVE', 'ptz')], [], [c.ref('deck_stop_all')]).forEach((b, k) => putCell(c, R.footer[k], b));
}


module.exports = { catalogue, buildSurface, regions, footerRow, safeId, ptzTabKeys, ptzDeckPage };
