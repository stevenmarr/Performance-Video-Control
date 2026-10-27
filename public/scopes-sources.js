// Scopes source menu. Desktop Video first. Empty legacy NDI is omitted.
// Shared with Node tests (module.exports). No mock-fixture group.
(function (root) {
  'use strict';
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function partitionSources(sources) {
    const list = Array.isArray(sources) ? sources : [];
    return {
      decklink: list.filter((s) => s && s.via === 'decklink'),
      sidecar: list.filter((s) => s && s.kind === 'ndi' && s.via === 'sidecar'),
      camera: list.filter((s) => s && s.kind === 'camera'),
      other: list.filter((s) => s && s.kind !== 'ndi' && s.kind !== 'camera'),
    };
  }
  function sourceGroups(sources) {
    const p = partitionSources(sources);
    return [
      { label: 'Desktop Video', items: p.decklink, empty: 'No Desktop Video input on this Mac.' },
      { label: 'Cameras', items: p.camera, empty: '' },
      { label: 'Test clips and custom', items: p.other, empty: '' },
      { label: 'NDI (advanced)', items: p.sidecar, empty: '' },
    ];
  }
  function sourceMenu(sources) {
    const html = sourceGroups(sources).map((b) => {
      if (!b.items.length && !b.empty) return '';
      const opts = b.items.map((s) => `<option value="${esc(s.key)}" ${s.ok ? '' : 'data-noh264="1"'}>${esc(s.label)}${s.ok ? '' : ' — JPEG only'}</option>`).join('');
      const hole = !b.items.length ? `<option disabled value="">${esc(b.empty)}</option>` : '';
      return `<optgroup label="${esc(b.label)}">${opts}${hole}</optgroup>`;
    }).join('');
    return html || '<option value="">no sources</option>';
  }
  function preferLiveSource(sources) {
    const list = Array.isArray(sources) ? sources : [];
    return list.find((s) => s && s.via === 'decklink' && s.ok)
      || list.find((s) => s && s.via === 'sidecar' && s.ok)
      || null;
  }
  const api = { partitionSources, sourceGroups, sourceMenu, preferLiveSource };
  root.ScopesSources = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
