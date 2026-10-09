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

// ===========================================================================
// Tier 2 — aggregate formulas (brief section 7). Every function takes an
// already-filtered list of ENDED sessions; live sessions never count.
// `mode` selects tournament net: 'net' (net of staking, default) | 'gross'.
// Pure functions; return null where the brief says to show "--".
// ===========================================================================

// Played hours for an ended session: (duration_seconds - break_seconds) / 3600.
export function sessionHours(s) {
  let dur = Number(s.duration_seconds);
  if (!Number.isFinite(dur) || s.duration_seconds === null) {
    dur = s.end_time ? Math.max(0, (Date.parse(s.end_time) - Date.parse(s.start_time)) / 1000) : 0;
  }
  return Math.max(0, dur - Number(s.break_seconds || 0)) / 3600;
}

// Sell actions for a tournament: p = Σ share sold (0..1), pm = Σ share × markup.
export function sellTotals(doc, s) {
  let p = 0, pm = 0;
  for (const a of (doc.sell_actions || [])) {
    if (a.session_id !== s.id) continue;
    const share = Math.max(0, Number(a.percentage) || 0) / 100;
    const mk = a.markup === null || a.markup === undefined || a.markup === '' || !Number.isFinite(Number(a.markup))
      ? 1 : Number(a.markup);
    p += share; pm += share * mk;
  }
  return { p, pm };
}

export function hasStaking(doc, s) {
  return s.kind === 'tournament' && sellTotals(doc, s).p > 0;
}

// Formula 1, net-of-staking retained share. With one markup this is exactly
// prize*(1-sold) - total_buy_in*(1-sold*markup); mixed markups use Σ(p_i*m_i).
export function stakedNetResult(doc, s) {
  if (s.kind !== 'tournament') return netResult(doc, s);
  const { p, pm } = sellTotals(doc, s);
  if (p <= 0) return netResult(doc, s);
  return Number(s.prize || 0) * (1 - p) - Number(s.total_buy_in || 0) * (1 - pm);
}

export function sessionNet(doc, s, mode = 'net') {
  return mode === 'gross' ? netResult(doc, s) : stakedNetResult(doc, s);
}

const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);

export function cashOnly(sessions) { return sessions.filter(s => s.kind === 'cash'); }
export function tournamentsOnly(sessions) { return sessions.filter(s => s.kind === 'tournament'); }
function withHours(sessions) { return sessions.filter(s => sessionHours(s) > 0); }
function withBB(sessions) { return sessions.filter(s => s.kind === 'cash' && Number(s.big_blind) > 0); }

// 1. Net result
export function totalNet(doc, sessions, mode = 'net') {
  return sum(sessions, s => sessionNet(doc, s, mode));
}

// 2. Net hourly rate — weighted by hours; duration-0 sessions excluded.
export function netHourlyRate(doc, sessions, mode = 'net') {
  const ok = withHours(sessions);
  const h = sum(ok, sessionHours);
  return h > 0 ? sum(ok, s => sessionNet(doc, s, mode)) / h : null;
}

// 3. BB/100 — only cash sessions with hands_count (and a big blind).
export function bbPer100Agg(doc, sessions) {
  const ok = withBB(sessions).filter(s => Number(s.hands_count) > 0);
  const hands = sum(ok, s => Number(s.hands_count));
  return hands > 0 ? (sum(ok, s => netResult(doc, s) / s.big_blind) / hands) * 100 : null;
}

// 4. Hourly rate in BB
export function hourlyRateBB(doc, sessions) {
  const ok = withHours(withBB(sessions));
  const h = sum(ok, sessionHours);
  return h > 0 ? sum(ok, s => netResult(doc, s) / s.big_blind) / h : null;
}

// 5. Average net result
export function avgNet(doc, sessions, mode = 'net') {
  return sessions.length ? totalNet(doc, sessions, mode) / sessions.length : null;
}

// Net result in BB (sum) and average net result in BB (cash).
export function totalNetBB(doc, sessions) {
  const ok = withBB(sessions);
  return ok.length ? sum(ok, s => netResult(doc, s) / s.big_blind) : null;
}
export function avgNetBB(doc, sessions) {
  const ok = withBB(sessions);
  return ok.length ? totalNetBB(doc, ok) / ok.length : null;
}

// 6. Hours-weighted mean and variance of per-session hourly rates.
// netFn lets the same formula run in BB units (net_result / big_blind).
export function hourlyMoments(doc, sessions, mode = 'net', netFn = null) {
  const f = netFn || (s => sessionNet(doc, s, mode));
  const ok = withHours(sessions);
  const H = sum(ok, sessionHours);
  if (!(H > 0)) return null;
  const rows = ok.map(s => { const h = sessionHours(s); return { h, r: f(s) / h }; });
  const mean = sum(rows, x => x.r * x.h) / H;
  const variance = sum(rows, x => x.h * (x.r - mean) ** 2) / H;
  return { mean, variance, hours: H, n: rows.length };
}
export function stdDevPerHour(doc, sessions, mode = 'net') {
  const m = hourlyMoments(doc, sessions, mode);
  return m ? Math.sqrt(m.variance) : null;
}
export function stdDevPerHourBB(doc, sessions) {
  const m = hourlyMoments(doc, withBB(sessions), 'net', s => netResult(doc, s) / s.big_blind);
  return m ? Math.sqrt(m.variance) : null;
}

// 7. Win ratio (0..1)
export function winRatio(doc, sessions, mode = 'net') {
  return sessions.length ? sessions.filter(s => sessionNet(doc, s, mode) > 0).length / sessions.length : null;
}

// 8. ROI (tournament) — busted (prize null/0) count with prize 0. Ratio 0..n.
export function roi(doc, sessions) {
  const t = tournamentsOnly(sessions);
  const invested = sum(t, s => Number(s.total_buy_in || 0));
  return invested > 0 ? sum(t, s => Number(s.prize || 0) - Number(s.total_buy_in || 0)) / invested : null;
}

// 9. ITM ratio (0..1)
export function itmRatio(doc, sessions) {
  const t = tournamentsOnly(sessions);
  return t.length ? t.filter(s => Number(s.prize || 0) > 0).length / t.length : null;
}

// 10. Duration of play (hours)  11. Average duration (hours)
export function durationOfPlay(sessions) { return sum(sessions, sessionHours); }
export function avgDuration(sessions) { return sessions.length ? durationOfPlay(sessions) / sessions.length : null; }

// Hands count (All section): sum of recorded hands; null when none recorded.
export function handsTotal(sessions) {
  const ok = sessions.filter(s => s.hands_count !== null && s.hands_count !== undefined && s.hands_count !== '');
  return ok.length ? sum(ok, s => Number(s.hands_count) || 0) : null;
}

// Average buy-in: cash uses the single-source buy-in, tournaments total_buy_in.
export function avgBuyIn(doc, sessions) {
  if (!sessions.length) return null;
  return sum(sessions, s => s.kind === 'cash' ? stackBuyIn(doc, s) : Number(s.total_buy_in || 0)) / sessions.length;
}

// 12. Risk of ruin from per-hour cash mean/variance (formula 6). Integer %, 1..100.
export function riskOfRuin(doc, cashSessions, bankroll) {
  const m = hourlyMoments(doc, cashOnly(cashSessions));
  if (!m) return null;
  if (m.mean <= 0) return 100;
  if (!(m.variance > 0)) return 1;
  const r = Math.exp((-2 * m.mean * Math.max(0, Number(bankroll) || 0)) / m.variance) * 100;
  return Math.min(100, Math.max(1, Math.round(r)));
}

// 13. Longest streaks, chronological. A zero result breaks both streaks.
export function longestStreaks(doc, sessions, mode = 'net') {
  const sorted = [...sessions].sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
  let w = 0, l = 0, bw = 0, bl = 0;
  for (const s of sorted) {
    const n = sessionNet(doc, s, mode);
    if (n > 0) { w++; l = 0; } else if (n < 0) { l++; w = 0; } else { w = 0; l = 0; }
    bw = Math.max(bw, w); bl = Math.max(bl, l);
  }
  return { wins: bw, losses: bl };
}

// 14. Best net result
export function bestNet(doc, sessions, mode = 'net') {
  return sessions.length ? Math.max(...sessions.map(s => sessionNet(doc, s, mode))) : null;
}

// 15. Locations played (distinct)
export function locationsPlayed(sessions) {
  return new Set(sessions.map(s => s.location_id).filter(Boolean)).size;
}

// 16. Days played — distinct LOCAL calendar days.
export function localDayKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
export function daysPlayed(sessions) {
  return new Set(sessions.map(s => localDayKey(new Date(s.start_time)))).size;
}

// 17. Max net duration — longest single session (hours).
export function maxDuration(sessions) {
  return sessions.length ? Math.max(...sessions.map(sessionHours)) : null;
}
