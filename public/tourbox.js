'use strict';
// TourBox card on CAMERA CONTROL (lib/surfaces/tourbox). Reads GET /api/surfaces/tourbox
// and lets the operator pick a serial port, claim or release it, turn on Learn mode, map
// each control to a Control Center action, and read the event log.
(() => {
  const $ = (s) => document.querySelector(s);
  const CC = window.CC;
  if (!$('#tbxPanel') || !CC) return;
  const { api, toast } = CC;
  let busy = false;
  let last = '';
  let lastMapKey = '';
  let lastSt = null;

  function set(sel, key, value) {
    const el = $(sel);
    if (!el || document.activeElement === el) return;
    if (key === 'checked') el.checked = !!value;
    else if (key === 'text') el.textContent = value == null ? '' : String(value);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function heldKey(held) {
    return (held || []).map((h) => String(h).toLowerCase()).filter(Boolean).sort().join('+');
  }

  function rowId(control, held) {
    return 'tbx-row-' + String(control || '') + '--' + heldKey(held);
  }

  function sameHeld(a, b) {
    return heldKey(a) === heldKey(b);
  }

  function findBinding(bindings, control, held) {
    return (bindings || []).find((b) => b && b.control === control && sameHeld(b.held, held)) || null;
  }

  function rowsFor(st) {
    const cat = st.catalog || {};
    const controls = cat.controls || ['knob', 'dial', 'scroll', 'side', 'top', 'tall', 'short', 'up', 'down', 'left', 'right', 'tour', 'c1', 'c2'];
    const modifiers = cat.modifiers || ['side', 'top', 'tall', 'short'];
    const rotaries = ['knob', 'dial', 'scroll'];
    const seen = new Set();
    const rows = [];
    function add(control, held) {
      const key = control + '|' + heldKey(held);
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({ control, held: held || [] });
    }
    for (const c of controls) add(c, []);
    for (const c of rotaries) {
      if (!controls.includes(c)) continue;
      for (const m of modifiers) add(c, [m]);
    }
    for (const b of st.bindings || []) {
      if (b && b.control) add(b.control, b.held || []);
    }
    return rows;
  }

  function actionOptions(catalog, event, current) {
    const actions = (catalog && catalog.actions) || [];
    const opts = [];
    for (const a of actions) {
      if (a.id === 'none' || !a.events || a.events.includes(event)) {
        opts.push({ value: a.id === 'none' ? '' : a.id, label: a.label || a.id });
      }
    }
    if (current && !opts.some((o) => o.value === current)) opts.push({ value: current, label: current });
    return opts;
  }

  function fieldSelect(name, value, options) {
    const opts = ['<option value="">—</option>'].concat((options || []).map((o) => {
      const v = typeof o === 'string' ? o : o.value;
      const l = typeof o === 'string' ? o : o.label;
      return `<option value="${esc(v)}"${String(v) === String(value || '') ? ' selected' : ''}>${esc(l)}</option>`;
    }));
    return `<select class="tbx-field" data-field="${esc(name)}" aria-label="${esc(name)}">${opts.join('')}</select>`;
  }

  function extrasHtml(spec, action, catalog, profiles) {
    if (!action || !spec || !spec.fields || !spec.fields.length) return '';
    const bits = [];
    for (const f of spec.fields) {
      if (f === 'op') bits.push(fieldSelect('op', action.op, (catalog.ops || []).map((x) => ({ value: x, label: x }))));
      else if (f === 'target') bits.push(fieldSelect('target', action.target || 'selected', catalog.targets || []));
      else if (f === 'axis') bits.push(fieldSelect('axis', action.axis || 'zoom', catalog.axes || []));
      else if (f === 'bank') bits.push(fieldSelect('bank', action.bank, catalog.banks || []));
      else if (f === 'dir') bits.push(fieldSelect('dir', action.dir == null ? '1' : String(action.dir), [{ value: '1', label: 'Next' }, { value: '-1', label: 'Prev' }]));
      else if (f === 'profile') bits.push(fieldSelect('profile', action.profile, (profiles || []).map((p) => ({ value: p.id, label: p.name || p.id }))));
    }
    return bits.length ? `<div class="tbx-extra">${bits.join('')}</div>` : '';
  }

  function slotHtml(binding, event, catalog, profiles) {
    const action = binding && binding[event];
    const cur = action && action.action ? action.action : '';
    const opts = actionOptions(catalog, event, cur).map((o) => {
      return `<option value="${esc(o.value)}"${o.value === cur ? ' selected' : ''}>${esc(o.label)}</option>`;
    }).join('');
    const spec = ((catalog && catalog.actions) || []).find((a) => a.id === cur);
    return `<select class="tbx-action" data-event="${esc(event)}" aria-label="${esc(event)}">${opts}</select>${extrasHtml(spec, action, catalog, profiles)}`;
  }

  function paintMap(st) {
    const table = $('#tbxMap');
    if (!table) return;
    const tbody = table.querySelector('tbody');
    if (!tbody) return;
    const focused = table.contains(document.activeElement);
    const mapKey = (st.profile || '') + '\0' + JSON.stringify(st.bindings || []);
    if (mapKey !== lastMapKey && !focused) {
      lastMapKey = mapKey;
      const catalog = st.catalog || {};
      const profiles = st.profiles || [];
      const bindings = st.bindings || [];
      tbody.innerHTML = rowsFor(st).map((row) => {
        const b = findBinding(bindings, row.control, row.held) || { control: row.control, held: row.held };
        const heldLabel = (row.held && row.held.length) ? row.held.join(' + ') : '—';
        return `<tr id="${esc(rowId(row.control, row.held))}" data-control="${esc(row.control)}" data-held="${esc((row.held || []).join(','))}">
          <td class="tbx-ctrl">${esc(row.control)}</td>
          <td>${esc(heldLabel)}</td>
          <td class="tbx-slot" data-event="turn">${slotHtml(b, 'turn', catalog, profiles)}</td>
          <td class="tbx-slot" data-event="press">${slotHtml(b, 'press', catalog, profiles)}</td>
          <td class="tbx-slot" data-event="long">${slotHtml(b, 'long', catalog, profiles)}</td>
        </tr>`;
      }).join('');
    }
    highlightLearn(st);
  }

  function highlightLearn(st) {
    const table = $('#tbxMap');
    if (!table) return;
    table.querySelectorAll('tr.tbx-learn').forEach((tr) => tr.classList.remove('tbx-learn'));
    const t = st && st.lastTouched;
    if (!t || !t.control) return;
    const id = rowId(t.control, t.held || []);
    const tr = document.getElementById(id);
    if (tr) {
      tr.classList.add('tbx-learn');
      if (st.learn) tr.scrollIntoView({ block: 'nearest' });
    }
  }

  function paintProfile(st) {
    const sel = $('#tbxProfile');
    if (!sel || document.activeElement === sel) return;
    const profiles = st.profiles || [];
    const cur = st.profile || '';
    const key = cur + '\0' + profiles.map((p) => p.id + ':' + (p.name || '')).join('|');
    if (sel.getAttribute('data-key') !== key) {
      sel.setAttribute('data-key', key);
      sel.innerHTML = profiles.map((p) => {
        const selAttr = p.id === cur ? ' selected' : '';
        return `<option value="${esc(p.id)}"${selAttr}>${esc(p.name || p.id)}</option>`;
      }).join('');
    } else {
      sel.value = cur;
    }
  }

  function paint(st) {
    if (!st) return;
    lastSt = st;
    set('#tbxEnabled', 'checked', !!st.enabled);
    set('#tbxLearn', 'checked', !!st.learn);
    const live = $('#tbxLive');
    if (live) { live.hidden = !st.live; live.textContent = st.live ? 'LIVE' : ''; }
    const bits = [];
    bits.push(st.state ? st.state.toUpperCase() : 'OFF');
    if (st.profileName) bits.push(st.profileName);
    if (st.cameraName) bits.push(st.cameraName);
    if (st.gang) bits.push('GANG');
    if (st.bank) bits.push(String(st.bank).toUpperCase());
    if (st.offline) bits.push('camera offline');
    if (st.locked) bits.push('paint locked');
    if (st.error) bits.push(st.error);
    set('#tbxState', 'text', bits.join(' · '));
    const sel = $('#tbxPort');
    if (sel && document.activeElement !== sel) {
      const ports = Array.isArray(st.ports) ? st.ports : [];
      const cur = st.port || '';
      const key = cur + '\0' + ports.map((p) => (p.path || '') + ':' + (p.kind || '') + ':' + (p.product || '')).join('|');
      if (sel.getAttribute('data-key') !== key) {
        sel.setAttribute('data-key', key);
        const opts = [{ value: '', label: 'Auto' }];
        const seen = new Set();
        for (const p of ports) {
          if (!p || !p.path || seen.has(p.path)) continue;
          seen.add(p.path);
          const bits = [p.path];
          if (p.product) bits.push(p.product);
          if (p.kind === 'candidate') bits.push('possible TourBox');
          else if (p.kind === 'tourbox') bits.push('TourBox');
          opts.push({ value: p.path, label: bits.join(' — ') });
        }
        if (cur && !seen.has(cur)) opts.push({ value: cur, label: cur + ' (saved)' });
        sel.innerHTML = opts.map((o) => {
          const selAttr = o.value === cur ? ' selected' : '';
          return '<option value="' + String(o.value).replace(/"/g, '&quot;') + '"' + selAttr + '>' + o.label + '</option>';
        }).join('');
      } else {
        sel.value = cur;
      }
    }
    const t = st.lastTouched;
    const notice = st.lastNotice && st.lastNotice.reason;
    const line = t
      ? `${(t.control || '').toUpperCase()}${t.op ? ` · ${String(t.op).toUpperCase()}` : ''}${t.text ? ` ${t.text}` : (t.value != null ? ` ${t.value}` : '')}`
      : '';
    set('#tbxTouch', 'text', [line, notice].filter(Boolean).join(' · '));
    const log = $('#tbxLog');
    if (log) {
      const rows = (st.events || []).slice().reverse().map((e) => {
        const at = (e.at || '').replace('T', ' ').replace(/\..+/, '');
        return `${at}  ${e.kind || ''}${e.control ? ` ${e.control}` : ''}${e.detail ? `  ${e.detail}` : ''}${e.reason ? `  ${e.reason}` : ''}${e.ticks ? `  ${e.ticks}` : ''}`;
      });
      const text = rows.join('\n') || 'No events yet. Enable the TourBox, quit Console, and turn a knob.';
      if (text !== last) { log.textContent = text; last = text; }
    }
    paintProfile(st);
    paintMap(st);
  }

  function bindingFromRow(tr) {
    const control = tr.getAttribute('data-control');
    const held = (tr.getAttribute('data-held') || '').split(',').filter(Boolean);
    const row = { control, held };
    for (const event of ['turn', 'press', 'long']) {
      const slot = tr.querySelector(`.tbx-slot[data-event="${event}"]`);
      if (!slot) continue;
      const sel = slot.querySelector('select.tbx-action');
      const action = sel && sel.value;
      if (!action) continue;
      const spec = { action };
      slot.querySelectorAll('select.tbx-field').forEach((f) => {
        if (!f.dataset.field || f.value === '') return;
        if (f.dataset.field === 'dir') spec.dir = Number(f.value);
        else spec[f.dataset.field] = f.value;
      });
      row[event] = spec;
    }
    return row;
  }

  async function refresh() {
    try { paint(await api('GET', '/api/surfaces/tourbox')); } catch { /* server restarting */ }
  }

  async function post(body) {
    busy = true;
    try { paint(await api('POST', '/api/surfaces/tourbox', body)); }
    catch (e) { const el = $('#tbxState'); if (el) el.textContent = e.message; if (toast) toast(e.message, true); }
    finally { busy = false; }
  }

  const en = $('#tbxEnabled');
  if (en) en.addEventListener('change', () => { if (!busy) post({ enabled: en.checked }); });
  const learn = $('#tbxLearn');
  if (learn) learn.addEventListener('change', () => { if (!busy) post({ learn: learn.checked }); });
  const claim = $('#tbxClaim');
  if (claim) claim.addEventListener('click', () => {
    const sel = $('#tbxPort');
    const body = { enabled: true };
    if (sel && sel.value) body.port = sel.value;
    post(body);
  });
  const use = $('#tbxUsePort');
  if (use) use.addEventListener('click', () => {
    const sel = $('#tbxPort');
    post({ port: sel ? sel.value : '', enabled: true });
  });
  const rel = $('#tbxRelease');
  if (rel) rel.addEventListener('click', () => post({ enabled: false }));
  const prof = $('#tbxProfile');
  if (prof) prof.addEventListener('change', () => { if (!busy) post({ profile: prof.value }); });
  const reset = $('#tbxResetMap');
  if (reset) reset.addEventListener('click', () => {
    if (busy) return;
    if (!window.confirm('Reset this TourBox profile to the factory map? The change is saved with the show.')) return;
    post({ resetMap: true });
  });

  const table = $('#tbxMap');
  if (table) {
    table.addEventListener('change', (ev) => {
      const el = ev.target;
      if (!el || busy) return;
      const tr = el.closest('tr');
      if (!tr || !tr.getAttribute('data-control')) return;
      if (el.classList.contains('tbx-action')) {
        // Rebuild extras for the new action using last catalog, then post the row.
        const event = el.getAttribute('data-event');
        const slot = el.closest('.tbx-slot');
        const catalog = (lastSt && lastSt.catalog) || {};
        const spec = ((catalog.actions) || []).find((a) => a.id === el.value);
        const dummy = el.value ? { action: el.value } : null;
        const extra = slot ? slot.querySelector('.tbx-extra') : null;
        if (extra) extra.remove();
        if (slot && dummy) {
          const html = extrasHtml(spec, dummy, catalog, (lastSt && lastSt.profiles) || []);
          if (html) slot.insertAdjacentHTML('beforeend', html);
        }
      }
      lastMapKey = '';
      post({ binding: bindingFromRow(tr) });
    });
  }

  refresh();
  setInterval(refresh, 800);
})();
