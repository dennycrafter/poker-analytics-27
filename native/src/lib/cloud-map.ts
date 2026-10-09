// Pure mappings between the in-memory document and the Supabase rows in
// supabase/migrations/20261009120000_step_a_backend.sql. Ported from the web
// app's js/cloud-map.js so both clients write byte-identical rows (the same
// fingerprint), which is what lets each side recognise its own realtime echo.
//
// A session row embeds its stack_events and sell_actions as jsonb arrays; in
// memory they live in flat doc.stack_events / doc.sell_actions lists keyed by
// session_id.

import type {
  Bankroll, Doc, JsonValue, NamedItem, SellAction, Session, SessionChildren, StackEvent, Transaction,
} from './types';

export const SESSION_COLUMNS = [
  'id', 'kind', 'game_id', 'location_id', 'bankroll_id', 'group_id', 'table_size',
  'start_time', 'end_time', 'duration_seconds', 'break_seconds',
  'is_live', 'paused_at', 'hands_count', 'hands_count_estimated',
  'comment', 'opponents', 'tracked_via_stack',
  'small_blind', 'big_blind', 'buy_in', 'cashed_out', 'tips',
  'tournament_type_id', 'tournament_name', 'initial_buy_in', 'total_buy_in',
  'prize', 'position', 'entries', 'created_at',
] as const;

export const TRANSACTION_COLUMNS = ['id', 'bankroll_id', 'kind', 'amount', 'description', 'occurred_at', 'created_at'] as const;

export const MASTER_LISTS = ['bankrolls', 'locations', 'games', 'tournament_types', 'groups'] as const;
type MasterList = (typeof MASTER_LISTS)[number];

const INT_COLS = new Set(['table_size', 'duration_seconds', 'break_seconds', 'hands_count', 'position', 'entries']);
const NUM_COLS = new Set(['small_blind', 'big_blind', 'buy_in', 'cashed_out', 'tips', 'initial_buy_in', 'total_buy_in', 'prize', 'amount']);
const TS_COLS = new Set(['start_time', 'end_time', 'paused_at', 'created_at', 'updated_at', 'occurred_at']);
const BOOL_COLS = new Set(['is_live', 'hands_count_estimated', 'tracked_via_stack']);

/** A database row as returned by PostgREST / realtime (loosely typed on purpose). */
export type DbRow = Record<string, unknown>;

/** JSON with sorted object keys: jsonb does not preserve key order. */
export function stableStringify(v: unknown): string {
  if (v === null || v === undefined || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort()
    .filter(k => o[k] !== undefined)
    .map(k => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string { return typeof v === 'string' && UUID_RE.test(v); }

/**
 * Canonical ISO-8601 UTC (ms precision). Postgres/realtime may send
 * "2026-10-09 20:31:00.123456+00" or a bare timestamp; a bare value is UTC.
 */
export function normTs(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  let s = String(v).trim().replace(' ', 'T');
  if (!/(Z|[+-]\d\d(:?\d\d)?)$/i.test(s)) s += 'Z';
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function coerce(col: string, v: unknown): unknown {
  if (BOOL_COLS.has(col)) return !!v;
  if (TS_COLS.has(col)) return normTs(v);
  if (INT_COLS.has(col)) { const n = numOrNull(v); return n === null ? null : Math.round(n); }
  if (NUM_COLS.has(col)) return numOrNull(v);
  return v === undefined || v === '' ? null : v;
}

interface StackEventJson { id: string; kind: StackEvent['kind']; amount: number; occurred_at: string | null }
interface SellActionJson { id: string; percentage: number; markup: number; backer_name: string | null }

function stackEventOut(e: Partial<StackEvent> & Record<string, unknown>): StackEventJson {
  return { id: String(e.id), kind: e.kind as StackEvent['kind'], amount: numOrNull(e.amount) ?? 0, occurred_at: normTs(e.occurred_at) };
}

function sellActionOut(a: Partial<SellAction> & Record<string, unknown>): SellActionJson {
  return {
    id: String(a.id),
    percentage: numOrNull(a.percentage) ?? 0,
    markup: numOrNull(a.markup) ?? 1,
    backer_name: (a.backer_name as string | null | undefined) ?? null,
  };
}

// --- sessions ---------------------------------------------------------------

/** Write payload for one session (column order fixed => stable fingerprint). */
export function sessionToRow(doc: SessionChildren, s: Session, userId: string | null): DbRow {
  const row: DbRow = { user_id: userId };
  const src = s as unknown as Record<string, unknown>;
  for (const c of SESSION_COLUMNS) row[c] = coerce(c, src[c]);
  row.break_seconds = row.break_seconds ?? 0;
  // An explicit null would override the column default and violate NOT NULL.
  row.created_at = row.created_at ?? row.start_time;
  row.stack_events = doc.stack_events.filter(e => e.session_id === s.id).map(e => stackEventOut({ ...e }));
  row.sell_actions = doc.sell_actions.filter(a => a.session_id === s.id).map(a => sellActionOut({ ...a }));
  return row;
}

export interface SessionParts { session: Session; stack_events: StackEvent[]; sell_actions: SellAction[] }

/** Server row -> in-memory entities. */
export function rowToSessionParts(row: DbRow): SessionParts {
  const session: Record<string, unknown> = {};
  for (const c of SESSION_COLUMNS) session[c] = coerce(c, row[c]);
  session.break_seconds = session.break_seconds ?? 0;
  session.updated_at = normTs(row.updated_at);
  const id = String(row.id);
  const evs = Array.isArray(row.stack_events) ? (row.stack_events as Record<string, unknown>[]) : [];
  const sells = Array.isArray(row.sell_actions) ? (row.sell_actions as Record<string, unknown>[]) : [];
  return {
    session: session as unknown as Session,
    stack_events: evs.map(e => ({ ...stackEventOut(e), session_id: id })),
    sell_actions: sells.map(a => ({ ...sellActionOut(a), session_id: id })),
  };
}

/** Canonical fingerprint of a session as the server would store it. */
export function sessionFingerprint(doc: SessionChildren, s: Session, userId: string | null): string {
  return stableStringify(sessionToRow(doc, s, userId));
}

export function rowFingerprint(row: DbRow, userId: string | null): string {
  const parts = rowToSessionParts(row);
  return sessionFingerprint(parts, parts.session, userId);
}

// --- bankroll transactions --------------------------------------------------

export function transactionToRow(t: Transaction, userId: string | null): DbRow {
  const row: DbRow = { user_id: userId };
  const src = t as unknown as Record<string, unknown>;
  for (const c of TRANSACTION_COLUMNS) row[c] = coerce(c, src[c]);
  row.created_at = row.created_at ?? row.occurred_at;
  return row;
}

export function rowToTransaction(row: DbRow): Transaction {
  const t: Record<string, unknown> = {};
  for (const c of TRANSACTION_COLUMNS) t[c] = coerce(c, row[c]);
  t.updated_at = normTs(row.updated_at);
  return t as unknown as Transaction;
}

// --- user settings ------------------------------------------------------------

export function settingsToRow(doc: Doc, userId: string | null): DbRow {
  // Unknown master_data keys (newer web versions) are written back untouched.
  const master_data: Record<string, unknown> = { ...doc.extra_master };
  for (const k of MASTER_LISTS) master_data[k] = doc[k] || [];
  return {
    user_id: userId,
    currency: doc.settings.currency || 'EUR',
    master_data,
    player_notes: doc.player_notes || [],
    hand_histories: doc.hand_histories || [],
  };
}

function asList<T extends NamedItem>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export function applySettingsRow(doc: Doc, row: DbRow): void {
  const md = (row.master_data && typeof row.master_data === 'object' ? row.master_data : {}) as Record<string, JsonValue>;
  doc.bankrolls = asList<Bankroll>(md.bankrolls);
  doc.locations = asList(md.locations);
  doc.games = asList(md.games);
  doc.tournament_types = asList(md.tournament_types);
  doc.groups = asList(md.groups);
  const extra: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(md)) {
    if (!(MASTER_LISTS as readonly string[]).includes(k)) extra[k] = v;
  }
  doc.extra_master = extra;
  doc.settings = { ...doc.settings, currency: typeof row.currency === 'string' && row.currency ? row.currency : 'EUR' };
  doc.player_notes = Array.isArray(row.player_notes) ? (row.player_notes as JsonValue[]) : [];
  doc.hand_histories = Array.isArray(row.hand_histories) ? (row.hand_histories as JsonValue[]) : [];
}

/**
 * Master data for a brand-new account. Ids are deterministic and identical
 * to the web app's, so two devices signing in for the first time at once
 * cannot fork the lists.
 */
export function defaultMasterData(nowIso: string): Pick<Doc, MasterList> {
  return {
    bankrolls: [{ id: 'bk-live', name: 'Live', is_default: true, created_at: nowIso }],
    games: [
      { id: 'g-nlh', name: "NL Hold'em" },
      { id: 'g-plo', name: 'PLO' },
      { id: 'g-plo5', name: 'PLO5' },
    ],
    tournament_types: [
      { id: 'tt-mtt', name: 'MTT' },
      { id: 'tt-sng', name: 'SNG' },
      { id: 'tt-spin', name: 'Spin & Go' },
      { id: 'tt-sat', name: 'Satellite' },
    ],
    locations: [],
    groups: [],
  };
}
