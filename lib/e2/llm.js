'use strict';
// Optional mapper for JSON fields the schema does not recognize.
//
// Steven's note was that the Event Master document changes with the show file,
// and that a model might be the way to cope. A guess that moves the wrong
// number onto Program is worse than a dial that is simply absent. So this stays
// off unless the server process has E2_LLM_MAP=1 and E2_LLM_API_KEY set in the
// environment. The key is never written into the repo, the logs, or the review
// file. A proposal is applied only when it names a property the desk already
// knows how to send, and only at high confidence. Everything it suggests is
// kept on the programming view so it can be checked.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { PROPOSAL_FIELDS } = require('./schema');

function enabled() {
  return String(process.env.E2_LLM_MAP || '') === '1';
}

function apiKey() {
  const k = process.env.E2_LLM_API_KEY;
  return k && String(k).trim() ? String(k).trim() : '';
}

function cacheKey(unknown) {
  const body = (unknown || []).map((u) => `${u.path}:${u.type}`).sort().join('|');
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 24);
}

function readCache(dir) {
  if (!dir) return {};
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'e2-llm-cache.json'), 'utf8'));
  } catch {
    return {};
  }
}

function writeCache(dir, all) {
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'e2-llm-cache.json'), JSON.stringify(all, null, 2));
  } catch {
    /* a cache miss next time is safe */
  }
}

function accept(raw) {
  const list = Array.isArray(raw) ? raw : (raw && raw.proposals) || [];
  const known = new Set([...Object.keys(PROPOSAL_FIELDS), 'ignore']);
  const out = [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const prop = String(row.prop || row.property || '');
    const p = String(row.path || '');
    const confidence = Number(row.confidence);
    if (!p || !known.has(prop)) continue;
    if (!Number.isFinite(confidence)) continue;
    out.push({ path: p, prop, confidence: Math.max(0, Math.min(1, confidence)), note: String(row.note || '').slice(0, 160) });
  }
  return out;
}

async function defaultComplete(unknown) {
  const url = process.env.E2_LLM_URL || 'https://api.openai.com/v1/chat/completions';
  const model = process.env.E2_LLM_MODEL || 'gpt-4o-mini';
  const vocab = Object.keys(PROPOSAL_FIELDS).concat(['ignore']).join(', ');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey()}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `You map unknown Barco Event Master JSON fields onto a fixed list. Reply with JSON only: {"proposals":[{"path":"...","prop":"...","confidence":0.0,"note":"..."}]}. prop must be one of: ${vocab}. Use ignore when unsure. Never invent a property name.`,
        },
        { role: 'user', content: JSON.stringify(unknown.map((u) => ({ path: u.path, type: u.type, sample: u.sample }))) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM mapper HTTP ${res.status}`);
  const body = await res.json();
  const text = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
  return JSON.parse(String(text || '{}').replace(/^```json\s*|\s*```$/g, ''));
}

async function mapUnknown(unknown, opts = {}) {
  const rows = unknown || [];
  if (!enabled()) return { enabled: false, reason: 'E2_LLM_MAP is not 1', proposals: [], cached: false };
  if (!rows.length) return { enabled: true, reason: null, proposals: [], cached: false };
  if (!apiKey() && !opts.complete) return { enabled: false, reason: 'E2_LLM_API_KEY is not set', proposals: [], cached: false };
  const key = cacheKey(rows);
  const mem = opts.memory || mapUnknown.memory;
  if (mem.has(key)) return { enabled: true, reason: null, proposals: mem.get(key), cached: true };
  const disk = readCache(opts.cacheDir);
  if (disk[key]) {
    mem.set(key, disk[key]);
    return { enabled: true, reason: null, proposals: disk[key], cached: true };
  }
  const complete = opts.complete || defaultComplete;
  let parsed;
  try {
    parsed = await complete(rows);
  } catch (e) {
    return { enabled: true, reason: e.message, proposals: [], cached: false };
  }
  const proposals = accept(parsed);
  mem.set(key, proposals);
  disk[key] = proposals;
  writeCache(opts.cacheDir, disk);
  return { enabled: true, reason: null, proposals, cached: false };
}

mapUnknown.memory = new Map();

function publicStatus(result) {
  const r = result || { enabled: false, reason: 'not run', proposals: [] };
  return {
    enabled: !!r.enabled,
    reason: r.reason || null,
    cached: !!r.cached,
    proposals: (r.proposals || []).length,
  };
}

module.exports = { mapUnknown, accept, publicStatus, enabled, cacheKey, LONG_PRESS_NOTE: 'Hold a dial for 800 ms to reset. A short press swaps the pair.' };
