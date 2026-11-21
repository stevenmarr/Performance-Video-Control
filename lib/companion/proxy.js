'use strict';
// 0.34.0: Companion's web UI under Control Center's own address. GET /companion/... and the tRPC websocket
// /companion/trpc go to Companion (the one Control Center runs, or the host and port on the COMPANION tab).
// Companion supports a sub-path behind a reverse proxy: its web UI is built with the placeholder base
// /ROOT_URL_HERE and the server swaps it for the `companion-custom-prefix` request header
// (companion/lib/UI/middleware/rewriteRootUrl.ts), so no Companion change is needed for /companion/.
// Also forwarded unchanged: /user-guide/ (help links that skip the base path) and /instance/ (module HTTP
// handlers, and where Companion redirects /connections/instance).
//
// Security: the websocket is Companion's full admin API. Control Center checks the browser's Origin against its
// own Host before forwarding (Cross-Site WebSocket Hijacking), then presents Companion's own origin upstream.
// Incoming companion-custom-prefix / X-Forwarded-* headers are replaced, never passed through.

const http = require('http');
const net = require('net');

const PREFIX = '/companion';
const ROOT_ALIASES = ['/user-guide', '/instance'];
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'companion-custom-prefix', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-prefix']);

const isAlias = (p) => ROOT_ALIASES.some((a) => p === a || p.startsWith(`${a}/`));

// '/companion/x?y' -> '/x?y' ; aliases unchanged ; null when not ours
function upstreamPath(rawUrl) {
  const url = String(rawUrl || '/');
  const q = url.indexOf('?');
  const p = q < 0 ? url : url.slice(0, q);
  const qs = q < 0 ? '' : url.slice(q);
  if (p === PREFIX) return { redirect: `${PREFIX}/${qs}` };
  if (p.startsWith(`${PREFIX}/`)) return { path: p.slice(PREFIX.length) + qs };
  if (isAlias(p)) return { path: p + qs };
  return null;
}

function remoteAddr(req) {
  return String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
}

function forwardHeaders(req, t) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase())) out[k] = v;
  out.host = `${t.host}:${t.port}`;
  out['x-forwarded-host'] = req.headers.host || '';
  out['x-forwarded-proto'] = req.socket && req.socket.encrypted ? 'https' : 'http';
  out['x-forwarded-for'] = remoteAddr(req);
  out['companion-custom-prefix'] = PREFIX.slice(1);
  return out;
}

// Same-origin check for the websocket: Origin must name this Control Center (or be absent: non-browser tools).
function originAllowed(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try { return new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase(); } catch { return false; }
}

function rewriteLocation(loc, t) {
  if (!loc) return loc;
  let l = String(loc);
  for (const base of [`http://${t.host}:${t.port}`, `http://localhost:${t.port}`, `http://127.0.0.1:${t.port}`]) if (l.startsWith(base)) { l = l.slice(base.length) || '/'; break; }
  if (l.startsWith('/') && !l.startsWith('//') && !l.startsWith(`${PREFIX}/`) && l !== PREFIX) return PREFIX + l;
  return l;
}

const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function unavailable(req, res, info) {
  const wantsHtml = /text\/html/.test(String(req.headers.accept || ''));
  const msg = (info && info.message) || 'Companion is not answering.';
  if (!wantsHtml) {
    res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ error: msg, state: info && info.state }));
  }
  res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>Companion</title>
<style>body{background:#0b0f16;color:#d7dee8;font:15px/1.5 "Space Grotesk",system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh}
.box{max-width:560px;padding:24px;border:1px solid #233046;border-radius:12px;background:#111826}h1{font-size:14px;letter-spacing:.08em;margin:0 0 8px}
small{color:#8a97a8}a{color:#7cc4ff}</style>
<div class="box"><h1>COMPANION ${escHtml(info && info.state ? `· ${String(info.state).toUpperCase()}` : '')}</h1><p>${escHtml(msg)}</p>
<small>This page retries every 3 seconds. Status and logs: <a href="/#companion" target="_top">Control Center → COMPANION</a>.</small></div>`);
}

// target(): {host, port} | null ; info(): {state, message} for the "not answering" page
function createCompanionProxy({ target, info = () => null, agent } = {}) {
  const keepAlive = agent || new http.Agent({ keepAlive: true, maxSockets: 64 });

  function handles(pathname) {
    const p = String(pathname || '');
    return p === PREFIX || p.startsWith(`${PREFIX}/`) || isAlias(p);
  }

  function web(req, res) {
    const up = upstreamPath(req.url);
    if (!up) return false;
    if (up.redirect) { res.writeHead(302, { Location: up.redirect, 'Cache-Control': 'no-store' }); res.end(); return true; }
    const t = target();
    if (!t) { unavailable(req, res, info()); return true; }
    const preq = http.request({ host: t.host, port: t.port, method: req.method, path: up.path, headers: forwardHeaders(req, t), agent: keepAlive }, (pres) => {
      const headers = {};
      for (const [k, v] of Object.entries(pres.headers)) if (!HOP.has(k.toLowerCase())) headers[k] = v;
      if (headers.location) headers.location = rewriteLocation(headers.location, t);
      res.writeHead(pres.statusCode || 502, headers);
      pres.pipe(res);
    });
    preq.setTimeout(120000, () => preq.destroy(new Error('Companion took too long to answer')));
    preq.on('error', (e) => {
      if (res.headersSent) { res.destroy(); return; }
      const i = info() || {};
      unavailable(req, res, { state: i.state, message: `${i.message ? `${i.message} ` : ''}(${e.code || e.message})` });
    });
    req.on('aborted', () => preq.destroy());
    req.pipe(preq);
    return true;
  }

  function reject(socket, status, text) {
    try { if (socket.writable) socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* closed */ }
    socket.destroy();
  }

  function upgrade(req, socket, head) {
    const up = upstreamPath(req.url);
    if (!up || up.redirect) { reject(socket, 404, 'Not Found'); return; }
    if (!originAllowed(req)) { reject(socket, 403, 'Forbidden'); return; }
    const t = target();
    if (!t) { reject(socket, 502, 'Bad Gateway'); return; }
    const headers = forwardHeaders(req, t);
    headers.connection = 'Upgrade';
    headers.upgrade = req.headers.upgrade || 'websocket';
    // Control Center already checked that the page is its own. Companion checks Origin against its Host.
    // X-Forwarded-Host is left out here: behind a trusted proxy Companion compares Origin with it instead of Host.
    if (req.headers.origin !== undefined) headers.origin = `http://${t.host}:${t.port}`;
    delete headers['x-forwarded-host'];
    const lines = [`${req.method} ${up.path} HTTP/1.1`];
    for (const [k, v] of Object.entries(headers)) for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${String(one).replace(/[\r\n]/g, ' ')}`);
    const upstream = net.connect(t.port, t.host);
    let open = false;
    upstream.setNoDelay(true); socket.setNoDelay(true);
    upstream.on('connect', () => {
      open = true;
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
    });
    const close = () => { upstream.destroy(); socket.destroy(); };
    upstream.on('error', () => { if (!open) reject(socket, 502, 'Bad Gateway'); else close(); });
    socket.on('error', close);
    upstream.on('close', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  }

  return { handles, web, upgrade, close: () => keepAlive.destroy() };
}

module.exports = { createCompanionProxy, upstreamPath, rewriteLocation, originAllowed, PREFIX };
