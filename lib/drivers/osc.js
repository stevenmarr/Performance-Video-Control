'use strict';
// A small OSC 1.0 encoder / decoder (Open Sound Control). Millumin's API is OSC and this app has no dependencies,
// so the handful of message types Millumin uses live here: string, int32, float32, and a message with no arguments.
// Bundles and blobs are out of scope; nothing in the Millumin command set needs them.
const { Buffer } = require('buffer');

const pad4 = (n) => (n + 3) & ~3;
function putString(parts, s) { const b = Buffer.from(String(s), 'utf8'); const out = Buffer.alloc(pad4(b.length + 1)); b.copy(out, 0); parts.push(out); }
function readString(buf, at) {
  let end = at; while (end < buf.length && buf[end] !== 0) end++;
  return { v: buf.toString('utf8', at, end), at: pad4(end + 1) };
}

// args: [{type:'s'|'i'|'f', value}] or a bare string / number (a number is a float, matching OSC's common case).
function encode(address, args = []) {
  if (!address || address[0] !== '/') throw new Error(`OSC address must start with / (${address})`);
  const list = (Array.isArray(args) ? args : [args]).filter((a) => a !== undefined && a !== null).map((a) => (
    typeof a === 'object' ? a : typeof a === 'string' ? { type: 's', value: a } : Number.isInteger(a) ? { type: 'i', value: a } : { type: 'f', value: a }
  ));
  const parts = [];
  putString(parts, address);
  putString(parts, `,${list.map((a) => a.type).join('')}`);
  for (const a of list) {
    if (a.type === 's') putString(parts, a.value);
    else if (a.type === 'i') { const b = Buffer.alloc(4); b.writeInt32BE(a.value | 0, 0); parts.push(b); }
    else if (a.type === 'f') { const b = Buffer.alloc(4); b.writeFloatBE(Number(a.value), 0); parts.push(b); }
    else throw new Error(`OSC type "${a.type}" is not used here`);
  }
  return Buffer.concat(parts);
}
function decode(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 4 || b[0] !== 0x2f) return null;
  const addr = readString(b, 0); const tags = readString(b, addr.at);
  if (!tags.v.startsWith(',')) return null;
  const args = []; let at = tags.at;
  for (const t of tags.v.slice(1)) {
    if (t === 's') { const r = readString(b, at); args.push({ type: 's', value: r.v }); at = r.at; }
    else if (t === 'i') { args.push({ type: 'i', value: b.readInt32BE(at) }); at += 4; }
    else if (t === 'f') { args.push({ type: 'f', value: b.readFloatBE(at) }); at += 4; }
    else return null;
  }
  return { address: addr.v, args };
}

module.exports = { encode, decode };
