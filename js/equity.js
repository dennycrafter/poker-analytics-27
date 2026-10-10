// Equity calculator (Tier 9): pure, dependency-free, DOM-free.
//
// Games: NL Hold'em ('nlh', 2 hole cards, best 5 of 7) and Pot-Limit Omaha
// ('plo4' / 'plo5', exactly 2 hole cards + exactly 3 board cards).
// 2-6 players, board of 0-5 known cards, optional dead cards. Players may
// leave hole cards blank; blanks are dealt at random (Monte Carlo only).
//
// Method: exact enumeration of every remaining runout when every hole card
// is known and the runout count is at most `exactLimit` (flop, turn and river
// spots by default); otherwise Monte Carlo with a seeded RNG, so the same
// input and seed always give the same answer.
//
// Hand state is four 13-bit per-suit rank masks. Cards are unique, so the
// masks of disjoint card sets combine with a plain OR — which lets the board
// be folded once per runout and each player's hole cards be added cheaply.
//
// Measured rate (node 20, repo sandbox, 100k trials; see tests/equity.test.mjs):
// NLH heads-up ~5.7M trials/s (17 ms), NLH 6-way ~3.4M/s (30 ms),
// PLO4 heads-up ~415k/s (241 ms), PLO5 heads-up ~282k/s (355 ms),
// PLO5 6-way ~96k/s (~1.04 s), the worst case, still inside the 2 s budget.

export const GAMES = {
  nlh: { id: 'nlh', label: "NL Hold'em", short: 'NLH', holeCards: 2 },
  plo4: { id: 'plo4', label: 'PLO', short: 'PLO4', holeCards: 4 },
  plo5: { id: 'plo5', label: 'PLO5', short: 'PLO5', holeCards: 5 },
};

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
export const DEFAULT_TRIALS = 100000;
export const DEFAULT_SEED = 27;
// C(45,2) = 990 flop runouts heads-up; multiway flops are smaller still.
export const DEFAULT_EXACT_LIMIT = 1000;

export const CATEGORY_NAMES = [
  'High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight',
  'Flush', 'Full house', 'Four of a kind', 'Straight flush',
];

// ---------------------------------------------------------------- cards ----

const RANKS = '23456789TJQKA';
const SUITS = 'shdc';

// Card id 0..51: rank * 4 + suit (rank 0 = deuce .. 12 = ace).
export function cardId(rank, suit) { return rank * 4 + suit; }
export function cardRank(c) { return c >> 2; }
export function cardSuit(c) { return c & 3; }
export function formatCard(c) { return RANKS[c >> 2] + SUITS[c & 3]; }
export function formatCards(cards) { return cards.map(formatCard).join(''); }
export const RANK_CHARS = RANKS;
export const SUIT_CHARS = SUITS;

// Parses "AsKd", "As Kd", "10h", "ah,kd" into card ids.
// Returns { cards } or { error } — never throws on user input.
export function parseCards(text) {
  const src = String(text ?? '').replace(/10/g, 'T').replace(/[\s,]+/g, '');
  if (src.length % 2 !== 0) return { error: `Cannot read "${text}" as cards` };
  const cards = [];
  for (let i = 0; i < src.length; i += 2) {
    const r = RANKS.indexOf(src[i].toUpperCase());
    const s = SUITS.indexOf(src[i + 1].toLowerCase());
    if (r < 0 || s < 0) return { error: `"${src.slice(i, i + 2)}" is not a card` };
    cards.push(cardId(r, s));
  }
  return { cards };
}

function toCards(value, label) {
  if (value == null || value === '') return { cards: [] };
  if (Array.isArray(value)) {
    const out = [];
    for (const v of value) {
      if (v == null) continue; // empty picker slot
      if (typeof v === 'number') {
        if (!Number.isInteger(v) || v < 0 || v > 51) return { error: `${label}: invalid card ${v}` };
        out.push(v);
      } else {
        const p = parseCards(v);
        if (p.error) return { error: `${label}: ${p.error}` };
        out.push(...p.cards);
      }
    }
    return { cards: out };
  }
  const p = parseCards(value);
  return p.error ? { error: `${label}: ${p.error}` } : p;
}

// ----------------------------------------------------------- evaluator ----

const POP = new Uint8Array(8192);
const HI = new Int8Array(8192);
const TOP5 = new Int32Array(8192);    // top five ranks as nibbles r1..r5
const STRAIGHT = new Int8Array(8192); // high rank of best straight, -1 none

(function buildTables() {
  for (let m = 0; m < 8192; m++) {
    let pop = 0, hi = -1, top = 0, taken = 0;
    for (let r = 12; r >= 0; r--) {
      if (m & (1 << r)) {
        pop++;
        if (hi < 0) hi = r;
        if (taken < 5) { top |= r << (16 - 4 * taken); taken++; }
      }
    }
    POP[m] = pop; HI[m] = hi; TOP5[m] = top;
    let s = -1;
    for (let h = 12; h >= 4; h--) {
      const run = 0x1f << (h - 4);
      if ((m & run) === run) { s = h; break; }
    }
    if (s < 0 && (m & 0x100f) === 0x100f) s = 3; // A-2-3-4-5 wheel
    STRAIGHT[m] = s;
  }
})();

const CAT = 1 << 20;

// Strength of the best 5-card hand inside the given suit masks; higher wins.
// Encoding: category * 2^20 + up to five 4-bit rank nibbles. Valid for 5..7
// cards (a flush can never coexist with quads or a full house at <= 7 cards).
export function evalMasks(m0, m1, m2, m3) {
  let fm = 0;
  if (POP[m0] >= 5) fm = m0;
  else if (POP[m1] >= 5) fm = m1;
  else if (POP[m2] >= 5) fm = m2;
  else if (POP[m3] >= 5) fm = m3;
  if (fm) {
    const sf = STRAIGHT[fm];
    return sf >= 0 ? 8 * CAT + sf : 5 * CAT + TOP5[fm];
  }
  const all = m0 | m1 | m2 | m3;
  const quads = m0 & m1 & m2 & m3;
  if (quads) {
    const q = HI[quads];
    return 7 * CAT + (q << 16) + (HI[all & ~(1 << q)] << 12);
  }
  const ge3 = (m0 & m1 & m2) | (m0 & m1 & m3) | (m0 & m2 & m3) | (m1 & m2 & m3);
  const ge2 = (m0 & m1) | (m0 & m2) | (m0 & m3) | (m1 & m2) | (m1 & m3) | (m2 & m3);
  if (ge3) {
    const t = HI[ge3];
    const rest = ge2 & ~(1 << t);
    if (rest) return 6 * CAT + (t << 16) + (HI[rest] << 12);
  }
  const st = STRAIGHT[all];
  if (st >= 0) return 4 * CAT + st;
  if (ge3) {
    const t = HI[ge3];
    return 3 * CAT + (t << 16) + (TOP5[all & ~(1 << t)] >> 4 & 0xff00);
  }
  if (ge2) {
    const p1 = HI[ge2];
    const restPairs = ge2 & ~(1 << p1);
    if (restPairs) {
      const p2 = HI[restPairs];
      return 2 * CAT + (p1 << 16) + (p2 << 12) + (HI[all & ~(1 << p1) & ~(1 << p2)] << 8);
    }
    return CAT + (p1 << 16) + (TOP5[all & ~(1 << p1)] >> 4 & 0xfff0);
  }
  return TOP5[all];
}

function masksOf(cards) {
  const m = [0, 0, 0, 0];
  for (const c of cards) m[c & 3] |= 1 << (c >> 2);
  return m;
}

// Best hand value for a set of 5-7 cards (NLH style: any 5).
export function evaluateCards(cards) {
  const m = masksOf(cards);
  return evalMasks(m[0], m[1], m[2], m[3]);
}

// Best Omaha value: exactly two hole cards plus exactly three board cards.
export function evaluateOmaha(hole, board) {
  let best = -1;
  for (let a = 0; a < hole.length; a++) for (let b = a + 1; b < hole.length; b++) {
    for (let i = 0; i < board.length; i++) for (let j = i + 1; j < board.length; j++) {
      for (let k = j + 1; k < board.length; k++) {
        const v = evaluateCards([hole[a], hole[b], board[i], board[j], board[k]]);
        if (v > best) best = v;
      }
    }
  }
  return best;
}

export function handCategory(value) { return Math.floor(value / CAT); }
export function categoryName(value) { return CATEGORY_NAMES[handCategory(value)]; }

// ------------------------------------------------------------------ RNG ----

// mulberry32: tiny, fast, good enough for card dealing; seeded and portable.
export function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --------------------------------------------------------- validation ----

function choose(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

// Normalises and validates input. Returns { spec } or { error }.
export function prepareEquity(input = {}) {
  const game = GAMES[input.game || 'nlh'];
  if (!game) return { error: `Unknown game "${input.game}"` };
  const rawHands = input.hands || [];
  if (rawHands.length < MIN_PLAYERS || rawHands.length > MAX_PLAYERS) {
    return { error: `Choose ${MIN_PLAYERS}-${MAX_PLAYERS} players` };
  }
  const hands = [];
  for (let i = 0; i < rawHands.length; i++) {
    const h = toCards(rawHands[i], `Player ${i + 1}`);
    if (h.error) return { error: h.error };
    if (h.cards.length > game.holeCards) {
      return { error: `Player ${i + 1}: ${game.short} hands have ${game.holeCards} cards` };
    }
    hands.push(h.cards);
  }
  const b = toCards(input.board, 'Board');
  if (b.error) return { error: b.error };
  if (b.cards.length > 5) return { error: 'The board has at most 5 cards' };
  const d = toCards(input.dead, 'Dead cards');
  if (d.error) return { error: d.error };

  const seen = new Set();
  for (const c of [...hands.flat(), ...b.cards, ...d.cards]) {
    if (seen.has(c)) return { error: `${formatCard(c)} is used twice` };
    seen.add(c);
  }
  const unknownHole = hands.reduce((n, h) => n + (game.holeCards - h.length), 0);
  const boardMissing = 5 - b.cards.length;
  const deck = [];
  for (let c = 0; c < 52; c++) if (!seen.has(c)) deck.push(c);
  if (deck.length < unknownHole + boardMissing) return { error: 'Not enough cards left in the deck' };

  const trials = input.trials ?? DEFAULT_TRIALS;
  if (!Number.isInteger(trials) || trials < 1) return { error: 'Trials must be a positive integer' };
  const exactLimit = input.exactLimit ?? DEFAULT_EXACT_LIMIT;
  const runouts = choose(deck.length, boardMissing);
  const exact = unknownHole === 0 && runouts <= exactLimit;
  return {
    spec: {
      game, hands, board: b.cards, dead: d.cards, deck, boardMissing, unknownHole,
      trials, seed: (input.seed ?? DEFAULT_SEED) >>> 0, exact, runouts,
    },
  };
}

// ------------------------------------------------------------ scoring ----

const BOARD_TRIPLES = [];
for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) for (let k = j + 1; k < 5; k++) BOARD_TRIPLES.push([i, j, k]);

// Builds a scorer for one game: score(board5, holes, out) writes each
// player's hand value into `out`.
function makeScorer(game, nPlayers) {
  if (game.id === 'nlh') {
    return function scoreNlh(board, holes, out) {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0;
      for (let i = 0; i < 5; i++) {
        const c = board[i], bit = 1 << (c >> 2);
        switch (c & 3) { case 0: b0 |= bit; break; case 1: b1 |= bit; break; case 2: b2 |= bit; break; default: b3 |= bit; }
      }
      for (let p = 0; p < nPlayers; p++) {
        const h = holes[p];
        let m0 = b0, m1 = b1, m2 = b2, m3 = b3;
        for (let i = 0; i < 2; i++) {
          const c = h[i], bit = 1 << (c >> 2);
          switch (c & 3) { case 0: m0 |= bit; break; case 1: m1 |= bit; break; case 2: m2 |= bit; break; default: m3 |= bit; }
        }
        out[p] = evalMasks(m0, m1, m2, m3);
      }
    };
  }
  // Omaha: fold the 10 board triples and each player's hole pairs into masks
  // once, then evaluate every pair x triple combination by OR-ing them.
  const tri = new Int32Array(40);
  const pairs = new Int32Array(10 * 4);
  return function scoreOmaha(board, holes, out) {
    for (let t = 0; t < 10; t++) {
      const idx = BOARD_TRIPLES[t];
      let m0 = 0, m1 = 0, m2 = 0, m3 = 0;
      for (let i = 0; i < 3; i++) {
        const c = board[idx[i]], bit = 1 << (c >> 2);
        switch (c & 3) { case 0: m0 |= bit; break; case 1: m1 |= bit; break; case 2: m2 |= bit; break; default: m3 |= bit; }
      }
      tri[t * 4] = m0; tri[t * 4 + 1] = m1; tri[t * 4 + 2] = m2; tri[t * 4 + 3] = m3;
    }
    for (let p = 0; p < nPlayers; p++) {
      const h = holes[p];
      let np = 0;
      for (let a = 0; a < h.length; a++) for (let b = a + 1; b < h.length; b++) {
        const o = np * 4;
        pairs[o] = 0; pairs[o + 1] = 0; pairs[o + 2] = 0; pairs[o + 3] = 0;
        pairs[o + (h[a] & 3)] |= 1 << (h[a] >> 2);
        pairs[o + (h[b] & 3)] |= 1 << (h[b] >> 2);
        np++;
      }
      let best = -1;
      for (let q = 0; q < np; q++) {
        const o = q * 4;
        const p0 = pairs[o], p1 = pairs[o + 1], p2 = pairs[o + 2], p3 = pairs[o + 3];
        for (let t = 0; t < 40; t += 4) {
          const v = evalMasks(p0 | tri[t], p1 | tri[t + 1], p2 | tri[t + 2], p3 | tri[t + 3]);
          if (v > best) best = v;
        }
      }
      out[p] = best;
    }
  };
}

function makeTally(n) {
  return { wins: new Float64Array(n), ties: new Float64Array(n), share: new Float64Array(n), total: 0 };
}

// Records one runout: a sole best hand wins; k-way best hands each tie and
// take 1/k of the pot for equity.
function record(tally, values, n) {
  let best = -1, count = 0;
  for (let p = 0; p < n; p++) {
    if (values[p] > best) { best = values[p]; count = 1; } else if (values[p] === best) count++;
  }
  if (count === 1) {
    for (let p = 0; p < n; p++) if (values[p] === best) { tally.wins[p]++; tally.share[p]++; }
  } else {
    const s = 1 / count;
    for (let p = 0; p < n; p++) if (values[p] === best) { tally.ties[p]++; tally.share[p] += s; }
  }
  tally.total++;
}

function summarise(tally, n) {
  const players = [];
  for (let p = 0; p < n; p++) {
    const win = (tally.wins[p] / tally.total) * 100;
    const tie = (tally.ties[p] / tally.total) * 100;
    players.push({ win, tie, lose: 100 - win - tie, equity: (tally.share[p] / tally.total) * 100 });
  }
  return players;
}

function runExact(spec) {
  const n = spec.hands.length;
  const score = makeScorer(spec.game, n);
  const tally = makeTally(n);
  const values = new Int32Array(n);
  const board = new Int32Array(5);
  for (let i = 0; i < spec.board.length; i++) board[i] = spec.board[i];
  const known = spec.board.length;
  const deck = spec.deck;
  const k = spec.boardMissing;
  // Iterative k-combination walk over the remaining deck.
  const idx = Array.from({ length: k }, (_, i) => i);
  const nDeck = deck.length;
  for (;;) {
    for (let i = 0; i < k; i++) board[known + i] = deck[idx[i]];
    score(board, spec.hands, values);
    record(tally, values, n);
    let i = k - 1;
    while (i >= 0 && idx[i] === nDeck - k + i) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
  return tally;
}

function runMonteCarlo(spec) {
  const n = spec.hands.length;
  const holeSize = spec.game.holeCards;
  const score = makeScorer(spec.game, n);
  const tally = makeTally(n);
  const values = new Int32Array(n);
  const rng = makeRng(spec.seed);
  const deck = Int32Array.from(spec.deck);
  const nDeck = deck.length;
  const board = new Int32Array(5);
  for (let i = 0; i < spec.board.length; i++) board[i] = spec.board[i];
  const known = spec.board.length;
  const holes = spec.hands.map(h => {
    const a = new Int32Array(holeSize);
    for (let i = 0; i < h.length; i++) a[i] = h[i];
    return a;
  });
  const missing = spec.hands.map(h => holeSize - h.length);
  const need = spec.unknownHole + spec.boardMissing;
  for (let t = 0; t < spec.trials; t++) {
    // Partial Fisher-Yates: the first `need` slots become a uniform draw.
    for (let i = 0; i < need; i++) {
      const j = i + ((rng() * (nDeck - i)) | 0);
      const tmp = deck[i]; deck[i] = deck[j]; deck[j] = tmp;
    }
    let d = 0;
    for (let p = 0; p < n; p++) {
      const start = holeSize - missing[p];
      for (let i = start; i < holeSize; i++) holes[p][i] = deck[d++];
    }
    for (let i = known; i < 5; i++) board[i] = deck[d++];
    score(board, holes, values);
    record(tally, values, n);
  }
  return tally;
}

// Main entry point. Input:
//   { game: 'nlh'|'plo4'|'plo5', hands: [..per player..], board, dead,
//     trials, seed, exactLimit }
// where each hand / board / dead is a card string ("AsKd") or an array of
// card ids / strings / nulls (empty picker slots).
// Returns { players: [{ win, tie, lose, equity }] (percent), method, samples,
//   seed } or { error }.
export function calculateEquity(input) {
  const { spec, error } = prepareEquity(input);
  if (error) return { error };
  const tally = spec.exact ? runExact(spec) : runMonteCarlo(spec);
  return {
    players: summarise(tally, spec.hands.length),
    method: spec.exact ? 'exact' : 'monte-carlo',
    samples: tally.total,
    seed: spec.exact ? null : spec.seed,
  };
}

export function streetName(boardCount) {
  if (boardCount === 0) return 'Preflop';
  if (boardCount < 3) return 'Partial flop';
  if (boardCount === 3) return 'Flop';
  if (boardCount === 4) return 'Turn';
  return 'River';
}
