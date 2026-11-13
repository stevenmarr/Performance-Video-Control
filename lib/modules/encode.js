'use strict';
// Payload encodings shared by the HTTP, UDP and TCP command systems.
// ascii: the text as UTF-8. hex: pairs of hex digits, spaces allowed.
// escape: backslash sequences (\n \r \t \\ \xNN). osc is built in transports.

function encodePayload(text, encoding) {
  const mode = String(encoding || 'ascii').toLowerCase();
  const raw = text == null ? '' : String(text);
  if (mode === 'hex') {
    const digits = raw.replace(/\s+/g, '');
    if (!digits) return Buffer.alloc(0);
    if (digits.length % 2 || /[^0-9a-f]/i.test(digits)) throw Object.assign(new Error('Hex payload needs pairs of hex digits'), { status: 400 });
    return Buffer.from(digits, 'hex');
  }
  if (mode === 'escape') return Buffer.from(unescape(raw), 'utf8');
  if (mode === 'ascii' || mode === 'utf8' || mode === 'text') return Buffer.from(raw, 'utf8');
  throw Object.assign(new Error(`Unknown payload encoding "${encoding}"`), { status: 400 });
}

function decodePayload(buf, encoding) {
  const mode = String(encoding || 'ascii').toLowerCase();
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (mode === 'hex') return b.toString('hex').replace(/(..)/g, '$1 ').trim();
  return b.toString('utf8');
}

function unescape(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') { out += s[i]; continue; }
    const n = s[++i];
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n === '\\') out += '\\';
    else if (n === 'x') {
      const hex = s.slice(i + 1, i + 3);
      if (!/^[0-9a-f]{2}$/i.test(hex)) throw Object.assign(new Error('Bad \\x escape'), { status: 400 });
      out += String.fromCharCode(parseInt(hex, 16));
      i += 2;
    } else if (n == null) out += '\\';
    else out += n;
  }
  return out;
}

function fill(template, bag) {
  return String(template == null ? '' : template).replace(/\$\(([^)]+)\)/g, (_, name) => {
    const value = bag && bag[name];
    return value == null ? '' : String(value);
  });
}

function bagFrom(conn, options, vars) {
  const bag = {};
  for (const [k, v] of Object.entries(vars || {})) bag[k] = v;
  for (const [k, v] of Object.entries(conn || {})) bag[`conn:${k}`] = v;
  for (const [k, v] of Object.entries(options || {})) bag[`options:${k}`] = v;
  return bag;
}

module.exports = { encodePayload, decodePayload, fill, bagFrom, unescape };
