// Tier 8 verification harness: Monte Carlo variance simulator (js/variance.js)
// checked against closed-form math. Every simulation is seeded, so each
// assertion is deterministic: a pass here passes on every run.
// Usage: node tests/variance.test.mjs
//
// Tolerances are stated next to each check. "SE" = Monte Carlo standard error
// of the estimate; 4 SE bands are used so a correct engine cannot fail by
// chance on a different seed, while a wrong formula (off by a constant factor
// or a missing sqrt) lands far outside them.

import assert from 'node:assert/strict';
import {
  simulateCash, simulateTournament, tournamentOutcomes, brownianRuin, discreteRuin,
  normalCdf, mulberry32, normalSampler, quantileSorted, checkpointUnits,
  cashParamsError, tournamentParamsError, normalizeCash, normalizeTournament, RUIN_CONTINUITY_BETA,
} from '../js/variance.js';
import { riskOfRuin, hourlyMoments } from '../js/stats.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const within = (a, b, tol, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} vs ${b} (tol ${tol})`);
const se = (p, n) => Math.sqrt((p * (1 - p)) / n);
const Z05 = 1.6448536269514722;
const HUGE = 1e12; // bankroll large enough that ruin is impossible

// ---- fixture: two 1h cash sessions, +55 and -45 -> mean 5/h, variance 2500 (SD 50/h)
const T0 = Date.parse('2026-09-01T18:00:00Z');
const H = 3600e3;
function cash(id, startH, hours, buyIn, cashedOut) {
  return {
    id, kind: 'cash', bankroll_id: 'bk', game_id: 'g', location_id: 'l', table_size: 9,
    start_time: new Date(T0 + startH * H).toISOString(), end_time: new Date(T0 + (startH + hours) * H).toISOString(),
    duration_seconds: hours * 3600, break_seconds: 0, is_live: false, tracked_via_stack: false,
    small_blind: 1, big_blind: 2, buy_in: buyIn, cashed_out: cashedOut, tips: 0,
  };
}
const doc = {
  settings: { currency: 'EUR' }, bankrolls: [{ id: 'bk', name: 'Live', is_default: true }],
  games: [{ id: 'g', name: "NL Hold'em" }], locations: [{ id: 'l', name: 'UCD' }], tournament_types: [], groups: [],
  sessions: [cash('c1', 0, 1, 100, 155), cash('c2', 24, 1, 100, 55)],
  stack_events: [], sell_actions: [], transactions: [], player_notes: [], hand_histories: [],
};
const BANKROLL = 500;

console.log('Analytic risk of ruin vs js/stats.js riskOfRuin (formula 12)');
const m = hourlyMoments(doc, doc.sessions);
const sigma = Math.sqrt(m.variance);
test('fixture moments from js/stats.js hourlyMoments: mean 5/h, variance 2500', () => {
  within(m.mean, 5, 1e-12); within(m.variance, 2500, 1e-9);
});
test('stats.js riskOfRuin = round(100*exp(-2*mu*B/var)) = 14; module closed form agrees exactly', () => {
  const analytic = Math.exp((-2 * m.mean * BANKROLL) / m.variance); // exp(-2) = 0.1353...
  within(analytic, Math.exp(-2), 1e-15);
  assert.equal(riskOfRuin(doc, doc.sessions, BANKROLL), 14);
  within(brownianRuin(m.mean, sigma, BANKROLL), analytic, 1e-15, 'module');
  assert.equal(Math.round(brownianRuin(m.mean, sigma, BANKROLL) * 100), riskOfRuin(doc, doc.sessions, BANKROLL));
});
test('negative/zero edge: both say ruin is certain when mean <= 0', () => {
  const losing = { ...doc, sessions: [cash('l1', 0, 1, 100, 45), cash('l2', 24, 1, 100, 55)] };
  assert.equal(riskOfRuin(losing, losing.sessions, BANKROLL), 100);
  assert.equal(brownianRuin(-50, 5, BANKROLL), 1);
  assert.equal(brownianRuin(0, 50, BANKROLL), 1);
});
test('finite-horizon ruin increases with horizon and converges to exp(-2*mu*B/var)', () => {
  const a = brownianRuin(5, 50, 500, 100), b = brownianRuin(5, 50, 500, 1000), c = brownianRuin(5, 50, 500, 1e6);
  assert.ok(a < b && b < c, `${a} < ${b} < ${c}`);
  within(c, Math.exp(-2), 1e-6, 'T=1e6');
});

// Simulated RoR (16 sub-steps per hour, 2000h ≈ infinite horizon at this drift).
const fine = simulateCash({ winRate: m.mean, stdDev: sigma, bankroll: BANKROLL, hours: 2000, paths: 4000, stepsPerHour: 16, seed: 101 });
test('Monte Carlo RoR (16 steps/h, 4000 paths) within 4 SE of discrete-corrected analytic', () => {
  const target = discreteRuin(m.mean, sigma, BANKROLL, 2000, sigma / 4);
  within(fine.riskOfRuin, target, 4 * se(target, 4000), 'sim vs corrected');
});
test('Monte Carlo RoR (16 steps/h) within 2.5 pp of the stats.js closed form exp(-2) = 13.53%', () => {
  within(fine.riskOfRuin, Math.exp(-2), 0.025, 'sim vs stats.js formula');
});
const coarse = simulateCash({ winRate: m.mean, stdDev: sigma, bankroll: BANKROLL, hours: 1000, paths: 20000, stepsPerHour: 1, seed: 102 });
test('hourly-step walk: sim within 4 SE of corrected analytic, and the correction is closer than raw BM', () => {
  const corrected = discreteRuin(m.mean, sigma, BANKROLL, 1000, sigma);
  const raw = brownianRuin(m.mean, sigma, BANKROLL, 1000);
  within(coarse.riskOfRuin, corrected, 4 * se(corrected, 20000), 'sim vs corrected');
  assert.ok(Math.abs(coarse.riskOfRuin - corrected) < Math.abs(coarse.riskOfRuin - raw), 'continuity correction should help');
  within(RUIN_CONTINUITY_BETA, 0.5826, 1e-4);
});
test('analytic block on the result reports the same closed forms', () => {
  within(fine.analytic.ruinInfinite, Math.exp(-2), 1e-15);
  within(fine.analytic.sdNet, sigma * Math.sqrt(2000), 1e-9);
});

console.log('SD of aggregate = sigma * sqrt(N)');
const N = 400;
const agg = simulateCash({ winRate: 5, stdDev: 50, bankroll: HUGE, hours: N, paths: 20000, seed: 7 });
test('cash: SD of net after 400h within 3% of 50*sqrt(400) = 1000 (SE of SD ≈ 0.5%)', () => {
  within(agg.net.sd, 50 * Math.sqrt(N), 0.03 * 1000, 'sd');
});
test('cash: mean net within 4 SE of mu*N = 2000', () => {
  within(agg.net.mean, 5 * N, (4 * 1000) / Math.sqrt(20000), 'mean');
});
test('cash: sub-stepping keeps per-hour SD (8 steps/h -> same sigma*sqrt(N))', () => {
  const r = simulateCash({ winRate: 5, stdDev: 50, bankroll: HUGE, hours: 100, paths: 10000, stepsPerHour: 8, seed: 8 });
  within(r.net.sd, 500, 0.03 * 500, 'sd');
});
const TP = { buyIn: 20, roi: 0.2, field: 200, itm: 0.15, steepness: 1 };
const table = tournamentOutcomes(TP);
test('tournament table: EV = buyIn*roi exactly, prize pool = field * buyIn, probs sum to 1', () => {
  within(table.mean, 4, 1e-9, 'EV');
  within(table.outcomes.filter(o => o.place).reduce((a, o) => a + o.multiple, 0), 200, 1e-9, 'pool');
  within(table.outcomes.reduce((a, o) => a + o.prob, 0), 1, 1e-12, 'probs');
  assert.equal(table.paid, 30);
  within(table.cashProb, 0.18, 1e-12, 'ITM rate = itm*(1+roi)');
});
const tAgg = simulateTournament({ ...TP, bankroll: HUGE, tournaments: 100, paths: 20000, seed: 9 });
test('tournament: SD of net after 100 MTTs within 5% of sd*sqrt(100) (heavy tail -> wider band)', () => {
  within(tAgg.net.sd, table.sd * 10, 0.05 * table.sd * 10, 'sd');
});
test('tournament: mean net within 4 SE of EV*N = 400', () => {
  within(tAgg.net.mean, 400, (4 * table.sd * 10) / Math.sqrt(20000), 'mean');
});

console.log('Percentiles converge (CLT) as paths grow');
// Cash, no ruin: final bankroll ~ Normal(B + mu*N, sigma^2*N) exactly.
const cltN = 100, s = 50 * Math.sqrt(cltN), mid = 1000 + 5 * cltN;
const exact = { p5: mid - Z05 * s, p50: mid, p95: mid + Z05 * s };
function pctError(paths, seed) {
  const r = simulateCash({ winRate: 5, stdDev: 50, bankroll: 1000, hours: cltN, paths, seed });
  // bankroll 1000 vs sd 500 and drift +5/h: ruin is possible, so use a huge bankroll for exactness
  return r;
}
function err(paths, seed) {
  const r = simulateCash({ winRate: 5, stdDev: 50, bankroll: HUGE, hours: cltN, paths, seed });
  const f = r.finalBankroll, off = HUGE - 1000;
  return Math.max(Math.abs(f.p5 - off - exact.p5), Math.abs(f.p50 - off - exact.p50), Math.abs(f.p95 - off - exact.p95));
}
const seeds = [11, 12, 13, 14, 15];
const avgErr = paths => seeds.reduce((a, sd) => a + err(paths, sd), 0) / seeds.length;
const e200 = avgErr(200), e2k = avgErr(2000), e20k = avgErr(20000);
test(`p5/p50/p95 max error shrinks: 200 paths ${e200.toFixed(1)} > 2000 ${e2k.toFixed(1)} > 20000 ${e20k.toFixed(1)}`, () => {
  assert.ok(e200 > e2k && e2k > e20k);
});
test('at 20000 paths every percentile is within 4% of sigma*sqrt(N) of the normal quantile', () => {
  assert.ok(e20k < 0.04 * s, `${e20k} vs ${0.04 * s}`);
});
test('error ratio 200 -> 20000 paths is roughly sqrt(100) = 10x (accept 4x..25x)', () => {
  const ratio = e200 / e20k;
  assert.ok(ratio > 4 && ratio < 25, `ratio ${ratio}`);
});
test('ruin floors paths at 0: p5 >= 0 when ruin is possible', () => {
  const r = pctError(5000, 16);
  assert.ok(r.finalBankroll.min >= 0 && r.riskOfRuin > 0);
});

console.log('Probability of being down after N');
test('P(down after 400h) within 4 SE of Phi(-mu*sqrt(N)/sigma) = Phi(-2) = 2.28%', () => {
  const target = normalCdf(-2);
  within(agg.probDown, target, 4 * se(target, 20000), 'down');
  within(agg.probDownAt[agg.probDownAt.length - 1].p, agg.probDown, 1e-12, 'last checkpoint');
});
test('P(down) decreases with N for a winning player (checkpoints at 100h and 400h)', () => {
  const at = u => agg.probDownAt.find(x => x.unit >= u).p;
  within(at(100), normalCdf(-1), 4 * se(normalCdf(-1), 20000), 'at 100h');
  assert.ok(at(100) > at(400));
});

console.log('Max downswing distribution');
test('zero drift: mean max downswing ≈ sqrt(pi/2)*sigma*sqrt(T) minus discrete correction (within 4%)', () => {
  const r = simulateCash({ winRate: 0, stdDev: 100, bankroll: HUGE, hours: 400, paths: 5000, stepsPerHour: 4, seed: 21 });
  const target = Math.sqrt(Math.PI / 2) * 100 * 20 - 2 * RUIN_CONTINUITY_BETA * 50;
  within(r.maxDownswing.mean, target, 0.04 * target, 'E[MDD]');
});
test('downswing percentiles ordered, histogram counts every path', () => {
  const d = agg.maxDownswing;
  assert.ok(d.min >= 0 && d.p5 <= d.p50 && d.p50 <= d.p95 && d.p95 <= d.max);
  assert.equal(d.histogram.reduce((a, b) => a + b.count, 0), 20000);
});

console.log('Determinism and edge cases');
test('same seed -> identical output; different seed -> different output (cash)', () => {
  const a = simulateCash({ winRate: 5, stdDev: 50, bankroll: 800, hours: 300, paths: 500, seed: 42 });
  const b = simulateCash({ winRate: 5, stdDev: 50, bankroll: 800, hours: 300, paths: 500, seed: 42 });
  const c = simulateCash({ winRate: 5, stdDev: 50, bankroll: 800, hours: 300, paths: 500, seed: 43 });
  assert.deepEqual(JSON.stringify(a), JSON.stringify(b));
  assert.notEqual(JSON.stringify(a), JSON.stringify(c));
});
test('same seed -> identical output (tournament)', () => {
  const a = simulateTournament({ ...TP, bankroll: 1000, tournaments: 200, paths: 500, seed: 42 });
  const b = simulateTournament({ ...TP, bankroll: 1000, tournaments: 200, paths: 500, seed: 42 });
  assert.deepEqual(JSON.stringify(a), JSON.stringify(b));
});
test('mulberry32 and Box-Muller: uniform mean 0.5, normal mean 0 / variance 1 (n=200k, 5 SE)', () => {
  const rng = mulberry32(1);
  let su = 0; for (let i = 0; i < 200000; i++) su += rng();
  within(su / 200000, 0.5, 5 * Math.sqrt(1 / 12 / 200000), 'uniform mean');
  const z = normalSampler(mulberry32(2));
  let s1 = 0, s2 = 0; for (let i = 0; i < 200000; i++) { const v = z(); s1 += v; s2 += v * v; }
  within(s1 / 200000, 0, 5 / Math.sqrt(200000), 'normal mean');
  within(s2 / 200000, 1, 5 * Math.sqrt(2 / 200000), 'normal var');
});
test('zero SD is deterministic: losing rate always busts, winning rate never does', () => {
  const lose = simulateCash({ winRate: -1, stdDev: 0, bankroll: 50, hours: 100, paths: 10 });
  assert.equal(lose.riskOfRuin, 1); assert.equal(lose.finalBankroll.max, 0);
  const win = simulateCash({ winRate: 1, stdDev: 0, bankroll: 50, hours: 100, paths: 10 });
  assert.equal(win.riskOfRuin, 0); within(win.finalBankroll.p50, 150, 1e-9);
});
test('validation rejects bad input with a message; simulate throws RangeError', () => {
  assert.match(cashParamsError(normalizeCash({ winRate: 5, stdDev: -1, bankroll: 1, hours: 1, paths: 1 })), /Standard deviation/);
  assert.match(cashParamsError(normalizeCash({ winRate: 5, stdDev: 1, bankroll: 0, hours: 1, paths: 1 })), /Bankroll/);
  assert.match(cashParamsError(normalizeCash({ winRate: 5, stdDev: 1, bankroll: 1, hours: 1.5, paths: 1 })), /Hours/);
  assert.match(tournamentParamsError(normalizeTournament({ buyIn: 10, roi: 9, field: 10, itm: 0.5, bankroll: 1, tournaments: 1, paths: 1 })), /ROI too high/);
  assert.equal(cashParamsError(normalizeCash({ winRate: 5, stdDev: 50, bankroll: 1, hours: 1, paths: 1 })), null);
  assert.throws(() => simulateCash({ winRate: NaN, stdDev: 1, bankroll: 1, hours: 1, paths: 1 }), RangeError);
});
test('quantile + checkpoint helpers', () => {
  within(quantileSorted([0, 10], 0.25), 2.5, 1e-12);
  assert.deepEqual(checkpointUnits(5), [1, 2, 3, 4, 5]);
  const cp = checkpointUnits(1000);
  assert.equal(cp.length, 60); assert.equal(cp[cp.length - 1], 1000);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
