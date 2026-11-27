'use strict';
// Clock and countdown math for the status wall. No device calls live here.
// A show clock counts down to a time of day. A playback clock is time remaining
// on a clip. Amber means under 30 seconds and red means under 10, unless a
// tile sets its own numbers.

const DEFAULT_ZONE = 'America/Chicago';

function resolveZone(name) {
  const want = String(name || '').trim() || DEFAULT_ZONE;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: want }).format(0);
    return { timeZone: want, fallback: false };
  } catch {
    return { timeZone: DEFAULT_ZONE, fallback: true };
  }
}

function zoneParts(date, timeZone) {
  const zone = resolveZone(timeZone).timeZone;
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) if (p.type !== 'literal') parts[p.type] = Number(p.value);
  if (parts.hour === 24) parts.hour = 0;
  return parts;
}

// Wall time in a zone, as a UTC instant. The guess-and-correct step is the
// usual way to do this without a timezone library.
function zonedToEpoch(y, month, day, h, mi, s, timeZone) {
  const zone = resolveZone(timeZone).timeZone;
  const utcGuess = Date.UTC(y, month - 1, day, h, mi, s);
  const seen = zoneParts(new Date(utcGuess), zone);
  const asUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
  return utcGuess - (asUtc - utcGuess);
}

function formatClock(date, opts = {}) {
  const zone = resolveZone(opts.timeZone);
  const hour12 = opts.hour12 !== false;
  const when = date instanceof Date ? date : new Date(date);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: zone.timeZone,
    hour: 'numeric', minute: '2-digit', second: '2-digit',
    hour12, hourCycle: hour12 ? 'h12' : 'h23',
  }).format(when);
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: zone.timeZone, weekday: 'long', month: 'long', day: 'numeric',
  }).format(when);
  return { time, date: day, timeZone: zone.timeZone, hour12, zoneFallback: zone.fallback };
}

// "01:02:03:15" is hours, minutes, seconds, frames (30 fps unless told otherwise).
// "01:02:03.5" is a fraction of a second. "12:03" is minutes and seconds.
function parseTimecode(value, fps = 30) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  if (!s || /^nan$/i.test(s)) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = /^(-)?(?:(\d+):)?(\d+):(\d+)(?:([:;.])(\d+))?$/.exec(s);
  if (!m) return null;
  const sign = m[1] ? -1 : 1;
  const h = m[2] != null ? Number(m[2]) : 0;
  const min = Number(m[3]);
  const sec = Number(m[4]);
  if (min > 59 || sec > 59) return null;
  let extra = 0;
  if (m[6] != null) {
    if (m[5] === '.') extra = Number(m[6]) / (10 ** m[6].length);
    else {
      const rate = Number(fps) > 0 ? Number(fps) : 30;
      extra = Number(m[6]) / rate;
    }
  }
  return sign * (h * 3600 + min * 60 + sec + extra);
}

function remainingSeconds(input = {}, fps = 30) {
  if (input.remaining != null && input.remaining !== '') {
    const r = parseTimecode(input.remaining, fps);
    if (r != null) return r;
  }
  const dur = parseTimecode(input.duration != null ? input.duration : input.length, fps);
  const pos = parseTimecode(input.elapsed != null ? input.elapsed : input.position, fps);
  if (dur != null && pos != null) return dur - pos;
  return null;
}

function warnLevel(seconds, warn = {}) {
  if (seconds == null || !Number.isFinite(seconds)) return 'none';
  if (seconds < 0) return 'over';
  const red = Number.isFinite(Number(warn.redSec)) ? Number(warn.redSec) : 10;
  const amber = Number.isFinite(Number(warn.amberSec)) ? Number(warn.amberSec) : 30;
  if (red > 0 && seconds < red) return 'red';
  if (amber > 0 && seconds < amber) return 'amber';
  return 'ok';
}

function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const over = seconds < 0;
  let whole = Math.floor(Math.abs(seconds));
  const s = whole % 60;
  whole = Math.floor(whole / 60);
  const m = whole % 60;
  const h = Math.floor(whole / 60);
  const body = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  return over ? `+${body}` : body;
}

function parseClockTime(value) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(String(value || '').trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const sec = m[3] ? Number(m[3]) : 0;
  const ap = m[4] ? m[4].toLowerCase() : '';
  if (min > 59 || sec > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === 'pm' && h !== 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
  } else if (h > 23) return null;
  return { h, min, sec };
}

// A countdown target: a clock time today ("7:00 PM", "19:00"), or a full date.
// A past clock time stays in the past (the tile says OVER). It does not jump to tomorrow.
function targetEpoch(value, now, timeZone) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  const zone = resolveZone(timeZone).timeZone;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
      const t = Date.parse(s);
      return Number.isFinite(t) ? t : null;
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
    if (!m) return null;
    return zonedToEpoch(+m[1], +m[2], +m[3], +m[4], +m[5], m[6] ? +m[6] : 0, zone);
  }
  const clock = parseClockTime(s);
  if (!clock) return null;
  const today = zoneParts(new Date(now), zone);
  return zonedToEpoch(today.year, today.month, today.day, clock.h, clock.min, clock.sec, zone);
}

function countdownRemaining(value, now, timeZone) {
  const at = targetEpoch(value, now, timeZone);
  if (at == null) return null;
  return { at, remainingSec: (at - now) / 1000 };
}

function formatAge(ms, now) {
  if (!ms) return 'not seen yet';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return s === 1 ? '1 second ago' : `${s} seconds ago`;
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? '1 minute ago' : `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 48) return h === 1 ? '1 hour ago' : `${h} hours ago`;
  const d = Math.round(h / 24);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

module.exports = {
  DEFAULT_ZONE, resolveZone, zoneParts, zonedToEpoch, formatClock, parseTimecode,
  remainingSeconds, warnLevel, formatDuration, parseClockTime, targetEpoch, countdownRemaining, formatAge,
};
