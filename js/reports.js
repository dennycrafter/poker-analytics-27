// Tier 3 aggregation (brief 5.11-5.13): period grouping for Calendar and the
// heatmaps, hour-of-day minute splitting, and the Reports dimensions.
// Pure functions, no DOM. Every money/rate number is produced by the shared
// section-7 formulas in stats.js; this module only decides WHICH sessions
// (or which share of a session) fall into each bucket.

import * as S from './stats.js';
import { monthKey } from './format.js';
import { stakesKey } from './filters.js';
import { splitByHour, hourLabel } from './hours.js';

export { splitByHour, overlapsHour, hourLabel, hourRangeLabel } from './hours.js';

const DAY_MS = 86400000;
const MONTHS3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// ---------------------------------------------------------------------------
// Period keys (local time — brief 7: "display and group by local time").
// day 'YYYY-MM-DD' · week = Monday's day key · month 'YYYY-MM' · year 'YYYY'.

export const dayKeyOf = s => S.localDayKey(new Date(s.start_time));
export const monthKeyOf = s => monthKey(new Date(s.start_time));
export const yearKeyOf = s => String(new Date(s.start_time).getFullYear());
export function weekKeyOf(s) {
  const d = new Date(s.start_time);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return S.localDayKey(d);
}

export function groupBy(list, keyFn) {
  const m = new Map();
  for (const x of list) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

function parseDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function lastDayOfMonth(y, m1) { return new Date(y, m1, 0).getDate(); }

// Inclusive local-date range {from, to} ('YYYY-MM-DD') for a period key —
// exactly what the Feed's custom date-range filter consumes.
export function periodRange(kind, key) {
  if (kind === 'day') return { from: key, to: key };
  if (kind === 'week') {
    const end = parseDay(key);
    end.setDate(end.getDate() + 6);
    return { from: key, to: S.localDayKey(end) };
  }
  if (kind === 'month') {
    const [y, m] = key.split('-').map(Number);
    return { from: `${key}-01`, to: `${key}-${String(lastDayOfMonth(y, m)).padStart(2, '0')}` };
  }
  return { from: `${key}-01-01`, to: `${key}-12-31` }; // year
}

export function periodLabel(kind, key) {
  if (kind === 'day') {
    const d = parseDay(key);
    return `${d.getDate()} ${MONTHS3[d.getMonth()]} ${d.getFullYear()}`;
  }
  if (kind === 'week') {
    const d = parseDay(key);
    return `Week of ${d.getDate()} ${MONTHS3[d.getMonth()]} ${d.getFullYear()}`;
  }
  if (kind === 'month') {
    const [y, m] = key.split('-').map(Number);
    return `${MONTHS3[m - 1]} ${y}`;
  }
  return key;
}

// Every month key from the earliest session's month to `now`'s month, newest first.
export function monthSpan(sessions, nowMs = Date.now()) {
  if (!sessions.length) return [];
  const first = new Date(Math.min(...sessions.map(s => Date.parse(s.start_time))));
  const now = new Date(nowMs);
  const out = [];
  const d = new Date(now.getFullYear(), now.getMonth(), 1);
  const stop = new Date(first.getFullYear(), first.getMonth(), 1);
  while (d >= stop) { out.push(monthKey(d)); d.setMonth(d.getMonth() - 1); }
  return out;
}

// Rolling "30 last days" window — same bounds as the Feed/Stats "Last 30 days" filter.
export function last30Days(sessions, nowMs = Date.now()) {
  const from = nowMs - 30 * DAY_MS;
  return sessions.filter(s => Date.parse(s.start_time) >= from);
}

// ---------------------------------------------------------------------------
// Hour-of-day buckets (brief 5.13 "Day Time Efficiency"); splitting in hours.js.
// 24 buckets. Each session's net result and played hours are attributed in
// proportion to the wall-clock minutes it spent in that hour, so Σ net and
// Σ hours over the 24 buckets equal the Statistics totals. Breaks are spread
// evenly across the span (no record of when a break happened).
export function hourBuckets(doc, sessions, mode = 'net') {
  const b = Array.from({ length: 24 }, (_, h) => ({ key: h, minutes: 0, hours: 0, net: 0, sessions: [] }));
  for (const s of sessions) {
    const mins = splitByHour(s);
    const wall = mins.reduce((a, x) => a + x, 0);
    if (!(wall > 0)) continue;
    const net = S.sessionNet(doc, s, mode);
    const played = S.sessionHours(s);
    mins.forEach((m, h) => {
      if (m <= 0) return;
      const f = m / wall;
      b[h].minutes += m;
      b[h].hours += played * f;
      b[h].net += net * f;
      b[h].sessions.push(s);
    });
  }
  return b.map(x => ({
    ...x,
    label: hourLabel(x.key),
    count: x.sessions.length,
    rate: x.hours > 0 ? x.net / x.hours : null,
  }));
}

// ---------------------------------------------------------------------------
// Reports dimensions (brief 5.13). Generic buckets run the shared formulas
// (totalNet / netHourlyRate) on each bucket's sessions.

function tableLabel(n) { return Number(n) === 2 ? 'Heads-up' : `${n}-max`; }
function numSort(a, b) { return Number(a) - Number(b); }

export const DIMENSIONS = [
  { id: 'hour', title: 'Day Time Efficiency', hourly: true, feed: k => ({ hour: Number(k) }) },
  { id: 'weekday', title: 'Day of Week',
    key: s => (new Date(s.start_time).getDay() + 6) % 7, label: k => WEEKDAY_NAMES[k], sort: numSort },
  { id: 'duration', title: 'Duration',
    key: s => Math.floor(S.sessionHours(s)), label: k => `>= ${k}:00 < ${Number(k) + 1}:00`, sort: numSort },
  { id: 'general', title: 'General',
    key: s => s.kind, label: k => (k === 'cash' ? 'Cash game' : 'Tournament'),
    sort: (a, b) => (a === 'cash' ? -1 : b === 'cash' ? 1 : 0), feed: k => ({ kind: k }) },
  { id: 'location', title: 'Locations',
    key: s => s.location_id || '', label: (k, doc) => ((doc.locations.find(l => l.id === k) || {}).name || 'No location'),
    feed: k => (k ? { location_ids: [k] } : null) },
  { id: 'stakes', title: 'Stakes', pick: S.cashOnly,
    key: s => stakesKey(s), label: k => k,
    sort: (a, b) => Number(a.split('/')[1]) - Number(b.split('/')[1]), feed: k => ({ stakes: [k] }) },
  { id: 'table', title: 'Table size',
    key: s => Number(s.table_size) || 0, label: k => (k ? tableLabel(k) : 'Unknown'), sort: numSort },
  { id: 'buyin', title: 'Tournament Buy-in', pick: S.tournamentsOnly, money: true,
    key: s => Number(s.initial_buy_in) || 0, label: k => k, sort: numSort },
];

export function dimensionBuckets(doc, dim, sessions, mode = 'net') {
  if (dim.hourly) return hourBuckets(doc, sessions, mode);
  const list = dim.pick ? dim.pick(sessions) : sessions;
  const groups = groupBy(list, dim.key);
  const keys = [...groups.keys()];
  if (dim.sort) keys.sort(dim.sort);
  else keys.sort((a, b) => String(dim.label(a, doc)).localeCompare(String(dim.label(b, doc))));
  return keys.map(k => {
    const l = groups.get(k);
    return {
      key: k, label: dim.label(k, doc), sessions: l, count: l.length,
      hours: S.durationOfPlay(l), net: S.totalNet(doc, l, mode), rate: S.netHourlyRate(doc, l, mode),
    };
  });
}

// Best bucket by net result and by net hourly rate (buckets with play only).
export function bestOf(buckets) {
  const played = buckets.filter(b => b.count > 0);
  const byNet = played.length ? played.reduce((a, b) => (b.net > a.net ? b : a)) : null;
  const rated = played.filter(b => b.rate !== null && Number.isFinite(b.rate));
  const byRate = rated.length ? rated.reduce((a, b) => (b.rate > a.rate ? b : a)) : null;
  return { byNet, byRate };
}

// ---------------------------------------------------------------------------
// Highlights: best day / week / month / year by net result, biggest single
// win and loss.

export function bestPeriod(doc, sessions, kind, mode = 'net') {
  const keyFn = { day: dayKeyOf, week: weekKeyOf, month: monthKeyOf, year: yearKeyOf }[kind];
  let best = null;
  for (const [k, l] of groupBy(sessions, keyFn)) {
    const net = S.totalNet(doc, l, mode);
    if (!best || net > best.net) best = { kind, key: k, net, count: l.length };
  }
  return best;
}

export function extremeSessions(doc, sessions, mode = 'net') {
  let win = null, loss = null;
  for (const s of sessions) {
    const n = S.sessionNet(doc, s, mode);
    if (!win || n > win.net) win = { session: s, net: n };
    if (!loss || n < loss.net) loss = { session: s, net: n };
  }
  return { win, loss };
}

// ---------------------------------------------------------------------------
// Heatmap colour level: 'none' (no sessions), 'zero', or pos/neg with a 1-3
// intensity relative to the largest absolute value shown on the grid.

export function heatLevel(net, count, maxAbs) {
  if (!count) return 'none';
  if (!net || Math.abs(net) < 0.005) return 'zero';
  const r = maxAbs > 0 ? Math.abs(net) / maxAbs : 1;
  const lvl = r > 2 / 3 ? 3 : r > 1 / 3 ? 2 : 1;
  return (net > 0 ? 'pos-' : 'neg-') + lvl;
}

// Net + count per period key, for the heatmaps.
export function periodTotals(doc, sessions, keyFn, mode = 'net') {
  const out = new Map();
  for (const [k, l] of groupBy(sessions, keyFn)) out.set(k, { net: S.totalNet(doc, l, mode), count: l.length, sessions: l });
  return out;
}
