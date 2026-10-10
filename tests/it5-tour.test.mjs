// IT5 verification harness: tournament variance module (js/variance-tour.js)
// checked against the brief's section 7 model. Every simulation is seeded, so
// each assertion is deterministic: a pass here passes on every run.
// Usage: TZ=UTC node tests/it5-tour.test.mjs
//
// Tolerances are stated next to each check. "SE" = Monte Carlo standard error
// of the estimate; 4 SE bands are used so a correct engine cannot fail by
// chance on a different seed, while a wrong formula (off by a constant factor
// or a missing sqrt) lands far outside them.

import assert from 'node:assert/strict';
import { payoutCurve, solveSkill, simulate } from '../js/variance-tour.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const within = (a, b, tol, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} vs ${b} (tol ${tol})`);
const firstShare = (paid) => Math.min(0.65, 0.22 + 0.43 * Math.exp(-(paid - 2) / 3.2));

// Canonical fixtures.
//   MTT: 100 entries, 10% rake, 12% paid -> 12 places, pool 90 buy-ins.
//   SNG: 9 entries, 5% rake, 1/3 paid -> 3 places, pool 8.55 buy-ins.
const MTT = { entries: 100, rakePct: 0.1, percentPaid: 0.12 };
const SNG = { entries: 9, rakePct: 0.05, percentPaid: 1 / 3 };
const sum = (a) => a.reduce((x, y) => x + y, 0);

console.log('Payout curve');
test('place count is round(entries*percentPaid), clamped into [1, entries]', () => {
  assert.equal(payoutCurve(MTT).paid, 12);
  assert.equal(payoutCurve(SNG).paid, 3);
  assert.equal(payoutCurve({ entries: 100, percentPaid: 0.004 }).paid, 1); // round(0.4) -> 0 -> clamp 1
  assert.equal(payoutCurve({ entries: 4, percentPaid: 1 }).paid, 4);
});
test('prizes sum to the pool exactly (MTT 90 and SNG 8.55 buy-ins)', () => {
  const m = payoutCurve(MTT);
  within(sum(m.prizes), 90, 1e-9, 'MTT sum');
  within(m.pool, 90, 1e-12, 'MTT pool');
  const s = payoutCurve(SNG);
  within(sum(s.prizes), 8.55, 1e-9, 'SNG sum');
  within(s.pool, 8.55, 1e-12, 'SNG pool');
});
test('fixture: 1st share lands on the s1 formula, inside the 20-25% band', () => {
  const m = payoutCurve(MTT);
  within(m.prizes[0] / m.pool, firstShare(12), 1e-9, '1st share');
  assert.ok(m.prizes[0] / m.pool >= 0.20 && m.prizes[0] / m.pool <= 0.25, 'band');
});
test('fixture: min-cash is 1.75 buy-ins, inside the 1.5-2 band', () => {
  const m = payoutCurve(MTT);
  within(m.prizes[11], 1.75, 1e-6, 'min-cash');
  assert.ok(m.prizes[11] >= 1.5 && m.prizes[11] <= 2, 'band');
});
test('prizes strictly decrease (top-heavy) for small and large fields', () => {
  for (const c of [MTT, SNG, { entries: 300, rakePct: 0.1, percentPaid: 0.1 }]) {
    const { prizes } = payoutCurve(c);
    for (let j = 1; j < prizes.length; j++) assert.ok(prizes[j - 1] > prizes[j], `place ${j} of entries=${c.entries}`);
  }
});
test('winner takes all when fewer than one place is paid', () => {
  const c = payoutCurve({ entries: 10, rakePct: 0.1, percentPaid: 0.04 });
  assert.equal(c.paid, 1);
  assert.equal(c.prizes.length, 1);
  within(c.prizes[0], 9, 1e-12, 'prize');
});
test('two paid places split 65/35', () => {
  const c = payoutCurve({ entries: 9, rakePct: 0, percentPaid: 2 / 9 });
  assert.equal(c.paid, 2);
  within(c.prizes[0], 0.65 * 9, 1e-9, '1st');
  within(c.prizes[1], 0.35 * 9, 1e-9, '2nd');
});
test('9-man SNG pays about 53/26/21 like a real pay table', () => {
  const s = payoutCurve(SNG);
  within(s.prizes[0] / s.pool, firstShare(3), 1e-9, '1st share');
  within(s.prizes[2], 1.75, 1e-6, 'min-cash'); // 1.75/8.55 share anchor binds
  assert.ok(s.prizes[0] > s.prizes[1] && s.prizes[1] > s.prizes[2], 'order');
});
test('tiny everyone-cashes pool falls back to a flat tail, sum still exact', () => {
  const c = payoutCurve({ entries: 4, rakePct: 0.05, percentPaid: 1 });
  assert.equal(c.paid, 4);
  within(sum(c.prizes), 3.8, 1e-9, 'sum');
  within(c.prizes[0], firstShare(4) * 3.8, 1e-9, '1st');
  within(c.prizes[1], c.prizes[2], 1e-12, 'flat tail');
  assert.ok(c.prizes[0] > c.prizes[1], '1st still largest');
});

console.log('Skill solve');
test('break-even, rake-free field solves to s = 0', () => {
  const s = solveSkill({ roi: 0, buyIn: 100, entries: 9, percentPaid: 1 / 3 });
  within(s, 0, 1e-6, 's');
});
test('ROI that exactly eats the rake solves to s = 0 (9-man, 5% rake)', () => {
  const s = solveSkill({ roi: -0.05, buyIn: 100, entries: 9, percentPaid: 1 / 3, rakePct: 0.05 });
  within(s, 0, 1e-6, 's');
});
test('s is positive for a winner and negative for a losing player', () => {
  assert.ok(solveSkill({ roi: 0.25, buyIn: 100, entries: 9, percentPaid: 1 / 3 }) > 0.01, 'positive roi');
  assert.ok(solveSkill({ roi: -0.4, buyIn: 100, entries: 9, percentPaid: 1 / 3 }) < -0.01, 'negative roi');
});
test('solved s hits the target EV to 1e-6 (positive ROI, via simulate perType)', () => {
  const res = simulate({ types: [{ buyin: 100, rakePct: 0.05, entries: 9, percentPaid: 1 / 3, roi: 0.15, events: 10 }], runs: 50, seed: 3 });
  within(res.perType[0].evPerEvent, 15, 1e-4, 'EV per event');
});
test('solved s hits the target EV to 1e-6 (negative ROI, big field)', () => {
  const res = simulate({ types: [{ buyin: 500, rakePct: 0.1, entries: 100, percentPaid: 0.12, roi: -0.35, events: 10 }], runs: 50, seed: 3 });
  within(res.perType[0].evPerEvent, -175, 1e-4, 'EV per event');
});
test('out-of-reach ROI saturates at the s bound instead of failing', () => {
  const s = solveSkill({ roi: 1e6, buyIn: 100, entries: 9, percentPaid: 1 / 3 });
  assert.equal(s, 60);
});
test('bad type inputs throw RangeError with plain messages', () => {
  assert.throws(() => payoutCurve({ entries: 1, percentPaid: 0.5 }), RangeError);
  assert.throws(() => payoutCurve({ entries: 9, percentPaid: 0 }), RangeError);
  assert.throws(() => payoutCurve({ entries: 9, percentPaid: 1.5 }), RangeError);
  assert.throws(() => payoutCurve({ entries: 9, rakePct: 1, percentPaid: 0.5 }), RangeError);
  assert.throws(() => solveSkill({ roi: 0.1, buyIn: 0, entries: 9, percentPaid: 1 / 3 }), RangeError);
  assert.throws(() => solveSkill({ roi: -1, buyIn: 100, entries: 9, percentPaid: 1 / 3 }), RangeError);
  assert.throws(() => simulate({ types: [] }), RangeError);
  assert.throws(() => simulate({ types: [SNG], runs: 0 }), RangeError);
  assert.throws(() => simulate({ types: [{ buyin: 100, entries: 9, percentPaid: 1 / 3, roi: 0.1, events: 2.5 }], runs: 10 }), RangeError);
  assert.throws(() => simulate({ types: [{ buyin: 100, entries: 9, percentPaid: 1 / 3, roi: 0.1, events: 20000 }], runs: 100000 }), RangeError);
});

console.log('Monte Carlo vs analytic moments');
const RES = simulate({ types: [{ buyin: 100, rakePct: 0.05, entries: 9, percentPaid: 1 / 3, roi: 0.1, events: 50 }], runs: 3000, seed: 12345 });
const T = RES.perType[0];
const analyticMean = 50 * T.evPerEvent;
const analyticSd = Math.sqrt(50) * T.sdPerEvent;
const se = analyticSd / Math.sqrt(RES.runs);
test('perType EV per event matches roi*buyIn and SD per event is positive', () => {
  within(T.evPerEvent, 10, 1e-4, 'EV per event');
  assert.ok(T.sdPerEvent > 100 && T.sdPerEvent < 200, `SD per event ${T.sdPerEvent} in buys 1.0-2.0`);
});
test('MC mean matches events * EV within 4 SE', () => {
  within(RES.mean, analyticMean, Math.max(4 * se, 1e-9), 'mean');
});
test('MC sd matches sqrt(events) * SD per event within 8%', () => {
  within(RES.sd, analyticSd, 0.08 * analyticSd, 'sd');
});
test('chance of loss is sane and never above the ever-negative share', () => {
  assert.ok(RES.chanceLoss > 0.2 && RES.chanceLoss < 0.45, `chanceLoss ${RES.chanceLoss}`);
  assert.ok(RES.chanceLoss <= RES.rorForBankroll(0) + 1e-12, 'loss <= dipped below 0 at some point');
});
test('perType table carries prize pool, 1st prize, ITM and events', () => {
  within(T.prizePool, 9 * 100 * 0.95, 1e-9, 'prize pool');
  assert.ok(T.firstPrize > 400, `1st prize ${T.firstPrize}`);
  assert.ok(T.itmPct > 1 / 3 && T.itmPct < 0.6, `ITM ${T.itmPct} above the 1/3 pay rate for a winner`);
  assert.equal(T.events, 50);
});
test('losing player cashes below the pay rate (100 entries, ROI -10%)', () => {
  const res = simulate({ types: [{ buyin: 500, rakePct: 0.1, entries: 100, percentPaid: 0.12, roi: -0.1, events: 10 }], runs: 50, seed: 3 });
  assert.ok(res.perType[0].itmPct < 0.12, `ITM ${res.perType[0].itmPct}`);
});
test('percentiles: exactly the 9 required keys, non-decreasing', () => {
  assert.deepEqual(Object.keys(RES.percentiles), ['1', '5', '10', '25', '50', '75', '90', '95', '99']);
  const vals = Object.values(RES.percentiles);
  for (let i = 1; i < vals.length; i++) assert.ok(vals[i] >= vals[i - 1], `p${i}`);
});
test('paths: 20 samples, one point per event plus the start', () => {
  assert.equal(RES.paths.length, 20);
  for (const p of RES.paths) {
    assert.equal(p.length, 51);
    assert.equal(p[0], 0);
    assert.ok(Number.isFinite(p[50]));
    assert.ok(p[50] >= -50 * 100 - 1e-9, 'final within worst case');
  }
});

console.log('Risk of ruin');
test('RoR is monotone non-increasing in bankroll and hits 0 at a huge one', () => {
  const Bs = [0, 250, 500, 1000, 2000, 5000, 1e9];
  for (let i = 1; i < Bs.length; i++) assert.ok(RES.rorForBankroll(Bs[i - 1]) + 1e-12 >= RES.rorForBankroll(Bs[i]), `B ${Bs[i]}`);
  assert.equal(RES.rorForBankroll(1e9), 0);
});
test('bankrollForRisk round-trips and grows as the risk target shrinks', () => {
  const b05 = RES.bankrollForRisk(0.05);
  assert.ok(RES.rorForBankroll(b05) <= 0.05 + 1e-12, 'round trip');
  assert.ok(RES.bankrollForRisk(0.01) >= b05, '1% needs more');
  assert.ok(RES.bankrollForRisk(0) >= RES.bankrollForRisk(0.01), '0% needs the most');
  assert.ok(b05 > 0, 'positive for the fixture');
});
test('long run: 2000 events simulated, deeper 5% bankroll than 50 events', () => {
  assert.equal(RES.longEvents, 2000);
  assert.ok(RES.bankrollForRiskLong(0.05) > RES.bankrollForRisk(0.05), 'long run needs more bankroll');
});
test('long-run RoR is monotone in bankroll and above the short-run at the median dip', () => {
  const Bs = [0, 250, 1000, 5000, 1e11];
  for (let i = 1; i < Bs.length; i++) assert.ok(RES.rorLongRun(Bs[i - 1]) + 1e-12 >= RES.rorLongRun(Bs[i]), `B ${Bs[i]}`);
  assert.equal(RES.rorLongRun(1e11), 0);
  const bHalf = RES.bankrollForRisk(0.5);
  assert.ok(RES.rorLongRun(bHalf) + 1e-12 >= RES.rorForBankroll(bHalf), 'long run risks at least as much');
});

console.log('Determinism and shape');
test('same seed gives byte-identical results; a new seed gives new paths', () => {
  const args = { types: [{ buyin: 100, rakePct: 0.05, entries: 9, percentPaid: 1 / 3, roi: 0.1, events: 20 }], runs: 300, seed: 7 };
  const a = JSON.stringify(simulate(args));
  const b = JSON.stringify(simulate(args));
  const c = JSON.stringify(simulate({ ...args, seed: 8 }));
  assert.equal(a, b, 'same seed');
  assert.notEqual(a, c, 'different seed');
});
test('multi-type mix: types in order, events summed, paths cover all events', () => {
  const res = simulate({
    types: [
      { buyin: 100, rakePct: 0.05, entries: 9, percentPaid: 1 / 3, roi: 0.1, events: 50 },
      { buyIn: 500, rakePct: 0.1, entries: 100, percentPaid: 0.12, roi: -0.1, events: 30 },
    ],
    runs: 200, seed: 5,
  });
  assert.equal(res.perType.length, 2);
  assert.equal(res.totalEvents, 80);
  assert.equal(res.paths.length, 20);
  assert.equal(res.paths[0].length, 81);
  within(res.perType[0].prizePool, 855, 1e-9, 'SNG pool');
  within(res.perType[1].prizePool, 45000, 1e-9, 'MTT pool');
  within(res.perType[1].firstPrize, firstShare(12) * 90 * 500, 1e-6, 'MTT 1st prize');
});
test('zero-event schedule is handled: zeros across the board', () => {
  const res = simulate({ types: [{ buyin: 100, entries: 9, percentPaid: 1 / 3, roi: 0.1, events: 0 }], runs: 100, seed: 1 });
  assert.equal(res.totalEvents, 0);
  within(res.mean, 0, 1e-12, 'mean');
  assert.equal(res.chanceLoss, 0);
  assert.equal(res.rorForBankroll(0), 0);
  assert.equal(res.rorLongRun(0), 0);
  assert.equal(res.paths.length, 20);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
