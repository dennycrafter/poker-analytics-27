// MONEY parity: bankroll + risk of ruin, staking ledger, Top 10.
//
// 1. Golden parity: tests/fixtures/money-golden.json was produced by RUNNING
//    the web modules (scripts/gen-money-golden.ts). The native ports replay the
//    stored inputs through the same recipe and must produce identical output.
//    A second check re-runs the web modules live, so a stale fixture fails too.
// 2. Worked examples: hand-computed numbers from the brief, so a bug shared
//    by both implementations still fails.
// 3. Mutators: the native add/delete helpers behave like web js/domain.js.
//
// Run: npm test   (node:test via tsx; npm run test:tz for three timezones)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as WB from '../../js/bankroll.js';
import { fmtNum as webFmtNum } from '../../js/format.js';
import * as WMG from '../../js/manage.js';
import * as WR from '../../js/rankings.js';
import * as WS from '../../js/stats.js';
import * as WK from '../../js/staking.js';

import * as B from '../src/lib/bankroll';
import * as R from '../src/lib/rankings';
import * as S from '../src/lib/stats';
import * as K from '../src/lib/staking';
import { blankDoc, type Doc, type Session, type TransactionKind } from '../src/lib/types';
import { computeMoney, NOW, type MoneyApi, type MoneyInputs } from './money-cases';

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(here, 'fixtures', 'money-golden.json'), 'utf8')) as {
  inputs: MoneyInputs; expected: Record<string, unknown>;
};

// The recipe passes loosely typed grid values (legacy strings/nulls) on purpose.
type Loose = never;

const nativeApi: MoneyApi = {
  endedSessions: S.endedSessions,
  cashOnly: S.cashOnly,
  riskOfRuin: S.riskOfRuin,
  txnSigned: B.txnSigned,
  signedAmount: (kind, amount, dir) => B.signedAmount(kind as TransactionKind, amount, dir as B.TxnDirection | undefined),
  transactionError: o => B.transactionError(o as Loose),
  bankrollSummary: B.bankrollSummary,
  bankrollSeries: B.bankrollSeries,
  bankrollUsage: B.bankrollUsage,
  bankrollNameError: B.bankrollNameError,
  bankrollDeleteError: B.bankrollDeleteError,
  rorBandClass: v => { const b = B.rorBand(v); return b ? `ror-${b}` : ''; },
  soldPercent: a => K.soldPercent(a as Loose),
  sellActionError: (e, p, m) => K.sellActionError(e as Loose, p as Loose, m as Loose),
  makeSellAction: (id, sid, input) => K.makeSellAction(id, sid, input as Loose),
  sellSummary: a => K.sellSummary(a as Loose),
  sellActionsOf: K.sellActionsOf,
  sellLedger: K.sellLedger,
  topSessions: (doc, which, n, mode) => R.topSessions(doc, which as R.RankWhich, n, mode as Loose),
};

const webApi: MoneyApi = {
  endedSessions: WS.endedSessions, cashOnly: WS.cashOnly, riskOfRuin: WS.riskOfRuin,
  txnSigned: WB.txnSigned, signedAmount: WB.signedAmount, transactionError: WB.transactionError,
  // The JS default `bankrollId = null` makes TS infer that parameter as `null`; the web code takes any id.
  bankrollSummary: (doc, id) => WB.bankrollSummary(doc, id as null),
  bankrollSeries: (doc, id) => WB.bankrollSeries(doc, id as null),
  bankrollUsage: WB.bankrollUsage,
  bankrollNameError: (doc, name, ex) => WMG.masterNameError(doc, 'bankrolls', name, ex as null),
  bankrollDeleteError: (doc, id) => WMG.masterDeleteError(doc, 'bankrolls', id),
  rorBandClass: WB.rorBand, soldPercent: WK.soldPercent, sellActionError: WK.sellActionError,
  makeSellAction: WK.makeSellAction,
  sellSummary: a => { const p = WK.soldPercent(a); return p > 0 ? `${webFmtNum(p)}% sold` : 'None'; },
  sellActionsOf: WK.sellActionsOf, sellLedger: WK.sellLedger, topSessions: WR.topSessions,
};

/** Fresh deep copy of the stored inputs, so no implementation can leak mutations into another. */
const inputs = (): MoneyInputs => JSON.parse(JSON.stringify(golden.inputs));

describe('money golden parity (native vs web fixtures)', () => {
  const actual = computeMoney(nativeApi, inputs()) as Record<string, unknown>;
  const sections = Object.keys(golden.expected);

  it('fixture covers every section', () => {
    assert.deepEqual(sections.sort(), ['bankroll', 'ledgers', 'makeSellAction', 'ror', 'rorBand', 'sellActionError',
      'sellSummary', 'signedAmount', 'soldPercent', 'top', 'transactionError', 'txnSigned'].sort());
  });
  for (const key of sections) {
    it(`${key} is byte-identical to web`, () => {
      assert.equal(JSON.stringify(actual[key]), JSON.stringify(golden.expected[key]));
    });
  }
  it('fixture is current: re-running the web modules reproduces it', () => {
    assert.equal(JSON.stringify(computeMoney(webApi, inputs())), JSON.stringify(golden.expected));
  });
});

// --- worked examples ------------------------------------------------------------

const H = 3600e3;
const iso = (ms: number) => new Date(ms).toISOString();
const close = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} ${a} !== ${b}`);

function tourney(id: string, total: number, prize: number | null): Session {
  const start = NOW - 10 * 24 * H;
  return {
    id, kind: 'tournament', game_id: 'g', location_id: null, bankroll_id: 'bk', group_id: null, table_size: 9,
    start_time: iso(start), end_time: iso(start + 4 * H), duration_seconds: 4 * 3600, break_seconds: 0,
    is_live: false, paused_at: null, hands_count: null, hands_count_estimated: false, comment: null, opponents: null,
    tracked_via_stack: false, small_blind: null, big_blind: null, buy_in: null, cashed_out: null, tips: 0,
    tournament_type_id: null, tournament_name: null, initial_buy_in: total, total_buy_in: total, prize,
    position: null, entries: null, created_at: iso(start), updated_at: iso(start),
  };
}

describe('staking ledger worked examples', () => {
  it('brief seed case: 30% sold at 1.1 markup, busted for 100', () => {
    const d = blankDoc();
    d.sessions = [tourney('t', 100, 0)];
    d.sell_actions = [{ id: 'a', session_id: 't', percentage: 30, markup: 1.1, backer_name: 'Bob' }];
    const L = K.sellLedger(d, d.sessions[0]);
    close(L.entries[0].cost, 33);        // 100 * 0.3 * 1.1
    close(L.entries[0].payout, 0);
    close(L.entries[0].backer_net, -33);
    close(L.gross, -100);
    close(L.retained, -67);              // 0 - 100 * (1 - 0.33)
    close(L.gross, L.retained + L.backersNet);
  });

  it('partial sells across three backers: gross = retained + backers', () => {
    const d = blankDoc();
    d.sessions = [tourney('t', 50, 400)];
    d.sell_actions = [
      { id: 'a', session_id: 't', percentage: 20, markup: 1, backer_name: null },
      { id: 'b', session_id: 't', percentage: 15, markup: 1.25, backer_name: 'Ann' },
      { id: 'c', session_id: 't', percentage: 10, markup: 1, backer_name: null },
    ];
    const L = K.sellLedger(d, d.sessions[0]);
    close(L.soldPct, 45);
    close(L.received, 50 * (0.2 + 0.15 * 1.25 + 0.1));   // 24.375
    close(L.paidOut, 400 * 0.45);                         // 180
    close(L.retained, 400 * 0.55 - 50 * (1 - 0.4875));    // 194.375
    close(L.gross, 350);
    close(L.gross, L.retained + L.backersNet);
  });

  it('validation rejects overselling with the remaining share', () => {
    assert.equal(K.sellActionError([{ percentage: 70 }], '31', '1'), 'Only 30% left to sell (total cannot exceed 100%)');
    assert.equal(K.sellActionError([{ percentage: 70 }], '30', ''), null);
    assert.equal(K.sellSummary([{ percentage: 12.5 }, { percentage: 17.5 }]), '30% sold');
  });
});

describe('bankroll + risk of ruin worked examples', () => {
  it('total = retained session nets + signed transactions; banked = deposits - withdrawals', () => {
    const d = blankDoc();
    d.bankrolls = [{ id: 'bk', name: 'Live', is_default: true }];
    d.sessions = [tourney('t', 100, 0)];
    d.sell_actions = [{ id: 'a', session_id: 't', percentage: 30, markup: 1.1, backer_name: null }];
    d.transactions = [
      { id: 'x1', bankroll_id: 'bk', kind: 'deposit', amount: 300, description: null, occurred_at: iso(NOW - 20 * 24 * H), created_at: iso(NOW) },
      { id: 'x2', bankroll_id: 'bk', kind: 'withdrawal', amount: 50, description: null, occurred_at: iso(NOW - 5 * 24 * H), created_at: iso(NOW) },
      { id: 'x3', bankroll_id: 'bk', kind: 'other', amount: -12, description: 'Parking', occurred_at: iso(NOW - 4 * 24 * H), created_at: iso(NOW) },
    ];
    const sum = B.bankrollSummary(d, 'bk');
    close(sum.net, -67);
    close(sum.banked, 250);
    close(sum.other, -12);
    close(sum.total, 300 - 50 - 12 - 67);
    assert.equal(sum.ror, null); // no cash sessions -> no RoR
    const series = B.bankrollSeries(d, 'bk');
    assert.deepEqual(series.map(p => p.y), [300, 233, 183, 171]);
  });

  it('RoR = exp(-2 * mean * bankroll / variance), clamped 1..100, integer', () => {
    // Two 1h cash sessions: +30 and -10 -> mean 10/h, variance 400.
    const d = blankDoc();
    const mk = (id: string, net: number, daysAgo: number): Session => ({
      ...tourney(id, 0, 0), kind: 'cash', initial_buy_in: null, total_buy_in: null, prize: null,
      small_blind: 0.5, big_blind: 1, buy_in: 100, cashed_out: 100 + net,
      start_time: iso(NOW - daysAgo * 24 * H), end_time: iso(NOW - daysAgo * 24 * H + H), duration_seconds: 3600,
    });
    d.sessions = [mk('a', 30, 3), mk('b', -10, 2)];
    const cash = S.cashOnly(S.endedSessions(d));
    assert.equal(S.riskOfRuin(d, cash, 50), Math.round(100 * Math.exp(-2 * 10 * 50 / 400))); // 8
    assert.equal(S.riskOfRuin(d, cash, 1e6), 1);
    assert.equal(B.rorBand(8), 'low');
    assert.equal(B.rorBand(10), 'mid');
    assert.equal(B.rorBand(31), 'high');
  });
});

describe('top 10 worked examples', () => {
  it('ties resolve to the later start, then id; staking mode changes the rank', () => {
    const d = blankDoc();
    const a = tourney('a', 10, 60);
    const b = { ...tourney('b', 10, 60), start_time: iso(NOW - 2 * 24 * H) };
    const c = tourney('c', 40, 200);
    d.sessions = [a, b, c];
    d.sell_actions = [{ id: 's', session_id: 'c', percentage: 80, markup: 1, backer_name: null }];
    assert.deepEqual(R.topSessions(d, 'best', 10, 'gross').map(x => x.s.id), ['c', 'b', 'a']); // 160, 50, 50
    assert.deepEqual(R.topSessions(d, 'best', 10, 'net').map(x => x.s.id), ['b', 'a', 'c']);   // 50, 50, 32
    assert.deepEqual(R.topSessions(d, 'worst', 2, 'net').map(x => x.s.id), ['c', 'b']);
  });
});

describe('money mutators', () => {
  let n = 0;
  const newId = () => `id-${++n}`;

  it('sell actions attach to the session and touch it', () => {
    const d: Doc = blankDoc();
    d.sessions = [tourney('t', 10, 0)];
    const before = d.sessions[0].updated_at;
    const id = K.addSellAction(d, 't', { percentage: '30', markup: '', backer_name: '  Bob ' }, newId);
    assert.deepEqual(d.sell_actions[0], { id, session_id: 't', percentage: 30, markup: 1, backer_name: 'Bob' });
    assert.notEqual(d.sessions[0].updated_at, before);
    K.deleteSellAction(d, id);
    assert.equal(d.sell_actions.length, 0);
  });

  it('transactions and bankrolls: add, edit, default, guarded delete', () => {
    const d: Doc = blankDoc();
    const live = B.addBankroll(d, ' Live ', newId);
    assert.equal(d.bankrolls[0].name, 'Live');
    assert.equal(d.bankrolls[0].is_default, true);
    const online = B.addBankroll(d, 'Online', newId);
    assert.equal(d.bankrolls[1].is_default, false);
    assert.equal(B.bankrollNameError(d, 'live'), 'That name already exists');
    const tx = B.addTransaction(d, { bankroll_id: live, kind: 'deposit', amount: B.signedAmount('deposit', 300),
      description: '', occurred_at: iso(NOW) }, newId);
    assert.equal(d.transactions[0].description, null);
    B.updateTransaction(d, tx, { amount: 250 });
    assert.equal(d.transactions[0].amount, 250);
    assert.equal(B.bankrollDeleteError(d, live), 'Used by 1 record — reassign them first');
    B.deleteTransaction(d, tx);
    assert.equal(B.bankrollDeleteError(d, live), null);
    B.setDefaultBankroll(d, online);
    assert.deepEqual(d.bankrolls.map(b => b.is_default), [false, true]);
    B.deleteBankroll(d, online);
    assert.deepEqual(d.bankrolls.map(b => [b.id, b.is_default]), [[live, true]]);
    assert.equal(B.bankrollDeleteError(d, live), 'Keep at least one bankroll');
  });
});
