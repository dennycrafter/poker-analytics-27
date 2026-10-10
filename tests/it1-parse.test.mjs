// Smart import parsers (iteration 1, parse lane): BankrollCoach cash template
// fixtures, format detection, pasted-text notes, generic-table mapping
// passthrough, tournament tables, delegation to the existing importers and
// XLSX extraction through the vendored SheetJS reader. Offline; runs the
// real modules.
// Usage: TZ=UTC node tests/it1-parse.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  detectFormat, parseBankrollCoachRows, parsePastedText, parseGenericTable,
  parsePa27Export, parsePokernowFiles, parseXlsx, BANKROLLCOACH_HEADERS,
} from '../js/import-smart.js';
import { importCsv } from '../js/csv-import.js';
import { importPokerNow } from '../js/pokernow-import.js';
import { XLSX } from '../js/vendor/xlsx.full.min.js';
import { SESSION_CSV_HEADERS } from '../js/csv-export.js';

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};
const asyncTests = [];
const testAsync = (name, fn) => asyncTests.push([name, fn]);

const NOW = Date.parse('2026-10-10T12:00:00Z');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sample = name => fs.readFileSync(ROOT + 'samples/' + name, 'utf8');

// One valid row of PA27's own export shape (all 26 columns; csv-import
// enforces the exact count).
function pa27ExportText() {
  const row = ['Cash', '2026-10-01 19:00', '2026-10-01 22:00', '3:00:00', '', "NL Hold'em", '1/2', '200', '340', '140', '0', '', '', 'Casino Royale'];
  while (row.length < SESSION_CSV_HEADERS.length) row.push('');
  return SESSION_CSV_HEADERS.join(',') + '\n' + row.join(',') + '\n';
}

// The EXACT BankrollCoach fixture rows from the brief (section 1.2).
const BC_ROWS = [
  ['2025-08-12', '6', '', '2000', '3400', '', 'Bellagio', '5/10/20 PLO', '20'],
  ['2025-08-18', '4.75', '', '800', '950', '', 'Commerce', '2/5 NLH', '30'],
  ['2025-08-22', '', '490', '', '', '-1100', 'Aria', '10/25/50 PLO straddle', '18'],
];
const BC_HEADERS = ['date', 'hours', 'minutes', 'buyin', 'cashout', 'result', 'location', 'game', 'hph'];
const bc = () => parseBankrollCoachRows(BC_ROWS);
const draftAt = (r, i) => r.accepted[i];

console.log('Module purity');
test('import-smart.js imports only the two importer modules and csv-export (no store / dom / stats)', () => {
  const src = fs.readFileSync(ROOT + 'js/import-smart.js', 'utf8');
  const code = src.replace(/\/\/.*$/gm, '');
  const statics = [...code.matchAll(/import[^'"]*?from\s*'([^']+)'/g)].map(m => m[1]).sort();
  assert.deepEqual(statics, ['./csv-export.js', './csv-import.js', './pokernow-import.js']);
  assert.ok(code.includes("import('./vendor/xlsx.full.min.js')"), 'lazy xlsx reader import missing');
  assert.ok(!/\b(document|window|localStorage|navigator|fetch)\b/.test(code), 'touches a browser global');
});

console.log('BankrollCoach fixture (brief section 1.2)');
test('row 1: hours, buy-in and cash-out, straddle stakes', () => {
  const r = bc();
  assert.equal(r.summary.accepted, 3, JSON.stringify(r.errors));
  const d = draftAt(r, 0);
  assert.equal(d.net_result, 1400);
  assert.equal(d.session.duration_seconds, 6 * 3600);
  assert.equal(d.session.big_blind, 10);
  assert.equal(d.session.small_blind, 5);
  assert.equal(d.refs.game, 'PLO');
  assert.equal(d.session.hands_count, 120);
  assert.equal(d.session.buy_in, 2000);
  assert.equal(d.session.cashed_out, 3400);
  assert.equal(d.refs.location, 'Bellagio');
  assert.equal(d.session.start_time, '2025-08-12T00:00:00.000Z');
  assert.equal(d.session.end_time, '2025-08-12T06:00:00.000Z');
  assert.ok(d.warnings.some(w => w.includes('straddle')));
});
test('row 2: fractional hours, 142.5 hands rounds to 143', () => {
  const d = draftAt(bc(), 1);
  assert.equal(d.net_result, 150);
  assert.equal(d.session.duration_seconds, 4 * 3600 + 45 * 60, '4h45m');
  assert.equal(d.session.big_blind, 5);
  assert.equal(d.session.small_blind, 2);
  assert.equal(d.refs.game, "NL Hold'em");
  assert.equal(d.session.hands_count, 143);
});
test('row 3: minutes fallback (490 min), result only (profit), straddle word ignored', () => {
  const d = draftAt(bc(), 2);
  assert.equal(d.net_result, -1100);
  assert.equal(d.session.duration_seconds, 8 * 3600 + 10 * 60, '8h10m');
  assert.equal(d.session.big_blind, 25, 'BB is always the second number');
  assert.equal(d.session.small_blind, 10);
  assert.equal(d.refs.game, 'PLO');
  assert.equal(d.session.hands_count, 147);
  // Profit-only: buy-in 0 + cash-out result keeps the read-time net math right.
  assert.equal(d.session.buy_in, 0);
  assert.equal(d.session.cashed_out, -1100);
  assert.ok(d.warnings.some(w => w.includes('No buy-in or cash-out')));
  assert.equal(d.session.kind, 'cash');
});
test('summary totals and fingerprints', () => {
  const r = bc();
  assert.equal(r.summary.totalRows, 3);
  assert.equal(r.summary.netTotal, 450);
  for (const d of r.accepted) assert.match(d.fingerprint, /^cash\|/);
  assert.deepEqual(r.errors, []);
});

console.log('BankrollCoach edge cases');
test('a leading header row is tolerated', () => {
  const r = parseBankrollCoachRows([BC_HEADERS, ...BC_ROWS]);
  assert.equal(r.summary.accepted, 3);
  assert.equal(r.accepted[0].line, 2, 'line numbers keep the header position');
});
test('result with buy-in but no cash-out derives the cash-out', () => {
  const r = parseBankrollCoachRows([['2025-08-12', '2', '', '200', '', '+140', 'Lodge', '2/5 NLH', '']]);
  assert.equal(r.summary.accepted, 1, JSON.stringify(r.errors));
  assert.equal(r.accepted[0].session.cashed_out, 340);
  assert.equal(r.accepted[0].net_result, 140);
});
test('result and amounts that disagree: amounts win with a warning', () => {
  const r = parseBankrollCoachRows([['2025-08-12', '2', '', '200', '340', '999', 'Lodge', '2/5 NLH', '']]);
  assert.equal(r.summary.accepted, 1);
  assert.equal(r.accepted[0].net_result, 140);
  assert.ok(r.accepted[0].warnings.some(w => w.includes('does not match')));
});
test('rejections: mixed currency, negative buy-in, missing duration, game without stakes', () => {
  const r = parseBankrollCoachRows([
    ['2025-08-12', '2', '', '$200', '€340', '', 'X', '2/5 NLH', ''],
    ['2025-08-12', '2', '', '-50', '340', '', 'X', '2/5 NLH', ''],
    ['2025-08-12', '', '', '200', '340', '', 'X', '2/5 NLH', ''],
    ['2025-08-12', '2', '', '200', '340', '', 'X', 'PLO', ''],
  ]);
  assert.equal(r.summary.rejected, 4);
  assert.ok(r.rejected[0].reasons[0].includes('currencies'));
  assert.ok(r.rejected[1].reasons[0].includes('Buy-in cannot be negative'));
  assert.ok(r.rejected[2].reasons[0].includes('Hours or minutes is missing'));
  assert.ok(r.rejected[3].reasons[0].includes('must hold stakes'));
});
test('blank filler rows are skipped, currency from the cells is kept', () => {
  const r = parseBankrollCoachRows([
    ['2025-08-12', '2', '', '$200', '$340', '', 'Lodge', '2/5 NLH', ''],
    ['', '', '', '', '', '', '', '', ''],
    ['2025-08-13', '1', '', '100', '90', '', 'Lodge', '1/2 NLH', ''],
  ]);
  assert.equal(r.summary.accepted, 2);
  assert.equal(r.summary.rejected, 0);
  assert.equal(r.accepted[0].currency, 'USD');
  assert.equal(r.accepted[1].net_result, -10);
});

console.log('Detection');
test('BankrollCoach by text, by headers+rows, case-insensitive, header left inside rows', () => {
  const text = BC_HEADERS.join(',') + '\n' + BC_ROWS.map(r => r.join(',')).join('\n');
  assert.equal(detectFormat({ text }).kind, 'bankrollcoach');
  const loud = detectFormat({ text: text.toUpperCase() });
  assert.equal(loud.kind, 'bankrollcoach');
  const split = detectFormat({ headers: BC_HEADERS, rows: BC_ROWS });
  assert.equal(split.kind, 'bankrollcoach');
  const embedded = detectFormat({ rows: [BC_HEADERS, ...BC_ROWS] });
  assert.equal(embedded.kind, 'bankrollcoach');
  assert.deepEqual(embedded.rows, BC_ROWS, 'header row stripped from rows');
  assert.deepEqual(BANKROLLCOACH_HEADERS, BC_HEADERS);
});
test('PA27 export detected; tracker sample and messy headers stay generic', () => {
  const det = detectFormat({ text: pa27ExportText() });
  assert.equal(det.kind, 'pa27-export');
  assert.equal(detectFormat({ text: sample('tracker-sessions.csv') }).kind, 'generic-table');
  const messy = 'Date Played,Stake,Won/Lost,Duration (h:mm)\n05/09/2026,1/2,+340,5:30\n';
  assert.equal(detectFormat({ text: messy }).kind, 'generic-table');
});
test('PokerNow ledger and log detected with their format', () => {
  const ledger = detectFormat({ text: sample('pokernow-ledger.csv') });
  assert.equal(ledger.kind, 'pokernow');
  assert.equal(ledger.pokernowFormat, 'ledger');
  const log = detectFormat({ text: sample('pokernow-log.csv') });
  assert.equal(log.kind, 'pokernow');
  assert.equal(log.pokernowFormat, 'log');
});
test('free text and unknown', () => {
  assert.equal(detectFormat({ text: 'Oct 3 1/2 at Lodge +340 5h' }).kind, 'free-text');
  assert.equal(detectFormat({ text: '' }).kind, 'unknown');
  assert.equal(detectFormat({}).kind, 'unknown');
});

console.log('Pasted text');
test('the brief example line: "Oct 3 1/2 at Lodge +340 5h"', () => {
  const { sessions, unresolved } = parsePastedText('Oct 3 1/2 at Lodge +340 5h', { nowMs: NOW });
  assert.equal(unresolved.length, 0, JSON.stringify(unresolved));
  const d = sessions[0];
  assert.equal(d.session.start_time, '2026-10-03T00:00:00.000Z');
  assert.equal(d.session.end_time, '2026-10-03T05:00:00.000Z');
  assert.equal(d.session.duration_seconds, 5 * 3600);
  assert.equal(d.session.small_blind, 1);
  assert.equal(d.session.big_blind, 2);
  assert.equal(d.net_result, 340);
  assert.equal(d.session.buy_in, 0, 'profit-only convention');
  assert.equal(d.session.cashed_out, 340);
  assert.equal(d.refs.location, 'Lodge');
  assert.ok(d.warnings.some(w => w.includes('assumed 2026')));
});
test('explicit year, future month-day falls back a year, $-prefixed negatives', () => {
  const a = parsePastedText('Oct 3 2025 1/2 at Lodge +340 5h', { nowMs: NOW }).sessions[0];
  assert.equal(a.session.start_time, '2025-10-03T00:00:00.000Z');
  assert.ok(!a.warnings.some(w => w.includes('assumed')));
  const b = parsePastedText('Dec 3 at Lodge +100 2h', { nowMs: NOW }).sessions[0];
  assert.equal(b.session.start_time, '2025-12-03T00:00:00.000Z', 'Dec 3 is ahead of Oct 10, so last year');
  assert.ok(b.warnings.some(w => w.includes('assumed 2025')));
  const c = parsePastedText('Oct 3 5h $-40', { nowMs: NOW }).sessions[0];
  assert.equal(c.net_result, -40);
  assert.equal(c.currency, 'USD');
  const d = parsePastedText('Oct 3 1/2 at Lodge - $40 5h', { nowMs: NOW }).sessions[0];
  assert.equal(d.net_result, -40);
  assert.equal(d.refs.location, 'Lodge');
});
test('durations: 4:45, 90m, 5h30, 2 hours 30', () => {
  const secs = line => parsePastedText('Oct 3 1/2 at Lodge +10 ' + line, { nowMs: NOW }).sessions[0].session.duration_seconds;
  assert.equal(secs('4:45'), 4 * 3600 + 45 * 60);
  assert.equal(secs('90m'), 5400);
  assert.equal(secs('5h30'), 5 * 3600 + 30 * 60);
  assert.equal(secs('2 hours 30'), 2 * 3600 + 30 * 60);
  const pm = parsePastedText('Oct 3 started 5:30pm', { nowMs: NOW });
  assert.equal(pm.sessions.length, 0, 'am/pm is a time of day, not a duration');
  assert.equal(pm.unresolved[0].reason, 'No stakes, result or duration found after the date');
});
test('unresolved lines come back with a reason and a physical line number', () => {
  const { sessions, unresolved } = parsePastedText([
    'Oct 3 1/2 at Lodge +340 5h',
    'hello world',
    '',
    'Oct 3 at Lodge',
  ].join('\n'), { nowMs: NOW });
  assert.equal(sessions.length, 1);
  assert.equal(unresolved.length, 2);
  assert.equal(unresolved[0].line, 2);
  assert.ok(unresolved[0].reason.includes('No date'));
  assert.equal(unresolved[1].line, 4);
  assert.ok(unresolved[1].reason.includes('No stakes, result or duration'));
});
test('unreadable leftovers flag a warning but the session survives', () => {
  const { sessions } = parsePastedText('Oct 3 1/2 at Lodge +340 5h vs villains', { nowMs: NOW });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].net_result, 340);
  assert.ok(sessions[0].warnings.some(w => w.includes('vs villains')));
});
test('multi-line batch: stakes without a result stores 0 with a warning', () => {
  const { sessions } = parsePastedText('Oct 5 2/5 -75 90m\nOct 6 1/2 3h', { nowMs: NOW });
  assert.equal(sessions[0].net_result, -75);
  assert.equal(sessions[0].session.duration_seconds, 5400);
  assert.equal(sessions[1].net_result, 0);
  assert.ok(sessions[1].warnings.some(w => w.includes('No result found')));
  assert.equal(sessions[1].session.big_blind, 2);
});

console.log('Generic tables and tournaments');
test('messy headers map to the right fields', () => {
  const messy = 'Date Played,Stake,Won/Lost,Duration (h:mm)\n05/09/2026,1/2,+340,5:30\n';
  const det = detectFormat({ text: messy });
  const gen = parseGenericTable(det.headers, det.rows);
  assert.equal(gen.kind, 'generic-table');
  assert.deepEqual(gen.mapping, ['date', 'stakes', 'net_result', 'duration']);
  assert.ok(gen.suggestions.every(s => s.confidence >= 0.5));
});
test('tournament list: buy-in, entries, place, prize map and import', () => {
  const csv = [
    'Date,Tournament,Buy In,Entries,Place,Prize,Duration (h:mm)',
    '05/09/2026,Friday Nighter,150,40,3,500,5:30',
    '06/09/2026,Weekend Deepstack,200,88,27,,6',
  ].join('\n');
  const det = detectFormat({ text: csv });
  assert.equal(det.kind, 'generic-table');
  const gen = parseGenericTable(det.headers, det.rows);
  assert.deepEqual(gen.mapping, ['date', 'tournament_name', 'buy_in', 'entries', 'position', 'prize', 'duration']);
  const r = importCsv(csv);
  assert.equal(r.summary.accepted, 2, JSON.stringify(r.rejected));
  const [a, b] = r.accepted;
  assert.equal(a.session.kind, 'tournament');
  assert.equal(a.session.total_buy_in, 150);
  assert.equal(a.session.entries, 40);
  assert.equal(a.session.position, 3);
  assert.equal(a.session.prize, 500);
  assert.equal(a.net_result, 350);
  assert.equal(b.net_result, -200, 'a missed cash is prize 0 minus the buy-in');
  assert.equal(b.session.position, 27);
});

console.log('Delegation to the existing importers');
test('parsePa27Export is csv-import round-trip, not a reimplementation', () => {
  const text = pa27ExportText();
  assert.deepEqual(parsePa27Export(text, { nowMs: NOW }), importCsv(text, { nowMs: NOW }));
  const r = parsePa27Export(text, { nowMs: NOW });
  assert.equal(r.summary.accepted, 1, JSON.stringify(r.rejected));
  assert.equal(r.accepted[0].net_result, 140);
});
test('parsePokernowFiles hands files straight to importPokerNow', () => {
  const files = [{ name: 'pokernow-ledger.csv', text: sample('pokernow-ledger.csv') }];
  assert.deepEqual(parsePokernowFiles(files, {}), importPokerNow(files, {}));
});

console.log('XLSX through the vendored reader');
testAsync('first sheet becomes headers + rows; date cells keep their calendar day', async () => {
  const aoa = [
    ['Date', 'Hours', 'Minutes', 'Buyin', 'Cashout', 'Result', 'Location', 'Game', 'Hph'],
    [new Date(2025, 7, 12), 6, '', 2000, 3400, '', 'Bellagio', '5/10/20 PLO', 20],
    ['2025-08-18', 4.75, '', 800, 950, '', 'Commerce', '2/5 NLH', 30],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa, { cellDates: true }), 'Sessions');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['ignored']]), 'Notes');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const res = await parseXlsx(new Uint8Array(buf));
  assert.equal(res.kind, 'xlsx');
  assert.equal(res.hasHeader, true);
  assert.deepEqual(res.headers, ['Date', 'Hours', 'Minutes', 'Buyin', 'Cashout', 'Result', 'Location', 'Game', 'Hph']);
  assert.equal(res.rows[0][0], '2025-08-12', 'a Date cell renders its local calendar day');
  assert.equal(res.rows[0][1], '6');
  assert.equal(res.rows[1][0], '2025-08-18');
  const r = parseBankrollCoachRows(res.rows);
  assert.equal(r.summary.accepted, 2, JSON.stringify(r.errors));
  assert.equal(r.accepted[0].net_result, 1400);
  assert.equal(r.accepted[0].session.hands_count, 120);
  assert.equal(r.accepted[1].session.hands_count, 143);
});
testAsync('a corrupt spreadsheet reports xlsx-error instead of throwing', async () => {
  // Zip magic followed by garbage makes SheetJS throw; plain garbage parses
  // as an empty workbook, so use the input that actually exercises the catch.
  const res = await parseXlsx(new Uint8Array([0x50, 0x4B, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]));
  assert.equal(res.kind, 'xlsx-error');
  assert.ok(res.message.length > 0);
  assert.ok(!res.message.includes('\u2014'), 'no em dashes in user-facing text');
});

for (const [name, fn] of asyncTests) {
  try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
