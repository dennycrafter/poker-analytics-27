// Per-tab session filters (brief section 9), ported 1:1 from the web app's
// js/filters.js. Feed and Statistics each keep their own filter; on native it
// is device-local (src/state/filters.ts), like the web's doc.ui.filters.
// Pure matching / summary logic only: no React, no storage.
import { fmtNum } from './format';
import { hourRangeLabel, overlapsHour } from './hours';
import type { Doc, NamedItem, Session } from './types';

export type FilterRange = '7d' | '30d' | '90d' | 'year' | 'all' | 'custom';
export type FilterKind = 'both' | 'cash' | 'tournament';
export type FilterTab = 'feed' | 'stats';

/** Multi-select id lists; an empty list means "no constraint". */
export const LIST_KEYS = ['game_ids', 'stakes', 'tournament_type_ids', 'location_ids', 'bankroll_ids', 'group_ids'] as const;
export type ListKey = (typeof LIST_KEYS)[number];

export interface Filter {
  range: FilterRange;
  /** Local 'YYYY-MM-DD' bounds, inclusive; only used when range = 'custom'. */
  from: string | null;
  to: string | null;
  kind: FilterKind;
  game_ids: string[];
  stakes: string[];
  tournament_type_ids: string[];
  location_ids: string[];
  bankroll_ids: string[];
  group_ids: string[];
  /** 0-23: Reports hour-bucket drill-down (session overlaps that local hour). */
  hour: number | null;
}

/** [id, chip label, summary label] — same order and wording as the web. */
export const RANGES: [FilterRange, string, string][] = [
  ['7d', 'Last 7d', 'Last 7 days'],
  ['30d', 'Last 30d', 'Last 30 days'],
  ['90d', 'Last 90d', 'Last 90 days'],
  ['year', 'This year', 'This year'],
  ['all', 'All time', 'All time'],
  ['custom', 'Custom', 'Custom'],
];

export function emptyFilter(): Filter {
  return {
    range: 'all', from: null, to: null, kind: 'both',
    game_ids: [], stakes: [], tournament_type_ids: [], location_ids: [], bankroll_ids: [], group_ids: [],
    hour: null,
  };
}

export function hasHour(f: Pick<Filter, 'hour'>): f is { hour: number } {
  return Number.isInteger(f.hour) && (f.hour as number) >= 0 && (f.hour as number) < 24;
}

const isRange = (v: unknown): v is FilterRange => RANGES.some(r => r[0] === v);
const isKind = (v: unknown): v is FilterKind => v === 'both' || v === 'cash' || v === 'tournament';
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * Saved filters are device-local and may predate a field or hold a bad value;
 * fill defaults and drop anything invalid (same intent as the web's
 * normalizeFilter, plus type guards because the input is untyped JSON).
 */
export function normalizeFilter(raw: unknown): Filter {
  const f = emptyFilter();
  if (!raw || typeof raw !== 'object') return f;
  const r = raw as Record<string, unknown>;
  if (isRange(r.range)) f.range = r.range;
  if (isDay(r.from)) f.from = r.from;
  if (isDay(r.to)) f.to = r.to;
  if (isKind(r.kind)) f.kind = r.kind;
  for (const k of LIST_KEYS) f[k] = strList(r[k]);
  if (typeof r.hour === 'number' && hasHour({ hour: r.hour })) f.hour = r.hour;
  return f;
}

export function isActive(f: Filter): boolean {
  return f.range !== 'all' || f.kind !== 'both' || hasHour(f) || LIST_KEYS.some(k => f[k].length > 0);
}

/** "0.1/0.2": the stakes key for a cash session (fmtNum-normalised). */
export function stakesKey(s: Pick<Session, 'small_blind' | 'big_blind'>): string {
  return fmtNum(Number(s.small_blind)) + '/' + fmtNum(Number(s.big_blind));
}

/** Distinct stakes present in cash sessions, ordered by big blind. */
export function stakesOptions(doc: Pick<Doc, 'sessions'>): string[] {
  const m = new Map<string, number>();
  for (const s of doc.sessions) {
    if (s.kind !== 'cash' || !s.big_blind) continue;
    m.set(stakesKey(s), Number(s.big_blind));
  }
  return [...m.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k);
}

function localDate(str: string | null, endOfDay: boolean): Date | null {
  if (!str) return null;
  const [y, mo, d] = str.split('-').map(Number);
  if (![y, mo, d].every(Number.isFinite)) return null;
  return endOfDay ? new Date(y, mo - 1, d, 23, 59, 59, 999) : new Date(y, mo - 1, d, 0, 0, 0, 0);
}

const DAY_MS = 86400000;

/** [fromMs, toMs] window for the date range, or null for no date bound. */
export function rangeBounds(f: Pick<Filter, 'range' | 'from' | 'to'>, nowMs: number = Date.now()): [number, number] | null {
  switch (f.range) {
    case '7d': return [nowMs - 7 * DAY_MS, Infinity];
    case '30d': return [nowMs - 30 * DAY_MS, Infinity];
    case '90d': return [nowMs - 90 * DAY_MS, Infinity];
    case 'year': return [new Date(new Date(nowMs).getFullYear(), 0, 1).getTime(), Infinity];
    case 'custom': {
      const a = localDate(f.from, false), b = localDate(f.to, true);
      return [a ? a.getTime() : -Infinity, b ? b.getTime() : Infinity];
    }
    default: return null;
  }
}

/**
 * Kind-specific filters: stakes only apply to cash, tournament type only to
 * tournaments. Picking stakes alone narrows to cash; picking a tournament
 * type alone narrows to tournaments; picking both filters each kind by its own.
 */
export function matches(f: Filter, s: Session, nowMs: number = Date.now()): boolean {
  const b = rangeBounds(f, nowMs);
  if (b) {
    const t = Date.parse(s.start_time);
    if (t < b[0] || t > b[1]) return false;
  }
  if (f.kind !== 'both' && s.kind !== f.kind) return false;
  const inList = (list: string[], v: string | null) => !list.length || (v !== null && list.includes(v));
  if (!inList(f.game_ids, s.game_id)) return false;
  if (!inList(f.location_ids, s.location_id)) return false;
  if (!inList(f.bankroll_ids, s.bankroll_id)) return false;
  if (!inList(f.group_ids, s.group_id)) return false;
  if (hasHour(f) && !overlapsHour(s, f.hour)) return false;
  const hasStakes = f.stakes.length > 0;
  const hasTT = f.tournament_type_ids.length > 0;
  if (s.kind === 'cash') {
    if (hasStakes && !f.stakes.includes(stakesKey(s))) return false;
    if (!hasStakes && hasTT) return false;
  } else {
    if (hasTT && !(s.tournament_type_id !== null && f.tournament_type_ids.includes(s.tournament_type_id))) return false;
    if (!hasTT && hasStakes) return false;
  }
  return true;
}

export function applyFilter(f: Filter, sessions: Session[], nowMs: number = Date.now()): Session[] {
  return sessions.filter(s => matches(f, s, nowMs));
}

function names(list: NamedItem[], ids: string[]): string[] {
  return ids.map(id => list.find(x => x.id === id)?.name).filter((n): n is string => !!n);
}

function compact(arr: string[]): string {
  if (arr.length <= 2) return arr.join(', ');
  return arr.slice(0, 2).join(', ') + ' +' + (arr.length - 2);
}

const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDay(str: string | null): string {
  const d = localDate(str, false);
  return d ? d.getDate() + ' ' + MON3[d.getMonth()] : '…';
}

/** Custom ranges that are exactly one day / month / year read as "4 Jul 2026", "Jul 2026", "2026". */
function customLabel(f: Filter): string {
  const a = localDate(f.from, false), b = localDate(f.to, false);
  if (a && b) {
    if (f.from === f.to) return a.getDate() + ' ' + MON3[a.getMonth()] + ' ' + a.getFullYear();
    const monthEnd = new Date(a.getFullYear(), a.getMonth() + 1, 0);
    if (a.getDate() === 1 && b.getTime() === monthEnd.getTime()) return MON3[a.getMonth()] + ' ' + a.getFullYear();
    if (a.getMonth() === 0 && a.getDate() === 1 && b.getFullYear() === a.getFullYear() && b.getMonth() === 11 && b.getDate() === 31) {
      return String(a.getFullYear());
    }
  }
  return fmtDay(f.from) + ' – ' + fmtDay(f.to);
}

/** "Last 30 days · Cash · UCD" */
export function summary(doc: Pick<Doc, 'games' | 'tournament_types' | 'locations' | 'bankrolls' | 'groups'>, f: Filter): string {
  const parts: string[] = [];
  if (f.range === 'custom') parts.push(customLabel(f));
  else if (f.range !== 'all') parts.push(RANGES.find(r => r[0] === f.range)![2]);
  if (f.kind === 'cash') parts.push('Cash');
  if (f.kind === 'tournament') parts.push('Tournament');
  const add = (arr: string[]) => { if (arr.length) parts.push(compact(arr)); };
  add(names(doc.games, f.game_ids));
  add(f.stakes);
  add(names(doc.tournament_types, f.tournament_type_ids));
  add(names(doc.locations, f.location_ids));
  add(names(doc.bankrolls, f.bankroll_ids));
  add(names(doc.groups, f.group_ids));
  if (hasHour(f)) parts.push(hourRangeLabel(f.hour));
  return parts.join(' · ');
}

/** Error for the custom range on Apply (web filter sheet rules), or null. */
export function customRangeError(f: Pick<Filter, 'range' | 'from' | 'to'>): string | null {
  if (f.range !== 'custom') return null;
  if (!f.from && !f.to) return 'Pick a start or end date';
  if (f.from && f.to && f.from > f.to) return 'Start date must be before end date';
  return null;
}

/** Toggle one id in a multi-select list (returns a new filter). */
export function toggleListValue(f: Filter, key: ListKey, value: string): Filter {
  const list = f[key];
  return { ...f, [key]: list.includes(value) ? list.filter(v => v !== value) : [...list, value] };
}

/** Picking a preset range clears custom bounds, as on the web. */
export function withRange(f: Filter, range: FilterRange): Filter {
  return range === 'custom' ? { ...f, range } : { ...f, range, from: null, to: null };
}
