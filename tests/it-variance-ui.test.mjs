// Variance screen UI-state tests (brief sections 4-6). Everything here is
// pure: no DOM, no store, and the simulation contracts are injected as fake
// functions, so the suite runs before the parallel math lanes merge.
// Usage: TZ=UTC node tests/it-variance-ui.test.mjs

import assert from 'node:assert/strict';
import {
  TABS, MIN_HPM, Z95, CASH_NEED_MESSAGE,
  normalizeTab, nextSeed, moments, cashStats, pickCashStats, commonBB, round2,
  cashPrefill, tourStats, bandCurve, samplePaths, percentileRows, percentileLadder,
  downswingRows, downswingChance, floorHpm, downswingHorizons, rorRows,
  bankrollForRorTarget, defaultTourType, defaultTourTypes, addTourType,
  normalizeTourType, normalizeTourTypes, normalizePath, yearRows, yearExtremes,
  mergeUiState, binsOf, quantile, tourRor, tourBankrollFor,
} from '../js/variance-ui-state.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const within = (a, b, tol, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} vs ${b} (tol ${tol})`);

// ---- fixtures --------------------------------------------------------------
const T0 = Date.parse('2026-09-01T18:00:00Z');
const H = 3600e3;
const emptyDoc = {
  settings: { currency: 'EUR' }, bankrolls: [], locations: [], games: [],
  tournament_types: [], groups: [], sessions: [], stack_events: [], sell_actions: [],
};
function cashSession(id, startH, hours, buyIn, cashedOut, extra = {}) {
  return {
    id, kind: 'cash', bankroll_id: 'bk', game_id: 'g', location_id: 'l', table_size: 9,
    start_time: new Date(T0 + startH * H).toISOString(), end_time: new Date(T0 + (startH + hours) * H).toISOString(),
    duration_seconds: hours * 3600, break_seconds: 0, is_live: false, tracked_via_stack: false,
    small_blind: 1, big_blind: 2, buy_in: buyIn, cashed_out: cashedOut, tips: 0,
    ...extra,
  };
}
function tourSession(id, startH, totalBuyIn, prize, extra = {}) {
  return {
    id, kind: 'tournament', bankroll_id: 'bk', location_id: 'l',
    start_time: new Date(T0 + startH * H).toISOString(), end_time: new Date(T0 + (startH + 5) * H).toISOString(),
    duration_seconds: 5 * 3600, break_seconds: 0, is_live: false, tracked_via_stack: false,
    total_buy_in: totalBuyIn, prize, entries: 100, finish_place: 5, ...extra,
  };
}
// Three cash sessions: +100 over 10h, -50 over 5h, +25 over 5h.
// sum(p) = 75, sum(h) = 20 -> wr 3.75; SD by the brief-7 formula.
const sessions3 = [
  cashSession('a', 0, 10, 100, 200, { big_blind: 2, hands_count: 2000 }),
  cashSession('b', 11, 5, 100, 50, { big_blind: 2, hands_count: 900 }),
  cashSession('c', 20, 5, 100, 125, { big_blind: 1, hands_count: 1100 }),
];
const EXPECT_WR = 3.75;
const EXPECT_SD = Math.sqrt(
  ((100 - EXPECT_WR * 10) ** 2) / 10 + ((-50 - EXPECT_WR * 5) ** 2) / 5 + ((25 - EXPECT_WR * 5) ** 2) / 5,
) / Math.sqrt(2);

// ---- tabs and seeds ---------------------------------------------------------

test('normalizeTab keeps valid tabs and falls back to cash', () => {
  assert.equal(normalizeTab('tournaments'), 'tournaments');
  assert.equal(normalizeTab('year'), 'year');
  assert.equal(normalizeTab('cash'), 'cash');
  assert.equal(normalizeTab('nope'), 'cash');
  assert.equal(normalizeTab(undefined), 'cash');
});

test('TABS are the three brief tabs in order', () => {
  assert.deepEqual(TABS.map(t => t.key), ['cash', 'tournaments', 'year']);
});

test('nextSeed is deterministic and moves', () => {
  const a = nextSeed(27);
  assert.equal(a, nextSeed(27));
  assert.notEqual(a, 27);
  assert.ok(a >= 0 && a < 1000000);
});

// ---- moments (brief section 7 formula) --------------------------------------

test('moments implements the brief-7 winrate and SD formula', () => {
  const m = moments([{ p: 100, h: 10 }, { p: -50, h: 5 }, { p: 25, h: 5 }]);
  within(m.wr, 3.75, 1e-9, 'wr');
  within(m.sd, EXPECT_SD, 1e-9, 'sd');
  assert.equal(m.k, 3);
  assert.equal(m.hours, 20);
});

test('moments returns null below 2 sessions or without hours', () => {
  assert.equal(moments([{ p: 100, h: 10 }]), null);
  assert.equal(moments([]), null);
  assert.equal(moments([{ p: 100, h: 0 }, { p: 5, h: 0 }]), null);
});

// ---- cashStats over a filtered session list ----------------------------------

test('cashStats derives $, BB and per-100-hands variants', () => {
  const s = cashStats(emptyDoc, sessions3);
  assert.equal(s.n, 3);
  within(s.usd.wr, EXPECT_WR, 1e-9, 'usd wr');
  within(s.usd.sd, EXPECT_SD, 1e-9, 'usd sd');
  within(s.hours, 20, 1e-9, 'hours');
  // BB variant: profits divided by each session's big blind (2, 2, 1).
  within(s.bb.wr, (50 - 25 + 25) / 20, 1e-9, 'bb wr');
  // Hands variant: h_i = hands_i / 100 -> 20, 9, 11.
  within(s.h100.wr, 75 / 40, 1e-9, 'h100 wr');
  // BB + hands variant.
  within(s.bb100.wr, (50 - 25 + 25) / 40, 1e-9, 'bb100 wr');
  within(s.hands, 4000, 1e-9, 'hands');
  within(s.handsPerHour, 200, 1e-9, 'hands per hour');
});

test('cashStats flags hand counts and BB coverage', () => {
  const missingHands = cashStats(emptyDoc, [
    cashSession('a', 0, 10, 100, 200, { hands_count: 1000 }),
    cashSession('b', 11, 5, 100, 50),
    cashSession('c', 20, 5, 100, 125, { hands_count: 500 }),
  ]);
  assert.equal(missingHands.hasHands, false);
  assert.equal(missingHands.h100.k, 2); // only two hand-counted sessions
  const allBB = cashStats(emptyDoc, sessions3);
  assert.equal(allBB.hasBB, true);
  const oneNoBB = cashStats(emptyDoc, [
    cashSession('a', 0, 10, 100, 200, { big_blind: null }),
    cashSession('b', 11, 5, 100, 50),
  ]);
  assert.equal(oneNoBB.hasBB, false);
});

test('cashStats skips tournaments and zero-hour sessions', () => {
  const s = cashStats(emptyDoc, [
    ...sessions3,
    tourSession('t', 30, 100, 200),
    cashSession('zero', 40, 0, 100, 300),
  ]);
  assert.equal(s.n, 3);
});

// ---- pickCashStats / commonBB / prefill --------------------------------------

test('pickCashStats selects the variant for the unit mode', () => {
  const s = cashStats(emptyDoc, sessions3);
  assert.equal(pickCashStats(s, '$', 'hours'), s.usd);
  assert.equal(pickCashStats(s, 'BB', 'hours'), s.bb);
  assert.equal(pickCashStats(s, '$', 'hands'), s.h100);
  assert.equal(pickCashStats(s, 'BB', 'hands'), s.bb100);
  assert.equal(pickCashStats(null, '$', 'hours'), null);
  const noHands = cashStats(emptyDoc, [cashSession('a', 0, 10, 100, 200), cashSession('b', 11, 5, 100, 50)]);
  assert.equal(pickCashStats(noHands, '$', 'hands'), null);
});

test('commonBB picks the most frequent big blind', () => {
  assert.equal(commonBB(emptyDoc, sessions3), 2);
  assert.equal(commonBB(emptyDoc, []), null);
});

test('cashPrefill rounds wr, sd and volume', () => {
  const s = cashStats(emptyDoc, sessions3);
  const p = cashPrefill(s, '$', 'hours');
  within(p.wr, round2(EXPECT_WR), 1e-9, 'prefill wr');
  within(p.sd, round2(EXPECT_SD), 1e-9, 'prefill sd');
  assert.equal(p.volume, 20);
  const hands = cashPrefill(s, '$', 'hands');
  assert.equal(hands.volume, 4000);
  assert.equal(cashPrefill(null, '$', 'hours'), null);
});

test('cashPrefill message constant is user-facing and em-dash free', () => {
  assert.ok(!CASH_NEED_MESSAGE.includes('\u2014'));
  assert.match(CASH_NEED_MESSAGE, /Need at least/);
});

// ---- tourStats ("Use my stats" for tournaments) -------------------------------

test('tourStats derives average buy-in, field and observed ROI', () => {
  const t = [
    tourSession('t1', 0, 100, 200, { entries: 120 }),
    tourSession('t2', 6, 200, 0, { entries: 80 }),
  ];
  const s = tourStats(emptyDoc, t);
  assert.equal(s.n, 2);
  within(s.avgBuyIn, 150, 1e-9, 'avg buy-in');
  within(s.avgField, 100, 1e-9, 'avg field');
  within(s.roiPct, (-100 / 300) * 100, 1e-9, 'roi pct');
  assert.equal(tourStats(emptyDoc, []), null);
});

// ---- projection band and sample paths -----------------------------------------

test('bandCurve is the EV line plus a 95% band', () => {
  const band = bandCurve({ wr: 5, sd: 47, hoursT: 100, steps: 10 });
  assert.equal(band.length, 11);
  within(band[0].ev, 0, 1e-9, 'start EV');
  within(band[10].ev, 500, 1e-9, 'end EV');
  within(band[10].hi - band[10].lo, 2 * Z95 * 47 * 10, 1e-9, 'band width at T');
  within(band[0].hi - band[0].lo, 0, 1e-9, 'band width at 0');
  assert.deepEqual(bandCurve({ wr: 5, sd: 47, hoursT: 0 }), []);
});

test('samplePaths are seeded, shaped and centred near EV', () => {
  const a = samplePaths({ wr: 5, sd: 47, hoursT: 256, count: 20, seed: 7, steps: 24 });
  const b = samplePaths({ wr: 5, sd: 47, hoursT: 256, count: 20, seed: 7, steps: 24 });
  assert.deepEqual(a, b);
  assert.equal(a.length, 20);
  assert.equal(a[0].length, 25);
  assert.equal(a[0][0].v, 0);
  const mean = a.reduce((acc, p) => acc + p[24].v, 0) / 20;
  within(mean, 5 * 256, 0.5 * 47 * 16, 'mean of finals near EV');
  const c = samplePaths({ wr: 5, sd: 47, hoursT: 256, count: 20, seed: 8, steps: 24 });
  assert.notDeepEqual(a, c);
  assert.equal(samplePaths({ wr: 5, sd: 47, hoursT: 0 }).length, 0);
});

// ---- percentile shaping --------------------------------------------------------

test('percentileRows keeps the given order with % labels', () => {
  const rows = percentileRows({ 1: 1, 5: 5, 25: 25, 50: 50, 75: 75, 95: 95, 99: 99 }, [1, 5, 25, 50, 75, 95, 99]);
  assert.deepEqual(rows.map(r => r.label), ['1%', '5%', '25%', '50%', '75%', '95%', '99%']);
  assert.deepEqual(rows.map(r => r.value), [1, 5, 25, 50, 75, 95, 99]);
  assert.deepEqual(percentileRows(null, [1, 5]), []);
});

test('percentileLadder sorts ascending and drops junk', () => {
  const ladder = percentileLadder({ 99: 900, 1: -300, 50: 40, bad: 'x' });
  assert.deepEqual(ladder, [{ p: 1, value: -300 }, { p: 50, value: 40 }, { p: 99, value: 900 }]);
  assert.deepEqual(percentileLadder(null), []);
});

// ---- downswings -----------------------------------------------------------------

test('downswingRows maps size and length percentiles', () => {
  const d = downswingRows({
    size: { p5: 1, p25: 2, p50: 3, p75: 4, p95: 5 },
    lengthHours: { p5: 10, p25: 20, p50: 30, p75: 40, p95: 50 },
  });
  assert.deepEqual(d.size.map(r => r.label), ['5%', '25%', '50%', '75%', '95%']);
  assert.deepEqual(d.length.map(r => r.value), [10, 20, 30, 40, 50]);
  assert.equal(downswingRows(null), null);
  assert.equal(downswingRows({ size: null, lengthHours: {} }), null);
});

test('downswingChance hits the percentile anchors and stays monotone', () => {
  const size = { p5: 100, p25: 200, p50: 400, p75: 800, p95: 1600 };
  within(downswingChance(0, size), 1, 1e-9, 'chance at 0');
  within(downswingChance(100, size), 0.95, 1e-9, 'chance at p5');
  within(downswingChance(400, size), 0.5, 1e-9, 'chance at p50');
  within(downswingChance(1600, size), 0.05, 1e-9, 'chance at p95');
  let prev = Infinity;
  for (let x = 0; x <= 3200; x += 50) {
    const c = downswingChance(x, size);
    assert.ok(c !== null && c >= 0 && c <= 1, `chance in range at ${x}`);
    assert.ok(c <= prev + 1e-12, `monotone at ${x}`);
    prev = c;
  }
  assert.equal(downswingChance(100000, size), 0);
  assert.equal(downswingChance(-1, size), null);
});

// ---- horizons --------------------------------------------------------------------

test('floorHpm enforces the 10-hour minimum', () => {
  assert.equal(floorHpm(5), MIN_HPM);
  assert.equal(floorHpm(30), 30);
  assert.equal(floorHpm(null), MIN_HPM);
  assert.equal(floorHpm('abc'), MIN_HPM);
});

test('downswingHorizons map month, quarter and year', () => {
  const h = downswingHorizons({ hpm: 20 });
  assert.deepEqual(h, { month: 20, quarter: 60, year: 240 });
  const hands = downswingHorizons({ hpm: 10, volumeUnit: 'hands', handsPerHour: 100 });
  assert.deepEqual(hands, { month: 10, quarter: 30, year: 120 }); // 10h x 100 hands/h / 100
  const fallback = downswingHorizons({ hpm: 10, volumeUnit: 'hands' });
  assert.deepEqual(fallback, { month: 3, quarter: 9, year: 36 }); // 30 hands/h fallback
  const floored = downswingHorizons({ hpm: 3 });
  assert.deepEqual(floored, { month: 10, quarter: 30, year: 120 });
});

// ---- bankroll block --------------------------------------------------------------

test('rorRows builds the 50/20/5/1 table through injected fns', () => {
  const rows = rorRows({ wr: 5, sd: 47, bankroll: 2000, rorFn: B => 1 / B, bankrollForFn: r => r * 100 });
  within(rows.current, 1 / 2000, 1e-12, 'current RoR');
  assert.deepEqual(rows.table.map(r => r.label), ['50%', '20%', '5%', '1%']);
  assert.deepEqual(rows.table.map(r => r.bankroll), [50, 20, 5, 1]);
  assert.equal(rorRows({ wr: 5, sd: 47, bankroll: 0, rorFn: () => 1, bankrollForFn: () => 1 }), null);
  assert.equal(rorRows({ wr: 5, sd: 0, bankroll: 100, rorFn: () => 1, bankrollForFn: () => 1 }), null);
});

test('bankrollForRorTarget bisects a known curve', () => {
  const B = bankrollForRorTarget(x => Math.exp(-x / 100), 0.5);
  within(B, 100 * Math.log(2), 0.01, 'crossing at ln2 * 100');
  within(bankrollForRorTarget(x => Math.exp(-x / 100), 1e-30), 100 * Math.log(1e30), 0.01, 'deep target');
  assert.equal(bankrollForRorTarget(x => 0.5 + Math.exp(-x / 100), 0.1), null); // never crosses
  assert.equal(bankrollForRorTarget('nope', 0.5), null);
  assert.equal(bankrollForRorTarget(x => Math.exp(-x / 100), 1.5), null);
});

// ---- tournament type inputs --------------------------------------------------------

test('normalizeTourType clamps and defaults', () => {
  const t = normalizeTourType({ name: '  ', buyin: 'abc', rakePct: 150, entries: 1, percentPaidPct: -4, roiPct: -12.5, events: 0 }, 2);
  assert.equal(t.name, 'Type 3');
  assert.equal(t.buyin, 50);
  assert.equal(t.rakePct, 100);
  assert.equal(t.entries, 2);
  assert.equal(t.percentPaidPct, 0);
  within(t.roiPct, -12.5, 1e-9, 'roi kept');
  assert.equal(t.events, 1);
  assert.deepEqual(normalizeTourType(defaultTourType()), defaultTourType());
});

test('tour type list helpers cap, append and default', () => {
  assert.deepEqual(defaultTourTypes(), [defaultTourType()]);
  const nine = Array.from({ length: 9 }, (_, i) => ({ buyin: i + 1 }));
  assert.equal(normalizeTourTypes(nine).length, 8);
  assert.deepEqual(normalizeTourTypes('junk'), []);
  const added = addTourType(defaultTourTypes());
  assert.equal(added.length, 2);
  assert.equal(added[1].name, 'Type 2');
  assert.equal(addTourType([{ buyin: 10 }])[0].buyin, 10);
});

// ---- simulate() output shaping -------------------------------------------------------

test('binsOf buckets finite values into an even histogram', () => {
  const bars = binsOf([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5);
  assert.equal(bars.length, 5);
  assert.equal(bars.reduce((a, b) => a + b.count, 0), 10); // everything bucketed
  const junk = binsOf([3, NaN, undefined], 16); // junk dropped, one value bucketed
  assert.equal(junk.length, 16);
  assert.equal(junk[0].count, 1);
  assert.equal(junk.slice(1).every(b => b.count === 0), true);
  assert.deepEqual(binsOf([]), []);
  const flat = binsOf([5, 5, 5], 5);
  assert.equal(flat[0].count, 3); // zero range still buckets
  assert.equal(flat.slice(1).every(b => b.count === 0), true);
});

test('normalizePath accepts totals and point objects', () => {
  assert.deepEqual(normalizePath([0, 5, 9]), [{ t: 1, v: 0 }, { t: 2, v: 5 }, { t: 3, v: 9 }]);
  assert.deepEqual(normalizePath([{ x: 10, y: -2 }, { x: 20, y: 4 }]), [{ t: 10, v: -2 }, { t: 20, v: 4 }]);
  assert.deepEqual(normalizePath([{ t: 1, v: 7 }]), [{ t: 1, v: 7 }]);
  assert.deepEqual(normalizePath([{ unit: 2, bankroll: 55 }]), [{ t: 2, v: 55 }]);
  assert.deepEqual(normalizePath([]), []);
  assert.deepEqual(normalizePath(null), []);
});

// ---- tournament risk of ruin from per-run minimums -------------------------------------

test('quantile interpolates and tourRor counts runs below -B', () => {
  within(quantile([0, 10], 0.5), 5, 1e-9, 'interpolated median');
  within(quantile([3, 1, 2], 0.9), 2.8, 1e-9, 'quantile of unsorted input'); // pos 1.8 of [1,2,3]
  assert.equal(quantile([], 0.5), null);
  const minRunning = [0, -100, -300, -50, 0];
  within(tourRor(minRunning, 0), 0.6, 1e-9, 'RoR at zero bankroll'); // 3 of 5 runs dipped negative
  within(tourRor(minRunning, 99), 0.4, 1e-9, 'RoR at 99'); // -100 and -300
  within(tourRor(minRunning, 299), 0.2, 1e-9, 'strictly below -B');
  within(tourRor(minRunning, 300), 0, 1e-9, 'RoR above the worst run');
  assert.equal(tourRor([], 100), null);
});

test('tourBankrollFor reads the r-quantile of minimums', () => {
  const minRunning = [-100, -200, -300, -400, -500];
  within(tourBankrollFor(minRunning, 0.5), 300, 1e-9, 'median minimum');
  within(tourBankrollFor(minRunning, 0.2), 420, 1e-9, '20% quantile');
  assert.equal(tourBankrollFor([50, 80], 0.5), 0); // never dipped negative
  assert.equal(tourBankrollFor([], 0.5), null);
});

// ---- year tab -------------------------------------------------------------------------

test('yearRows flags lucky and unlucky months', () => {
  const rows = yearRows({
    months: Array.from({ length: 12 }, (_, i) => ({ result: i * 100, ev: 50, z: i - 6 })),
  });
  assert.equal(rows.length, 12);
  assert.equal(rows[0].label, 'Jan');
  assert.equal(rows[11].label, 'Dec');
  assert.equal(rows[9].z, 3);
  assert.equal(rows[9].luck, 'lucky');
  assert.equal(rows[0].z, -6);
  assert.equal(rows[0].luck, 'unlucky');
  assert.equal(rows[6].luck, null); // z = 0
  assert.deepEqual(yearRows(null), []);
});

test('yearExtremes finds the luckiest and unluckiest months', () => {
  const y = {
    months: Array.from({ length: 12 }, (_, i) => ({ z: [0.5, -2, 1.5, 0, -0.5, 3, 0.2, 0.1, 0, -0.1, -0.2, 0.3][i] })),
  };
  const e = yearExtremes(y);
  assert.equal(e.luckiest, 5);
  assert.equal(e.unluckiest, 1);
  assert.equal(e.luckiestLabel, 'Jun');
  assert.equal(e.unluckiestLabel, 'Feb');
  assert.equal(yearExtremes(null).luckiest, null);
});

// ---- saved-state merge -------------------------------------------------------------------

test('mergeUiState fills defaults and sanitizes junk', () => {
  const s = mergeUiState(null);
  assert.equal(s.tab, 'cash');
  assert.equal(s.cash.wr, 10);
  assert.equal(s.cash.volumeUnit, 'hours');
  assert.equal(s.cash.unit, '$');
  assert.equal(s.cash.x, null);
  assert.equal(s.tournaments.types.length, 1);
  assert.equal(s.tournaments.statsN, null);
  assert.equal(s.year.hpm, null);
  assert.equal(s.seeds.cash, 27);

  const saved = mergeUiState({
    tab: 'year',
    cash: { wr: 'abc', sd: 47, unit: 'BB', volume: 256, volumeUnit: 'hands' },
    tournaments: { bankroll: 500, statsN: 42, types: [{ buyin: 20 }] },
    year: { hpm: 33 },
    seeds: { cash: 5, tour: 'x', year: 9 },
  });
  assert.equal(saved.tab, 'year');
  assert.equal(saved.cash.wr, 10); // junk restored to default
  assert.equal(saved.cash.sd, 47);
  assert.equal(saved.cash.unit, 'BB');
  assert.equal(saved.cash.volumeUnit, 'hands');
  assert.equal(saved.tournaments.bankroll, 500);
  assert.equal(saved.tournaments.statsN, 42);
  assert.equal(saved.tournaments.types[0].buyin, 20);
  assert.equal(saved.year.hpm, 33);
  assert.equal(saved.seeds.cash, 5);
  assert.equal(saved.seeds.tour, 27); // junk restored to default
  assert.equal(saved.seeds.year, 9);
  assert.equal(mergeUiState({ tab: 'bogus' }).tab, 'cash');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
