// Tier 9: pure picker-state helpers behind the equity screen (js/equity-state.js).
// Usage: node tests/equity-state.test.mjs

import assert from 'node:assert/strict';
import { parseCards, calculateEquity } from '../js/equity.js';
import {
  initialEquityState, normaliseEquityState, setGame, addPlayer, removePlayer, clearCards,
  cardAt, setCard, usedCards, nextEmptySlot, boardCount, isCalculable, equityInput,
  describeCard, monteCarloMargin,
} from '../js/equity-state.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const id = s => parseCards(s).cards[0];

test('initial state: NLH, two empty 2-card hands, five empty board slots', () => {
  const s = initialEquityState();
  assert.equal(s.game, 'nlh');
  assert.deepEqual(s.players, [[null, null], [null, null]]);
  assert.deepEqual(s.board, [null, null, null, null, null]);
  assert.equal(isCalculable(s), false);
});

test('setCard moves a card that is already used, so duplicates are impossible', () => {
  let s = setCard(initialEquityState(), { zone: 'player', player: 0, slot: 0 }, id('As'));
  s = setCard(s, { zone: 'board', slot: 2 }, id('As'));
  assert.equal(s.players[0][0], null);
  assert.equal(s.board[2], id('As'));
  assert.equal(usedCards(s).size, 1);
});

test('setCard never mutates its input', () => {
  const s0 = initialEquityState();
  const snapshot = JSON.stringify(s0);
  setCard(s0, { zone: 'player', player: 1, slot: 1 }, id('Kd'));
  assert.equal(JSON.stringify(s0), snapshot);
});

test('clearing a slot with null leaves other cards alone', () => {
  let s = setCard(initialEquityState(), { zone: 'player', player: 0, slot: 0 }, id('As'));
  s = setCard(s, { zone: 'player', player: 0, slot: 1 }, id('Ks'));
  s = setCard(s, { zone: 'player', player: 0, slot: 0 }, null);
  assert.deepEqual(s.players[0], [null, id('Ks')]);
});

test('nextEmptySlot advances within the zone, wraps, and returns null when full', () => {
  let s = initialEquityState();
  assert.deepEqual(nextEmptySlot(s, { zone: 'board', slot: 0 }), { zone: 'board', slot: 1 });
  s = setCard(s, { zone: 'board', slot: 1 }, id('2c'));
  assert.deepEqual(nextEmptySlot(s, { zone: 'board', slot: 0 }), { zone: 'board', slot: 2 });
  s = setCard(s, { zone: 'player', player: 1, slot: 0 }, id('Ah'));
  assert.deepEqual(nextEmptySlot(s, { zone: 'player', player: 1, slot: 0 }), { zone: 'player', player: 1, slot: 1 });
  s = setCard(s, { zone: 'player', player: 1, slot: 1 }, id('Ad'));
  assert.equal(nextEmptySlot(s, { zone: 'player', player: 1, slot: 1 }), null);
});

test('add/remove player respects the 2-6 bounds', () => {
  let s = initialEquityState();
  assert.equal(removePlayer(s, 0), s, 'cannot go below 2');
  for (let i = 0; i < 10; i++) s = addPlayer(s);
  assert.equal(s.players.length, 6);
  s = setCard(s, { zone: 'player', player: 3, slot: 0 }, id('Qs'));
  s = removePlayer(s, 3);
  assert.equal(s.players.length, 5);
  assert.equal(usedCards(s).has(id('Qs')), false, 'removed player frees their cards');
});

test('setGame resizes hands and keeps the cards that fit', () => {
  let s = setCard(initialEquityState(), { zone: 'player', player: 0, slot: 0 }, id('As'));
  s = setCard(s, { zone: 'player', player: 0, slot: 1 }, id('Ah'));
  s = setGame(s, 'plo5');
  assert.deepEqual(s.players[0], [id('As'), id('Ah'), null, null, null]);
  s = setCard(s, { zone: 'player', player: 0, slot: 4 }, id('Kd'));
  s = setGame(s, 'nlh');
  assert.deepEqual(s.players[0], [id('As'), id('Ah')], 'first cards win when shrinking');
  assert.equal(setGame(s, 'stud'), s, 'unknown game ignored');
});

test('clearCards empties every slot but keeps game and player count', () => {
  let s = addPlayer(setGame(initialEquityState(), 'plo4'));
  s = setCard(s, { zone: 'board', slot: 0 }, id('Th'));
  s = clearCards(s);
  assert.equal(s.game, 'plo4');
  assert.equal(s.players.length, 3);
  assert.equal(usedCards(s).size, 0);
  assert.equal(boardCount(s), 0);
});

test('normaliseEquityState rejects malformed or duplicated saved state', () => {
  const fresh = initialEquityState();
  assert.deepEqual(normaliseEquityState(null), fresh);
  assert.deepEqual(normaliseEquityState({ game: 'nlh', players: [[0, 0], [null, null]], board: [null, null, null, null, null] }), fresh);
  assert.deepEqual(normaliseEquityState({ game: 'nlh', players: [[0, 99], [null, null]], board: [null, null, null, null, null] }), fresh);
  assert.deepEqual(normaliseEquityState({ game: 'plo4', players: [[0, 1], [null, null]], board: [null, null, null, null, null] }), initialEquityState('plo4'));
  const ok = { game: 'nlh', players: [[0, 1], [null, 2]], board: [3, null, null, null, null] };
  assert.deepEqual(normaliseEquityState(ok), ok);
});

test('equityInput feeds the engine directly (empty slots become random cards)', () => {
  let s = setCard(initialEquityState(), { zone: 'player', player: 0, slot: 0 }, id('As'));
  s = setCard(s, { zone: 'player', player: 0, slot: 1 }, id('Ah'));
  assert.equal(isCalculable(s), true);
  const r = calculateEquity({ ...equityInput(s), trials: 20000 });
  assert.equal(r.error, undefined);
  assert.equal(r.method, 'monte-carlo');
  assert.ok(r.players[0].equity > 80 && r.players[0].equity < 90, `AA vs random ${r.players[0].equity}`);
});

test('describeCard and cardAt give readable labels', () => {
  assert.deepEqual(describeCard(id('Th')), { rank: '10', suit: 'h', symbol: '\u2665', name: 'Ten of hearts' });
  assert.equal(describeCard(id('As')).name, 'Ace of spades');
  const s = setCard(initialEquityState(), { zone: 'board', slot: 4 }, id('2c'));
  assert.equal(cardAt(s, { zone: 'board', slot: 4 }), id('2c'));
});

test('monteCarloMargin: 100k trials is about ±0.31 points at 95%', () => {
  assert.equal(monteCarloMargin(0), null);
  assert.ok(Math.abs(monteCarloMargin(100000) - 0.3099) < 0.001);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
