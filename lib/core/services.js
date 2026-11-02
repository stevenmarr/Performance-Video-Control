'use strict';
// Service status the console can show. Phase 1 does not start a speaker timer
// or an SMB server. It reports what it can see, and it will start or stop a
// systemd unit only when CC_SERVICE_CONTROL=1 (the Pi image).
const http = require('http');
const https = require('https');
const fs = require('fs');
const { spawn } = require('child_process');

const IDS = ['speakerTimer', 'smb', 'companion'];
const UNITS = {
  speakerTimer: process.env.CC_SPEAKER_TIMER_UNIT || 'control-center-speaker-timer.service',
  smb: process.env.CC_SMB_UNIT || 'smbd.service',
  companion: process.env.CC_COMPANION_UNIT || 'companion.service',
};

function blank(id) {
  return { id, state: 'unconfigured', detail: '', output: null, checkedAt: 0, enabled: true };
}

function probeHttp(url, timeout = 800) {
  return new Promise((resolve) => {
    let lib = http;
    try { lib = url.startsWith('https:') ? https : http; } catch { resolve({ ok: false, error: 'bad url' }); return; }
    const req = lib.get(url, { timeout }, (res) => {
      const parts = [];
      res.on('data', (c) => { if (parts.reduce((n, b) => n + b.length, 0) < 8000) parts.push(c); });
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8').slice(0, 2000);
        let output = null;
        try { output = JSON.parse(text); } catch { output = text ? { text } : null; }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, output });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

function systemctl(unit, arg) {
  if (process.env.CC_SERVICE_CONTROL !== '1') return Promise.resolve(null);
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('systemctl', [arg, unit], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ ok: false, error: 'timeout' }); }, 4000);
    if (timer.unref) timer.unref();
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, text: out.slice(0, 200) }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
  });
}

function createServices(store, opts = {}) {
  const status = {
    speakerTimer: blank('speakerTimer'),
    smb: blank('smb'),
    companion: blank('companion'),
  };
  function enabled(id) {
    const row = store.services && store.services[id];
    return !row || row.enabled !== false;
  }
  function applyEnabled() {
    for (const id of IDS) status[id].enabled = enabled(id);
  }
  const api = {
    snapshot() {
      applyEnabled();
      return {
        speakerTimer: { ...status.speakerTimer },
        smb: { ...status.smb },
        companion: { ...status.companion },
      };
    },
    async refresh(ctx = {}) {
      applyEnabled();
      await Promise.all(IDS.map((id) => api.probe(id, ctx)));
      return api.snapshot();
    },
    async probe(id, ctx = {}) {
      if (!IDS.includes(id)) { const e = new Error(`Unknown service "${id}"`); e.status = 404; throw e; }
      const row = status[id];
      row.checkedAt = Date.now();
      row.enabled = enabled(id);
      if (!row.enabled) { row.state = 'disabled'; row.detail = 'turned off on this console'; return row; }
      if (id === 'speakerTimer') {
        const url = opts.speakerTimerUrl || process.env.CC_SPEAKER_TIMER_URL || '';
        if (!url) { row.state = 'unconfigured'; row.detail = 'set CC_SPEAKER_TIMER_URL'; row.output = null; return row; }
        const r = await probeHttp(url);
        row.state = r.ok ? 'up' : 'down';
        row.detail = r.ok ? 'timer answered' : (r.error || `HTTP ${r.status}`);
        row.output = r.output || null;
        return row;
      }
      if (id === 'smb') {
        const path = opts.smbPath || process.env.CC_SMB_PATH || '';
        if (!path) { row.state = 'unconfigured'; row.detail = 'set CC_SMB_PATH'; return row; }
        try {
          fs.accessSync(path);
          row.state = 'up'; row.detail = path;
        } catch (e) {
          row.state = 'down'; row.detail = e.message;
        }
        return row;
      }
      const fresh = ctx.companionFresh;
      const url = opts.companionUrl || process.env.CC_COMPANION_URL || '';
      if (fresh) { row.state = 'up'; row.detail = 'feedback in the last 30s'; return row; }
      if (ctx.companionConfigured && !fresh) { row.state = 'down'; row.detail = 'no recent Companion feedback'; return row; }
      if (!url) { row.state = 'unconfigured'; row.detail = 'no Companion connection yet'; return row; }
      const r = await probeHttp(url);
      row.state = r.ok ? 'up' : 'down';
      row.detail = r.ok ? 'Companion answered' : (r.error || `HTTP ${r.status}`);
      return row;
    },
    async setEnabled(id, on) {
      if (!IDS.includes(id)) { const e = new Error(`Unknown service "${id}"`); e.status = 404; throw e; }
      store.services[id] = { enabled: !!on };
      status[id].enabled = !!on;
      if (process.env.CC_SERVICE_CONTROL === '1') await systemctl(UNITS[id], on ? 'start' : 'stop');
      await api.probe(id);
      return { ...status[id], control: process.env.CC_SERVICE_CONTROL === '1' ? 'systemctl' : 'recorded' };
    },
  };
  return api;
}

module.exports = { createServices, IDS, probeHttp };
