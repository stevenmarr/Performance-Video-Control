'use strict';
// Control Center's client for the Path C plugin HTTP API. Every call is a real HTTP
// request. Nothing here invents a connected deck.

const DEFAULT_URL = process.env.RS6_DECK_PLUGIN || 'http://127.0.0.1:9721';

async function pluginFetch(base, path, { method = 'GET', body, timeout = 1500 } = {}) {
  const root = String(base || DEFAULT_URL).replace(/\/$/, '');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${root}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text.slice(0, 180) }; }
    if (!res.ok) {
      const err = new Error(json.error || `Plugin HTTP ${res.status}`);
      err.status = res.status === 404 || res.status === 409 || res.status === 400 ? res.status : 502;
      throw err;
    }
    return json;
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error('Path C plugin did not answer');
      err.status = 502;
      throw err;
    }
    if (e.status) throw e;
    const err = new Error(e.message && /fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET/.test(e.message) ? 'Path C plugin is not running' : (e.message || 'Path C plugin is not running'));
    err.status = 502;
    throw err;
  } finally {
    clearTimeout(t);
  }
}

function listDevices(base, opts) { return pluginFetch(base, '/v1/devices', opts); }
function health(base, opts) { return pluginFetch(base, '/v1/health', opts); }
function deploy(base, body, opts) { return pluginFetch(base, '/v1/deploy', { ...opts, method: 'POST', body }); }

module.exports = { DEFAULT_URL, pluginFetch, listDevices, health, deploy };
