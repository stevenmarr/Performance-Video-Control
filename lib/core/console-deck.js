'use strict';
// Console keys a Stream Deck can bind. Each action is POST /api/core/cmd/<id>.
// feedback is a flat id from os.feedbacks().flat. The USB face and the page
// library both use these cells.

const post = (action, body) => ({ method: 'POST', path: `/api/core/cmd/${action}`, body: body || {} });

function mainCells() {
  return [
    { label: 'SAVE', caption: 'SHOW', action: post('show.save'), feedback: 'show.name', role: 'show.save' },
    { label: 'STAGE', caption: 'SHOW', action: post('show.stage'), feedback: 'show.staged', role: 'show.stage' },
    { label: 'LOAD', caption: '2-HIT', action: post('show.load'), feedback: 'show.dirty', role: 'show.load' },
    { label: 'FOCUS', caption: 'NEXT', action: post('focus.next'), feedback: 'focus.name', role: 'focus.next' },
    { label: 'RECONN', caption: 'LINK', action: post('connection.reconnect'), feedback: 'focus.fsm', role: 'connection.reconnect' },
    { label: 'HEALTH', caption: 'ACK', action: post('health.ack'), feedback: 'health.alert', role: 'health.ack' },
    { label: 'SAFE', caption: 'MODE', action: post('panel.safe'), feedback: 'panel.safe', role: 'panel.safe' },
    { label: 'LOCK', caption: 'PANEL', action: post('panel.lock'), feedback: 'panel.locked', role: 'panel.lock' },
    { label: 'TIMER', caption: 'SPKR', action: post('service.refresh'), feedback: 'service.speakerTimer', role: 'service.speakerTimer' },
    { label: 'SMB', caption: 'SHARE', action: post('service.refresh'), feedback: 'service.smb', role: 'service.smb' },
    { label: 'COMP', caption: 'NION', action: post('service.refresh'), feedback: 'service.companion', role: 'service.companion' },
    { label: 'RESTART', caption: 'MOD', action: post('module.restart'), feedback: 'focus.fsm', role: 'module.restart' },
  ];
}

function powerCells() {
  return [
    { label: 'CANCEL', caption: 'POWER', action: post('host.cancel'), feedback: 'host.pending', role: 'host.cancel' },
    { label: 'REBOOT', caption: '2-HIT', action: post('host.reboot'), feedback: 'host.pending', role: 'host.reboot' },
    { label: 'SHUTDN', caption: '2-HIT', action: post('host.shutdown'), feedback: 'host.pending', role: 'host.shutdown' },
    { label: 'UNLOCK', caption: 'PIN', action: post('panel.unlock'), feedback: 'panel.locked', role: 'panel.unlock' },
    { label: 'P.SAVE', caption: 'PROF', action: post('profile.save'), feedback: 'profile.name', role: 'profile.save' },
  ];
}

function textOf(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'boolean') return value ? 'ON' : 'OFF';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    if (value.state) return String(value.state).toUpperCase();
    if (value.text) return String(value.text).slice(0, 12);
    return '';
  }
  return String(value).slice(0, 12);
}

function stampConsole(keys, flat) {
  const map = flat || {};
  return (keys || []).map((key) => {
    if (!key || !key.feedback) return key;
    const value = map[key.feedback];
    const caption = textOf(value);
    if (!caption) return key;
    const alert = key.feedback === 'health.alert' && Number(value) > 0;
    const bad = value === 'failed' || value === 'down' || value === true && key.feedback === 'panel.locked';
    return { ...key, caption: caption.slice(0, 12), on: alert || bad || value === 'connected' || value === 'up' };
  });
}

module.exports = { mainCells, powerCells, stampConsole, post };
