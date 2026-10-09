// Derived values — computed on read, NEVER stored (brief section 4).
// Tier 2 adds aggregate formulas here on top of these per-session helpers.

import { monthKey } from './format.js';

export function endedSessions(doc) {
  return doc.sessions.filter(s => !s.is_live && s.end_time);
}

// Single source of truth for cash buy-in:
// live-tracked sessions derive it from stack events, past sessions use the field.
export function stackBuyIn(doc, s) {
  if (!s.tracked_via_stack) return Number(s.buy_in || 0);
  return doc.stack_events
    .filter(e => e.session_id === s.id && (e.kind === 'buy_in' || e.kind === 'top_up'))
    .reduce((a, e) => a + Number(e.amount || 0), 0);
}

export function stackCashedOut(doc, s) {
  if (!s.tracked_via_stack) return Number(s.cashed_out || 0);
  return doc.stack_events
    .filter(e => e.session_id === s.id && e.kind === 'cash_out')
    .reduce((a, e) => a + Number(e.amount || 0), 0);
}

export function netResult(doc, s) {
  if (s.kind === 'cash') {
    return stackCashedOut(doc, s) - stackBuyIn(doc, s) - Number(s.tips || 0);
  }
  return Number(s.prize || 0) - Number(s.total_buy_in || 0);
}

// Play time excluding breaks and any ongoing pause. For live sessions `end` is now.
export function playSeconds(s, nowMs = Date.now()) {
  const endMs = s.end_time ? Date.parse(s.end_time) : nowMs;
  const total = Math.max(0, (endMs - Date.parse(s.start_time)) / 1000);
  const ongoingPause = s.paused_at ? Math.max(0, (nowMs - Date.parse(s.paused_at)) / 1000) : 0;
  return Math.max(0, total - Number(s.break_seconds || 0) - ongoingPause);
}

export function hoursOf(s, nowMs) {
  return playSeconds(s, nowMs) / 3600;
}

export function hourlyRate(doc, s, nowMs = Date.now()) {
  const h = hoursOf(s, nowMs);
  return h > 0 ? netResult(doc, s) / h : null;
}

export function netResultBB(doc, s) {
  if (s.kind !== 'cash' || !s.big_blind) return null;
  return netResult(doc, s) / s.big_blind;
}

export function bbPer100(doc, s) {
  const bb = netResultBB(doc, s);
  if (bb === null || !s.hands_count) return null;
  return (bb / s.hands_count) * 100;
}

// Hands auto-estimate while the user has not overridden (~30 hands/hour live).
export function effectiveHands(s, nowMs = Date.now()) {
  if (!s.hands_count_estimated) return s.hands_count ?? null;
  return Math.floor((playSeconds(s, nowMs) / 3600) * 30);
}

// Group sessions by local calendar month, newest first.
export function groupByMonth(sessions) {
  const map = new Map();
  const sorted = [...sessions].sort((a, b) => Date.parse(b.start_time) - Date.parse(a.start_time));
  for (const s of sorted) {
    const k = monthKey(new Date(s.start_time));
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(s);
  }
  return [...map.entries()].map(([key, list]) => ({ key, sessions: list }));
}

// Cumulative profit/loss over time for the Stack screen (brief 5.4):
// chronological points [{x: hoursSinceStart, y: net}], starting at (0, 0),
// including every stack event and (for ended sessions) the final result.
export function stackSeries(doc, s) {
  const startMs = Date.parse(s.start_time);
  const pts = [{ x: 0, y: 0 }];
  let run = 0;
  const evs = doc.stack_events
    .filter(e => e.session_id === s.id)
    .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
  for (const e of evs) {
    run += e.kind === 'cash_out' ? -Number(e.amount || 0) : Number(e.amount || 0);
    pts.push({ x: (Date.parse(e.occurred_at) - startMs) / 3600000, y: run });
  }
  if (s.end_time && s.kind === 'cash' && !s.tracked_via_stack) {
    pts.push({ x: (Date.parse(s.end_time) - startMs) / 3600000, y: Number(netResult(doc, s)) });
  }
  return pts;
}
