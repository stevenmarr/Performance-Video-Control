'use strict';
// Companion page placement (designer Phase B, Q7). Companion has no page
// cap, so Control Center does not reserve a number range. It tags the pages
// it owns, appends new ones after the user's last hand-built page, and only
// ever rewrites pages that still carry its tag.

const TAG_RE = /^cc:[a-z0-9]+(?:[.-][a-z0-9]+)*$/i;

function tagFor(pageId) {
  const id = String(pageId || '').trim().toLowerCase();
  if (!id) throw Object.assign(new Error('A Control Center page needs a stable id'), { status: 400 });
  return `cc:${id}`;
}

function displayName(title) {
  const name = String(title || '').trim() || 'Page';
  return name.startsWith('CC · ') ? name : `CC · ${name}`;
}

function tagOf(page) {
  if (!page || typeof page !== 'object') return null;
  const raw = page.tag || page.ccPage || page['cc-page'] || page.cc_tag;
  const tag = raw == null ? '' : String(raw).trim();
  if (TAG_RE.test(tag)) return tag.toLowerCase();
  return null;
}

function isCcTagged(page) {
  return !!tagOf(page);
}

function lastHandBuiltIndex(pages) {
  const list = Array.isArray(pages) ? pages : [];
  let last = -1;
  for (let i = 0; i < list.length; i++) if (!isCcTagged(list[i])) last = i;
  return last;
}

// existingPages: Companion's current page list (index = order, 0-based).
// ccPages: [{ id, title, ...fields }] Control Center pages to place.
// Returns a new list plus a report. Untagged pages are never rewritten or moved.
function placeCcPages(existingPages, ccPages) {
  const pages = (Array.isArray(existingPages) ? existingPages : []).map((p) => (p && typeof p === 'object' ? { ...p } : p));
  const wanted = Array.isArray(ccPages) ? ccPages : [];
  const report = { rewritten: [], appended: [], untouched: [], skipped: [] };

  const indexByTag = new Map();
  pages.forEach((p, i) => {
    const tag = tagOf(p);
    if (tag && !indexByTag.has(tag)) indexByTag.set(tag, i);
    if (!tag) report.untouched.push({ index: i, name: p && (p.name || p.title) || `page ${i + 1}` });
  });

  for (const src of wanted) {
    if (!src || !src.id) {
      report.skipped.push({ reason: 'missing id' });
      continue;
    }
    const tag = tagFor(src.id);
    const name = displayName(src.title || src.name || src.id);
    const body = { ...src, tag, name, 'cc-page': tag };
    const at = indexByTag.get(tag);
    if (at != null) {
      const prev = pages[at];
      if (isCcTagged(prev) && tagOf(prev) === tag) {
        pages[at] = { ...prev, ...body };
        report.rewritten.push({ index: at, tag, name });
      } else {
        // Defensive: never overwrite an untagged page even if the map was stale.
        pages.push(body);
        indexByTag.set(tag, pages.length - 1);
        report.appended.push({ index: pages.length - 1, tag, name });
      }
    } else {
      pages.push(body);
      indexByTag.set(tag, pages.length - 1);
      report.appended.push({ index: pages.length - 1, tag, name });
    }
  }

  report.lastHandBuiltIndex = lastHandBuiltIndex(pages);
  report.appendedAfterHandBuilt = report.appended.every((row) => row.index > report.lastHandBuiltIndex);
  return { pages, report };
}

module.exports = {
  tagFor, displayName, tagOf, isCcTagged, lastHandBuiltIndex, placeCcPages, TAG_RE,
};
