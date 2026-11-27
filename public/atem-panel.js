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
    off: 'Off.', disabled: 'Turned off on this computer (CC_BMD_PANEL=0).', searching: 'Looking for the panel. Plug it into the Raspberry Pi 5 by USB-C (and install the udev rule so Control Center can open it without root).',
    authenticating: 'Found the panel; answering its handshake…', connected: 'Connected.',
    busy: 'The panel is in use by another program (turn off Companion\'s Blackmagic controller surface).',
    refused: 'The panel did not answer the handshake.', 'no-hid': 'The HID library is missing, so Control Center cannot open the panel.', error: 'Error.',
  };
  const FALLBACK_SOURCES = [
    { id: 0, long: 'Black', short: 'BLK' }, { id: 1000, long: 'Color Bars', short: 'BARS' },
    ...Array.from({ length: 20 }, (_, i) => ({ id: i + 1, long: `Input ${i + 1}`, short: String(i + 1) })),
    { id: 2001, long: 'Color 1', short: 'COL1' }, { id: 2002, long: 'Color 2', short: 'COL2' },
    { id: 3010, long: 'Media Player 1', short: 'MP1' }, { id: 3020, long: 'Media Player 2', short: 'MP2' },
    { id: 6000, long: 'SuperSource', short: 'SS' }, { id: 6001, long: 'SuperSource 2', short: 'SS2' },
  ];
  let busy = false;
  let lastSourcesSig = '';
  function instOptions(cur) {
    const st = window.CCSYS && window.CCSYS.state && window.CCSYS.state();
    const list = ((st && st.instances) || []).filter((i) => i.type === 'atem');
    const rows = list.length ? list : [{ id: 'atem', name: 'ATEM' }];
    return rows.map((i) => `<option value="${esc(i.id)}" ${i.id === cur ? 'selected' : ''}>${esc(i.name || i.id)}</option>`).join('');
  }
  function sourceList(st) {
    const have = new Map();
    for (const s of FALLBACK_SOURCES) have.set(s.id, s);
    for (const s of st.sourcesAvailable || []) have.set(s.id, { id: s.id, short: s.short || '', long: s.long || String(s.id) });
    return [...have.values()].sort((a, b) => a.id - b.id);
  }
  function sourceLabel(s) { return s.short && s.long && s.short !== s.long ? `${s.short} — ${s.long}` : (s.long || s.short || String(s.id)); }
  function mappedSources(st) {
    const src = (st.settings && st.settings.sources) || null;
    return Array.from({ length: 20 }, (_, i) => (src && src[i] !== null && src[i] !== undefined && src[i] !== '' ? Number(src[i]) : i + 1));
  }
  function paintMap(st) {
    const box = $('#ampMap'); if (!box) return;
    const srcs = mappedSources(st);
    const opts = sourceList(st);
    const sig = JSON.stringify({ srcs, ids: opts.map((o) => o.id) });
    if (sig === lastSourcesSig && box.children.length === 20) {
      for (let i = 0; i < 20; i++) {
        const sel = box.querySelector(`#ampSrc${i}`);
        if (sel && document.activeElement !== sel) sel.value = String(srcs[i]);
      }
      return;
    }
    lastSourcesSig = sig;
    const options = (cur) => {
      const known = opts.some((o) => o.id === cur);
      const extra = known ? '' : `<option value="${esc(cur)}" selected>id ${esc(cur)}</option>`;
      return extra + opts.map((o) => `<option value="${o.id}" ${o.id === cur ? 'selected' : ''}>${esc(sourceLabel(o))}</option>`).join('');
    };
    box.innerHTML = srcs.map((id, i) => `<label>Btn ${i + 1} <select id="ampSrc${i}">${options(id)}</select></label>`).join('');
    for (let i = 0; i < 20; i++) {
      const sel = $(`#ampSrc${i}`);
      if (!sel || sel._ampBound) continue;
      sel._ampBound = true;
      sel.addEventListener('change', () => {
        const next = Array.from({ length: 20 }, (_, j) => Number(($(`#ampSrc${j}`) || {}).value));
        post({ sources: next });
      });
    }
  }
  function paint(st) {
    if (!st) return;
    const s = st.settings || {};
    const set = (sel, prop, v) => { const el = $(sel); if (el && document.activeElement !== el) el[prop] = v; };
    set('#ampEnabled', 'checked', !!st.enabled);
    const inst = $('#ampInst'); if (inst && document.activeElement !== inst) inst.innerHTML = instOptions(st.instance);
    set('#ampMe', 'value', String(st.me || 1)); set('#ampPgm', 'value', s.programRow || 'hot');
    set('#ampInvert', 'checked', !!s.tbarInvert); set('#ampLedRev', 'checked', !!s.tbarLedReverse);
    paintMap(st);
    const d = st.device;
    const bits = [STATE[st.state] || st.state];
    if (d) bits.push(`${esc(d.product || 'ATEM Micro Panel')} over ${d.transport === 'bluetooth' ? 'Bluetooth' : 'USB'}${d.serial ? ` · serial ${esc(d.serial)}` : ''}`);
    if (st.battery !== null && st.battery !== undefined) bits.push(`battery ${st.battery}%`);
    if (st.enabled) bits.push(st.atemConnected ? `driving M/E ${st.me} of ${st.mes}` : 'the ATEM is not connected');
    if (st.armed) bits.push('<b>ARM is on: CUT, AUTO and the T-bar fire every M/E</b>');
    if (st.tbar && st.tbar.engaged === false) bits.push('<b>park the T-bar at either end to pick it up</b>');
    if (st.error && st.state !== 'connected') bits.push(esc(st.error));
    $('#ampState').innerHTML = bits.join(' · ');
    const lines = (st.events || []).filter((e) => e.kind !== 'release').slice(-14).reverse().map((e) => {
      const t = new Date(e.at).toLocaleTimeString();
      if (e.kind === 'send') return `${t}  ${e.label || ''} → ${e.op} ${JSON.stringify(e.body || {})}`;
      if (e.kind === 'refused') return `${t}  ${e.label || ''} refused: ${e.reason}`;
      if (e.kind === 'press') return `${t}  ${e.label || e.key}`;
      if (e.kind === 'arm') return `${t}  ARM ${e.armed ? 'on (all M/Es)' : 'off'}`;
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
  $('#ampInvert').addEventListener('change', (e) => post({ tbarInvert: e.target.checked }));
  $('#ampLedRev').addEventListener('change', (e) => post({ tbarLedReverse: e.target.checked }));
  $('#ampMapReset').addEventListener('click', () => post({ sources: null }));
  setInterval(refresh, 1000);
  refresh();
})();
