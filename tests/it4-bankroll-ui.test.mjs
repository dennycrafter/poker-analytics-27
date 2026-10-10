// It4 bankroll UI: the "What if your winrate is wrong?" row-builder
// (js/bankroll-ror-ui.js, brief section 4, bankroll part). The ror() and
// bankrollFor() formulas are the brief section 7 pins; the suite also
// cross-checks them against js/variance-cash.js once that module merges.
// Usage: TZ=UTC node tests/it4-bankroll-ui.test.mjs

import assert from 'node:assert/strict';
import { buildWinrateSensitivityRows, rorPercent, ror, bankrollFor, SENSITIVITY_FRACTIONS } from '../js/bankroll-ror-ui.js';

let pass = 0, fail = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// Production path: the row-builder's default math (no injection).
const build = (winrate, sd, bankroll) => buildWinrateSensitivityRows({ winrate, sd, bankroll });

console.log('"What if your winrate is wrong?" row-builder (brief section 4, bankroll part)');

test('four rows: my winrate, 70% of it, 30% of it, break even', () => {
  assert.deepEqual(SENSITIVITY_FRACTIONS.map(f => f.fraction), [1, 0.7, 0.3, 0]);
  const rows = build(5, 47, 2000);
  assert.deepEqual(rows.map(r => r.label), ['Your winrate', '70% of it', '30% of it', 'Break even']);
  close(rows[0].winrate, 5);
  close(rows[1].winrate, 3.5);
  close(rows[2].winrate, 1.5);
  close(rows[3].winrate, 0);
});

test('row shape matches what the screen consumes', () => {
  const rows = build(5, 47, 2000);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['bankrollFor5', 'fraction', 'label', 'ror', 'winrate']);
  assert.deepEqual(Object.keys(rows[3]).sort(), ['bankrollFor5', 'fraction', 'label', 'ror', 'winrate']);
});

test('pinned case: 0% row has ror 1 and a null bankroll for 5%', () => {
  const zero = build(5, 47, 2000)[3];
  assert.equal(zero.ror, 1);
  assert.equal(zero.bankrollFor5, null);
});

test('monotonic: ror rises as the winrate shrinks, bankroll for 5% grows', () => {
  const rows = build(5, 47, 2000);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].ror > rows[i - 1].ror, `ror not rising from row ${i - 1} to ${i}`);
  }
  assert.ok(rows[1].bankrollFor5 > rows[0].bankrollFor5, '70% row needs more bankroll');
  assert.ok(rows[2].bankrollFor5 > rows[1].bankrollFor5, '30% row needs more bankroll');
  assert.equal(rows[3].bankrollFor5, null);
});

test('row values match the brief formulas (wr 5, sd 47, B 2000)', () => {
  const rows = build(5, 47, 2000);
  const v = 47 * 47; // sd^2
  close(rows[0].ror, Math.exp((-2 * 5 * 2000) / v), 1e-12);
  close(rows[0].bankrollFor5, (v * Math.log(20)) / 10, 1e-9);
  close(rows[1].ror, Math.exp((-2 * 3.5 * 2000) / v), 1e-12);
  close(rows[1].bankrollFor5, (v * Math.log(20)) / 7, 1e-9);
  close(rows[2].ror, Math.exp((-2 * 1.5 * 2000) / v), 1e-12);
  close(rows[2].bankrollFor5, (v * Math.log(20)) / 3, 1e-9);
});

test('ror: brief formula, certain ruin when WR <= 0 or bankroll is gone', () => {
  close(ror(2000, 5, 47), Math.exp((-2 * 5 * 2000) / (47 * 47)), 1e-12);
  assert.equal(ror(2000, 0, 47), 1);
  assert.equal(ror(2000, -5, 47), 1);
  assert.equal(ror(0, 5, 47), 1);
  assert.equal(ror(-100, 5, 47), 1);
  close(ror(null, 5, 47), 1, 1e-12);
});

test('bankrollFor: brief formula, null when no bankroll can hold the risk', () => {
  close(bankrollFor(0.05, 5, 47), (47 * 47 * Math.log(20)) / 10, 1e-9);
  assert.equal(bankrollFor(0.05, 0, 47), null);
  assert.equal(bankrollFor(0.05, -5, 47), null);
  assert.equal(bankrollFor(0, 5, 47), null);
  assert.equal(bankrollFor(1, 5, 47), null);
  close(ror(bankrollFor(0.05, 5, 47), 5, 47), 0.05, 1e-9); // the pair inverts
});

test('negative observed winrate: every row is certain ruin with no 5% bankroll', () => {
  const rows = build(-5, 47, 2000);
  assert.ok(rows.every(r => r.ror === 1 && r.bankrollFor5 === null));
  close(rows[1].winrate, -3.5); // 70% of a losing rate walks it toward zero
  close(rows[2].winrate, -1.5);
});

test('no observed stats -> null so the screen hides the table', () => {
  assert.equal(build(NaN, 47, 2000), null);
  assert.equal(build(5, NaN, 2000), null);
  assert.equal(build(5, -1, 2000), null);
  assert.equal(build(Infinity, 47, 2000), null);
});

test('zero SD with a positive winrate: no ruin risk and no 5% target', () => {
  const rows = build(5, 0, 2000);
  close(rows[0].ror, 0, 1e-12);
  assert.equal(rows[0].bankrollFor5, null);
  assert.equal(rows[3].ror, 1);
});

test('injected fns receive (bankroll, rowWinrate, sd) and the 0.05 target', () => {
  const seen = [];
  buildWinrateSensitivityRows({
    winrate: 5, sd: 47, bankroll: 2000,
    rorFn: (B, wr, sd) => { seen.push(['ror', B, wr, sd]); return 0.5; },
    bankrollForFn: (r, wr, sd) => { seen.push(['b5', r, wr, sd]); return 123; },
  });
  assert.deepEqual(seen[0], ['ror', 2000, 5, 47]);
  assert.deepEqual(seen[1], ['b5', 0.05, 5, 47]);
  assert.equal(seen.length, 6); // 3 positive rows x 2 calls; the 0% row calls nothing
});

test('rorPercent: fraction to the screen integer percent, null for junk', () => {
  assert.equal(rorPercent(0.36787944117144233), 37);
  assert.equal(rorPercent(1), 100);
  assert.equal(rorPercent(0), 0);
  assert.equal(rorPercent(0.004), 0);
  assert.equal(rorPercent(null), null);
  assert.equal(rorPercent(NaN), null);
  assert.equal(rorPercent(Infinity), null);
});

test('variance-cash.js contract: matches the local brief-formula implementations', async () => {
  let vc = null;
  try { vc = await import('../js/variance-cash.js'); } catch (e) {
    if (!e || e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  }
  if (!vc) {
    console.log('  note  js/variance-cash.js is not on this branch yet (it4-cash-math lane); contract check skipped');
    return;
  }
  assert.equal(typeof vc.ror, 'function', 'variance-cash.js must export ror(B, wr, sd)');
  assert.equal(typeof vc.bankrollFor, 'function', 'variance-cash.js must export bankrollFor(risk, wr, sd)');
  // Fraction units per the brief formulas, not the stats.js percent scale.
  const r = vc.ror(2000, 5, 47);
  assert.ok(r > 0 && r <= 1, `ror(2000, 5, 47) must be a fraction, got ${r}`);
  close(r, ror(2000, 5, 47), 1e-9);
  assert.equal(vc.ror(2000, 0, 47), 1);
  assert.equal(vc.ror(2000, -5, 47), 1);
  const b5 = vc.bankrollFor(0.05, 5, 47);
  close(b5, bankrollFor(0.05, 5, 47), 1e-6);
  close(vc.ror(b5, 5, 47), 0.05, 1e-9);
});

for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
