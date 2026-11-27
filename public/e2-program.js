'use strict';
// Web desk for Event Master layer programming. Same job as the Stream Deck + XL
// pages: pick a destination, pick a layer, move the dials, assign a source.
// Numbers go to Preview. Red means that layer is on program.
(function () {
  const root = document.getElementById('e2program');
  if (!root || !window.CC || !window.CCSYS) return;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let busy = false;
  let confirmClear = false;

  function owner() {
    const tab = document.querySelector('.tab[data-tab="xprogram"]');
    return (tab && tab.dataset.owner) || 'e2';
  }
  function model() {
    const st = window.CCSYS.state && window.CCSYS.state();
    const id = owner();
    const view = st && st.views && st.views[id];
    return (view && view.program) || (window.CCSYS.view() && window.CCSYS.view().program) || null;
  }
  async function act(body) {
    if (busy) return;
    busy = true;
    try {
      await window.CC.api('POST', `/api/sys/${owner()}/program`, body);
      await window.CCSYS.refetch();
    } catch (e) {
      window.CC.toast(e.message, true);
    } finally {
      busy = false;
      paint();
    }
  }

  function card(cls, title, sub, live, attrs) {
    return `<button type="button" class="e2p-card ${cls}" ${attrs}><b>${esc(title)}</b><small>${esc(sub)}</small>${live ? '<span class="live-tag">LIVE</span>' : ''}</button>`;
  }

  function paint() {
    const p = model();
    if (!p || !p.ready) {
      root.innerHTML = `<div class="e2p"><p class="e2p-note">${p && p.error ? esc(p.error) : 'Connect the E2. PROGRAM reads that frame and only shows the layers and dials it actually has.'}</p></div>`;
      return;
    }
    const frame = p.frame || {};
    const dests = (p.destinations || []).map((d) => card(
      `${d.selected ? 'sel' : ''} ${d.live ? 'live' : (d.preview ? 'pvw' : '')}`,
      d.name, d.kind === 'aux' ? `AUX ${d.key}` : d.key, d.live, `data-dest="${esc(d.key)}"`,
    )).join('');
    const layers = p.note
      ? `<p class="e2p-note">${esc(p.note)}</p>`
      : (p.layers || []).map((l) => {
        const bits = [l.role === 'mix' ? 'MIX' : l.role === 'split' ? 'SPLIT' : l.role === 'background' ? 'BG' : 'PIP'];
        if (l.live) bits.push('PROGRAM');
        else if (l.pvw) bits.push('PREVIEW');
        else if (l.free) bits.push('FREE');
        else bits.push('IN USE');
        if (l.sourceName) bits.push(l.sourceName);
        return card(`${l.selected ? 'sel' : ''} ${l.live ? 'live' : (l.pvw ? 'pvw' : '')} ${l.free ? 'free' : ''}`, l.name, bits.join(' · '), l.live, `data-layer="${l.id}"`);
      }).join('') || '<p class="e2p-note">This destination has no layers.</p>';
    const dials = (p.encoders || []).map((e) => {
      const active = e.pair[e.active] || e.pair[0];
      const halves = e.pair.map((part, i) => `<button type="button" class="half ${i === e.active ? 'on' : ''}" data-swap="${e.index}" data-half="${i}"><span>${esc(part.label)}</span><b>${esc(part.value == null ? '—' : part.value)}</b></button>`).join('');
      const min = active && active.min != null ? active.min : 0;
      const max = active && active.max != null ? active.max : 1000;
      const step = active && active.fine ? active.fine : 1;
      const val = active && active.value != null ? active.value : min;
      return `<div class="e2p-dial"><div class="pair">${halves}</div><input type="range" min="${min}" max="${max}" step="${step}" value="${val}" data-dial="${e.index}" data-was="${val}"><div class="e2p-tools"><button type="button" class="btn mini" data-swap="${e.index}">SWAP</button><button type="button" class="btn mini" data-reset="${e.index}">RESET</button></div></div>`;
    }).join('') || '<p class="e2p-note">Pick a layer. Dials appear for the properties this frame sent.</p>';
    const banks = (p.banks || []).map((b) => `<button type="button" class="btn mini ${p.selected && p.selected.bank === b.id ? 'on' : ''}" data-bank="${esc(b.id)}">${esc(b.label)}</button>`).join('');
    const sc = p.shortcuts || {};
    const tools = [
      sc.aspect ? `<button type="button" class="btn mini ${p.selected && p.selected.aspectLock ? 'on' : ''}" data-aspect="lock">ASPECT ${p.selected && p.selected.aspectLock ? 'ON' : 'LOCK'}</button>` : '',
      sc.center ? '<button type="button" class="btn mini" data-aspect="center">CENTER</button>' : '',
      sc.fit ? '<button type="button" class="btn mini" data-aspect="fit">FIT</button>' : '',
      sc.fill ? '<button type="button" class="btn mini" data-aspect="fill">FILL</button>' : '',
      sc.freeze ? `<button type="button" class="btn mini ${p.layerFrozen ? 'on' : ''}" data-freeze="1">FREEZE</button>` : '',
      sc.invert ? '<button type="button" class="btn mini" data-invert="1">INVERT</button>' : '',
      sc.z ? '<button type="button" class="btn mini" data-z="1">FRONT</button><button type="button" class="btn mini" data-z="-1">BACK</button>' : '',
      sc.clear ? `<button type="button" class="btn mini guard" data-clear="1">${confirmClear ? 'CLEAR?' : 'CLEAR'}</button>` : '',
    ].join('');
    const sources = (p.sources || []).map((s) => {
      const plate = s.thumb ? `<img alt="" src="${esc(s.thumb)}">` : esc((s.name || '?').slice(0, 3).toUpperCase());
      return `<button type="button" class="e2p-card e2p-src ${s.live ? 'live' : (s.selected ? 'pvw sel' : '')}" data-src="${s.id}">${s.live ? '<span class="live-tag">LIVE</span>' : ''}<span class="e2p-plate" style="background:${esc(s.plate || '#333')}">${plate}</span><span><b>${esc(s.name)}</b><small>${esc(s.kind || 'input')}${s.size && s.size.label ? ' · ' + esc(s.size.label) : ''}</small></span></button>`;
    }).join('') || '<p class="e2p-note">No sources reported.</p>';
    const presets = (p.presets || []).map((pr) => `<option value="${pr.id}">${esc(pr.sno != null ? pr.sno : pr.id)} · ${esc(pr.name)}</option>`).join('');
    const unknown = (p.unknown || []).length;
    const review = (p.review || []).map((r) => `<li>${esc(r.path)} → ${esc(r.prop)} ${r.applied ? '(on a dial)' : '(not applied)'} ${Math.round((r.confidence || 0) * 100)}%</li>`).join('');
    root.innerHTML = `<div class="e2p">
      <div class="e2p-head"><h2>E2 PROGRAM</h2><small>${esc(frame.name || '')} ${esc(frame.model || '')} ${esc(frame.version || '')}</small><span class="spacer"></span><button type="button" class="btn mini" data-refresh="1">Refresh from frame</button></div>
      <p class="e2p-note">Pick a destination, then a layer. Dials send to Preview. A slow move on the Stream Deck + XL is one step; a fast spin is bigger. Tap a dial to swap the pair. Hold it 800 ms, or press RESET, to put the value back. Red frame and LIVE means that layer is on program.</p>
      <div class="e2p-grid">
        <div class="e2p-col"><h3>DESTINATION</h3><div class="e2p-list">${dests}</div></div>
        <div class="e2p-col"><h3>LAYER</h3><div class="e2p-list">${layers}</div></div>
        <div class="e2p-col"><h3>DIALS</h3><div class="e2p-tools">${banks}</div><div class="e2p-list">${dials}</div><div class="e2p-tools">${tools}</div></div>
        <div class="e2p-col"><h3>SOURCE</h3><div class="e2p-list">${sources}</div></div>
      </div>
      <div class="e2p-foot">
        <select id="e2pPreset">${presets}</select>
        <button type="button" class="btn mini" data-recall="preview">RECALL → PVW</button>
        <button type="button" class="btn mini guard" data-save="1">SAVE PVW</button>
        <button type="button" class="btn hot" data-cut="1">CUT</button>
        <button type="button" class="btn hot" data-take="1">AUTO</button>
      </div>
      ${unknown ? `<p class="e2p-review">${unknown} field${unknown === 1 ? '' : 's'} from this frame ${p.llm && p.llm.enabled ? 'were offered to the mapper' : 'are not on a dial'}. They stay off the controls until they match a property the desk already sends.</p>` : ''}
      ${review ? `<ul class="e2p-review">${review}</ul>` : ''}
    </div>`;
  }

  root.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-dest],[data-layer],[data-src],[data-bank],[data-aspect],[data-freeze],[data-invert],[data-z],[data-clear],[data-recall],[data-save],[data-cut],[data-take],[data-refresh],[data-swap],[data-reset]');
    if (!t) return;
    if (t.dataset.dest) return act({ op: 'selectDest', dest: t.dataset.dest });
    if (t.dataset.layer != null) return act({ op: 'selectLayer', layer: Number(t.dataset.layer) });
    if (t.dataset.src != null) return act({ op: 'source', id: Number(t.dataset.src) });
    if (t.dataset.bank) return act({ op: 'selectBank', bank: t.dataset.bank });
    if (t.dataset.aspect) return act({ op: 'aspect', mode: t.dataset.aspect });
    if (t.dataset.freeze) return act({ op: 'freeze' });
    if (t.dataset.invert) return act({ op: 'invert' });
    if (t.dataset.z) return act({ op: 'z', dir: Number(t.dataset.z) });
    if (t.dataset.clear) {
      if (!confirmClear) { confirmClear = true; paint(); return; }
      confirmClear = false;
      return act({ op: 'clear', confirm: true });
    }
    if (t.dataset.recall) {
      const id = Number((document.getElementById('e2pPreset') || {}).value);
      return act({ op: 'recall', id, target: 'preview' });
    }
    if (t.dataset.save) return act({ op: 'save' });
    if (t.dataset.cut) return act({ op: 'cut' });
    if (t.dataset.take) return act({ op: 'take' });
    if (t.dataset.refresh) return act({ op: 'discover' });
    if (t.dataset.swap != null) return act({ op: 'press', encoder: Number(t.dataset.swap), kind: 'toggle' });
    if (t.dataset.reset != null) return act({ op: 'press', encoder: Number(t.dataset.reset), kind: 'reset' });
  });
  root.addEventListener('change', (ev) => {
    const input = ev.target.closest('input[data-dial]');
    if (!input) return;
    const p = model();
    const enc = p && (p.encoders || []).find((e) => e.index === Number(input.dataset.dial));
    const active = enc && (enc.pair[enc.active] || enc.pair[0]);
    if (!active) return;
    const fine = Number(active.fine) || 1;
    const delta = Number(input.value) - Number(input.dataset.was);
    const ticks = Math.round(delta / fine);
    if (!ticks) return;
    act({ op: 'turn', encoder: Number(input.dataset.dial), ticks, dtMs: 400 });
  });

  window.CCSYS.onRender((_view, tab) => {
    if (tab === 'xprogram' || (document.body.classList.contains('tab-xprogram'))) paint();
  });
})();
