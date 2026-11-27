'use strict';
// Shared administrator account for every PTZ camera. The secret lives in the
// environment (CC_PTZ_ADMIN_USER / CC_PTZ_ADMIN_PASS) or in a 0600 file under
// the install data dir (secrets/ptz-admin.env). It is never written into a
// profile, a show, an API answer, or the log.
const fs = require('fs');
const path = require('path');
const os = require('os');

const ID = 'ptz-admin';
const USER_KEY = 'CC_PTZ_ADMIN_USER';
const PASS_KEY = 'CC_PTZ_ADMIN_PASS';
const FILE_NAME = path.join('secrets', 'ptz-admin.env');

const isPass = (s) => typeof s === 'string' && s.length > 0;
const looksWeak = (pass) => {
  if (!isPass(pass) || pass.length < 8) return true;
  const classes = [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pass)).length;
  return classes < 3;
};

function parseEnvText(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('='); if (i < 1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1);
  }
  return out;
}

function redact(s) {
  if (s == null) return s;
  const text = typeof s === 'string' ? s : JSON.stringify(s);
  return text;
}

function filePath(dataDir) { return path.join(dataDir, FILE_NAME); }

function readFile(dataDir) {
  if (!dataDir) return null;
  const fp = filePath(dataDir);
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const ev = parseEnvText(raw);
    const user = ev[USER_KEY]; const pass = ev[PASS_KEY];
    if (user && isPass(pass)) return { user, pass, source: 'file', id: ID };
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return null;
}

function fromEnv(env = process.env) {
  const user = env[USER_KEY]; const pass = env[PASS_KEY];
  if (user && isPass(pass)) return { user, pass, source: 'env', id: ID };
  return null;
}

function load({ dataDir, env = process.env } = {}) {
  return fromEnv(env) || readFile(dataDir) || null;
}

function publicView(secret) {
  if (!secret) return { id: ID, passSet: false, user: null, source: 'none' };
  return { id: ID, passSet: true, user: secret.user, source: secret.source, weak: looksWeak(secret.pass) };
}

function writeFile(dataDir, { user, pass }) {
  if (!dataDir) throw new Error('No data directory for the PTZ admin vault');
  if (!String(user || '').trim()) throw Object.assign(new Error('A username is required for the shared admin account'), { status: 400 });
  if (!isPass(pass)) throw Object.assign(new Error('A password is required for the shared admin account'), { status: 400 });
  const dir = path.join(dataDir, 'secrets');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fp = filePath(dataDir);
  const tmp = `${fp}.${process.pid}.tmp`;
  const body = `${USER_KEY}=${String(user).trim()}\n${PASS_KEY}=${pass}\n`;
  fs.writeFileSync(tmp, body, { mode: 0o600, flag: 'w' });
  fs.renameSync(tmp, fp);
  try { fs.chmodSync(fp, 0o600); fs.chmodSync(dir, 0o700); } catch { /* best effort on some FS */ }
  return publicView({ user: String(user).trim(), pass, source: 'file', id: ID });
}

function clearFile(dataDir) {
  if (!dataDir) return;
  try { fs.unlinkSync(filePath(dataDir)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

// Used only by --mock so a digest mock can answer without a password in the repo.
function writeGenerated(dataDir, { user = 'admin' } = {}) {
  const crypto = require('crypto');
  const pass = `mock-${crypto.randomBytes(12).toString('hex')}-Aa1`;
  writeFile(dataDir, { user, pass });
  return load({ dataDir });
}

function assertNotIn(text, secret) {
  if (secret && isPass(secret.pass) && String(text).includes(secret.pass)) throw new Error('PTZ admin password leaked');
}

function describeSource(secret) {
  if (!secret) return 'none';
  return secret.source;
}

module.exports = {
  ID, USER_KEY, PASS_KEY, FILE_NAME, looksWeak, parseEnvText, load, publicView, writeFile, clearFile, writeGenerated, filePath, assertNotIn, describeSource, redact, os,
};
