// Tier 4 verification harness: Risk of Ruin, sell-action ledger, Top 10
// ordering, bankroll totals, transactions, export/import, players, master data.
// Runs the real app modules (no copies). Usage: node tests/tier4-math.test.mjs

import assert from 'node:assert/strict';
import { riskOfRuin, netResult, stakedNetResult, sessionNet, endedSessions } from '../js/stats.js';
import { bankrollSummary, bankrollSeries, txnSigned, signedAmount, transactionError, rorBand } from '../js/bankroll.js';
import { sellLedger, sellActionError, makeSellAction, soldPercent } from '../js/staking.js';
import { topSessions } from '../js/rankings.js';
import { exportPayload, parseImport, demoDoc, EXPORT_APP } from '../js/backup.js';
import { playersFromNotes, notesForPlayer, masterUsage, masterNameError, masterDeleteError, currencyError, playerNoteError } from '../js/manage.js';
import { buildSeed } from '../js/seed.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

const T0 = Date.parse('2026-09-01T18:00:00Z');
const H = 3600e3;
function cash(id, startH, hours, buyIn, cashedOut, extra = {}) {
  return {
    id, kind: 'cash', bankroll_id: 'bk-a', game_id: 'g', location_id: 'l', table_size: 9,
    start_time: new Date(T0 + startH * H).toISOString(), end_time: new Date(T0 + (startH + hours) * H).toISOString(),
    duration_seconds: hours * 3600, break_seconds: 0, is_live: false, tracked_via_stack: false,
    small_blind: 1, big_blind: 2, buy_in: buyIn, cashed_out: cashedOut, tips: 0, ...extra,
  };
}
function tourney(id, startH, hours, totalBuyIn, prize, extra = {}) {
  return {
    id, kind: 'tournament', bankroll_id: 'bk-a', game_id: 'g', table_size: 9,
    start_time: new Date(T0 + startH * H).toISOString(), end_time: new Date(T0 + (startH + hours) * H).toISOString(),
    duration_seconds: hours * 3600, break_seconds: 0, is_live: false, tracked_via_stack: false,
    initial_buy_in: totalBuyIn, total_buy_in: totalBuyIn, prize, ...extra,
  };
}
const baseDoc = over => ({
  settings: { currency: 'EUR' }, bankrolls: [{ id: 'bk-a', name: 'Live', is_default: true }, { id: 'bk-b', name: 'Online', is_default: false }],
  games: [{ id: 'g', name: "NL Hold'em" }], locations: [{ id: 'l', name: 'UCD' }], tournament_types: [], groups: [],
  sessions: [], stack_events: [], sell_actions: [], transactions: [], player_notes: [], hand_histories: [], ...over,
});

console.log('Risk of Ruin (formula 12)');
// Hand check: s1 = +60 over 2h (r=30/h), s2 = -20 over 2h (r=-10/h).
// mean = (30*2 + -10*2)/4 = 10/h; variance = (2*(30-10)^2 + 2*(-10-10)^2)/4 = 400.
// Bankroll = net 40 + withdrawal -20 = 20 -> RoR = exp(-2*10*20/400) = exp(-1) = 36.79% -> 37%.
const rorDoc = baseDoc({
  sessions: [cash('c1', 0, 2, 100, 160), cash('c2', 24, 2, 100, 80)],
  transactions: [{ id: 't1', bankroll_id: 'bk-a', kind: 'withdrawal', amount: -20, occurred_at: new Date(T0 + 30 * H).toISOString() }],
});
test('hand-checked example: mean 10/h, variance 400, bankroll 20 -> 37%', () => {
  const s = bankrollSummary(rorDoc, 'bk-a');
  close(s.moments.mean, 10); close(s.moments.variance, 400);
  assert.equal(s.total, 20);
  assert.equal(s.ror, 37);
  close(Math.exp(-1) * 100, 36.787944117144235);
  assert.equal(rorBand(s.ror), 'ror-high');
});
test('mean <= 0 gives 100%', () => {
  const d = baseDoc({ sessions: [cash('c1', 0, 2, 100, 40), cash('c2', 24, 2, 100, 120)] }); // -60 +20
  assert.equal(riskOfRuin(d, endedSessions(d), 500), 100);
});
test('clamped to 1% for a huge bankroll', () => {
  assert.equal(riskOfRuin(rorDoc, endedSessions(rorDoc), 1e6), 1);
});
test('no cash sessions -> null ("--")', () => {
  const d = baseDoc({ sessions: [tourney('t', 0, 3, 50, 0)] });
  assert.equal(riskOfRuin(d, endedSessions(d), 500), null);
});
test('colour bands: >30 red, 10-30 yellow, <10 green', () => {
  assert.equal(rorBand(31), 'ror-high'); assert.equal(rorBand(30), 'ror-mid');
  assert.equal(rorBand(10), 'ror-mid'); assert.equal(rorBand(9), 'ror-low');
});

console.log('Bankroll value (5.15) and transactions');
test('total = Σ session net + Σ transactions; banked = deposits - withdrawals', () => {
  const d = baseDoc({
    sessions: [cash('c1', 0, 2, 100, 160), cash('c2', 24, 2, 100, 80, { bankroll_id: 'bk-b' })],
    transactions: [
      { id: 'a', bankroll_id: 'bk-a', kind: 'deposit', amount: 300, occurred_at: new Date(T0 - H).toISOString() },
      { id: 'b', bankroll_id: 'bk-a', kind: 'withdrawal', amount: -50, occurred_at: new Date(T0 + 5 * H).toISOString() },
      { id: 'c', bankroll_id: 'bk-a', kind: 'other', amount: -15, occurred_at: new Date(T0 + 6 * H).toISOString() },
    ],
  });
  const a = bankrollSummary(d, 'bk-a');
  assert.deepEqual([a.net, a.banked, a.other, a.total], [60, 250, -15, 295]);
  const all = bankrollSummary(d, null);
  assert.equal(all.total, 275); // 295 + (-20) from bk-b
  const series = bankrollSeries(d, 'bk-a').map(p => p.y);
  assert.deepEqual(series, [300, 360, 310, 295]); // chronological running balance
});
test('live sessions never count', () => {
  const d = baseDoc({ sessions: [cash('c1', 0, 2, 100, 160), { ...cash('lv', 30, 1, 100, null), is_live: true, end_time: null }] });
  assert.equal(bankrollSummary(d, 'bk-a').net, 60);
});
test('signs: deposits add, withdrawals subtract whatever the stored sign', () => {
  assert.equal(txnSigned({ kind: 'deposit', amount: -40 }), 40);
  assert.equal(txnSigned({ kind: 'withdrawal', amount: 40 }), -40);
  assert.equal(txnSigned({ kind: 'other', amount: -12 }), -12);
  assert.equal(signedAmount('withdrawal', '25'), -25);
  assert.equal(signedAmount('other', '9', 'in'), 9);
  assert.equal(signedAmount('other', '9', 'out'), -9);
});
test('transaction validation', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  assert.equal(transactionError({ kind: 'deposit', amountRaw: '', occurredAt: new Date(now), nowMs: now }), 'Enter an amount greater than 0');
  assert.equal(transactionError({ kind: 'deposit', amountRaw: '0', occurredAt: new Date(now), nowMs: now }), 'Enter an amount greater than 0');
  assert.equal(transactionError({ kind: 'deposit', amountRaw: '10', occurredAt: new Date(now + 60e3), nowMs: now }), 'Date cannot be in the future');
  assert.equal(transactionError({ kind: 'bogus', amountRaw: '10', occurredAt: new Date(now), nowMs: now }), 'Pick a transaction type');
  assert.equal(transactionError({ kind: 'other', amountRaw: '10', occurredAt: new Date(now), nowMs: now }), null);
});

console.log('Sell action ledger (5.6 + formula 1)');
// B = 50, P = 500, 30% sold at 1.1: retained = 500*0.7 - 50*(1 - 0.33) = 350 - 33.5 = 316.5.
// Backer: cost 50*0.3*1.1 = 16.5, payout 500*0.3 = 150, backer net 133.5. Gross 450 = 316.5 + 133.5.
const stakeDoc = baseDoc({
  sessions: [tourney('t1', 0, 4, 50, 500), tourney('t2', 10, 2, 50, 0)],
  sell_actions: [
    { id: 's1', session_id: 't1', percentage: 30, markup: 1.1, backer_name: 'M. Byrne' },
    { id: 's2', session_id: 't2', percentage: 30, markup: 1.1, backer_name: 'M. Byrne' },
  ],
});
test('deep run: retained 316.5, backer cost 16.5 / payout 150 / net 133.5, gross 450', () => {
  const L = sellLedger(stakeDoc, stakeDoc.sessions[0]);
  close(L.retained, 316.5); close(L.gross, 450);
  close(L.entries[0].cost, 16.5); close(L.entries[0].payout, 150); close(L.entries[0].backer_net, 133.5);
  close(L.gross, L.retained + L.backersNet);
  assert.equal(L.soldPct, 30);
});
test('bust: retained = -B*(1 - 0.33) = -33.5, backer net -16.5', () => {
  const L = sellLedger(stakeDoc, stakeDoc.sessions[1]);
  close(L.retained, -33.5); close(L.entries[0].backer_net, -16.5); close(L.gross, -50);
});
test('mixed markups: retained = P(1-Σp) - B(1-Σp·m) and gross identity holds', () => {
  const d = baseDoc({
    sessions: [tourney('t', 0, 4, 100, 1000)],
    sell_actions: [
      { id: 'a', session_id: 't', percentage: 20, markup: 1.2 },
      { id: 'b', session_id: 't', percentage: 10, markup: 1 },
    ],
  });
  const L = sellLedger(d, d.sessions[0]);
  close(L.retained, 1000 * 0.7 - 100 * (1 - (0.24 + 0.1))); // 700 - 66 = 634
  close(L.retained, 634);
  close(L.gross, L.retained + L.backersNet);
});
test('seed staked tournament: gross 35 vs net-of-staking 25.25 (the earlier QA example)', () => {
  const seed = buildSeed(Date.parse('2026-10-09T12:00:00Z'));
  const sa = seed.sell_actions[0];
  const s = seed.sessions.find(x => x.id === sa.session_id);
  close(netResult(seed, s), 35);
  close(stakedNetResult(seed, s), 25.25);
  close(sessionNet(seed, s, 'gross'), 35);
  close(sessionNet(seed, s, 'net'), 25.25);
});
test('sell validation: >0, <=100, markup > 0, total cannot exceed 100%', () => {
  assert.equal(sellActionError([], '', ''), 'Enter a percentage greater than 0');
  assert.equal(sellActionError([], '101', ''), 'Percentage cannot exceed 100%');
  assert.equal(sellActionError([], '20', '0'), 'Markup must be a number above 0 (1.0 = no markup)');
  assert.equal(sellActionError([{ percentage: 70 }], '31', '1'), 'Only 30% left to sell (total cannot exceed 100%)');
  assert.equal(sellActionError([{ percentage: 70 }], '30', '1'), null);
  assert.equal(soldPercent([{ percentage: 70 }, { percentage: 30 }]), 100);
  assert.deepEqual(makeSellAction('x', 't', { percentage: '25', markup: '', backer_name: '  ' }),
    { id: 'x', session_id: 't', percentage: 25, markup: 1, backer_name: null });
});

console.log('Top 10 (5.14)');
test('best = net desc, worst = net asc, ties -> more recent first, live excluded, max 10', () => {
  const sessions = [];
  for (let i = 0; i < 14; i++) sessions.push(cash('c' + String(i).padStart(2, '0'), i * 24, 2, 100, 100 + (i % 7) * 10 - 30));
  sessions.push({ ...cash('live', 999, 1, 100, 999), is_live: true, end_time: null });
  const d = baseDoc({ sessions });
  const best = topSessions(d, 'best', 10, 'net');
  assert.equal(best.length, 10);
  assert.ok(!best.some(x => x.s.id === 'live'));
  for (let i = 1; i < best.length; i++) {
    assert.ok(best[i - 1].net > best[i].net || (best[i - 1].net === best[i].net && Date.parse(best[i - 1].s.start_time) > Date.parse(best[i].s.start_time)));
  }
  assert.deepEqual(best.slice(0, 2).map(x => x.s.id), ['c13', 'c06']); // both +30, c13 more recent
  const worst = topSessions(d, 'worst', 10, 'net');
  assert.deepEqual(worst.slice(0, 2).map(x => [x.s.id, x.net]), [['c07', -30], ['c00', -30]]);
});
test('staking mode: net-of-staking vs gross changes the value and the order', () => {
  const d = baseDoc({
    sessions: [tourney('t1', 0, 4, 50, 500), cash('c1', 30, 2, 100, 440)], // gross: t1 450 > c1 340; net: t1 316.5 < c1 340
    sell_actions: [{ id: 's', session_id: 't1', percentage: 30, markup: 1.1 }],
  });
  assert.deepEqual(topSessions(d, 'best', 10, 'gross').map(x => x.s.id), ['t1', 'c1']);
  assert.deepEqual(topSessions(d, 'best', 10, 'net').map(x => x.s.id), ['c1', 't1']);
  close(topSessions(d, 'best', 10, 'net')[1].net, 316.5);
});

console.log('Settings: export / import / reset (5.16)');
test('export -> import round-trip preserves every collection and all money', () => {
  const demo = demoDoc(Date.parse('2026-10-09T12:00:00Z'), uuid);
  const text = JSON.stringify(exportPayload(demo, '2026-10-09T12:00:00Z'));
  const res = parseImport(text, uuid);
  assert.ok(res.ok, res.error);
  for (const k of ['bankrolls', 'games', 'locations', 'tournament_types', 'sessions', 'stack_events', 'sell_actions', 'transactions', 'player_notes', 'hand_histories']) {
    assert.deepEqual(res.doc[k], demo[k], k);
  }
  assert.equal(JSON.parse(text).app, EXPORT_APP);
  close(bankrollSummary(res.doc, null).total, bankrollSummary(demo, null).total);
});
test('demo reset: ~40 ended sessions, uuids, no live session, 3 notes, 1 hand, one 30%/1.1 sell', () => {
  const demo = demoDoc(Date.parse('2026-10-09T12:00:00Z'), uuid);
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  assert.ok(demo.sessions.length >= 35 && demo.sessions.length <= 45);
  assert.ok(demo.sessions.every(s => uuidRe.test(s.id) && !s.is_live));
  assert.ok(demo.transactions.every(t => uuidRe.test(t.id)));
  assert.ok(demo.sell_actions.every(a => demo.sessions.some(s => s.id === a.session_id)));
  assert.equal(demo.player_notes.length, 3); assert.equal(demo.hand_histories.length, 1);
  assert.deepEqual(demo.sell_actions.map(a => [a.percentage, a.markup]), [[30, 1.1]]);
});
test('legacy bare document (Tier 1/2 local shape) imports and re-keys ids consistently', () => {
  const seed = buildSeed(Date.parse('2026-10-09T12:00:00Z'));
  const res = parseImport(JSON.stringify(seed), uuid);
  assert.ok(res.ok, res.error);
  assert.equal(res.doc.sessions.length, seed.sessions.length);
  assert.ok(res.doc.stack_events.every(e => res.doc.sessions.some(s => s.id === e.session_id)));
  close(bankrollSummary(res.doc, null).total, bankrollSummary(seed, null).total);
});
test('import rejects bad files with a clear message', () => {
  assert.equal(parseImport('{nope', uuid).error, 'This file is not valid JSON.');
  assert.equal(parseImport('[]', uuid).error, 'This file does not contain Poker Analytics data.');
  assert.equal(parseImport(JSON.stringify({ app: 'other', data: {} }), uuid).error, 'This file is not a Poker Analytics 27 export.');
  assert.equal(parseImport(JSON.stringify({ app: EXPORT_APP, format: 99, data: { sessions: [] } }), uuid).error, 'This export was made by a newer version of the app.');
  assert.equal(parseImport(JSON.stringify({ sessions: [{ id: 'x', kind: 'poker' }] }), uuid).error, 'A session is missing its id, kind or start time.');
  assert.equal(parseImport(JSON.stringify({ sessions: [], transactions: [{ kind: 'gift', amount: 1 }] }), uuid).error, 'A transaction has an unknown kind or amount.');
});
test('import keeps at most one live session', () => {
  const live = { ...cash('11111111-1111-4111-8111-111111111111', 0, 1, 100, null), is_live: true, end_time: null };
  const live2 = { ...live, id: '22222222-2222-4222-8222-222222222222' };
  const res = parseImport(JSON.stringify({ sessions: [live, live2] }), uuid);
  assert.equal(res.doc.sessions.filter(s => s.is_live).length, 1);
});
test('currency code validation', () => {
  assert.equal(currencyError('usd'), null);
  assert.equal(currencyError('EURO'), 'Use a 3-letter currency code (e.g. EUR)');
});

console.log('Master data and Players (5.14, 5.16)');
test('master data: usage blocks delete, names unique case-insensitively, keep one bankroll', () => {
  const d = baseDoc({ sessions: [cash('c1', 0, 2, 100, 160)], transactions: [{ id: 't', bankroll_id: 'bk-b', kind: 'deposit', amount: 5 }] });
  assert.equal(masterUsage(d, 'locations', 'l'), 1);
  assert.equal(masterDeleteError(d, 'locations', 'l'), 'Used by 1 record — reassign them first');
  assert.equal(masterUsage(d, 'bankrolls', 'bk-b'), 1); // transactions count too
  assert.equal(masterNameError(d, 'games', " nl hold'em "), 'That name already exists');
  assert.equal(masterNameError(d, 'games', "NL Hold'em", 'g'), null); // renaming itself
  assert.equal(masterNameError(d, 'games', '   '), 'Enter a name');
  const one = baseDoc({ bankrolls: [{ id: 'only', name: 'Only', is_default: true }] });
  assert.equal(masterDeleteError(one, 'bankrolls', 'only'), 'Keep at least one bankroll');
});
test('players: grouped by trimmed case-insensitive name, newest first', () => {
  const notes = [
    { id: '1', player_name: 'Eoin K.', note: 'tight', created_at: '2026-09-01T10:00:00Z' },
    { id: '2', player_name: ' eoin k. ', note: 'talks', created_at: '2026-09-20T10:00:00Z' },
    { id: '3', player_name: 'Sandra M.', note: 'tilts', created_at: '2026-09-10T10:00:00Z' },
    { id: '4', player_name: '   ', note: 'ignored', created_at: '2026-09-30T10:00:00Z' },
  ];
  const ps = playersFromNotes(notes);
  assert.deepEqual(ps.map(p => [p.name, p.notes.length]), [['Eoin K.', 2], ['Sandra M.', 1]]);
  assert.equal(ps[0].notes[0].id, '2');
  assert.equal(notesForPlayer(notes, 'EOIN K.').notes.length, 2);
  assert.equal(playerNoteError('', 'x'), 'Enter the player name');
  assert.equal(playerNoteError('A', ' '), 'Write a note');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
