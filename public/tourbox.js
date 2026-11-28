
'use strict';
// TourBox card on CAMERA CONTROL (lib/surfaces/tourbox). Reads GET /api/surfaces/tourbox
// and lets the operator pick a serial port, claim or release it, turn on Learn mode, and read the event log.
(() => {
  const $ = (s) => document.querySelector(s);
  const CC = window.CC;
  if (!$('#tbxPanel') || !CC) return;
  const { api, toast } = CC;
  let busy = false;
  let last = '';

  function set(sel, key, value) {
    const el = $(sel);
    if (!el || document.activeElement === el) return;
    if (key === 'checked') el.checked = !!value;
    else if (key === 'text') el.textContent = value == null ? '' : String(value);
  }

  function paint(st) {
    if (!st) return;
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

  refresh();
  setInterval(refresh, 800);
})();
