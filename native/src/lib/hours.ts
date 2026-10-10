// Hour-of-day splitting (brief 5.13 "Day Time Efficiency"), ported 1:1 from
// the web app's js/hours.js so the Reports hour buckets and the Feed hour
// filter mean exactly the same thing on both clients.
//
// A session's wall-clock span [start, end] is cut at every LOCAL hour
// boundary and each piece is credited to the bucket of its local hour.
// A 22:30-02:15 session gives 30 min to 22, 60 to 23, 60 to 0, 60 to 1 and
// 15 to 2: crossing midnight wraps because buckets are hours of the day.
import type { Session } from './types';

/** 24 numbers: minutes the session spent in each local hour. */
export function splitByHour(s: Pick<Session, 'start_time' | 'end_time'>): number[] {
  const out = new Array<number>(24).fill(0);
  const startMs = Date.parse(s.start_time);
  const endMs = s.end_time ? Date.parse(s.end_time) : startMs;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return out;
  let t = startMs;
  while (t < endMs) {
    const next = new Date(t);
    next.setMinutes(60, 0, 0); // next local hour boundary
    const stop = Math.min(next.getTime(), endMs);
    out[new Date(t).getHours()] += (stop - t) / 60000;
    t = stop;
  }
  return out;
}

/** True when the session spent any time in local hour h (0-23). */
export function overlapsHour(s: Pick<Session, 'start_time' | 'end_time'>, h: number): boolean {
  return splitByHour(s)[h] > 0;
}

export function hourLabel(h: number): string { return String(h).padStart(2, '0') + ':00'; }
export function hourRangeLabel(h: number): string { return `${hourLabel(h)}–${hourLabel((Number(h) + 1) % 24)}`; }
