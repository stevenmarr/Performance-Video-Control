'use strict';
// Draws a status board from the JSON the server sends. Text only: a tile
// label can never become HTML.
(function (root) {
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null && text !== '') node.textContent = text;
    return node;
  }

  function renderTile(tile) {
    const node = el('article', `st-tile type-${tile.type} warn-${tile.warn || 'none'}${tile.live ? ' is-live' : ''}`);
    node.dataset.id = tile.id || '';
    node.style.setProperty('--fs', `${Number(tile.fontSize) || 48}px`);
    node.style.gridColumn = `${(tile.col || 0) + 1} / span ${tile.w || 1}`;
    node.style.gridRow = `${(tile.row || 0) + 1} / span ${tile.h || 1}`;
    if (tile.background) node.style.background = tile.background;
    node.appendChild(el('div', 'st-label', tile.label || ''));
    if (tile.kicker) node.appendChild(el('div', 'st-kicker', tile.kicker));
    const listed = tile.type === 'preset' || tile.type === 'tally' || (tile.type === 'online' && tile.items && tile.items.length);
    if (!listed) {
      const primary = el('div', tile.type === 'countdown' || tile.type === 'timer' ? 'st-primary remain' : 'st-primary', tile.primary || '');
      if (tile.color && (!tile.warn || tile.warn === 'ok' || tile.warn === 'none')) primary.style.color = tile.color;
      node.appendChild(primary);
    }
    if (tile.type === 'preset') node.appendChild(presetList(tile.items));
    else if (tile.type === 'tally') node.appendChild(tallyList(tile.items));
    else if (tile.type === 'online' && tile.items && tile.items.length) node.appendChild(onlineList(tile.items));
    if (tile.secondary) node.appendChild(el('div', 'st-secondary', tile.secondary));
    if (tile.note) node.appendChild(el('div', 'st-note', tile.note));
    return node;
  }

  function presetList(items) {
    const wrap = el('div', 'st-roles');
    const labels = { program: 'ON PROGRAM', preview: 'PREVIEW', standby: 'STANDBY' };
    const rows = items || [];
    if (!rows.length) {
      wrap.appendChild(el('div', 'st-role', 'Nothing on program'));
      return wrap;
    }
    for (const role of ['program', 'preview', 'standby']) {
      const group = rows.filter((row) => row.role === role);
      if (!group.length) continue;
      const row = el('div', `st-role ${role}`);
      row.appendChild(el('div', 'k', labels[role]));
      row.appendChild(el('div', 'v', group.map((item) => item.name).join(' · ')));
      wrap.appendChild(row);
    }
    return wrap;
  }

  function tallyList(items) {
    const wrap = el('div', 'st-cams');
    if (!items || !items.length) {
      wrap.appendChild(el('div', 'st-note', 'No tally'));
      return wrap;
    }
    for (const cam of items) {
      const card = el('div', `st-cam${cam.live ? ' live' : cam.preview ? ' preview' : ''}`);
      if (cam.live) card.appendChild(el('span', 'live-badge', 'LIVE'));
      else if (cam.preview) card.appendChild(el('span', 'pvw-badge', 'PREVIEW'));
      card.appendChild(el('div', 'cam-name', cam.name || ''));
      if (cam.meta) card.appendChild(el('div', 'cam-meta', cam.meta));
      wrap.appendChild(card);
    }
    return wrap;
  }

  function onlineList(items) {
    const wrap = el('div', 'st-lines');
    for (const row of items) {
      const line = el('div', `st-line${row.online ? ' on' : ''}`);
      line.appendChild(el('span', 'dot'));
      line.appendChild(el('span', 'nm', row.name || ''));
      line.appendChild(el('span', 'st', row.stateText || (row.online ? 'ONLINE' : 'OFFLINE')));
      if (row.ip) line.appendChild(el('span', 'ip', row.ip));
      if (row.age) line.appendChild(el('span', 'age', row.age));
      if (row.record) line.appendChild(el('span', 'chip rec', 'REC'));
      if (row.stream) line.appendChild(el('span', 'chip', 'STREAM'));
      wrap.appendChild(line);
    }
    return wrap;
  }

  function renderBoard(mount, board) {
    mount.textContent = '';
    if (!board || board.missing) {
      const p = el('p', 'st-missing', board && board.name
        ? `No layout named ${board.name}. Saved layouts: ${(board.names || []).join(', ') || 'none'}.`
        : 'No layout yet. Open /status/config to make one.');
      mount.appendChild(p);
      return;
    }
    for (const tile of board.tiles || []) mount.appendChild(renderTile(tile));
  }

  function coverage(mount, board) {
    mount.textContent = '';
    const notes = board && board.coverage && board.coverage.notYet && board.coverage.notYet.length;
    if (!notes || !board.layout || board.layout.notes === false) return;
    const details = el('details', 'st-coverage');
    details.appendChild(el('summary', '', 'What this screen cannot see yet'));
    const ul = el('ul');
    for (const line of board.coverage.notYet) ul.appendChild(el('li', '', line));
    details.appendChild(ul);
    mount.appendChild(details);
  }

  root.StatusView = { renderBoard, renderTile, coverage };
})(typeof window !== 'undefined' ? window : global);
