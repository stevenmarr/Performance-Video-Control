'use strict';
// Aquilon REST API client (REST Programmer's Guide v4.01, "v6.0" file).
// Base path /api/tpp/v1 (REST p.4). Auth: POST /auth/login?identifier=Admin&password=... -> Set-Cookie auth-jwt (REST p.73-74).
const http = require('http');
const https = require('https');

class RestError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

class RestClient {
  constructor({ host, port = 80, https: useHttps = false, password = '', timeoutMs = 3000, log = () => {} }) {
    this.host = host; this.port = Number(port) || (useHttps ? 443 : 80); this.useHttps = !!useHttps;
    this.password = password || ''; this.timeoutMs = timeoutMs; this.log = log;
    this.cookie = null;
  }

  _raw(method, path, bodyObj) {
    return new Promise((resolve, reject) => {
      const body = bodyObj === undefined ? null : Buffer.from(JSON.stringify(bodyObj), 'utf8');
      const headers = {};
      if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = body.length; } // REST p.12: exact byte count
      else if (method === 'POST') headers['Content-Length'] = 0;
      if (this.cookie) headers['Cookie'] = `auth-jwt=${this.cookie}`; // REST p.74
      const mod = this.useHttps ? https : http;
      const req = mod.request({ host: this.host, port: this.port, method, path, headers, timeout: this.timeoutMs, rejectUnauthorized: false }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          if (text) { try { json = JSON.parse(text); } catch { json = null; } }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      });
      req.on('timeout', () => req.destroy(new Error(`timeout after ${this.timeoutMs} ms`)));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  async login() {
    if (!this.password) throw new RestError('Device requires a Web RCS password (401) but none is configured', 401);
    const path = `/auth/login?identifier=Admin&password=${encodeURIComponent(this.password)}`;
    const res = await this._raw('POST', path);
    const sc = [].concat(res.headers['set-cookie'] || []);
    const m = sc.map((c) => /auth-jwt=([^;]+)/.exec(c)).find(Boolean);
    if (!m) throw new RestError(`Login failed (HTTP ${res.status}); no auth-jwt cookie returned`, res.status, res.text);
    this.cookie = m[1];
    this.log('info', 'REST: logged in, auth-jwt cookie stored');
    return true;
  }

  async request(method, path, body) {
    let res = await this._raw(method, path, body);
    if (res.status === 401) {
      this.cookie = null;
      await this.login();
      res = await this._raw(method, path, body);
    }
    if (res.status >= 400) {
      throw new RestError(`${method} ${path} -> HTTP ${res.status}${res.text ? ': ' + res.text.slice(0, 200) : ''}`, res.status, res.text);
    }
    return res.json;
  }

  get(path) { return this.request('GET', path); }
  post(path, body) { return this.request('POST', path, body); }
}

const API = '/api/tpp/v1';
module.exports = { RestClient, RestError, API };
