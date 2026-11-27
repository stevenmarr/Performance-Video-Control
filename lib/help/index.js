'use strict';
// In-app help (designer Phase C). Articles live in help/ next to the code.
// The tour never auto-starts (Q8).

const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', '..', 'help');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let list = null;
  let listItems = [];
  const flush = () => {
    if (!list) return;
    out.push('<' + list + '>' + listItems.join('') + '</' + list + '>');
    list = null;
    listItems = [];
  };
  const inline = (s) => escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^```/.test(line)) continue;
    if (/^###\s+/.test(line)) { flush(); out.push(`<h3>${inline(line.replace(/^###\s+/, ''))}</h3>`); continue; }
    if (/^##\s+/.test(line)) { flush(); out.push(`<h2>${inline(line.replace(/^##\s+/, ''))}</h2>`); continue; }
    if (/^#\s+/.test(line)) { flush(); out.push(`<h1>${inline(line.replace(/^#\s+/, ''))}</h1>`); continue; }
    const ul = line.match(/^[-*]\s+(.*)$/);
    const ol = line.match(/^\d+\.\s+(.*)$/);
    if (ul || ol) {
      const kind = ul ? 'ul' : 'ol';
      if (list && list !== kind) flush();
      list = kind;
      listItems.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    flush();
    out.push(`<p>${inline(line.trim())}</p>`);
  }
  flush();
  return out.join('\n');
}

function parseFrontMatter(text) {
  const m = String(text || '').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(text || '') };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    meta[kv[1]] = v;
  }
  return { meta, body: m[2] };
}

function walk(dir, acc = []) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return acc; }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const p = path.join(dir, name);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

class Help {
  constructor({ dir } = {}) {
    this.dir = dir || DEFAULT_DIR;
    this.articles = new Map();
    this.tips = {};
    this.tours = [];
    this.reload();
  }

  reload() {
    this.articles = new Map();
    this.tips = {};
    this.tours = [];
    for (const file of walk(this.dir)) {
      const rel = path.relative(this.dir, file).replace(/\\/g, '/');
      if (rel === 'tips.yml' || rel.endsWith('/tips.yml')) {
        this.tips = parseTips(fs.readFileSync(file, 'utf8'));
        continue;
      }
      if (/\.json$/.test(file) && /(^|\/)tours\//.test(rel)) {
        try {
          const tour = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (tour && tour.id) this.tours.push(tour);
        } catch { /* skip a bad tour file */ }
        continue;
      }
      if (!/\.md$/.test(file)) continue;
      const { meta, body } = parseFrontMatter(fs.readFileSync(file, 'utf8'));
      const id = String(meta.id || path.basename(file, '.md'));
      this.articles.set(id, {
        id,
        title: meta.title || id,
        tab: meta.tab || '',
        keywords: meta.keywords || '',
        since: meta.since || '',
        file: rel,
        body,
        html: renderMarkdown(body),
      });
    }
  }

  index() {
    return {
      articles: [...this.articles.values()].map(({ body, html, ...row }) => row),
      tips: this.tips,
      tours: this.tours.map((t) => ({
        id: t.id,
        title: t.title,
        steps: Array.isArray(t.steps) ? t.steps.length : 0,
        autoStart: t.autoStart === true,
      })),
    };
  }

  article(id) {
    const a = this.articles.get(String(id || ''));
    if (!a) {
      const err = new Error(`No help article "${id}"`);
      err.status = 404;
      throw err;
    }
    return a;
  }

  search(q) {
    const needle = String(q || '').trim().toLowerCase();
    if (!needle) return [];
    const hits = [];
    for (const a of this.articles.values()) {
      const hay = `${a.title} ${a.keywords} ${a.tab} ${a.body}`.toLowerCase();
      if (hay.includes(needle)) hits.push({ id: a.id, title: a.title, tab: a.tab });
    }
    return hits;
  }

  tour(id) {
    const t = this.tours.find((x) => x.id === (id || 'getting-started'));
    return t || null;
  }
}

function parseTips(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^([\w.-]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function mount(route, help) {
  const h = help || new Help();
  route('GET', /^\/api\/help\/index$/, () => h.index());
  route('GET', /^\/api\/help\/search$/, (b, m, url) => ({ hits: h.search(url.searchParams.get('q') || '') }));
  route('GET', /^\/api\/help\/tours$/, () => ({ tours: h.tours, autoStart: false }));
  route('GET', /^\/api\/help\/tours\/([\w-]+)$/, (b, m) => {
    const t = h.tour(m[1]);
    if (!t) { const e = new Error(`No tour "${m[1]}"`); e.status = 404; throw e; }
    return t;
  });
  route('GET', /^\/api\/help\/([^/]+)$/, (b, m) => h.article(m[1]));
  return h;
}

module.exports = { Help, renderMarkdown, parseFrontMatter, parseTips, mount, DEFAULT_DIR };
