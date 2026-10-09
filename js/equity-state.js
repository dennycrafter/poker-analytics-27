// Pure state helpers for the equity calculator screen: no DOM, no storage.
// State shape: { game, players: [[cardId|null, ...], ...], board: [5 x cardId|null] }.
// Every function returns a new state; inputs are never mutated.

import { GAMES, MIN_PLAYERS, MAX_PLAYERS, RANK_CHARS, SUIT_CHARS } from './equity.js';

export const BOARD_SLOTS = 5;

const SUIT_SYMBOLS = ['\u2660', '\u2665', '\u2666', '\u2663'];
const SUIT_NAMES = ['spades', 'hearts', 'diamonds', 'clubs'];
const RANK_NAMES = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];

function emptyHand(game) { return Array(GAMES[game].holeCards).fill(null); }

export function initialEquityState(game = 'nlh') {
  return { game, players: [emptyHand(game), emptyHand(game)], board: Array(BOARD_SLOTS).fill(null) };
}

const isCard = v => Number.isInteger(v) && v >= 0 && v <= 51;

// Validates state loaded from storage; anything malformed falls back to a
// fresh state rather than feeding the engine a broken spec.
export function normaliseEquityState(raw) {
  if (!raw || typeof raw !== 'object' || !GAMES[raw.game]) return initialEquityState();
  const size = GAMES[raw.game].holeCards;
  const { players, board } = raw;
  if (!Array.isArray(players) || players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) return initialEquityState(raw.game);
  if (!Array.isArray(board) || board.length !== BOARD_SLOTS) return initialEquityState(raw.game);
  const all = [...players.flat(), ...board];
  const okSlots = players.every(h => Array.isArray(h) && h.length === size) && all.every(v => v === null || isCard(v));
  const known = all.filter(v => v !== null);
  if (!okSlots || new Set(known).size !== known.length) return initialEquityState(raw.game);
  return { game: raw.game, players: players.map(h => [...h]), board: [...board] };
}

// Switching game keeps each player's first cards that still fit.
export function setGame(state, game) {
  if (!GAMES[game] || game === state.game) return state;
  const size = GAMES[game].holeCards;
  const players = state.players.map(h => {
    const kept = h.filter(c => c !== null).slice(0, size);
    return [...kept, ...Array(size - kept.length).fill(null)];
  });
  return { ...state, game, players };
}

export function addPlayer(state) {
  if (state.players.length >= MAX_PLAYERS) return state;
  return { ...state, players: [...state.players, emptyHand(state.game)] };
}

export function removePlayer(state, index) {
  if (state.players.length <= MIN_PLAYERS || index < 0 || index >= state.players.length) return state;
  return { ...state, players: state.players.filter((_, i) => i !== index) };
}

export function clearCards(state) {
  return { ...state, players: state.players.map(() => emptyHand(state.game)), board: Array(BOARD_SLOTS).fill(null) };
}

// target: { zone: 'board', slot } | { zone: 'player', player, slot }
export function cardAt(state, target) {
  return target.zone === 'board' ? state.board[target.slot] : state.players[target.player][target.slot];
}

// Puts `card` (or null) at target. A card already used elsewhere moves here,
// so the picker can never create a duplicate.
export function setCard(state, target, card) {
  const strip = c => (card !== null && c === card ? null : c);
  const players = state.players.map(h => h.map(strip));
  const board = state.board.map(strip);
  if (target.zone === 'board') board[target.slot] = card;
  else players[target.player][target.slot] = card;
  return { ...state, players, board };
}

export function usedCards(state) {
  return new Set([...state.players.flat(), ...state.board].filter(c => c !== null));
}

// Next empty slot after `target` in the same zone (wrapping), or null when full.
export function nextEmptySlot(state, target) {
  const slots = target.zone === 'board' ? state.board : state.players[target.player];
  for (let k = 1; k <= slots.length; k++) {
    const slot = (target.slot + k) % slots.length;
    if (slots[slot] === null) return { ...target, slot };
  }
  return null;
}

export function boardCount(state) { return state.board.filter(c => c !== null).length; }

// A spot is worth calculating once any player has a known card; otherwise
// every hand is random and the answer is trivially 1/n.
export function isCalculable(state) {
  return state.players.some(h => h.some(c => c !== null));
}

export function equityInput(state) {
  return { game: state.game, hands: state.players.map(h => [...h]), board: [...state.board] };
}

export function describeCard(c) {
  const rank = c >> 2, suit = c & 3;
  return {
    rank: RANK_CHARS[rank] === 'T' ? '10' : RANK_CHARS[rank],
    suit: SUIT_CHARS[suit],
    symbol: SUIT_SYMBOLS[suit],
    name: `${RANK_NAMES[rank]} of ${SUIT_NAMES[suit]}`,
  };
}

// 95% margin of error in percentage points for a Monte Carlo equity estimate
// (worst case p = 0.5), so the UI can say how precise the number is.
export function monteCarloMargin(samples) {
  if (!samples) return null;
  return 1.96 * Math.sqrt(0.25 / samples) * 100;
}
