// IT6 verification harness: the 12-month year simulator (js/year-sim.js).
// Every year is seeded, so each assertion is deterministic: a pass here
// passes on every run.
// Usage: TZ=UTC node tests/it6-year.test.mjs
//
// Tolerances are stated next to each check. "SE" = Monte Carlo standard
// error; 4 SE bands are used so a correct engine cannot fail by chance.

import assert from 'node:assert/strict';
import { simulateYear } from '../js/year-sim.js';
import { normalCdf, mulberry32, normalSampler } from '../js/variance.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const within = (a, b, tol, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} vs ${b} (tol ${tol})`);

const WR = 5, SD = 47, HPM = 100, SEED = 42;

console.log('simulateYear (brief: 12 months at the real winrate and SD, z per month)');
test('consumes the seeded stream in order: month result = ev + sd*sqrt(hpm) x normal', () => {
  const y = simulateYear({ wr: WR, sd: SD, hoursPerMonth: HPM, seed: SEED });
  const normal = normalSampler(mulberry32(SEED));
  for (let m = 0; m < 12; m++) {
    const z = normal();
    within(y.months[m].result, WR * HPM + SD * Math.sqrt(HPM) * z, 1e-9, `month ${m} result`);
    within(y.months[m].ev, WR * HPM, 1e-12, `month ${m} ev`);
    within(y.months[m].z, z, 1e-12, `month ${m} z`);
  }
  assert.equal(y.months.length, 12);
});
test('z identity: z = (result - ev) / (sd * sqrt(hours)) for every month', () => {
  const y = simulateYear({ wr: WR, sd: SD, hoursPerMonth: HPM, seed: SEED });
  for (const m of y.months) {
    within(m.z, (m.result - m.ev) / (SD * Math.sqrt(HPM)), 1e-9, 'z');
  }
});
test('annual sums: annual = sum of month results, annualEv = 12 x wr x hours', () => {
  const y = simulateYear({ wr: WR, sd: SD, hoursPerMonth: HPM, seed: SEED });
  within(y.annual, y.months.reduce((a, m) => a + m.result, 0), 1e-9, 'annual');
  within(y.annualEv, 12 * WR * HPM, 1e-12, 'annualEv');
});
test('luckiest and unluckiest point at the max and min result months (0-based indexes)', () => {
  const y = simulateYear({ wr: WR, sd: SD, hoursPerMonth: HPM, seed: SEED });
  const results = y.months.map(m => m.result);
  assert.equal(y.months[y.luckiest].result, Math.max(...results));
  assert.equal(y.months[y.unluckiest].result, Math.min(...results));
  assert.ok(y.luckiest >= 0 && y.luckiest <= 11 && y.unluckiest >= 0 && y.unluckiest <= 11);
});
test('zero SD: every month lands exactly on EV with z = 0', () => {
  const y = simulateYear({ wr: 3, sd: 0, hoursPerMonth: 80, seed: 5 });
  for (const m of y.months) { assert.equal(m.result, m.ev); assert.equal(m.z, 0); }
  assert.equal(y.annual, y.annualEv);
  assert.equal(y.annualEv, 3 * 80 * 12);
});
test('determinism: same seed gives byte-identical output, different seed differs', () => {
  const a = simulateYear({ wr: WR, sd: SD, hoursPerMonth: HPM, seed: SEED });
  const b = simulateYear({ wr: WR, sd: SD, hoursPerMonth: HPM, seed: SEED });
  assert.deepEqual(a, b);
  const c = simulateYear({ wr: WR, sd: SD, hoursPerMonth: HPM, seed: SEED + 1 });
  assert.notDeepEqual(a.months, c.months);
});
test('omitted seed defaults to 27 (matches js/variance.js convention)', () => {
  const a = simulateYear({ wr: WR, sd: SD, hoursPerMonth: HPM });
  const b = simulateYear({ wr: WR, sd: SD, hoursPerMonth: HPM, seed: 27 });
  assert.deepEqual(a, b);
});
test('distribution sanity over 4000 seeded years: mean annual near EV and lucky/unlucky shares near 15.9%', () => {
  const N = 4000;
  let sum = 0, lucky = 0, unlucky = 0;
  for (let s = 0; s < N; s++) {
    const y = simulateYear({ wr: WR, sd: SD, hoursPerMonth: HPM, seed: s });
    sum += y.annual;
    for (const m of y.months) {
      if (m.z > 1) lucky++;
      if (m.z < -1) unlucky++;
    }
  }
  const sdAnnual = SD * Math.sqrt(12 * HPM);
  within(sum / N, 12 * WR * HPM, (4 * sdAnnual) / Math.sqrt(N), 'mean annual');
  const p = 1 - normalCdf(1); // share of months beyond +1 SD
  const se = Math.sqrt((p * (1 - p)) / (N * 12)); // SE of the share itself
  within(lucky / (N * 12), p, 4 * se, 'lucky share (z > 1)');
  within(unlucky / (N * 12), p, 4 * se, 'unlucky share (z < -1)');
});
test('fractional hours per month work and stay exact for the month SD', () => {
  const y = simulateYear({ wr: WR, sd: SD, hoursPerMonth: 42.5, seed: 9 });
  within(y.months[0].ev, WR * 42.5, 1e-12, 'ev');
  within(y.months[0].z, (y.months[0].result - y.months[0].ev) / (SD * Math.sqrt(42.5)), 1e-9, 'z');
});
test('validation: bad winrate, SD, hours or seed throw RangeError', () => {
  assert.throws(() => simulateYear({ wr: NaN, sd: 47, hoursPerMonth: 100 }), /Win rate/);
  assert.throws(() => simulateYear({ wr: 5, sd: -1, hoursPerMonth: 100 }), /Standard deviation/);
  assert.throws(() => simulateYear({ wr: 5, sd: 47, hoursPerMonth: 0 }), /Hours per month/);
  assert.throws(() => simulateYear({ wr: 5, sd: 47, hoursPerMonth: NaN }), /Hours per month/);
  assert.throws(() => simulateYear({ wr: 5, sd: 47, hoursPerMonth: 100, seed: -1 }), /Seed must be a whole number/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
