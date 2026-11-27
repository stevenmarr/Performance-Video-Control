'use strict';
// ATEM Micro Panel card on the ATEM page (lib/surfaces/bmd-panel). Reads GET /api/surfaces/atem-panel once a
// second while the ATEM page is open; every change is one POST.
(() => {
  const $ = (s) => document.querySelector(s);
  const CC = window.CC;
  if (!$('#ampPanel') || !CC) return;
  const api = (method, path, body) => CC.api(method, path, body);
  const esc = CC.esc || ((s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const STATE = {
    off: 'Off.', disabled: 'Turned off on this computer (CC_BMD_PANEL=0).', searching: 'Looking for the panel. Plug it in by USB-C, or pair it over Bluetooth in System Settings.',
    authenticating: 'Found the panel; answering its handshake…', connected: 'Connected.', conflict: 'Waiting: ATEM Software Control or ATEM Setup is open on this Mac.',
    busy: 'The panel is in use by another program.', refused: 'The panel did not answer the handshake.', 'no-hid': 'The HID library is missing, so Control Center cannot open the panel.', error: 'Error.',
  };
  let busy = false;
  function instOptions(cur) {
    const st = window.CCSYS && window.CCSYS.state && window.CCSYS.state();
    const list = ((st && st.instances) || []).filter((i) => i.type === 'atem');
    const rows = list.length ? list : [{ id: 'atem', name: 'ATEM' }];
    return rows.map((i) => `<option value="${esc(i.id)}" ${i.id === cur ? 'selected' : ''}>${esc(i.name || i.id)}</option>`).join('');
  }
  function paint(st) {
    if (!st) return;
    const s = st.settings || {};
    const set = (sel, prop, v) => { const el = $(sel); if (el && document.activeElement !== el) el[prop] = v; };
    set('#ampEnabled', 'checked', !!st.enabled);
    const inst = $('#ampInst'); if (inst && document.activeElement !== inst) inst.innerHTML = instOptions(st.instance);
    set('#ampMe', 'value', String(st.me || 1)); set('#ampPgm', 'value', s.programRow || 'hot'); set('#ampArm', 'value', s.arm || 'none');
    set('#ampInvert', 'checked', !!s.tbarInvert); set('#ampLedRev', 'checked', !!s.tbarLedReverse);
    const d = st.device;
    const bits = [STATE[st.state] || st.state];
    if (d) bits.push(`${esc(d.product || 'ATEM Micro Panel')} over ${d.transport === 'bluetooth' ? 'Bluetooth' : 'USB'}${d.serial ? ` · serial ${esc(d.serial)}` : ''}`);
    if (st.battery !== null && st.battery !== undefined) bits.push(`battery ${st.battery}%`);
    if (st.enabled) bits.push(st.atemConnected ? `driving M/E ${st.me} of ${st.mes}` : 'the ATEM is not connected');
    if (st.tbar && st.tbar.engaged === false) bits.push('<b>park the T-bar at either end to pick it up</b>');
    if (st.conflict && st.conflict.length) bits.push(`open now: ${st.conflict.map(esc).join(', ')}`);
    if (st.error && st.state !== 'connected') bits.push(esc(st.error));
    $('#ampState').innerHTML = bits.join(' · ');
    const lines = (st.events || []).filter((e) => e.kind !== 'release').slice(-14).reverse().map((e) => {
      const t = new Date(e.at).toLocaleTimeString();
      if (e.kind === 'send') return `${t}  ${e.label || ''} → ${e.op} ${JSON.stringify(e.body || {})}`;
      if (e.kind === 'refused') return `${t}  ${e.label || ''} refused: ${e.reason}`;
      if (e.kind === 'press') return `${t}  ${e.label || e.key}`;
      return `${t}  ${e.kind}${e.me ? ` M/E ${e.me}` : ''}${e.detail ? `: ${e.detail}` : ''}`;
    });
    $('#ampLog').textContent = lines.join('\n');
  }
  async function refresh() {
    if (busy || $('#pane-atem').hidden) return;
    try { paint(await api('GET', '/api/surfaces/atem-panel')); } catch { /* server restarting */ }
  }
  async function post(body) { busy = true; try { paint(await api('POST', '/api/surfaces/atem-panel', body)); } catch (e) { $('#ampState').textContent = e.message; } finally { busy = false; } }
  $('#ampEnabled').addEventListener('change', (e) => post({ enabled: e.target.checked }));
  $('#ampInst').addEventListener('change', (e) => post({ instance: e.target.value }));
  $('#ampMe').addEventListener('change', (e) => post({ me: Number(e.target.value) }));
  $('#ampPgm').addEventListener('change', (e) => post({ programRow: e.target.value }));
  $('#ampArm').addEventListener('change', (e) => post({ arm: e.target.value }));
  $('#ampInvert').addEventListener('change', (e) => post({ tbarInvert: e.target.checked }));
  $('#ampLedRev').addEventListener('change', (e) => post({ tbarLedReverse: e.target.checked }));
  setInterval(refresh, 1000);
  refresh();
})();
