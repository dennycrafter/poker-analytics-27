// Hour-of-day splitting (brief 5.13 "Day Time Efficiency"). Dependency-free
// so both the Reports aggregation and the Feed hour filter can share it.
//
// A session's wall-clock span [start, end] is cut at every LOCAL hour
// boundary and each piece is credited to the bucket of its local hour.
// A 22:30-02:15 session gives 30 min to 22, 60 to 23, 60 to 0, 60 to 1 and
// 15 to 2 — crossing midnight wraps naturally because buckets are hours of
// the day, not absolute hours.

// Returns 24 numbers: minutes the session spent in each local hour.
export function splitByHour(s) {
  const out = new Array(24).fill(0);
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

// True when the session spent any time in local hour h (0-23).
export function overlapsHour(s, h) { return splitByHour(s)[h] > 0; }

export function hourLabel(h) { return String(h).padStart(2, '0') + ':00'; }
export function hourRangeLabel(h) { return `${hourLabel(h)}–${hourLabel((Number(h) + 1) % 24)}`; }
