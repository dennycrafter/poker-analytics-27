// Reports aggregation (brief 5.13), ported 1:1 from the web app's
// js/reports.js: report dimensions, hour-of-day buckets, best-of picks,
// highlights (best day / week / month / year, biggest win and loss) and the
// period ranges the drill-downs hand to the Feed filter. Every money / rate
// number comes from the shared section-7 formulas in stats.ts; this module
// only decides WHICH sessions (or which share of a session) fall in a bucket.
import { monthKey } from './format';
import { stakesKey } from './filters';
import type { Filter } from './filters';
import { hourLabel, hourRangeLabel, splitByHour } from './hours';
import * as S from './stats';
import type { Doc, Session, SessionChildren, StakingMode } from './types';

export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** brief 8: "Log at least 5 sessions to unlock reports." */
export const MIN_REPORT_SESSIONS = 5;

// --- period keys (local time) ---------------------------------------------------
// day 'YYYY-MM-DD' · week = Monday's day key · month 'YYYY-MM' · year 'YYYY'.

export type PeriodKind = 'day' | 'week' | 'month' | 'year';

export const dayKeyOf = (s: Session): string => S.localDayKey(new Date(s.start_time));
export const monthKeyOf = (s: Session): string => monthKey(new Date(s.start_time));
export const yearKeyOf = (s: Session): string => String(new Date(s.start_time).getFullYear());
export function weekKeyOf(s: Session): string {
  const d = new Date(s.start_time);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return S.localDayKey(d);
}

const PERIOD_KEY: Record<PeriodKind, (s: Session) => string> = { day: dayKeyOf, week: weekKeyOf, month: monthKeyOf, year: yearKeyOf };

function groupBy<K>(list: Session[], keyFn: (s: Session) => K): Map<K, Session[]> {
  const m = new Map<K, Session[]>();
  for (const x of list) {
    const k = keyFn(x);
    const bucket = m.get(k);
    if (bucket) bucket.push(x); else m.set(k, [x]);
  }
  return m;
}

function parseDay(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Inclusive local-date range ('YYYY-MM-DD') for a period key: what the custom Feed filter consumes. */
export function periodRange(kind: PeriodKind, key: string): { from: string; to: string } {
  if (kind === 'day') return { from: key, to: key };
  if (kind === 'week') {
    const end = parseDay(key);
    end.setDate(end.getDate() + 6);
    return { from: key, to: S.localDayKey(end) };
  }
  if (kind === 'month') {
    const [y, m] = key.split('-').map(Number);
    return { from: `${key}-01`, to: `${key}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}` };
  }
  return { from: `${key}-01-01`, to: `${key}-12-31` };
}

export function periodLabel(kind: PeriodKind, key: string): string {
  if (kind === 'day') { const d = parseDay(key); return `${d.getDate()} ${MONTHS3[d.getMonth()]} ${d.getFullYear()}`; }
  if (kind === 'week') { const d = parseDay(key); return `Week of ${d.getDate()} ${MONTHS3[d.getMonth()]} ${d.getFullYear()}`; }
  if (kind === 'month') { const [y, m] = key.split('-').map(Number); return `${MONTHS3[m - 1]} ${y}`; }
  return key;
}

// --- buckets ----------------------------------------------------------------------

export type BucketKey = string | number;

export interface Bucket {
  key: BucketKey;
  label: string;
  sessions: Session[];
  count: number;
  hours: number;
  net: number;
  rate: number | null;
  /** Hour buckets only: wall-clock minutes spent in that hour. */
  minutes?: number;
}

/**
 * 24 hour-of-day buckets. Each session's net result and played hours are
 * attributed in proportion to the wall-clock minutes it spent in that hour,
 * so the bucket sums equal the Statistics totals. Breaks are spread evenly
 * across the span (there is no record of when a break happened).
 */
export function hourBuckets(doc: SessionChildren, sessions: Session[], mode: StakingMode = 'net'): Bucket[] {
  const b = Array.from({ length: 24 }, (_, h) => ({ key: h, minutes: 0, hours: 0, net: 0, sessions: [] as Session[] }));
  for (const s of sessions) {
    const mins = splitByHour(s);
    const wall = mins.reduce((a, x) => a + x, 0);
    if (!(wall > 0)) continue;
    const net = S.sessionNet(doc, s, mode);
    const played = S.sessionHours(s);
    mins.forEach((m, h) => {
      if (m <= 0) return;
      const f = m / wall;
      b[h].minutes += m;
      b[h].hours += played * f;
      b[h].net += net * f;
      b[h].sessions.push(s);
    });
  }
  return b.map(x => ({ ...x, label: hourLabel(x.key), count: x.sessions.length, rate: x.hours > 0 ? x.net / x.hours : null }));
}

export type DimensionId = 'hour' | 'weekday' | 'duration' | 'general' | 'location' | 'stakes' | 'table' | 'buyin';

type LabelDoc = Pick<Doc, 'locations'>;

export interface Dimension {
  id: DimensionId;
  title: string;
  /** Hour-of-day split instead of whole-session grouping. */
  hourly?: boolean;
  /** Bucket key is a money amount (tournament buy-in). */
  money?: boolean;
  pick?: (l: Session[]) => Session[];
  key?: (s: Session) => BucketKey;
  label?: (k: BucketKey, doc: LabelDoc) => string;
  sort?: (a: BucketKey, b: BucketKey) => number;
  /** Feed filter fields equivalent to one bucket, when the filter can express it. */
  feed?: (k: BucketKey) => Partial<Filter> | null;
}

const numSort = (a: BucketKey, b: BucketKey) => Number(a) - Number(b);
const tableName = (n: BucketKey) => (Number(n) === 2 ? 'Heads-up' : `${n}-max`);

export const DIMENSIONS: Dimension[] = [
  { id: 'hour', title: 'Day Time Efficiency', hourly: true, feed: k => ({ hour: Number(k) }) },
  { id: 'weekday', title: 'Day of Week',
    key: s => (new Date(s.start_time).getDay() + 6) % 7, label: k => WEEKDAY_NAMES[Number(k)], sort: numSort },
  { id: 'duration', title: 'Duration',
    key: s => Math.floor(S.sessionHours(s)), label: k => `>= ${k}:00 < ${Number(k) + 1}:00`, sort: numSort },
  { id: 'general', title: 'General',
    key: s => s.kind, label: k => (k === 'cash' ? 'Cash game' : 'Tournament'),
    sort: (a, b) => (a === 'cash' ? -1 : b === 'cash' ? 1 : 0), feed: k => ({ kind: k === 'cash' ? 'cash' : 'tournament' }) },
  { id: 'location', title: 'Locations',
    key: s => s.location_id || '', label: (k, doc) => doc.locations.find(l => l.id === k)?.name || 'No location',
    feed: k => (k ? { location_ids: [String(k)] } : null) },
  { id: 'stakes', title: 'Stakes', pick: S.cashOnly,
    key: s => stakesKey(s), label: k => String(k),
    sort: (a, b) => Number(String(a).split('/')[1]) - Number(String(b).split('/')[1]), feed: k => ({ stakes: [String(k)] }) },
  { id: 'table', title: 'Table size',
    key: s => Number(s.table_size) || 0, label: k => (k ? tableName(k) : 'Unknown'), sort: numSort },
  { id: 'buyin', title: 'Tournament Buy-in', pick: S.tournamentsOnly, money: true,
    key: s => Number(s.initial_buy_in) || 0, label: k => String(k), sort: numSort },
];

export function dimensionById(id: string): Dimension | null {
  return DIMENSIONS.find(d => d.id === id) ?? null;
}

export function dimensionBuckets(doc: SessionChildren & LabelDoc, dim: Dimension, sessions: Session[], mode: StakingMode = 'net'): Bucket[] {
  if (dim.hourly) return hourBuckets(doc, sessions, mode);
  const keyFn = dim.key!, labelFn = dim.label!;
  const list = dim.pick ? dim.pick(sessions) : sessions;
  const groups = groupBy(list, keyFn);
  const keys = [...groups.keys()];
  if (dim.sort) keys.sort(dim.sort);
  else keys.sort((a, b) => labelFn(a, doc).localeCompare(labelFn(b, doc)));
  return keys.map(k => {
    const l = groups.get(k)!;
    return {
      key: k, label: labelFn(k, doc), sessions: l, count: l.length,
      hours: S.durationOfPlay(l), net: S.totalNet(doc, l, mode), rate: S.netHourlyRate(doc, l, mode),
    };
  });
}

/** Best bucket by net result and by net hourly rate (buckets with play only). */
export function bestOf(buckets: Bucket[]): { byNet: Bucket | null; byRate: Bucket | null } {
  const played = buckets.filter(b => b.count > 0);
  const byNet = played.length ? played.reduce((a, b) => (b.net > a.net ? b : a)) : null;
  const rated = played.filter(b => b.rate !== null && Number.isFinite(b.rate));
  const byRate = rated.length ? rated.reduce((a, b) => ((b.rate as number) > (a.rate as number) ? b : a)) : null;
  return { byNet, byRate };
}

/** Display name of a bucket (hour range, money amount, or its label). */
export function bucketName(dim: Dimension, b: Bucket, fmtMoney: (n: number) => string): string {
  if (dim.hourly) return hourRangeLabel(Number(b.key));
  if (dim.money) return fmtMoney(Number(b.key));
  return b.label;
}

/** Compact axis/bar label used under each bar in the drill-down chart. */
export function shortLabel(dim: Dimension, b: Bucket, fmtNum: (n: number) => string): string {
  if (dim.hourly) return String(b.key);
  if (dim.id === 'weekday') return b.label.slice(0, 3);
  if (dim.id === 'duration') return `${b.key}h`;
  if (dim.id === 'general') return b.key === 'cash' ? 'Cash' : 'Tourn.';
  if (dim.id === 'buyin') return fmtNum(Number(b.key));
  if (dim.id === 'location') return b.label.length > 9 ? b.label.slice(0, 8) + '…' : b.label;
  return b.label;
}

// --- highlights -------------------------------------------------------------------

export interface BestPeriod { kind: PeriodKind; key: string; net: number; count: number }

export function bestPeriod(doc: SessionChildren, sessions: Session[], kind: PeriodKind, mode: StakingMode = 'net'): BestPeriod | null {
  let best: BestPeriod | null = null;
  for (const [k, l] of groupBy(sessions, PERIOD_KEY[kind])) {
    const net = S.totalNet(doc, l, mode);
    if (!best || net > best.net) best = { kind, key: k, net, count: l.length };
  }
  return best;
}

export interface Extreme { session: Session; net: number }

export function extremeSessions(doc: SessionChildren, sessions: Session[], mode: StakingMode = 'net'): { win: Extreme | null; loss: Extreme | null } {
  let win: Extreme | null = null, loss: Extreme | null = null;
  for (const s of sessions) {
    const n = S.sessionNet(doc, s, mode);
    if (!win || n > win.net) win = { session: s, net: n };
    if (!loss || n < loss.net) loss = { session: s, net: n };
  }
  return { win, loss };
}
