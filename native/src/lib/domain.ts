// Session mutations, ported from js/domain.js. Each function mutates a Doc
// draft (the one CloudStore.mutate hands out) and is pure apart from that, so
// tests drive them without a store. Ids are Postgres uuid primary keys.

import type { Doc, Session, SessionKind, StackEventKind } from './types';

export type IdFn = () => string;

export function getLiveSession(doc: Doc): Session | null {
  return doc.sessions.find(s => s.is_live) || null;
}

export function getSession(doc: Doc, id: string): Session | null {
  return doc.sessions.find(s => s.id === id) || null;
}

export interface SetupFields {
  game_id: string | null;
  location_id: string | null;
  bankroll_id: string | null;
  group_id: string | null;
  table_size: number | null;
}

function baseSession(id: string, kind: SessionKind, f: SetupFields, startIso: string): Session {
  return {
    id, kind,
    game_id: f.game_id, location_id: f.location_id || null, bankroll_id: f.bankroll_id,
    group_id: f.group_id || null, table_size: f.table_size,
    start_time: startIso, end_time: null, duration_seconds: null, break_seconds: 0,
    is_live: true, paused_at: null,
    hands_count: null, hands_count_estimated: true,
    comment: null, opponents: null, tracked_via_stack: false,
    small_blind: null, big_blind: null, buy_in: null, cashed_out: null, tips: null,
    tournament_type_id: null, tournament_name: null, initial_buy_in: null, total_buy_in: null,
    prize: null, position: null, entries: null,
    created_at: startIso, updated_at: startIso,
  };
}

export interface LiveCashInput extends SetupFields { small_blind: number; big_blind: number; buy_in: number; start_time: string }

/** Live cash: tracked_via_stack = true and the first buy_in stack event (single source of truth). */
export function startLiveCash(d: Doc, f: LiveCashInput, newId: IdFn): string {
  const id = newId();
  const s = baseSession(id, 'cash', f, f.start_time);
  s.tracked_via_stack = true;
  s.small_blind = f.small_blind;
  s.big_blind = f.big_blind;
  s.tips = 0;
  d.sessions.push(s);
  d.stack_events.push({ id: newId(), session_id: id, kind: 'buy_in', amount: f.buy_in, occurred_at: f.start_time });
  return id;
}

export interface LiveTournamentInput extends SetupFields {
  tournament_type_id: string | null; tournament_name: string | null; initial_buy_in: number; start_time: string;
}

export function startLiveTournament(d: Doc, f: LiveTournamentInput, newId: IdFn): string {
  const id = newId();
  const s = baseSession(id, 'tournament', f, f.start_time);
  s.tournament_type_id = f.tournament_type_id || null;
  s.tournament_name = f.tournament_name || null;
  s.initial_buy_in = f.initial_buy_in;
  s.total_buy_in = f.initial_buy_in;
  s.tips = 0;
  d.sessions.push(s);
  return id;
}

interface PastCommon extends SetupFields { start: Date; end: Date; tips: number | null; hands_count: number | null }
export type PastSessionInput =
  | (PastCommon & { kind: 'cash'; small_blind: number; big_blind: number; buy_in: number; cashed_out: number | null })
  | (PastCommon & {
    kind: 'tournament'; tournament_type_id: string | null; tournament_name: string | null;
    initial_buy_in: number; total_buy_in: number | null; prize: number | null; position: number | null; entries: number | null;
  });

/** After-the-fact session (either kind). Times must already pass validateTimes. */
export function logPastSession(d: Doc, f: PastSessionInput, newId: IdFn): string {
  const id = newId();
  const s = baseSession(id, f.kind, f, f.start.toISOString());
  s.is_live = false;
  s.end_time = f.end.toISOString();
  s.duration_seconds = Math.max(0, Math.round((f.end.getTime() - f.start.getTime()) / 1000));
  s.tips = f.tips || 0;
  s.hands_count = f.hands_count ?? null;
  s.hands_count_estimated = false;
  if (f.kind === 'cash') {
    s.small_blind = f.small_blind;
    s.big_blind = f.big_blind;
    s.buy_in = f.buy_in;
    s.cashed_out = f.cashed_out || 0;
  } else {
    s.tournament_type_id = f.tournament_type_id || null;
    s.tournament_name = f.tournament_name || null;
    s.initial_buy_in = f.initial_buy_in;
    s.total_buy_in = f.total_buy_in || f.initial_buy_in;
    s.prize = f.prize || 0;
    s.position = f.position ?? null;
    s.entries = f.entries ?? null;
  }
  d.sessions.push(s);
  return id;
}

/** Seconds of an ongoing pause, rounded like resume does. */
function pendingPauseSeconds(s: Session, nowMs: number): number {
  return s.paused_at ? Math.max(0, Math.round((nowMs - Date.parse(s.paused_at)) / 1000)) : 0;
}

export function togglePause(d: Doc, sessionId: string, nowMs: number = Date.now()): void {
  const s = d.sessions.find(x => x.id === sessionId);
  if (!s || !s.is_live) return;
  if (s.paused_at) {
    // Resume: fold the elapsed pause into break_seconds.
    s.break_seconds = (s.break_seconds || 0) + pendingPauseSeconds(s, nowMs);
    s.paused_at = null;
  } else {
    s.paused_at = new Date(nowMs).toISOString();
  }
  s.updated_at = new Date(nowMs).toISOString();
}

function endCommon(d: Doc, sessionId: string, nowMs: number): Session | null {
  const s = d.sessions.find(x => x.id === sessionId);
  if (!s || !s.is_live) return null;
  const endIso = new Date(nowMs).toISOString();
  // Ending while paused: the pause so far is break time, not play time.
  s.break_seconds = (s.break_seconds || 0) + pendingPauseSeconds(s, nowMs);
  s.end_time = endIso;
  s.duration_seconds = Math.max(0, Math.round((nowMs - Date.parse(s.start_time)) / 1000));
  s.is_live = false;
  s.paused_at = null;
  s.updated_at = endIso;
  return s;
}

export function endLiveCash(d: Doc, sessionId: string, cashedOut: number, newId: IdFn, nowMs: number = Date.now()): void {
  const s = endCommon(d, sessionId, nowMs);
  if (!s) return;
  const amount = Number(cashedOut) || 0;
  if (amount > 0) {
    d.stack_events.push({ id: newId(), session_id: s.id, kind: 'cash_out', amount, occurred_at: s.end_time });
  }
}

export function endLiveTournament(
  d: Doc, sessionId: string, r: { position: number | null; prize: number | null }, nowMs: number = Date.now(),
): void {
  const s = endCommon(d, sessionId, nowMs);
  if (!s) return;
  if (r.position !== null) s.position = r.position;
  s.prize = Number(r.prize) || 0; // 0 = busted
}

export function updateSession(d: Doc, sessionId: string, patch: Partial<Session>): void {
  const s = d.sessions.find(x => x.id === sessionId);
  if (!s) return;
  Object.assign(s, patch, { updated_at: new Date().toISOString() });
}

export function deleteSession(d: Doc, sessionId: string): void {
  d.sessions = d.sessions.filter(s => s.id !== sessionId);
  d.stack_events = d.stack_events.filter(e => e.session_id !== sessionId);
  d.sell_actions = d.sell_actions.filter(x => x.session_id !== sessionId);
}

export function addStackEvent(
  d: Doc, sessionId: string, e: { kind: StackEventKind; amount: number; occurred_at: string }, newId: IdFn,
): void {
  d.stack_events.push({ id: newId(), session_id: sessionId, ...e });
}

export function deleteStackEvent(d: Doc, eventId: string): void {
  d.stack_events = d.stack_events.filter(e => e.id !== eventId);
}

export function addTournamentRebuy(d: Doc, sessionId: string, amount: number): void {
  const s = d.sessions.find(x => x.id === sessionId);
  if (!s) return;
  s.total_buy_in = Number(s.total_buy_in || 0) + Number(amount || 0);
  s.updated_at = new Date().toISOString();
}

/** Find-or-create a named master-data entry; master ids are text, any unique string works. */
export function ensureByName(list: { id: string; name: string }[], name: string, newId: IdFn): string | null {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  const found = list.find(x => x.name.toLowerCase() === trimmed.toLowerCase());
  if (found) return found.id;
  const item = { id: newId(), name: trimmed };
  list.push(item);
  return item.id;
}

/** Brief 7 edge cases: no future starts, end after start. Null when valid. */
export function validateTimes(start: Date | null, end: Date | null, nowMs: number = Date.now()): string | null {
  if (!start) return 'Enter a valid start time (YYYY-MM-DD HH:MM).';
  if (start.getTime() > nowMs + 60000) return 'Start time cannot be in the future.';
  if (end === null) return null;
  if (end.getTime() <= start.getTime()) return 'End time must be after start time.';
  if (end.getTime() > nowMs + 60000) return 'End time cannot be in the future.';
  return null;
}
