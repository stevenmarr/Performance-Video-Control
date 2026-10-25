'use strict';
// Control Center's client for the Path C plugin HTTP API. Every call is a real HTTP
// request. Nothing here invents a connected deck.
// Uses node:http so this still runs on Node 16. The desk does not require Node 18's fetch.

const http = require('http');
const https = require('https');

const DEFAULT_URL = process.env.RS6_DECK_PLUGIN || 'http://127.0.0.1:9721';

function pluginFetch(base, path, { method = 'GET', body, timeout = 1500 } = {}) {
  const root = String(base || DEFAULT_URL).replace(/\/$/, '');
  let target;
  try { target = new URL(root + path); }
  catch {
    const err = new Error('Path C plugin is not running');
    err.status = 502;
    return Promise.reject(err);
  }
  const payload = body == null ? null : JSON.stringify(body);
  const lib = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    const ok = (val) => { if (!settled) { settled = true; resolve(val); } };
    const req = lib.request({
      method,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      headers: payload ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = {};
        try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text.slice(0, 180) }; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(json.error || `Plugin HTTP ${res.statusCode}`);
          err.status = res.statusCode === 404 || res.statusCode === 409 || res.statusCode === 400 ? res.statusCode : 502;
          fail(err);
          return;
        }
        ok(json);
      });
    });
    req.setTimeout(timeout, () => {
      const err = new Error('Path C plugin did not answer');
      err.status = 502;
      fail(err);
      req.destroy();
    });
    req.on('error', (e) => {
      if (e.status) { fail(e); return; }
      const err = new Error(e.message && /ECONNREFUSED|ENOTFOUND|ECONNRESET/.test(e.message) ? 'Path C plugin is not running' : (e.message || 'Path C plugin is not running'));
      err.status = 502;
      fail(err);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function listDevices(base, opts) { return pluginFetch(base, '/v1/devices', opts); }
function health(base, opts) { return pluginFetch(base, '/v1/health', opts); }
function deploy(base, body, opts) { return pluginFetch(base, '/v1/deploy', { ...opts, method: 'POST', body }); }

module.exports = { DEFAULT_URL, pluginFetch, listDevices, health, deploy };
