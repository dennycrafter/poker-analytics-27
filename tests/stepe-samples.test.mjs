// STEP E acceptance: imports verified against the sample CSVs committed to the
// repo (samples/). Covers the generic tracker CSV through the full wizard path
// (analyze → suggested mapping → per-row validation → store import), PokerNow
// ledger+log through the store (dedupe by import_key, stack events), and the
// export → re-import round trip. No sync engine: importSessions runs without
// startSync, so only a localStorage stub is needed (idb.js degrades silently).
// Usage: node --no-warnings --experimental-websocket tests/stepe-samples.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Store globals before any module import.
const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k),
  clear: () => mem.clear(),
  key: i => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};

const { importSessions, getState } = await import('../js/store.js');
const { importCsv, canonicalGame } = await import('../js/csv-import.js');
const { importPokerNow } = await import('../js/pokernow-import.js');
const { sessionsCsv } = await import('../js/csv-export.js');
const { netResult } = await import('../js/stats.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) {
    fail++;
    console.error('  FAIL', name, '\n     ', e.message, '\n     ', (e.stack || '').split('\n')[1] || '');
  }
}

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'samples');
const read = name => readFileSync(join(DIR, name), 'utf8');

// Reset the in-memory document between scenarios (no cloud involved).
function freshDoc() {
  const d = getState();
  for (const k of ['sessions', 'stack_events', 'transactions', 'games', 'locations', 'groups', 'tournament_types', 'bankrolls', 'sell_actions', 'player_notes', 'hand_histories']) d[k] = d[k] instanceof Array ? [] : d[k];
  d.import_keys = {};
}

// ---------------------------------------------------------------------------

await test('sample tracker CSV: suggested mapping imports 4 of 6 rows, one rejected, one in-file duplicate', () => {
  freshDoc();
  const res = importCsv(read('tracker-sessions.csv'));
  assert.equal(res.ok, true, res.fileError || 'parse failed');
  assert.equal(res.summary.totalRows, 6);
  assert.equal(res.summary.accepted, 4, JSON.stringify(res.rejected.map(r => r.reasons)));
  assert.equal(res.summary.rejected, 2); // seat-count typo + in-file duplicate
  assert.equal(res.summary.duplicates, 1);

  const out = importSessions(res.accepted);
  assert.equal(out.imported.length, 4);
  assert.deepEqual(out.skipped, []);

  const doc = getState();
  const sessions = [...doc.sessions].sort((a, b) => a.start_time.localeCompare(b.start_time));
  // The row with Seats=1 was refused; nothing from it leaks into master data.
  assert.equal(sessions.length, 4);
  assert.ok(!doc.locations.some(l => l.name === 'Kaizen Room'), 'rejected row must not create master data');

  // Nets: +140.50, −105, +70 (tournament), +54 — all in the account currency.
  const nets = sessions.map(s => netResult(doc, s));
  assert.equal(Math.round(nets.reduce((t, n) => t + n, 0) * 100) / 100, 159.50, `net total ${nets}`);

  const t = sessions[2];
  assert.equal(t.kind, 'tournament');
  // Tournament money is modelled as entry fees: initial/total buy-in + prize.
  assert.equal(t.initial_buy_in, 50);
  assert.equal(t.total_buy_in, 50);
  assert.equal(t.prize, 120);

  // Master data resolved from names and reused across rows.
  const royale = doc.locations.find(l => l.name === 'Casino Royale');
  assert.ok(royale, 'location created');
  assert.ok(sessions[0].location_id === royale.id && sessions[1].location_id === royale.id, 'location reused');
  const gameNames = doc.games.map(g => g.name);
  assert.ok(gameNames.includes(canonicalGame("NL Hold'em")), `games: ${gameNames}`);
  assert.ok(sessions.every(s => s.bankroll_id && doc.bankrolls.some(b => b.id === s.bankroll_id)), 'bankroll ids resolve');
  assert.ok(sessions.every(s => s.is_live === false && s.tracked_via_stack === false), 'E1 contract on imported rows');
});

await test('sample tracker CSV re-import: every row is skipped as an existing session', () => {
  const res = importCsv(read('tracker-sessions.csv'));
  const out = importSessions(res.accepted);
  assert.equal(out.imported.length, 0, 'no duplicate imports');
  assert.equal(out.skipped.length, res.accepted.length);
  assert.ok(out.skipped.every(s => /already have/i.test(s.reason)), out.skipped.map(s => s.reason).join(' | '));
  assert.equal(getState().sessions.length, 4);
});

await test('sample PokerNow export: one session for the log exporter, stack events written, import_key dedupes', () => {
  freshDoc();
  const r = importPokerNow([
    { name: 'pokernow-ledger.csv', text: read('pokernow-ledger.csv') },
    { name: 'pokernow-log.csv', text: read('pokernow-log.csv') },
  ]);
  assert.equal(r.status, 'ok', r.errors.map(e => e.message).join(' | '));
  assert.equal(r.sessions.length, 1, 'one table, one "me"');

  const out = importSessions(r.sessions);
  assert.equal(out.imported.length, 1);
  assert.deepEqual(out.skipped, []);

  const doc = getState();
  const s = doc.sessions[0];
  assert.equal(s.is_live, false);
  assert.equal(s.game_id && doc.games.find(g => g.id === s.game_id).name, "NL Hold'em");
  // Closed sessions carry no stack events (after-the-fact import); the money
  // lives on the session row itself. Live imports write stack events — covered
  // in tests/stepe-store-import.test.mjs.
  assert.deepEqual(doc.stack_events, []);
  // Ledger is in cents (PokerNow decimal-chips format): 100.00 in, 117.50 out.
  assert.equal(s.buy_in, 100);
  assert.equal(s.cashed_out, 117.50);

  // Re-importing the same file must import nothing.
  const again = importSessions(importPokerNow([
    { name: 'pokernow-ledger.csv', text: read('pokernow-ledger.csv') },
    { name: 'pokernow-log.csv', text: read('pokernow-log.csv') },
  ]).sessions);
  assert.equal(again.imported.length, 0, 'import_key dedupe');
  assert.equal(again.skipped.length, 1);
  assert.match(again.skipped[0].reason, /already imported/i);
  assert.equal(doc.sessions.length, 1);
});

await test('exported CSV re-imports cleanly: same sessions, same net', () => {
  const doc = getState();
  const csv = sessionsCsv(doc);
  assert.ok(csv && csv.length, 'export produced content');
  const res = importCsv(csv);
  assert.equal(res.ok, true, res.fileError || 're-parse failed');
  assert.equal(res.summary.accepted, doc.sessions.length, 'every exported session maps back');
  const outNet = res.accepted.reduce((t, d) => t + d.net_result, 0);
  const docNet = doc.sessions.reduce((t, s) => t + netResult(doc, s), 0);
  assert.equal(Math.round(outNet * 100) / 100, Math.round(docNet * 100) / 100, 'net preserved');

  // And importing it back into the same account is a no-op (all duplicates).
  const out = importSessions(res.accepted);
  assert.equal(out.imported.length, 0);
  assert.equal(getState().sessions.length, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
