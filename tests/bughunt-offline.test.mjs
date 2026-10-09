// BUG HUNT offline regressions (no network). Each test asserts the CORRECT
// behaviour and FAILS while the matching ISSUES.md entry is open.
// Runs the real app modules with minimal browser stubs.
// Usage: node tests/bughunt-offline.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (typeof globalThis.WebSocket === 'undefined') {
  const r = spawnSync(process.execPath, ['--experimental-websocket', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: process.env });
  process.exit(r.status ?? 1);
}

const mem = new Map();
globalThis.localStorage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
globalThis.window = globalThis;
globalThis.location = new URL('http://localhost/#/feed');
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, querySelector: () => null, getElementById: () => null };

const store = await import('../js/store.js');
const { endLiveCash, endLiveTournament } = await import('../js/domain.js');
const { parseImport } = await import('../js/backup.js');
const { stakedNetResult, netResult, sessionHours } = await import('../js/stats.js');
const { sessionRowHtml } = await import('../js/screens/feed.js');
const { fmtMoney } = await import('../js/format.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const cash = (extra = {}) => ({
  id: 'a', kind: 'cash', start_time: '2026-09-01T18:00:00Z', end_time: '2026-09-01T20:00:00Z', duration_seconds: 7200,
  break_seconds: 0, small_blind: 1, big_blind: 2, buy_in: 100, cashed_out: 150, table_size: 9, ...extra,
});
const parse = data => { try { return parseImport(JSON.stringify(data), uuid); } catch (e) { return { threw: e }; } };
const rejected = r => !r.threw && r.ok === false && typeof r.error === 'string';

// --- #8 parseImport crashes on null entries in child lists -------------------
for (const k of ['stack_events', 'sell_actions', 'player_notes', 'hand_histories']) {
  test(`#8 parseImport returns a validation error (not a TypeError) for ${k}: [null]`, () => {
    const r = parse({ sessions: [cash()], [k]: [null] });
    assert.ok(!r.threw, `threw ${r.threw && r.threw.message}`);
    assert.equal(r.ok, false);
  });
}

// --- #1 root cause: parseImport accepts rows the database will reject -------
// (Each of these, once imported, triggers the data loss in
// tests/bughunt-cloud-import.test.mjs. Constraints from
// supabase/migrations/20261009120000_step_a_backend.sql.)
const DB_REJECTS = [
  ['table_size 12 (check 2..10)', cash({ table_size: 12 })],
  ['end_time before start_time (sessions_end_after_start)', cash({ end_time: '2026-09-01T10:00:00Z' })],
  ['hands_count -5 (check >= 0)', cash({ hands_count: -5 })],
  ['break_seconds -100 (check >= 0)', cash({ break_seconds: -100 })],
  ['duration_seconds -1 (check >= 0)', cash({ duration_seconds: -1 })],
];
for (const [label, s] of DB_REJECTS) {
  test(`#1 parseImport refuses a session the DB rejects: ${label}`, () => assert.ok(rejected(parse({ sessions: [s] })),
    'accepted; on a signed-in account this wipes existing cloud data (see #1)'));
}

// --- #3 duplicate session ids accepted --------------------------------------
test('#3 parseImport refuses (or de-duplicates) two sessions with the same id', () => {
  const r = parse({ sessions: [cash(), cash({ cashed_out: 99 })] });
  assert.ok(rejected(r) || new Set(r.doc.sessions.map(s => s.id)).size === r.doc.sessions.length,
    `ids: ${r.doc && r.doc.sessions.map(s => s.id).join(', ')}`);
});

// --- #4 ending a paused live session drops the ongoing pause ----------------
function endWhilePaused(kind) {
  const now = Date.now();
  const id = uuid();
  store.mutate(d => {
    d.sessions.push({
      id, kind, start_time: new Date(now - 3 * 3600e3).toISOString(), end_time: null, is_live: true,
      break_seconds: 600, paused_at: new Date(now - 3600e3).toISOString(), tracked_via_stack: kind === 'cash',
      small_blind: 0.1, big_blind: 0.2, initial_buy_in: 10, total_buy_in: 10,
    });
  });
  if (kind === 'cash') endLiveCash(id, 50); else endLiveTournament(id, { position: 5, prize: 0 });
  return store.getState().sessions.find(s => s.id === id);
}
for (const kind of ['cash', 'tournament']) {
  test(`#4 ${kind}: ending while paused 1h (after a 10 min break) records 70 min of break / 1:50 played`, () => {
    const s = endWhilePaused(kind);
    assert.ok(Math.abs(s.break_seconds - 4200) <= 2, `break_seconds ${s.break_seconds} (expected ~4200)`);
    assert.ok(Math.abs(sessionHours(s) - 110 / 60) < 0.01, `hours ${sessionHours(s).toFixed(3)} (expected 1.833)`);
  });
}

// --- #2 stored XSS: imported non-numeric table_size rendered as raw HTML ----
test('#2 parseImport refuses / coerces a non-numeric table_size', () => {
  const r = parse({ sessions: [cash({ table_size: '<img src=x onerror=alert(1)>' })] });
  assert.ok(rejected(r) || typeof r.doc.sessions[0].table_size !== 'string',
    `kept ${JSON.stringify(r.doc && r.doc.sessions[0].table_size)}`);
});
test('#2 Feed row escapes table_size (no live <img> tag in the row HTML)', () => {
  const s = cash({ table_size: '<img src=x onerror=alert(1)>' });
  const doc = { settings: { currency: 'EUR' }, sessions: [s], stack_events: [], sell_actions: [], games: [], locations: [], ui: {} };
  assert.ok(!sessionRowHtml(doc, s).includes('<img src=x'), 'row HTML contains the raw <img onerror> payload');
});

// --- #7 import accepts > 100% sold; staked net goes absurd -------------------
test('#7 parseImport refuses sell actions totalling more than 100% of a tournament', () => {
  const t = { ...cash(), kind: 'tournament', total_buy_in: 100, initial_buy_in: 100, prize: 1000 };
  const r = parse({ sessions: [t], sell_actions: [{ id: 'x', session_id: 'a', percentage: 300, markup: 1 }] });
  const detail = r.doc ? `staked net ${stakedNetResult(r.doc, r.doc.sessions[0])} vs gross ${netResult(r.doc, r.doc.sessions[0])}` : '';
  assert.ok(rejected(r), `accepted; ${detail}`);
});

// --- #9 money formatting shows "-EUR 0" ------------------------------------
test('#9 fmtMoney(-0.004) does not render a negative zero', () => {
  assert.ok(!/^-/.test(fmtMoney(-0.004, 'EUR')), `got ${JSON.stringify(fmtMoney(-0.004, 'EUR'))}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
