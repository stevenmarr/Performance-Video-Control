'use strict';
// TSL 5.0 tally map on the ATEM page: ATEM sources → TSL IP and port.
// Separate from Scopes. Desktop Video ingest is an input on the SCOPES tab. Lightning is a scope mode.
(() => {
  const $ = (s) => document.querySelector(s);
  const CC = window.CC;
  if (!$('#tslPanel') || !CC) return;
  let cfg = null;
  const api = (method, path, body) => CC.api(method, path, body);

  const esc = CC.esc || ((s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  function instOptions(type, selected, fallbackId, fallbackName) {
    const st = window.CCSYS && window.CCSYS.state && window.CCSYS.state();
    const list = ((st && st.instances) || []).filter((i) => i.type === type && i.armed);
    const rows = list.length ? list : [{ id: fallbackId, name: fallbackName }];
    const cur = selected || fallbackId;
    return rows.map((i) => `<option value="${i.id}" ${i.id === cur ? 'selected' : ''}>${esc(i.name || i.id)}</option>`).join('');
  }
  function atemOptions(selected) { return instOptions('atem', selected, 'atem', 'ATEM'); }
  function ptzOptions(selected) { return instOptions('ptz', selected, 'ptz', 'PTZ'); }
  function rowHtml(a, i) {
    const atem = (a.sources || []).find((s) => s.system === 'atem');
    const ptz = (a.sources || []).find((s) => s.system === 'ptz');
    return `<tr data-i="${i}">
      <td><input class="tsl-idx" type="number" min="0" max="65534" value="${a.index}"></td>
      <td><input class="tsl-lab" maxlength="16" value="${esc(a.label || '')}"></td>
      <td><select class="tsl-inst">${atemOptions(atem && atem.instance)}</select></td>
      <td><input class="tsl-atem" type="number" min="0" max="65535" placeholder="—" value="${atem ? atem.input : ''}"></td>
      <td><select class="tsl-ptzinst">${ptzOptions(ptz && ptz.instance)}</select></td>
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
      const inst = tr.querySelector('.tsl-inst') && tr.querySelector('.tsl-inst').value;
      if (ai !== '') sources.push({ system: 'atem', input: Number(ai), ...(inst && inst !== 'atem' ? { instance: inst } : {}) });
      const cam = tr.querySelector('.tsl-ptz').value.trim();
      const ptzInst = tr.querySelector('.tsl-ptzinst') && tr.querySelector('.tsl-ptzinst').value;
      if (cam) sources.push({ system: 'ptz', cameraId: cam, ...(ptzInst && ptzInst !== 'ptz' ? { instance: ptzInst } : {}) });
      return { index, label, sources };
    });
  }

  function rxId() {
    return `tsl-${Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(2, 8)}`;
  }
  function readReceivers() {
    const first = {
      id: 'tsl',
      name: ($('#tslName') && $('#tslName').value.trim()) || 'TSL',
      host: $('#tslHost').value.trim() || '127.0.0.1',
      port: Number($('#tslPort').value) || 8900,
    };
    const rest = [...document.querySelectorAll('#tslRxs .tsl-rx')].map((row) => ({
      id: row.dataset.id,
      name: row.querySelector('.tsl-rx-name').value.trim() || 'TSL',
      host: row.querySelector('.tsl-rx-host').value.trim() || '127.0.0.1',
      port: Number(row.querySelector('.tsl-rx-port').value) || 8900,
    }));
    return [first, ...rest];
  }
  function paintReceivers(list) {
    const box = $('#tslRxs'); if (!box) return;
    const extra = (list || []).filter((r) => r.id && r.id !== 'tsl');
    box.innerHTML = extra.map((r) => `<div class="tsl-row tsl-rx${r.duplicate ? ' dup' : ''}" data-id="${esc(r.id)}">
      <label>Name <input class="tsl-rx-name" maxlength="40" value="${esc(r.name || '')}"></label>
      <label>Host <input class="tsl-rx-host" value="${esc(r.host || '')}" spellcheck="false" autocomplete="off"></label>
      <label>Port <input class="tsl-rx-port" type="number" min="1" max="65535" value="${r.port || 8900}"></label>
      ${r.duplicate ? '<span class="dup-flag">DUPLICATE IP</span>' : ''}
      <button type="button" class="btn mini danger tsl-rx-del">REMOVE</button>
    </div>`).join('');
  }

  function paint(st) {
    cfg = st;
    $('#tslEnabled').checked = !!st.enabled;
    $('#tslFollowPtz').checked = !!st.followPtz;
    $('#tslTransport').value = st.transport === 'udp' ? 'udp' : 'mock';
    const first = ((st.receivers || []).find((r) => r.id === 'tsl')) || { name: 'TSL', host: st.host, port: st.port };
    if ($('#tslName')) $('#tslName').value = first.name || 'TSL';
    $('#tslHost').value = first.host || st.host || '127.0.0.1';
    $('#tslPort').value = first.port || st.port || 8900;
    paintReceivers(st.receivers || []);
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
        receivers: readReceivers(),
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
  const addRx = $('#tslAddRx');
  if (addRx) addRx.addEventListener('click', () => {
    const box = $('#tslRxs');
    const row = document.createElement('div');
    row.className = 'tsl-row tsl-rx';
    row.dataset.id = rxId();
    row.innerHTML = `<label>Name <input class="tsl-rx-name" maxlength="40" value="TSL ${box.children.length + 2}"></label>
      <label>Host <input class="tsl-rx-host" value="127.0.0.1" spellcheck="false" autocomplete="off"></label>
      <label>Port <input class="tsl-rx-port" type="number" min="1" max="65535" value="8901"></label>
      <button type="button" class="btn mini danger tsl-rx-del">REMOVE</button>`;
    box.appendChild(row);
  });
  const rxs = $('#tslRxs');
  if (rxs) rxs.addEventListener('click', (ev) => {
    const b = ev.target.closest('.tsl-rx-del'); if (!b) return;
    b.closest('.tsl-rx').remove();
  });

  window.addEventListener('cc:tab', (ev) => { if (ev.detail === 'atem') load(); });
  if (CC.getTab && CC.getTab() === 'atem') load();
})();
