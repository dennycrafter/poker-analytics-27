// IT1 import UI tests: the pure flow machine in js/import-flow.js.
//
// js/screens/import.js is DOM-only and is exercised by the sibling
// browser QA; here the machine is driven through the same events the screen
// emits, against contract-shaped fakes for js/import-smart.js, js/import-ai.js
// and the store batch API. An XLSX fixture zip is built with node:zlib so the
// embedded reader is tested without any dependency.
//
// Run: TZ=UTC node tests/it1-ui.test.mjs
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  createImportFlow, rowView, summarizePreview, acceptedRows, jsonToTable,
  pa27JsonSessions, xlsxToRows, applyEdit, PREVIEW_RENDER_CAP,
} from '../js/import-flow.js';

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) {
    fail++;
    console.error('  FAIL ' + name + '\n       ' + e.message + '\n       ' + ((e.stack || '').split('\n')[1] || ''));
  }
}

const eq = assert.strictEqual;
const deq = assert.deepEqual;
const ok = assert.ok;

// --- fakes matching the sibling-lane contracts ------------------------------------

const BC_HEADERS = ['date', 'hours', 'minutes', 'buyin', 'cashout', 'result', 'location', 'game', 'hph'];

function makeDeps(over) {
  const calls = { detect: [], bc: [], pasted: [], generic: [], buildTable: [], applyMapping: [], findDup: [], commit: [] };
  const deps = {
    detectFormat({ headers, text } = {}) {
      calls.detect.push({ headers, text });
      const h = (headers || []).map(x => String(x).toLowerCase());
      if (h.join(',') === BC_HEADERS.join(',')) return { format: 'bankrollcoach' };
      if (text && text.includes('poker-analytics-27')) return { format: 'pa27' };
      return null;
    },
    parseBankrollCoachRows(rows) {
      calls.bc.push(rows.length);
      // Mirrors the parse lane's fixture rules at machine-test fidelity.
      return rows.map(r => {
        const hours = r.hours !== '' ? Number(r.hours) : Number(r.minutes) / 60;
        const buyin = r.buyin === '' ? null : Number(r.buyin);
        const cashout = r.cashout === '' ? null : Number(r.cashout);
        const result = r.result === '' ? null : Number(r.result);
        const profit = buyin !== null || cashout !== null
          ? (buyin !== null && cashout !== null ? cashout - buyin : null)
          : result;
        const parts = String(r.game).split(' ');
        const nums = parts.filter(p => /^\d+$/.test(p));
        return {
          kind: 'cash', date: r.date, stakes: r.game, game: parts[parts.length - 1],
          location: r.location, buy_in: buyin, cash_out: cashout, profit,
          hours: String(hours), hands: Math.round(Number(r.hph) * hours),
          confidence: 1,
        };
      });
    },
    parsePastedText(text) {
      calls.pasted.push(text);
      return null;
    },
    parseGenericTable(headers, rows) {
      calls.generic.push(rows.length);
      // Pass-through: the real parser normalizes raw table rows, and the
      // machine routes whatever it returns into applyMapping unchanged.
      return rows.map(r => ({ ...r }));
    },
    buildTableRequest(headers, rows) {
      calls.buildTable.push({ headers, rows });
      return { kind: 'table', headers, rows: rows.slice(0, 20) };
    },
    applyMapping(rows, mapping) {
      calls.applyMapping.push(mapping);
      return rows.map(r => ({
        date: mapping.date === null ? undefined : r[Object.keys(r)[mapping.date]],
        profit: mapping.profit === null ? undefined : r[Object.keys(r)[mapping.profit]],
        hours: mapping.hours === null ? undefined : r[Object.keys(r)[mapping.hours]],
        confidence: undefined,
      }));
    },
    scoreConfidence: () => 0.45,
    rowsFromAi: json => json.rows,
    manualMappingShape: headers => ({
      headers,
      fields: [
        { key: 'type', label: 'Type' }, { key: 'date', label: 'Date' },
        { key: 'profit', label: 'Profit' }, { key: 'hours', label: 'Hours' },
        { key: 'stakes', label: 'Stakes' }, { key: 'game', label: 'Game' },
        { key: 'location', label: 'Location' },
      ],
    }),
    findDuplicates: rows => { calls.findDup.push(rows.length); return []; },
    commit: rows => { calls.commit.push(rows.length); return { batchId: 'batch_test_1' }; },
  };
  // Overrides may be a deps object or a (deps, calls) => deps function.
  const extra = !over ? {} : (typeof over === 'function' ? over(deps, calls) : over);
  return { deps: { ...deps, ...extra }, calls };
}

const BC_SESSIONS = [
  { date: '2025-08-12', hours: '6', minutes: '', buyin: '2000', cashout: '3400', result: '', location: 'Bellagio', game: '5/10/20 PLO', hph: '20' },
  { date: '2025-08-18', hours: '4.75', minutes: '', buyin: '800', cashout: '950', result: '', location: 'Commerce', game: '2/5 NLH', hph: '30' },
  { date: '2025-08-22', hours: '', minutes: '490', buyin: '', cashout: '', result: '-1100', location: 'Aria', game: '10/25/50 PLO straddle', hph: '18' },
];

// --- machine -----------------------------------------------------------------------

await test('known format: instant parse, no AI payload, no commit', async () => {
  const { deps, calls } = makeDeps();
  const flow = createImportFlow(deps);
  const st = flow.handle('SOURCE', { headers: BC_HEADERS, rows: BC_SESSIONS });
  eq(st.phase, 'preview');
  eq(st.format, 'bankrollcoach');
  eq(st.sessions.length, 3);
  eq(calls.buildTable.length, 0);
  eq(calls.commit.length, 0);
  eq(st.previewRows[0].row.profit, 1400);
  eq(st.previewRows[1].row.profit, 150);
  eq(st.previewRows[2].row.profit, -1100);
  eq(st.previewRows[0].row.hands, 120);
  eq(st.previewRows[2].row.hands, 147);
});

await test('generic table routes to the AI path and exposes the payload', async () => {
  const { deps, calls } = makeDeps();
  const flow = createImportFlow(deps);
  const headers = ['Date Played', 'Won/Lost', 'Duration (h:mm)'];
  flow.handle('SOURCE', { headers, rows: [{ 'Date Played': '2025-09-01', 'Won/Lost': '100', 'Duration (h:mm)': '2' }] });
  const st = flow.state;
  eq(st.phase, 'ai');
  eq(st.kind, 'table');
  eq(st.format, 'generic'); // unrecognized table, still routed to AI
  const payload = flow.aiPayload();
  eq(calls.buildTable.length, 1);
  eq(payload.kind, 'table');
  deq(payload.headers, headers);
  eq(payload.rows.length, 1);
  eq(calls.commit.length, 0);
});

await test('AI_RESULT decorates rows and flags low confidence', async () => {
  const { deps } = makeDeps();
  const flow = createImportFlow(deps);
  flow.handle('SOURCE', { headers: ['a', 'b'], rows: [{ a: '1', b: '2' }, { a: '3', b: '4' }] });
  flow.handle('AI_RESULT', { json: { rows: [
    { date: '2025-09-01', profit: '100', hours: '2', confidence: 0.95 },
    { date: '2025-09-02', profit: '-40', hours: '1', confidence: 0.42 },
  ] } });
  const st = flow.state;
  eq(st.phase, 'preview');
  eq(st.previewRows[0].flag, false);
  eq(st.previewRows[1].flag, true);
  ok(st.previewRows[1].labels.includes('Check this'));
  eq(st.previewRows[0].accepted, true);
  // Flagged rows start unticked: the button counts what a commit would write.
  eq(st.previewRows[1].accepted, false);
});

await test('aiUnavailable on a table: manual mapping step, then preview', async () => {
  const { deps, calls } = makeDeps();
  const flow = createImportFlow(deps);
  flow.handle('SOURCE', { headers: ['Date Played', 'Won/Lost', 'Duration (h:mm)'], rows: [
    { 'Date Played': '2025-09-01', 'Won/Lost': '100', 'Duration (h:mm)': '2' },
  ] });
  eq(flow.state.phase, 'ai');
  flow.handle('AI_UNAVAILABLE');
  eq(flow.state.phase, 'manual');
  const shape = flow.state.mappingShape;
  eq(shape.fields.length, 7);
  deq(shape.fields.map(f => f.key), ['type', 'date', 'profit', 'hours', 'stakes', 'game', 'location']);
  flow.handle('MAPPING', { mapping: { date: 0, profit: 1, hours: 2, stakes: null, game: null, location: null, type: null } });
  const st = flow.state;
  eq(st.phase, 'preview');
  eq(calls.applyMapping.length, 1);
  eq(st.previewRows[0].flag, true); // fake scoreConfidence returns 0.45
  ok(st.previewRows[0].labels.includes('Check this'));
  eq(st.previewRows[0].row.date, '2025-09-01');
  eq(st.previewRows[0].row.profit, '100');
});

await test('aiUnavailable on plain text: plain error, nothing written', async () => {
  const { deps, calls } = makeDeps();
  const flow = createImportFlow(deps);
  flow.handle('SOURCE', { text: 'some session notes without a table' });
  eq(flow.state.phase, 'ai');
  eq(flow.state.kind, 'text');
  flow.handle('AI_UNAVAILABLE');
  eq(flow.state.phase, 'error');
  ok(/not available/i.test(flow.state.error));
  eq(calls.commit.length, 0);
});

await test('pasted text: smart parse wins when it returns rows', async () => {
  const { deps, calls } = makeDeps({
    parsePastedText: () => [{ date: '2025-10-03', stakes: '1/2', location: 'Lodge', profit: 340, hours: '5', confidence: 1 }],
  });
  const flow = createImportFlow(deps);
  flow.handle('SOURCE', { text: 'Oct 3 1/2 at Lodge +340 5h' });
  const st = flow.state;
  eq(st.phase, 'preview');
  eq(st.format, 'pasted');
  eq(st.sessions.length, 1);
  eq(st.previewRows[0].row.location, 'Lodge');
  eq(calls.buildTable.length, 0);
  eq(calls.commit.length, 0);
});

await test('image source builds an image payload', async () => {
  const { deps, calls } = makeDeps();
  const flow = createImportFlow(deps);
  flow.handle('SOURCE', { base64: 'QUJD', mime: 'image/png' });
  eq(flow.state.phase, 'ai');
  eq(flow.state.kind, 'image');
  const payload = flow.aiPayload();
  eq(payload.kind, 'image');
  eq(payload.dataBase64, 'QUJD');
  eq(payload.mime, 'image/png');
  eq(calls.commit.length, 0);
});

await test('duplicates: unticked, labeled, counted in the summary', async () => {
  const { deps } = makeDeps({ findDuplicates: rows => (rows.length === 3 ? [1] : []) });
  const flow = createImportFlow(deps);
  flow.handle('SOURCE', { headers: BC_HEADERS, rows: BC_SESSIONS });
  const st = flow.state;
  eq(st.previewRows[0].accepted, true);
  eq(st.previewRows[1].accepted, false);
  eq(st.previewRows[1].duplicate, true);
  ok(st.previewRows[1].labels.includes('Already in your app'));
  const s = summarizePreview(st.previewRows);
  eq(s.text, '2 new, 1 duplicate');
  eq(s.button, 'Import 2 sessions');
});

await test('summary line counts new, duplicates and flagged rows', async () => {
  const { deps } = makeDeps({ findDuplicates: rows => (rows.length === 61 ? [3, 4, 5, 6, 7, 8, 9] : []) });
  const flow = createImportFlow(deps);
  const rows = [];
  for (let i = 0; i < 61; i++) {
    rows.push({ date: `2025-09-${String(1 + (i % 28)).padStart(2, '0')}`, profit: String(i), hours: '2' });
  }
  flow.handle('SOURCE', { headers: ['date', 'profit', 'hours'], rows });
  flow.handle('AI_RESULT', { json: { rows: rows.map((r, i) => ({ ...r, confidence: i < 52 ? 0.9 : (i >= 59 ? 0.3 : 0.9) })) } });
  const s = summarizePreview(flow.state.previewRows);
  eq(s.text, '52 new, 7 duplicates, 2 need a check');
  eq(s.button, 'Import 52 sessions');
});

await test('summary singular forms read naturally', async () => {
  const rows = [
    { date: '2025-09-01', profit: '10', hours: '1', confidence: 0.9 },
    { date: '2025-09-02', profit: '20', hours: '1', confidence: 0.9 },
    { date: '2025-09-03', profit: '30', hours: '1', confidence: 0.3 },
  ];
  const { deps } = makeDeps({ findDuplicates: () => [1] });
  const flow = createImportFlow(deps);
  flow.handle('SOURCE', { headers: ['h'], rows });
  flow.handle('AI_RESULT', { json: { rows } });
  const s = summarizePreview(flow.state.previewRows);
  eq(s.text, '1 new, 1 duplicate, 1 needs a check');
  // Only row 0 is ticked by default (duplicate unticked, flagged row unticked).
  eq(s.button, 'Import 1 session');
});

await test('edits merge into the raw row and clear the flag chip', async () => {
  const { deps } = makeDeps();
  const flow = createImportFlow(deps);
  flow.handle('SOURCE', { headers: ['a'], rows: [{ a: '1' }] });
  flow.handle('AI_RESULT', { json: { rows: [{ date: '2025-09-01', profit: '10', hours: '1', confidence: 0.3 }] } });
  eq(flow.state.previewRows[0].flag, true);
  flow.handle('EDIT_ROW', { index: 0, patch: { profit: '500', location: 'MGM' } });
  const st = flow.state;
  eq(st.phase, 'preview');
  eq(st.previewRows[0].row.profit, '500');
  eq(st.previewRows[0].row.location, 'MGM');
  eq(st.previewRows[0].flag, false);
  ok(!st.previewRows[0].labels.includes('Check this'));
  // Reviewing the flagged row by editing it ticks it for import.
  eq(st.previewRows[0].accepted, true);
  flow.handle('IMPORT');
  // The sync fake commit resolves immediately: no async committing hop.
  eq(flow.state.phase, 'committed');
});

await test('import: exactly the accepted rows commit once, batch id reported', async () => {
  const { deps, calls } = makeDeps({ findDuplicates: rows => (rows.length === 3 ? [1] : []) });
  const flow = createImportFlow(deps);
  flow.handle('SOURCE', { headers: BC_HEADERS, rows: BC_SESSIONS });
  flow.handle('TOGGLE_ROW', { index: 2, accepted: false });
  flow.handle('EDIT_ROW', { index: 0, patch: { profit: '1500' } });
  const st = flow.handle('IMPORT');
  eq(st.phase, 'committed'); // sync fake resolves immediately
  eq(calls.commit.length, 1);
  eq(calls.commit[0], 1); // duplicate unticked, row 3 untoggled off
  eq(st.batchId, 'batch_test_1');
  eq(st.committedCount, 1);
});

await test('nothing is written before Import, and Import cannot double-commit', async () => {
  const { deps, calls } = makeDeps();
  const flow = createImportFlow(deps);
  flow.handle('SOURCE', { headers: BC_HEADERS, rows: BC_SESSIONS });
  flow.handle('EDIT_ROW', { index: 0, patch: { location: 'MGM' } });
  flow.handle('TOGGLE_ROW', { index: 1, accepted: false });
  eq(calls.commit.length, 0);
  eq(flow.state.phase, 'preview');
  flow.handle('IMPORT');
  eq(calls.commit.length, 1);
  flow.handle('IMPORT');
  eq(calls.commit.length, 1); // committed phase ignores IMPORT
  flow.handle('COMMITTED', { batchId: 'b1', count: 2 });
  flow.handle('IMPORT');
  eq(calls.commit.length, 1);
});

await test('import with nothing accepted: no commit, plain message', async () => {
  const { deps, calls } = makeDeps({ findDuplicates: () => [0] });
  const flow = createImportFlow(deps);
  flow.handle('SOURCE', { headers: BC_HEADERS, rows: [BC_SESSIONS[0]] });
  eq(flow.state.previewRows[0].accepted, false);
  const st = flow.handle('IMPORT');
  eq(st.phase, 'preview');
  eq(st.error, 'Nothing to import yet. Tick at least one row.');
  eq(calls.commit.length, 0);
});

await test('commit failure and missing batch id surface a plain error', async () => {
  // A pending promise keeps the machine in 'committing', so COMMIT_FAILED lands.
  const { deps } = makeDeps({ commit: () => new Promise(() => {}) });
  const flow = createImportFlow(deps);
  flow.handle('SOURCE', { headers: BC_HEADERS, rows: BC_SESSIONS });
  flow.handle('IMPORT');
  eq(flow.state.phase, 'committing');
  flow.handle('COMMIT_FAILED');
  eq(flow.state.phase, 'error');

  const flow2 = createImportFlow(makeDeps({ commit: async () => ({ batchId: null }) }).deps);
  flow2.handle('SOURCE', { headers: BC_HEADERS, rows: BC_SESSIONS });
  flow2.handle('IMPORT');
  eq(flow2.state.phase, 'committing');
  const st = flow2.handle('COMMITTED', { batchId: null });
  eq(st.phase, 'error');
});

await test('async commit promise: committing holds until COMMITTED resolves it', async () => {
  let resolveCommit;
  const { deps } = makeDeps({ commit: () => new Promise(res => { resolveCommit = res; }) });
  const flow = createImportFlow(deps);
  flow.handle('SOURCE', { headers: BC_HEADERS, rows: BC_SESSIONS });
  flow.handle('IMPORT');
  eq(flow.state.phase, 'committing');
  resolveCommit({ batchId: 'batch_later' });
  const st = flow.handle('COMMITTED', { batchId: 'batch_later', count: 3 });
  eq(st.phase, 'committed');
  eq(st.batchId, 'batch_later');
});

await test('pa27 JSON export: flagged, converted, previewed without AI', async () => {
  const { deps, calls } = makeDeps();
  const flow = createImportFlow(deps);
  const text = JSON.stringify({
    app: 'poker-analytics-27', format: 1, exported_at: '2025-09-01T00:00:00Z',
    data: { sessions: [
      { id: 's1', kind: 'cash', start_time: '2025-08-12T10:00:00Z' },
      { id: 's2', kind: 'tournament', start_time: '2025-08-13T10:00:00Z' },
    ] },
  });
  flow.handle('SOURCE', { text });
  const st = flow.state;
  eq(st.phase, 'preview');
  eq(st.format, 'pa27');
  eq(st.sessions.length, 2);
  eq(rowView(st.previewRows[0].row).type, 'cash');
  eq(rowView(st.previewRows[1].row).type, 'tournament');
  eq(calls.buildTable.length, 0);
});

await test('PA27 export reimport marks every row a duplicate', async () => {
  const { deps } = makeDeps({ findDuplicates: rows => (rows.length === 2 ? [0, 1] : []) });
  const flow = createImportFlow(deps);
  const text = JSON.stringify({ app: 'poker-analytics-27', format: 1, data: { sessions: [
    { id: 's1', kind: 'cash', start_time: '2025-08-12T10:00:00Z' },
    { id: 's2', kind: 'cash', start_time: '2025-08-13T10:00:00Z' },
  ] } });
  flow.handle('SOURCE', { text });
  const st = flow.state;
  eq(st.previewRows.every(r => r.duplicate && !r.accepted), true);
  const s = summarizePreview(st.previewRows);
  eq(s.button, ''); // nothing to import
});

await test('RESET clears the machine for the next source', async () => {
  const { deps } = makeDeps();
  const flow = createImportFlow(deps);
  flow.handle('SOURCE', { headers: BC_HEADERS, rows: BC_SESSIONS });
  flow.handle('RESET');
  const st = flow.state;
  eq(st.phase, 'empty');
  eq(st.sessions.length, 0);
  eq(st.previewRows.length, 0);
});

await test('unknown events and out-of-phase events are no-ops', async () => {
  const { deps, calls } = makeDeps();
  const flow = createImportFlow(deps);
  const before = flow.state;
  const st = flow.handle('NOT_A_REAL_EVENT', {});
  eq(st, before);
  flow.handle('EDIT_ROW', { index: 0, patch: { profit: '5' } });
  flow.handle('AI_RESULT', { json: { rows: [] } });
  flow.handle('MAPPING', { mapping: {} });
  eq(flow.state.phase, 'empty');
  eq(calls.commit.length, 0);
});

await test('pa27JsonSessions: flat session arrays convert, nested docs unwrap', async () => {
  const flat = pa27JsonSessions('[{"id":"a","kind":"cash"},{"id":"b","kind":"cash"}]');
  eq(flat.length, 2);
  const nested = pa27JsonSessions(JSON.stringify({ data: { sessions: [{ id: 'c', kind: 'cash' }] } }));
  eq(nested.length, 1);
  eq(pa27JsonSessions('{"not":"sessions"}'), null);
  eq(pa27JsonSessions('nonsense'), null);
  eq(pa27JsonSessions('["a string","not objects"]'), null);
});

await test('jsonToTable: arrays of objects become tables, everything else is null', async () => {
  const t = jsonToTable('[{"date":"2025-09-01","won":"10"},{"date":"2025-09-02","won":"-5"}]');
  deq(t.headers, ['date', 'won']);
  eq(t.rows.length, 2);
  eq(jsonToTable('{"a":1}'), null);
  eq(jsonToTable('[1,2,3]'), null);
  eq(jsonToTable('[{"a":{"x":1}}]'), null);
  eq(jsonToTable('nope'), null);
  const holes = jsonToTable('[{"a":"1"},{"b":"2"}]');
  deq(holes.headers, ['a', 'b']);
  eq(holes.rows[0].b, '');
  eq(holes.rows[1].a, '');
});

await test('applyEdit writes canonical fields and mirrors stored aliases', async () => {
  const mirrored = applyEdit({ start_time: 'x', kind: 'cash' }, 'date', 'y');
  eq(mirrored.start_time, 'y');
  eq(mirrored.date, 'y');
  eq(mirrored.kind, 'cash');
  const plain = applyEdit({ hours: 5 }, 'hours', '6');
  // Preview edits stay string-shaped; the commit lane coerces numbers.
  eq(plain.hours, '6');
  eq(plain.start_time, undefined);
  const tournament = applyEdit({ finish_place: 3 }, 'finish_place', '7');
  eq(tournament.finish_place, '7');
});

await test('rowView shapes preview fields, including durations and hands', async () => {
  const v = rowView({ kind: 'tournament', start_time: '2025-08-12T10:00:00Z', duration_seconds: 18000, hands_count: 120, location_name: 'Aria' });
  eq(v.type, 'tournament');
  eq(v.date, '2025-08-12T10:00:00Z');
  eq(v.hours, '5');
  eq(v.hands, '120');
  eq(v.location, 'Aria');
  const empty = rowView(null);
  eq(empty.type, 'cash');
  eq(empty.hours, '');
});

// --- xlsx reader ---------------------------------------------------------------------

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipEntry(name, data, offset, deflate) {
  const comp = deflate ? deflateRawSync(data) : data;
  const method = deflate ? 8 : 0;
  const nameBuf = Buffer.from(name);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(offset, 42);
  // Local entry = header + name + the actual (compressed) data.
  return { local: Buffer.concat([local, nameBuf, comp]), central: Buffer.concat([central, nameBuf]) };
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const { local, central } = zipEntry(e.name, e.data, offset, e.deflate);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centrals.reduce((n, c) => n + c.length, 0), 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

const XLSX_CONTENT_TYPES = Buffer.from(
  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
const XLSX_WORKBOOK = Buffer.from(
  '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"></workbook>');
const XLSX_STRINGS = Buffer.from(
  '<?xml version="1.0"?><sst><si><t>Date</t></si><si><t>Profit</t></si><si><t>Stakes</t></si>' +
  '<si><t>2025-08-12</t></si><si><t>2025-08-14</t></si></sst>');
const XLSX_SHEET = Buffer.from(
  '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
  '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
  '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>340</v></c><c r="C2" t="inlineStr"><is><t>NLH</t></is></c></row>' +
  '<row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3"><v>-12.5</v></c><c r="C3"><v>2</v></c></row>' +
  '</sheetData></worksheet>');

await test('xlsxToRows reads shared strings, inline strings and numbers', async () => {
  const zip = buildZip([
    { name: '[Content_Types].xml', data: XLSX_CONTENT_TYPES },
    { name: 'xl/workbook.xml', data: XLSX_WORKBOOK },
    { name: 'xl/sharedStrings.xml', data: XLSX_STRINGS },
    { name: 'xl/worksheets/sheet1.xml', data: XLSX_SHEET, deflate: true },
  ]);
  const t = await xlsxToRows(new Uint8Array(zip));
  eq(t.headers.length, 3);
  deq(t.headers, ['Date', 'Profit', 'Stakes']);
  eq(t.rows.length, 2);
  eq(t.rows[0].Date, '2025-08-12');
  eq(t.rows[0].Profit, '340');
  eq(t.rows[0].Stakes, 'NLH');
  eq(t.rows[1].Date, '2025-08-14');
  eq(t.rows[1].Profit, '-12.5');
  eq(t.rows[1].Stakes, '2');
});

await test('xlsxToRows rejects non-zip bytes with a plain error', async () => {
  await assert.rejects(() => xlsxToRows(new Uint8Array([1, 2, 3, 4])), /Not an XLSX/);
});

// --- render cap ------------------------------------------------------------------------

await test('PREVIEW_RENDER_CAP keeps the DOM bounded on big imports', async () => {
  ok(PREVIEW_RENDER_CAP >= 50);
  ok(PREVIEW_RENDER_CAP <= 300);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
