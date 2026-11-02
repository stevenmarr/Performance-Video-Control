'use strict';
// Cue run state. Pure and synchronous: send() either returns a new state or the
// same object when the event is ignored. An ignored event does not copy the
// state, does not bump generation, and is the whole of the "no side effects" lock.
//
// States: idle, loaded, running, failed.
// Running phases: take, then go (the timeline mark), then post.
// Events: load, run, enterGo, enterPost, timelineDone, externalPresetTake,
// cancel, fail, ack.

function createCueMachine() {
  return {
    state: 'idle',
    phase: null,
    cueId: null,
    error: null,
    locked: false,
    generation: 0,
  };
}

function idle(generation) {
  return { state: 'idle', phase: null, cueId: null, error: null, locked: false, generation };
}

function send(machine, event) {
  const state = machine || createCueMachine();
  const type = event && event.type;
  if (type === 'load') {
    if (state.state === 'running') return { state, ignored: true };
    const cueId = event.cueId ? String(event.cueId) : '';
    if (!cueId) return { state, ignored: true };
    if (state.state === 'loaded' && state.cueId === cueId && !state.error) return { state, ignored: true };
    return {
      state: { state: 'loaded', phase: null, cueId, error: null, locked: false, generation: state.generation },
      ignored: false,
    };
  }
  if (type === 'run') {
    // A second run while a timeline is in progress is the lock. Same object back.
    if (state.state === 'running' || state.state === 'failed') return { state, ignored: true };
    const cueId = event.cueId ? String(event.cueId) : (state.cueId || '');
    if (!cueId) return { state, ignored: true };
    return {
      state: {
        state: 'running',
        phase: 'take',
        cueId,
        error: null,
        locked: true,
        generation: state.generation + 1,
      },
      ignored: false,
    };
  }
  if (type === 'enterGo') {
    if (state.state !== 'running' || state.phase !== 'take') return { state, ignored: true };
    return { state: { ...state, phase: 'go' }, ignored: false };
  }
  if (type === 'enterPost') {
    if (state.state !== 'running' || (state.phase !== 'go' && state.phase !== 'take')) return { state, ignored: true };
    return { state: { ...state, phase: 'post' }, ignored: false };
  }
  if (type === 'timelineDone') {
    if (state.state !== 'running') return { state, ignored: true };
    if (event.stacked && event.nextCueId) {
      return {
        state: {
          state: 'loaded',
          phase: null,
          cueId: String(event.nextCueId),
          error: null,
          locked: false,
          generation: state.generation + 1,
        },
        ignored: false,
      };
    }
    return { state: idle(state.generation + 1), ignored: false };
  }
  if (type === 'fail') {
    if (state.state !== 'running') return { state, ignored: true };
    return {
      state: {
        state: 'failed',
        phase: null,
        cueId: state.cueId,
        error: String(event.error || 'Action failed').slice(0, 240),
        locked: false,
        generation: state.generation + 1,
      },
      ignored: false,
    };
  }
  if (type === 'ack') {
    if (state.state !== 'failed') return { state, ignored: true };
    if (event.unload || !state.cueId) return { state: idle(state.generation), ignored: false };
    return {
      state: { state: 'loaded', phase: null, cueId: state.cueId, error: null, locked: false, generation: state.generation },
      ignored: false,
    };
  }
  if (type === 'externalPresetTake' || type === 'cancel') {
    if (state.state === 'idle') return { state, ignored: true };
    return { state: idle(state.generation + 1), ignored: false };
  }
  return { state, ignored: true };
}

module.exports = { createCueMachine, send };
