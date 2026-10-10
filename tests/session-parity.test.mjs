// Web <-> native parity for ending a live session (track fx1, Bug B).
// The native port (native/src/lib/domain.ts) is the reference rule: an OPEN
// pause at end is folded into break_seconds. This drives the REAL web path
// (js/domain.js -> store.mutate) and the native functions on identical
// fixtures with the same clock, and compares duration / break / played / net
// and the recorded stack events. Hand-computed expectations are asserted too,
// so a bug shared by both sides still fails.
//
// Usage: node tests/session-parity.test.mjs   (re-execs itself under tsx so
// the native TypeScript can be imported; fails loudly if tsx is missing).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
if (!process.env.SESSION_PARITY_CHILD) {
  const r = spawnSync('tsx', ['--experimental-websocket', '--no-warnings', self], {
    stdio: 'inherit', env: { ...process.env, SESSION_PARITY_CHILD: '1' },
  });
  if (r.error) { console.error('FAIL cannot run tsx (needed to import native TS): ' + r.error.message); process.exit(1); }
  process.exit(r.status ?? 1);
}

// Minimal browser stubs so js/store.js runs signed-out, in memory.
const mem = new Map();
globalThis.localStorage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
globalThis.window = globalThis;
globalThis.location = new URL('http://localhost/#/feed');
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, querySelector: () => null, getElementById: () => null };

const store = await import('../js/store.js');
const W = await import('../js/domain.js');
const WS = await import('../js/stats.js');
const N = await import('../native/src/lib/domain.ts');
const NS = await import('../native/src/lib/stats.ts');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const T0 = Date.parse('2026-10-10T18:00:00Z');
const at = s => new Date(T0 + s * 1000).toISOString();

// Each fixture: a live session + its stack events, the end time, the end
// input, and the hand-computed result.
const FIXTURES = [
  {
    name: 'cash, no pauses',
    session: { kind: 'cash', break_seconds: 0, paused_at: null },
    events: [['buy_in', 100, 0]],
    endAt: 3 * 3600, end: { cashedOut: 160 },
    expect: { duration: 10800, brk: 0, played: 10800, net: 60 },
  },
  {
    name: 'cash, closed pauses only (resumed before end)',
    session: { kind: 'cash', break_seconds: 900, paused_at: null },
    events: [['buy_in', 100, 0], ['top_up', 50, 3600]],
    endAt: 4 * 3600, end: { cashedOut: 120 },
    expect: { duration: 14400, brk: 900, played: 13500, net: -30 },
  },
  {
    name: 'cash, open pause at end (ended while paused)',
    session: { kind: 'cash', break_seconds: 0, paused_at: at(2 * 3600) },
    events: [['buy_in', 100, 0]],
    endAt: 3 * 3600, end: { cashedOut: 100 },
    expect: { duration: 10800, brk: 3600, played: 7200, net: 0 },
  },
  {
    name: 'cash, closed + open pause, ended during pause with top-ups and a partial cash-out',
    session: { kind: 'cash', break_seconds: 600, paused_at: at(2 * 3600) },
    events: [['buy_in', 50, 0], ['top_up', 30, 1800], ['cash_out', 20, 5400], ['top_up', 25, 6000]],
    endAt: 3 * 3600, end: { cashedOut: 140 },
    expect: { duration: 10800, brk: 4200, played: 6600, net: 55 },
  },
  {
    name: 'cash, ~1 minute, paused at 20 s, ended while paused, cashed out 0',
    session: { kind: 'cash', break_seconds: 0, paused_at: at(20) },
    events: [['buy_in', 20, 0]],
    endAt: 61, end: { cashedOut: 0 },
    expect: { duration: 61, brk: 41, played: 20, net: -20 },
  },
  {
    name: 'tournament, open pause at end, cashed',
    session: { kind: 'tournament', break_seconds: 300, paused_at: at(5 * 3600), total_buy_in: 30, initial_buy_in: 20 },
    events: [],
    endAt: 5.5 * 3600, end: { position: 4, prize: 110 },
    expect: { duration: 19800, brk: 2100, played: 17700, net: 80 },
  },
  {
    name: 'tournament, no pauses, busted',
    session: { kind: 'tournament', break_seconds: 0, paused_at: null, total_buy_in: 10, initial_buy_in: 10 },
    events: [],
    endAt: 90 * 60, end: { position: 57, prize: 0 },
    expect: { duration: 5400, brk: 0, played: 5400, net: -10 },
  },
];

function buildSession(id, f) {
  return {
    id, game_id: null, location_id: null, bankroll_id: null, group_id: null, table_size: 9,
    start_time: at(0), end_time: null, duration_seconds: null, is_live: true,
    hands_count: null, hands_count_estimated: true, comment: null, opponents: null,
    tracked_via_stack: f.session.kind === 'cash',
    small_blind: 0.5, big_blind: 1, buy_in: null, cashed_out: null, tips: 0,
    tournament_type_id: null, tournament_name: null, initial_buy_in: null, total_buy_in: null,
    prize: null, position: null, entries: null, created_at: at(0), updated_at: at(0),
    ...f.session,
  };
}
const buildEvents = (id, f) => f.events.map(([kind, amount, s], i) =>
  ({ id: `${id}-e${i}`, session_id: id, kind, amount, occurred_at: at(s) }));
const eventShape = (d, id) => d.stack_events.filter(e => e.session_id === id)
  .map(e => ({ kind: e.kind, amount: e.amount, occurred_at: e.occurred_at }))
  .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.kind.localeCompare(b.kind));

function runWeb(f, i) {
  const id = `web-${i}`;
  store.mutate(d => { d.sessions.push(buildSession(id, f)); d.stack_events.push(...buildEvents(id, f)); });
  const nowMs = T0 + f.endAt * 1000;
  if (f.session.kind === 'cash') W.endLiveCash(id, f.end.cashedOut, nowMs);
  else W.endLiveTournament(id, f.end, nowMs);
  const d = store.getState();
  const s = d.sessions.find(x => x.id === id);
  return { s, net: WS.netResult(d, s), played: Math.round(WS.sessionHours(s) * 3600), events: eventShape(d, id) };
}

function runNative(f, i) {
  const id = `nat-${i}`;
  const d = { sessions: [buildSession(id, f)], stack_events: buildEvents(id, f), sell_actions: [] };
  const nowMs = T0 + f.endAt * 1000;
  let k = 0;
  if (f.session.kind === 'cash') N.endLiveCash(d, id, f.end.cashedOut, () => `${id}-n${k++}`, nowMs);
  else N.endLiveTournament(d, id, f.end, nowMs);
  const s = d.sessions.find(x => x.id === id);
  return { s, net: NS.netResult(d, s), played: Math.round(NS.sessionHours(s) * 3600), events: eventShape(d, id) };
}

const pick = r => ({
  is_live: r.s.is_live, paused_at: r.s.paused_at, end_time: r.s.end_time,
  duration_seconds: r.s.duration_seconds, break_seconds: r.s.break_seconds,
  played_seconds: r.played, net: r.net, position: r.s.position, prize: r.s.prize, events: r.events,
});

FIXTURES.forEach((f, i) => {
  test(`parity: ${f.name}`, () => {
    const w = runWeb(f, i);
    const n = runNative(f, i);
    assert.deepEqual(pick(w), pick(n));
  });
  test(`expected: ${f.name}`, () => {
    const w = runWeb(f, i + 100);
    assert.equal(w.s.duration_seconds, f.expect.duration, 'duration_seconds');
    assert.equal(w.s.break_seconds, f.expect.brk, 'break_seconds');
    assert.equal(w.played, f.expect.played, 'played seconds');
    assert.equal(w.net, f.expect.net, 'net');
    assert.equal(w.s.paused_at, null, 'paused_at cleared');
    assert.equal(w.s.is_live, false, 'is_live cleared');
  });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
