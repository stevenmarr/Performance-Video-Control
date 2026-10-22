'use strict';
// 0.7.0 Blackmagic ATEM tabs: SWITCHER (program / preview bus, CUT / AUTO, transition style and rate, next
// transition + key tie, upstream / downstream keys, FTB), AUX (aux output routing) and MACROS. State comes from
// public/sys.js (window.CCSYS); every action is POST /api/sys/atem/cmd/<name>.
(() => {
  const $ = (s) => document.querySelector(s);
  const { api, toast, run, esc } = window.CC;
  const S = window.CCSYS;
  let V = null; let auxSel = Number(localStorage.getItem('cc.atemAux') || 0);
  const cmd = (name, body = {}) => run(api('POST', `/api/sys/atem/cmd/${name}`, body));
  const live = () => V && V.kind === 'atem' && V.status && V.status.connected;
  const btn = (i, cls, attr) => `<button class="src ${cls}" ${attr}="${i.id}" title="${esc(i.long)} (${i.id})"><b>${esc(i.short || i.id)}</b><span>${esc(i.long)}</span></button>`;

  function renderSwitcher() {
    const off = !live();
    $('#atemInfo').textContent = off ? (V && V.status && V.status.error ? `not connected · ${V.status.error}` : 'not connected · set its IP on ⌂ SYSTEMS')
      : `${V.product} · protocol ${V.protocol} · M/E ${V.me} of ${V.topology ? V.topology.mixEffects : 1}`;
    $('#atemTally').innerHTML = off ? '' : `<span class="lg pgm">PGM</span> ${esc(V.tally.program.join(', ') || '—')} &nbsp; <span class="lg pvw">PVW</span> ${esc(V.tally.preview.join(', ') || '—')}`;
    S.set($('#atemPgm'), 'atem-pgm', V.bus.map((i) => btn(i, i.pgm ? 'on-pgm' : '', 'data-pgm')).join('') || '<div class="note">No sources (not connected).</div>');
    S.set($('#atemPvw'), 'atem-pvw', V.bus.map((i) => btn(i, i.pvw ? 'on-pvw' : '', 'data-pvw')).join(''));
    const sel = V.nextSelection || 1;
    const layers = [{ bit: 0, label: 'BKGD' }].concat((V.keyers || []).map((k) => ({ bit: k.index + 1, label: `KEY ${k.index + 1}` })));
    S.set($('#atemNext'), 'atem-next', layers.map((l) => `<button class="mode ${sel & (1 << l.bit) ? 'active' : ''}" data-next="${l.bit}" type="button">${l.label}</button>`).join(''));
    S.set($('#atemStyle'), 'atem-style', (V.styles || []).map((x) => `<button class="mode ${V.style === x ? 'active' : ''}" data-style="${x}" type="button">${x}</button>`).join(''));
    const rate = $('#atemRate'); if (document.activeElement !== rate) rate.value = V.mixRate || '';
    S.set($('#atemUsk'), 'atem-usk', (V.keyers || []).map((k) => `<div class="key-cell"><span class="lbl">KEY ${k.index + 1}</span><button class="mode ${k.onAir ? 'onair' : ''}" data-usk="${k.index}" data-on="${k.onAir ? 0 : 1}" type="button">${k.onAir ? 'ON AIR' : 'OFF'}</button>
      <button class="mode ${k.tie ? 'active' : ''}" data-usktie="${k.index}" data-on="${k.tie ? 0 : 1}" type="button">TIE</button></div>`).join('') || '<div class="note small">No upstream keys.</div>');
    S.set($('#atemDsk'), 'atem-dsk', (V.dsk || []).map((k) => `<div class="key-cell"><span class="lbl">DSK ${k.index + 1}</span>
      <button class="mode ${k.tie ? 'active' : ''}" data-dsktie="${k.index}" data-on="${k.tie ? 0 : 1}" type="button">TIE</button>
      <button class="mode ${k.onAir ? 'onair' : ''}" data-dskcut="${k.index}" data-on="${k.onAir ? 0 : 1}" type="button">${k.onAir ? 'ON AIR' : 'CUT'}</button>
      <button class="mode ${k.inTransition ? 'running' : ''}" data-dskauto="${k.index}" type="button">AUTO</button><small>${k.rate ? `${k.rate} fr` : ''}</small></div>`).join('') || '<div class="note small">No downstream keys.</div>');
    renderTransport();
  }
  function renderTransport() {
    const off = !live();
    for (const id of ['#atemCut', '#atemAuto', '#atemFtb']) $(id).disabled = off;
    $('#atemAutoSub').textContent = off ? '' : `${V.nextStyle || V.style} · ${V.mixRate || '—'} fr`;
    $('#atemAuto').classList.toggle('running', !!(V && V.inTransition));
    $('#atemBar').style.width = V && V.inTransition ? `${Math.round((V.handle || 0) / 100)}%` : '0%';
    const f = (V && V.ftb) || {};
    $('#atemFtb').classList.toggle('on', !!f.black); $('#atemFtb').classList.toggle('running', !!f.inTransition);
    $('#atemFtbState').textContent = f.inTransition ? 'FADING' : f.black ? 'BLACK' : 'OFF';
    const r = $('#atemFtbRate'); if (document.activeElement !== r) r.value = f.rate || '';
  }
  function renderAux() {
    if (!(V.aux || []).length) { S.set($('#atemAuxBar'), 'atem-auxbar', '<div class="note">This ATEM reports no aux outputs (or is not connected).</div>'); S.set($('#atemAuxGrid'), 'atem-aux', ''); return; }
    if (auxSel >= V.aux.length) auxSel = 0;
    const name = (id) => { const i = V.inputs.find((x) => x.id === id); return i ? i.short : '—'; };
    S.set($('#atemAuxBar'), 'atem-auxbar', `<span class="modes-lbl">AUX</span>${V.aux.map((a) => `<button class="mode ${auxSel === a.index ? 'active' : ''}" data-aux="${a.index}" type="button">AUX ${a.index + 1} · ${esc(name(a.source))}</button>`).join('')}`);
    const cur = V.aux[auxSel] ? V.aux[auxSel].source : null;
    S.set($('#atemAuxGrid'), 'atem-aux', (V.auxSources || []).map((i) => btn(i, i.id === cur ? 'on-aux' : '', 'data-auxsrc')).join(''));
  }
  function renderMacros() {
    const r = V.macroRun || {};
    const running = r.isRunning ? (V.macros.find((m) => m.index === r.macroIndex) || { name: `Macro ${r.macroIndex + 1}` }) : null;
    $('#atemMacroInfo').textContent = running ? `running: ${running.name}` : 'tap to run';
    $('#atemMacroStop').disabled = !r.isRunning;
    S.set($('#atemMacros'), 'atem-macros', (V.macros || []).map((m) => `<button class="preset ${r.isRunning && r.macroIndex === m.index ? 'pvw running' : ''}" data-macro="${m.index}" title="${esc(m.description || m.name)}"><span class="num">${m.index + 1}</span><span class="name">${esc(m.name || `Macro ${m.index + 1}`)}</span><span class="chips">${m.description ? `<span class="chip">${esc(m.description)}</span>` : ''}</span></button>`).join('') || '<div class="note">No macros recorded on this ATEM.</div>');
  }
  S.onRender((v, tab) => {
    V = v; if (!V || V.kind !== 'atem') return;
    if (tab === 'atem') renderSwitcher(); else if (tab === 'aaux') renderAux(); else if (tab === 'amacros') renderMacros();
  });
  $('#pane-atem').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b || !live()) return;
    const d = b.dataset;
    if (d.pgm) return cmd('program', { source: Number(d.pgm) });
    if (d.pvw) return cmd('preview', { source: Number(d.pvw) });
    if (d.next !== undefined) { const bit = 1 << Number(d.next); const cur = V.nextSelection || 1; const nv = cur & bit ? cur & ~bit : cur | bit; if (!nv) return toast('The next transition needs at least one layer', true); return cmd('nextSelection', { selection: nv }); }
    if (d.style) return cmd('style', { style: d.style });
    if (d.usk !== undefined) return cmd('uskOnAir', { key: Number(d.usk), on: d.on === '1' });
    if (d.usktie !== undefined) return cmd('uskTie', { key: Number(d.usktie), on: d.on === '1' });
    if (d.dsktie !== undefined) return cmd('dskTie', { key: Number(d.dsktie), on: d.on === '1' });
    if (d.dskcut !== undefined) return cmd('dskOnAir', { key: Number(d.dskcut), on: d.on === '1' });
    if (d.dskauto !== undefined) return cmd('dskAuto', { key: Number(d.dskauto) });
    return undefined;
  });
  $('#atemRateSet').addEventListener('click', () => { const r = Number($('#atemRate').value); if (!(r >= 1 && r <= 250)) return toast('Rate is 1..250 frames', true); cmd('mixRate', { rate: r }); $('#atemRate').blur(); });
  $('#atemFtbRate').addEventListener('change', () => { const r = Number($('#atemFtbRate').value); if (r >= 1 && r <= 250) cmd('ftbRate', { rate: r }); });
  $('#atemCut').addEventListener('click', () => cmd('cut'));
  $('#atemAuto').addEventListener('click', () => cmd('auto'));
  $('#atemFtb').addEventListener('click', () => { if (!V.ftb || V.ftb.black || confirm('FADE TO BLACK takes the program output to black. Continue?')) cmd('ftb'); });
  $('#atemAuxBar').addEventListener('click', (ev) => { const b = ev.target.closest('[data-aux]'); if (!b) return; auxSel = Number(b.dataset.aux); localStorage.setItem('cc.atemAux', String(auxSel)); renderAux(); });
  $('#atemAuxGrid').addEventListener('click', (ev) => { const b = ev.target.closest('[data-auxsrc]'); if (b && live()) cmd('aux', { aux: auxSel, source: Number(b.dataset.auxsrc) }); });
  $('#atemMacros').addEventListener('click', (ev) => { const b = ev.target.closest('[data-macro]'); if (b && live()) cmd('macroRun', { macro: Number(b.dataset.macro) }).then(() => toast('Macro started')); });
  $('#atemMacroStop').addEventListener('click', () => cmd('macroStop'));
  document.addEventListener('keydown', (e) => {
    if (window.CC.getTab() !== 'atem' || !live() || document.querySelector('dialog[open]') || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || e.repeat) return;
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); cmd('auto'); }
    if (e.key === 'c' || e.key === 'C') cmd('cut');
  });
})();
