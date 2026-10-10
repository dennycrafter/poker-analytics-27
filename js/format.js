// Formatting helpers. Timestamps are stored ISO-8601 UTC; all display is local time.

export const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

export function getCurrency(doc) {
  return (doc && doc.settings && doc.settings.currency) || 'EUR';
}

// Round to 2 decimals, then strip trailing zeros: 16.80 -> "16.8", 16 -> "16", 0.1 -> "0.1".
export function fmtNum(n) {
  const v = Math.round(Number(n) * 100) / 100;
  if (!Number.isFinite(v)) return '--';
  return String(parseFloat(v.toFixed(2)));
}

// Positive: "EUR 16.8" (no plus). Negative: "-EUR 12.5" (minus sign).
export function fmtMoney(amount, currency = 'EUR') {
  if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return '--';
  const a = Number(amount);
  // Round to cents before the sign check so a tiny negative (-0.004) cannot
  // render as a negative zero (ISSUES.md #9).
  const cents = Math.round(a * 100);
  return (cents < 0 ? '-' : '') + currency + ' ' + fmtNum(Math.abs(cents) / 100);
}

export function moneyClass(amount) {
  const a = Number(amount);
  if (!Number.isFinite(a) || a === 0) return 'zero';
  return a > 0 ? 'pos' : 'neg';
}

// seconds -> "H:MM" (e.g. 12300 -> "3:25")
export function fmtDur(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '--';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h + ':' + String(m).padStart(2, '0');
}

export function fmtHours(hours) { return fmtDur((Number(hours) || 0) * 3600); }

// Live timer split: big part "H:MM" + small seconds suffix ":SS"
export function fmtTimer(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = n => String(n).padStart(2, '0');
  return { main: h + ':' + p(m), sec: ':' + p(sec) };
}

export function weekdayAbbr(d) { return WEEKDAYS[d.getDay()]; }
export function dayNum(d) { return String(d.getDate()).padStart(2, '0'); }
export function monthLabel(d) { return MONTHS[d.getMonth()] + ' ' + d.getFullYear(); }
export function monthKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }

function p2(n) { return String(n).padStart(2, '0'); }
export function fmtClock(d) { return p2(d.getHours()) + ':' + p2(d.getMinutes()); }
export function fmtDateShort(d) { return d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getFullYear(); }
export function fmtDateTime(d) { return fmtDateShort(d) + ', ' + fmtClock(d); }

// datetime-local helpers (local time strings)
export function toLocalInputValue(d) {
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) +
    'T' + p2(d.getHours()) + ':' + p2(d.getMinutes());
}
export function fromLocalInputValue(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
