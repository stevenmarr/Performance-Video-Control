'use strict';
// TSL 5.0 tally map. SYSTEMS → TALLIES only. Not part of Lightning.
(() => {
  const $ = (s) => document.querySelector(s);
  const CC = window.CC;
  if (!$('#tslPanel') || !CC) return;
  let cfg = null;
  const api = (method, path, body) => CC.api(method, path, body);

  function rowHtml(a, i) {
    const atem = (a.sources || []).find((s) => s.system === 'atem');
    const ptz = (a.sources || []).find((s) => s.system === 'ptz');
    return `<tr data-i="${i}">
      <td><input class="tsl-idx" type="number" min="0" max="65534" value="${a.index}"></td>
      <td><input class="tsl-lab" maxlength="16" value="${(CC.esc || ((s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))))(a.label || '')}"></td>
      <td><input class="tsl-atem" type="number" min="0" max="65535" placeholder="—" value="${atem ? atem.input : ''}"></td>
      <td><input class="tsl-ptz" placeholder="cam1" value="${ptz ? ptz.cameraId : ''}"></td>
      <td><button type="button" class="btn mini danger tsl-del" title="Remove">✕</button></td>
    </tr>`;
  }

  function readTable() {
    return [...document.querySelectorAll('#tslTable tbody tr')].map((tr) => {
      const index = Number(tr.querySelector('.tsl-idx').value);
      const label = tr.querySelector('.tsl-lab').value;
      const sources = [];
      const ai = tr.querySelector('.tsl-atem').value;
      if (ai !== '') sources.push({ system: 'atem', input: Number(ai) });
      const cam = tr.querySelector('.tsl-ptz').value.trim();
      if (cam) sources.push({ system: 'ptz', cameraId: cam });
      return { index, label, sources };
    });
  }

  function paint(st) {
    cfg = st;
    $('#tslEnabled').checked = !!st.enabled;
    $('#tslFollowPtz').checked = !!st.followPtz;
    $('#tslTransport').value = st.transport === 'udp' ? 'udp' : 'mock';
    $('#tslHost').value = st.host || '127.0.0.1';
    $('#tslPort').value = st.port || 8900;
    $('#tslTable tbody').innerHTML = (st.addresses || []).map(rowHtml).join('') || '';
    const lines = (st.last || []).map((p) => `${p.at}  #${p.index}  lh=${p.lh} rh=${p.rh}  ${p.via}  ${p.hex.slice(0, 48)}${p.hex.length > 48 ? '…' : ''}`);
    $('#tslLog').textContent = lines.join('\n') || '(no packets yet — enable sender and change ATEM PGM/PVW, or SEND NOW)';
  }

  async function load() {
    try { paint(await api('GET', '/api/tsl')); } catch (e) { $('#tslMsg').textContent = e.message || String(e); }
  }

  async function save() {
    $('#tslMsg').textContent = 'Saving…';
    try {
      const body = {
        enabled: $('#tslEnabled').checked,
        followPtz: $('#tslFollowPtz').checked,
        transport: $('#tslTransport').value,
        host: $('#tslHost').value.trim() || '127.0.0.1',
        port: Number($('#tslPort').value) || 8900,
        addresses: readTable(),
      };
      paint(await api('POST', '/api/tsl', body));
      $('#tslMsg').textContent = 'Saved';
    } catch (e) { $('#tslMsg').textContent = e.message || String(e); }
  }

  $('#tslSave').addEventListener('click', save);
  $('#tslTick').addEventListener('click', async () => {
    try { await save(); const r = await api('POST', '/api/tsl/tick'); paint(r.status || await api('GET', '/api/tsl')); $('#tslMsg').textContent = r.unchanged ? 'Unchanged' : `Sent ${r.packets || 0}`; }
    catch (e) { $('#tslMsg').textContent = e.message || String(e); }
  });
  $('#tslAdd').addEventListener('click', () => {
    const addrs = readTable();
    const next = addrs.length ? Math.max(...addrs.map((a) => a.index)) + 1 : 1;
    addrs.push({ index: next, label: `CAM ${next}`, sources: [{ system: 'atem', input: next }] });
    $('#tslTable tbody').innerHTML = addrs.map(rowHtml).join('');
  });
  $('#tslTable').addEventListener('click', (ev) => {
    const b = ev.target.closest('.tsl-del'); if (!b) return;
    b.closest('tr').remove();
  });

  const desk = $('#sysDesk');
  const tallies = $('#sysTallies');
  function show(view) {
    const onTallies = view === 'tallies';
    if (desk) desk.hidden = onTallies;
    if (tallies) tallies.hidden = !onTallies;
    document.querySelectorAll('#sysViews [data-sysview]').forEach((b) => b.classList.toggle('active', b.dataset.sysview === (onTallies ? 'tallies' : 'desk')));
    if (onTallies) load();
  }
  const views = $('#sysViews');
  if (views) views.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-sysview]'); if (!b) return;
    show(b.dataset.sysview);
  });

  window.addEventListener('cc:tab', (ev) => { if (ev.detail === 'system') { show('desk'); load(); } });
  if (CC.getTab && CC.getTab() === 'system') load();
})();
