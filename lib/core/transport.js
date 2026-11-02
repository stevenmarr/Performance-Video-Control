'use strict';
// Transport for record / play. Plain values (a fader, a crosspoint) do not use this.
// States: stopped, playing, paused, recording.
// Events: play, pause, stop, record, toggle.
// An ignored event returns the same object. The device command is not sent by this file.

function createTransport() {
  return { state: 'stopped', generation: 0, history: [] };
}

function remember(machine, from, to, event) {
  const history = machine.history.concat({ t: new Date().toISOString(), from, to, event });
  return { state: to, generation: machine.generation + 1, history: history.length > 40 ? history.slice(-40) : history };
}

function send(machine, event) {
  const current = machine || createTransport();
  const type = typeof event === 'string' ? event : (event && event.type);
  const from = current.state;
  let to = null;
  if (type === 'play') {
    if (from === 'recording') return { machine: current, changed: false, from, to: from, event: type };
    to = 'playing';
  } else if (type === 'pause') {
    if (from !== 'playing') return { machine: current, changed: false, from, to: from, event: type };
    to = 'paused';
  } else if (type === 'stop') {
    to = 'stopped';
  } else if (type === 'record') {
    if (from === 'playing') return { machine: current, changed: false, from, to: from, event: type };
    to = 'recording';
  } else if (type === 'toggle') {
    if (from === 'playing') to = 'paused';
    else if (from === 'recording') to = 'stopped';
    else to = 'playing';
  } else {
    return { machine: current, changed: false, from, to: from, event: type || '' };
  }
  if (to === from) return { machine: current, changed: false, from, to, event: type };
  return { machine: remember(current, from, to, type), changed: true, from, to, event: type };
}

module.exports = { createTransport, send };
