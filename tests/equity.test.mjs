// Tier 9 verification harness: equity calculator (js/equity.js).
// Runs the real module. Usage: node tests/equity.test.mjs
//
// Published reference figures (±0.5pp tolerance):
//   AA vs KK (suit-specific, one shared suit) 81.946 / 18.054  flopturnriver.com "Poker Hands Odds"
//   AsAh vs KsKh (both suits shared)          82.6 / 17.4      pokerpro.tools (exact enumeration)
//   AsAh vs KdKc (no shared suit)             81.3 / 18.7      pokerspot.gg (exact enumeration)
//   AKs vs QQ                                 46.049 / 53.951  flopturnriver.com
//   QsQh vs AdKd (no shared suit)             53.8 / 46.2      pokerspot.gg
//   9-out flush draw on the flop              ~35-36%          holdempro.app, allinblind.com (34.97%)
//   PLO AsKsAhKh vs KdQdKcQc (AAKK ds v KKQQ ds) 69.1 exact     pokerpro.tools
//   PLO AsAh7d2c vs Th9h8s7s                  50.4 / 49.6      pokerpro.tools
//   PLO5 AsAhKsKh2d vs KcKdQcQd3s             67.1 / 32.9      pokerpro.tools (200k MC)
//   AA vs a random hand                       85.2             widely quoted (gitnux.org)
// Flop spots with exact cards (FD vs top pair, set vs OESD) are pinned to
// exact equality with an independent brute-force evaluator written in this
// file. Published exact-card flop tables disagreed with each other and with
// brute force (e.g. one quotes AsKh vs JhTh on Ad7h2h at 63/37; brute force
// gives 67.68), so they are not used as oracles.
// PLO KhKsJh9s vs AcAd7c2s (double-suited KKxx vs AAxx) is a regression pin,
// not a published oracle: preflop exact enumeration of all 1,086,008 boards =
// 41.41 / 58.59; the four flop targets are this engine's exact values (820
// runouts each) rounded to 0.1.

import assert from 'node:assert/strict';
import {
  calculateEquity, prepareEquity, parseCards, evaluateCards, evaluateOmaha,
  handCategory, makeRng, formatCards, streetName,
} from '../js/equity.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const near = (actual, expected, tol, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tol, `${label} ${actual.toFixed(3)} not within ${tol} of ${expected}`);
const eq = (input) => {
  const r = calculateEquity(input);
  if (r.error) throw new Error(r.error);
  return r;
};
const cards = s => parseCards(s).cards;

// ---- independent naive evaluator (cross-check only) ------------------------
// Scores a 5-card hand as a base-16 tuple; best of all 5-card subsets.
function rank5(cs) {
  const r = cs.map(c => c >> 2).sort((a, b) => b - a);
  const flush = cs.every(c => (c & 3) === (cs[0] & 3));
  const cnt = {};
  r.forEach(x => { cnt[x] = (cnt[x] || 0) + 1; });
  const g = Object.entries(cnt).map(([k, v]) => [v, +k]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const u = [...new Set(r)];
  let st = -1;
  if (u.length === 5) {
    if (u[0] - u[4] === 4) st = u[0];
    else if (u.join() === '12,3,2,1,0') st = 3;
  }
  let t;
  if (st >= 0 && flush) t = [8, st];
  else if (g[0][0] === 4) t = [7, g[0][1], g[1][1]];
  else if (g[0][0] === 3 && g[1][0] === 2) t = [6, g[0][1], g[1][1]];
  else if (flush) t = [5, ...r];
  else if (st >= 0) t = [4, st];
  else if (g[0][0] === 3) t = [3, ...g.map(x => x[1])];
  else if (g[0][0] === 2 && g[1][0] === 2) t = [2, ...g.map(x => x[1])];
  else if (g[0][0] === 2) t = [1, ...g.map(x => x[1])];
  else t = [0, ...r];
  while (t.length < 6) t.push(0);
  return t.reduce((a, x) => a * 16 + x, 0);
}
function naiveBest(cs) {
  let best = -1;
  const n = cs.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    const v = rank5(cs.filter((_, i) => i !== a && i !== b));
    if (v > best) best = v;
  }
  return best;
}
// Heads-up NLH flop equity by brute force over every turn+river.
function naiveFlopEquity(h1, h2, flop) {
  const A = cards(h1), B = cards(h2), F = cards(flop);
  const used = new Set([...A, ...B, ...F]);
  const deck = [...Array(52).keys()].filter(c => !used.has(c));
  let share = 0, n = 0;
  for (let i = 0; i < deck.length; i++) for (let j = i + 1; j < deck.length; j++) {
    const b = [...F, deck[i], deck[j]];
    const a = naiveBest([...A, ...b]), v = naiveBest([...B, ...b]);
    share += a > v ? 1 : a === v ? 0.5 : 0;
    n++;
  }
  return (share / n) * 100;
}

console.log('Evaluator');

test('hand categories: every rank class recognised', () => {
  const cases = [
    ['AsKsQsJsTs', 8], ['5d4d3d2dAd', 8], ['9c9d9h9s2c', 7], ['KcKdKh2s2c', 6],
    ['Ah9h7h4h2h', 5], ['Ts9h8d7c6s', 4], ['5s4h3d2cAs', 4], ['7s7h7d3c2s', 3],
    ['JsJh4d4c2s', 2], ['QsQh9d5c2s', 1], ['AsJh9d5c2s', 0],
  ];
  for (const [h, cat] of cases) assert.equal(handCategory(evaluateCards(cards(h))), cat, h);
});

test('kickers and tie-breaks order correctly', () => {
  const v = h => evaluateCards(cards(h));
  assert.ok(v('6s5h4d3c2s') > v('5s4h3d2cAs'), '6-high straight beats the wheel');
  assert.ok(v('AsAhKdQc9s') > v('AsAhKdQc8s'), 'fifth kicker counts for one pair');
  assert.ok(v('KsKhQdQc3s') > v('KsKhJdJcAs'), 'second pair before kicker');
  assert.equal(v('AsKsQs Js9s'.replace(' ', '')), v('AhKhQhJh9h'), 'suits do not rank');
  assert.ok(v('3s3h3d2c2s') < v('2s2h2dAcAs') === false, 'trips rank decides the boat');
});

test('evaluator matches naive brute force on 20,000 random 7-card showdowns', () => {
  const rng = makeRng(5);
  let mismatches = 0;
  for (let t = 0; t < 20000; t++) {
    const d = [...Array(52).keys()];
    for (let i = 0; i < 14; i++) { const j = i + Math.floor(rng() * (52 - i)); [d[i], d[j]] = [d[j], d[i]]; }
    const A = d.slice(0, 7), B = d.slice(7, 14);
    if (Math.sign(evaluateCards(A) - evaluateCards(B)) !== Math.sign(naiveBest(A) - naiveBest(B))) mismatches++;
  }
  assert.equal(mismatches, 0);
});

test('Omaha uses exactly two hole cards and three board cards', () => {
  // Four spades in hand + one on board is not a flush in Omaha.
  const v1 = evaluateOmaha(cards('AsKsQsJs'), cards('2s7h8d9cTh'));
  assert.notEqual(handCategory(v1), 5);
  // Royal-looking hand with one board ten: broadway needs three hole cards and
  // the wheel needs four board cards, so Omaha scores this as ace-high.
  assert.equal(handCategory(evaluateOmaha(cards('AsKsQsJs'), cards('Ts2c3d4c5d'))), 0, 'no straight with 2 hole + 3 board');
  // Contrast: Hold'em plays any five of seven, so the same cards are a royal flush.
  assert.equal(handCategory(evaluateCards(cards('AsKsQsJsTs2c3d'))), 8, 'NLH 7-card royal for contrast');
  // Board quads do not play: best is quads only if two hole cards fit.
  assert.notEqual(handCategory(evaluateOmaha(cards('2c3d4h5s'), cards('9s9h9d9cKs'))), 7);
});

console.log('Published matchups');

test('AA vs KK, one shared suit (AhAs vs KhKc) = 81.95/18.05 (suit-average figure)', () => {
  const r = eq({ hands: ['AhAs', 'KhKc'], exactLimit: Infinity });
  assert.equal(r.method, 'exact');
  assert.equal(r.samples, 1712304);
  near(r.players[0].equity, 81.946, 0.5, 'AA');
  near(r.players[1].equity, 18.054, 0.5, 'KK');
});

test('AA vs KK suit variants: both suits shared 82.6, none shared 81.3', () => {
  near(eq({ hands: ['AsAh', 'KsKh'], exactLimit: Infinity }).players[0].equity, 82.6, 0.5, 'shared');
  near(eq({ hands: ['AsAh', 'KdKc'], exactLimit: Infinity }).players[0].equity, 81.3, 0.5, 'unshared');
});

test('AA vs KK Monte Carlo 100k agrees with the published figure', () => {
  const r = eq({ hands: ['AhAs', 'KhKc'], trials: 100000, seed: 27 });
  assert.equal(r.method, 'monte-carlo');
  near(r.players[0].equity, 81.946, 0.5, 'AA');
});

test('AKs vs QQ: suit average 46.05/53.95 and QsQh vs AdKd 53.8/46.2', () => {
  const shared = eq({ hands: ['AsKs', 'QsQd'], exactLimit: Infinity }).players[0].equity;
  const unshared = eq({ hands: ['AsKs', 'QhQd'], exactLimit: Infinity }).players[0].equity;
  // Half of QQ combos contain the AKs suit: average of the two cases.
  near((shared + unshared) / 2, 46.049, 0.5, 'AKs avg');
  near(eq({ hands: ['QsQh', 'AdKd'], exactLimit: Infinity }).players[0].equity, 53.8, 0.5, 'QQ');
  near(eq({ hands: ['AsKs', 'QhQd'] }).players[0].equity, 46.2, 0.5, 'AKs MC');
});

test('flush draw vs top pair on the flop: AsKd vs 9h8h on Kh7h2s = 60/40, exact', () => {
  const r = eq({ hands: ['AsKd', '9h8h'], board: 'Kh7h2s' });
  assert.equal(r.method, 'exact');
  assert.equal(r.samples, 990);
  near(r.players[1].equity, 40, 0.5, 'FD');
  near(r.players[0].equity, naiveFlopEquity('AsKd', '9h8h', 'Kh7h2s'), 1e-9, 'brute force');
});

test('pure nine-out flush draw vs top pair ~36/64 (KsQd vs Qh5h on Kh8h2c)', () => {
  const r = eq({ hands: ['KsQd', 'Qh5h'], board: 'Kh8h2c' });
  near(r.players[1].equity, 36, 0.5, 'FD');
  near(r.players[0].equity, naiveFlopEquity('KsQd', 'Qh5h', 'Kh8h2c'), 1e-9, 'brute force');
});

test('set vs open-ended straight draw (7s7d vs 9h8h on 7c6s2d) ~74/26, brute-force exact', () => {
  const r = eq({ hands: ['7s7d', '9h8h'], board: '7c6s2d' });
  near(r.players[0].equity, naiveFlopEquity('7s7d', '9h8h', '7c6s2d'), 1e-9, 'brute force');
  near(r.players[0].equity, 74, 0.5, 'set');
});

test('PLO double-suited AAKK vs KKQQ (AsKsAhKh vs KdQdKcQc) = 69.1 (MC 100k)', () => {
  const r = eq({ game: 'plo4', hands: ['AsKsAhKh', 'KdQdKcQc'] });
  near(r.players[0].equity, 69.1, 0.5, 'AAKK');
});

test('PLO double-suited KKxx vs AAxx (KhKsJh9s vs AcAd7c2s) preflop 41.1-41.4 and four flops', () => {
  const hands = ['KhKsJh9s', 'AcAd7c2s'];
  near(eq({ game: 'plo4', hands }).players[0].equity, 41.25, 0.5, 'preflop');
  const flops = [['KdTc4h', 87.3], ['KcTc4h', 67.0], ['Ts8s5d', 59.8], ['Ah8d3c', 6.6]];
  for (const [board, want] of flops) {
    const r = eq({ game: 'plo4', hands, board });
    assert.equal(r.method, 'exact');
    near(r.players[0].equity, want, 0.5, board);
  }
});

test('PLO bad aces vs rundown (AsAh7d2c vs Th9h8s7s) = 50.4/49.6', () => {
  near(eq({ game: 'plo4', hands: ['AsAh7d2c', 'Th9h8s7s'] }).players[0].equity, 50.4, 0.5, 'aces');
});

test('PLO5 AsAhKsKh2d vs KcKdQcQd3s = 67.1/32.9', () => {
  near(eq({ game: 'plo5', hands: ['AsAhKsKh2d', 'KcKdQcQd3s'] }).players[0].equity, 67.1, 0.5, 'PLO5');
});

console.log('Invariants');

test('equities sum to 100 and win+tie+lose = 100, across games and player counts', () => {
  const spots = [
    { hands: ['AsAh', 'KsKh', 'QsQh', 'JsJh', 'TsTh', '9s9h'], trials: 20000 },
    { hands: ['AsKd', '9h8h', 'QcQd'], board: 'Kh7h2s' },
    { game: 'plo4', hands: ['AsAhJsTh', 'KcKdQcJd', '9s8s7d6d'], trials: 20000 },
    { game: 'plo5', hands: ['AsAhKsKh2d', '', ''], trials: 5000 },
    { hands: ['AsAh', ''], board: 'Kd' },
  ];
  for (const s of spots) {
    const r = eq(s);
    const total = r.players.reduce((a, p) => a + p.equity, 0);
    near(total, 100, 1e-6, 'equity sum');
    for (const p of r.players) {
      near(p.win + p.tie + p.lose, 100, 1e-9, 'w+t+l');
      assert.ok(p.win >= 0 && p.tie >= 0 && p.lose >= -1e-9);
    }
  }
});

test('identical hands tie: AsKd vs AhKc splits exactly 50/50', () => {
  const r = eq({ hands: ['AsKd', 'AhKc'], exactLimit: Infinity });
  near(r.players[0].equity, 50, 1e-9, 'p1');
  near(r.players[1].equity, 50, 1e-9, 'p2');
  assert.ok(r.players[0].tie > 90, 'mostly ties');
});

test('board plays on the river: both players tie 100%', () => {
  const r = eq({ hands: ['2s3d', '2h3c'], board: 'AsKsQsJsTs' });
  assert.equal(r.method, 'exact');
  assert.equal(r.samples, 1);
  assert.equal(r.players[0].tie, 100);
  assert.equal(r.players[1].equity, 50);
});

test('river spot is a single exact runout; turn spot enumerates 44 rivers', () => {
  const river = eq({ hands: ['AsAh', 'KsKh'], board: 'Kd7c2h3s9d' });
  assert.deepEqual([river.method, river.samples, river.players[1].win], ['exact', 1, 100]);
  const turn = eq({ hands: ['AsKd', '9h8h'], board: 'Kh7h2s3c' });
  assert.deepEqual([turn.method, turn.samples], ['exact', 44]);
});

test('Monte Carlo is deterministic for a seed and converges to exact', () => {
  const a = eq({ hands: ['AsKs', 'QhQd'], trials: 50000, seed: 11 });
  const b = eq({ hands: ['AsKs', 'QhQd'], trials: 50000, seed: 11 });
  const c = eq({ hands: ['AsKs', 'QhQd'], trials: 50000, seed: 12 });
  assert.deepEqual(a.players, b.players);
  assert.notDeepEqual(a.players, c.players);
  const exact = eq({ hands: ['AsKs', 'QhQd'], exactLimit: Infinity });
  near(a.players[0].equity, exact.players[0].equity, 0.5, 'MC vs exact');
});

test('flop exact matches Monte Carlo on the same spot', () => {
  const exact = eq({ hands: ['AsKd', '9h8h', 'QcQd'], board: 'Kh7h2s' });
  const mc = eq({ hands: ['AsKd', '9h8h', 'QcQd'], board: 'Kh7h2s', exactLimit: 0, trials: 100000 });
  assert.equal(mc.method, 'monte-carlo');
  exact.players.forEach((p, i) => near(mc.players[i].equity, p.equity, 0.5, `player ${i + 1}`));
});

test('dead cards are removed from the deck', () => {
  const live = eq({ hands: ['AsKd', '9h8h'], board: 'Kh7h2s' });
  const dead = eq({ hands: ['AsKd', '9h8h'], board: 'Kh7h2s', dead: 'Ah5h' });
  assert.equal(dead.samples, 903); // C(43,2)
  assert.ok(dead.players[1].equity < live.players[1].equity, 'two dead hearts hurt the flush draw');
});

test('a random opponent is dealt when hole cards are blank (AA vs random ~85.2)', () => {
  const r = eq({ hands: ['AsAh', ''], trials: 100000 });
  assert.equal(r.method, 'monte-carlo');
  near(r.players[0].equity, 85.2, 0.5, 'AA vs any two');
});

console.log('Validation');

test('bad input returns { error } instead of throwing', () => {
  const bad = [
    [{ hands: ['AsKd'] }, /2-6 players/],
    [{ hands: ['AsKd', 'QhQd', 'JcJd', 'Tc9c', '8s8h', '7c7d', '6h6s'] }, /2-6 players/],
    [{ hands: ['AsKd', 'AsQd'] }, /As is used twice/],
    [{ hands: ['AsKd', 'QhQd'], board: 'Qh7c2d' }, /Qh is used twice/],
    [{ hands: ['AsKdQc', 'QhQd'] }, /Player 1: NLH hands have 2 cards/],
    [{ hands: ['AsKd', 'Zz'] }, /"Zz" is not a card/],
    [{ hands: ['AsKd', 'QhQd'], board: '2c3c4c5c6c7c' }, /at most 5 cards/],
    [{ game: 'stud', hands: ['AsKd', 'QhQd'] }, /Unknown game/],
    [{ hands: ['AsKd', 'QhQd'], trials: 0 }, /positive integer/],
  ];
  for (const [input, re] of bad) {
    const r = calculateEquity(input);
    assert.ok(r.error && re.test(r.error), `${JSON.stringify(input)} -> ${r.error}`);
  }
});

test('parsing accepts picker arrays, ids, "10", spaces and case', () => {
  assert.equal(formatCards(parseCards('as 10h, kD').cards), 'AsThKd');
  const { spec } = prepareEquity({ hands: [[cards('As')[0], null], ['Kd', 'Kc']], board: [null, 'Qh'] });
  assert.deepEqual(spec.hands.map(formatCards), ['As', 'KdKc']);
  assert.equal(formatCards(spec.board), 'Qh');
  assert.equal(spec.unknownHole, 1);
  assert.equal(streetName(0), 'Preflop');
  assert.equal(streetName(4), 'Turn');
});

console.log('Performance');

function rate(label, input) {
  const t0 = performance.now();
  const r = eq(input);
  const ms = performance.now() - t0;
  console.log(`       ${label}: ${r.samples} trials in ${ms.toFixed(0)} ms = ${Math.round(r.samples / ms * 1000).toLocaleString('en-US')} trials/s`);
  return ms;
}

test('100k trials < 2s: NLH heads-up preflop', () => {
  assert.ok(rate('NLH HU 100k', { hands: ['AhAs', 'KhKc'], trials: 100000 }) < 2000);
});
test('100k trials < 2s: NLH 6-way preflop', () => {
  assert.ok(rate('NLH 6-way 100k', { hands: ['AsAh', 'KsKh', 'QsQh', 'JsJh', 'TsTh', '9s9h'], trials: 100000 }) < 2000);
});
test('100k trials < 2s: PLO4 heads-up preflop', () => {
  assert.ok(rate('PLO4 HU 100k', { game: 'plo4', hands: ['AsKsAhKh', 'KdQdKcQc'], trials: 100000 }) < 2000);
});
test('100k trials < 2s: PLO5 heads-up preflop', () => {
  assert.ok(rate('PLO5 HU 100k', { game: 'plo5', hands: ['AsAhKsKh2d', 'KcKdQcQd3s'], trials: 100000 }) < 2000);
});
test('worst case reported: PLO5 6-way 100k (no hard limit, logged)', () => {
  rate('PLO5 6-way 100k', { game: 'plo5', hands: ['AsAhKsKh2d', 'QcQdJcJd2c', 'Ts9s8d7d2h', '6h5h4c3c2s', '3d3s4s4d5s', 'AcAd9h8h5d'], trials: 100000 });
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
