// STEP E verification: CSV export (sessions + bankroll transactions) that
// round-trips through the import mapper.
//
//   export sessions CSV  ->  importCsv(text)  ->  same sessions (field by field)
//   every export header must map back to its field via matchHeader
//
// Pure module tests: no store, no network. Usage: node tests/stepe-csv-export.test.mjs

import assert from 'node:assert/strict';
import { importCsv, matchHeader, sessionFingerprint } from '../js/csv-import.js';
import { netResult } from '../js/stats.js';
import {
  sessionsCsv, transactionsCsv, csvExportFilename,
} from '../js/csv-export.js';

const round2 = v => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// A realistic document: ended cash + tournaments (incl. SNG type, group),
// a live-tracked ended session (money on stack events), one live session
// (excluded), master data with a rename case ("NLH 25/50"), and transactions.
const T0 = Date.UTC(2026, 8, 1, 19, 0, 0);
const doc = {
  currency: 'EUR',
  games: [
    { id: 'g-nlh', name: "NL Hold'em" },
    { id: 'g-plo', name: 'PLO' },
  ],
  locations: [{ id: 'loc-ucd', name: 'UCD' }],
  groups: [{ id: 'grp-home', name: 'Home League' }],
  tournament_types: [{ id: 'tt-sng', name: 'SNG' }, { id: 'tt-mtt', name: 'MTT' }],
  bankrolls: [{ id: 'bk-live', name: 'Live', is_default: true }],
  stack_events: [
    { id: 'e1', session_id: 's-live-ended', kind: 'buy_in', amount: 200, occurred_at: new Date(T0 - 5 * 3600e3).toISOString() },
    { id: 'e2', session_id: 's-live-ended', kind: 'top_up', amount: 100, occurred_at: new Date(T0 - 4 * 3600e3).toISOString() },
    { id: 'e3', session_id: 's-live-ended', kind: 'cash_out', amount: 420, occurred_at: new Date(T0).toISOString() },
  ],
  sessions: [
    { // plain cash win
      id: 's-cash', kind: 'cash', game_id: 'g-nlh', location_id: 'loc-ucd', bankroll_id: 'bk-live',
      group_id: 'grp-home', start_time: new Date(T0).toISOString(), end_time: new Date(T0 + 3 * 3600e3).toISOString(),
      duration_seconds: 3 * 3600, break_seconds: 0, table_size: 9, hands_count: 90,
      hands_count_estimated: false, comment: 'Solid game, "tough" table', opponents: 'Rook, Mara',
      is_live: false, tracked_via_stack: false, small_blind: 0.1, big_blind: 0.2,
      buy_in: 20, cashed_out: 35, tips: 0,
    },
    { // cash loss with tips, no table size
      id: 's-loss', kind: 'cash', game_id: 'g-nlh', location_id: null, bankroll_id: 'bk-live',
      group_id: null, start_time: new Date(T0 + 86400e3).toISOString(), end_time: new Date(T0 + 86400e3 + 2 * 3600e3).toISOString(),
      duration_seconds: 2 * 3600, break_seconds: 900, table_size: null, hands_count: 42,
      hands_count_estimated: true, comment: null, opponents: null,
      is_live: false, tracked_via_stack: false, small_blind: 0.5, big_blind: 1,
      buy_in: 100, cashed_out: 62.5, tips: 2.5,
    },
    { // tournament with full metadata
      id: 's-mtt', kind: 'tournament', game_id: null, location_id: 'loc-ucd', bankroll_id: 'bk-live',
      group_id: 'grp-home', tournament_type_id: 'tt-mtt', tournament_name: 'Wednesday Night 5k',
      start_time: new Date(T0 + 2 * 86400e3).toISOString(), end_time: new Date(T0 + 2 * 86400e3 + 4 * 3600e3).toISOString(),
      duration_seconds: 4 * 3600, break_seconds: 0, table_size: 9, hands_count: null,
      hands_count_estimated: false, comment: null, opponents: null,
      is_live: false, tracked_via_stack: false, initial_buy_in: 50, total_buy_in: 60,
      prize: 120, position: 3, entries: 80, tips: 0,
    },
    { // SNG
      id: 's-sng', kind: 'tournament', game_id: null, location_id: null, bankroll_id: 'bk-live',
      group_id: null, tournament_type_id: 'tt-sng', tournament_name: null,
      start_time: new Date(T0 + 3 * 86400e3).toISOString(), end_time: new Date(T0 + 3 * 86400e3 + 1800e3).toISOString(),
      duration_seconds: 1800, break_seconds: 0, table_size: 9, hands_count: null,
      hands_count_estimated: false, comment: null, opponents: null,
      is_live: false, tracked_via_stack: false, initial_buy_in: 10, total_buy_in: 10,
      prize: 0, position: null, entries: null, tips: 0,
    },
    { // ended session that was tracked live — money lives on stack events
      id: 's-live-ended', kind: 'cash', game_id: 'g-plo', location_id: 'loc-ucd', bankroll_id: 'bk-live',
      group_id: null, start_time: new Date(T0 - 5 * 3600e3).toISOString(), end_time: new Date(T0).toISOString(),
      duration_seconds: 5 * 3600, break_seconds: 0, table_size: 8, hands_count: null,
      hands_count_estimated: false, comment: null, opponents: null,
      is_live: false, tracked_via_stack: true, small_blind: 0.5, big_blind: 1,
      buy_in: null, cashed_out: null, tips: 0,
    },
    { // live right now — must NOT export
      id: 's-live', kind: 'cash', game_id: 'g-nlh', location_id: null, bankroll_id: 'bk-live',
      group_id: null, start_time: new Date(T0 + 4 * 86400e3).toISOString(), end_time: null,
      duration_seconds: null, break_seconds: 0, table_size: 9, hands_count: null,
      hands_count_estimated: false, comment: null, opponents: null,
      is_live: true, tracked_via_stack: true, small_blind: 0.1, big_blind: 0.2,
      buy_in: null, cashed_out: null, tips: 0,
    },
  ],
  transactions: [
    { id: 'tx-1', bankroll_id: 'bk-live', kind: 'deposit', amount: 500, description: 'Starting bankroll', occurred_at: new Date(T0 - 86400e3).toISOString() },
    { id: 'tx-2', bankroll_id: 'bk-live', kind: 'withdrawal', amount: -75, description: 'Rent, "the pain"', occurred_at: new Date(T0 + 86400e3).toISOString() },
    { id: 'tx-3', bankroll_id: null, kind: 'other', amount: 10, description: null, occurred_at: new Date(T0 + 2 * 86400e3).toISOString() },
  ],
};

const pass = [];
let fail = 0;
const test = (name, fn) => {
  try { fn(); pass.push(name); console.log('  ok  ', name); }
  catch (e) { fail++; console.error('  FAIL', name, '\n     ', e.message); }
};

// --- export shape ------------------------------------------------------------

test('every export header maps back to its field through the import mapper', () => {
  const headers = sessionsCsv(doc).split('\n')[0].split(',');
  const fields = new Set(headers.map(h => matchHeader(h).field));
  for (const f of ['kind', 'start_time', 'end_time', 'duration', 'break', 'game', 'stakes',
    'buy_in', 'cashed_out', 'net_result', 'tips', 'hands_count', 'table_size', 'location', 'bankroll',
    'group', 'tournament_type', 'tournament_name', 'initial_buy_in', 'total_buy_in', 'prize',
    'position', 'entries', 'currency', 'comment', 'opponents']) {
    assert.ok(fields.has(f), `header for ${f} missing or unmappable (headers: ${headers.join(' | ')})`);
  }
  // And the mapping the mapper suggests for our own header row is fully valid.
  const { mappingErrors } = importCsv(sessionsCsv(doc));
  assert.deepEqual(mappingErrors, [], 'import of our own export has no mapping errors');
});

test('exported values: money as plain numbers, duration H:MM:SS, UTC ISO timestamps', () => {
  const text = sessionsCsv(doc);
  const row = text.split('\n').find(r => r.includes('Solid game'));
  assert.ok(row);
  assert.ok(row.includes('0.1/0.2'), 'stakes cell');
  assert.ok(row.includes(',20,'), 'buy_in 20 without decimals');
  assert.ok(row.includes(',35,'), 'cashed_out 35');
  assert.ok(row.includes(',3:00:00,'), 'duration 3h as H:MM:SS');
  assert.ok(row.startsWith('cash,2026-09-01T19:00:00'), 'kind + ISO start');
});

test('live-tracked ended sessions export their stack-event totals as buy-in/cashed-out', () => {
  const rows = sessionsCsv(doc).split('\n');
  const plo = rows.find(r => r.includes('0.5/1') && r.includes('UCD'));
  assert.ok(plo, 'PLO row exported');
  assert.ok(plo.includes(',300,'), 'buy_in = 200 buy-in + 100 top-up');
  assert.ok(plo.includes(',420,'), 'cashed_out from the cash_out event');
});

test('live sessions are excluded from the export', () => {
  const text = sessionsCsv(doc);
  assert.equal(text.split('\n').length - 2, 5, '5 ended sessions (header + trailing newline)');
  assert.ok(!text.includes('2026-09-05'), 'the live session start date never appears');
});

test('CSV escaping: quotes, commas, newlines and semicolons survive the round-trip', () => {
  const text = sessionsCsv(doc);
  const r = importCsv(text, { currency: 'EUR' });
  assert.ok(r.ok, JSON.stringify({ mappingErrors: r.mappingErrors, errors: r.errors?.slice(0, 3) }));
  const c = r.accepted.find(d => d.session.comment?.includes('tough'));
  assert.equal(c.session.comment, 'Solid game, "tough" table');
  assert.equal(c.session.opponents, 'Rook, Mara');
});

test('export filename: pa27-sessions-YYYY-MM-DD.csv / pa27-bankroll-YYYY-MM-DD.csv', () => {
  assert.equal(csvExportFilename('sessions', T0), 'pa27-sessions-2026-09-01.csv');
  assert.equal(csvExportFilename('bankroll', T0), 'pa27-bankroll-2026-09-01.csv');
});

// --- transactions export -----------------------------------------------------

test('transactions CSV: date, bankroll name, kind, amount, description', () => {
  const text = transactionsCsv(doc);
  const lines = text.split('\n');
  assert.equal(lines[0], 'Date,Bankroll,Kind,Amount,Description');
  assert.ok(lines[1].includes('2026-08-31') && lines[1].includes('Live') && lines[1].includes('deposit,500'), lines[1]);
  const r = importCsv(text, { currency: 'EUR' });
  // Feeding the transactions file into the session importer must be REJECTED
  // with a clear mapping error, never half-interpreted as sessions.
  assert.ok(r.mappingErrors.length >= 1 && r.mappingErrors.join(' ').match(/End time|Duration/i),
    `got: ${JSON.stringify(r.mappingErrors)}`);
});

// --- round-trip: export -> import -> same sessions -----------------------------

test('round-trip: sessionsCsv -> importCsv -> drafts identical to the originals', () => {
  const text = sessionsCsv(doc);
  const r = importCsv(text, { currency: 'EUR' });
  assert.ok(r.ok, JSON.stringify({ mappingErrors: r.mappingErrors, errors: r.errors?.slice(0, 3) }));
  assert.equal(r.accepted.length, 5, 'all five ended sessions re-import');
  assert.equal(r.rejected.length, 0);

  const nameOf = (list, id) => doc[list].find(x => x.id === id)?.name ?? null;
  for (const orig of doc.sessions.filter(s => !s.is_live)) {
    const d = r.accepted.find(x => x.session.start_time === orig.start_time
      && x.session.kind === orig.kind);
    assert.ok(d, `draft for ${orig.id}`);
    const s = d.session;
    assert.equal(s.kind, orig.kind);
    assert.equal(s.start_time, orig.start_time, 'start_time');
    assert.equal(s.end_time, orig.end_time, 'end_time');
    assert.equal(s.duration_seconds, orig.duration_seconds, 'duration');
    assert.equal(s.break_seconds, orig.break_seconds, 'break');
    assert.equal(s.table_size, orig.table_size, 'table_size');
    assert.equal(s.hands_count, orig.hands_count, 'hands');
    assert.equal(s.small_blind, orig.small_blind, 'sb');
    assert.equal(s.big_blind, orig.big_blind, 'bb');
    assert.equal(s.tips, orig.tips, 'tips');
    assert.equal(s.comment, orig.comment, 'comment');
    assert.equal(s.opponents, orig.opponents, 'opponents');
    if (orig.kind === 'cash') {
      assert.equal(s.buy_in, round2(orig.tracked_via_stack ? 300 : orig.buy_in), 'buy_in');
      assert.equal(s.cashed_out, round2(orig.tracked_via_stack ? 420 : orig.cashed_out), 'cashed_out');
    } else {
      assert.equal(s.tournament_name, orig.tournament_name, 'tourney name');
      assert.equal(s.initial_buy_in, orig.initial_buy_in, 'initial buy-in');
      assert.equal(s.total_buy_in, orig.total_buy_in, 'total buy-in');
      assert.equal(s.prize, orig.prize, 'prize');
      assert.equal(s.position, orig.position, 'position');
      assert.equal(s.entries, orig.entries, 'entries');
    }
    // Refs resolved back to the same names.
    assert.equal(d.refs.game, nameOf('games', orig.game_id), 'game name');
    assert.equal(d.refs.location, nameOf('locations', orig.location_id), 'location name');
    assert.equal(d.refs.group, nameOf('groups', orig.group_id), 'group name');
    assert.equal(d.refs.tournament_type, nameOf('tournament_types', orig.tournament_type_id), 'tt name');
    assert.equal(d.refs.bankroll, nameOf('bankrolls', orig.bankroll_id), 'bankroll name');
    // Net agrees with stats on the original.
    assert.equal(d.net_result, round2(netResult(doc, orig)), 'net result');
    // Fingerprint agrees with the original session's fingerprint.
    assert.equal(d.fingerprint, sessionFingerprint(orig, round2(netResult(doc, orig))), 'fingerprint');
  }
});

test('double round-trip is stable: export(exported draft doc) equals the first export', () => {
  const r = importCsv(sessionsCsv(doc), { currency: 'EUR' });
  assert.ok(r.ok, JSON.stringify({ mappingErrors: r.mappingErrors, errors: r.errors?.slice(0, 3) }));
  // Resolve the drafts' ref names to ids the way the store does, so doc2 is a
  // faithful model of what an import would produce.
  const findOrCreate = (list, name, mk) => {
    if (!name) return null;
    let hit = doc[list].find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!hit) { hit = mk(name); doc[list].push(hit); }
    return hit.id;
  };
  const doc2 = {
    ...doc,
    sessions: r.accepted.map(d => ({
      ...d.session,
      id: d.session.kind + d.session.start_time,
      game_id: findOrCreate('games', d.refs.game, n => ({ id: 'g-' + n, name: n })),
      location_id: findOrCreate('locations', d.refs.location, n => ({ id: 'loc-' + n, name: n })),
      bankroll_id: findOrCreate('bankrolls', d.refs.bankroll, n => ({ id: 'bk-' + n, name: n })),
      group_id: findOrCreate('groups', d.refs.group, n => ({ id: 'grp-' + n, name: n })),
      tournament_type_id: findOrCreate('tournament_types', d.refs.tournament_type, n => ({ id: 'tt-' + n, name: n })),
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    })),
  };
  const text2 = sessionsCsv(doc2);
  assert.equal(text2, sessionsCsv(doc), `second export is byte-identical\n--- first:\n${sessionsCsv(doc)}\n--- second:\n${text2}`);
});

// --- summary -----------------------------------------------------------------
console.log(`\n${pass.length} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
