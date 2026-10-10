// Breakdown tables (brief iteration 3). Pure module: no DOM, no store, no clock.
//
// byWeekday(doc, sessions, mode) — one row per LOCAL weekday of start_time
//   (Monday first, the same keys and labels as the Reports "Day of Week"
//   dimension in js/reports.js). All 7 rows are always returned; a weekday
//   with no sessions shows zeros and null rates.
//
// resultHistogram(values, targetBuckets, netFn) — equal-width session-count
//   buckets over the profit range, padded to include 0. Pass plain profit
//   numbers, or sessions plus a netFn(session) -> profit mapper.
//
// SD per hour is the brief section 7 formula, implemented locally (the
// js/stats.js stdDevPerHour variant divides the same weighted residuals by
// total hours instead; the brief divides by k - 1):
//   SD/hr = sqrt( sum( (p_i - WR*h_i)^2 / h_i ) / (k - 1) ),  WR = sum(p_i) / sum(h_i)
// Sessions with zero played hours have a defined profit but an undefined
// hourly residual (h_i = 0 divides), so they count toward a row's profit and
// hours but not its SD sum; inside the SD, WR and k run over timed sessions.
//
// Imports stay light (stats.js only) so plain `node tests/it3-breakdowns.test.mjs`
// works: importing js/reports.js for its WEEKDAY_NAMES would drag in
// filters.js -> store.js -> supabase-client.js, which needs a WebSocket shim.

import { sessionNet, sessionHours } from './stats.js';

// Same Monday-first names and (getDay() + 6) % 7 keys as the Reports
// "Day of Week" dimension (WEEKDAY_NAMES in js/reports.js).
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function byWeekday(doc, sessions, mode = 'net') {
  const groups = WEEKDAY_NAMES.map((label, weekday) => ({ weekday, label, list: [] }));
  for (const s of sessions) groups[(new Date(s.start_time).getDay() + 6) % 7].list.push(s);
  return groups.map(({ weekday, label, list }) => {
    const profit = list.reduce((a, s) => a + sessionNet(doc, s, mode), 0);
    const hours = list.reduce((a, s) => a + sessionHours(s), 0);
    const timed = list
      .map(s => ({ p: sessionNet(doc, s, mode), h: sessionHours(s) }))
      .filter(x => x.h > 0);
    return {
      weekday, label, profit, hours,
      perHour: hours > 0 ? profit / hours : null,
      sdPerHour: sdPerHourOf(timed),
    };
  });
}

// Brief section 7, exact. Needs at least 2 timed sessions and a positive hour
// total; otherwise there is no meaningful SD and the row shows null.
function sdPerHourOf(timed) {
  const k = timed.length;
  const H = timed.reduce((a, x) => a + x.h, 0);
  if (k < 2 || !(H > 0)) return null;
  const wr = timed.reduce((a, x) => a + x.p, 0) / H;
  const ss = timed.reduce((a, x) => a + ((x.p - wr * x.h) ** 2) / x.h, 0);
  return Math.sqrt(ss / (k - 1));
}

// Equal-width count buckets over [min(0, min), max(0, max)]. A non-finite
// profit throws rather than silently corrupting the counts.
export function resultHistogram(values, targetBuckets = 20, netFn = v => v) {
  const nets = [];
  for (const v of values) {
    const n = Number(netFn(v));
    if (!Number.isFinite(n)) throw new TypeError('resultHistogram: profit values must be finite numbers');
    nets.push(n);
  }
  if (!nets.length) return [];
  let lo = 0, hi = 0; // padded range: always spans 0
  for (const v of nets) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (hi === lo) return [{ lo, hi, count: nets.length }];
  const n = Math.max(1, Math.floor(Number(targetBuckets) || 20));
  const width = (hi - lo) / n;
  const buckets = Array.from({ length: n }, (_, i) => ({ lo: lo + i * width, hi: lo + (i + 1) * width, count: 0 }));
  buckets[n - 1].hi = hi; // exact upper edge; a value equal to the max clamps into the last bucket
  for (const v of nets) buckets[Math.min(n - 1, Math.floor((v - lo) / width))].count++;
  return buckets;
}
