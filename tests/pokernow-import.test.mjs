// PokerNow import verification harness. Runs the real pure module against
// synthetic fixtures built from the real export formats (docs/pokernow-format.md).
// Usage: node tests/pokernow-import.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  importPokerNow, parseCsv, detectPokerNowFormat, tableIdFromFileName, parseTimestamp,
  parsePokerNowLedger, parsePokerNowLog, logSegments, mapVariant, groupPokerNowFiles,
} from '../js/pokernow-import.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pokernow');
const read = rel => readFileSync(join(DIR, rel), 'utf8');
const file = (rel, name = rel.split('/').pop()) => ({ name, text: read(rel) });
const NOW = '2026-10-01T00:00:00Z';
const run = (files, cfg = {}) => importPokerNow(files, { now: NOW, ...cfg });
const codes = r => r.warnings.map(w => w.code);
const HOME = () => [file('ledger_pglPa27Home01.csv'), file('poker_now_log_pglPa27Home01.csv')];
const ME_ID = 'Qv7mPa27Dn';

// --- format layer -------------------------------------------------------------

test('parseCsv handles quotes, doubled quotes, embedded newlines and a BOM', () => {
  const rows = parseCsv('\uFEFFa,b\r\n"x, ""y""","line1\nline2"\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, "y"', 'line1\nline2']]);
});

test('detects ledger vs log vs unknown from the header', () => {
  assert.equal(detectPokerNowFormat(read('ledger_pglPa27Home01.csv')), 'ledger');
  assert.equal(detectPokerNowFormat(read('poker_now_log_pglPa27Home01.csv')), 'log');
  assert.equal(detectPokerNowFormat(read('edge/log_no_at.csv')), 'unknown');
  assert.equal(detectPokerNowFormat('date,profit\n2026-01-01,5\n'), 'unknown');
});

test('table id comes from PokerNow file names, including browser " (1)" copies', () => {
  assert.equal(tableIdFromFileName('ledger_pglPa27Home01.csv'), 'pglPa27Home01');
  assert.equal(tableIdFromFileName('poker_now_log_pglPa27Home01 (1).csv'), 'pglPa27Home01');
  assert.equal(tableIdFromFileName('export.csv'), null);
});

test('variant names map to app game names', () => {
  assert.equal(mapVariant("No Limit Texas Hold'em"), "NL Hold'em");
  assert.equal(mapVariant('Pot Limit Omaha Hi'), 'PLO');
  assert.equal(mapVariant('Pot Limit Omaha 5 Hi'), 'PLO5');
  assert.equal(mapVariant('Some New Game'), 'Some New Game');
  assert.equal(mapVariant(''), null);
});

test('ledger parser keeps raw units (cents) and flags open seats', () => {
  const l = parsePokerNowLedger(read('ledger_pglPa27Home01.csv'));
  assert.equal(l.errors.length, 0);
  assert.equal(l.rows.length, 8);
  const me = l.rows.find(r => r.player_id === ME_ID);
  assert.equal(me.buy_in, 10000);
  assert.equal(me.buy_out, 11750);
  assert.equal(me.open, false);
  const theoOpen = l.rows.find(r => r.player_id === 'Th3oXk91aZ' && r.start_ms != null);
  assert.equal(theoOpen.open, true);
  const theoPre = l.rows.find(r => r.player_id === 'Th3oXk91aZ' && r.start_ms == null);
  assert.equal(theoPre.open, false, 'pre-game seat: blank start but has an end');
});

test('log parser: hands, blinds, exporter, id change; ledger chips reconcile to zero', () => {
  const text = read('poker_now_log_pglPa27Home01.csv');
  const log = parsePokerNowLog(text);
  assert.equal(log.errors.length, 0);
  assert.equal(log.hands.length, (text.match(/-- starting hand #/g) || []).length);
  assert.equal(log.hands.length, 129);
  assert.equal(log.exporter_id, ME_ID);
  assert.equal(log.canon('tmpMara0x1'), 'MaraAuth7Q');
  assert.equal(log.hands[0].bb, 0.5);
  const l = parsePokerNowLedger(read('ledger_pglPa27Home01.csv'));
  const total = l.rows.reduce((t, r) => t + r.buy_out + r.stack - r.buy_in, 0);
  assert.equal(total, 0, 'fixture conserves chips');
});

test('log segments rebuild join, admin top-up, stand-up break and quit', () => {
  const log = parsePokerNowLog(read('poker_now_log_pglPa27Home01.csv'));
  const segs = logSegments(log, ME_ID);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].buy_in, 100);   // 50 join + 50 admin update
  assert.equal(segs[0].buy_out, 117.5);
  assert.equal(segs[0].breaks.length, 1);
});

test('groupPokerNowFiles pairs ledger+log by game id and keeps tables apart', () => {
  const g = groupPokerNowFiles([...HOME(), file('ledger_pglPa27Online2.csv'), file('poker_now_log_pglPa27Online2.csv')]);
  assert.equal(g.tables.length, 2);
  for (const t of g.tables) { assert.ok(t.ledgerText); assert.ok(t.logText); }
});

// --- full realistic sample: cash-out present --------------------------------------

test('full home game (ledger + log): closed session with every field mapped', () => {
  const r = run(HOME(), { me: 'Denis' });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(codes(r), []);
  assert.equal(r.sessions.length, 1);
  const { session: s, stack_events, source } = r.sessions[0];
  assert.equal(s.kind, 'cash');
  assert.equal(s.game_name, "NL Hold'em");
  assert.equal(s.small_blind, 0.25);
  assert.equal(s.big_blind, 0.5);
  assert.equal(s.buy_in, 100);               // ledger 10000 cents
  assert.equal(s.cashed_out, 117.5);         // ledger 11750 cents
  assert.equal(s.cashed_out - s.buy_in, 17.5); // equals ledger net 1750 cents
  assert.equal(s.start_time, '2026-09-10T18:00:04.003Z');
  assert.equal(s.end_time, '2026-09-10T21:35:43.275Z');
  assert.equal(s.duration_seconds, 12939);   // 3:35:39.272
  assert.equal(s.break_seconds, 735);        // stand up 19:41:38.084 → sit back 19:53:53.133
  // Hands = "Your hand is" lines, since the exporter is "me".
  assert.equal(s.hands_count, (read('poker_now_log_pglPa27Home01.csv').match(/Your hand is/g) || []).length);
  assert.equal(s.hands_count, 113);
  assert.equal(s.hands_count_estimated, false);
  assert.equal(s.table_size, 6);
  assert.equal(s.is_live, false);
  assert.equal(s.tracked_via_stack, false);
  assert.equal(s.tips, 0);
  assert.deepEqual(stack_events, []);        // after-the-fact sessions carry no stack events
  assert.equal(source.money_from, 'ledger');
  assert.equal(source.import_key, `pokernow:pglPa27Home01:${ME_ID}:2026-09-10T18:00:04.003Z`);
  assert.ok(s.opponents.includes('Rook') && !s.opponents.includes('Denis'));
});

test('re-import yields the same import_key (dedupe handle for the store)', () => {
  const a = run(HOME(), { me: 'Denis' }).sessions[0].source.import_key;
  const b = run(HOME().reverse(), { me: 'denis' }).sessions[0].source.import_key;
  assert.equal(a, b);
});

test('no "me" given: falls back to the account that exported the log', () => {
  const r = run(HOME());
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.tables[0].me, { ids: [ME_ID], via: 'log_exporter' });
  assert.ok(codes(r).includes('me_inferred'));
});

test('log only: same money, times within the log/ledger stamp skew', () => {
  const r = run([file('poker_now_log_pglPa27Home01.csv')], { me: 'Denis' });
  const s = r.sessions[0].session;
  assert.equal(r.sessions[0].source.money_from, 'log');
  assert.equal(s.buy_in, 100);
  assert.equal(s.cashed_out, 117.5);
  assert.equal(s.start_time, '2026-09-10T18:00:04.000Z');
  assert.equal(s.duration_seconds, 12939);
});

test('ledger only: unit cannot be calibrated, so chips are assumed and flagged', () => {
  const r = run([file('ledger_pglPa27Home01.csv')], { me: 'Denis' });
  const s = r.sessions[0].session;
  assert.equal(s.buy_in, 10000);
  assert.ok(codes(r).includes('ledger_unit_assumed'));
  assert.ok(codes(r).includes('stakes_unknown'));
  assert.equal(s.big_blind, null);
  const c = run([file('ledger_pglPa27Home01.csv')], { me: 'Denis', ledgerUnit: 'cents', defaults: { small_blind: 0.25, big_blind: 0.5, game_name: "NL Hold'em" } });
  assert.equal(c.sessions[0].session.buy_in, 100);
  assert.equal(c.sessions[0].session.big_blind, 0.5);
  assert.ok(!codes(c).includes('ledger_unit_assumed'));
});

test('chipValue converts chips to currency', () => {
  const s = run(HOME(), { me: 'Denis', chipValue: 0.1 }).sessions[0].session;
  assert.equal(s.buy_in, 10);
  assert.equal(s.cashed_out, 11.75);
  assert.equal(s.big_blind, 0.05);
});

test('identity by player_id survives an "authenticated login" id change', () => {
  const r = run(HOME(), { me: 'tmpMara0x1' });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.tables[0].me, { ids: ['MaraAuth7Q'], via: 'player_id' });
  assert.equal(r.sessions[0].session.buy_in, 50);
  assert.equal(r.sessions[0].session.cashed_out, 32);
});

// --- cash-out absent: open seats ---------------------------------------------------

test('mid-game export: open seat becomes a live session driven by stack events', () => {
  const r = run([file('live/ledger_pglPa27Home01.csv'), file('live/poker_now_log_pglPa27Home01.csv')], { me: 'Denis' });
  assert.equal(r.status, 'ok');
  const { session: s, stack_events, source } = r.sessions[0];
  assert.equal(s.is_live, true);
  assert.equal(s.tracked_via_stack, true);
  assert.equal(s.end_time, null);
  assert.equal(s.duration_seconds, null);
  assert.equal(s.buy_in, null);       // brief: derived from stack events on live sessions
  assert.equal(s.cashed_out, null);
  assert.deepEqual(stack_events, [
    { kind: 'buy_in', amount: 50, occurred_at: '2026-09-10T18:00:04.003Z' },
    { kind: 'top_up', amount: 50, occurred_at: '2026-09-10T19:11:01.516Z' },
  ]);
  assert.equal(source.current_stack, 93.75);   // ledger stack 9375 cents
  assert.equal(s.break_seconds, 735);           // completed stand-up banked
});

test('openSeats "close" ends the open seat at the last log line, stack = cash-out', () => {
  const r = run([file('live/ledger_pglPa27Home01.csv'), file('live/poker_now_log_pglPa27Home01.csv')], { me: 'Denis', openSeats: 'close' });
  const s = r.sessions[0].session;
  assert.equal(s.is_live, false);
  assert.equal(s.buy_in, 100);
  assert.equal(s.cashed_out, 93.75);
  assert.ok(Date.parse(s.end_time) > Date.parse(s.start_time));
  const x = run([file('live/ledger_pglPa27Home01.csv')], { me: 'Denis', openSeats: 'close', ledgerUnit: 'cents', exportedAt: '2026-09-10T20:05:00Z' });
  assert.equal(x.sessions[0].session.end_time, '2026-09-10T20:05:00.000Z');
});

test('quit and rejoin: two seats fold into one live session (buy-in, cash-out, top-up)', () => {
  const r = run(HOME(), { me: 'Kasia' });
  const { session: s, stack_events, source } = r.sessions[0];
  assert.equal(s.is_live, true);
  assert.equal(source.segments, 2);
  assert.deepEqual(stack_events.map(e => [e.kind, e.amount]), [['buy_in', 50], ['cash_out', 18], ['top_up', 40]]);
  assert.equal(source.current_stack, 29.25);
  assert.ok(s.break_seconds > 0, 'gap between seats is break time');
});

test('pre-game seat with blank session_start_at is timed from the admin approval', () => {
  const r = run(HOME(), { me: 'Theo' });
  const { session: s, stack_events } = r.sessions[0];
  assert.equal(s.start_time, '2026-09-10T17:51:05.500Z');
  assert.deepEqual(stack_events.map(e => e.kind), ['buy_in', 'cash_out', 'top_up']);
  assert.ok(!codes(r).includes('ledger_log_mismatch'));
});

// --- duplicate names ("me" twice at one table) -------------------------------------

test('"me" twice at one table: ledger alone is ambiguous and lists both candidates', () => {
  const r = run([file('ledger_pglPa27DupName.csv')], { me: 'Denis' });
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.sessions.length, 0);
  const c = r.tables[0].candidates;
  assert.deepEqual(c.map(x => x.player_id).sort(), ['Qv7mPa27Dn', 'dNs2xOther']);
  assert.deepEqual(c.map(x => x.ledger_net).sort((a, b) => a - b), [-300, 390]);
  assert.ok(codes(r).includes('ambiguous_me'));
});

test('"me" twice at one table: the log exporter breaks the tie', () => {
  const r = run([file('ledger_pglPa27DupName.csv'), file('poker_now_log_pglPa27DupName.csv')], { me: 'Denis' });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.tables[0].me, { ids: [ME_ID], via: 'log_exporter' });
  const s = r.sessions[0].session;
  assert.equal(s.buy_in, 20);
  assert.equal(s.cashed_out, 17);
  assert.ok(s.opponents.split(', ').includes('Denis'), 'the other Denis is an opponent');
  assert.ok(codes(r).includes('me_resolved_by_log'));
});

test('"me" twice at one table: explicit player_id pins it; merge sums both seats', () => {
  const pinned = run([file('ledger_pglPa27DupName.csv')], { me: 'dNs2xOther', ledgerUnit: 'cents' });
  assert.equal(pinned.sessions[0].session.cashed_out, 23.9);
  const merged = run([file('ledger_pglPa27DupName.csv')], { me: 'Denis', duplicateNames: 'merge', ledgerUnit: 'cents' });
  assert.equal(merged.status, 'ok');
  assert.equal(merged.sessions[0].session.buy_in, 40);
  assert.equal(merged.sessions[0].session.cashed_out, 40.9);
  assert.ok(codes(merged).includes('concurrent_seats'));
});

test('"me" not at the table', () => {
  const r = run(HOME(), { me: 'Nobody' });
  assert.equal(r.status, 'not_found');
  assert.ok(codes(r).includes('me_not_found'));
});

// --- multi-table ------------------------------------------------------------------

test('two overlapping tables stay two sessions, each with its own stakes', () => {
  const r = run([...HOME(), file('ledger_pglPa27Online2.csv'), file('poker_now_log_pglPa27Online2.csv')], { me: 'Denis' });
  assert.equal(r.status, 'ok');
  assert.equal(r.sessions.length, 2);
  const [home, online] = r.sessions;
  assert.equal(home.source.table_id, 'pglPa27Home01');
  assert.equal(online.source.table_id, 'pglPa27Online2');
  assert.equal(online.session.big_blind, 20);         // integer-chip table: ledger in chips
  assert.equal(online.session.buy_in, 2000);
  assert.equal(online.session.cashed_out, 2600);
  assert.equal(online.session.table_size, 3);
  assert.ok(codes(r).includes('overlapping_tables'));
});

test('same table uploaded twice is flagged, not double-imported', () => {
  const r = run([...HOME(), file('ledger_pglPa27Home01.csv', 'ledger_pglPa27Home01 (1).csv')], { me: 'Denis' });
  assert.equal(r.sessions.length, 1);
  assert.ok(codes(r).includes('duplicate_table'));
});

// --- missing columns / bad data -----------------------------------------------------

test('missing player_id column is a hard error', () => {
  const r = run([file('edge/ledger_no_player_id.csv')], { me: 'Denis' });
  assert.equal(r.status, 'invalid');
  assert.equal(r.errors[0].code, 'missing_column');
  assert.deepEqual(r.errors[0].columns, ['player_id']);
});

test('missing time columns: error alone, recovered when the log is supplied', () => {
  const alone = run([file('edge/ledger_no_times.csv')], { me: 'Denis' });
  assert.equal(alone.status, 'invalid');
  assert.ok(alone.errors.some(e => e.code === 'missing_time'));
  assert.ok(codes(alone).includes('missing_column'));
  const withLog = run([file('edge/ledger_no_times.csv', 'ledger_pglPa27Home01.csv'), file('poker_now_log_pglPa27Home01.csv')], { me: 'Denis' });
  assert.equal(withLog.status, 'ok');
  const s = withLog.sessions[0].session;
  assert.equal(s.buy_in, 100);
  assert.equal(s.cashed_out, 117.5);
  assert.equal(s.duration_seconds, 12939);
});

test('missing buy_out and stack: cash-out recovered from net', () => {
  const r = run([file('edge/ledger_net_only.csv')], { me: 'Denis', ledgerUnit: 'cents' });
  assert.equal(r.status, 'ok');
  assert.equal(r.sessions[0].session.buy_in, 100);
  assert.equal(r.sessions[0].session.cashed_out, 117.5);
});

test('unreadable money cell is reported with its row; net column mismatch warns', () => {
  const bad = run([file('edge/ledger_bad_value.csv')], { me: 'Denis' });
  assert.equal(bad.status, 'invalid');
  assert.equal(bad.errors[0].code, 'bad_value');
  assert.equal(bad.errors[0].row, 2);
  const mm = run([file('edge/ledger_net_mismatch.csv')], { me: 'Denis' });
  assert.equal(mm.status, 'ok');
  assert.ok(codes(mm).includes('net_mismatch'));
  assert.equal(mm.sessions[0].session.cashed_out, 2600);   // components win over net
});

test('unknown file and bad input are errors, never throws', () => {
  assert.equal(run([file('edge/log_no_at.csv')]).status, 'invalid');
  assert.equal(run([{ name: 'x.csv' }]).errors[0].code, 'bad_input');
  assert.equal(run([{ name: 'ledger_x.csv', text: '' }]).status, 'invalid');
  assert.equal(run(HOME(), { chipValue: 0 }).errors[0].code, 'bad_config');
});

// --- timezones ----------------------------------------------------------------------

test('PokerNow UTC "Z" stamps are kept as UTC', () => {
  assert.deepEqual(parseTimestamp('2026-09-10T18:00:04.003Z'), { ms: Date.parse('2026-09-10T18:00:04.003Z'), naive: false });
});

test('explicit offsets are honoured (session across midnight and a DST night)', () => {
  const r = run([file('edge/ledger_offset.csv')], { me: 'Denis' });
  const s = r.sessions[0].session;
  assert.equal(s.start_time, '2026-03-28T22:30:00.000Z');
  assert.equal(s.end_time, '2026-03-29T02:30:00.000Z');
  assert.equal(s.duration_seconds, 4 * 3600);
  assert.ok(!codes(r).includes('naive_timestamp'));
});

test('spreadsheet-mangled naive times read in the configured zone, DMY order', () => {
  const dublin = run([file('edge/ledger_spreadsheet_dmy.csv')], { me: 'Denis', timeZone: 'Europe/Dublin', dateOrder: 'DMY' });
  assert.equal(dublin.status, 'ok');
  assert.equal(dublin.sessions[0].session.start_time, '2026-09-10T18:00:00.000Z'); // 19:00 IST
  assert.ok(codes(dublin).includes('naive_timestamp'));
  const la = run([file('edge/ledger_spreadsheet_dmy.csv')], { me: 'Denis', timeZone: 'America/Los_Angeles', dateOrder: 'DMY' });
  assert.equal(la.sessions[0].session.start_time, '2026-09-11T02:00:00.000Z');    // 19:00 PDT
});

test('wrong date order puts the session in the future and is blocked', () => {
  const r = run([file('edge/ledger_spreadsheet_dmy.csv')], { me: 'Denis' }); // MDY → 9 Oct 19:00
  assert.equal(r.status, 'invalid');
  assert.ok(r.errors.some(e => e.code === 'future_start'));
});

test('unknown timeZone is rejected; DST-aware zone conversion', () => {
  assert.equal(run(HOME(), { timeZone: 'Mars/Olympus' }).errors[0].code, 'bad_config');
  // Dublin: GMT in winter, IST (UTC+1) in summer.
  assert.equal(parseTimestamp('2026-01-15 20:00', { timeZone: 'Europe/Dublin' }).ms, Date.parse('2026-01-15T20:00:00Z'));
  assert.equal(parseTimestamp('2026-07-15 20:00', { timeZone: 'Europe/Dublin' }).ms, Date.parse('2026-07-15T19:00:00Z'));
  // Day > 12 settles day/month order regardless of config.
  assert.equal(parseTimestamp('25/12/2026 10:00').ms, Date.parse('2026-12-25T10:00:00Z'));
  assert.equal(parseTimestamp('13/13/2026 10:00'), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
