'use strict';
// Blackmagic ATEM Micro Panel (USB 1edb:bef0, also over Bluetooth with the same HID ids): the bytes, no I/O.
// On the Raspberry Pi 5, node-hid opens the panel through Linux hidraw (/dev/hidraw*).
//
// Sources (MIT): Julian Waller's node-blackmagic-controller (packages/core/src/models/definitions.ts,
// models/atem-micro-panel.ts, services/input/default.ts, services/led/ledBuffer.ts, authenticate.ts), which
// Bitfocus Companion drives real panels with since v3.4.0. The handshake is Sylvain Munaut's Speed Editor work
// (github.com/smunaut/blackmagic-misc bmd.py). Report ids, key codes and lamp bits are copied code for code.
//
// - Input report 0x03: the keys held now, as LE16 codes, ended by 0. Every change sends a new report.
// - Input report 0x08: the T-bar, LE16 at byte 1, 0..4096.
// - Input report 0x06: battery, percent at byte 2 (untested upstream).
// - Output report 0x02, 32 bytes: one bit per lamp after the report id. T-bar meter = bits 0..15;
//   key with code c = bits 13 + 3c (red), +1 (green), +2 (blue). Three bits per key: 8 colours, no dimming.
// - Feature report 0x05, 10 bytes: the challenge. The panel is silent until it is answered and asks again
//   every lease (seconds, LE16 at byte 2 of the status); answer at half the lease.

const VENDOR_ID = 0x1edb;
const PRODUCT_ID = 0xbef0;
const PRODUCT_NAME = 'ATEM Micro Panel';
const REPORT = Object.freeze({ firmware: 1, led: 2, buttons: 3, auth: 5, battery: 6, serial: 7, tbar: 8 });
const LED_REPORT_LEN = 32;
const TBAR_SEGMENTS = 16;
const TBAR_MAX = 4096;

// [id, wire code, row, column] in the panel's own grid (Companion's layout uses the same row / column).
const KEY_TABLE = [
  ['macro', 0x01, 0, 5],
  ['key1-on', 0x02, 0, 6], ['key2-on', 0x03, 0, 7], ['key3-on', 0x04, 0, 8], ['key4-on', 0x05, 0, 9],
  ['next-background', 0x06, 1, 5], ['next-key1', 0x07, 1, 6], ['next-key2', 0x08, 1, 7], ['next-key3', 0x09, 1, 8], ['next-key4', 0x0a, 1, 9],
  ...Array.from({ length: 10 }, (_, i) => [`program${i + 1}`, 0x0b + i, 2, i]),
  ...Array.from({ length: 10 }, (_, i) => [`preview${i + 1}`, 0x15 + i, 3, i]),
  ['mixeffect1', 0x1f, 0, 10], ['mixeffect2', 0x20, 0, 11], ['mixeffect3', 0x21, 0, 12], ['mixeffect4', 0x22, 0, 13],
  ['transition-dip', 0x23, 1, 11], ['transition-dve', 0x24, 1, 12], ['transition-sting', 0x25, 1, 13],
  ['shift', 0x26, 2, 10],
  ['transition-mix', 0x27, 2, 11], ['transition-wipe', 0x28, 2, 12], ['transition-arm', 0x29, 2, 13],
  ['preview-transition', 0x2a, 3, 10],
  ['cut', 0x2b, 3, 11], ['auto', 0x2c, 3, 13],
  ['dsk1-tie', 0x2d, 1, 15], ['dsk2-tie', 0x2e, 1, 16], ['dsk1-cut', 0x2f, 2, 15], ['dsk2-cut', 0x30, 2, 16], ['dsk1-auto', 0x31, 3, 15], ['dsk2-auto', 0x32, 3, 16],
];
// The engraving, for logs and the UI.
const LABELS = {
  macro: 'MACRO', 'next-background': 'BKGD', shift: 'SHIFT', 'preview-transition': 'PREV TRANS', cut: 'CUT', auto: 'AUTO',
  'transition-mix': 'MIX', 'transition-dip': 'DIP', 'transition-wipe': 'WIPE', 'transition-dve': 'DVE', 'transition-sting': 'STING', 'transition-arm': 'ARM',
};
function labelOf(id) {
  if (LABELS[id]) return LABELS[id];
  let m;
  if ((m = /^key(\d)-on$/.exec(id))) return `KEY ${m[1]} ON`;
  if ((m = /^next-key(\d)$/.exec(id))) return `KEY ${m[1]}`;
  if ((m = /^program(\d+)$/.exec(id))) return `PGM ${m[1]}`;
  if ((m = /^preview(\d+)$/.exec(id))) return `PVW ${m[1]}`;
  if ((m = /^mixeffect(\d)$/.exec(id))) return `M/E ${m[1]}`;
  if ((m = /^dsk(\d)-(tie|cut|auto)$/.exec(id))) return `DSK ${m[1]} ${m[2].toUpperCase()}`;
  return id;
}

const KEYS = Object.freeze(KEY_TABLE.map(([id, code, row, column]) => Object.freeze({ id, code, row, column, ledBit: 13 + 3 * code, label: labelOf(id) })));
const BY_CODE = new Map(KEYS.map((k) => [k.code, k]));
const BY_ID = new Map(KEYS.map((k) => [k.id, k]));

// 3-bit colours: [red, green, blue]
const COLORS = Object.freeze({
  off: [0, 0, 0], red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1],
  yellow: [1, 1, 0], cyan: [0, 1, 1], magenta: [1, 0, 1], white: [1, 1, 1],
});

function isPanel(dev) {
  return !!dev && Number(dev.vendorId) === VENDOR_ID && Number(dev.productId) === PRODUCT_ID;
}

// ---------- input ----------
// Returns { type: 'keys', held: [ids] } | { type: 'tbar', raw, value } | { type: 'battery', percent } | null
function decodeInput(data) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  if (!b.length) return null;
  switch (b[0]) {
    case REPORT.buttons: {
      const held = [];
      for (let i = 1; i + 1 < b.length; i += 2) {
        const code = b.readUInt16LE(i);
        if (code === 0) break;
        const k = BY_CODE.get(code);
        if (k && !held.includes(k.id)) held.push(k.id);
      }
      return { type: 'keys', held };
    }
    case REPORT.tbar: {
      if (b.length < 3) return null;
      const raw = b.readUInt16LE(1);
      return { type: 'tbar', raw, value: Math.max(0, Math.min(1, raw / TBAR_MAX)) };
    }
    case REPORT.battery:
      if (b.length < 3) return null;
      return { type: 'battery', percent: b[2] };
    default:
      return null;
  }
}

// Key-down / key-up edges between two held lists.
function diffHeld(before, after) {
  const was = new Set(before || []); const now = new Set(after || []);
  return { down: [...now].filter((k) => !was.has(k)), up: [...was].filter((k) => !now.has(k)) };
}

// ---------- lamps ----------
// keys: { [id]: colourName | [r,g,b] }, tbar: boolean[16] (segment 0 = bit 0)
function encodeLeds({ keys = {}, tbar = [] } = {}) {
  const buf = Buffer.alloc(LED_REPORT_LEN);
  buf[0] = REPORT.led;
  const set = (bit, on) => { if (!on) return; const byte = 1 + (bit >> 3); if (byte < buf.length) buf[byte] |= 1 << (bit & 7); };
  for (let i = 0; i < TBAR_SEGMENTS; i++) set(i, !!tbar[i]);
  for (const [id, colour] of Object.entries(keys)) {
    const k = BY_ID.get(id); if (!k) continue;
    const rgb = Array.isArray(colour) ? colour : COLORS[colour] || COLORS.off;
    set(k.ledBit, rgb[0]); set(k.ledBit + 1, rgb[1]); set(k.ledBit + 2, rgb[2]);
  }
  return buf;
}

function decodeLeds(buf) {
  const b = Buffer.from(buf);
  const bit = (i) => !!(b[1 + (i >> 3)] & (1 << (i & 7)));
  const keys = {};
  for (const k of KEYS) {
    const rgb = [bit(k.ledBit), bit(k.ledBit + 1), bit(k.ledBit + 2)].map(Number);
    keys[k.id] = Object.keys(COLORS).find((n) => COLORS[n].every((v, i) => v === rgb[i])) || 'off';
  }
  return { keys, tbar: Array.from({ length: TBAR_SEGMENTS }, (_, i) => bit(i)) };
}

// ---------- handshake ----------
const MASK64 = 0xffffffffffffffffn;
// Rotate right by 8 bits (named rol8 upstream; kept bit-identical).
const rol8 = (v) => ((v << 56n) | (v >> 8n)) & MASK64;
const rol8n = (v, n) => { for (let i = 0; i < n; i++) v = rol8(v); return v; };
const AUTH_EVEN = [0x3ae1206f97c10bc8n, 0x2a9ab32bebf244c6n, 0x20a6f8b8df9adf0an, 0xaf80ece52cfc1719n, 0xec2ee2f7414fd151n, 0xb055adfd73344a15n, 0xa63d2e3059001187n, 0x751bf623f42e0dden];
const AUTH_ODD = [0x3e22b34f502e7fden, 0x24656b981875ab1cn, 0xa17f3456df7bf8c3n, 0x6df72e1941aef698n, 0x72226f011e66ab94n, 0x3831a3c606296b42n, 0xfd7ff81881332c89n, 0x61a3f6474ff236c6n];
const AUTH_MASK = 0xa79a63f585d37bf0n;

function authResponse(challenge) {
  const c = BigInt.asUintN(64, BigInt(challenge));
  const n = Number(c & 7n);
  let v = rol8n(c, n);
  let k;
  if ((v & 1n) === (BigInt(0x78 >> n) & 1n)) k = AUTH_EVEN[n];
  else { v ^= rol8(v); k = AUTH_ODD[n]; }
  return (v ^ (rol8(v) & AUTH_MASK) ^ k) & MASK64;
}

function authPacket(step, value = 0n, reportId = REPORT.auth) {
  const b = Buffer.alloc(10);
  b[0] = reportId; b[1] = step; b.writeBigUInt64LE(BigInt.asUintN(64, BigInt(value)), 2);
  return b;
}

// The host side of the handshake. `dev` has sendFeatureReport(buf) and getFeatureReport(id, len) (sync or async).
// Resolves to the lease in seconds; throws when the panel refuses.
async function authenticate(dev, reportId = REPORT.auth) {
  await dev.sendFeatureReport(authPacket(0, 0n, reportId)); // reset the state machine
  const challenge = Buffer.from(await dev.getFeatureReport(reportId, 10)); // the panel's challenge to us
  if (challenge.length < 10) throw new Error(`ATEM Micro Panel: short challenge (${challenge.length} bytes)`);
  await dev.sendFeatureReport(authPacket(1, 0n, reportId)); // our challenge to the panel (unchecked, as upstream)
  await dev.getFeatureReport(reportId, 10); // its answer, ignored
  await dev.sendFeatureReport(authPacket(3, authResponse(challenge.readBigUInt64LE(2)), reportId));
  const status = Buffer.from(await dev.getFeatureReport(reportId, 10));
  if (status[1] !== 0x04) throw new Error('ATEM Micro Panel refused the handshake');
  return status.readUInt16LE(2);
}

module.exports = {
  VENDOR_ID, PRODUCT_ID, PRODUCT_NAME, REPORT, LED_REPORT_LEN, TBAR_SEGMENTS, TBAR_MAX,
  KEYS, BY_ID, BY_CODE, COLORS, labelOf, isPanel,
  decodeInput, diffHeld, encodeLeds, decodeLeds,
  authResponse, authPacket, authenticate,
};
