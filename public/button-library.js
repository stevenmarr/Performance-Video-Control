'use strict';
// BUTTONS, under Control Devices. Creates library buttons through the Step 1
// routes. Placement is the PAGES page, not this one.
(() => {
  const root = document.querySelector('#buttonRoot');
  if (!root || !window.CC) return;
  const { api, toast, run, esc } = window.CC;
  const ROLE_LABEL = { program: 'Program', preview: 'Preview', hot: 'Hot', shift: 'Shift', memory: 'Memory', macro: 'Macro', nav: 'Nav', tab: 'Tab', info: 'Info', toggle: 'Toggle' };
  const ELEMENT_LABEL = { button: 'Key', encoder: 'Encoder', 'touch-segment': 'Touch segment' };
  const EVENT_LABEL = { press: 'Press', release: 'Release', hold: 'Hold', turn: 'Turn', push: 'Push', touch: 'Touch' };
  const SEED = {
    program: [{ when: 'onProgram', style: { bgcolor: '#ff2d2d', color: '#ffffff' } }],
    preview: [{ when: 'onPreview', style: { bgcolor: '#3DDC84', color: '#06210f' } }],
    hot: [{ when: 'transition', style: { bgcolor: '#ff6b6b' } }],
    shift: [{ when: 'shift', style: { bgcolor: '#E0B030', color: '#1a1404' } }],
  };
  const TEMPLATES = [
    { name: 'Program', role: 'program', text: '$(atem:name)' },
    { name: 'Preview', role: 'preview', text: '$(atem:name)' },
    { name: 'CUT', role: 'hot', text: 'CUT', actions: { press: [{ action: 'atem.cut' }] } },
    { name: 'TRANS', role: 'hot', text: 'TRANS', actions: { press: [{ action: 'atem.auto' }] } },
    { name: 'Shift', role: 'shift', text: 'SHIFT' },
    { name: 'Memory', role: 'memory', text: 'MEM' },
    { name: 'Macro', role: 'macro', text: 'MACRO' },
  ];

  let catalog = { actions: [], roles: Object.keys(ROLE_LABEL), elements: ['button', 'encoder', 'touch-segment'], events: { button: ['press', 'release', 'hold'], encoder: ['turn', 'push'], 'touch-segment': ['touch'] }, flags: ['onProgram', 'onPreview', 'transition', 'shift', 'bankOn', 'held'] };
  let buttons = [];
  let selected = '';
  let flags = {};
  let confirmDelete = false;
  let loaded = false;

  const same = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);
  const byId = (id) => buttons.find((b) => b.id === id);
  const eventsOf = (element) => (catalog.events && catalog.events[element]) || [];

  function draftFrom(template) {
    const role = template.role;
    return {
      name: template.name,
      role,
      element: 'button',
      text: template.text || '',
      title: '',
      caption: '',
      style: {},
      target: { mode: 'follow', system: '', instance: '' },
      actions: template.actions || {},
      feedbacks: (SEED[role] || []).map((f) => ({ when: f.when, style: { ...f.style } })),
      template: template.name.toLowerCase(),
    };
  }

  function paintList() {
    const list = root.querySelector('#blList');
    if (!list) return;
    list.innerHTML = buttons.length ? buttons.map((b) => `<button type="button" class="deck-page${b.id === selected ? ' on' : ''}" data-pick="${esc(b.id)}"><b>${esc(b.name)}</b><small>${esc(ROLE_LABEL[b.role] || b.role)} · ${esc(ELEMENT_LABEL[b.element] || b.element)}</small></button>`).join('') : '<p class="note">No buttons yet. Start with Program or CUT.</p>';
  }

  function optionHtml(selectedId) {
    const groups = [];
    for (const action of catalog.actions) {
      let g = groups.find((x) => x.name === action.group);
      if (!g) { g = { name: action.group, items: [] }; groups.push(g); }
      g.items.push(action);
    }
    return groups.map((g) => `<optgroup label="${esc(g.name)}">${g.items.map((a) => `<option value="${esc(a.id)}"${a.id === selectedId ? ' selected' : ''}>${esc(a.label)} · ${esc(a.id)}${a.bound ? '' : ' · page'}</option>`).join('')}</optgroup>`).join('');
  }

  function actionBound(id) {
    const hit = catalog.actions.find((a) => a.id === id);
    return hit ? hit.bound : false;
  }

  async function refreshPreview() {
    const box = root.querySelector('#blPreview');
    const button = byId(selected);
    if (!box || !button) return;
    try {
      const pic = await api('POST', '/api/buttons/preview', { button, flags });
      box.innerHTML = pic.svg || '';
    } catch (e) {
      box.textContent = e.message;
    }
  }

  function paint() {
    const button = byId(selected);
    const starters = TEMPLATES.map((t) => `<button type="button" class="btn mini" data-new="${esc(t.name)}">${esc(t.name === 'Shift' ? 'Shift' : t.name)}</button>`).join('');
    const editor = button ? editorHtml(button) : '<p class="note">Select a button, or create one. Slots are assigned on PAGES.</p>';
    root.innerHTML = `<div class="btn-editor">
      <div class="deck-list">
        <div class="deck-pick">${starters}</div>
        <div id="blList" class="deck-pages"></div>
      </div>
      <div class="deck-stage">${editor}</div>
    </div>`;
    paintList();
    refreshPreview();
  }

  function editorHtml(button) {
    const roles = (catalog.roles || []).map((r) => `<option value="${esc(r)}"${r === button.role ? ' selected' : ''}>${esc(ROLE_LABEL[r] || r)}</option>`).join('');
    const elements = (catalog.elements || []).map((el) => `<option value="${esc(el)}"${el === button.element ? ' selected' : ''}>${esc(ELEMENT_LABEL[el] || el)}</option>`).join('');
    const style = button.style || {};
    const barMode = style.bar === null ? 'none' : (typeof style.bar === 'string' && style.bar ? 'custom' : 'role');
    const target = button.target || { mode: 'follow' };
    const flagBtns = (catalog.flags || []).map((f) => `<button type="button" class="btn mini${flags[f] ? ' on' : ''}" data-flag="${esc(f)}">${esc(f)}</button>`).join('');
    const events = eventsOf(button.element).map((ev) => eventHtml(button, ev)).join('');
    const feedbacks = (button.feedbacks || []).map((f, i) => `<div class="bl-row" data-fb="${i}"><input data-fb-when="${i}" value="${esc(f.when || '')}" placeholder="when" aria-label="When"><input data-fb-bg="${i}" value="${esc((f.style && f.style.bgcolor) || '')}" placeholder="background"><input data-fb-ink="${i}" value="${esc((f.style && f.style.color) || '')}" placeholder="text"><button type="button" class="btn mini" data-fb-del="${i}">Remove</button></div>`).join('');
    const unbound = [];
    for (const ev of eventsOf(button.element)) {
      for (const action of (button.actions && button.actions[ev]) || []) {
        if (action.action && !actionBound(action.action)) unbound.push(action.action);
      }
    }
    return `<div class="bl-head">
        <h2>${esc(button.name)}</h2>
        <span class="spacer"></span>
        <button type="button" class="btn mini" id="blDup">Duplicate</button>
        <button type="button" class="btn mini danger" id="blDel">Delete</button>
      </div>
      <p class="note" id="blAsk" ${confirmDelete ? '' : 'hidden'}>Delete ${esc(button.name)}? Slots that used it become empty. <button type="button" class="btn mini danger" id="blDelYes">Delete</button> <button type="button" class="btn mini" id="blDelNo">Cancel</button></p>
      <div class="bl-preview-row">
        <div id="blPreview" class="bl-preview" aria-label="Live preview"></div>
        <div>
          <p class="note small">Sample. $(atem:name) reads as Constellation. Flags are not saved.</p>
          <div class="deck-pick">${flagBtns}</div>
        </div>
      </div>
      <div class="bl-fields">
        <label>Name<input data-field="name" value="${esc(button.name)}"></label>
        <label>Element<select data-field="element">${elements}</select></label>
        <label>Role<select data-field="role">${roles}</select></label>
        <label>Text<input data-field="text" value="${esc(button.text || '')}" placeholder="$(atem:name)"></label>
        <label>Title<input data-field="title" value="${esc(button.title || '')}"></label>
        <label>Caption<input data-field="caption" value="${esc(button.caption || '')}"></label>
        <label>Background<input data-style="bgcolor" value="${esc(style.bgcolor || '')}" placeholder="Role default"></label>
        <label>Text color<input data-style="color" value="${esc(style.color || '')}" placeholder="Role default"></label>
        <label>Group bar<select data-bar="${esc(barMode)}">
          <option value="role"${barMode === 'role' ? ' selected' : ''}>Role default</option>
          <option value="none"${barMode === 'none' ? ' selected' : ''}>No separate bar</option>
          <option value="custom"${barMode === 'custom' ? ' selected' : ''}>Custom</option>
        </select></label>
        <label>Bar color<input data-style="bar" value="${esc(barMode === 'custom' ? style.bar : '')}" placeholder="#E0B030" ${barMode === 'custom' ? '' : 'disabled'}></label>
        <label>Border<input data-style="border" value="${esc(style.border || '')}" placeholder="None"></label>
      </div>
      <div class="deck-pick">
        <button type="button" class="btn mini${target.mode !== 'fixed' ? ' on' : ''}" data-target="follow">Follows selection</button>
        <button type="button" class="btn mini${target.mode === 'fixed' ? ' on' : ''}" data-target="fixed">Fixed instance</button>
      </div>
      ${target.mode === 'fixed' ? `<div class="bl-fields"><label>System<input data-target-system value="${esc(target.system || '')}" placeholder="atem"></label><label>Instance<input data-target-instance value="${esc(target.instance || '')}" placeholder="atem-1"></label></div>` : ''}
      <h3>Actions</h3>
      ${unbound.length ? `<p class="note">Not an OS catalog id yet: ${esc([...new Set(unbound)].join(', '))}. The press is stored. It is not sent until that id has a route.</p>` : ''}
      ${events}
      <h3>Feedbacks</h3>
      <button type="button" class="btn mini" id="blAddFb">Add feedback</button>
      ${feedbacks}
      <p class="note small">A hold does not also fire the short press. A press is not proof the device did it.</p>`;
  }

  function eventHtml(button, ev) {
    const list = (button.actions && button.actions[ev]) || [];
    const rows = list.map((action, i) => `<div class="bl-row" data-act="${esc(ev)}:${i}">
      <select data-act-id="${esc(ev)}:${i}" aria-label="Action">${optionHtml(action.action)}</select>
      <select data-act-inst="${esc(ev)}:${i}" aria-label="Instance">
        <option value=""${!action.instance ? ' selected' : ''}>Button target</option>
        <option value="$(target)"${action.instance === '$(target)' ? ' selected' : ''}>Follows selection</option>
        <option value="fixed"${action.instance && action.instance !== '$(target)' ? ' selected' : ''}>Fixed instance</option>
      </select>
      ${action.instance && action.instance !== '$(target)' ? `<input data-act-fixed="${esc(ev)}:${i}" value="${esc(action.instance)}" placeholder="instance id">` : ''}
      <button type="button" class="btn mini" data-act-del="${esc(ev)}:${i}">Remove</button>
    </div>`).join('');
    const hold = ev === 'hold' ? '<p class="note small">Hold does not also fire Press.</p>' : '';
    return `<section><h4>${esc(EVENT_LABEL[ev] || ev)}</h4>${rows}<button type="button" class="btn mini" data-act-add="${esc(ev)}">Add</button>${hold}</section>`;
  }

  async function commit(next, id) {
    buttons = next;
    if (id) selected = id;
    confirmDelete = false;
    paint();
  }

  async function create(template) {
    const body = draftFrom(template);
    const made = await api('POST', '/api/buttons', body);
    buttons = buttons.concat(made);
    selected = made.id;
    confirmDelete = false;
    paint();
    toast(`${made.name} saved`);
  }

  async function save(patch, repaint) {
    const button = byId(selected);
    if (!button) return;
    const next = { ...button, ...patch };
    if (patch.role && patch.role !== button.role && same(button.feedbacks, SEED[button.role] || [])) {
      next.feedbacks = (SEED[patch.role] || []).map((f) => ({ when: f.when, style: { ...f.style } }));
    }
    if (patch.element && patch.element !== button.element) {
      const allow = new Set(eventsOf(patch.element));
      const actions = {};
      for (const ev of Object.keys(button.actions || {})) if (allow.has(ev)) actions[ev] = button.actions[ev];
      next.actions = actions;
    }
    const saved = await api('PUT', `/api/buttons/${button.id}`, next);
    buttons = buttons.map((b) => (b.id === saved.id ? saved : b));
    if (repaint) paint();
    else { paintList(); refreshPreview(); }
  }

  root.addEventListener('click', (ev) => {
    const pick = ev.target.closest('[data-pick]');
    if (pick) { selected = pick.dataset.pick; confirmDelete = false; paint(); return; }
    const neu = ev.target.closest('[data-new]');
    if (neu) {
      const template = TEMPLATES.find((t) => t.name === neu.dataset.new);
      if (template) run(create(template));
      return;
    }
    const flag = ev.target.closest('[data-flag]');
    if (flag) { flags = { ...flags, [flag.dataset.flag]: !flags[flag.dataset.flag] }; flag.classList.toggle('on', !!flags[flag.dataset.flag]); refreshPreview(); return; }
    if (ev.target.id === 'blDup') {
      run(api('POST', `/api/buttons/${selected}/duplicate`).then((copy) => { buttons = buttons.concat(copy); selected = copy.id; paint(); toast(`${copy.name} saved`); }));
      return;
    }
    if (ev.target.id === 'blDel') { confirmDelete = true; paint(); return; }
    if (ev.target.id === 'blDelNo') { confirmDelete = false; paint(); return; }
    if (ev.target.id === 'blDelYes') {
      const id = selected;
      run(api('DELETE', `/api/buttons/${id}`).then(() => {
        buttons = buttons.filter((b) => b.id !== id);
        selected = buttons[0] ? buttons[0].id : '';
        confirmDelete = false;
        paint();
        toast('Deleted');
      }));
      return;
    }
    const target = ev.target.closest('[data-target]');
    if (target) {
      const button = byId(selected);
      if (!button) return;
      const mode = target.dataset.target;
      run(save({ target: { mode, system: mode === 'fixed' ? (button.target && button.target.system) || '' : '', instance: mode === 'fixed' ? (button.target && button.target.instance) || '' : '' } }, true));
      return;
    }
    const add = ev.target.closest('[data-act-add]');
    if (add) {
      const button = byId(selected);
      const evName = add.dataset.actAdd;
      const actions = { ...(button.actions || {}) };
      const list = (actions[evName] || []).slice();
      list.push({ action: (catalog.actions[0] && catalog.actions[0].id) || 'atem.cut' });
      actions[evName] = list;
      run(save({ actions }, true));
      return;
    }
    const del = ev.target.closest('[data-act-del]');
    if (del) {
      const [evName, index] = del.dataset.actDel.split(':');
      const button = byId(selected);
      const actions = { ...(button.actions || {}) };
      actions[evName] = (actions[evName] || []).filter((_, i) => i !== Number(index));
      run(save({ actions }, true));
      return;
    }
    if (ev.target.id === 'blAddFb') {
      const button = byId(selected);
      run(save({ feedbacks: (button.feedbacks || []).concat([{ when: '', style: {} }]) }, true));
      return;
    }
    const fbDel = ev.target.closest('[data-fb-del]');
    if (fbDel) {
      const button = byId(selected);
      const index = Number(fbDel.dataset.fbDel);
      run(save({ feedbacks: (button.feedbacks || []).filter((_, i) => i !== index) }, true));
    }
  });

  root.addEventListener('change', (ev) => {
    const t = ev.target;
    const button = byId(selected);
    if (!button) return;
    if (t.dataset.field) {
      const structural = t.dataset.field === 'role' || t.dataset.field === 'element';
      run(save({ [t.dataset.field]: t.value }, structural));
      return;
    }
    if (t.dataset.style) {
      const style = { ...(button.style || {}) };
      const key = t.dataset.style;
      if (!t.value) delete style[key];
      else style[key] = t.value;
      run(save({ style }, false));
      return;
    }
    if (t.dataset.bar !== undefined && t.tagName === 'SELECT') {
      const style = { ...(button.style || {}) };
      if (t.value === 'role') delete style.bar;
      else if (t.value === 'none') style.bar = null;
      else style.bar = typeof style.bar === 'string' && style.bar ? style.bar : '#E0B030';
      run(save({ style }, true));
      return;
    }
    if (t.dataset.targetSystem !== undefined || t.dataset.targetInstance !== undefined) {
      const cur = button.target || { mode: 'fixed', system: '', instance: '' };
      run(save({ target: { mode: 'fixed', system: t.dataset.targetSystem !== undefined ? t.value : cur.system, instance: t.dataset.targetInstance !== undefined ? t.value : cur.instance } }, false));
      return;
    }
    const act = t.dataset.actId || t.dataset.actInst;
    if (act) {
      const [evName, index] = act.split(':');
      const actions = JSON.parse(JSON.stringify(button.actions || {}));
      const row = actions[evName][Number(index)];
      if (t.dataset.actId) row.action = t.value;
      if (t.dataset.actInst) {
        if (t.value === 'fixed') row.instance = row.instance && row.instance !== '$(target)' ? row.instance : 'atem-1';
        else if (t.value) row.instance = t.value;
        else delete row.instance;
      }
      run(save({ actions }, !!t.dataset.actInst));
    }
  });

  root.addEventListener('input', (ev) => {
    const t = ev.target;
    if (!t.dataset.fbWhen && !t.dataset.fbBg && !t.dataset.fbInk && !t.dataset.actFixed && !t.dataset.field) return;
    const button = byId(selected);
    if (!button) return;
    if (t.dataset.field === 'text' || t.dataset.field === 'title' || t.dataset.field === 'caption' || t.dataset.field === 'name') {
      const patch = { [t.dataset.field]: t.value };
      if (t.dataset.field === 'name' && !t.value.trim()) return;
      run(save(patch));
      return;
    }
    if (t.dataset.actFixed) {
      const [evName, index] = t.dataset.actFixed.split(':');
      const actions = JSON.parse(JSON.stringify(button.actions || {}));
      actions[evName][Number(index)].instance = t.value;
      run(save({ actions }, false));
      return;
    }
    const index = Number(t.dataset.fbWhen || t.dataset.fbBg || t.dataset.fbInk);
    const feedbacks = (button.feedbacks || []).map((f, i) => (i === index ? { when: f.when, style: { ...(f.style || {}) } } : f));
    const row = feedbacks[index];
    if (!row) return;
    if (t.dataset.fbWhen !== undefined) row.when = t.value;
    if (t.dataset.fbBg !== undefined) { if (t.value) row.style.bgcolor = t.value; else delete row.style.bgcolor; }
    if (t.dataset.fbInk !== undefined) { if (t.value) row.style.color = t.value; else delete row.style.color; }
    run(save({ feedbacks }));
  });

  async function load() {
    const [lib, cat] = await Promise.all([api('GET', '/api/buttons'), api('GET', '/api/buttons/catalog')]);
    catalog = cat;
    buttons = lib.buttons || [];
    if (!selected || !byId(selected)) selected = buttons[0] ? buttons[0].id : '';
    loaded = true;
    paint();
  }

  window.addEventListener('cc:tab', (ev) => { if (ev.detail === 'buttons') run(load()); });
  if (window.CC.getTab && window.CC.getTab() === 'buttons') run(load());
})();
