// Iteration 3 verification harness: Reports breakdowns (js/breakdowns.js).
// Usage: TZ=UTC node tests/it3-breakdowns.test.mjs
//
// Weekday grouping is exercised with sessions built from LOCAL Date
// constructors at local noon, so each session's LOCAL weekday is exact under
// whatever timezone the battery runs in (harness convention: TZ=UTC). The
// SD/hr check uses a fixture with a closed-form answer that DISTINGUISHES the
// brief section 7 formula (divide by k - 1) from the stats.js hours-weighted
// variant (divide by total hours): two 1h sessions +55 and -45 give
// SD = sqrt(5000) ~ 70.71 under the brief formula, 50 under the stats one.

import assert from 'node:assert/strict';
import { byWeekday, resultHistogram } from '../js/breakdowns.js';
import { totalNet, durationOfPlay } from '../js/stats.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const within = (a, b, tol, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} vs ${b} (tol ${tol})`);

// ---- fixtures -----------------------------------------------------------------
// Local-noon sessions on known 2026 weekdays: Oct 5 = Monday, Oct 7 = Wednesday,
// Oct 10 = Saturday, Oct 11 = Sunday.
const doc = { settings: { currency: 'EUR' }, stack_events: [], sell_actions: [] };

function cash(id, y, mo, d, hours, buyIn, out, extra = {}) {
  const start = new Date(y, mo - 1, d, 12, 0, 0, 0);
  return {
    id, kind: 'cash', start_time: start.toISOString(),
    end_time: new Date(start.getTime() + hours * 3600e3).toISOString(),
    duration_seconds: hours * 3600, break_seconds: 0, is_live: false,
    tracked_via_stack: false, buy_in: buyIn, cashed_out: out, tips: 0, ...extra,
  };
}
const MON = [2026, 10, 5], WED = [2026, 10, 7], SUN = [2026, 10, 11];
const sessions = [
  cash('m1', ...MON, 1, 100, 155), // +55 over 1h, Monday
  cash('m2', ...MON, 1, 100, 55),  // -45 over 1h, Monday
  cash('w1', ...WED, 2, 200, 300), // +100 over 2h, Wednesday
  cash('s1', ...SUN, 1, 100, 70),  // -30 over 1h, Sunday
];

// ---- byWeekday ------------------------------------------------------------------

console.log('byWeekday (brief iteration 3, section 7 SD formula)');

test('always returns 7 rows, Monday-first with weekday 0..6 and labels', () => {
  const rows = byWeekday(doc, sessions);
  assert.equal(rows.length, 7);
  rows.forEach((r, i) => assert.equal(r.weekday, i));
  assert.deepEqual(rows.map(r => r.label),
    ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
});

test('groups profit and hours by the LOCAL weekday of each UTC start_time', () => {
  const rows = byWeekday(doc, sessions);
  assert.equal(rows[0].profit, 10, 'Monday = +55 and -45');    // 2026-10-05
  within(rows[0].hours, 2, 1e-12, 'Monday hours');
  assert.equal(rows[2].profit, 100, 'Wednesday');              // 2026-10-07
  within(rows[2].hours, 2, 1e-12, 'Wednesday hours');
  assert.equal(rows[6].profit, -30, 'Sunday');                 // 2026-10-11
  within(rows[6].hours, 1, 1e-12, 'Sunday hours');
  for (const i of [1, 3, 4, 5]) assert.equal(rows[i].profit, 0, `weekday ${i} untouched`);
});

test('near-midnight UTC instants one hour apart land on different local weekdays', () => {
  const sat2330 = new Date(2026, 9, 10, 23, 30).toISOString(); // 2026-10-10T23:30Z
  const sun0030 = new Date(2026, 9, 11, 0, 30).toISOString();  // 2026-10-11T00:30Z
  const mk = (id, t, out) => ({
    id, kind: 'cash', start_time: t, end_time: t, duration_seconds: 3600, break_seconds: 0,
    is_live: false, tracked_via_stack: false, buy_in: 100, cashed_out: out, tips: 0,
  });
  const rows = byWeekday(doc, [mk('a', sat2330, 120), mk('b', sun0030, 95)]);
  assert.equal(rows[5].profit, 20, 'Saturday 23:30 local');
  assert.equal(rows[6].profit, -5, 'Sunday 00:30 local');
});

test('SD/hr is the brief-7 formula (divide by k-1), NOT the stats.js hours-weighted variant', () => {
  // Monday: two 1h sessions +55/-45. WR = 5/h. Sum of (p_i - WR*h_i)^2 / h_i = 2500 + 2500 = 5000.
  // Brief: sqrt(5000 / (2-1)) = 70.7107...  stats.js variant would be sqrt(5000/2) = 50.
  const rows = byWeekday(doc, sessions);
  within(rows[0].sdPerHour, Math.sqrt(5000), 1e-9, 'Monday SD/hr');
  assert.ok(Math.abs(rows[0].sdPerHour - 50) > 20, 'must not equal the hours-weighted 50');
});

test('perHour is row profit / row hours; single-session weekdays have null SD', () => {
  const rows = byWeekday(doc, sessions);
  within(rows[0].perHour, 5, 1e-12, 'Monday $/hr');
  within(rows[2].perHour, 50, 1e-12, 'Wednesday $/hr');
  within(rows[6].perHour, -30, 1e-12, 'Sunday $/hr');
  assert.equal(rows[2].sdPerHour, null, 'one timed session: no SD');
  assert.equal(rows[6].sdPerHour, null, 'one timed session: no SD');
});

test('empty weekdays show zero profit/hours and null rates', () => {
  const r = byWeekday(doc, sessions)[4]; // Friday, no sessions
  assert.equal(r.profit, 0);
  assert.equal(r.hours, 0);
  assert.equal(r.perHour, null);
  assert.equal(r.sdPerHour, null);
});

test('zero-hour sessions keep their profit and hours(0) but leave the SD sum untouched', () => {
  const busted = cash('m3', ...MON, 1, 100, 0, { duration_seconds: 0 }); // busted in 0h, -100
  const rows = byWeekday(doc, [...sessions, busted]);
  assert.equal(rows[0].profit, -90, 'profit includes the 0-hour session');
  within(rows[0].hours, 2, 1e-12, 'hours stay at the timed total');
  within(rows[0].perHour, -45, 1e-12, 'perHour = profit / hours');
  within(rows[0].sdPerHour, Math.sqrt(5000), 1e-9, 'SD unchanged: h_i = 0 excluded');
});

test('staking mode passes through: net-of-staking vs gross tournament profit', () => {
  const t = {
    id: 't1', kind: 'tournament', start_time: new Date(2026, 9, 5, 12).toISOString(),
    duration_seconds: 1800, break_seconds: 0, is_live: false, prize: 200, total_buy_in: 100,
  };
  const sells = { ...doc, sell_actions: [{ session_id: 't1', percentage: '50', markup: null }] };
  within(byWeekday(sells, [t], 'net')[0].profit, 50, 1e-9, 'net: 200*0.5 - 100*0.5');
  within(byWeekday(sells, [t], 'gross')[0].profit, 100, 1e-9, 'gross: 200 - 100');
});

test('row profits and hours reconcile with the stats.js totals', () => {
  const rows = byWeekday(doc, sessions);
  within(rows.reduce((a, r) => a + r.profit, 0), totalNet(doc, sessions), 1e-9, 'sum profit');
  within(rows.reduce((a, r) => a + r.hours, 0), durationOfPlay(sessions), 1e-9, 'sum hours');
});

// ---- resultHistogram ------------------------------------------------------------

console.log('resultHistogram (brief iteration 3)');

test('empty input returns []', () => {
  assert.deepEqual(resultHistogram([]), []);
});

test('20 equal-width buckets spanning the profit range padded to include 0', () => {
  const b = resultHistogram([-50, -25, 0, 25, 100]);
  assert.equal(b.length, 20);
  within(b[0].lo, -50, 1e-12, 'padded lo');
  assert.equal(b[19].hi, 100, 'padded hi is exact');
  const width = (100 - -50) / 20;
  b.forEach((x, i) => within(x.lo, -50 + i * width, 1e-9, `bucket ${i} lo`));
});

test('counts land in the right buckets with negatives, zero and the clamped max', () => {
  const b = resultHistogram([-50, -25, 0, 25, 100]);
  // lo=-50, width=7.5: -50 -> 0, -25 -> 3, 0 -> 6, 25 -> 10, 100 (== hi) -> clamped to 19.
  for (const i of [0, 3, 6, 10, 19]) assert.equal(b[i].count, 1, `bucket ${i}`);
  assert.equal(b.reduce((a, x) => a + x.count, 0), 5, 'count conservation');
});

test('all-zero profits collapse to a single zero-width bucket', () => {
  assert.deepEqual(resultHistogram([0, 0, 0]), [{ lo: 0, hi: 0, count: 3 }]);
});

test('all-equal nonzero profits pad the range to 0 and fill the first bucket', () => {
  const b = resultHistogram([-50, -50, -50]);
  assert.equal(b.length, 20);
  assert.equal(b[0].lo, -50);
  assert.equal(b[0].count, 3);
  assert.equal(b.reduce((a, x) => a + x.count, 0), 3);
});

test('honors targetBuckets and keeps bounds monotonic and disjoint', () => {
  const b = resultHistogram([-120, -5, 3, 40, 250, 17, -66], 5);
  assert.equal(b.length, 5);
  assert.equal(b[0].lo, -120);
  assert.equal(b[4].hi, 250);
  for (let i = 0; i < 5; i++) assert.ok(b[i].lo < b[i].hi, `bucket ${i} width`);
  for (let i = 1; i < 5; i++) assert.equal(b[i].lo, b[i - 1].hi, `bucket ${i} contiguous`);
  assert.equal(b.reduce((a, x) => a + x.count, 0), 7);
});

test('a non-finite profit throws instead of silently corrupting counts', () => {
  assert.throws(() => resultHistogram([1, Number.NaN]), TypeError);
  assert.throws(() => resultHistogram([1, Infinity]), TypeError);
  assert.throws(() => resultHistogram([{ n: 'x' }], 20, s => s.n), TypeError);
});

test('netFn maps sessions to profits (identity by default for plain numbers)', () => {
  // Range [0, 15] padded to include 0, 2 buckets of width 7.5: 5 -> bucket 0, 15 -> bucket 1.
  const s = [{ id: 1, net: 5 }, { id: 2, net: 15 }];
  const b = resultHistogram(s, 2, x => x.net);
  assert.equal(b[0].lo, 0);
  assert.equal(b[0].count, 1);
  assert.equal(b[1].count, 1);
  assert.deepEqual(resultHistogram([5, 10], 2), resultHistogram([5, 10], 2, v => v));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
