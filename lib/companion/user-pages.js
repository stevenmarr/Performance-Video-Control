'use strict';
// 0.33.0: USER PAGES. A page that came out of Control Center (a live deck page, a PAGES library page) can be placed in
// Companion as its own copy and edited there; editing never changes the Control Center original. An edited copy can be
// saved back here as a user page. User pages live in the app's data dir (companion-user-pages.json), so they are
// backed up with Control Center and listed on its COMPANION tab and in PV Companion's "Control Center pages".
//
// A user page is a Companion page export (version 6 page content) plus the connections it refers to. Only each
// connection's label, module id and upgrade index are kept: never its config or secrets.
const crypto = require('crypto');
const path = require('path');
const { readJson, writeJsonAtomic } = require('../store');

const MAX_PAGES = 200;
const MAX_BYTES = 1.5e6;
const fail = (status, message) => Object.assign(new Error(message), { status });
const str = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

function cleanInstances(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, c] of Object.entries(raw).slice(0, 64)) {
    if (!c || typeof c !== 'object' || !/^[\w-]{1,64}$/.test(id)) continue;
    const moduleId = str(c.moduleId || c.instance_type, 80);
    if (!moduleId) continue;
    out[id] = { label: str(c.label, 60) || id, moduleId, lastUpgradeIndex: Number.isInteger(c.lastUpgradeIndex) ? c.lastUpgradeIndex : -1 };
  }
  return out;
}

function cleanPage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail(400, 'page must be a Companion page export');
  if (!raw.controls || typeof raw.controls !== 'object') throw fail(400, 'page has no controls');
  const page = JSON.parse(JSON.stringify(raw));
  page.name = str(page.name, 60);
  return page;
}

class UserPages {
  constructor({ dataDir } = {}) {
    this.file = dataDir ? path.join(dataDir, 'companion-user-pages.json') : null;
    const raw = this.file ? readJson(this.file, {}) : {};
    this.pages = Array.isArray(raw.pages) ? raw.pages.filter((p) => p && p.id && p.page) : [];
  }

  _save() { if (this.file) writeJsonAtomic(this.file, { version: 1, pages: this.pages }); }

  summary(p) {
    const controls = p.page && p.page.controls ? Object.values(p.page.controls).reduce((n, row) => n + Object.keys(row || {}).length, 0) : 0;
    return { id: p.id, name: p.name, origin: p.origin || '', originTitle: p.originTitle || '', surfaceLayout: (p.page && p.page.surfaceLayout) || '', controls, connections: Object.values(p.instances || {}).map((c) => ({ label: c.label, moduleId: c.moduleId })), createdAt: p.createdAt, updatedAt: p.updatedAt };
  }

  list() { return this.pages.map((p) => this.summary(p)).sort((a, b) => a.name.localeCompare(b.name) || b.updatedAt - a.updatedAt); }

  must(id) {
    const p = this.pages.find((x) => x.id === id);
    if (!p) throw fail(404, `No user page "${id}"`);
    return p;
  }

  // body: { id? (update that page), name, page, instances, version (the Companion export file version the page is
  // in: PV Companion 5.1 sends 17; Control Center's own exports are 6), origin?, originTitle? }
  save(body = {}) {
    const page = cleanPage(body.page);
    const version = Number.isInteger(body.version) && body.version >= 1 && body.version <= 99 ? body.version : 6;
    const instances = cleanInstances(body.instances);
    const name = str(body.name, 60) || page.name || 'User page';
    page.name = name;
    if (JSON.stringify(page).length > MAX_BYTES) throw fail(413, 'That page is too large to save');
    const now = Date.now();
    if (body.id) {
      const p = this.must(String(body.id));
      Object.assign(p, { name, page, instances, version, updatedAt: now });
      if (body.origin != null) p.origin = str(body.origin, 120);
      this._save();
      return this.summary(p);
    }
    if (this.pages.length >= MAX_PAGES) throw fail(409, `At most ${MAX_PAGES} user pages`);
    const p = { id: `u${crypto.randomBytes(5).toString('hex')}`, name, version, origin: str(body.origin, 120), originTitle: str(body.originTitle, 80), page, instances, createdAt: now, updatedAt: now };
    this.pages.push(p);
    this._save();
    return this.summary(p);
  }

  rename(id, name) {
    const p = this.must(id);
    const n = str(name, 60);
    if (!n) throw fail(400, 'Name the page');
    p.name = n; p.page.name = n; p.updatedAt = Date.now();
    this._save();
    return this.summary(p);
  }

  remove(id) {
    this.must(id);
    this.pages = this.pages.filter((p) => p.id !== id);
    this._save();
    return { ok: true };
  }

  // a .companionconfig download (and what PV Companion imports)
  companionConfig(id) {
    const p = this.must(id);
    const body = { version: p.version || 6, type: 'page', page: p.page, instances: p.instances, oldPageNumber: 1 };
    const safe = p.name.replace(/[^\w .()-]/g, '_').replace(/\s+/g, ' ').trim() || 'User page';
    return { name: `${safe}.companionconfig`, body: JSON.stringify(body, null, 2), json: body };
  }
}

module.exports = { UserPages, cleanInstances };
