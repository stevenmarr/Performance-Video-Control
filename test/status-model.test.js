'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const time = require('../lib/status/time');
const grid = require('../public/status-grid');
const { LayoutStore, cleanLayout } = require('../lib/status/layouts');
const { gather } = require('../lib/status/gather');
const { renderBoard } = require('../lib/status/map');

const noonChicago = Date.parse('2026-11-27T18:00:00Z');

test('timecode and time remaining', () => {
  assert.equal(time.parseTimecode('01:00:00'), 3600);
  assert.equal(time.parseTimecode('00:00:10'), 10);
  assert.equal(time.parseTimecode('12:03'), 723);
  assert.equal(time.parseTimecode('01:02:03:15', 30), 3723.5);
  assert.equal(time.parseTimecode('01:02:03.5'), 3723.5);
  assert.equal(time.remainingSeconds({ duration: '00:01:00', elapsed: '00:00:40' }), 20);
  assert.equal(time.remainingSeconds({ remaining: '00:00:09' }), 9);
  assert.equal(time.remainingSeconds({ length: 60, position: 70 }), -10);
  assert.equal(time.remainingSeconds({}), null);
});

test('amber is under 30 seconds and red is under 10, and a tile can set its own', () => {
  assert.equal(time.warnLevel(30), 'ok');
  assert.equal(time.warnLevel(29.9), 'amber');
  assert.equal(time.warnLevel(10), 'amber');
  assert.equal(time.warnLevel(9.9), 'red');
  assert.equal(time.warnLevel(0), 'red');
  assert.equal(time.warnLevel(-1), 'over');
  assert.equal(time.warnLevel(null), 'none');
  assert.equal(time.warnLevel(20, { amberSec: 15, redSec: 5 }), 'ok');
  assert.equal(time.warnLevel(12, { amberSec: 15, redSec: 5 }), 'amber');
  assert.equal(time.warnLevel(4, { amberSec: 15, redSec: 5 }), 'red');
  assert.equal(time.formatDuration(9), '0:09');
  assert.equal(time.formatDuration(65), '1:05');
  assert.equal(time.formatDuration(3723), '1:02:03');
  assert.equal(time.formatDuration(-4), '+0:04');
});

test('the house clock defaults to America/Chicago and can be 12-hour or 24-hour', () => {
  const clock = time.formatClock(noonChicago, { timeZone: 'America/Chicago', hour12: true });
  assert.match(clock.time, /12:00:00/);
  assert.match(clock.time, /PM/);
  assert.equal(clock.timeZone, 'America/Chicago');
  assert.match(clock.date, /November 27/);
  const h24 = time.formatClock(noonChicago, { timeZone: 'America/Chicago', hour12: false });
  assert.equal(/AM|PM/.test(h24.time), false);
  assert.match(h24.time, /12:00:00/);
  const fallback = time.resolveZone('Not/AZone');
  assert.equal(fallback.timeZone, 'America/Chicago');
  assert.equal(fallback.fallback, true);
});

test('a countdown aims at a clock time today in that zone', () => {
  const show = time.countdownRemaining('19:00', noonChicago, 'America/Chicago');
  assert.ok(Math.abs(show.remainingSec - 7 * 3600) < 2, show.remainingSec);
  const evening = time.countdownRemaining('7:00 PM', noonChicago, 'America/Chicago');
  assert.ok(Math.abs(evening.remainingSec - 7 * 3600) < 2, evening.remainingSec);
  const over = time.countdownRemaining('11:00 AM', noonChicago, 'America/Chicago');
  assert.ok(over.remainingSec < 0);
  assert.equal(time.countdownRemaining('not a time', noonChicago, 'America/Chicago'), null);
  const dated = time.countdownRemaining('2026-11-27T19:00:00Z', noonChicago, 'America/Chicago');
  assert.ok(Math.abs(dated.remainingSec - 3600) < 2);
});

test('tiles clamp onto the 12-column grid and a new tile takes an open spot', () => {
  const box = grid.clampTile({ col: 20, row: -3, w: 30, h: 0 });
  assert.equal(box.w, 12);
  assert.equal(box.col, 0);
  assert.equal(box.h, 1);
  assert.equal(box.row, 0);
  const tiles = [{ col: 0, row: 0, w: 6, h: 2 }];
  assert.equal(grid.overlaps(tiles), false);
  assert.deepEqual(grid.firstGap(tiles), { col: 6, row: 0, w: 4, h: 2 });
  assert.equal(grid.overlaps([{ col: 0, row: 0, w: 4, h: 2 }, { col: 2, row: 1, w: 4, h: 2 }]), true);
});

test('a layout keeps a name, and red has to be shorter than amber', () => {
  const layout = cleanLayout({
    name: 'FOH',
    tiles: [{ id: 'a', type: 'timer', label: 'Clip', col: 0, row: 0, w: 4, h: 2, warn: { amberSec: 20, redSec: 5 }, source: { kind: 'system', system: 'hyperdeck' } }],
  });
  assert.equal(layout.timeZone, 'America/Chicago');
  assert.equal(layout.hour12, true);
  assert.equal(layout.tiles[0].warn.redSec, 5);
  assert.throws(() => cleanLayout({ name: 'Bad', tiles: [{ type: 'timer', warn: { amberSec: 10, redSec: 10 } }] }), /shorter/);
  assert.throws(() => cleanLayout({ name: 'Bad', tiles: [{ type: 'launch' }] }), /does not know/);
  assert.throws(() => cleanLayout({ name: '' }), /name/);
});

test('layouts save on disk, import, and export', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-layouts-'));
  const store = new LayoutStore(dir);
  assert.ok(store.names().includes('FOH'));
  assert.ok(store.names().includes('Green room'));
  assert.ok(store.names().includes('Client'));
  const made = store.create({ name: 'Booth', tiles: [] });
  assert.equal(made.name, 'Booth');
  const again = new LayoutStore(dir);
  assert.ok(again.names().includes('Booth'));
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'status-layouts.json'), 'utf8'));
  assert.equal(file.version, 1);
  const exported = store.exportOne(made.id);
  assert.equal(exported.format, 'cc-status-layout');
  store.importBody({ format: 'cc-status-layout', layout: { ...exported.layout, name: 'Lobby', tiles: exported.layout.tiles } });
  assert.ok(store.names().includes('Lobby'));
  assert.throws(() => store.importBody({ format: 'something-else', layouts: [] }), /not a status layout/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('state mapping: program, preview, standby, tally, remaining, and a Companion variable', () => {
  const state = {
    systems: [
      {
        id: 'atem', name: 'ATEM', type: 'atem', online: true, stateText: 'ONLINE', ip: '10.0.0.8:9910', lastSeen: noonChicago - 4000,
        program: [{ name: 'Cam 1', detail: 'ME 1' }], preview: [{ name: 'Cam 2', detail: 'ME 1' }], standby: [],
        clip: 'Media Player 1', elapsedSec: 52, remainingSec: 8, transport: 'On program', playNote: '',
        record: false, stream: true, tally: [{ name: 'Cam 1', live: true, preview: false }, { name: 'Cam 2', live: false, preview: true }],
        summary: 'Cam 1',
      },
      {
        id: 'rs6', name: 'RS6', type: 'rs6', online: true, stateText: 'ONLINE', ip: '10.0.0.2', lastSeen: noonChicago,
        program: [], preview: [{ name: 'Walk-in', detail: 'Preset 1' }], standby: [{ name: 'Keynote', detail: 'Recalled, not taken' }],
        clip: '', elapsedSec: null, remainingSec: null, transport: '', playNote: '', record: null, stream: null, tally: [], summary: 'Walk-in',
      },
    ],
    companion: {
      httpOnline: true, wsOnline: true, version: '4.3.0', apiVersion: '1.10.0', error: '', connections: [],
      variables: { show_name: { found: true, value: 'Gala' }, gone: { found: false, value: '' } },
    },
  };
  const layout = cleanLayout({
    name: 'Test', hour12: true,
    tiles: [
      { id: 'remain', type: 'timer', label: 'Playback', source: { kind: 'system', system: 'atem' }, warn: { amberSec: 30, redSec: 10 } },
      { id: 'loose', type: 'timer', label: 'Loose', source: { kind: 'system', system: 'atem' }, warn: { amberSec: 5, redSec: 2 } },
      { id: 'rs6', type: 'preset', label: 'RS6', source: { kind: 'system', system: 'rs6' } },
      { id: 'name', type: 'text', label: 'Show name', source: { kind: 'companion', variable: 'show_name' } },
      { id: 'gone', type: 'text', label: 'Missing', source: { kind: 'companion', variable: 'gone' } },
      { id: 'cams', type: 'tally', label: 'Cameras', source: { kind: 'system', system: 'atem' } },
      { id: 'up', type: 'online', label: 'ATEM', source: { kind: 'system', system: 'atem' } },
      { id: 'show', type: 'countdown', label: 'Show', source: { kind: 'countdown', at: '19:00' } },
      { id: 'clock', type: 'clock', label: 'House', source: { kind: 'clock' } },
    ],
  });
  const board = renderBoard({ now: noonChicago, layout, state });
  const tile = (id) => board.tiles.find((row) => row.id === id);
  assert.equal(tile('remain').primary, '0:08');
  assert.equal(tile('remain').warn, 'red');
  assert.match(tile('remain').secondary, /Media Player 1/);
  assert.match(tile('remain').secondary, /Elapsed 0:52/);
  assert.equal(tile('loose').warn, 'ok');
  const preset = tile('rs6').items;
  assert.ok(preset.some((row) => row.role === 'preview' && row.name === 'Walk-in'));
  assert.ok(preset.some((row) => row.role === 'standby' && row.name === 'Keynote'));
  assert.equal(tile('name').primary, 'Gala');
  assert.equal(tile('gone').primary, 'Not set');
  assert.equal(tile('cams').live, true);
  assert.ok(tile('cams').items.some((row) => row.live && row.name === 'Cam 1'));
  assert.match(tile('up').secondary, /10\.0\.0\.8:9910/);
  assert.match(tile('up').secondary, /Streaming/);
  assert.equal(tile('show').warn, 'ok');
  assert.match(tile('clock').primary, /12:00:00/);
  assert.match(tile('clock').primary, /PM/);
});

test('gather reads an ATEM bus, a HyperDeck timecode, a PTZ tally, and the cue stack', () => {
  const now = noonChicago;
  const state = gather({
    systems: {
      listInstances() {
        return [
          { id: 'atem', name: 'Switcher', type: 'atem', armed: true },
          { id: 'hd', name: 'HyperDeck', type: 'hyperdeck', armed: true },
          { id: 'ptz', name: 'Cameras', type: 'ptz', armed: true },
        ];
      },
      view(id) {
        if (id === 'atem') {
          return {
            type: 'atem', label: 'Switcher', status: { connected: true, lastSeen: now }, connection: { host: '10.0.0.8', port: 9910 },
            mes: [{ index: 0, program: 3010, preview: 2, bus: [{ id: 3010, long: 'Media Player 1', pgm: true }, { id: 2, long: 'Cam 2', pvw: true }] }],
            sources: [{ id: 3010, kind: 'media', long: 'Media Player 1' }],
            tally: { program: ['Cam 1'], preview: ['Cam 2'] },
          };
        }
        if (id === 'hd') {
          return {
            type: 'hyperdeck', status: { connected: true, lastSeen: now }, connection: { host: '10.0.0.9', port: 9993 },
            transport: { status: 'record', clip: 4, timecode: '00:00:50', duration: '00:01:00' },
          };
        }
        return {
          type: 'ptz', status: { connected: true, lastSeen: now }, connection: { cameras: [{ host: '10.0.0.11' }, { host: '10.0.0.12' }] },
          cameras: [{ id: 'cam1', name: 'Cam 1 Wide', tally: true, connected: true, moving: true, pos: { pan: 12.5, tilt: -3, zoom: 40 } }],
        };
      },
    },
    cues: { status: () => ({ runState: 'loaded', index: 0, cues: [{ id: 'c1', name: 'Walk-in', steps: [{}] }, { id: 'c2', name: 'Keynote', steps: [{}] }] }) },
  });
  const atem = state.systems.find((row) => row.id === 'atem');
  assert.equal(atem.program[0].name, 'Media Player 1');
  assert.equal(atem.preview[0].name, 'Cam 2');
  assert.equal(atem.clip, 'Media Player 1');
  assert.match(atem.playNote, /does not report clip time/);
  assert.equal(atem.ip, '10.0.0.8:9910');
  const deck = state.systems.find((row) => row.id === 'hd');
  assert.equal(deck.clip, 'Clip 4');
  assert.equal(deck.remainingSec, 10);
  assert.equal(deck.record, true);
  const ptz = state.systems.find((row) => row.id === 'ptz');
  assert.equal(ptz.tally[0].live, true);
  assert.equal(ptz.tally[0].pan, 12.5);
  assert.match(ptz.ip, /10\.0\.0\.11/);
  const cues = state.systems.find((row) => row.id === 'cues');
  assert.equal(cues.preview[0].name, 'Walk-in');
  assert.equal(cues.standby[0].name, 'Keynote');
  const board = renderBoard({
    now, state, layout: cleanLayout({
      name: 'Deck', hour12: false,
      tiles: [{ id: 't', type: 'timer', label: 'HyperDeck', source: { kind: 'system', system: 'hd' } }],
    }),
  });
  assert.equal(board.tiles[0].primary, '0:10');
  assert.equal(board.tiles[0].warn, 'amber');
});
