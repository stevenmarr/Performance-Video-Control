'use strict';
// JPEG snapshot and get_rtsp, talking to the camera. Not to Control Center.
const http = require('http');
const https = require('https');
const { parseChallenge, authorization } = require('./http-auth');
const { loginOf } = require('./cameras');

function requestOnce(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'GET', headers: headers || {}, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('camera timed out')); });
    req.end();
  });
}

async function fetchAuthed(url, login, timeoutMs = 4000) {
  const first = await requestOnce(url, {}, timeoutMs);
  if (first.status !== 401) return first;
  const ch = parseChallenge(first.headers['www-authenticate']);
  if (!ch) return first;
  const st = { ch, nc: 0 };
  const u = new URL(url);
  const header = authorization(st, { user: login.user, pass: login.password }, 'GET', u.pathname + u.search);
  if (!header) return first;
  return requestOnce(url, { Authorization: header }, timeoutMs);
}

function cameraHttp(cam, pathAndQuery) {
  const port = Number(cam.httpPort) || 80;
  return `http://${cam.host}${port === 80 ? '' : `:${port}`}${pathAndQuery}`;
}

async function snapshot(cam) {
  const login = loginOf(cam);
  const url = cameraHttp(cam, '/cgi-bin/camera?resolution=640');
  const res = await fetchAuthed(url, login, 5000);
  const type = String(res.headers['content-type'] || '').split(';')[0].trim();
  if (res.status !== 200 || !/^image\//i.test(type)) {
    const status = res.status === 401 ? 401 : 502;
    throw Object.assign(new Error(`snapshot ${res.status || 'failed'}`), { status });
  }
  return { type, body: res.body };
}

function parseRtspPath(text, streamN) {
  const kv = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*([\w]+)=(.*)$/.exec(line);
    if (m) kv[m[1].toLowerCase()] = m[2].trim();
  }
  const key = `h264_rtsp_req_uri${streamN}`;
  let path = kv[key];
  if (!path) {
    const hit = Object.entries(kv).find(([k]) => new RegExp(`uri${streamN}$`, 'i').test(k) && /h264/i.test(k));
    path = hit && hit[1];
  }
  if (!path) return null;
  return path.startsWith('/') ? path : `/${path}`;
}

async function getRtspPath(cam, streamN) {
  const login = loginOf(cam);
  const url = cameraHttp(cam, '/cgi-bin/get_rtsp');
  try {
    const res = await fetchAuthed(url, login, 2500);
    if (res.status !== 200) return null;
    return parseRtspPath(res.body.toString('utf8'), streamN);
  } catch { return null; }
}

module.exports = { snapshot, getRtspPath, parseRtspPath, fetchAuthed };
