// Pure session-lifecycle math shared by the live screens and domain.js.
// No store, no DOM, explicit clock — so node tests can pin every case and
// assert parity with the native port (native/src/lib/domain.ts).

// How far back a LIVE session's start may be set. A player who forgot to tap
// Start can catch up on tonight's session; anything older is a past session
// and must go through "Log past session" (explicit start AND end), otherwise
// the timer runs from the picked day and the stored duration spans days.
export const LIVE_BACKDATE_MAX_SECONDS = 12 * 3600;

// Grace for clock skew between the picker (minute precision) and Date.now().
const FUTURE_GRACE_MS = 60 * 1000;

/**
 * Classify a chosen live start time.
 * @param {Date|null} startDate  null = "Now"
 * @returns {'live'|'past'|'future'|'invalid'}
 */
export function liveStartMode(startDate, nowMs) {
  if (startDate === null || startDate === undefined) return 'live';
  const t = startDate.getTime();
  if (!Number.isFinite(t)) return 'invalid';
  if (t > nowMs + FUTURE_GRACE_MS) return 'future';
  if (nowMs - t > LIVE_BACKDATE_MAX_SECONDS * 1000) return 'past';
  return 'live';
}

/** Whole seconds of the currently open pause (0 when not paused). */
export function pendingPauseSeconds(s, nowMs) {
  return s.paused_at ? Math.max(0, Math.round((nowMs - Date.parse(s.paused_at)) / 1000)) : 0;
}

/**
 * Close a live session in place. Native rule: an open pause at end is break
 * time, not play time — fold it into break_seconds before clearing paused_at.
 * Returns the session, or null when it is not live (no-op).
 */
export function closeLiveSession(s, nowMs) {
  if (!s || !s.is_live) return null;
  const endIso = new Date(nowMs).toISOString();
  s.break_seconds = (s.break_seconds || 0) + pendingPauseSeconds(s, nowMs);
  s.end_time = endIso;
  s.duration_seconds = Math.max(0, Math.round((nowMs - Date.parse(s.start_time)) / 1000));
  s.is_live = false;
  s.paused_at = null;
  s.updated_at = endIso;
  return s;
}

/** End a live cash session inside a document; records the cash-out stack event. */
export function endLiveCashIn(d, sessionId, cashedOut, newId, nowMs) {
  const s = closeLiveSession(d.sessions.find(x => x.id === sessionId), nowMs);
  if (!s) return null;
  const amount = Number(cashedOut) || 0;
  if (amount > 0) {
    d.stack_events.push({ id: newId('stk'), session_id: s.id, kind: 'cash_out', amount, occurred_at: s.end_time });
  }
  return s;
}

/** End a live tournament inside a document; prize 0/blank = busted. */
export function endLiveTournamentIn(d, sessionId, { position, prize }, nowMs) {
  const s = closeLiveSession(d.sessions.find(x => x.id === sessionId), nowMs);
  if (!s) return null;
  if (position !== null && position !== undefined && position !== '') s.position = Number(position);
  s.prize = Number(prize) || 0;
  return s;
}
