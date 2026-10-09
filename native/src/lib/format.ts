// Formatting helpers, ported from js/format.js. Timestamps are stored
// ISO-8601 UTC; every display and grouping uses device-local time.

export const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/** Round to 2 decimals, then strip trailing zeros: 16.80 -> "16.8". */
export function fmtNum(n: number): string {
  const v = Math.round(Number(n) * 100) / 100;
  if (!Number.isFinite(v)) return '--';
  return String(parseFloat(v.toFixed(2)));
}

/** Positive "EUR 16.8" (no plus), negative "-EUR 12.5". */
export function fmtMoney(amount: number | null | undefined, currency = 'EUR'): string {
  if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return '--';
  const a = Number(amount);
  return (a < 0 ? '-' : '') + currency + ' ' + fmtNum(Math.abs(a));
}

export type Tone = 'pos' | 'neg' | 'zero';

export function moneyTone(amount: number | null | undefined): Tone {
  const a = Number(amount);
  if (amount === null || amount === undefined || !Number.isFinite(a) || a === 0) return 'zero';
  return a > 0 ? 'pos' : 'neg';
}

/** seconds -> "H:MM" (12300 -> "3:25"). */
export function fmtDur(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '--';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h + ':' + String(m).padStart(2, '0');
}

export function fmtHours(hours: number): string {
  return fmtDur((Number(hours) || 0) * 3600);
}

/** Live timer: big "H:MM" plus small ":SS". */
export function fmtTimer(seconds: number): { main: string; sec: string } {
  const s = Math.max(0, Math.floor(seconds));
  const p = (n: number) => String(n).padStart(2, '0');
  return { main: Math.floor(s / 3600) + ':' + p(Math.floor((s % 3600) / 60)), sec: ':' + p(s % 60) };
}

const p2 = (n: number) => String(n).padStart(2, '0');

export function weekdayAbbr(d: Date): string { return WEEKDAYS[d.getDay()]; }
export function dayNum(d: Date): string { return p2(d.getDate()); }
export function monthLabel(d: Date): string { return MONTHS[d.getMonth()] + ' ' + d.getFullYear(); }
export function monthKey(d: Date): string { return d.getFullYear() + '-' + p2(d.getMonth() + 1); }
export function fmtClock(d: Date): string { return p2(d.getHours()) + ':' + p2(d.getMinutes()); }
export function fmtDateShort(d: Date): string {
  return d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getFullYear();
}
export function fmtDateTime(d: Date): string { return fmtDateShort(d) + ', ' + fmtClock(d); }

/** Local "YYYY-MM-DD HH:MM" for a text input (no native date picker dependency). */
export function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** Parse a local "YYYY-MM-DD HH:MM" (or "YYYY-MM-DDTHH:MM") string. Null when invalid. */
export function fromLocalInput(v: string): Date | null {
  const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})\s*$/.exec(v || '');
  if (!m) return null;
  const [y, mo, da, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59) return null;
  const d = new Date(y, mo - 1, da, h, mi, 0, 0);
  // Reject roll-over dates like 2026-02-31.
  if (d.getMonth() !== mo - 1 || d.getDate() !== da) return null;
  return d;
}

/** Parse a user-typed decimal ("12,5" or "12.5"). Null for empty/invalid. */
export function parseAmount(raw: string): number | null {
  const t = String(raw ?? '').trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
