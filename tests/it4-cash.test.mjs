// IT4 verification harness: cash variance math (js/variance-cash.js) against
// the brief's section 7 formulas. Every simulation is seeded, so each
// assertion is deterministic: a pass here passes on every run.
// Usage: TZ=UTC node tests/it4-cash.test.mjs
//
// Tolerances are stated next to each check. "SE" = Monte Carlo standard
// error; 4 SE bands are used so a correct engine cannot fail by chance, while
// a wrong formula (off by a constant factor or a missing sqrt) lands far
// outside them.

import assert from 'node:assert/strict';
import { project, downswings, ror, bankrollFor, sensitivityRows, avgHoursPerMonth, invNorm } from '../js/variance-cash.js';
import { brownianRuin, normalCdf, mulberry32, normalSampler } from '../js/variance.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const within = (a, b, tol, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} vs ${b} (tol ${tol})`);

// Known standard normal quantiles (spot values; the round-trip test below is
// the ground truth since it pits the module against its own CDF).
const Z975 = 1.959963984540054;
const Z95 = 1.6448536269514722;
const Z99 = 2.3263478740408408;
const Z25 = -0.6744897501960817;

console.log('invNorm (inverse standard normal CDF)');
test('known quantiles: 0.975 -> 1.9600, 0.95 -> 1.6449, 0.99 -> 2.3263, 0.25 -> -0.6745', () => {
  within(invNorm(0.975), Z975, 1e-8, 'z975');
  within(invNorm(0.95), Z95, 1e-8, 'z95');
  within(invNorm(0.99), Z99, 1e-8, 'z99');
  within(invNorm(0.25), Z25, 1e-8, 'z25');
});
test('round trip normalCdf(invNorm(p)) = p within 2e-7 (A&S erf accuracy) across the range', () => {
  for (const p of [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99]) {
    within(normalCdf(invNorm(p)), p, 2e-7, `p=${p}`);
  }
});
test('symmetry invNorm(1 - p) = -invNorm(p); rejects p outside (0, 1)', () => {
  for (const p of [0.01, 0.2, 0.5, 0.8, 0.99]) within(invNorm(1 - p), -invNorm(p), 1e-12, `p=${p}`);
  assert.throws(() => invNorm(0), RangeError);
  assert.throws(() => invNorm(1), RangeError);
  assert.throws(() => invNorm(-0.1), RangeError);
});

console.log('project (brief: mean = WR x T, SD = SD x sqrt(T), chanceLoss = NormalCDF(-mean/SD))');
test('exact formulas at 256 hours, $5/hr, SD $47/hr', () => {
  const p = project({ wr: 5, sd: 47, hoursT: 256 });
  within(p.mean, 1280, 1e-9, 'mean');
  within(p.sd, 47 * 16, 1e-9, 'SD of total');
  within(p.chanceLoss, normalCdf(-1280 / 752), 1e-12, 'chance of loss');
});
test('percentiles: median is the mean, tails symmetric around it, z spread matches invNorm', () => {
  const p = project({ wr: 5, sd: 47, hoursT: 256 });
  const sdT = 752;
  within(p.percentiles[50], p.mean, 1e-9, 'p50');
  for (const [q, z] of [[1, -2.3263478740408408], [5, -1.6448536269514722], [25, -0.6744897501960817], [75, 0.6744897501960817], [95, 1.6448536269514722], [99, 2.3263478740408408]]) {
    within(p.percentiles[q], 1280 + z * sdT, 1e-6, `p${q}`);
  }
  within(p.percentiles[5] + p.percentiles[95], 2 * p.mean, 1e-9, '5/95 symmetry');
  within(p.percentiles[1] + p.percentiles[99], 2 * p.mean, 1e-9, '1/99 symmetry');
});
test('brief sanity check: 256h, $5/hr, SD $47/hr gives SE about 2.9 and a 95% interval of about -$1 to $11 per hour', () => {
  const se = 47 / Math.sqrt(256);
  within(se, 2.9375, 1e-9, 'SE');
  const lo = 5 + invNorm(0.025) * se;
  const hi = 5 + invNorm(0.975) * se;
  within(lo, 5 - Z975 * 2.9375, 1e-9, 'lower');
  within(hi, 5 + Z975 * 2.9375, 1e-9, 'upper');
  assert.ok(lo > -1 && hi < 11, 'interval inside the brief round numbers -$1 to $11');
});
test('degenerate sd = 0: every percentile is the mean, chance of loss by sign of wr', () => {
  const win = project({ wr: 5, sd: 0, hoursT: 100 });
  for (const q of [1, 5, 25, 50, 75, 95, 99]) within(win.percentiles[q], 500, 1e-9, `p${q}`);
  assert.equal(win.chanceLoss, 0);
  assert.equal(project({ wr: -5, sd: 0, hoursT: 100 }).chanceLoss, 1);
});
test('losing player: chance of loss above 50%; input validation throws RangeError', () => {
  assert.ok(project({ wr: -2, sd: 30, hoursT: 500 }).chanceLoss > 0.5);
  assert.throws(() => project({ wr: NaN, sd: 47, hoursT: 100 }), RangeError);
  assert.throws(() => project({ wr: 5, sd: -1, hoursT: 100 }), RangeError);
  assert.throws(() => project({ wr: 5, sd: 47, hoursT: 0 }), RangeError);
});

console.log('downswings (brief: 2000 paths, 1-hour steps, size = biggest drop from peak, length = peak to recovery)');
test('determinism: same seed gives byte-identical output, different seed differs', () => {
  const a = downswings({ wr: 2, sd: 40, totalHours: 1500, seed: 123 });
  const b = downswings({ wr: 2, sd: 40, totalHours: 1500, seed: 123 });
  assert.deepEqual(a, b);
  const c = downswings({ wr: 2, sd: 40, totalHours: 1500, seed: 124 });
  assert.notDeepEqual(a.size, c.size);
  assert.notDeepEqual(a.lengthHours, c.lengthHours);
});
test('defaults: 2000 paths when paths is omitted', () => {
  assert.equal(downswings({ wr: 2, sd: 40, totalHours: 100, seed: 1 }).paths, 2000);
});
test('percentile monotonicity for size and lengthHours; lengths within [1, totalHours]', () => {
  const d = downswings({ wr: 2, sd: 40, totalHours: 1500, seed: 123 });
  for (const block of [d.size, d.lengthHours]) {
    assert.ok(block.p5 <= block.p25 && block.p25 <= block.p50 && block.p50 <= block.p75 && block.p75 <= block.p95,
      `monotone: ${JSON.stringify(block)}`);
  }
  assert.ok(d.size.p5 >= 0 && d.lengthHours.p5 >= 1 && d.lengthHours.p95 <= 1500);
});
test('seeded distribution sanity: mean of many paths near wr*T within 4 SE', () => {
  const d = downswings({ wr: 5, sd: 47, totalHours: 2000, paths: 2000, seed: 99 });
  const se = (47 * Math.sqrt(2000)) / Math.sqrt(2000); // 47
  within(d.finalsMean, 10000, 4 * se, 'finalsMean');
  const zero = downswings({ wr: 0, sd: 47, totalHours: 2000, paths: 2000, seed: 99 });
  within(zero.finalsMean, 0, 4 * se, 'zero-drift finalsMean');
});
test('zero SD walk: no downswing, peak beaten every hour, result exactly wr*T', () => {
  const d = downswings({ wr: 5, sd: 0, totalHours: 100, paths: 40, seed: 7 });
  for (const q of ['p5', 'p25', 'p50', 'p75', 'p95']) {
    within(d.size[q], 0, 1e-12, `size ${q}`);
    within(d.lengthHours[q], 1, 1e-12, `length ${q}`);
  }
  assert.equal(d.finalsMean, 500);
});
test('downswing sizes grow with horizon (longer play, bigger worst drops)', () => {
  const short = downswings({ wr: 0, sd: 40, totalHours: 200, seed: 55 });
  const long = downswings({ wr: 0, sd: 40, totalHours: 2000, seed: 55 });
  assert.ok(long.size.p50 > short.size.p50, `${long.size.p50} > ${short.size.p50}`);
});
test('validation: bad hours, paths, seed or SD throw RangeError', () => {
  assert.throws(() => downswings({ wr: 5, sd: -1, totalHours: 100 }), /Standard deviation/);
  assert.throws(() => downswings({ wr: 5, sd: 47, totalHours: 0 }), /Hours must be a whole number/);
  assert.throws(() => downswings({ wr: 5, sd: 47, totalHours: 100.5 }), /Hours must be a whole number/);
  assert.throws(() => downswings({ wr: 5, sd: 47, totalHours: 100, paths: 0 }), /Simulations must be a whole number/);
  assert.throws(() => downswings({ wr: 5, sd: 47, totalHours: 100, seed: -1 }), /Seed must be a whole number/);
  assert.throws(() => downswings({ wr: NaN, sd: 47, totalHours: 100 }), /Win rate/);
});

console.log('risk of ruin and bankroll (brief: exp(-2 x WR x B / SD^2), bankroll = -SD^2 x ln(r) / (2 x WR))');
test('exact formula: ror($500, $5/hr, SD $50) = exp(-2 * 5 * 500 / 2500) = exp(-2)', () => {
  within(ror(500, 5, 50), Math.exp(-2), 1e-15, 'ror');
  within(ror(100, 5, 50), Math.exp(-0.4), 1e-15, 'ror at $100');
});
test('matches js/variance.js brownianRuin at infinite horizon across a grid', () => {
  for (const B of [100, 2500, 100000]) {
    for (const wr of [0.5, 5, 25]) {
      for (const sd of [10, 47, 100]) {
        within(ror(B, wr, sd), brownianRuin(wr, sd, B, Infinity), 1e-15, `B=${B} wr=${wr} sd=${sd}`);
      }
    }
  }
});
test('ror is monotone decreasing in B; exactly 1 when wr <= 0; 0 with zero variance', () => {
  assert.ok(ror(50, 5, 50) > ror(100, 5, 50));
  assert.ok(ror(100, 5, 50) > ror(400, 5, 50));
  assert.ok(ror(400, 5, 50) > ror(4000, 5, 50));
  assert.equal(ror(100, 0, 50), 1);
  assert.equal(ror(100, -5, 50), 1);
  assert.equal(ror(100, 5, 0), 0);
});
test('bankrollFor: round trip ror(bankrollFor(r)) = r for many risk levels', () => {
  for (const r of [0.5, 0.2, 0.05, 0.01, 0.001]) {
    within(ror(bankrollFor(r, 5, 47), 5, 47), r, 1e-12, `r=${r}`);
  }
  within(bankrollFor(0.05, 5, 47), (-47 * 47 * Math.log(0.05)) / (2 * 5), 1e-12, 'exact value');
});
test('bankrollFor degenerate cases: wr <= 0 or bad r gives null, r = 1 gives 0', () => {
  assert.equal(bankrollFor(0.05, 0, 47), null);
  assert.equal(bankrollFor(0.05, -2, 47), null);
  assert.equal(bankrollFor(0, 5, 47), null);
  assert.equal(bankrollFor(1.2, 5, 47), null);
  assert.equal(bankrollFor(1, 5, 47), 0);
});

console.log('sensitivityRows (brief: my winrate, 70%, 30%, 0 with RoR now and bankroll for 5%)');
test('four rows in order with the right winrates, RoRs and bankrolls', () => {
  const rows = sensitivityRows(5, 47, 2000);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(r => r.label), ['My winrate', '70% of it', '30% of it', 'Break even']);
  within(rows[0].wr, 5, 1e-12); within(rows[1].wr, 3.5, 1e-12); within(rows[2].wr, 1.5, 1e-12);
  assert.equal(rows[3].wr, 0);
  within(rows[0].ror, ror(2000, 5, 47), 1e-15, 'row1 ror');
  within(rows[1].ror, ror(2000, 3.5, 47), 1e-15, 'row2 ror');
  within(rows[2].ror, ror(2000, 1.5, 47), 1e-15, 'row3 ror');
  assert.equal(rows[3].ror, 1);
  within(rows[0].bankrollFor5, bankrollFor(0.05, 5, 47), 1e-12, 'row1 bankroll');
  within(rows[1].bankrollFor5, bankrollFor(0.05, 3.5, 47), 1e-12, 'row2 bankroll');
  within(rows[2].bankrollFor5, bankrollFor(0.05, 1.5, 47), 1e-12, 'row3 bankroll');
  assert.equal(rows[3].bankrollFor5, null);
});
test('a losing player sees certain ruin and null bankrolls on every row', () => {
  const rows = sensitivityRows(-2, 40, 1000);
  assert.ok(rows.every(r => r.ror === 1 && r.bankrollFor5 === null), JSON.stringify(rows));
});

console.log('avgHoursPerMonth (brief: average hours over the last 90 days)');
const NOW = Date.parse('2026-10-10T12:00:00Z');
const H = 3600e3;
function sess(startIso, hours, breakHours = 0) {
  return {
    start_time: startIso,
    end_time: new Date(Date.parse(startIso) + hours * H).toISOString(),
    duration_seconds: hours * 3600,
    break_seconds: breakHours * 3600,
  };
}
test('sums played hours (breaks excluded) for sessions starting in the 90 day window, divides by 3', () => {
  const sessions = [
    sess('2026-10-01T20:00:00Z', 10),   // 10h
    sess('2026-09-01T20:00:00Z', 6, 1), // 5h played (1h break excluded)
    sess('2026-07-20T20:00:00Z', 8),    // 8h, inside the window
    sess('2026-07-01T20:00:00Z', 9),    // starts before the window: excluded
    sess('2026-10-11T20:00:00Z', 9),    // starts after nowMs: excluded
    sess('2026-07-12T12:00:00Z', 3),    // exactly on the cutoff: included
  ];
  within(avgHoursPerMonth(sessions, NOW), 26 / 3, 1e-12, 'avg');
});
test('a live session (no end_time) counts play up to nowMs', () => {
  const live = [{ start_time: '2026-10-10T10:00:00Z', break_seconds: 0 }];
  within(avgHoursPerMonth(live, NOW), 2 / 3, 1e-9, '2h elapsed');
});
test('empty or all-old history gives 0', () => {
  assert.equal(avgHoursPerMonth([], NOW), 0);
  assert.equal(avgHoursPerMonth([sess('2020-01-01T20:00:00Z', 10)], NOW), 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
