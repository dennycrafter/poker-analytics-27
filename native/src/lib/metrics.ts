// Statistics registry, ported from js/metrics.js: which metrics appear in
// which Statistics section, how each is computed (stats.ts) and formatted.
// Calendar reuses the same registry so both screens always agree.

import * as S from './stats';
import { fmtHours, fmtMoney, fmtNum, monthKey, MONTHS } from './format';
import type { Session, SessionChildren, StakingMode } from './types';

export type MetricUnit = 'money' | 'rate' | 'bb' | 'bbrate' | 'bb100' | 'pct' | 'count' | 'hours' | 'streak';
export type MetricValue = number | S.Streaks | null;
export type ScopeId = 'all' | 'cash' | 'tournament';

export interface MetricDef {
  label: string;
  unit: MetricUnit;
  /** Net vs gross staking toggle changes this metric. */
  staking?: boolean;
  /** Neutral colour (std dev, buy-in): never green/red. */
  signless?: boolean;
  value: (doc: SessionChildren, sessions: Session[], mode: StakingMode) => MetricValue;
}

export const SCOPES: Record<ScopeId, { label: string; pick: (l: Session[]) => Session[] }> = {
  all: { label: 'All', pick: l => l },
  cash: { label: 'Cash games', pick: S.cashOnly },
  tournament: { label: 'Tournaments', pick: S.tournamentsOnly },
};

export const METRICS = {
  net: { label: 'Net result', unit: 'money', staking: true,
    value: (d, l, m) => (l.length ? S.totalNet(d, l, m) : null) },
  hourly: { label: 'Net hourly rate', unit: 'rate', staking: true, value: (d, l, m) => S.netHourlyRate(d, l, m) },
  avg_net: { label: 'Average net result', unit: 'money', staking: true, value: (d, l, m) => S.avgNet(d, l, m) },
  count: { label: 'Number of sessions', unit: 'count', value: (_d, l) => l.length },
  records: { label: 'Number of records', unit: 'count', value: (_d, l) => l.length },
  avg_duration: { label: 'Average duration', unit: 'hours', value: (_d, l) => S.avgDuration(l) },
  duration: { label: 'Duration of play', unit: 'hours', value: (_d, l) => (l.length ? S.durationOfPlay(l) : null) },
  hands: { label: 'Hands count', unit: 'count', value: (_d, l) => S.handsTotal(l) },
  bb100: { label: 'BB per 100 hands', unit: 'bb100', value: (d, l) => S.bbPer100Agg(d, l) },
  hourly_bb: { label: 'Hourly rate in BB', unit: 'bbrate', value: (d, l) => S.hourlyRateBB(d, l) },
  avg_net_bb: { label: 'Average net result in BB', unit: 'bb', value: (d, l) => S.avgNetBB(d, l) },
  stddev: { label: 'Standard deviation per hour', unit: 'rate', signless: true,
    value: (d, l, m) => S.stdDevPerHour(d, l, m) },
  stddev_bb: { label: 'Standard deviation per hour in BB', unit: 'bbrate', signless: true,
    value: (d, l) => S.stdDevPerHourBB(d, l) },
  win_ratio: { label: 'Win ratio', unit: 'pct', staking: true, value: (d, l, m) => S.winRatio(d, l, m) },
  net_bb: { label: 'Net result in BB', unit: 'bb', value: (d, l) => S.totalNetBB(d, l) },
  avg_buyin: { label: 'Average buy-in', unit: 'money', signless: true, value: (d, l) => S.avgBuyIn(d, l) },
  roi: { label: 'ROI', unit: 'pct', value: (d, l) => S.roi(d, l) },
  itm: { label: 'ITM ratio', unit: 'pct', value: (d, l) => S.itmRatio(d, l) },
  // Calendar-only metrics (brief 5.11), formulas 13-17.
  best_net: { label: 'Best net result', unit: 'money', staking: true, value: (d, l, m) => S.bestNet(d, l, m) },
  locations: { label: 'Locations played', unit: 'count', value: (_d, l) => (l.length ? S.locationsPlayed(l) : null) },
  days: { label: 'Days played', unit: 'count', value: (_d, l) => (l.length ? S.daysPlayed(l) : null) },
  max_duration: { label: 'Max net duration', unit: 'hours', value: (_d, l) => S.maxDuration(l) },
  streaks: { label: 'Longest streaks', unit: 'streak', staking: true,
    value: (d, l, m) => (l.length ? S.longestStreaks(d, l, m) : null) },
} satisfies Record<string, MetricDef>;

export type MetricId = keyof typeof METRICS;

export function metricDef(id: MetricId): MetricDef {
  return METRICS[id];
}

/** Exactly the rows listed in brief 5.9, in order. */
export const SECTIONS: Record<ScopeId, MetricId[]> = {
  all: ['net', 'hourly', 'avg_net', 'count', 'avg_duration', 'duration', 'hands'],
  cash: ['net', 'hourly', 'bb100', 'hourly_bb', 'avg_net', 'avg_net_bb', 'stddev', 'win_ratio', 'records', 'net_bb', 'avg_buyin'],
  tournament: ['net', 'hourly', 'roi', 'itm', 'records', 'avg_buyin'],
};

/**
 * Calendar metric tabs (brief 5.11). Win ratio and std dev per hour only
 * appear in the Statistics Cash section, so Calendar computes them on the
 * period's cash sessions to report the same number (matches web).
 */
export const CALENDAR_METRICS: { id: MetricId; scope: ScopeId }[] = [
  { id: 'net', scope: 'all' },
  { id: 'hourly', scope: 'all' },
  { id: 'records', scope: 'all' },
  { id: 'win_ratio', scope: 'cash' },
  { id: 'stddev', scope: 'cash' },
  { id: 'avg_net', scope: 'all' },
  { id: 'avg_duration', scope: 'all' },
  { id: 'duration', scope: 'all' },
  { id: 'hands', scope: 'all' },
  { id: 'best_net', scope: 'all' },
  { id: 'locations', scope: 'all' },
  { id: 'days', scope: 'all' },
  { id: 'max_duration', scope: 'all' },
  { id: 'streaks', scope: 'all' },
];

export function metricValue(doc: SessionChildren, id: MetricId, sessions: Session[], mode: StakingMode = 'net'): MetricValue {
  return metricDef(id).value(doc, sessions, mode);
}

export function calendarValue(
  doc: SessionChildren,
  cm: { id: MetricId; scope: ScopeId },
  sessions: Session[],
  mode: StakingMode = 'net',
): MetricValue {
  return metricDef(cm.id).value(doc, SCOPES[cm.scope].pick(sessions), mode);
}

function isStreak(v: MetricValue): v is S.Streaks {
  return typeof v === 'object' && v !== null;
}

/** Display string for a metric value (identical output to web fmtMetric). */
export function fmtMetric(def: MetricDef, v: MetricValue, currency: string): string {
  if (def.unit === 'streak') return isStreak(v) ? `${v.wins}w / ${v.losses}l` : '--';
  if (v === null || isStreak(v) || !Number.isFinite(v)) return '--';
  switch (def.unit) {
    case 'money': return fmtMoney(v, currency);
    case 'rate': return fmtMoney(v, currency) + '/h';
    case 'bb': return fmtNum(v) + ' BB';
    case 'bbrate': return fmtNum(v) + ' BB/h';
    case 'bb100': return fmtNum(v) + ' BB';
    case 'pct': return fmtNum(v * 100) + '%';
    case 'hours': return fmtHours(v);
    default: return String(Math.round(v));
  }
}

/** Results green/red; neutral metrics (counts, durations, ratios, std dev) stay white. */
export function metricTone(def: MetricDef, v: MetricValue): 'pos' | 'neg' | '' {
  if (def.unit === 'streak' || v === null || isStreak(v) || !Number.isFinite(v) || def.signless) return '';
  if (['money', 'rate', 'bb', 'bbrate', 'bb100'].includes(def.unit) || def === METRICS.roi) {
    return v > 0 ? 'pos' : v < 0 ? 'neg' : '';
  }
  return '';
}

// ---------------------------------------------------------------------------
// Calendar periods (ported from js/reports.js; local time).

export const monthKeyOf = (s: Session): string => monthKey(new Date(s.start_time));
export const yearKeyOf = (s: Session): string => String(new Date(s.start_time).getFullYear());

export function groupBy<K>(list: Session[], keyFn: (s: Session) => K): Map<K, Session[]> {
  const m = new Map<K, Session[]>();
  for (const x of list) {
    const k = keyFn(x);
    const arr = m.get(k);
    if (arr) arr.push(x); else m.set(k, [x]);
  }
  return m;
}

/** Every month key from the earliest session's month to now's month, newest first. */
export function monthSpan(sessions: Session[], nowMs: number = Date.now()): string[] {
  if (!sessions.length) return [];
  const first = new Date(Math.min(...sessions.map(s => Date.parse(s.start_time))));
  const now = new Date(nowMs);
  const out: string[] = [];
  const d = new Date(now.getFullYear(), now.getMonth(), 1);
  const stop = new Date(first.getFullYear(), first.getMonth(), 1);
  while (d >= stop) { out.push(monthKey(d)); d.setMonth(d.getMonth() - 1); }
  return out;
}

const DAY_MS = 86400000;

/** Rolling "30 last days" window. */
export function last30Days(sessions: Session[], nowMs: number = Date.now()): Session[] {
  const from = nowMs - 30 * DAY_MS;
  return sessions.filter(s => Date.parse(s.start_time) >= from);
}

export function monthName(key: string): string {
  return MONTHS[Number(key.slice(5)) - 1];
}

/** Sessions whose local start falls in month key 'YYYY-MM'. */
export function sessionsInMonth(sessions: Session[], key: string): Session[] {
  return sessions.filter(s => monthKeyOf(s) === key);
}

// ---------------------------------------------------------------------------
// Stat-detail series (ported from js/metrics.js buildSeries).
//  line: y = metric over ALL sessions up to and including this point (cumulative).
//  bar:  y = metric over just this point's own bucket.
//  group: unit (x = session #) | month | year | duration (x = cumulative hours).

export type SeriesGroup = 'unit' | 'month' | 'year' | 'duration';
export type ChartKind = 'line' | 'bar';
export interface SeriesPoint { x: number; y: number; label: string; n?: number }

const MONTHS3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function chrono(list: Session[]): Session[] {
  return [...list].sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
}

function isPlottable(y: MetricValue): y is number {
  return typeof y === 'number' && Number.isFinite(y);
}

export function buildSeries(
  doc: SessionChildren,
  id: MetricId,
  sessions: Session[],
  { group = 'unit', chart = 'line', mode = 'net' }: { group?: SeriesGroup; chart?: ChartKind; mode?: StakingMode } = {},
): SeriesPoint[] {
  const def = metricDef(id);
  const list = chrono(sessions);
  if (!list.length) return [];
  const val = (l: Session[]) => def.value(doc, l, mode);

  if (group === 'month' || group === 'year') {
    const buckets = groupBy(list, s => (group === 'month' ? monthKeyOf(s) : yearKeyOf(s)));
    const out: SeriesPoint[] = [];
    let upTo: Session[] = [];
    [...buckets.keys()].forEach((k, i) => {
      const own = buckets.get(k) as Session[];
      upTo = upTo.concat(own);
      const label = group === 'month' ? MONTHS3[Number(k.slice(5)) - 1] + ' ' + k.slice(2, 4) : k;
      const y = chart === 'bar' ? val(own) : val(upTo);
      if (isPlottable(y)) out.push({ x: i + 1, y, label, n: own.length });
    });
    return out;
  }

  const out: SeriesPoint[] = [];
  let hours = 0;
  list.forEach((s, i) => {
    hours += S.sessionHours(s);
    const y = chart === 'bar' ? val([s]) : val(list.slice(0, i + 1));
    const x = group === 'duration' ? hours : i + 1;
    if (isPlottable(y)) out.push({ x, y, label: group === 'duration' ? fmtNum(hours) + 'h' : '#' + (i + 1) });
  });
  return out;
}
