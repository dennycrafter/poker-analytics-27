// Verification harness for the "Am I a winner?" card lane (variance brief,
// iteration 2). Pure helpers only: js/winner-ui.js runs without DOM and
// without js/inference.js (that module is a parallel lane's file and merges
// first; the screen's contract consumption is checked as source text).
// Usage: TZ=UTC node tests/it2-ui.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  cashRows, usableRows, hasAllHands, bbAvailable, clampConfidence, CONFIDENCE_DEFAULT,
  CONFIDENCE_MIN, CONFIDENCE_MAX, accuracyDefault, fmtRateShort, fmtRateFull,
  ciSentence, chancePct, bellCurveGeom,
} from '../js/winner-ui.js';

const root = new URL('..', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// ---- fixtures ------------------------------------------------------------

const T0 = Date.parse('2026-09-01T18:00:00Z');
// Mirrors the BankrollCoach import fixture semantics (brief 1.2): profit =
// cashout - buyin, hours from duration, BB is the second stakes number.
function cash(id, { hours = 0, buyIn = 0, cashedOut = 0, bb = 0, hands = 0, tips = 0 } = {}) {
  return {
    id, kind: 'cash', bankroll_id: 'bk', game_id: 'g', location_id: 'l', table_size: 9,
    start_time: new Date(T0).toISOString(),
    end_time: new Date(T0 + hours * 3600e3).toISOString(),
    duration_seconds: hours * 3600, break_seconds: 0, is_live: false, tracked_via_stack: false,
    small_blind: bb ? bb / 2 : 0, big_blind: bb, buy_in: buyIn, cashed_out: cashedOut, tips,
    hands_count: hands,
  };
}
function tournament(id, { buyIn = 100, prize = 0 } = {}) {
  return {
    id, kind: 'tournament', start_time: new Date(T0).toISOString(),
    end_time: new Date(T0 + 3600e3).toISOString(), duration_seconds: 3600, break_seconds: 0,
    is_live: false, total_buy_in: buyIn, prize,
  };
}
const emptyDoc = { stack_events: [], sell_actions: [] };

console.log('cashRows: pinned row shape [{p, h, bb, hands}] for winrateStats');

test('cashRows maps profit, hours, big blind and hands', () => {
  const s = cash('c1', { hours: 6, buyIn: 2000, cashedOut: 3400, bb: 10, hands: 120 });
  const [r] = cashRows(emptyDoc, [s]);
  assert.deepEqual(r, { p: 1400, h: 6, bb: 10, hands: 120 });
});

test('cashRows maps the 4h45m fixture row (brief 1.2 row 2)', () => {
  const s = cash('c2', { hours: 4.75, buyIn: 800, cashedOut: 950, bb: 5, hands: 143 });
  const [r] = cashRows(emptyDoc, [s]);
  assert.deepEqual(r, { p: 150, h: 4.75, bb: 5, hands: 143 });
});

test('cashRows subtracts tips', () => {
  const s = cash('c3', { hours: 2, buyIn: 100, cashedOut: 200, bb: 2, tips: 25 });
  assert.equal(cashRows(emptyDoc, [s])[0].p, 75);
});

test('cashRows derives profit from stack events for tracked sessions', () => {
  const s = { ...cash('c4', { hours: 1 }), tracked_via_stack: true };
  const doc = { stack_events: [
    { session_id: 'c4', kind: 'buy_in', amount: 100 },
    { session_id: 'c4', kind: 'cash_out', amount: 250 },
  ] };
  assert.equal(cashRows(doc, [s])[0].p, 150);
});

test('cashRows keeps only cash sessions', () => {
  const rows = cashRows(emptyDoc, [cash('c1', { hours: 1, buyIn: 100, cashedOut: 120, bb: 2 }), tournament('t1')]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].p, 20);
});

test('usableRows drops 0-hour rows (brief-7 formula divides by h_i)', () => {
  const rows = [{ p: 10, h: 2, bb: 2, hands: 40 }, { p: 5, h: 0, bb: 2, hands: 30 }];
  assert.deepEqual(usableRows(rows), [rows[0]]);
});

console.log('gates: SD/100 hands and the BB unit toggle');

test('hasAllHands: true only when every row has hands', () => {
  assert.equal(hasAllHands([{ hands: 40 }, { hands: 30 }]), true);
  assert.equal(hasAllHands([{ hands: 40 }, { hands: 0 }]), false);
  assert.equal(hasAllHands([{ hands: 40 }, { hands: null }]), false);
  assert.equal(hasAllHands([]), false);
});

test('bbAvailable: false when any row lacks a big blind', () => {
  assert.equal(bbAvailable([{ bb: 2 }, { bb: 5 }]), true);
  assert.equal(bbAvailable([{ bb: 2 }, { bb: 0 }]), false);
  assert.equal(bbAvailable([{ bb: 2 }, { bb: undefined }]), false);
  assert.equal(bbAvailable([]), false);
});

console.log('confidence input and accuracy defaults');

test('clampConfidence keeps whole numbers in [50, 99]', () => {
  assert.equal(clampConfidence(95), 95);
  assert.equal(clampConfidence(72), 72);
  assert.equal(clampConfidence(95.4), 95);
  assert.equal(clampConfidence(50), 50);
  assert.equal(clampConfidence(99), 99);
  assert.equal(clampConfidence(5), CONFIDENCE_MIN);
  assert.equal(clampConfidence(150), CONFIDENCE_MAX);
  assert.equal(clampConfidence(99.6), CONFIDENCE_MAX); // rounds to 100 first
  assert.equal(clampConfidence(-10), CONFIDENCE_MIN);
  assert.equal(CONFIDENCE_DEFAULT, 95);
});

test('clampConfidence falls back to 95 on bad input', () => {
  assert.equal(clampConfidence('abc'), 95);
  assert.equal(clampConfidence(undefined), 95);
  assert.equal(clampConfidence(NaN), 95);
  assert.equal(clampConfidence(''), 95);
});

test('accuracyDefault: plus or minus 2 currency, 0.5 BB', () => {
  assert.equal(accuracyDefault('usd'), 2);
  assert.equal(accuracyDefault('bb'), 0.5);
  assert.equal(accuracyDefault('other'), 2);
});

console.log('rate formatting for sentences and card values');

test('fmtRateShort (usd) rounds to whole units like the brief example', () => {
  assert.equal(fmtRateShort(-0.77, 'usd', 'EUR'), '-EUR 1/hr');
  assert.equal(fmtRateShort(10.77, 'usd', 'EUR'), 'EUR 11/hr');
  assert.equal(fmtRateShort(5, 'usd', 'EUR'), 'EUR 5/hr');
  assert.equal(fmtRateShort(0, 'usd', 'EUR'), 'EUR 0/hr');
});

test('fmtRateShort (bb) keeps decimals', () => {
  assert.equal(fmtRateShort(-0.2, 'bb'), '-0.2 BB/hr');
  assert.equal(fmtRateShort(2.256, 'bb'), '2.26 BB/hr');
  assert.equal(fmtRateShort(0, 'bb'), '0 BB/hr');
});

test('fmtRateShort shows -- for non-finite values', () => {
  assert.equal(fmtRateShort(NaN, 'usd', 'EUR'), '--');
  assert.equal(fmtRateShort(Infinity, 'bb'), '--');
});

test('fmtRateFull matches the metric unit styles', () => {
  assert.equal(fmtRateFull(2.936, 'usd', 'EUR'), 'EUR 2.94/h');
  assert.equal(fmtRateFull(0.309, 'bb'), '0.31 BB/h');
  assert.equal(fmtRateFull(null, 'usd', 'EUR'), '--');
});

console.log('the one plain sentence');

test('ciSentence matches the brief wording with whole-unit money', () => {
  const s = ciSentence({ confidence: 95, ci: [-0.77, 10.77], unit: 'usd', currency: 'EUR' });
  assert.equal(s, 'Based on your filtered sessions, you can be 95% sure your true winrate is between -EUR 1/hr and EUR 11/hr.');
});

test('ciSentence in BB mode', () => {
  const s = ciSentence({ confidence: 90, ci: [-0.2, 2.25], unit: 'bb' });
  assert.equal(s, 'Based on your filtered sessions, you can be 90% sure your true winrate is between -0.2 BB/hr and 2.25 BB/hr.');
});

test('ciSentence defaults to usd and EUR', () => {
  const s = ciSentence({ confidence: 95, ci: [1, 9] });
  assert.equal(s, 'Based on your filtered sessions, you can be 95% sure your true winrate is between EUR 1/hr and EUR 9/hr.');
});

test('ciSentence has no em or en dashes', () => {
  for (const unit of ['usd', 'bb']) {
    const s = ciSentence({ confidence: 95, ci: [-3, 7], unit });
    assert.ok(!s.includes('\u2014') && !s.includes('\u2013'), unit);
  }
});

console.log('chance percent');

test('chancePct rounds the probability to a whole percent', () => {
  assert.equal(chancePct(0.9554), 96);
  assert.equal(chancePct(0.5), 50);
  assert.equal(chancePct(0), 0);
  assert.equal(chancePct(1), 100);
});

test('chancePct returns null for non-finite input', () => {
  assert.equal(chancePct(NaN), null);
  assert.equal(chancePct(undefined), null);
});

console.log('bell curve geometry');

const GEOM = bellCurveGeom({ wr: 5, se: 2.94, ci: [-0.77, 10.77], width: 340, height: 160 });

test('bellCurveGeom returns null without a usable standard error', () => {
  assert.equal(bellCurveGeom({ wr: 5, se: 0, ci: [4, 6] }), null);
  assert.equal(bellCurveGeom({ wr: 5, se: -1 }), null);
  assert.equal(bellCurveGeom({ wr: NaN, se: 2 }), null);
});

test('bellCurveGeom samples the density over 61 points, all positive, peak 1', () => {
  assert.equal(GEOM.points.length, 61);
  for (const p of GEOM.points) assert.ok(p.y > 0 && p.y <= 1);
  const peak = GEOM.points.reduce((a, b) => (b.y > a.y ? b : a));
  assert.ok(Math.abs(peak.y - 1) < 0.01, 'peak height ' + peak.y);
  const step = (GEOM.x1 - GEOM.x0) / 60;
  assert.ok(Math.abs(peak.x - 5) <= step, 'peak at wr, off by ' + Math.abs(peak.x - 5));
});

test('bellCurveGeom domain covers break-even and both interval bounds', () => {
  // Domain extends 0.5 se beyond the outermost anchor, so strict inequalities.
  assert.ok(GEOM.x0 < Math.min(0, -0.77, 5 - 3 * 2.94));
  assert.ok(GEOM.x1 > Math.max(0, 10.77, 5 + 3 * 2.94));
});

test('bellCurveGeom paths stay inside the viewBox', () => {
  for (const [path, what] of [[GEOM.curvePath, 'curve'], [GEOM.bandPath, 'band']]) {
    assert.ok(path && path.startsWith('M'), what);
    const nums = path.replace(/[MLZ]/g, ' ').trim().split(/\s+/).map(Number);
    assert.equal(nums.length % 2, 0, what + ' coordinate pairs');
    for (let i = 0; i < nums.length; i += 2) {
      assert.ok(nums[i] >= 0 && nums[i] <= 340, what + ' x ' + nums[i]);
      assert.ok(nums[i + 1] >= 0 && nums[i + 1] <= 160, what + ' y ' + nums[i + 1]);
    }
  }
  assert.ok(GEOM.bandPath.endsWith('Z'));
});

test('bellCurveGeom band spans the interval and the zero line sits between pads', () => {
  assert.ok(GEOM.loX < GEOM.hiX);
  assert.ok(GEOM.zeroX >= GEOM.padL && GEOM.zeroX <= 340 - GEOM.padR);
  assert.ok(GEOM.yTop < GEOM.yBase);
});

test('bellCurveGeom defaults the band to wr +/- 1.96 se when ci is omitted', () => {
  const g = bellCurveGeom({ wr: 0, se: 1 });
  assert.ok(g.bandPath, 'band built');
  const span = g.hiX - g.loX;
  const total = 340 - g.padL - g.padR;
  // Domain: wr +/- 3se (always the widest anchor here) plus 0.5 se each side.
  const expected = (2 * 1.96) / (2 * 3 + 2 * 0.5);
  assert.ok(Math.abs(span / total - expected) < 0.01, 'band share ' + span / total + ' vs ' + expected);
});

test('bellCurveGeom still shades a narrow interval inside a tall domain', () => {
  const g = bellCurveGeom({ wr: 5, se: 0.4, ci: [4.9, 5.1] });
  assert.ok(g.bandPath, 'band built');
  assert.ok(g.loX < g.hiX);
});

console.log('lane contracts (source text, module-graph free)');

test('screens/stats.js consumes the pinned inference contract', () => {
  const src = read('js/screens/stats.js');
  for (const name of ['winrateStats', 'hoursToKnow', 'MIN_SESSIONS', 'NEED_MORE_MESSAGE']) {
    assert.ok(src.includes(name), name + ' used');
  }
  assert.ok(src.includes("from '../inference.js'"), 'imports inference.js');
});

test('winner-ui.js stays independent of js/inference.js (base-testable)', () => {
  assert.ok(!read('js/winner-ui.js').match(/from\s+'[^']*inference/), 'no inference import');
});

test('stats screen renders the card, gates and SD/100 rows', () => {
  const src = read('js/screens/stats.js');
  assert.ok(src.includes('Am I a winner?'), 'card title');
  assert.ok(src.includes("esc(NEED_MORE_MESSAGE)"), 'below-10 message');
  assert.ok(src.includes('SD per 100 hands'), 'SD/100 rows');
  assert.ok(src.includes('winnerConfidence'), 'editable confidence');
  assert.ok(src.includes('Hours until you know within'), 'hours-to-know input');
});

// The no-dash rule covers UI text; code comments elsewhere in the repo may
// use em dashes, so only winner-ui.js (wholly mine) and the card's own
// literals are scanned.
test('no em or en dashes in any winner-card UI string', () => {
  const ui = read('js/winner-ui.js');
  assert.ok(!ui.includes('\u2014') && !ui.includes('\u2013'), 'js/winner-ui.js');
  const fragments = [
    'Am I a winner?', 'Observed winrate', 'Standard error', 'confidence interval',
    'Confidence %', 'Possible true winrate. Shaded: ', '% interval. Dashed line: break even.',
    "Chance you're a winner", 'Hours until you know within', 'Hours needed at 95%',
    'about ', ' hours', ' to ', ' sessions', 'BB/hr', 'SD per 100 hands', 'SD per 100 hands in BB',
  ];
  const src = read('js/screens/stats.js');
  for (const f of fragments) {
    assert.ok(!f.includes('\u2014') && !f.includes('\u2013'), f);
    assert.ok(src.includes(f), 'present: ' + f);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
