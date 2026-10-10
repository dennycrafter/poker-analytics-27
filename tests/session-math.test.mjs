// Session-math regressions (track fx1): how a live session is closed and how
// its duration / break / played time come out.
//
//  Bug A — a ~1 minute live session showed "Duration of play 169:30"
//          (= 7 days + 1:30). The live start form accepted a back-dated
//          "Date" and started a LIVE session from it, so the timer (and the
//          stored duration) ran from a week ago. Back-dating beyond the
//          live window must route to "Log past session" instead.
//  Bug B — ending while paused must count the open pause as break time
//          (the native rule), not as play time.
//
// Pure functions only (no store, no DOM). DST cases re-run this file under
// TZ=Europe/Dublin and TZ=America/New_York.
// Usage: node tests/session-math.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  pendingPauseSeconds, closeLiveSession, endLiveCashIn, endLiveTournamentIn,
  liveStartMode, LIVE_BACKDATE_MAX_SECONDS,
} from '../js/session-math.js';
import { playSeconds, sessionHours, durationOfPlay, netResult } from '../js/stats.js';
import { fmtDur, fmtHours, fromLocalInputValue } from '../js/format.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const T0 = Date.parse('2026-10-10T20:00:00Z');
const sec = n => n * 1000;
const iso = ms => new Date(ms).toISOString();

function live(extra = {}) {
  return {
    id: 's1', kind: 'cash', start_time: iso(T0), end_time: null, duration_seconds: null,
    break_seconds: 0, paused_at: null, is_live: true, tracked_via_stack: true,
    small_blind: 0.1, big_blind: 0.2, buy_in: null, cashed_out: null, tips: 0,
    updated_at: iso(T0), ...extra,
  };
}
function doc(s, events = []) {
  return { sessions: [s], stack_events: events, sell_actions: [] };
}
let n = 0;
const newId = () => 'e' + (++n);

// --- Bug A: durations ---------------------------------------------------------

test('A: a 1-minute live session stores 60 s and displays 0:01 everywhere', () => {
  const s = live();
  closeLiveSession(s, T0 + sec(60));
  assert.equal(s.duration_seconds, 60);
  assert.equal(s.break_seconds, 0);
  assert.equal(playSeconds(s), 60);
  assert.equal(fmtDur(s.duration_seconds), '0:01');
  assert.equal(fmtHours(sessionHours(s)), '0:01');
  assert.equal(fmtHours(durationOfPlay([s])), '0:01');
});

test('A: 1-minute session with a pause/resume in the middle', () => {
  const s = live({ break_seconds: 20 });   // paused 20 s then resumed
  closeLiveSession(s, T0 + sec(83));
  assert.equal(s.duration_seconds, 83);
  assert.equal(playSeconds(s), 63);
  assert.equal(fmtHours(sessionHours(s)), '0:01');
});

test('A: stored duration is real seconds, never ms or minutes (2h 30m 15s)', () => {
  const s = live();
  closeLiveSession(s, T0 + sec(2 * 3600 + 30 * 60 + 15));
  assert.equal(s.duration_seconds, 9015);
  assert.equal(fmtDur(s.duration_seconds), '2:30');
});

test('A: sub-second end rounds to whole seconds and never goes negative', () => {
  const s = live();
  closeLiveSession(s, T0 + 400);
  assert.equal(s.duration_seconds, 0);
  const t = live();
  closeLiveSession(t, T0 - sec(5));     // clock skew: end before start
  assert.equal(t.duration_seconds, 0);
  assert.equal(playSeconds(t), 0);
});

test('A: live start "Now" (or a few minutes back) starts live', () => {
  const now = T0;
  assert.equal(liveStartMode(null, now), 'live');
  assert.equal(liveStartMode(new Date(now), now), 'live');
  assert.equal(liveStartMode(new Date(now - sec(45 * 60)), now), 'live');
});

test('A: back-dating the live start by a week routes to "Log past session"', () => {
  // The reported 169:30 = 7 days + 1:30: a start picked a week back.
  const now = T0;
  const weekAgo = new Date(now - sec(7 * 24 * 3600 + 89 * 60));
  assert.equal(liveStartMode(weekAgo, now), 'past');
  // Had it started live, this is exactly what Statistics showed:
  const s = live({ start_time: weekAgo.toISOString() });
  closeLiveSession(s, now + sec(60));
  assert.equal(fmtHours(sessionHours(s)), '169:30');
});

test('A: the live back-date window is a hard boundary', () => {
  const now = T0;
  assert.equal(liveStartMode(new Date(now - sec(LIVE_BACKDATE_MAX_SECONDS)), now), 'live');
  assert.equal(liveStartMode(new Date(now - sec(LIVE_BACKDATE_MAX_SECONDS + 1)), now), 'past');
});

test('A: future or invalid live start is refused', () => {
  assert.equal(liveStartMode(new Date(T0 + sec(61)), T0), 'future');
  assert.equal(liveStartMode(new Date('nope'), T0), 'invalid');
});

// --- Bug A: DST / timezone ----------------------------------------------------

test('A: duration across the EU autumn DST change is real elapsed time', () => {
  // Europe/Dublin falls back 2026-10-25 02:00 IST -> 01:00 GMT (01:00 UTC).
  const start = Date.parse('2026-10-24T23:30:00Z');
  const s = live({ start_time: iso(start) });
  closeLiveSession(s, start + sec(3 * 3600));
  assert.equal(s.duration_seconds, 10800);
  assert.equal(fmtHours(sessionHours(s)), '3:00');
});

test('A: duration across the US spring DST change is real elapsed time', () => {
  // America/New_York springs forward 2026-03-08 02:00 EST (07:00 UTC).
  const start = Date.parse('2026-03-08T06:00:00Z');
  const s = live({ start_time: iso(start) });
  closeLiveSession(s, start + sec(2 * 3600));
  assert.equal(s.duration_seconds, 7200);
});

test('A: local datetime inputs across fall-back produce elapsed, not wall-clock, time', () => {
  // 00:30 -> 03:30 local on the fall-back night is 4 real hours in Dublin,
  // 3 in UTC. Either way duration = end - start in epoch ms.
  const a = fromLocalInputValue('2026-10-25T00:30');
  const b = fromLocalInputValue('2026-10-25T03:30');
  const secs = (b - a) / 1000;
  const tz = process.env.TZ || 'UTC';
  const expected = tz === 'Europe/Dublin' ? 4 * 3600 : 3 * 3600;
  if (tz === 'Europe/Dublin' || tz === 'UTC') assert.equal(secs, expected);
  assert.ok(secs > 0 && secs <= 4 * 3600);
});

// --- Bug B: end while paused (native rule) ------------------------------------

test('B: pendingPauseSeconds is 0 when not paused, rounded seconds when paused', () => {
  assert.equal(pendingPauseSeconds(live(), T0 + sec(100)), 0);
  assert.equal(pendingPauseSeconds(live({ paused_at: iso(T0 + sec(40)) }), T0 + sec(100.4)), 60);
  assert.equal(pendingPauseSeconds(live({ paused_at: iso(T0 + sec(40)) }), T0 + sec(10)), 0);
});

test('B: ending while paused adds the open pause to break_seconds', () => {
  // 3h session, 10-min closed break, then paused for the last hour.
  const s = live({ break_seconds: 600, paused_at: iso(T0 + sec(2 * 3600)) });
  closeLiveSession(s, T0 + sec(3 * 3600));
  assert.equal(s.break_seconds, 4200);
  assert.equal(s.duration_seconds, 10800);
  assert.equal(s.paused_at, null);
  assert.equal(s.is_live, false);
  assert.equal(fmtHours(sessionHours(s)), '1:50');
  // Played time is the same live (just before end) and after end.
  assert.equal(playSeconds(s), 6600);
});

test('B: played time does not jump when ending while paused', () => {
  const s = live({ paused_at: iso(T0 + sec(30 * 60)) });
  const end = T0 + sec(90 * 60);
  const before = playSeconds(s, end);
  closeLiveSession(s, end);
  assert.equal(playSeconds(s), before);
  assert.equal(before, 30 * 60);
});

test('B: 1-minute session paused at 20 s and ended while paused', () => {
  const s = live({ paused_at: iso(T0 + sec(20)) });
  closeLiveSession(s, T0 + sec(60));
  assert.equal(s.break_seconds, 40);
  assert.equal(playSeconds(s), 20);
  assert.equal(fmtDur(s.break_seconds), '0:00');
});

test('B: endLiveCashIn records the cash-out at end time; net is unaffected by the pause', () => {
  const s = live({ paused_at: iso(T0 + sec(3000)) });
  const d = doc(s, [{ id: 'b', session_id: 's1', kind: 'buy_in', amount: 50, occurred_at: iso(T0) }]);
  endLiveCashIn(d, 's1', 72.5, newId, T0 + sec(3600));
  const co = d.stack_events.filter(e => e.kind === 'cash_out');
  assert.equal(co.length, 1);
  assert.equal(co[0].amount, 72.5);
  assert.equal(co[0].occurred_at, s.end_time);
  assert.equal(netResult(d, s), 22.5);
  assert.equal(s.break_seconds, 600);
});

test('B: endLiveCashIn with 0 cash-out adds no stack event', () => {
  const s = live();
  const d = doc(s, [{ id: 'b', session_id: 's1', kind: 'buy_in', amount: 50, occurred_at: iso(T0) }]);
  endLiveCashIn(d, 's1', 0, newId, T0 + sec(60));
  assert.equal(d.stack_events.length, 1);
  assert.equal(netResult(d, s), -50);
});

test('B: endLiveTournamentIn while paused: break folded, prize/position saved', () => {
  const s = live({ kind: 'tournament', tracked_via_stack: false, total_buy_in: 20, paused_at: iso(T0 + sec(7200)) });
  const d = doc(s);
  endLiveTournamentIn(d, 's1', { position: 3, prize: 85 }, T0 + sec(9000));
  assert.equal(s.break_seconds, 1800);
  assert.equal(s.position, 3);
  assert.equal(s.prize, 85);
  assert.equal(netResult(d, s), 65);
});

test('B: ending an already-ended session is a no-op', () => {
  const s = live();
  closeLiveSession(s, T0 + sec(60));
  const snap = JSON.stringify(s);
  const d = doc(s);
  endLiveCashIn(d, 's1', 10, newId, T0 + sec(999));
  assert.equal(JSON.stringify(s), snap);
  assert.equal(d.stack_events.length, 0);
});

console.log(`\n${pass} passed, ${fail} failed` + (process.env.TZ ? ` (TZ=${process.env.TZ})` : ''));

// Re-run under two DST-observing zones so local-time code paths are covered.
if (!process.env.SESSION_MATH_CHILD) {
  let childFail = 0;
  for (const tz of ['Europe/Dublin', 'America/New_York']) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, TZ: tz, SESSION_MATH_CHILD: '1' }, encoding: 'utf8',
    });
    const last = (r.stdout || '').trim().split('\n').pop();
    console.log(`  [${tz}] ${last}`);
    if (r.status !== 0) { childFail++; process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || ''); }
  }
  if (childFail) process.exit(1);
}
process.exit(fail ? 1 : 0);
