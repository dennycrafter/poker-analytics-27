// CSV import harness (track E1): RFC 4180 parsing, header detection, mapping
// suggestions, per-row validation, preview summary, duplicate hook and a
// 10k-row smoke test. Offline; runs the real module.
// Usage: node tests/csv-import.test.mjs   (any TZ: expected instants are
// computed in local time, the same rule the importer applies)

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseCsv, detectDelimiter, detectHeader, matchHeader, suggestMapping, validateMapping,
  parseAmount, detectDecimal, parseStakes, parseDuration, parseDateTime, detectDateOrder,
  parseTableSize, parseInteger, parseKind, canonicalGame, parseCurrencyCell, headerCurrency,
  analyzeCsv, buildImport, importCsv, sessionFingerprint, draftNetResult, IMPORT_FIELDS, FIELD_KEYS,
} from '../js/csv-import.js';
import { netResult, endedSessions } from '../js/stats.js';
import { SESSION_COLUMNS } from '../js/cloud-map.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const FIX = fileURLToPath(new URL('./fixtures/csv-import/', import.meta.url));
const fixture = name => fs.readFileSync(FIX + name, 'utf8');
const NOW = Date.parse('2026-10-09T12:00:00Z');
const run = (name, opts = {}) => importCsv(fixture(name), { nowMs: NOW, ...opts });
const local = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).toISOString();
const reasonsAt = (r, line) => r.errors.filter(e => e.line === line).map(e => e.reason);

console.log('Module purity');
test('csv-import.js imports nothing (no store / stats / dom)', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../js/csv-import.js', import.meta.url)), 'utf8');
  assert.ok(!/^\s*import\s/m.test(src), 'found an import statement');
  assert.ok(!/\b(document|window|localStorage|fetch)\b/.test(src.replace(/\/\/.*$/gm, '')), 'touches a browser global');
});

console.log('RFC 4180 parsing');
test('quoted fields: "" escape, embedded comma, embedded newline', () => {
  const { records } = parseCsv('a,b,c\n"x ""y""","1,2","l1\nl2"\nlast,row,here\n');
  assert.deepEqual(records[1].cells, ['x "y"', '1,2', 'l1\nl2']);
  assert.equal(records[1].line, 2);
  assert.equal(records[2].line, 4, 'record after a 2-line field starts on physical line 4');
});
test('CRLF, lone CR and LF endings; CRLF inside quotes normalised to \\n', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n').records.map(r => r.cells), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a,b\r1,2\r3,4').records.map(r => r.cells), [['a', 'b'], ['1', '2'], ['3', '4']]);
  assert.deepEqual(parseCsv('a\r\n"x\r\ny"\r\n').records[1].cells, ['x\ny']);
});
test('UTF-8 BOM is stripped from the first header', () => {
  const { records } = parseCsv('\uFEFFDate,Buy-in\n2026-01-01,20');
  assert.equal(records[0].cells[0], 'Date');
});
test('blank lines and all-empty records are skipped; empty fields kept', () => {
  const { records } = parseCsv('a,b,c\n\n,,\n1,,3\n\n');
  assert.deepEqual(records.map(r => r.cells), [['a', 'b', 'c'], ['1', '', '3']]);
  assert.deepEqual(records.map(r => r.line), [1, 4]);
});
test('trailing empty field after final delimiter', () => {
  assert.deepEqual(parseCsv('a,b,\n').records[0].cells, ['a', 'b', '']);
});
test('unterminated quote and text after a closing quote are flagged, not thrown', () => {
  const r1 = parseCsv('a,b\n1,"open\n2,3');
  assert.match(r1.records[1].error, /Unterminated quoted field \(opened on line 2\)/);
  const r2 = parseCsv('a,b\n"x"y,2\n3,4');
  assert.match(r2.records[1].error, /Unexpected text after a closing quote/);
  assert.deepEqual(r2.records[2].cells, ['3', '4'], 'parser recovers on the next line');
});
test('quote inside an unquoted field is literal (lenient)', () => {
  assert.deepEqual(parseCsv('a,b\n5" stack,2').records[1].cells, ['5" stack', '2']);
});
test('delimiter detection: comma, semicolon, tab, pipe; quoted delimiters ignored', () => {
  assert.equal(detectDelimiter('a,b,c\n1,2,3'), ',');
  assert.equal(detectDelimiter('a;b;c\n1,5;2,5;3'), ';');
  assert.equal(detectDelimiter('a\tb\n1\t2'), '\t');
  assert.equal(detectDelimiter('a|b|c\n1|2|3'), '|');
  assert.equal(detectDelimiter('"x;y;z",b\n"1;2;3",2'), ',');
});
test('parseCsv rejects non-string input loudly', () => {
  assert.throws(() => parseCsv(null), TypeError);
});

console.log('Header detection and mapping suggestions');
test('header detected when cells name fields; not when the first row is data', () => {
  assert.equal(detectHeader(parseCsv('Date,Buy-in\n2026-01-01,20').records), true);
  assert.equal(detectHeader(parseCsv('2026-01-01,20\n2026-01-02,30').records), false);
  assert.equal(detectHeader(parseCsv('Foo,Bar\n2026-01-01,20').records), true, 'unknown words above values');
});
test('header aliases map common tracker spellings', () => {
  const cases = { 'Buy In': 'buy_in', 'BUYIN': 'buy_in', 'Cash-out': 'cashed_out', 'Profit (€)': 'net_result', 'P/L': 'net_result',
    '# Hands': 'hands_count', 'Hands played': 'hands_count', 'Venue': 'location', 'Blinds': 'stakes', 'Total buy-in': 'total_buy_in',
    'Entry fee': 'initial_buy_in', 'Finish': 'position', 'Entrants': 'entries', 'Tournament name': 'tournament_name', 'Notes': 'comment',
    'Start time': 'start_time', 'End date': 'end_time', 'Duration (min)': 'duration', 'Minutes played': 'duration_minutes', 'Game type': 'kind' };
  for (const [h, f] of Object.entries(cases)) assert.equal(matchHeader(h).field, f, h);
});
test('more specific multi-word alias wins ("Total buy-in" is not plain Buy-in)', () => {
  const { mapping } = suggestMapping(['Buy-in', 'Total buy-in', 'Initial buy-in']);
  assert.deepEqual(mapping, ['buy_in', 'total_buy_in', 'initial_buy_in']);
});
test('money headers in big blinds are not mapped as currency', () => {
  assert.equal(matchHeader('Net (BB)').field, null);
  assert.equal(matchHeader('Result in BB').field, null);
  assert.equal(matchHeader('BB').field, 'big_blind', 'a bare BB column is the big blind');
});
test('each field used once; strongest header wins a conflict', () => {
  const { mapping, suggestions } = suggestMapping(['Profit', 'Net result', 'Result']);
  assert.deepEqual(mapping, [null, 'net_result', null], 'canonical name beats a synonym');
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].confidence, 1);
  assert.equal(matchHeader('Profit').score, 0.95);
  assert.deepEqual(suggestMapping(['Profit', 'Winnings']).mapping, ['net_result', 'prize'], 'synonyms still map');
});
test('headerless file: date-time / type / stakes columns sniffed from values', () => {
  const a = analyzeCsv(fixture('no-header.csv'));
  assert.equal(a.hasHeader, false);
  assert.deepEqual(a.mapping, ['start_time', 'end_time', 'kind', 'stakes', null, null]);
  assert.ok(a.suggestions.every(s => s.source === 'values' && s.header === null));
});
test('headerless file imports once the UI supplies the money columns', () => {
  const a = analyzeCsv(fixture('no-header.csv'));
  const mapping = [...a.mapping]; mapping[4] = 'buy_in'; mapping[5] = 'cashed_out';
  const r = buildImport(a, mapping, { nowMs: NOW });
  assert.equal(r.accepted.length, 2);
  assert.equal(r.accepted[0].line, 1, 'no header: first data row is line 1');
  assert.equal(r.accepted[1].session.end_time, local(2026, 7, 3, 1, 0));
  assert.deepEqual(r.accepted.map(d => d.net_result), [30, -30]);
});
test('header-currency hint: "Buy-in (EUR)" and "Profit €"', () => {
  assert.equal(headerCurrency('Buy-in (EUR)'), 'EUR');
  assert.equal(headerCurrency('Profit €'), 'EUR');
  assert.equal(headerCurrency('Profit'), null);
  const r = importCsv('Date,Start,End,Stakes,Buy-in (USD),Cashed out (USD)\n2026-05-01,19:00,22:00,1/2,200,260', { nowMs: NOW });
  assert.equal(r.accepted[0].currency, 'USD');
  assert.equal(r.summary.currency, 'USD');
});

console.log('Mapping validation');
test('missing start, end/duration and buy-in are mapping errors, not row errors', () => {
  const v = validateMapping(['stakes', 'cashed_out']);
  assert.equal(v.ok, false);
  assert.deepEqual(v.errors, ['Map a Start time or Date column.', 'Map an End time or Duration column.', 'Map a Buy-in column.']);
});
test('unknown field, duplicate field, and both duration units are rejected', () => {
  const v = validateMapping(['date', 'date', 'nope', 'duration', 'duration_minutes', 'buy_in']);
  assert.ok(v.errors.some(e => /mapped to more than one column \(1 and 2\)/.test(e)));
  assert.ok(v.errors.some(e => /unknown field "nope"/.test(e)));
  assert.ok(v.errors.some(e => /not both/.test(e)));
});
test('buildImport reports mapping errors and accepts nothing', () => {
  const a = analyzeCsv(fixture('happy.csv'));
  const r = buildImport(a, a.mapping.map(f => (f === 'buy_in' ? null : f)), { nowMs: NOW });
  assert.equal(r.ok, false);
  assert.deepEqual(r.mappingErrors, ['Map a Buy-in column.']);
  assert.equal(r.accepted.length, 0);
});
test('every IMPORT_FIELDS key is unique and labelled', () => {
  assert.equal(new Set(FIELD_KEYS).size, IMPORT_FIELDS.length);
  assert.ok(IMPORT_FIELDS.every(f => f.label && f.aliases.length));
});

console.log('Happy path (happy.csv)');
const happy = run('happy.csv');
test('5 rows accepted, 0 rejected, header mapped column for column', () => {
  assert.equal(happy.ok, true);
  assert.equal(happy.summary.accepted, 5);
  assert.equal(happy.summary.rejected, 0);
  assert.deepEqual(happy.analysis.mapping, ['date', 'start_time', 'end_time', 'kind', 'game', 'stakes', 'buy_in', 'cashed_out', 'tips', 'hands_count', 'table_size', 'location', 'comment']);
});
test('cash draft carries brief Session fields and the past-session invariants', () => {
  const d = happy.accepted[0];
  assert.equal(d.line, 2);
  assert.deepEqual(d.session, {
    kind: 'cash', start_time: local(2026, 4, 4, 19, 30), end_time: local(2026, 4, 4, 22, 53), duration_seconds: 3 * 3600 + 23 * 60,
    break_seconds: 0, table_size: 9, hands_count: 102, hands_count_estimated: false, comment: 'Good table', opponents: null,
    is_live: false, tracked_via_stack: false, small_blind: 0.1, big_blind: 0.2, buy_in: 20, cashed_out: 36.8, tips: 0,
  });
  assert.deepEqual(d.refs, { game: "NL Hold'em", location: 'UCD', bankroll: null, group: null, tournament_type: null });
  assert.equal(d.net_result, 16.8);
});
test('overnight session: end 01:15 after start 20:00 rolls to the next day', () => {
  const d = happy.accepted[1];
  assert.equal(d.session.end_time, local(2026, 4, 8, 1, 15));
  assert.equal(d.net_result, -39.5, '12.5 - 50 - 2 tips');
});
test('MTT in a mixed file: kind + tournament type from the Type column, busted = prize 0', () => {
  const d = happy.accepted[3];
  assert.equal(d.session.kind, 'tournament');
  assert.equal(d.refs.tournament_type, 'MTT');
  assert.equal(d.session.initial_buy_in, 30);
  assert.equal(d.session.total_buy_in, 30);
  assert.equal(d.session.prize, 0);
  assert.equal(d.net_result, -30);
});
test('game spellings canonicalised (NLHE / nl holdem -> NL Hold\'em)', () => {
  assert.deepEqual(happy.summary.games, { "NL Hold'em": 4, PLO: 1 });
});
test('preview summary: counts, kinds, locations, formats, net total, range', () => {
  const s = happy.summary;
  assert.deepEqual(s.kinds, { cash: 4, tournament: 1 });
  assert.deepEqual(s.locations, { UCD: 1, 'Stillo Game': 1, 'Casino Dublin': 2, 'Home Game': 1 });
  assert.deepEqual(s.dateFormats, ['HH:mm', 'YYYY-MM-DD']);
  assert.equal(s.netTotal, 16.8 - 39.5 + 140 - 30 - 20);
  assert.equal(s.firstStart, local(2026, 4, 4, 19, 30));
  assert.equal(s.lastStart, local(2026, 4, 18, 20, 15));
  assert.equal(s.delimiter, ',');
  assert.equal(s.hasHeader, true);
  assert.equal(s.totalRows, 5);
});

console.log('Tournaments (tournaments.csv)');
const tour = run('tournaments.csv');
test('DD/MM dates (19/04 proves day-first), H:MM and "1h 30m" durations', () => {
  assert.equal(tour.summary.accepted, 3);
  assert.equal(tour.summary.dateOrder, 'DMY');
  assert.equal(tour.summary.dateOrderAmbiguous, false);
  assert.equal(tour.accepted[0].session.start_time, local(2026, 4, 12, 14, 0));
  assert.equal(tour.accepted[0].session.duration_seconds, 5.5 * 3600);
  assert.equal(tour.accepted[2].session.duration_seconds, 1.5 * 3600);
});
test('rebuys: net = prize - total buy-in; deep run; SNG from Type column', () => {
  assert.deepEqual(tour.accepted.map(d => d.net_result), [-45, 1190, 15]);
  assert.deepEqual(tour.accepted.map(d => [d.session.position, d.session.entries]), [[41, 120], [2, 180], [2, 9]]);
  assert.equal(tour.accepted[1].session.tournament_name, 'Spring Series Main');
  assert.equal(tour.accepted[2].refs.tournament_type, 'SNG');
  assert.equal(tour.accepted[2].session.total_buy_in, 10, 'missing total defaults to initial');
});

console.log('Quoting edge cases (quoting.csv)');
const quoting = run('quoting.csv');
test('embedded quotes, commas and newlines survive into session fields', () => {
  assert.equal(quoting.accepted[0].session.comment, 'Said "nice hand", then shoved');
  assert.equal(quoting.accepted[1].refs.location, 'UCD, Room 2');
  assert.equal(quoting.accepted[1].session.comment, 'Line one\nline two, with comma');
});
test('thousands separators inside quotes: "1,250.00" / "1,300"', () => {
  assert.equal(quoting.accepted[0].session.buy_in, 1250);
  assert.equal(quoting.accepted[0].session.cashed_out, 1300);
  assert.equal(quoting.summary.decimal, '.');
});
test('line numbers count physical lines across a multi-line field', () => {
  assert.deepEqual(quoting.accepted.map(d => d.line), [2, 3, 6]);
  assert.deepEqual(reasonsAt(quoting, 5), ['Cashed out is missing (map Cashed out or Net result)']);
});

console.log('European export (semicolon, BOM, CRLF, decimal comma)');
const eu = run('eu-semicolon-bom-crlf.csv');
test('semicolon + decimal comma + dotted dates parse correctly', () => {
  assert.equal(eu.summary.delimiter, ';');
  assert.equal(eu.summary.decimal, ',');
  assert.deepEqual(eu.summary.dateFormats, ['DD.MM.YYYY', 'HH:mm']);
  assert.equal(eu.accepted.length, 2);
  assert.deepEqual([eu.accepted[0].session.small_blind, eu.accepted[0].session.big_blind], [0.1, 0.2]);
  assert.equal(eu.accepted[0].session.cashed_out, 36.8);
  assert.equal(eu.accepted[1].session.buy_in, 1250);
  assert.equal(eu.accepted[1].session.cashed_out, 1300.5);
  assert.equal(eu.accepted[0].session.start_time, local(2026, 4, 4, 19, 30));
});

console.log('Malformed rows (malformed.csv)');
const bad = run('malformed.csv');
test('one good row, nine rejections, every one with its line and reason', () => {
  assert.equal(bad.summary.accepted, 1);
  assert.equal(bad.summary.rejected, 9);
  const expected = {
    3: ['Expected 8 columns, found 5'],
    4: ['Buy-in: "abc" is not an amount'],
    5: ['Hands count: "many" is not a whole number'],
    6: ['Table size: Table size must be between 2 and 10'],
    7: ['Expected 8 columns, found 9'],
    8: ['Small blind is bigger than the big blind'],
    9: ['Big blind is missing (map Stakes or Big blind)'],
    10: ['Buy-in cannot be negative'],
    11: ['Unterminated quoted field (opened on line 11)'],
  };
  for (const [line, reasons] of Object.entries(expected)) assert.deepEqual(reasonsAt(bad, Number(line)), reasons, 'line ' + line);
});
test('rejected rows keep their raw cells for the preview', () => {
  const r = bad.rejected.find(x => x.line === 4);
  assert.deepEqual(r.cells, ['2026-05-12', '19:00', '23:00', '0.1/0.2', 'abc', '40', '100', '9']);
});
test('extra empty trailing cells are tolerated (spreadsheet padding)', () => {
  const r = importCsv('Date,Start,End,Stakes,Buy-in,Cashed out\n2026-05-01,19:00,22:00,1/2,200,260,,\n', { nowMs: NOW });
  assert.equal(r.accepted.length, 1);
});
test('a row can carry several reasons at once', () => {
  const r = importCsv('Date,Start,End,Stakes,Buy-in,Cashed out,Hands\n2026-05-01,19:00,22:00,x,abc,-1,1.5\n', { nowMs: NOW });
  assert.deepEqual([...reasonsAt(r, 2)].sort(), [
    'Hands count: "1.5" is not a whole number', 'Buy-in: "abc" is not an amount', 'Cashed out cannot be negative',
    'Stakes "x" are not readable (expected SB/BB, e.g. 0.1/0.2)', 'Big blind is missing (map Stakes or Big blind)',
  ].sort());
});

console.log('Bad dates (bad-dates.csv)');
const dates = run('bad-dates.csv');
test('impossible, unreadable, future and dateless rows rejected with reasons', () => {
  assert.equal(dates.summary.accepted, 1);
  assert.deepEqual(reasonsAt(dates, 2), ['Date: Date "2026-02-30" does not exist']);
  assert.deepEqual(reasonsAt(dates, 3), ['Date: Date "2026-13-01" does not exist']);
  assert.deepEqual(reasonsAt(dates, 4), ['Date: Date "yesterday" is not readable']);
  assert.deepEqual(reasonsAt(dates, 5), ['Start time: Time "25:00" is not valid']);
  assert.deepEqual(reasonsAt(dates, 6), ['End time: Time "19:75" is not valid']);
  assert.deepEqual(reasonsAt(dates, 7), ['Start time is in the future', 'End time is in the future']);
  assert.deepEqual(reasonsAt(dates, 8), ['Start time has no date (map a Date column)']);
});
test('end before start (full date-times) is rejected', () => {
  const r = importCsv('Start,End,Stakes,Buy-in,Cashed out\n2026-05-02 19:00,2026-05-01 23:00,1/2,200,260\n', { nowMs: NOW });
  assert.deepEqual(reasonsAt(r, 2), ['End time is before start time']);
});
test('break longer than the session is rejected; minutes break accepted', () => {
  const r = importCsv('Date,Start,End,Break,Stakes,Buy-in,Cashed out\n2026-05-01,19:00,20:00,90,1/2,200,260\n2026-05-02,19:00,23:00,30,1/2,200,260\n', { nowMs: NOW });
  assert.deepEqual(reasonsAt(r, 2), ['Break is longer than the session']);
  assert.equal(r.accepted[0].session.break_seconds, 1800);
});
test('date-only start gets a 00:00 warning, not a rejection', () => {
  const r = importCsv('Date,Hours,Stakes,Buy-in,Cashed out\n2026-05-01,3,1/2,200,260\n', { nowMs: NOW });
  assert.equal(r.accepted[0].session.start_time, local(2026, 5, 1, 0, 0));
  assert.deepEqual(r.accepted[0].warnings, ['No start time of day; assumed 00:00']);
  assert.equal(r.summary.warnings, 1);
});
test('MM/DD with 12-hour times (net-only.csv): 06/14 proves month-first', () => {
  const r = run('net-only.csv');
  assert.equal(r.summary.dateOrder, 'MDY');
  assert.deepEqual(r.summary.dateFormats, ['MM/DD/YYYY', 'h:mm A']);
  assert.equal(r.accepted[0].session.start_time, local(2026, 6, 14, 19, 30));
  assert.equal(r.accepted[0].session.duration_seconds, 3.5 * 3600);
});
test('ambiguous numeric dates fall back to DMY and say so; MDY can be forced', () => {
  const csv = 'Date,Start,End,Stakes,Buy-in,Cashed out\n04/05/2026,19:00,22:00,1/2,200,260\n';
  const auto = importCsv(csv, { nowMs: NOW });
  assert.equal(auto.summary.dateOrderAmbiguous, true);
  assert.equal(auto.accepted[0].session.start_time, local(2026, 5, 4, 19, 0));
  const forced = importCsv(csv, { nowMs: NOW, dateOrder: 'MDY' });
  assert.equal(forced.accepted[0].session.start_time, local(2026, 4, 5, 19, 0));
  assert.equal(forced.summary.dateOrderAmbiguous, false);
});
test('explicit UTC offset is honoured; zone-less times are local', () => {
  const r = importCsv('Start,End,Stakes,Buy-in,Cashed out\n2026-05-01T19:00:00Z,2026-05-01T23:00:00+01:00,1/2,200,260\n', { nowMs: NOW });
  assert.equal(r.accepted[0].session.start_time, '2026-05-01T19:00:00.000Z');
  assert.equal(r.accepted[0].session.end_time, '2026-05-01T22:00:00.000Z');
  assert.deepEqual(r.summary.dateFormats, ['ISO 8601']);
});
test('detectDateOrder flags a file that contradicts itself', () => {
  const d = detectDateOrder(['13/01/2026', '01/13/2026', '25/02/2026']);
  assert.deepEqual(d, { order: 'DMY', ambiguous: false, conflict: true });
});

console.log('Mixed currencies (mixed-currencies.csv)');
const mixed = run('mixed-currencies.csv');
test('detected currencies counted per row; dominant one becomes the import currency', () => {
  assert.deepEqual(mixed.summary.currencies, { EUR: 4, USD: 2, GBP: 1 });
  assert.equal(mixed.summary.mixedCurrencies, true);
  assert.equal(mixed.summary.currency, 'EUR');
});
test('other-currency rows rejected (no conversion); a row mixing two rejected', () => {
  assert.deepEqual(mixed.accepted.map(d => d.line), [2, 3, 7]);
  assert.deepEqual(reasonsAt(mixed, 4), ['Amounts are in USD but the import currency is EUR (no conversion)']);
  assert.deepEqual(reasonsAt(mixed, 5), ['Amounts are in GBP but the import currency is EUR (no conversion)']);
  assert.deepEqual(reasonsAt(mixed, 6), ['Row mixes currencies (EUR, USD)']);
  assert.ok(mixed.accepted.every(d => d.currency === 'EUR'));
});
test('account currency option overrides the file majority', () => {
  const r = run('mixed-currencies.csv', { currency: 'usd' });
  assert.equal(r.summary.currency, 'USD');
  assert.deepEqual(r.accepted.map(d => d.line), [4]);
});
test('a file with no currency marks inherits the account currency', () => {
  assert.equal(happy.summary.currency, null);
  assert.equal(happy.accepted[0].currency, null);
  assert.equal(run('happy.csv', { currency: 'EUR' }).accepted[0].currency, 'EUR');
});

console.log('Duplicates (duplicates.csv + hook)');
test('in-file duplicate rejected as "Duplicate of line N"', () => {
  const r = run('duplicates.csv');
  assert.deepEqual(r.accepted.map(d => d.line), [2, 3, 5]);
  assert.deepEqual(reasonsAt(r, 4), ['Duplicate of line 2']);
  assert.equal(r.summary.duplicates, 1);
});
test('isDuplicate hook sees each draft; true and string results reject', () => {
  const seen = [];
  const r = run('duplicates.csv', { isDuplicate: d => { seen.push(d.line); return d.line === 3 ? 'Already logged on 11 Jun' : d.line === 5; } });
  assert.deepEqual(seen, [2, 3, 5], 'in-file duplicate never reaches the hook');
  assert.deepEqual(r.accepted.map(d => d.line), [2]);
  assert.deepEqual(reasonsAt(r, 3), ['Already logged on 11 Jun']);
  assert.deepEqual(reasonsAt(r, 5), ['Matches a session you already have']);
  assert.equal(r.summary.duplicates, 3);
});
test('fingerprint of an existing store session (via stats.netResult) matches its draft', () => {
  const d = happy.accepted[0];
  const existing = { id: 'x', ...d.session, game_id: 'g', bankroll_id: 'b' };
  const doc = { sessions: [existing], stack_events: [] };
  const fp = sessionFingerprint(existing, netResult(doc, existing));
  assert.equal(fp, d.fingerprint);
  const known = new Set([fp]);
  const again = run('happy.csv', { isDuplicate: x => known.has(x.fingerprint) });
  assert.deepEqual(again.accepted.map(x => x.line), [3, 4, 5, 6]);
});

console.log('Empty and degenerate files');
test('empty file, blank-only file, header-only file', () => {
  for (const [f, msg] of [['empty.csv', 'The file is empty.'], ['blank-lines.csv', 'The file is empty.'], ['header-only.csv', 'The file has a header but no rows.']]) {
    const r = run(f);
    assert.equal(r.ok, false, f);
    assert.equal(r.fileError, msg, f);
    assert.equal(r.summary.accepted, 0);
    assert.equal(r.summary.rejected, 0);
  }
});
test('null / undefined text behave like an empty file', () => {
  assert.equal(importCsv(undefined).fileError, 'The file is empty.');
  assert.equal(analyzeCsv(null).ok, false);
});
test('maxRows guard', () => {
  const r = importCsv('Date,Hours,Stakes,Buy-in,Cashed out\n2026-05-01,3,1/2,200,260\n2026-05-02,3,1/2,200,260\n', { maxRows: 1 });
  assert.equal(r.fileError, 'The file has 2 rows; the limit is 1.');
});

console.log('Value parsers');
test('parseAmount: symbols, codes, signs, parentheses, thousands, decimal comma', () => {
  const v = (s, d) => parseAmount(s, d);
  assert.deepEqual(v('€1,234.50'), { value: 1234.5, currency: 'EUR' });
  assert.deepEqual(v('EUR 16.8'), { value: 16.8, currency: 'EUR' });
  assert.deepEqual(v('-12'), { value: -12, currency: null });
  assert.deepEqual(v('(12.5)'), { value: -12.5, currency: null });
  assert.deepEqual(v('12-'), { value: -12, currency: null });
  assert.deepEqual(v('−7'), { value: -7, currency: null });
  assert.deepEqual(v('1.234,5', ','), { value: 1234.5, currency: null });
  assert.deepEqual(v('36,8', ','), { value: 36.8, currency: null });
  assert.deepEqual(v('1 300 $'), { value: 1300, currency: 'USD' });
  assert.equal(v(''), null);
  assert.ok(v('12,34,5').error);
  assert.ok(v('1.2.3').error);
  assert.ok(v('€5 $5').error);
  assert.ok(v('ten').error);
});
test('detectDecimal: comma votes, 3-digit groups abstain', () => {
  assert.equal(detectDecimal(['36,8', '20', '1.250,00']), ',');
  assert.equal(detectDecimal(['1,250', '1,300']), '.');
  assert.equal(detectDecimal(['36.8', '1,250.00']), '.');
  assert.equal(detectDecimal(['0,1/0,2']), ',');
});
test('parseStakes: currency, straddle, decimal comma, garbage', () => {
  assert.deepEqual(parseStakes('€0.25/€0.5'), { small_blind: 0.25, big_blind: 0.5, currency: 'EUR', straddle: false });
  assert.deepEqual(parseStakes('$1/$2 NL'), { small_blind: 1, big_blind: 2, currency: 'USD', straddle: false });
  assert.deepEqual(parseStakes('1/2/5'), { small_blind: 1, big_blind: 2, currency: null, straddle: true });
  assert.deepEqual(parseStakes('0,5/1', ','), { small_blind: 0.5, big_blind: 1, currency: null, straddle: false });
  assert.ok(parseStakes('NL200').error);
});
test('parseDuration: H:MM, H:MM:SS, h/m words, decimals, minutes unit', () => {
  assert.equal(parseDuration('3:23'), 3 * 3600 + 23 * 60);
  assert.equal(parseDuration('3:23:10'), 3 * 3600 + 23 * 60 + 10);
  assert.equal(parseDuration('3h 20m'), 3 * 3600 + 20 * 60);
  assert.equal(parseDuration('200 min'), 200 * 60);
  assert.equal(parseDuration('3.5h'), 3.5 * 3600);
  assert.equal(parseDuration('3,5'), 3.5 * 3600);
  assert.equal(parseDuration('45', 'minutes'), 45 * 60);
  assert.ok(parseDuration('3:75').error);
  assert.ok(parseDuration('-2').error);
  assert.ok(parseDuration('long').error);
});
test('parseDateTime: named months, weekday prefix, 12h clock, 2-digit year', () => {
  const p = s => { const r = parseDateTime(s); return [r.y, r.m, r.d, r.h, r.mi]; };
  assert.deepEqual(p('4 Apr 2026'), [2026, 4, 4, 0, 0]);
  assert.deepEqual(p('April 4th, 2026 9:30 PM'), [2026, 4, 4, 21, 30]);
  assert.deepEqual(p('Sat, 4 Apr 2026 21:30'), [2026, 4, 4, 21, 30]);
  assert.deepEqual(p('04/04/26 12:05 am'), [2026, 4, 4, 0, 5]);
  assert.deepEqual(p('2026-04-04 21:30:15'), [2026, 4, 4, 21, 30]);
  assert.equal(parseDateTime('2026-02-29').error, 'Date "2026-02-29" does not exist');
  assert.equal(parseDateTime('2028-02-29').d, 29, 'leap year');
  assert.ok(parseDateTime('13:00 PM').error);
});
test('table size, integers, kinds, games, currency cells', () => {
  assert.equal(parseTableSize('6-max'), 6);
  assert.equal(parseTableSize('HU'), 2);
  assert.equal(parseTableSize('9 handed'), 9);
  assert.ok(parseTableSize('1').error);
  assert.ok(parseTableSize('full ring').error);
  assert.equal(parseInteger('1,234'), 1234);
  assert.equal(parseInteger('120.0'), 120);
  assert.ok(parseInteger('1.5').error);
  assert.ok(parseInteger('12,34').error);
  assert.deepEqual(parseKind('Sit & Go'), { kind: 'tournament', tournamentType: 'SNG' });
  assert.deepEqual(parseKind('Ring game'), { kind: 'cash', tournamentType: null });
  assert.equal(parseKind('bingo'), null);
  assert.equal(canonicalGame('Pot Limit Omaha'), 'PLO');
  assert.equal(canonicalGame('  Short   Deck '), 'Short Deck');
  assert.equal(parseCurrencyCell('€'), 'EUR');
  assert.equal(parseCurrencyCell('chf'), 'CHF');
  assert.ok(parseCurrencyCell('euros').error);
});
test('net-result-only cash rows derive cashed_out; loss beyond buy-in rejected', () => {
  const r = run('net-only.csv');
  assert.deepEqual(r.accepted.map(d => [d.session.cashed_out, d.net_result]), [[115, -85], [510, 310]]);
  assert.deepEqual(reasonsAt(r, 4), ['Net result loses more than the buy-in']);
});
test('cashed out and net both given but disagreeing: amounts win, warning raised', () => {
  const r = importCsv('Date,Start,End,Stakes,Buy-in,Cashed out,Profit\n2026-05-01,19:00,22:00,1/2,200,260,50\n', { nowMs: NOW });
  assert.equal(r.accepted[0].net_result, 60);
  assert.deepEqual(r.accepted[0].warnings, ['Net result does not match cashed out - buy-in - tips; used the amounts']);
});
test('type inferred from filled columns when no Session type column exists', () => {
  const r = importCsv('Date,Start,End,Buy-in,Prize,Stakes,Cashed out\n2026-05-01,19:00,22:00,50,120,,\n2026-05-02,19:00,22:00,200,,1/2,260\n2026-05-03,19:00,22:00,30,,,\n', { nowMs: NOW });
  assert.equal(r.accepted[0].session.kind, 'tournament');
  assert.equal(r.accepted[1].session.kind, 'cash');
  assert.deepEqual(reasonsAt(r, 4), ['Cannot tell whether this is a cash game or a tournament (map a Session type column)']);
  const withDefault = importCsv('Date,Start,End,Buy-in,Prize\n2026-05-03,19:00,22:00,30,\n', { nowMs: NOW, defaultKind: 'tournament' });
  assert.equal(withDefault.accepted[0].session.kind, 'tournament');
});

console.log('Wiring contract (store will consume drafts unchanged)');
test('every draft session key is a real session column', () => {
  const allowed = new Set(SESSION_COLUMNS);
  for (const d of [...happy.accepted, ...tour.accepted]) {
    for (const k of Object.keys(d.session)) assert.ok(allowed.has(k), `unknown session key ${k}`);
  }
});
test('stats.netResult on the drafts (ids added) equals draft.net_result', () => {
  const sessions = [...happy.accepted, ...tour.accepted, ...eu.accepted].map((d, i) => ({ id: 's' + i, game_id: 'g', bankroll_id: 'b', ...d.session }));
  const doc = { sessions, stack_events: [] };
  assert.equal(endedSessions(doc).length, sessions.length, 'drafts are ended sessions');
  sessions.forEach((s, i) => {
    const d = [...happy.accepted, ...tour.accepted, ...eu.accepted][i];
    assert.ok(Math.abs(netResult(doc, s) - d.net_result) < 1e-9, `line ${d.line}`);
    assert.ok(Math.abs(draftNetResult(s) - d.net_result) < 1e-9);
  });
});
test('result is JSON-serialisable (can be handed to a worker or saved)', () => {
  const r = run('happy.csv');
  const back = JSON.parse(JSON.stringify({ accepted: r.accepted, errors: r.errors, summary: r.summary, mapping: r.analysis.mapping }));
  assert.deepEqual(back.accepted, r.accepted);
});

console.log('Huge-file smoke test');
test('10,000 rows (cash + tournaments, quoted comments) analysed and validated under 2s', () => {
  const lines = ['Date,Start,End,Type,Game,Stakes,Buy-in,Cashed out,Prize,Hands,Table size,Location,Comment'];
  const base = Date.UTC(2023, 0, 1); // 10k x 3h ends mid-2026, before NOW
  for (let i = 0; i < 10000; i++) {
    const day = new Date(base + i * 3 * 3600e3);
    const ds = day.toISOString().slice(0, 10), h = String(day.getUTCHours()).padStart(2, '0');
    const end = String((day.getUTCHours() + 2) % 24).padStart(2, '0');
    if (i % 5 === 4) lines.push(`${ds},${h}:00,${end}:30,MTT,NL Hold'em,,${20 + (i % 3) * 10},,${i % 7 === 0 ? 150 : 0},,9,UCD,"MTT #${i}, ok"`);
    else lines.push(`${ds},${h}:00,${end}:30,Cash,NLHE,0.25/0.5,50,${(i * 37) % 160},,${60 + (i % 90)},${6 + (i % 4)}-max,Stillo Game,"row ${i}\nsecond line"`);
  }
  const text = lines.join('\r\n');
  const t0 = performance.now();
  const r = importCsv(text, { nowMs: NOW });
  const ms = performance.now() - t0;
  console.log(`       (10k rows in ${ms.toFixed(0)} ms)`);
  assert.equal(r.summary.totalRows, 10000);
  assert.equal(r.summary.accepted, 10000, JSON.stringify(r.errors.slice(0, 3)));
  assert.deepEqual(r.summary.kinds, { cash: 8000, tournament: 2000 });
  assert.ok(ms < 2000, `took ${ms} ms`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
