'use strict';
// Macro run. The switcher is the authority: mirror() follows a command that already
// succeeded, even if a strict send() would have ignored it. send() is the gate for
// our own runners (the cue machine stays in lib/cue-machine.js).
// States: idle, running, waiting, stopped.

function createMacro() {
  return { state: 'idle', generation: 0, history: [] };
}

function nextOf(from, type) {
  if (type === 'run' && (from === 'idle' || from === 'stopped')) return 'running';
  if (type === 'wait' && from === 'running') return 'waiting';
  if (type === 'continue' && from === 'waiting') return 'running';
  if (type === 'stop' && (from === 'running' || from === 'waiting')) return 'stopped';
  if ((type === 'done' || type === 'fail') && (from === 'running' || from === 'waiting' || from === 'stopped')) return 'idle';
  return null;
}

function apply(machine, type, forced) {
  const current = machine || createMacro();
  const from = current.state;
  const to = nextOf(from, type);
  if (!to) {
    if (!forced) return { machine: current, changed: false, from, to: from, event: type, forced: false };
    const forceTo = { run: 'running', wait: 'waiting', continue: 'running', stop: 'stopped', done: 'idle', fail: 'idle' }[type];
    if (!forceTo || forceTo === from) return { machine: current, changed: false, from, to: from, event: type, forced: true };
    return finish(current, from, forceTo, type, true);
  }
  return finish(current, from, to, type, false);
}

function finish(machine, from, to, event, forced) {
  const history = machine.history.concat({ t: new Date().toISOString(), from, to, event, forced });
  return {
    machine: { state: to, generation: machine.generation + 1, history: history.length > 40 ? history.slice(-40) : history },
    changed: true, from, to, event, forced,
  };
}

function send(machine, event) {
  const type = typeof event === 'string' ? event : (event && event.type);
  return apply(machine, type, false);
}

function mirror(machine, event) {
  const type = typeof event === 'string' ? event : (event && event.type);
  return apply(machine, type, true);
}

// Map an ATEM command name onto a macro event. Unknown names return ''.
function eventForAtem(name) {
  if (name === 'macroRun' || name === 'macroRecord') return 'run';
  if (name === 'macroUserWait') return 'wait';
  if (name === 'macroContinue') return 'continue';
  if (name === 'macroStop' || name === 'macroStopRecord') return 'stop';
  return '';
}

module.exports = { createMacro, send, mirror, eventForAtem };
