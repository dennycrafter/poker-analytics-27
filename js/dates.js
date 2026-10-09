// Local-time <-> UTC helpers. All timestamps are stored ISO-8601 UTC and
// displayed / input in the browser's local time (brief section 7 edge cases).

// 'date' -> YYYY-MM-DD, 'time' -> HH:MM in local time for an input value.
export function localInputValue(d, part) {
  const p = n => String(n).padStart(2, '0');
  if (part === 'date') return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Combine local date ('2026-04-12') + time ('21:30') into an ISO UTC string.
// Returns null when the inputs are invalid.
export function utcFromLocalInputs(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [y, mo, da] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(da) ||
      !Number.isFinite(h) || !Number.isFinite(mi)) return null;
  const d = new Date(y, mo - 1, da, h, mi, 0, 0);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
