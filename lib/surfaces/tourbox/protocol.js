'use strict';
// TourBox NEO (TBG_H) USB CDC serial protocol. VID 0x2E3C, PID 0x5740, 115200 8N1.
// Bytes and handshake come from yukimashita/TourBoxLinux (tourboxlinux.c), which matches
// the official Max/MSP table for buttons. Rotary Max/MSP integers are the serial byte OR 0x80.
// This module only decodes. It does not open a port or talk to a camera.

const VENDOR_ID = 0x2E3C;
const PRODUCT_ID = 0x5740;
const PRODUCT_NAME = 'TourBox NEO';
const BAUD = 115200;
const MODEL = 'TBG_H';

// House long-press on this surface (and the mapping UI). paint-accel still ships 500 ms
// for the Stream Deck dials until that constant moves in a later combined change.
const LONG_PRESS_MS = 800;

// Handshake, bit-identical to TourBoxLinux.
const MAGIC1 = Buffer.from([0x55, 0x00, 0x07, 0x88, 0x94, 0x00, 0x1a, 0xfe]);
const MAGIC2 = Buffer.from([
  0xb5, 0x00, 0x5d, 0x04, 0x08, 0x05, 0x08, 0x06,
  0x08, 0x07, 0x08, 0x08, 0x08, 0x09, 0x08, 0x0b,
  0x08, 0x0c, 0x08, 0x0d, 0x08, 0x0e, 0x08, 0x0f,
  0x08, 0x26, 0x08, 0x27, 0x08, 0x28, 0x08, 0x29,
  0x08, 0x3b, 0x08, 0x3c, 0x08, 0x3d, 0x08, 0x3e,
  0x08, 0x3f, 0x08, 0x40, 0x08, 0x41, 0x08, 0x42,
  0x08, 0x43, 0x08, 0x44, 0x08, 0x45, 0x08, 0x46,
  0x08, 0x47, 0x08, 0x48, 0x08, 0x49, 0x08, 0x4a,
  0x08, 0x4b, 0x08, 0x4c, 0x08, 0x4d, 0x08, 0x4e,
  0x08, 0x4f, 0x08, 0x50, 0x08, 0x51, 0x08, 0x52,
  0x08, 0x53, 0x08, 0x54, 0x08, 0xa8, 0x08, 0xa9,
  0x08, 0xaa, 0x08, 0xab, 0x08, 0xfe,
]);

const MODIFIERS = Object.freeze(['side', 'top', 'tall', 'short']);
const CONTROLS = Object.freeze(['knob', 'dial', 'scroll', 'side', 'top', 'tall', 'short', 'up', 'down', 'left', 'right', 'tour', 'c1', 'c2']);

// Press / one-way serial base codes. Release = base | 0x80. Rotary other way = base | 0x40.
const BUTTONS = Object.freeze({
  tall: 0x00,
  side: 0x01,
  top: 0x02,
  short: 0x03,
  scroll: 0x0a,
  up: 0x10,
  down: 0x11,
  left: 0x12,
  right: 0x13,
  c1: 0x22,
  c2: 0x23,
  tour: 0x2a,
  knob: 0x37,
  dial: 0x38,
});

const ROTARIES = Object.freeze({
  knob: { ccw: 0x04, cw: 0x44 },
  scroll: { down: 0x09, up: 0x49 },
  dial: { ccw: 0x0f, cw: 0x4f },
});

const BY_SERIAL = new Map();
for (const [id, base] of Object.entries(BUTTONS)) {
  BY_SERIAL.set(base, { control: id, event: 'press' });
  BY_SERIAL.set(base | 0x80, { control: id, event: 'release' });
}
for (const [id, dirs] of Object.entries(ROTARIES)) {
  BY_SERIAL.set(dirs.cw ?? dirs.up, { control: id, event: 'turn', ticks: 1 });
  BY_SERIAL.set(dirs.ccw ?? dirs.down, { control: id, event: 'turn', ticks: -1 });
  // Max/MSP rotary integers are the serial byte OR 0x80.
  BY_SERIAL.set((dirs.cw ?? dirs.up) | 0x80, { control: id, event: 'turn', ticks: 1, max: true });
  BY_SERIAL.set((dirs.ccw ?? dirs.down) | 0x80, { control: id, event: 'turn', ticks: -1, max: true });
}

function decodeByte(raw) {
  const code = Number(raw) & 0xff;
  const hit = BY_SERIAL.get(code);
  if (!hit) return { control: null, event: 'unknown', code };
  const out = { control: hit.control, event: hit.event, code };
  if (hit.event === 'turn') out.ticks = hit.ticks;
  if (hit.max) out.source = 'max';
  return out;
}

function decodeBuffer(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const events = [];
  for (const byte of b) events.push(decodeByte(byte));
  return events;
}

function labelOf(control) {
  const names = {
    knob: 'Knob', dial: 'Dial', scroll: 'Scroll', side: 'Side', top: 'Top', tall: 'Tall', short: 'Short',
    up: 'Up', down: 'Down', left: 'Left', right: 'Right', tour: 'Tour', c1: 'C1', c2: 'C2',
  };
  return names[control] || String(control || '');
}

module.exports = {
  VENDOR_ID, PRODUCT_ID, PRODUCT_NAME, BAUD, MODEL, LONG_PRESS_MS,
  MAGIC1, MAGIC2, MODIFIERS, CONTROLS, BUTTONS, ROTARIES, BY_SERIAL,
  decodeByte, decodeBuffer, labelOf,
};
