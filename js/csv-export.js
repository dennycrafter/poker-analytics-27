// CSV export for sessions and bankroll transactions (STEP E).
//
// The header row is the contract: every column name is chosen so the import
// mapper (js/csv-import.js matchHeader) maps it back to its field, which makes
// export → import a round-trip (tests/stepe-csv-export.test.mjs). Money cells
// are plain numbers with at most 2 decimals; durations are H:MM:SS; timestamps
// are the stored UTC ISO strings. Live sessions are excluded — they have no
// end time yet and the mapper only imports ended sessions.
//
// Rows tracked via stack events (live sessions that were cashed out) export
// the derived event totals as buy-in / cashed out, so a re-import rebuilds an
// equivalent direct-money session.

import { endedSessions, stackBuyIn, stackCashedOut, netResult } from './stats.js';

const round2 = v => Math.round(v * 100) / 100;

// Money as a plain number, at most 2 decimals: "20", "16.8", "-12.5".
function moneyCell(v) {
  if (v === null || v === undefined || v === '') return '';
  return String(round2(Number(v)));
}

// H:MM:SS — parseDuration reads it back as exact seconds.
function hmsCell(sec) {
  if (sec === null || sec === undefined || sec === '') return '';
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// RFC 4180 cell: quote when the value contains the delimiter, a quote, a
// newline or a semicolon (some spreadsheet tools auto-detect ';' as the
// delimiter, and an unquoted semicolon would corrupt such a round-trip).
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",;\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const toCsv = (headers, rows) =>
  [headers.join(','), ...rows.map(r => r.map(csvCell).join(','))].join('\n') + '\n';

export const SESSION_CSV_HEADERS = [
  'Kind', 'Start time', 'End time', 'Duration', 'Break', 'Game', 'Stakes',
  'Buy-in', 'Cashed out', 'Net result', 'Tips', 'Hands', 'Table size',
  'Location', 'Bankroll', 'Group', 'Tournament type', 'Tournament name',
  'Initial buy-in', 'Total buy-in', 'Prize', 'Position', 'Entries',
  'Currency', 'Comment', 'Opponents',
];

export const TRANSACTION_CSV_HEADERS = ['Date', 'Bankroll', 'Kind', 'Amount', 'Description'];

const nameOf = (doc, list, id) => (id ? doc[list].find(x => x.id === id)?.name ?? '' : '');

/**
 * Export ended sessions to CSV. `sessions` defaults to the document's ended
 * sessions in stored order. Returns the file text (header + rows, LF endings).
 */
export function sessionsCsv(doc, sessions = endedSessions(doc)) {
  const rows = sessions.map(s => {
    const cash = s.kind === 'cash';
    const buyIn = cash ? (s.tracked_via_stack ? stackBuyIn(doc, s) : s.buy_in) : null;
    const cashedOut = cash ? (s.tracked_via_stack ? stackCashedOut(doc, s) : s.cashed_out) : null;
    const duration = s.duration_seconds ?? (s.end_time
      ? Math.max(0, Math.round((Date.parse(s.end_time) - Date.parse(s.start_time)) / 1000)) : null);
    return [
      s.kind,
      s.start_time ?? '',
      s.end_time ?? '',
      hmsCell(duration),
      hmsCell(s.break_seconds),
      nameOf(doc, 'games', s.game_id),
      cash && (s.small_blind != null || s.big_blind != null) ? `${s.small_blind ?? ''}/${s.big_blind ?? ''}` : '',
      moneyCell(buyIn),
      moneyCell(cashedOut),
      moneyCell(netResult(doc, s)),
      moneyCell(s.tips ?? 0),
      s.hands_count ?? '',
      s.table_size ?? '',
      nameOf(doc, 'locations', s.location_id),
      nameOf(doc, 'bankrolls', s.bankroll_id),
      nameOf(doc, 'groups', s.group_id),
      nameOf(doc, 'tournament_types', s.tournament_type_id),
      s.tournament_name ?? '',
      moneyCell(s.initial_buy_in),
      moneyCell(s.total_buy_in),
      moneyCell(s.prize),
      s.position ?? '',
      s.entries ?? '',
      doc.currency || 'EUR',
      s.comment ?? '',
      s.opponents ?? '',
    ];
  });
  return toCsv(SESSION_CSV_HEADERS, rows);
}

/**
 * Export the bankroll transaction ledger to CSV. Bankroll ids resolve to
 * names (unnamed bankroll = "Bankroll"). Feeding this file back into the
 * session importer is rejected at the mapping step (no End time / Duration).
 */
export function transactionsCsv(doc) {
  const rows = (doc.transactions ?? []).map(t => [
    t.occurred_at ?? '',
    nameOf(doc, 'bankrolls', t.bankroll_id) || 'Bankroll',
    t.kind ?? 'other',
    moneyCell(t.amount),
    t.description ?? '',
  ]);
  return toCsv(TRANSACTION_CSV_HEADERS, rows);
}

/** Download filename for a CSV export, e.g. pa27-sessions-2026-10-10.csv. */
export function csvExportFilename(kind, nowMs = Date.now()) {
  const base = kind === 'bankroll' ? 'pa27-bankroll' : 'pa27-sessions';
  return `${base}-${new Date(nowMs).toISOString().slice(0, 10)}.csv`;
}
