// Import AI client harness (IT1 lane, brief section 1.3): request builders,
// server reply classification, manual mapping shape, mapping -> drafts for the
// messy-CSV fixture, recorded AI row replies (pasted text, tournament list),
// the 300-row per-run split, and confidence flagging. Fully offline: every AI
// reply is a recorded fixture, no network anywhere.
// Usage: TZ=UTC node tests/it1-ai.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../js/csv-import.js';
import {
  IMPORT_AI_URL, MAX_TABLE_SAMPLE_ROWS, MAX_AI_ROWS_PER_RUN, NEEDS_CHECK_THRESHOLD, MAPPING_ROLES,
  buildTableRequest, textToSessions, imageToSessions, interpretAiResponse,
  manualMappingShape, normalizeMapping, applyMapping, scoreConfidence,
  rowsFromAi, chunkIntoRuns,
  parseAiMoney, parseAiHours, parseAiInt, parseAiStakes, parseAiDate, parseAiKind, canonicalAiGame,
} from '../js/import-ai.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const FIX = fileURLToPath(new URL('./fixtures/import-ai/', import.meta.url));
const fixture = name => fs.readFileSync(FIX + name, 'utf8');
// Naive dates are local time (same rule as csv-import.js); expected instants
// are computed the same way so the suite is TZ-agnostic, TZ=UTC included.
const loc = (y, m, d, hh = 0, mi = 0) => new Date(y, m - 1, d, hh, mi).toISOString();
const NOW = Date.parse('2026-10-10T12:00:00Z');

console.log('Module purity');
test('import-ai.js imports nothing and touches no browser global', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../js/import-ai.js', import.meta.url)), 'utf8');
  assert.ok(!/^\s*import\s/m.test(src), 'found an import statement');
  assert.ok(!/\b(document|window|localStorage|fetch|XMLHttpRequest|WebSocket)\b/.test(src.replace(/\/\/.*$/gm, '')), 'touches a browser global');
});

console.log('Cell parsers');
test('parseAiMoney: symbols, codes, accounting negatives, thousands, decimal comma', () => {
  assert.deepEqual(parseAiMoney('$340'), { value: 340, currency: 'USD' });
  assert.deepEqual(parseAiMoney('USD 340'), { value: 340, currency: 'USD' });
  assert.deepEqual(parseAiMoney('£12.5'), { value: 12.5, currency: 'GBP' });
  assert.deepEqual(parseAiMoney('(65)'), { value: -65, currency: null });
  assert.deepEqual(parseAiMoney('$-300'), { value: -300, currency: 'USD' });
  assert.deepEqual(parseAiMoney('340-'), { value: -340, currency: null });
  assert.deepEqual(parseAiMoney('+80'), { value: 80, currency: null });
  assert.deepEqual(parseAiMoney('1,234.56'), { value: 1234.56, currency: null });
  assert.deepEqual(parseAiMoney('1234,50'), { value: 1234.5, currency: null });
  assert.equal(parseAiMoney(''), null);
  assert.equal(parseAiMoney('  '), null);
  assert.equal(parseAiMoney('n/a'), undefined);
});
test('parseAiHours: decimal, H:MM, 4h45, 290 min, minutes unit for bare numbers', () => {
  assert.equal(parseAiHours('4.75'), 4.75);
  assert.equal(parseAiHours('4:45'), 4.75);
  assert.equal(parseAiHours('8h10'), 8 + 10 / 60);
  assert.equal(parseAiHours('3h30'), 3.5);
  assert.equal(parseAiHours('290 min'), 290 / 60);
  assert.equal(parseAiHours('290', 'minutes'), 290 / 60);
  assert.equal(parseAiHours('290', 'hours'), 290);
  assert.equal(parseAiHours('4,5'), 4.5);
  assert.equal(parseAiHours(''), null);
  assert.equal(parseAiHours('long'), undefined);
});
test('parseAiInt: plain, comma thousands, float rounding, junk', () => {
  assert.equal(parseAiInt('145'), 145);
  assert.equal(parseAiInt('1,200'), 1200);
  assert.equal(parseAiInt('2.5'), 3);
  assert.equal(parseAiInt(''), null);
  assert.equal(parseAiInt('many'), undefined);
});
test('parseAiStakes: BB is always the second number, straddle ignored', () => {
  assert.deepEqual(parseAiStakes('5/10/20 PLO'), { smallBlind: 5, bigBlind: 10, straddle: 20, game: 'PLO' });
  assert.deepEqual(parseAiStakes('2/5 NLH'), { smallBlind: 2, bigBlind: 5, straddle: null, game: "NL Hold'em" });
  assert.deepEqual(parseAiStakes('10/25/50 PLO straddle'), { smallBlind: 10, bigBlind: 25, straddle: 50, game: 'PLO' });
  assert.deepEqual(parseAiStakes('0.5/1'), { smallBlind: 0.5, bigBlind: 1, straddle: null, game: null });
  assert.equal(parseAiStakes(''), null);
});
test('parseAiDate: ISO with zone honoured, naive local, month names, orders', () => {
  assert.equal(parseAiDate('2025-10-03T07:00:00Z').iso, '2025-10-03T07:00:00.000Z');
  assert.equal(parseAiDate('2025-10-03', 'auto', NOW).iso, loc(2025, 10, 3));
  assert.equal(parseAiDate('2025-09-15 19:00', 'auto', NOW).iso, loc(2025, 9, 15, 19, 0));
  assert.equal(parseAiDate('Oct 3, 2025', 'auto', NOW).iso, loc(2025, 10, 3));
  assert.equal(parseAiDate('3 Oct 2025', 'auto', NOW).iso, loc(2025, 10, 3));
  assert.equal(parseAiDate('Oct 3, 2025 7:00 pm', 'auto', NOW).iso, loc(2025, 10, 3, 19, 0));
  assert.equal(parseAiDate('10/3/25', 'mdy', NOW).iso, loc(2025, 10, 3));
  assert.equal(parseAiDate('10/3/25', 'dmy', NOW).iso, loc(2025, 3, 10));
  // 13 cannot be a month: the order settles itself even against the rule.
  assert.equal(parseAiDate('13/4/25', 'mdy', NOW).iso, loc(2025, 4, 13));
  assert.ok(/does not fit the month\/day format/.test(parseAiDate('13/4/25', 'mdy', NOW).warning));
  // Truly ambiguous: auto assumes month/day and says so.
  const amb = parseAiDate('10/3/25', 'auto', NOW);
  assert.equal(amb.iso, loc(2025, 10, 3));
  assert.ok(/ambiguous/.test(amb.warning));
  // Missing year: current year, rolled back when that lands in the future.
  assert.equal(parseAiDate('Oct 3', 'auto', NOW).iso, loc(2026, 10, 3));
  assert.equal(parseAiDate('Nov 20', 'auto', NOW).iso, loc(2025, 11, 20));
  assert.equal(parseAiDate('2025/09/15', 'auto', NOW).iso, loc(2025, 9, 15));
  assert.equal(parseAiDate('', 'auto', NOW), null);
  assert.ok(parseAiDate('gobbledegook', 'auto', NOW).error);
  assert.ok(parseAiDate('2025-02-30', 'auto', NOW).error);
});
test('parseAiKind and canonicalAiGame: canonical names match the app vocabulary', () => {
  assert.equal(parseAiKind('Cash'), 'cash');
  assert.equal(parseAiKind('MTT'), 'tournament');
  assert.equal(parseAiKind('Sit and Go'), 'tournament');
  assert.equal(parseAiKind(''), null);
  assert.equal(canonicalAiGame('Holdem'), "NL Hold'em");
  assert.equal(canonicalAiGame('NLHE'), "NL Hold'em");
  assert.equal(canonicalAiGame('PLO'), 'PLO');
  assert.equal(canonicalAiGame('Omaha Hi-Lo'), 'PLO Hi-Lo');
  assert.equal(canonicalAiGame('Pot Limit Omaha 5'), 'PLO5');
  assert.equal(canonicalAiGame('Weird Home Game'), 'Weird Home Game');
});

console.log('Request builders');
test('buildTableRequest: exact body {kind, headers, rows}, cells stringified', () => {
  assert.deepEqual(
    buildTableRequest(['Date', 'Buy-in'], [['2025-01-01', 20], [null, undefined]]),
    { kind: 'table', headers: ['Date', 'Buy-in'], rows: [['2025-01-01', '20'], ['', '']] },
  );
});
test('buildTableRequest: at most 20 sample rows travel', () => {
  const rows = Array.from({ length: 31 }, (_, i) => [String(i)]);
  const body = buildTableRequest(['A'], rows);
  assert.equal(body.rows.length, MAX_TABLE_SAMPLE_ROWS);
  assert.equal(MAX_TABLE_SAMPLE_ROWS, 20);
  assert.equal(body.rows[19][0], '19');
});
test('buildTableRequest throws on bad input', () => {
  assert.throws(() => buildTableRequest([], []), TypeError);
  assert.throws(() => buildTableRequest('Date', []), TypeError);
  assert.throws(() => buildTableRequest(['A'], 'rows'), TypeError);
  assert.throws(() => buildTableRequest(['A'], ['not-a-row']), TypeError);
});
test('textToSessions and imageToSessions build the paste/screenshot bodies', () => {
  assert.deepEqual(textToSessions('  Oct 3 1/2 at Lodge +340 5h  '), { kind: 'text', content: 'Oct 3 1/2 at Lodge +340 5h' });
  assert.throws(() => textToSessions('   '), TypeError);
  assert.deepEqual(imageToSessions('aGk=', 'image/jpg'), { kind: 'image', base64: 'aGk=', mime: 'image/jpeg' });
  assert.deepEqual(imageToSessions('aGk='), { kind: 'image', base64: 'aGk=', mime: 'image/png' });
  assert.throws(() => imageToSessions(''), TypeError);
  assert.throws(() => imageToSessions('aGk=', 'application/pdf'), TypeError);
  assert.equal(IMPORT_AI_URL, '/api/import-ai');
});

console.log('AI availability passthrough');
test('interpretAiResponse: 200 hands the payload through', () => {
  const r = interpretAiResponse(200, { mapping: { columns: [] } });
  assert.equal(r.ok, true);
  assert.equal(r.aiUnavailable, false);
  assert.deepEqual(r.data, { mapping: { columns: [] } });
});
test('interpretAiResponse: 503 and any other non-200 -> aiUnavailable true', () => {
  for (const status of [400, 401, 404, 500, 503]) {
    const r = interpretAiResponse(status, { error: 'ai_unavailable' });
    assert.equal(r.ok, false, 'status ' + status);
    assert.equal(r.aiUnavailable, true, 'status ' + status);
    assert.equal(r.error, 'ai_unavailable', 'status ' + status);
  }
  const bare = interpretAiResponse(503, null);
  assert.equal(bare.aiUnavailable, true);
  assert.match(bare.error, /HTTP 503/);
});

console.log('Manual mapping shape');
const HEADERS = ['Date Played', 'Stake', 'Won/Lost', 'Duration (h:mm)', 'Location', 'Game', 'Type', 'Entries', 'Place', 'Rebuys', 'Hands'];
test('manualMappingShape suggests roles from messy headers', () => {
  const shape = manualMappingShape(HEADERS);
  assert.deepEqual(shape.columns.map(c => c.suggestedRole), [
    'date', 'stakes', 'profit', 'hours', 'location', 'game', 'type', 'entries', 'finish', 'rebuys', 'hands',
  ]);
  assert.deepEqual(shape.columns.map(c => c.index), HEADERS.map((_, i) => i));
  assert.deepEqual(shape.rules, { dateFormat: 'auto', currency: null, kind: null, hoursUnit: 'hours' });
});
test('manualMappingShape throws on empty or non-array headers', () => {
  assert.throws(() => manualMappingShape([]), TypeError);
  assert.throws(() => manualMappingShape('Date'), TypeError);
});
test('normalizeMapping: role falls back to suggestedRole, junk roles ignore, rules default', () => {
  const norm = normalizeMapping({
    columns: [{ header: 'When', suggestedRole: 'date' }, { index: 5, header: 'X', role: 'nonsense' }, {}],
    confidence: 1.5,
    rules: { dateFormat: 'nonsense', hoursUnit: 'minutes' },
  });
  assert.deepEqual(norm.columns[0], { index: 0, header: 'When', role: 'date' });
  assert.deepEqual(norm.columns[1], { index: 5, header: 'X', role: 'ignore' });
  assert.deepEqual(norm.columns[2], { index: 2, header: '', role: 'ignore' });
  assert.equal(norm.confidence, 1);
  assert.deepEqual(norm.rules, { dateFormat: 'auto', currency: null, kind: null, hoursUnit: 'minutes' });
  assert.throws(() => normalizeMapping({}), TypeError);
});

console.log('Messy CSV through the recorded AI mapping');
const csvText = fixture('messy-headers.csv');
const records = parseCsv(csvText).records;
const messyRows = records.slice(1).map(r => r.cells);
const tableReply = JSON.parse(fixture('messy-mapping-reply.json'));
const mapped = applyMapping(messyRows, tableReply.mapping, { nowMs: NOW });
assert.equal(mapped.length, 5);
test('row 1: profit only, stakes with variant, H:MM duration, hands count', () => {
  const d = mapped[0];
  assert.equal(d.line, 2);
  assert.equal(d.session.kind, 'cash');
  assert.equal(d.session.start_time, loc(2025, 10, 3));
  assert.equal(d.session.duration_seconds, 5.25 * 3600);
  assert.equal(d.session.small_blind, 1);
  assert.equal(d.session.big_blind, 2);
  assert.equal(d.session.buy_in, null);
  assert.equal(d.session.cashed_out, null);
  assert.equal(d.session.hands_count, 145);
  assert.equal(d.session.is_live, false);
  assert.equal(d.session.tracked_via_stack, false);
  assert.deepEqual(d.refs, { game: "NL Hold'em", location: 'Lodge Cash Game', bankroll: null, group: null, tournament_type: null });
  assert.equal(d.currency, 'USD');
  assert.equal(d.net_result, 340);
  assert.deepEqual(d.warnings, []);
  assert.equal(d.confidence, 0.93);
  assert.equal(d.needsCheck, false);
});
test('row 2 and 3: negative profits via $-300 and quoted "(65)"', () => {
  assert.equal(mapped[1].net_result, -300);
  assert.equal(mapped[1].session.duration_seconds, 3.5 * 3600);
  assert.equal(mapped[1].line, 3);
  assert.equal(mapped[2].net_result, -65);
  assert.equal(mapped[2].session.duration_seconds, 6.75 * 3600);
  assert.equal(mapped[2].refs.game, 'PLO');
  assert.equal(mapped[2].line, 4);
});
test('row 4: 13/4/25 contradicts the mdy rule, falls back to day/month with a warning', () => {
  const d = mapped[3];
  assert.equal(d.session.start_time, loc(2025, 4, 13));
  assert.equal(d.session.small_blind, 1);
  assert.equal(d.session.big_blind, 3);
  assert.equal(d.net_result, 120);
  assert.equal(d.session.duration_seconds, 4 * 3600);
  assert.equal(d.warnings.length, 1);
  assert.match(d.warnings[0], /day\/month/);
  assert.equal(d.needsCheck, false, 'one minor warning keeps confidence at 0.81');
});
test('row 5: no amounts at all -> flagged Check this', () => {
  const d = mapped[4];
  assert.equal(d.net_result, null);
  assert.equal(d.session.buy_in, null);
  assert.ok(d.warnings.some(w => /Result is missing/.test(w)));
  assert.equal(d.needsCheck, true);
});
test('hand-built mapping (manual shape) and AI mapping produce identical drafts', () => {
  // The manual screen path: manualMappingShape, the user confirms roles and rules.
  const manual = manualMappingShape(HEADERS);
  manual.rules = { dateFormat: 'mdy', currency: 'USD', kind: 'cash', hoursUnit: 'hours' };
  // The AI path: same columns but with role instead of suggestedRole, plus confidence.
  const ai = {
    columns: manual.columns.map(c => ({ index: c.index, header: c.header, role: c.suggestedRole })),
    confidence: 1,
    rules: manual.rules,
  };
  assert.deepEqual(applyMapping(messyRows, manual, { nowMs: NOW }), applyMapping(messyRows, ai, { nowMs: NOW }));
});
test('rules.hoursUnit minutes: a bare 290 becomes 4h50m', () => {
  const m = { columns: [{ index: 0, header: 'H', role: 'hours' }], rules: { hoursUnit: 'minutes' } };
  const out = applyMapping([['290']], m, { nowMs: NOW });
  assert.equal(out[0].session.duration_seconds, 17400);
});
test('start_time and end_time roles: time-only end rolls over midnight', () => {
  const m = {
    columns: [
      { index: 0, header: 'Date', role: 'date' },
      { index: 1, header: 'Start', role: 'start_time' },
      { index: 2, header: 'End', role: 'end_time' },
    ],
    rules: { dateFormat: 'mdy' },
  };
  const out = applyMapping([['10/3/25', '10:00 pm', '1:30 am']], m, { nowMs: NOW });
  assert.equal(out[0].session.start_time, loc(2025, 10, 3, 22, 0));
  assert.equal(out[0].session.end_time, loc(2025, 10, 4, 1, 30));
});
test('applyMapping guards: empty rows ok, null rows and non-cell rows throw', () => {
  assert.deepEqual(applyMapping([], tableReply.mapping, { nowMs: NOW }), []);
  assert.throws(() => applyMapping(null, tableReply.mapping), TypeError);
  assert.throws(() => applyMapping([['a', 'b'], 'oops'], tableReply.mapping), TypeError);
});

console.log('Pasted text through the recorded AI reply');
const pastedReply = JSON.parse(fixture('pasted-reply.json'));
const pasted = rowsFromAi(pastedReply, { nowMs: NOW });
assert.equal(pasted.length, 4);
test('row 1: full buy-in and cash-out -> profit derived, evening start', () => {
  const d = pasted[0];
  assert.equal(d.line, 1);
  assert.equal(d.session.kind, 'cash');
  assert.equal(d.session.start_time, loc(2025, 10, 3, 19, 0));
  assert.equal(d.session.small_blind, 1);
  assert.equal(d.session.big_blind, 2);
  assert.equal(d.session.buy_in, 300);
  assert.equal(d.session.cashed_out, 640);
  assert.equal(d.session.duration_seconds, 5 * 3600);
  assert.equal(d.net_result, 340);
  assert.equal(d.refs.game, "NL Hold'em");
  assert.equal(d.refs.location, 'Lodge');
  // No currency marker anywhere in the AI row: the draft stays untagged and
  // the UI applies the account default later.
  assert.equal(d.currency, null);
  assert.equal(d.confidence, 0.97);
  assert.equal(d.needsCheck, false);
});
test('row 2: profit only, low AI confidence -> flagged Check this', () => {
  const d = pasted[1];
  assert.equal(d.net_result, -300);
  assert.equal(d.session.duration_seconds, 3.5 * 3600);
  assert.equal(d.session.buy_in, null);
  assert.equal(d.session.cashed_out, null);
  assert.equal(d.confidence, 0.55);
  assert.equal(d.needsCheck, true);
});
test('rows 3 and 4: missing years infer the current year, rolled back when future', () => {
  assert.equal(pasted[2].session.start_time, loc(2026, 10, 3));
  assert.equal(pasted[2].net_result, 80);
  assert.equal(pasted[3].session.start_time, loc(2025, 11, 20));
  assert.equal(pasted[3].net_result, -500);
});
test('rowsFromAi accepts a bare row array too', () => {
  assert.deepEqual(rowsFromAi(pastedReply.rows, { nowMs: NOW }), pasted);
});

console.log('Tournament list through the recorded AI reply');
const tourReply = JSON.parse(fixture('tournament-reply.json'));
const tour = rowsFromAi(tourReply, { nowMs: NOW });
assert.equal(tour.length, 4);
test('row 1: rebuys raise the total buy-in, prize 0, net negative', () => {
  const d = tour[0];
  assert.equal(d.session.kind, 'tournament');
  assert.equal(d.session.start_time, loc(2025, 9, 15, 19, 0));
  assert.equal(d.session.tournament_name, 'Nightly $80');
  assert.equal(d.session.initial_buy_in, 80);
  assert.equal(d.session.total_buy_in, 160);
  assert.equal(d.session.prize, 0);
  assert.equal(d.session.position, 37);
  assert.equal(d.session.entries, 132);
  assert.equal(d.net_result, -160);
  assert.equal(d.refs.tournament_type, 'Tournament');
  assert.equal(d.refs.location, 'Lodge');
  assert.equal(d.needsCheck, false);
});
test('row 2: a podium finish converts cash-out into prize and positive net', () => {
  const d = tour[1];
  assert.equal(d.session.prize, 940);
  assert.equal(d.session.total_buy_in, 80);
  assert.equal(d.session.position, 3);
  assert.equal(d.net_result, 860);
});
test('rows 3 and 4: impossible finish places warn and flag', () => {
  assert.equal(tour[2].net_result, -200);
  assert.ok(tour[2].warnings.some(w => /worse than the number of entries/.test(w)));
  assert.equal(tour[2].needsCheck, true);
  assert.ok(tour[3].warnings.some(w => /worse than the number of entries/.test(w)));
  assert.equal(tour[3].needsCheck, false, 'warning visible but confidence 0.73 stays above the flag');
});

console.log('Per-run split (max 300 rows per run)');
test('MAX_AI_ROWS_PER_RUN is 300 and chunkIntoRuns splits and keeps everything', () => {
  assert.equal(MAX_AI_ROWS_PER_RUN, 300);
  const rows700 = Array.from({ length: 700 }, (_, i) => ({ date: '2025-10-01', stakes: '1/2', profit: 10, hours: 1, confidence: 0.9 }));
  const chunks = chunkIntoRuns(rows700);
  assert.deepEqual(chunks.map(c => c.length), [300, 300, 100]);
  assert.equal(chunks.flat().length, 700);
  assert.deepEqual(chunkIntoRuns([]), []);
  assert.deepEqual(chunkIntoRuns([{ a: 1 }], 5), [[{ a: 1 }]]);
  assert.throws(() => chunkIntoRuns('rows'), TypeError);
  assert.throws(() => chunkIntoRuns([], 0), RangeError);
});
test('rowsFromAi splits a 700-row reply into runs of 300 and concatenates', () => {
  const rows700 = Array.from({ length: 700 }, (_, i) => ({ date: '2025-10-01', stakes: '1/2', profit: 10, hours: 1, confidence: 0.9 }));
  const out = rowsFromAi({ rows: rows700 }, { nowMs: NOW });
  assert.equal(out.length, 700);
  assert.equal(out[0].net_result, 10);
  assert.equal(out[699].net_result, 10);
  assert.equal(out[699].line, 700);
  assert.equal(out.every(d => d.session.kind === 'cash'), true);
});
test('a multi-run reply ({runs}) and a run-object array concatenate identically', () => {
  const mk = i => ({ date: '2025-10-01', stakes: '1/2', profit: i, hours: 1, confidence: 0.9 });
  const a = Array.from({ length: 300 }, (_, i) => mk(i));
  const b = Array.from({ length: 300 }, (_, i) => mk(300 + i));
  const c = Array.from({ length: 100 }, (_, i) => mk(600 + i));
  const merged = rowsFromAi({ rows: [...a, ...b, ...c] }, { nowMs: NOW });
  assert.deepEqual(rowsFromAi({ runs: [{ rows: a }, { rows: b }, { rows: c }] }, { nowMs: NOW }), merged);
  assert.deepEqual(rowsFromAi([{ rows: a }, { rows: b }, { rows: c }], { nowMs: NOW }), merged);
});
test('rowsFromAi rejects replies without rows', () => {
  assert.throws(() => rowsFromAi({}), TypeError);
  assert.throws(() => rowsFromAi(null), TypeError);
  assert.throws(() => rowsFromAi({ runs: [{ nope: 1 }] }), TypeError);
});

console.log('Confidence scoring');
test('a complete cash session scores 1.0 with a confident mapping', () => {
  const s = { kind: 'cash', start_time: loc(2025, 10, 3), duration_seconds: 3600, big_blind: 2, buy_in: 100, cashed_out: 160, net_result: 60 };
  assert.equal(scoreConfidence(s, {}), 1);
  assert.equal(scoreConfidence(s, { confidence: 0.93 }), 0.93);
});
test('penalties push broken sessions under the needsCheck threshold', () => {
  assert.equal(NEEDS_CHECK_THRESHOLD, 0.7);
  const full = { kind: 'cash', start_time: loc(2025, 10, 3), duration_seconds: 3600, big_blind: 2, buy_in: 100, cashed_out: 160, net_result: 60 };
  assert.equal(scoreConfidence({ ...full, start_time: null }, {}), 0.75);
  assert.equal(scoreConfidence({ ...full, start_time: null, duration_seconds: null }, {}), 0.65);
  const noResult = { kind: 'cash', start_time: loc(2025, 10, 3), duration_seconds: 3600, big_blind: 2 };
  assert.equal(scoreConfidence(noResult, {}), 0.65);
  const t = { kind: 'tournament', start_time: loc(2025, 10, 3), duration_seconds: 3600 };
  // missing buy-in -0.3, entries -0.15, finish place -0.05, result -0.1
  assert.equal(scoreConfidence(t, {}), 0.4);
});
test('an unsure mapping (confidence 0.6) flags even a perfect session', () => {
  const s = { kind: 'cash', start_time: loc(2025, 10, 3), duration_seconds: 3600, big_blind: 2, buy_in: 100, cashed_out: 160, net_result: 60 };
  const score = scoreConfidence(s, { confidence: 0.6 });
  assert.equal(score, 0.6);
  assert.equal(score < NEEDS_CHECK_THRESHOLD, true);
});
test('scores never leave 0..1', () => {
  // (1 - 0.25 - 0.1 - 0.1 - 0.35) scaled by the AI's 0.2 mapping confidence.
  assert.equal(scoreConfidence({ kind: 'cash' }, { confidence: 0.2 }), 0.04);
  // Mapping confidence can only drag a score down, never repair a broken one.
  assert.equal(scoreConfidence({ kind: 'cash' }, { confidence: 5 }), 0.2);
  assert.equal(scoreConfidence(null, {}), 0.2);
});
test('MAPPING_ROLES covers the brief vocabulary', () => {
  for (const role of ['date', 'profit', 'buyin', 'cashout', 'hours', 'stakes', 'game', 'location', 'type', 'entries', 'finish', 'rebuys', 'ignore']) {
    assert.ok(MAPPING_ROLES.includes(role), role);
  }
});

console.log('Fixtures are well-formed');
test('every fixture file parses and the CSV lines are consistent', () => {
  for (const name of ['messy-mapping-reply.json', 'pasted-reply.json', 'tournament-reply.json']) {
    assert.deepEqual(JSON.parse(fixture(name)), JSON.parse(fixture(name)), name);
  }
  const rows = parseCsv(csvText).records;
  assert.ok(rows[0].cells.every(h => h.length > 0), 'header row has no empty headers');
  assert.equal(new Set(rows.slice(1).map(r => r.cells.length)).size, 1, 'all data rows share one column count');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
