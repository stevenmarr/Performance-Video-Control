'use strict';
// 0.7.0 Blackmagic ATEM tabs: SWITCHER (program / preview bus, CUT / AUTO, transition style and rate, next
// transition + key tie, upstream / downstream keys, FTB) and MACROS. 0.10.0: ROUTER (replaces AUX), AUDIO and
// DVE / SS / KEYS are in public/atem-ext.js. State comes from public/sys.js (window.CCSYS); every action is
// POST /api/sys/atem/cmd/<name>.
// 0.11.0: every M/E of the model. An M/E selector (shared with DVE / SS / KEYS, kept per browser) picks the M/E the
// buses, transition controls, keys and the CUT / AUTO / FTB transport drive; ALL M/Es shows every M/E side by side
// (stacked when the window is narrow), each with its own CUT / AUTO. Buttons show the source's long name; the short
// name only replaces it when the bus gets too narrow (CSS, .nm-l / .nm-s). SAVE stores the show and asks the ATEM to
// save its startup state (SRsv).
(() => {
  const $ = (s) => document.querySelector(s);
  const { api, toast, run, esc } = window.CC;
  const S = window.CCSYS;
  let V = null;
  const cmd = (name, body = {}) => run(api('POST', `/api/sys/atem/cmd/${name}`, body));
  const live = () => V && V.kind === 'atem' && V.status && V.status.connected;
  // ---- shared M/E selection (0-based index, or 'all' on the SWITCHER) ----
  const ls = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
  let meSel = ls('cc.atemMe', null); let meView = ls('cc.atemMeView', 'one');
  const mes = () => (V && V.mes && V.mes.length ? V.mes : V ? [{ index: 0, bus: V.bus || [], program: V.program, preview: V.preview, style: V.style, nextStyle: V.nextStyle, nextSelection: V.nextSelection, inTransition: V.inTransition, handle: V.handle, mixRate: V.mixRate, ftb: V.ftb, keyers: V.keyers || [] }] : []);
  const curMe = () => { const list = mes(); const n = meSel === null || meSel === undefined ? ((V && V.me) || 1) - 1 : Number(meSel); return Math.max(0, Math.min(list.length - 1, n)) || 0; };
  const meOf = (i = curMe()) => mes()[i] || mes()[0] || {};
  const setMe = (i) => { meSel = Number(i); localStorage.setItem('cc.atemMe', JSON.stringify(meSel)); for (const fn of meListeners) fn(meSel); };
  const meListeners = [];
  const meBody = (i = curMe()) => (mes().length > 1 ? { me: i + 1 } : {});
  // long name first; the short name is only for narrow buses (see .nm-l / .nm-s in style.css)
  const nm = (long, short) => `<span class="nm-l">${esc(long || short)}</span><span class="nm-s">${esc(short || long)}</span>`;
  const btn = (i, cls, attr, me) => `<button class="src ${cls}" ${attr}="${i.id}" ${me !== undefined ? `data-me="${me}"` : ''} title="${esc(i.long)} · ${esc(i.short)} (${i.id})"><b>${nm(i.long, i.short)}</b></button>`;

  function renderMeBar() {
    const list = mes(); const el = $('#atemMe'); if (!el) return;
    S.set(el, 'atem-me', list.length > 1 ? `<span class="modes-lbl">M/E</span>${list.map((m) => `<button type="button" class="mode ${meView !== 'all' && m.index === curMe() ? 'active' : ''}" data-ame="${m.index}" title="Drive M/E ${m.index + 1}">M/E ${m.index + 1}</button>`).join('')}<button type="button" class="mode ${meView === 'all' ? 'active' : ''}" data-ameall="1" title="Every M/E side by side (stacked on a narrow screen)">ALL M/Es</button>` : '');
  }
  function renderSwitcher() {
    const off = !live(); const list = mes(); const all = meView === 'all' && list.length > 1; const mi = curMe(); const m = meOf(mi);
    $('#atemInfo').textContent = off ? (V && V.status && V.status.error ? `not connected · ${V.status.error}` : 'not connected · set its IP on ⌂ SYSTEMS')
      : `${V.product} · protocol ${V.protocol} · ${list.length > 1 ? (all ? `${list.length} M/Es side by side` : `driving M/E ${mi + 1} of ${list.length}`) : '1 M/E'}`;
    $('#atemTally').innerHTML = off ? '' : `<span class="lg pgm">PGM</span> ${esc((V.tallyLong || V.tally).program.join(', ') || '—')} &nbsp; <span class="lg pvw">PVW</span> ${esc((V.tallyLong || V.tally).preview.join(', ') || '—')}`;
    renderMeBar();
    document.body.classList.toggle('atem-allme', all);
    $('#atemSingle').hidden = all; $('#atemMulti').hidden = !all;
    if (all) {
      S.set($('#atemMulti'), 'atem-multi', `<div class="me-grid me-n${list.length}">${list.map((x) => `<section class="me-block ${x.index === mi ? 'focus' : ''}" data-meblock="${x.index}">
        <div class="me-head"><b>M/E ${x.index + 1}</b><span class="small">${esc(x.style || '')} · ${x.mixRate || '—'} fr</span><span class="spacer"></span>
          <button type="button" class="btn mini cut" data-mecut="${x.index}">CUT</button><button type="button" class="btn mini take ${x.inTransition ? 'running' : ''}" data-meauto="${x.index}">AUTO</button></div>
        <div class="bus-block"><div class="bus-lbl pgm">PGM</div><div class="bus">${x.bus.map((i) => btn(i, i.pgm ? 'on-pgm' : '', 'data-pgm', x.index)).join('')}</div></div>
        <div class="bus-block"><div class="bus-lbl pvw">PVW</div><div class="bus">${x.bus.map((i) => btn(i, i.pvw ? 'on-pvw' : '', 'data-pvw', x.index)).join('')}</div></div>
        <div class="me-keys">${(x.keyers || []).map((k) => `<button type="button" class="mode mini ${k.onAir ? 'onair' : ''}" data-usk="${k.index}" data-me="${x.index}" data-on="${k.onAir ? 0 : 1}">KEY ${k.index + 1} ${k.onAir ? 'ON AIR' : 'OFF'}</button>`).join('')}</div></section>`).join('')}</div>`);
    } else {
      S.set($('#atemPgm'), 'atem-pgm', (m.bus || []).map((i) => btn(i, i.pgm ? 'on-pgm' : '', 'data-pgm')).join('') || '<div class="note">No sources (not connected).</div>');
      S.set($('#atemPvw'), 'atem-pvw', (m.bus || []).map((i) => btn(i, i.pvw ? 'on-pvw' : '', 'data-pvw')).join(''));
      $('#atemPgmLbl').textContent = list.length > 1 ? `M/E ${mi + 1} PROGRAM` : 'PROGRAM'; $('#atemPvwLbl').textContent = list.length > 1 ? `M/E ${mi + 1} PREVIEW` : 'PREVIEW';
    }
    const sel = m.nextSelection || 1;
    const layers = [{ bit: 0, label: 'BKGD' }].concat((m.keyers || []).map((k) => ({ bit: k.index + 1, label: `KEY ${k.index + 1}` })));
    S.set($('#atemNext'), 'atem-next', layers.map((l) => `<button class="mode ${sel & (1 << l.bit) ? 'active' : ''}" data-next="${l.bit}" type="button">${l.label}</button>`).join(''));
    S.set($('#atemStyle'), 'atem-style', (V.styles || []).map((x) => `<button class="mode ${m.style === x ? 'active' : ''}" data-style="${x}" type="button">${x}</button>`).join(''));
    const rate = $('#atemRate'); if (document.activeElement !== rate) rate.value = m.mixRate || '';
    $('#atemLowerMe').textContent = list.length > 1 ? `M/E ${mi + 1}` : '';
    S.set($('#atemUsk'), 'atem-usk', (m.keyers || []).map((k) => `<div class="key-cell"><span class="lbl">KEY ${k.index + 1}</span><button class="mode ${k.onAir ? 'onair' : ''}" data-usk="${k.index}" data-on="${k.onAir ? 0 : 1}" type="button">${k.onAir ? 'ON AIR' : 'OFF'}</button>
      <button class="mode ${k.tie ? 'active' : ''}" data-usktie="${k.index}" data-on="${k.tie ? 0 : 1}" type="button">TIE</button></div>`).join('') || '<div class="note small">No upstream keys.</div>');
    S.set($('#atemDsk'), 'atem-dsk', (V.dsk || []).map((k) => `<div class="key-cell"><span class="lbl">DSK ${k.index + 1}</span>
      <button class="mode ${k.tie ? 'active' : ''}" data-dsktie="${k.index}" data-on="${k.tie ? 0 : 1}" type="button">TIE</button>
      <button class="mode ${k.onAir ? 'onair' : ''}" data-dskcut="${k.index}" data-on="${k.onAir ? 0 : 1}" type="button">${k.onAir ? 'ON AIR' : 'CUT'}</button>
      <button class="mode ${k.inTransition ? 'running' : ''}" data-dskauto="${k.index}" type="button">AUTO</button><small>${k.rate ? `${k.rate} fr` : ''}</small></div>`).join('') || '<div class="note small">No downstream keys.</div>');
    renderTransport();
  }
  function renderTransport() {
    const off = !live(); const m = V ? meOf() : {}; const multi = mes().length > 1;
    for (const id of ['#atemCut', '#atemAuto', '#atemFtb']) $(id).disabled = off;
    $('#atemAutoSub').textContent = off ? '' : `${multi ? `M/E ${curMe() + 1} · ` : ''}${m.nextStyle || m.style} · ${m.mixRate || '—'} fr`;
    $('#atemCutSub').textContent = off || !multi ? '' : `M/E ${curMe() + 1}`;
    $('#atemAuto').classList.toggle('running', !!m.inTransition);
    $('#atemBar').style.width = m.inTransition ? `${Math.round((m.handle || 0) / 100)}%` : '0%';
    const f = m.ftb || {};
    $('#atemFtb').classList.toggle('on', !!f.black); $('#atemFtb').classList.toggle('running', !!f.inTransition);
    $('#atemFtbState').textContent = f.inTransition ? 'FADING' : f.black ? 'BLACK' : 'OFF';
    const r = $('#atemFtbRate'); if (document.activeElement !== r) r.value = f.rate || '';
    if ($('#atemSave')) $('#atemSave').disabled = off;
  }
  function renderMacros() {
    const r = V.macroRun || {};
    const running = r.isRunning ? (V.macros.find((m) => m.index === r.macroIndex) || { name: `Macro ${r.macroIndex + 1}` }) : null;
    $('#atemMacroInfo').textContent = running ? `running: ${running.name}` : 'tap to run';
    $('#atemMacroStop').disabled = !r.isRunning;
    S.set($('#atemMacros'), 'atem-macros', (V.macros || []).map((m) => `<button class="preset ${r.isRunning && r.macroIndex === m.index ? 'pvw running' : ''}" data-macro="${m.index}" title="${esc(m.description || m.name)}"><span class="num">${m.index + 1}</span><span class="name">${esc(m.name || `Macro ${m.index + 1}`)}</span><span class="chips">${m.description ? `<span class="chip">${esc(m.description)}</span>` : ''}</span></button>`).join('') || '<div class="note">No macros recorded on this ATEM.</div>');
  }
  let tabNow = '';
  S.onRender((v, tab) => {
    V = v; tabNow = tab; if (!V || V.kind !== 'atem') return;
    if (tab === 'atem') renderSwitcher(); else if (tab === 'amacros') renderMacros();
  });
  $('#atemMe').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.ameall) { meView = meView === 'all' ? 'one' : 'all'; localStorage.setItem('cc.atemMeView', JSON.stringify(meView)); return renderSwitcher(); }
    if (b.dataset.ame !== undefined) { meView = 'one'; localStorage.setItem('cc.atemMeView', JSON.stringify(meView)); setMe(b.dataset.ame); renderSwitcher(); }
    return undefined;
  });
  $('#pane-atem').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b || !live() || b.closest('#atemMe')) return;
    const d = b.dataset;
    const mi = d.me !== undefined ? Number(d.me) : curMe(); const mb = meBody(mi);
    if (d.me !== undefined && mi !== curMe()) setMe(mi); // a press in an M/E block also focuses it for the transport
    if (d.mecut !== undefined) { setMe(d.mecut); return cmd('cut', meBody(Number(d.mecut))); }
    if (d.meauto !== undefined) { setMe(d.meauto); return cmd('auto', meBody(Number(d.meauto))); }
    if (d.pgm) return cmd('program', { source: Number(d.pgm), ...mb });
    if (d.pvw) return cmd('preview', { source: Number(d.pvw), ...mb });
    if (d.next !== undefined) { const bit = 1 << Number(d.next); const cur = meOf(mi).nextSelection || 1; const nv = cur & bit ? cur & ~bit : cur | bit; if (!nv) return toast('The next transition needs at least one layer', true); return cmd('nextSelection', { selection: nv, ...mb }); }
    if (d.style) return cmd('style', { style: d.style, ...mb });
    if (d.usk !== undefined) return cmd('uskOnAir', { key: Number(d.usk), on: d.on === '1', ...mb });
    if (d.usktie !== undefined) return cmd('uskTie', { key: Number(d.usktie), on: d.on === '1', ...mb });
    if (d.dsktie !== undefined) return cmd('dskTie', { key: Number(d.dsktie), on: d.on === '1' });
    if (d.dskcut !== undefined) return cmd('dskOnAir', { key: Number(d.dskcut), on: d.on === '1' });
    if (d.dskauto !== undefined) return cmd('dskAuto', { key: Number(d.dskauto) });
    return undefined;
  });
  $('#atemRateSet').addEventListener('click', () => { const r = Number($('#atemRate').value); if (!(r >= 1 && r <= 250)) return toast('Rate is 1..250 frames', true); cmd('mixRate', { rate: r, ...meBody() }); $('#atemRate').blur(); });
  $('#atemFtbRate').addEventListener('change', () => { const r = Number($('#atemFtbRate').value); if (r >= 1 && r <= 250) cmd('ftbRate', { rate: r, ...meBody() }); });
  $('#atemCut').addEventListener('click', () => cmd('cut', meBody()));
  $('#atemAuto').addEventListener('click', () => cmd('auto', meBody()));
  $('#atemFtb').addEventListener('click', () => { const f = meOf().ftb; if (!f || f.black || confirm(`FADE TO BLACK takes ${mes().length > 1 ? `M/E ${curMe() + 1}` : 'the program output'} to black. Continue?`)) cmd('ftb', meBody()); });
  // 0.11.0 SAVE: the show file (app state) and, on the ATEM, its startup state (SRsv; see docs/atem-models.md)
  if ($('#atemSave')) $('#atemSave').addEventListener('click', () => {
    if (!confirm('SAVE\n\n• saves the current show (presets, layouts, desk) to the show library\n• asks the ATEM to save its current state as its STARTUP state (what it boots into)\n\nContinue?')) return;
    run(api('POST', '/api/sys/atem/save', { show: true, startup: true }).then((r) => toast(`Saved show "${r.show ? r.show.name : ''}"${r.startup ? ' · ATEM startup state saved' : ''}`)));
  });
  $('#atemMacros').addEventListener('click', (ev) => { const b = ev.target.closest('[data-macro]'); if (b && live()) cmd('macroRun', { macro: Number(b.dataset.macro) }).then(() => toast('Macro started')); });
  $('#atemMacroStop').addEventListener('click', () => cmd('macroStop'));
  document.addEventListener('keydown', (e) => {
    if (window.CC.getTab() !== 'atem' || !live() || document.querySelector('dialog[open]') || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || e.repeat) return;
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); cmd('auto', meBody()); }
    if (e.key === 'c' || e.key === 'C') cmd('cut', meBody());
    const n = Number(e.key); if (e.altKey && n >= 1 && n <= mes().length) { setMe(n - 1); renderSwitcher(); }
  });
  meListeners.push(() => { if (tabNow === 'atem') renderSwitcher(); });
  window.CCATEMME = { get: curMe, set: setMe, count: () => mes().length, on: (fn) => meListeners.push(fn) };
})();
