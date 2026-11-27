'use strict';
// Format-aware shutter step lists for the AW-UE150 / UE150A / UE160 families.
// Source: Panasonic interface specs (COMMANDS.md §3.3). OSJ:06 is the denominator
// as 4 hex digits. A value that is not valid for the current format is refused (ER3).

const UE150_COMMON = [100, 120, 250, 500, 1000, 2000, 4000, 8000, 10000];
const UE160_COMMON = [100, 120, 125, 250, 500, 1000, 1500, 2000];

// Family lists. The leading frame-rate stop is included only where the spec lists it.
const LISTS = {
  ue150: {
    '59.94': [60, ...UE150_COMMON],
    '60': [60, ...UE150_COMMON],
    '50': [60, ...UE150_COMMON],
    '29.97': [30, 60, ...UE150_COMMON],
    '25': [25, 50, 60, ...UE150_COMMON],
    '23.98': [24, 48, 60, ...UE150_COMMON],
    '24': [24, 48, 60, ...UE150_COMMON],
  },
  ue160: {
    '59.94': UE160_COMMON,
    '60': UE160_COMMON,
    '50': [60, 100, 125, 250, 500, 1000, 1500, 2000],
    '29.97': [48, 50, 60, 96, 100, 120, 125, 250, 500, 1000, 1500, 2000],
    '25': [48, 50, 60, 96, 100, 125, 250, 500, 1000, 1500, 2000],
    '23.98': [48, 50, 60, 96, 100, 120, 125, 250, 500, 1000, 1500, 2000],
    '24': [48, 50, 60, 96, 100, 120, 125, 250, 500, 1000, 1500, 2000],
    '119.88': [125, 250, 500, 1000, 1500, 2000],
    '120': [125, 250, 500, 1000, 1500, 2000],
    '100': [125, 250, 500, 1000, 1500, 2000],
  },
};

// OSA:87 data (hex, no 0x) → a rate family used to pick the list.
// UE150 / UE150A (spec p.42) and UE160 (spec p.35) share many codes; a few differ.
const FORMAT_UE150 = {
  '1':  { label: '720/59.94p', rate: '59.94' },
  '2':  { label: '720/50p', rate: '50' },
  '4':  { label: '1080/59.94i', rate: '59.94' },
  '5':  { label: '1080/50i', rate: '50' },
  '7':  { label: '1080/29.97psF', rate: '29.97' },
  '8':  { label: '1080/25psF', rate: '25' },
  'A':  { label: '1080/23.98psF', rate: '23.98' },
  '10': { label: '1080/59.94p', rate: '59.94' },
  '11': { label: '1080/50p', rate: '50' },
  '14': { label: '1080/29.97p', rate: '29.97' },
  '15': { label: '1080/25p', rate: '25' },
  '16': { label: '1080/23.98p (59.94)', rate: '23.98' },
  '17': { label: '2160/29.97p', rate: '29.97' },
  '18': { label: '2160/25p', rate: '25' },
  '19': { label: '2160/59.94p', rate: '59.94' },
  '1A': { label: '2160/50p', rate: '50' },
  '1B': { label: '2160/23.98p', rate: '23.98' },
  '21': { label: '2160/24p', rate: '24' },
  '22': { label: '1080/24p', rate: '24' },
  '23': { label: '1080/23.98p', rate: '23.98' },
};

const FORMAT_UE160 = {
  '1':  { label: '720/59.94p', rate: '59.94' },
  '2':  { label: '720/50p', rate: '50' },
  '10': { label: '1080/59.94p', rate: '59.94' },
  '11': { label: '1080/50p', rate: '50' },
  '14': { label: '1080/29.97p', rate: '29.97' },
  '15': { label: '1080/25p', rate: '25' },
  '17': { label: '2160/29.97p', rate: '29.97' },
  '18': { label: '2160/25p', rate: '25' },
  '19': { label: '2160/59.94p', rate: '59.94' },
  '1A': { label: '2160/50p', rate: '50' },
  '1B': { label: '2160/23.98p', rate: '23.98' },
  '20': { label: '1080/60p', rate: '60' },
  '21': { label: '2160/24p', rate: '24' },
  '22': { label: '1080/24p', rate: '24' },
  '23': { label: '1080/23.98p', rate: '23.98' },
  '26': { label: '1080/119.88p', rate: '119.88' },
  '27': { label: '1080/100p', rate: '100' },
};

function normCode(v) {
  if (v == null || v === '') return '';
  const s = String(v).replace(/^0x/i, '').toUpperCase();
  const n = parseInt(s, 16);
  if (!Number.isFinite(n)) return s.replace(/^0+/, '') || '0';
  return n.toString(16).toUpperCase();
}

function isUe160(model) {
  const m = String(model || '').toUpperCase();
  return /\bAW-UE160\b/.test(m) || m.includes('UE160');
}

function formatInfo(model, code) {
  const table = isUe160(model) ? FORMAT_UE160 : FORMAT_UE150;
  const key = normCode(code);
  return table[key] || null;
}

function rateFamily(model, format) {
  if (format && typeof format === 'object' && format.rate) return format.rate;
  const info = formatInfo(model, format);
  if (info) return info.rate;
  const label = String(format || '');
  const hit = label.match(/(\d+(?:\.\d+)?)\s*[ip]/i);
  if (hit) {
    const n = hit[1];
    if (n === '59.94' || n === '29.97' || n === '23.98' || n === '119.88') return n;
    if (n === '50' || n === '25' || n === '24' || n === '60' || n === '100' || n === '120') return n;
  }
  // House profile is 2160/59.94p. Until the camera reports a format, use that list.
  return '59.94';
}

function shutterDenominators(model, format) {
  const family = isUe160(model) ? 'ue160' : 'ue150';
  const rate = rateFamily(model, format);
  const list = (LISTS[family] && LISTS[family][rate]) || LISTS[family]['59.94'];
  return list.slice();
}

function shutterOptions(model, format) {
  return shutterDenominators(model, format).map((n) => [String(n), `1/${n}`]);
}

module.exports = {
  LISTS, FORMAT_UE150, FORMAT_UE160,
  normCode, isUe160, formatInfo, rateFamily, shutterDenominators, shutterOptions,
};
