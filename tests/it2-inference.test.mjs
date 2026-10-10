// IT2 verification harness: winrate inference math (js/inference.js), the
// formulas fixed by brief section 7. Every check is closed form and
// deterministic: no randomness, no clock, exact-integer fixtures where the
// arithmetic allows it.
// Usage: TZ=UTC node tests/it2-inference.test.mjs

import assert from 'node:assert/strict';
import {
  sessionRows, winrateStats, normalCdf, zFor, hoursToKnow,
  MIN_SESSIONS, NEED_MORE_MESSAGE,
} from '../js/inference.js';
import { netResult, sessionHours } from '../js/stats.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const within = (a, b, tol, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} vs ${b} (tol ${tol})`);

// ---- fixtures: same session shape as tests/variance.test.mjs ----
const T0 = Date.parse('2026-09-01T18:00:00Z');
const H = 3600e3;

function cash(id, startH, hours, opts = {}) {
  const { buyIn = 0, cashedOut = 0, tips = 0, bb = 2, hands = null, est = false, live = false, stack = false } = opts;
  return {
    id, kind: 'cash', bankroll_id: 'bk', game_id: 'g', location_id: 'l', table_size: 9,
    start_time: new Date(T0 + startH * H).toISOString(),
    end_time: live ? null : new Date(T0 + (startH + hours) * H).toISOString(),
    duration_seconds: live ? null : hours * 3600, break_seconds: 0,
    is_live: live, tracked_via_stack: stack,
    small_blind: bb ? bb / 2 : null, big_blind: bb,
    buy_in: buyIn, cashed_out: cashedOut, tips,
    hands_count: hands, hands_count_estimated: est,
  };
}

function tourney(id, startH, hours, buyIn, prize) {
  return {
    id, kind: 'tournament', bankroll_id: 'bk', game_id: 'g', location_id: 'l', table_size: 9,
    start_time: new Date(T0 + startH * H).toISOString(),
    end_time: new Date(T0 + (startH + hours) * H).toISOString(),
    duration_seconds: hours * 3600, break_seconds: 0, is_live: false, tracked_via_stack: false,
    total_buy_in: buyIn, prize,
  };
}

// A live-tracked session: money lives in stack events, not on the session.
const doc = {
  stack_events: [
    { id: 'e1', session_id: 'stk', kind: 'buy_in', amount: 500, occurred_at: new Date(T0).toISOString() },
    { id: 'e2', session_id: 'stk', kind: 'top_up', amount: 200, occurred_at: new Date(T0 + H).toISOString() },
    { id: 'e3', session_id: 'stk', kind: 'cash_out', amount: 900, occurred_at: new Date(T0 + 3 * H).toISOString() },
  ],
};

const sessions = [
  cash('c1', 0, 4, { buyIn: 1000, cashedOut: 1120, bb: 2, hands: 260 }),
  tourney('t1', 5, 6, 100, 300),
  cash('c2', 12, 3, { buyIn: 500, cashedOut: 480, tips: 20, bb: 5, hands: 100 }),
  cash('c3', 20, 2, { live: true, buyIn: 300 }),
  cash('c4', 30, 0, { buyIn: 100, cashedOut: 100 }),
  cash('stk', 40, 3, { stack: true, buyIn: 500, cashedOut: 0, bb: 1, hands: 80 }),
  cash('c5', 50, 5, { buyIn: 200, cashedOut: 310, bb: 2, hands: null, est: true }),
  cash('c6', 60, 1, { buyIn: 100, cashedOut: 90, bb: 2, hands: null }),
  cash('c7', 70, 2, { buyIn: 100, cashedOut: 150, bb: null, hands: 50 }),
];

console.log('sessionRows: filters and doc wiring');
const rows = sessionRows(sessions, doc);
test('keeps ended cash sessions only, in input order, with exact rows', () => {
  assert.deepEqual(rows, [
    { p: 120, h: 4, bb: 2, hands: 260 },
    { p: -40, h: 3, bb: 5, hands: 100 },
    { p: 200, h: 3, bb: 1, hands: 80 },
    { p: 110, h: 5, bb: 2, hands: 150 },
    { p: -10, h: 1, bb: 2, hands: null },
    { p: 50, h: 2, bb: null, hands: 50 },
  ]);
});
test('rows agree with stats.js netResult and sessionHours session by session', () => {
  const kept = sessions.filter(s => s.kind === 'cash' && !s.is_live && s.end_time && sessionHours(s) > 0);
  assert.equal(rows.length, kept.length);
  rows.forEach((r, i) => {
    assert.equal(r.p, netResult(doc, kept[i]));
    within(r.h, sessionHours(kept[i]), 1e-12);
  });
});
test('without a doc, live-tracked sessions are skipped, not scored as 0', () => {
  const noDoc = sessionRows(sessions);
  assert.equal(noDoc.length, rows.length - 1);
  assert.deepEqual(noDoc[0], rows[0]);
  assert.deepEqual(noDoc[noDoc.length - 1], rows[rows.length - 1]);
});

console.log('Brief 7 sanity anchor: 256h at $5/hr with SD $47/hr');
// Two 128h sessions, +1016 and +264: WR = 1280/256 = 5, residuals +376/-376,
// SD = sqrt(2 * 376^2/128) = 47 exactly, SE = 47/16 = 2.9375.
const sanitySessions = [
  cash('s1', 0, 128, { buyIn: 1000, cashedOut: 2016, bb: 10, hands: 2560 }),
  cash('s2', 200, 128, { buyIn: 1000, cashedOut: 1264, bb: 10, hands: 2560 }),
];
const sanityRows = sessionRows(sanitySessions, { stack_events: [] });
const sanity = winrateStats(sanityRows);
test('SE about 2.9 (tol 0.1), 95% CI about -1 to 11 (tol 0.25)', () => {
  within(sanity.se, 2.9, 0.1, 'SE');
  within(sanity.ci[0], -1, 0.25, 'CI low');
  within(sanity.ci[1], 11, 0.25, 'CI high');
  assert.ok(sanity.chanceWinner > 0.9 && sanity.chanceWinner < 0.99, 'chance in the 90s');
  assert.equal(sanity.n, 2);
});
test('the same fixture is exact: WR 5, SD 47, SE 2.9375, z at 95%', () => {
  within(sanity.wr, 5, 1e-12, 'WR');
  within(sanity.sd, 47, 1e-9, 'SD');
  within(sanity.se, 2.9375, 1e-12, 'SE');
  assert.equal(sanity.z, zFor(0.95));
  within(sanity.chanceWinner, 0.95564, 1e-3, 'chance of winning');
});
test('BB unit on uniform stakes is the USD stat divided by the BB', () => {
  const bb = winrateStats(sanityRows, { unit: 'bb' });
  within(bb.wr, sanity.wr / 10, 1e-12, 'wr bb');
  within(bb.sd, sanity.sd / 10, 1e-12, 'sd bb');
  within(bb.se, sanity.se / 10, 1e-12, 'se bb');
  within(bb.chanceWinner, sanity.chanceWinner, 1e-12, 'chance invariant');
});
test('per100 on the same fixture (2560 hands per session)', () => {
  const p100 = winrateStats(sanityRows, { unit: 'per100' });
  within(p100.wr, 25, 1e-12, 'wr per 100');
  within(p100.sd, Math.sqrt(11045), 1e-8, 'sd per 100');
  within(p100.se, Math.sqrt(11045) / Math.sqrt(51.2), 1e-8, 'se per 100');
});

console.log('Exact closed-form checks');
const three = [
  { p: 100, h: 2, bb: 5, hands: 200 },
  { p: -50, h: 1, bb: 2, hands: 100 },
  { p: 30, h: 1, bb: 10, hands: 100 },
];
test('usd unit: wr 20, SD sqrt(3400), SE sd/2, CI wr +/- z*SE', () => {
  const s = winrateStats(three);
  within(s.wr, 20, 1e-12, 'wr');
  within(s.sd, Math.sqrt(3400), 1e-12, 'sd');
  within(s.se, Math.sqrt(3400) / 2, 1e-12, 'se');
  within(s.ci[0], 20 - s.z * s.se, 1e-12, 'ci low');
  within(s.ci[1], 20 + s.z * s.se, 1e-12, 'ci high');
  within(s.chanceWinner, 0.753642, 1e-3, 'chance');
  assert.equal(s.n, 3);
});
test('bb unit with mixed stakes: each p divided by its own big blind', () => {
  const s = winrateStats(three, { unit: 'bb' });
  within(s.wr, -0.5, 1e-12, 'wr bb');
  within(s.sd, Math.sqrt(416.5), 1e-12, 'sd bb');
  within(s.se, Math.sqrt(416.5) / 2, 1e-12, 'se bb');
  within(s.chanceWinner, 0.480452, 1e-3, 'chance');
  assert.ok(s.chanceWinner < 0.5, 'below 50% when wr < 0');
});
test('per100 mirrors usd when hands = 100 x hours', () => {
  const mirrored = three.map(r => ({ ...r, hands: r.h * 100 }));
  const a = winrateStats(mirrored, { unit: 'per100' });
  const b = winrateStats(three);
  within(a.wr, b.wr, 1e-12, 'wr'); within(a.sd, b.sd, 1e-12, 'sd'); within(a.se, b.se, 1e-12, 'se');
  within(a.chanceWinner, b.chanceWinner, 1e-12, 'chance');
});
test('per100 with its own hands: wr 80/6, SD sqrt(43500/18)', () => {
  const s = winrateStats([
    { p: 100, h: 2, hands: 400 }, { p: -50, h: 1, hands: 100 }, { p: 30, h: 1, hands: 100 },
  ], { unit: 'per100' });
  within(s.wr, 80 / 6, 1e-12, 'wr');
  within(s.sd, Math.sqrt(43500 / 18), 1e-9, 'sd');
  within(s.se, Math.sqrt(43500 / 18) / Math.sqrt(6), 1e-9, 'se');
});
test('k = 1: SD 0, SE 0, point CI, chance by sign of WR', () => {
  const up = winrateStats([{ p: 100, h: 3, bb: 5, hands: 150 }]);
  within(up.wr, 100 / 3, 1e-12, 'wr');
  assert.equal(up.sd, 0); assert.equal(up.se, 0);
  assert.deepEqual(up.ci, [up.wr, up.wr]);
  assert.equal(up.chanceWinner, 1);
  const down = winrateStats([{ p: -30, h: 2 }]);
  assert.equal(down.chanceWinner, 0); assert.equal(down.sd, 0); assert.equal(down.se, 0);
  const flat = winrateStats([{ p: 0, h: 2 }]);
  assert.equal(flat.wr, 0); assert.equal(flat.chanceWinner, 0.5);
});

console.log('Small-sample guard and null-data contract');
test('MIN_SESSIONS is 10 and the message matches the brief exactly', () => {
  assert.equal(MIN_SESSIONS, 10);
  assert.equal(NEED_MORE_MESSAGE, 'Need at least 10 sessions');
  assert.ok(!NEED_MORE_MESSAGE.includes('\u2014'), 'no em dashes in UI strings');
});
test('9 sessions still compute: the guard belongs to the caller', () => {
  const nine = Array.from({ length: 9 }, (_, i) => ({ p: 10 + i, h: 1 }));
  const s = winrateStats(nine);
  assert.equal(s.n, 9);
  within(s.wr, 14, 1e-12, 'wr');
  within(s.sd, Math.sqrt(7.5), 1e-12, 'sd');
  within(s.se, Math.sqrt(7.5) / 3, 1e-12, 'se');
});

console.log('normalCdf and zFor');
test('normalCdf anchors within 1e-6', () => {
  within(normalCdf(0), 0.5, 1e-7);
  within(normalCdf(1), 0.841344746068543, 1e-6);
  within(normalCdf(-1), 0.158655253931457, 1e-6);
  within(normalCdf(2), 0.977249868051821, 1e-6);
  within(normalCdf(-2), 0.022750131948179, 1e-6);
  within(normalCdf(1.959963984540054), 0.975, 1e-6);
});
test('normalCdf symmetry: cdf(-x) = 1 - cdf(x)', () => {
  for (const x of [0.3, 1.7, 4.2]) within(normalCdf(-x), 1 - normalCdf(x), 1e-15);
});
test('zFor matches published two-sided z values', () => {
  within(zFor(0.95), 1.959963984540054, 1e-6);
  within(zFor(0.90), 1.644853626951472, 1e-6);
  within(zFor(0.99), 2.575829303548900, 1e-6);
  within(zFor(0.999), 3.290526731491925, 1e-5);
});
test('zFor round-trips through normalCdf', () => {
  for (const c of [0.5, 0.8, 0.95, 0.99]) within(normalCdf(zFor(c)), (c + 1) / 2, 1e-6);
});
test('confidence outside (0, 1) throws', () => {
  assert.throws(() => zFor(0), RangeError);
  assert.throws(() => zFor(1), RangeError);
  assert.throws(() => zFor(1.5), RangeError);
  assert.throws(() => winrateStats([{ p: 1, h: 1 }], { confidence: 1 }), RangeError);
});
test('unknown unit throws', () => {
  assert.throws(() => winrateStats([{ p: 1, h: 1 }], { unit: 'per1k' }), RangeError);
});
test('missing unit data nulls the whole stat instead of a subset', () => {
  const noBB = winrateStats([{ p: 100, h: 2, bb: null, hands: 100 }], { unit: 'bb' });
  assert.equal(noBB.wr, null); assert.equal(noBB.ci, null); assert.equal(noBB.chanceWinner, null); assert.equal(noBB.n, 1);
  const noHands = winrateStats([{ p: 100, h: 2, bb: 5, hands: null }], { unit: 'per100' });
  assert.equal(noHands.wr, null); assert.equal(noHands.sd, null);
  const none = winrateStats([]);
  assert.equal(none.n, 0); assert.equal(none.wr, null); assert.equal(none.ci, null);
  const bad = winrateStats([{ p: 100, h: 0 }]);
  assert.equal(bad.wr, null);
});

console.log('hoursToKnow');
test('hoursToKnow = (1.96 * SD / X)^2 with the default z', () => {
  within(hoursToKnow(47, 2), 2121.5236, 1e-6, 'brief numbers');
  assert.equal(hoursToKnow(47, 2), Math.pow(1.96 * 47 / 2, 2));
  assert.equal(hoursToKnow(47, 2, zFor(0.99)), Math.pow(zFor(0.99) * 47 / 2, 2));
  assert.equal(hoursToKnow(47, 0), Infinity);
  assert.equal(hoursToKnow(0, 2), 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
