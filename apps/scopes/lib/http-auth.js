'use strict';
// 0.11.1 HTTP authentication for camera CGI requests (RFC 7617 Basic, RFC 7616 Digest: MD5, MD5-sess, SHA-256,
// qop=auth). Credentials are only sent once a camera has asked for them (401 + WWW-Authenticate); after that the
// answer is sent up front on that camera's next requests (Digest: same nonce, counting nc) until it changes.
// Panasonic AW-UE150 factory login: admin / 12345 (the default here; a user-set password lives only in the
// install's data folder, systems.json).
const crypto = require('crypto');

const FACTORY = Object.freeze({ user: 'admin', pass: '12345' });

// WWW-Authenticate: 'Digest realm="x", nonce="y", qop="auth,auth-int"' -> { scheme: 'digest', realm, nonce, qop, ... }
// Several challenges in one header (or several headers): Digest wins over Basic.
function parseChallenge(header) {
  const list = (Array.isArray(header) ? header : [header]).filter(Boolean).map(String);
  const all = [];
  for (const h of list) {
    const re = /(Basic|Digest)\s+((?:[\w-]+=(?:"[^"]*"|[^,\s]*)\s*,?\s*)*)/gi; let m;
    while ((m = re.exec(h))) {
      const out = { scheme: m[1].toLowerCase() }; const pr = /([\w-]+)=(?:"([^"]*)"|([^,\s]*))/g; let p;
      while ((p = pr.exec(m[2]))) out[p[1].toLowerCase()] = p[2] !== undefined ? p[2] : p[3];
      all.push(out);
    }
  }
  return all.find((x) => x.scheme === 'digest') || all.find((x) => x.scheme === 'basic') || null;
}
const hashFor = (alg) => { const a = String(alg || 'MD5').toUpperCase().replace(/-SESS$/, ''); return a === 'SHA-256' ? 'sha256' : a === 'MD5' ? 'md5' : null; };
const H = (algo, s) => crypto.createHash(algo).update(s).digest('hex');

// The Authorization header for one request. `st` is the per-camera state ({ ch, nc }) kept between requests.
function authorization(st, { user, pass }, method, uri) {
  const ch = st && st.ch; if (!ch) return null;
  if (ch.scheme === 'basic') return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
  const algo = hashFor(ch.algorithm); if (!algo) return null;
  const qop = ch.qop ? (String(ch.qop).split(',').map((s) => s.trim()).includes('auth') ? 'auth' : null) : '';
  if (qop === null) return null; // auth-int only: not supported
  st.nc = (st.nc || 0) + 1; const nc = st.nc.toString(16).padStart(8, '0'); const cnonce = crypto.randomBytes(8).toString('hex');
  let ha1 = H(algo, `${user}:${ch.realm || ''}:${pass}`);
  if (/-sess$/i.test(ch.algorithm || '')) ha1 = H(algo, `${ha1}:${ch.nonce}:${cnonce}`);
  const ha2 = H(algo, `${method}:${uri}`);
  const response = qop ? H(algo, `${ha1}:${ch.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : H(algo, `${ha1}:${ch.nonce}:${ha2}`);
  const q = (s) => String(s).replace(/["\\]/g, '\\$&');
  return `Digest username="${q(user)}", realm="${q(ch.realm || '')}", nonce="${q(ch.nonce)}", uri="${q(uri)}", response="${response}"`
    + `${ch.algorithm ? `, algorithm=${ch.algorithm}` : ''}${ch.opaque !== undefined ? `, opaque="${q(ch.opaque)}"` : ''}${qop ? `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"` : ''}`;
}
// Server side (mocks / tests): check an Authorization header against user / pass for a challenge this server issued.
function verify(header, { user, pass, method = 'GET', nonces = null, scheme = 'digest' }) {
  const h = String(header || '');
  if (scheme === 'basic') { const m = /^Basic\s+(.+)$/i.exec(h); return !!m && Buffer.from(m[1], 'base64').toString('utf8') === `${user}:${pass}`; }
  const m = /^Digest\s+(.*)$/i.exec(h); if (!m) return false;
  const f = {}; const pr = /([\w-]+)=(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/g; let p;
  while ((p = pr.exec(m[1]))) f[p[1].toLowerCase()] = p[2] !== undefined ? p[2].replace(/\\(.)/g, '$1') : p[3];
  if (f.username !== user || (nonces && !nonces.has(f.nonce))) return false;
  const algo = hashFor(f.algorithm); if (!algo) return false;
  let ha1 = H(algo, `${user}:${f.realm}:${pass}`); if (/-sess$/i.test(f.algorithm || '')) ha1 = H(algo, `${ha1}:${f.nonce}:${f.cnonce}`);
  const ha2 = H(algo, `${method}:${f.uri}`);
  const want = f.qop ? H(algo, `${ha1}:${f.nonce}:${f.nc}:${f.cnonce}:${f.qop}:${ha2}`) : H(algo, `${ha1}:${f.nonce}:${ha2}`);
  return want === f.response;
}

module.exports = { FACTORY, parseChallenge, authorization, verify };
