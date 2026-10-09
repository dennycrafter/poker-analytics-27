// Date-range presets for the Statistics tab (subset of brief 9's filter chips).
import type { Session } from './types';

export type RangeId = 'all' | '7d' | '30d' | '90d' | 'year';

export const RANGES: { id: RangeId; label: string }[] = [
  { id: 'all', label: 'All time' },
  { id: '7d', label: 'Last 7d' },
  { id: '30d', label: 'Last 30d' },
  { id: '90d', label: 'Last 90d' },
  { id: 'year', label: 'This year' },
];

const DAY_MS = 86400000;

/** Inclusive lower bound (ms) of a range, in local time for "This year"; null = unbounded. */
export function rangeStart(id: RangeId, nowMs: number): number | null {
  switch (id) {
    case '7d': return nowMs - 7 * DAY_MS;
    case '30d': return nowMs - 30 * DAY_MS;
    case '90d': return nowMs - 90 * DAY_MS;
    case 'year': return new Date(new Date(nowMs).getFullYear(), 0, 1).getTime();
    default: return null;
  }
}

export function inRange(sessions: Session[], id: RangeId, nowMs: number): Session[] {
  const from = rangeStart(id, nowMs);
  return from === null ? sessions : sessions.filter(s => Date.parse(s.start_time) >= from);
}

export function isRangeId(v: unknown): v is RangeId {
  return typeof v === 'string' && RANGES.some(r => r.id === v);
}
