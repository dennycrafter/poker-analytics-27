// Parity + worked-example tests for the ported formulas.
//
// 1. Parity: the web app's own modules (js/stats.js, js/metrics.js,
//    js/cloud-map.js) and the native ports run on the same fixtures — the
//    web's deterministic 40-session demo seed — and must produce identical
//    values, formatted strings, chart series and database rows.
// 2. Worked examples: small hand-computed cases from the brief (section 7) so
//    a bug shared by both implementations still fails.
//
// Run: npm test   (node:test via tsx; also run under TZ=Europe/Dublin)

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSeed } from '../../js/seed.js';
import * as WS from '../../js/stats.js';
import * as WM from '../../js/metrics.js';
import * as WC from '../../js/cloud-map.js';

import * as S from '../src/lib/stats';
import * as M from '../src/lib/metrics';
import * as C from '../src/lib/cloud-map';
import * as D from '../src/lib/domain';
import { blankDoc, type Doc, type Session, type StakingMode } from '../src/lib/types';

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const MODES: StakingMode[] = ['net', 'gross'];
const SCOPES: M.ScopeId[] = ['all', 'cash', 'tournament'];

/** The web seed is plain JSON; the native Doc additionally carries extra_master. */
function seedDoc(): Doc {
  const web = buildSeed(NOW) as unknown as Partial<Doc>;
  return { ...blankDoc(), ...web, extra_master: {} };
}

/** Equal, with float noise tolerance (both sides use identical arithmetic, so this is belt and braces). */
function same(actual: unknown, expected: unknown, msg: string): void {
  if (typeof actual === 'number' && typeof expected === 'number') {
    if (Number.isNaN(expected)) { assert.ok(Number.isNaN(actual), msg); return; }
    assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${msg}: ${actual} !== ${expected}`);
    return;
  }
  assert.deepEqual(actual, expected, msg);
}

describe('parity with web js/stats.js + js/metrics.js on the demo seed', () => {
  const doc = seedDoc();
  const ended = S.endedSessions(doc);

  it('uses a non-trivial fixture (cash, tournaments, staking, breaks)', () => {
    assert.equal(ended.length, 40);
    assert.ok(S.cashOnly(ended).length >= 25);
    assert.ok(S.tournamentsOnly(ended).length >= 5);
    assert.ok(doc.sell_actions.length >= 1);
    assert.ok(ended.some(s => s.break_seconds > 0));
    assert.equal(WS.endedSessions(doc).length, ended.length);
  });

  it('per-session derived values match', () => {
    for (const s of ended) {
      same(S.netResult(doc, s), WS.netResult(doc, s), `netResult ${s.id}`);
      same(S.sessionHours(s), WS.sessionHours(s), `sessionHours ${s.id}`);
      same(S.hourlyRate(doc, s, NOW), WS.hourlyRate(doc, s, NOW), `hourlyRate ${s.id}`);
      same(S.netResultBB(doc, s), WS.netResultBB(doc, s), `netResultBB ${s.id}`);
      same(S.bbPer100(doc, s), WS.bbPer100(doc, s), `bbPer100 ${s.id}`);
      same(S.stakedNetResult(doc, s), WS.stakedNetResult(doc, s), `stakedNetResult ${s.id}`);
      for (const m of MODES) same(S.sessionNet(doc, s, m), WS.sessionNet(doc, s, m), `sessionNet ${m} ${s.id}`);
    }
  });

  it('every registry metric matches in every scope and staking mode (value + formatted string)', () => {
    const ids = Object.keys(M.METRICS) as M.MetricId[];
    assert.deepEqual([...ids].sort(), Object.keys(WM.METRICS).sort(), 'same metric registry');
    let checked = 0;
    for (const scope of SCOPES) {
      const list = M.SCOPES[scope].pick(ended);
      for (const id of ids) {
        for (const mode of MODES) {
          const n = M.metricValue(doc, id, list, mode);
          const w = WM.metricValue(doc, id, list, mode);
          same(n, w, `${scope}/${id}/${mode}`);
          assert.equal(M.fmtMetric(M.metricDef(id), n, 'EUR'), WM.fmtMetric(WM.METRICS[id], w, 'EUR'), `fmt ${scope}/${id}/${mode}`);
          checked++;
        }
      }
    }
    assert.equal(checked, ids.length * SCOPES.length * MODES.length);
    assert.ok(ids.length >= 23, 'full registry exercised');
  });

  it('Statistics sections and Calendar tabs are identical', () => {
    assert.deepEqual(M.SECTIONS, WM.SECTIONS);
    assert.deepEqual(M.CALENDAR_METRICS, WM.CALENDAR_METRICS);
  });

  it('Calendar month values match for every month and metric', () => {
    const months = M.monthSpan(ended, NOW);
    assert.ok(months.length >= 5);
    for (const key of months) {
      const list = M.sessionsInMonth(ended, key);
      for (const cm of M.CALENDAR_METRICS) {
        same(M.calendarValue(doc, cm, list), WM.calendarValue(doc, cm, list), `calendar ${key}/${cm.id}`);
      }
    }
  });

  it('stat-detail series match for every group and chart kind', () => {
    for (const id of ['net', 'hourly', 'bb100', 'roi', 'win_ratio', 'stddev'] as M.MetricId[]) {
      for (const group of ['unit', 'month', 'year', 'duration'] as M.SeriesGroup[]) {
        for (const chart of ['line', 'bar'] as M.ChartKind[]) {
          const n = M.buildSeries(doc, id, ended, { group, chart });
          const w = WM.buildSeries(doc, id, ended, { group, chart }) as M.SeriesPoint[];
          assert.equal(n.length, w.length, `series length ${id}/${group}/${chart}`);
          n.forEach((p, i) => {
            same(p.x, w[i].x, `x ${id}/${group}/${chart}#${i}`);
            same(p.y, w[i].y, `y ${id}/${group}/${chart}#${i}`);
            assert.equal(p.label, w[i].label);
          });
        }
      }
    }
  });

  it('risk of ruin and streaks match', () => {
    const cash = S.cashOnly(ended);
    for (const bankroll of [0, 100, 300, 1000, 5000]) {
      same(S.riskOfRuin(doc, cash, bankroll), WS.riskOfRuin(doc, cash, bankroll), `RoR ${bankroll}`);
    }
    for (const m of MODES) assert.deepEqual(S.longestStreaks(doc, ended, m), WS.longestStreaks(doc, ended, m));
  });

  it('database rows are byte-identical (shared realtime fingerprints)', () => {
    const uid = '00000000-0000-4000-8000-000000000001';
    for (const s of doc.sessions) {
      const n = C.stableStringify(C.sessionToRow(doc, s, uid));
      const w = WC.stableStringify(WC.sessionToRow(doc, s, uid));
      assert.equal(n, w, `session row ${s.id}`);
      const back = C.rowToSessionParts(JSON.parse(n));
      assert.equal(C.stableStringify(C.sessionToRow(back, back.session, uid)), n, `round trip ${s.id}`);
    }
    for (const t of doc.transactions) {
      assert.equal(C.stableStringify(C.transactionToRow(t, uid)), WC.stableStringify(WC.transactionToRow(t, uid)), `txn ${t.id}`);
    }
    assert.equal(
      C.stableStringify(C.settingsToRow(doc, uid)),
      WC.stableStringify(WC.settingsToRow(doc, uid)),
      'settings row',
    );
  });
});

// --- worked examples (brief section 7), computed by hand ---------------------

function sess(over: Partial<Session>): Session {
  return {
    id: 'x', kind: 'cash', game_id: null, location_id: null, bankroll_id: null, group_id: null, table_size: 9,
    start_time: '2026-04-04T18:00:00.000Z', end_time: '2026-04-04T22:00:00.000Z', duration_seconds: 4 * 3600,
    break_seconds: 0, is_live: false, paused_at: null, hands_count: null, hands_count_estimated: false,
    comment: null, opponents: null, tracked_via_stack: false,
    small_blind: null, big_blind: null, buy_in: null, cashed_out: null, tips: null,
    tournament_type_id: null, tournament_name: null, initial_buy_in: null, total_buy_in: null,
    prize: null, position: null, entries: null, created_at: null, ...over,
  };
}

describe('worked examples (hand-checked)', () => {
  // Cash A: 100 in, 180 out, 5 tips => +75; 4h with a 30 min break => 3.5h; BB 0.5, 120 hands.
  const cashA = sess({ id: 'a', buy_in: 100, cashed_out: 180, tips: 5, break_seconds: 1800, small_blind: 0.25, big_blind: 0.5, hands_count: 120 });
  // Cash B: 200 in, 150 out => -50; 2h, no break; BB 1, no hands.
  const cashB = sess({ id: 'b', buy_in: 200, cashed_out: 150, tips: 0, duration_seconds: 7200,
    end_time: '2026-04-04T20:00:00.000Z', small_blind: 0.5, big_blind: 1 });
  // Tournaments: T1 busted (30 in), T2 cashed 110 on 20 in.
  const t1 = sess({ id: 't1', kind: 'tournament', initial_buy_in: 30, total_buy_in: 30, prize: 0, duration_seconds: 3 * 3600 });
  const t2 = sess({ id: 't2', kind: 'tournament', initial_buy_in: 20, total_buy_in: 20, prize: 110, duration_seconds: 2 * 3600 });
  const doc = { ...blankDoc(), sessions: [cashA, cashB, t1, t2] };
  const cash = [cashA, cashB];
  const tours = [t1, t2];

  it('net result: cash = cashed_out - buy_in - tips; tournament = prize - total_buy_in', () => {
    assert.equal(S.netResult(doc, cashA), 75);
    assert.equal(S.netResult(doc, cashB), -50);
    assert.equal(S.netResult(doc, t1), -30);
    assert.equal(S.netResult(doc, t2), 90);
    assert.equal(S.totalNet(doc, cash), 25);
    assert.equal(WS.totalNet(doc, cash), 25);
  });

  it('net hourly rate is hours-weighted and excludes breaks: 25 / 5.5h', () => {
    assert.equal(S.sessionHours(cashA), 3.5);
    same(S.netHourlyRate(doc, cash), 25 / 5.5, 'native');
    same(WS.netHourlyRate(doc, cash), 25 / 5.5, 'web');
    // Not the mean of per-session rates ((75/3.5 + -50/2) / 2 = -1.79).
    assert.notEqual(Math.round(S.netHourlyRate(doc, cash)! * 100), Math.round(((75 / 3.5 - 25) / 2) * 100));
    assert.equal(M.fmtMetric(M.metricDef('hourly'), S.netHourlyRate(doc, cash), 'EUR'), WM.fmtMetric(WM.METRICS.hourly, 25 / 5.5, 'EUR'));
  });

  it('ROI = sum(prize - buy-in) / sum(buy-in) = 60 / 50 = 120%; ITM 50%', () => {
    same(S.roi(doc, tours), 1.2, 'native roi');
    same(WS.roi(doc, tours), 1.2, 'web roi');
    assert.equal(M.fmtMetric(M.metricDef('roi'), S.roi(doc, tours), 'EUR'), '120%');
    assert.equal(S.itmRatio(doc, tours), 0.5);
  });

  it('BB/100 = (75 / 0.5) / 120 * 100 = 125, sessions without hands skipped', () => {
    same(S.bbPer100Agg(doc, cash), 125, 'native');
    same(WS.bbPer100Agg(doc, cash), 125, 'web');
  });

  it('win ratio = 1 winning of 2 cash sessions = 50%', () => {
    assert.equal(S.winRatio(doc, cash), 0.5);
  });

  it('staking: prize*(1-sold) - buy_in*(1-sold*markup) = 1000*0.7 - 50*0.67 = 666.5', () => {
    const deep = sess({ id: 'deep', kind: 'tournament', initial_buy_in: 50, total_buy_in: 50, prize: 1000 });
    const staked = { ...blankDoc(), sessions: [deep], sell_actions: [{ id: 'sa', session_id: 'deep', percentage: 30, markup: 1.1, backer_name: null }] };
    same(S.stakedNetResult(staked, deep), 666.5, 'native staked');
    same(WS.stakedNetResult(staked, deep), 666.5, 'web staked');
    assert.equal(S.sessionNet(staked, deep, 'gross'), 950);
  });

  it('no eligible sessions => "--"', () => {
    assert.equal(S.bbPer100Agg(doc, [cashB]), null);
    assert.equal(M.fmtMetric(M.metricDef('bb100'), null, 'EUR'), '--');
    assert.equal(M.fmtMetric(M.metricDef('net'), M.metricValue(doc, 'net', []), 'EUR'), '--');
  });
});

// --- live session domain rules ----------------------------------------------

describe('live session domain (native port of js/domain.js)', () => {
  let n = 0;
  const id = () => `id-${++n}`;
  const t0 = Date.parse('2026-10-09T18:00:00.000Z');

  it('live cash derives buy-in from stack events; end records a cash_out event', () => {
    const d = blankDoc();
    const sid = D.startLiveCash(d, { game_id: 'g', location_id: null, bankroll_id: 'b', group_id: null, table_size: 9,
      small_blind: 0.5, big_blind: 1, buy_in: 100, start_time: new Date(t0).toISOString() }, id);
    D.addStackEvent(d, sid, { kind: 'top_up', amount: 50, occurred_at: new Date(t0 + 3600e3).toISOString() }, id);
    const s = D.getSession(d, sid)!;
    assert.equal(s.tracked_via_stack, true);
    assert.equal(S.stackBuyIn(d, s), 150);
    assert.equal(D.getLiveSession(d)?.id, sid);
    D.endLiveCash(d, sid, 230, id, t0 + 3 * 3600e3);
    assert.equal(s.is_live, false);
    assert.equal(s.duration_seconds, 3 * 3600);
    assert.equal(S.netResult(d, s), 80);
    assert.equal(D.getLiveSession(d), null);
  });

  it('pause/resume folds the pause into break_seconds', () => {
    const d = blankDoc();
    const sid = D.startLiveTournament(d, { game_id: 'g', location_id: null, bankroll_id: 'b', group_id: null, table_size: 9,
      tournament_type_id: null, tournament_name: null, initial_buy_in: 10, start_time: new Date(t0).toISOString() }, id);
    D.togglePause(d, sid, t0 + 600e3);
    D.togglePause(d, sid, t0 + 900e3);
    const s = D.getSession(d, sid)!;
    assert.equal(s.paused_at, null);
    assert.equal(s.break_seconds, 300);
    assert.equal(S.playSeconds(s, t0 + 3600e3), 3300);
  });

  it('ending while paused keeps the ongoing pause as break time', () => {
    const d = blankDoc();
    const sid = D.startLiveTournament(d, { game_id: 'g', location_id: null, bankroll_id: 'b', group_id: null, table_size: 9,
      tournament_type_id: null, tournament_name: null, initial_buy_in: 10, start_time: new Date(t0).toISOString() }, id);
    D.togglePause(d, sid, t0 + 3000e3);
    D.endLiveTournament(d, sid, { position: 3, prize: 40 }, t0 + 3600e3);
    const s = D.getSession(d, sid)!;
    assert.equal(s.break_seconds, 600);
    assert.equal(S.sessionHours(s), 3000 / 3600);
    assert.equal(S.netResult(d, s), 30);
  });

  it('rejects future starts and end-before-start', () => {
    const now = t0;
    assert.match(D.validateTimes(new Date(now + 3600e3), null, now)!, /future/);
    assert.match(D.validateTimes(new Date(now - 3600e3), new Date(now - 7200e3), now)!, /after start/);
    assert.equal(D.validateTimes(new Date(now - 7200e3), new Date(now - 3600e3), now), null);
  });
});
