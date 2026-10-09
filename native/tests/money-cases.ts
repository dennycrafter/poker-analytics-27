// Shared input grid + output recipe for the MONEY parity suite (bankroll,
// risk of ruin, staking ledger, Top 10).
//
// scripts/gen-money-golden.ts runs `computeMoney` with the WEB modules
// (js/bankroll.js, js/staking.js, js/rankings.js, js/stats.js, js/manage.js)
// and writes inputs + outputs to tests/fixtures/money-golden.json.
// tests/native-parity-money.test.ts runs the same recipe with the NATIVE
// modules on the stored inputs and requires identical output.
//
// Inputs are stored in the fixture (not rebuilt) because the web demo seed is
// built in local time; the stored docs make the suite timezone-independent.

import type { Doc, SellAction, Session, Transaction } from '../src/lib/types';
import { blankDoc } from '../src/lib/types';

export const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);

/** The surface both implementations expose to the recipe. Web rorBand classes are mapped to 'ror-*' strings. */
export interface MoneyApi {
  endedSessions(doc: Doc): Session[];
  cashOnly(sessions: Session[]): Session[];
  riskOfRuin(doc: Doc, cash: Session[], bankroll: number): number | null;
  txnSigned(t: Pick<Transaction, 'kind' | 'amount'>): number;
  signedAmount(kind: string, amount: number | string, direction?: string): number;
  transactionError(o: { kind: string; amountRaw: unknown; occurredAt: string | null; nowMs: number }): string | null;
  bankrollSummary(doc: Doc, id: string | null): unknown;
  bankrollSeries(doc: Doc, id: string | null): { t: number; y: number }[];
  bankrollUsage(doc: Doc, id: string): { sessions: number; transactions: number };
  bankrollNameError(doc: Doc, name: string, exceptId: string | null): string | null;
  bankrollDeleteError(doc: Doc, id: string): string | null;
  rorBandClass(ror: number | null | undefined): string;
  soldPercent(actions: { percentage: unknown }[]): number;
  sellActionError(existing: { percentage: unknown }[], pct: unknown, markup: unknown): string | null;
  makeSellAction(id: string, sessionId: string, input: { percentage: unknown; markup?: unknown; backer_name?: unknown }): unknown;
  sellSummary(actions: { percentage: unknown }[]): string;
  sellActionsOf(doc: Doc, sessionId: string): SellAction[];
  sellLedger(doc: Doc, s: Session): unknown;
  topSessions(doc: Doc, which: string, n: number, mode: string): { s: Session; net: number }[];
}

// --- fixture builders ------------------------------------------------------------

const H = 3600e3;
const iso = (ms: number) => new Date(ms).toISOString();

function session(p: Partial<Session> & Pick<Session, 'id' | 'kind'>): Session {
  const start = p.start_time ?? iso(NOW - 30 * 24 * H);
  return {
    game_id: 'g-nlh', location_id: null, bankroll_id: 'bk-a', group_id: null, table_size: 9,
    start_time: start, end_time: null, duration_seconds: null, break_seconds: 0,
    is_live: false, paused_at: null, hands_count: null, hands_count_estimated: false,
    comment: null, opponents: null, tracked_via_stack: false,
    small_blind: null, big_blind: null, buy_in: null, cashed_out: null, tips: 0,
    tournament_type_id: null, tournament_name: null, initial_buy_in: null, total_buy_in: null,
    prize: null, position: null, entries: null, created_at: start, updated_at: start,
    ...p,
  };
}

/** Ended cash session `daysAgo` days back, `hours` long, with a net of cashed_out - buy_in. */
function cash(id: string, daysAgo: number, hours: number, buyIn: number, cashedOut: number, extra: Partial<Session> = {}): Session {
  const start = NOW - daysAgo * 24 * H;
  return session({
    id, kind: 'cash', small_blind: 0.25, big_blind: 0.5, buy_in: buyIn, cashed_out: cashedOut,
    start_time: iso(start), end_time: iso(start + hours * H), duration_seconds: Math.round(hours * 3600), ...extra,
  });
}

function tourney(id: string, daysAgo: number, total: number | null, prize: number | null, extra: Partial<Session> = {}): Session {
  const start = NOW - daysAgo * 24 * H;
  return session({
    id, kind: 'tournament', initial_buy_in: total, total_buy_in: total, prize,
    start_time: iso(start), end_time: iso(start + 4 * H), duration_seconds: 4 * 3600, ...extra,
  });
}

/** Legacy/imported rows can carry strings or nulls where the type says number. */
const loose = <T>(v: unknown): T => v as T;

function sell(id: string, sessionId: string, percentage: unknown, markup: unknown, backer: string | null = null): SellAction {
  return { id, session_id: sessionId, percentage: loose<number>(percentage), markup: loose<number>(markup), backer_name: backer };
}

function txn(id: string, bankroll: string | null, kind: Transaction['kind'], amount: unknown, daysAgo: number | string): Transaction {
  const at = typeof daysAgo === 'string' ? daysAgo : iso(NOW - daysAgo * 24 * H);
  return { id, bankroll_id: bankroll, kind, amount: loose<number | null>(amount), description: null, occurred_at: at, created_at: at };
}

/** Partial sells, mixed and legacy markups, 100% sold, busted, live, two bankrolls, odd transaction signs. */
function stakingDoc(): Doc {
  const d = blankDoc();
  d.bankrolls = [{ id: 'bk-a', name: 'Live', is_default: true }, { id: 'bk-b', name: 'Online' }];
  d.sessions = [
    tourney('t1-busted-30pct', 40, 100, 0),
    tourney('t2-mixed', 35, 50, 400),
    tourney('t3-full', 30, 30, 90),
    tourney('t4-legacy-strings', 25, 20, 55.5, { initial_buy_in: 10 }),
    tourney('t5-no-sells', 20, 25, null, { bankroll_id: 'bk-b' }),
    tourney('t6-live', 0, 40, null, { is_live: true, end_time: null, duration_seconds: null }),
    tourney('t7-null-buyin', 15, null, 10),
    cash('c1', 45, 5, 100, 162.5),
    cash('c2', 38, 3.5, 50, 12, { break_seconds: 1800 }),
    cash('c3', 33, 6, 100, 310.25, { tips: 4.5 }),
    cash('c4-zero-dur', 28, 0, 50, 80),
    cash('c5-stack', 22, 4, 0, 0, { tracked_via_stack: true }),
    cash('c6-bk-b', 18, 2, 20, 7, { bankroll_id: 'bk-b', small_blind: 0.1, big_blind: 0.2 }),
    cash('c7', 10, 7, 200, 141),
  ];
  d.stack_events = [
    { id: 'e1', session_id: 'c5-stack', kind: 'buy_in', amount: 60, occurred_at: iso(NOW - 22 * 24 * H) },
    { id: 'e2', session_id: 'c5-stack', kind: 'top_up', amount: 40, occurred_at: iso(NOW - 22 * 24 * H + H) },
    { id: 'e3', session_id: 'c5-stack', kind: 'cash_out', amount: 187.3, occurred_at: iso(NOW - 22 * 24 * H + 4 * H) },
  ];
  d.sell_actions = [
    sell('s1', 't1-busted-30pct', 30, 1.1, 'Bob'),
    sell('s2a', 't2-mixed', 20, 1),
    sell('s2b', 't2-mixed', 15, 1.25, 'Ann'),
    sell('s2c', 't2-mixed', 10, null),
    sell('s3a', 't3-full', 33.3, ''),
    sell('s3b', 't3-full', 33.3, 1.05),
    sell('s3c', 't3-full', 33.4, 1.05, 'Cy'),
    sell('s4', 't4-legacy-strings', '25', '1.2', 'Dee'),
    sell('s6', 't6-live', 50, 1.1),
    sell('s7', 't7-null-buyin', 50, 1),
  ];
  d.transactions = [
    txn('x1', 'bk-a', 'deposit', 500, 60),
    txn('x2', 'bk-a', 'deposit', -50, 50),
    txn('x3', 'bk-a', 'withdrawal', 120, 29),
    txn('x4', 'bk-b', 'withdrawal', -80, 12),
    txn('x5', 'bk-a', 'other', -15.5, 8),
    txn('x6', 'bk-b', 'other', 40, 5),
    txn('x7', 'bk-a', 'other', null, 4),
    txn('x8', 'bk-a', 'deposit', 'abc', 3),
    txn('x9', 'bk-a', 'deposit', 25, 'not-a-date'),
    txn('x10', 'bk-gone', 'deposit', 999, 2),
    // Same instant as c7's end: series order must follow insertion (stable sort).
    txn('x11', 'bk-a', 'other', -7, iso(NOW - 10 * 24 * H + 7 * H)),
  ];
  return d;
}

/** Equal nets everywhere: ties resolve by later start_time, then id. */
function tieDoc(): Doc {
  const d = blankDoc();
  d.bankrolls = [{ id: 'bk-a', name: 'Live', is_default: true }];
  const sameStart = NOW - 5 * 24 * H;
  d.sessions = [
    cash('tie-b', 5, 3, 100, 150, { start_time: iso(sameStart), end_time: iso(sameStart + 3 * H) }),
    cash('tie-a', 5, 3, 100, 150, { start_time: iso(sameStart), end_time: iso(sameStart + 3 * H) }),
    cash('tie-c', 5, 3, 100, 150, { start_time: iso(sameStart), end_time: iso(sameStart + 3 * H) }),
    cash('tie-older', 9, 3, 100, 150),
    cash('tie-newer', 2, 3, 100, 150),
    cash('lose-a', 7, 2, 100, 50),
    cash('lose-b', 6, 2, 100, 50),
    cash('zero', 4, 2, 100, 100),
    // Gross 80 vs retained 120*0.5 - 40*(1-0.5*1.2) = 44: above the 50s gross, below them net.
    tourney('staked', 3, 40, 120),
    tourney('busted', 8, 30, 0),
  ];
  d.sell_actions = [sell('ts', 'staked', 50, 1.2)];
  return d;
}

function losingDoc(): Doc {
  const d = blankDoc();
  d.bankrolls = [{ id: 'bk-a', name: 'Live', is_default: true }];
  d.sessions = [cash('l1', 9, 3, 100, 40), cash('l2', 6, 4, 100, 130), cash('l3', 3, 2, 50, 0)];
  d.transactions = [txn('lx', 'bk-a', 'deposit', 1000, 20)];
  return d;
}

/** Every session wins exactly 10/h: variance 0 -> RoR clamps to 1. */
function zeroVarianceDoc(): Doc {
  const d = blankDoc();
  d.bankrolls = [{ id: 'bk-a', name: 'Live', is_default: true }];
  d.sessions = [cash('z1', 9, 2, 100, 120), cash('z2', 6, 3, 100, 130), cash('z3', 3, 4, 100, 140)];
  return d;
}

function zeroDurationDoc(): Doc {
  const d = blankDoc();
  d.bankrolls = [{ id: 'bk-a', name: 'Live', is_default: true }];
  d.sessions = [cash('d0', 3, 0, 100, 180)];
  d.transactions = [txn('dx', 'bk-a', 'deposit', 200, 10)];
  return d;
}

function emptyDoc(): Doc {
  const d = blankDoc();
  d.bankrolls = [{ id: 'bk-a', name: 'Live', is_default: true }];
  return d;
}

export interface MoneyInputs { nowMs: number; docs: Record<string, Doc> }

/** `seed` is the web demo seed (built by the generator), stored verbatim in the fixture. */
export function buildInputs(seed: Doc): MoneyInputs {
  return {
    nowMs: NOW,
    docs: {
      seed, staking: stakingDoc(), ties: tieDoc(), losing: losingDoc(),
      zeroVariance: zeroVarianceDoc(), zeroDuration: zeroDurationDoc(), empty: emptyDoc(),
    },
  };
}

// --- recipe ------------------------------------------------------------------------

const ROR_BANKROLLS = [-100, 0, 1, 50, 100, 250, 300, 500, 1000, 2500, 5000, 1e6];
const ROR_VALUES = [null, undefined, 0, 1, 9, 9.99, 10, 10.5, 29, 30, 30.01, 31, 100];
const KINDS = ['deposit', 'withdrawal', 'other', 'bogus', ''];
const SELL_EXISTING = [[], [{ percentage: 30 }], [{ percentage: 99.5 }], [{ percentage: 100 }],
  [{ percentage: 33.3 }, { percentage: 33.3 }], [{ percentage: '25' }, { percentage: -5 }]];
const SELL_PCTS = ['', '0', '-5', 'abc', '10', '0.5', '70', '70.0000000001', '33.4', '100', '101', ' 25 ', 30, null];
const SELL_MARKUPS = ['', '1', '1.1', '0', '-1', '10', '10.5', 'x', null, ' 1.2 ', 1.25];

/**
 * -0 and NaN do not survive JSON: normalise them so both sides compare by
 * value (-0 and 0 render identically; NaN would display as "--").
 */
export function normalize<T>(v: T): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => {
    if (typeof x === 'number') {
      if (Object.is(x, -0)) return 0;
      if (Number.isNaN(x)) return 'NaN';
      if (!Number.isFinite(x)) return String(x);
    }
    return x === undefined ? null : x;
  }));
}

export function computeMoney(api: MoneyApi, inputs: MoneyInputs): unknown {
  const { docs, nowMs } = inputs;
  const out: Record<string, unknown> = {};

  // Bankroll: summaries (all, each bankroll, unknown id), series, usage, guards.
  out.bankroll = Object.fromEntries(Object.entries(docs).map(([key, doc]) => {
    const ids: (string | null)[] = [null, ...doc.bankrolls.map(b => b.id), 'bk-missing'];
    return [key, {
      summaries: ids.map(id => ({ id, summary: api.bankrollSummary(doc, id) })),
      series: ids.map(id => ({ id, series: api.bankrollSeries(doc, id) })),
      usage: doc.bankrolls.map(b => ({ id: b.id, usage: api.bankrollUsage(doc, b.id), deleteError: api.bankrollDeleteError(doc, b.id) })),
      nameErrors: ['', '   ', 'live', ' Live ', 'Online', 'New roll', 'x'.repeat(61), 'x'.repeat(60)].map(name => ({
        name, err: api.bankrollNameError(doc, name, null), errSelf: api.bankrollNameError(doc, name, doc.bankrolls[0]?.id ?? null),
      })),
    }];
  }));

  // Risk of ruin across the bankroll grid, for every doc's cash sessions.
  out.ror = Object.fromEntries(Object.entries(docs).map(([key, doc]) => {
    const c = api.cashOnly(api.endedSessions(doc));
    return [key, ROR_BANKROLLS.map(b => ({ bankroll: b, ror: api.riskOfRuin(doc, c, b) }))];
  }));
  out.rorBand = ROR_VALUES.map(v => ({ v, band: api.rorBandClass(v) }));

  // Transactions: signs, stored amounts, validation.
  const amounts: unknown[] = [100, -100, 0, null, 'abc', '25', -0.5, 12.345];
  out.txnSigned = KINDS.flatMap(kind => amounts.map(amount => ({
    kind, amount, v: api.txnSigned({ kind: kind as Transaction['kind'], amount: loose<number | null>(amount) }),
  })));
  out.signedAmount = KINDS.flatMap(kind => [100, -100, '12.5', 0].flatMap(amount => ['out', 'in', undefined].map(dir => ({
    kind, amount, dir, v: dir === undefined ? api.signedAmount(kind, amount) : api.signedAmount(kind, amount, dir),
  }))));
  const whens = [iso(nowMs - 24 * H), iso(nowMs), iso(nowMs + 1), iso(nowMs + 24 * H), 'not-a-date', null];
  out.transactionError = KINDS.flatMap(kind => ['', '0', '-5', '12.5', 'abc', ' 7 ', 100].flatMap(amountRaw => whens.map(occurredAt => ({
    kind, amountRaw, occurredAt, err: api.transactionError({ kind, amountRaw, occurredAt, nowMs }),
  }))));

  // Staking: validation grid, normalisation, summaries, ledgers for every tournament.
  out.sellActionError = SELL_EXISTING.flatMap((existing, ei) => SELL_PCTS.flatMap(pct => SELL_MARKUPS.map(mk => ({
    existing: ei, pct, mk, err: api.sellActionError(existing, pct, mk),
  }))));
  out.soldPercent = SELL_EXISTING.map(e => api.soldPercent(e));
  out.sellSummary = SELL_EXISTING.map(e => api.sellSummary(e));
  out.makeSellAction = [
    { percentage: '30', markup: '1.1', backer_name: '  Bob ' },
    { percentage: 12.5, markup: '', backer_name: '' },
    { percentage: '5', markup: null, backer_name: null },
    { percentage: '40', markup: ' 1.2 ' },
    { percentage: 100, markup: 1 },
  ].map(input => api.makeSellAction('sell-x', 'sess-x', input));
  out.ledgers = Object.fromEntries(Object.entries(docs).map(([key, doc]) => [key,
    doc.sessions.filter(s => s.kind === 'tournament').map(s => ({
      id: s.id, sold: api.soldPercent(api.sellActionsOf(doc, s.id)), summary: api.sellSummary(api.sellActionsOf(doc, s.id)),
      ledger: api.sellLedger(doc, s),
    }))]));

  // Top 10: both directions, both staking modes, several n.
  out.top = Object.fromEntries(Object.entries(docs).map(([key, doc]) => [key,
    ['best', 'worst'].flatMap(which => ['net', 'gross'].flatMap(mode => [3, 10, 50].map(n => ({
      which, mode, n, list: api.topSessions(doc, which, n, mode).map(x => ({ id: x.s.id, net: x.net })),
    }))))]));

  return normalize(out);
}
