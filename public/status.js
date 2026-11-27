'use strict';
// Read-only status wall. It listens for snapshots and draws them. It never
// sends a command to a switcher, a player, a camera, or Companion.
(function () {
  const params = new URLSearchParams(location.search);
  const layout = params.get('layout') || '';
  const linkPill = document.getElementById('linkPill');
  const companionPill = document.getElementById('companionPill');
  const editLink = document.getElementById('editLink');
  let socket = null;
  let wait = 1000;
  let poll = null;
  let opened = false;

  function query() {
    return layout ? `?layout=${encodeURIComponent(layout)}` : '';
  }

  function setLink(live) {
    linkPill.textContent = live ? 'LIVE' : 'RECONNECTING';
    linkPill.className = live ? 'pill live' : 'pill wait';
  }

  function show(board) {
    if (!board) return;
    StatusView.renderBoard(document.getElementById('board'), board);
    StatusView.coverage(document.getElementById('coverage'), board);
    const name = board.layout && board.layout.name;
    document.getElementById('layoutName').textContent = name || '';
    document.title = name ? `${name} · Status` : 'Status · Control Center';
    const link = board.companion || {};
    const up = !!(link.httpOnline || link.wsOnline);
    companionPill.textContent = up ? (link.wsOnline ? 'COMPANION LIVE' : 'COMPANION') : 'COMPANION OFF';
    companionPill.className = up ? 'pill live' : 'pill off';
    if (board.layout && board.layout.editLink === false) editLink.hidden = true;
    else {
      editLink.hidden = false;
      editLink.href = `/status/config${query()}`;
    }
  }

  async function pull() {
    try {
      const res = await fetch(`/api/status${query()}`, { cache: 'no-store' });
      show(await res.json());
      if (!opened) setLink(true);
    } catch {
      setLink(false);
    }
  }

  function startPoll() {
    if (poll) return;
    poll = setInterval(pull, 3000);
    pull();
  }

  function stopPoll() {
    clearInterval(poll);
    poll = null;
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${proto}//${location.host}/status/ws${query()}`);
    socket.onopen = () => { opened = true; wait = 1000; setLink(true); stopPoll(); };
    socket.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg && msg.board) show(msg.board);
      } catch { /* ignore a bad frame */ }
    };
    socket.onclose = () => {
      opened = false;
      setLink(false);
      startPoll();
      setTimeout(connect, wait);
      wait = Math.min(wait * 2, 10000);
    };
  }

  connect();
})();
