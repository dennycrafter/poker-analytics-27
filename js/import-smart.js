// Smart import (brief iteration 1): format detection + parsers. PURE module:
// no DOM, no store, no network, no clock (callers pass nowMs for tests).
//
// Delegation over duplication: PA27's own CSV export and generic tables run
// through js/csv-import.js; PokerNow ledgers and game logs through
// js/pokernow-import.js. This module adds what those lack: the BankrollCoach
// cash template, pasted plain-text notes, XLSX extraction (vendored reader in
// ./vendor/xlsx.full.min.js) and one detectFormat entry point.
//
// Every parser returns drafts in the csv-import draft shape
//   { line, session, refs, currency, net_result, fingerprint, warnings }
// so one store path commits every source identically. `line` is the 1-based
// position of the row within the `rows` array the caller passed (or the
// physical line for text sources).
//
// Profit-only rows (a result but no buy-in / cash-out): the app derives net
// on read as cashed_out - buy_in - tips, so the profit is stored as
// buy_in 0 + cashed_out profit with a warning on the draft. Leaving the
// fields null would read back as net 0 and silently drop the user's result.
//
// Exports:
//   BANKROLLCOACH_HEADERS     the fixed BankrollCoach cash template, in order
//   detectFormat({headers, rows, text}) -> {kind, headers, rows, pokernowFormat?}
//     kind: 'bankrollcoach' | 'pa27-export' | 'pokernow' | 'generic-table'
//         | 'free-text' | 'unknown'
//   parseBankrollCoachRows(rows)   -> {kind, accepted, rejected, errors, summary}
//   parsePastedText(text, opts)    -> {sessions, unresolved}   (drafts; opts.nowMs)
//   parseGenericTable(headers, rows) -> {kind, headers, rows, mapping, suggestions}
//   parsePa27Export(text, opts)    -> delegation to csv-import's importCsv
//   parsePokernowFiles(files, config) -> delegation to pokernow's importPokerNow
//   parseXlsx(data)                -> async {kind:'xlsx', headers, rows, hasHeader}
//                                     | {kind:'xlsx-unsupported'|'xlsx-error', message}
//
// Committing a generic table or a PA27 export: importCsv(text, {mapping})
// from js/csv-import.js (mapping from parseGenericTable or the manual editor).

import {
  parseCsv, detectHeader, parseDateTime, parseDuration, parseAmount,
  suggestMapping, canonicalGame, sessionFingerprint, normalizeHeader, importCsv,
} from './csv-import.js';
import { SESSION_CSV_HEADERS } from './csv-export.js';
import { detectPokerNowFormat, importPokerNow, LOG_COLUMNS } from './pokernow-import.js';

// ---------------------------------------------------------------- helpers

const round2 = v => Math.round(v * 100) / 100;

// Plain count/number cells (hours, minutes, hands per hour). Blank -> null,
// unreadable -> { error }, else the number.
function numish(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const v = Number(s.replace(',', '.'));
  return Number.isFinite(v) ? v : { error: `"${s}" is not a number` };
}

// Date + time parts -> ISO-8601 UTC. No zone = local time, an explicit
// offset = that zone (the csv-import rule; its partsToMs twin).
function partsToIso(p) {
  const ms = p.offset !== null && p.offset !== undefined
    ? Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - p.offset * 60000
    : new Date(p.y, p.m - 1, p.d, p.h, p.mi, p.s).getTime();
  return new Date(ms).toISOString();
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthIndexOf = w => {
  const i = MONTHS.indexOf(String(w).slice(0, 3).toLowerCase());
  return i < 0 ? null : i + 1;
};

// ---------------------------------------------------------------- BankrollCoach

// The fixed BankrollCoach cash template. `game` holds stakes and variant:
// "5/10/20 PLO" = SB 5, BB 10, straddle 20, game PLO (BB is always the
// SECOND number; the word "straddle" is decoration).
export const BANKROLLCOACH_HEADERS = ['date', 'hours', 'minutes', 'buyin', 'cashout', 'result', 'location', 'game', 'hph'];

const BC_SET = new Set(BANKROLLCOACH_HEADERS);
const PA27_SET = new Set(SESSION_CSV_HEADERS.map(normalizeHeader));

// "5/10/20 PLO" / "2/5 NLH" / "10/25/50 PLO straddle" -> stakes + variant.
// Returns { small_blind, big_blind, straddle, variant } or { error }.
function parseCoachGame(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { error: 'Game is missing; it must hold stakes and a variant, e.g. 2/5 NLH' };
  const numRe = /\d+(?:[.,]\d+)?/g;
  const nums = [];
  let m;
  while ((m = numRe.exec(s))) nums.push(Number(m[0].replace(',', '.')));
  if (nums.length < 2) return { error: `Game "${s}" must hold stakes, e.g. 2/5 NLH` };
  const variant = s.replace(numRe, ' ').replace(/\bstraddle\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return {
    small_blind: nums[0],
    big_blind: nums[1],
    straddle: nums.length > 2 ? nums[2] : null,
    variant: variant ? canonicalGame(variant) : null,
  };
}

// Parses BankrollCoach cash template rows (arrays of cells, in template
// order). A leading header row is tolerated. Returns
// { kind, accepted, rejected, errors, summary } in the csv-import conventions.
export function parseBankrollCoachRows(rows) {
  const accepted = [], rejected = [];
  const dataRows = Array.isArray(rows) ? rows : [];
  let start = 0;
  if (dataRows.length && String(dataRows[0]?.[0] ?? '').trim().toLowerCase() === 'date') start = 1;

  for (let i = start; i < dataRows.length; i++) {
    const line = i + 1;
    const cells = (Array.isArray(dataRows[i]) ? dataRows[i] : []).map(c => String(c ?? '').trim());
    if (cells.every(c => !c)) continue; // trailing blank filler
    const reject = reasons => rejected.push({ line, reasons, cells });

    const dp = parseDateTime(cells[0], 'DMY');
    if (!dp || dp.error || !dp.hasDate) {
      reject([cells[0] ? `Date "${cells[0]}" is not readable` : 'Date is missing']);
      continue;
    }

    const hoursCell = numish(cells[1]);
    const minutesCell = numish(cells[2]);
    const numErr = [hoursCell, minutesCell].find(v => v && v.error);
    if (numErr) { reject([numErr.error]); continue; }
    if ((hoursCell !== null && hoursCell < 0) || (minutesCell !== null && minutesCell < 0)) {
      reject(['Duration cannot be negative']);
      continue;
    }
    // Hours wins; minutes / 60 is the fallback (brief rule).
    let durationHours, durationSeconds;
    if (hoursCell !== null) { durationHours = hoursCell; durationSeconds = Math.round(hoursCell * 3600); }
    else if (minutesCell !== null) { durationHours = minutesCell / 60; durationSeconds = Math.round(minutesCell * 60); }
    else { reject(['Hours or minutes is missing']); continue; }

    const buyin = parseAmount(cells[3], '.');
    const cashout = parseAmount(cells[4], '.');
    const result = parseAmount(cells[5], '.');
    const moneyErrors = [['Buy-in', buyin], ['Cashed out', cashout], ['Result', result]]
      .filter(([, p]) => p && p.error).map(([label, p]) => `${label}: ${p.error}`);
    const currencies = new Set([buyin, cashout, result].filter(p => p && p.currency).map(p => p.currency));
    if (currencies.size > 1) moneyErrors.push(`Row mixes currencies (${[...currencies].sort().join(', ')})`);
    if (moneyErrors.length) { reject(moneyErrors); continue; }

    const buyinV = buyin ? buyin.value : null;
    const cashoutV = cashout ? cashout.value : null;
    const resultV = result ? result.value : null;
    if (buyinV !== null && buyinV < 0) { reject(['Buy-in cannot be negative']); continue; }
    if (cashoutV !== null && cashoutV < 0) { reject(['Cashed out cannot be negative']); continue; }

    const game = parseCoachGame(cells[7]);
    if (game.error) { reject([game.error]); continue; }

    const warnings = [];
    let buyIn = buyinV, cashedOut = cashoutV, net;
    if (resultV === null) {
      if (buyIn === null || cashedOut === null) {
        reject([buyIn === null && cashedOut === null ? 'Buy-in or result is missing' : 'Cashed out is missing (or fill result)']);
        continue;
      }
      net = round2(cashedOut - buyIn);
    } else if (buyIn === null && cashedOut === null) {
      // Profit only (brief rule): keep it readable by the read-time net math.
      buyIn = 0;
      cashedOut = round2(resultV);
      net = round2(resultV);
      warnings.push('No buy-in or cash-out; stored the result as the profit');
    } else if (cashedOut === null) {
      cashedOut = round2(buyIn + resultV);
      net = round2(resultV);
      if (cashedOut < 0) { reject(['Result loses more than the buy-in']); continue; }
    } else if (buyIn === null) {
      buyIn = round2(cashedOut - resultV);
      net = round2(resultV);
      if (buyIn < 0) { reject(['Buy-in cannot be negative']); continue; }
    } else {
      net = round2(cashedOut - buyIn);
      if (Math.abs(net - resultV) > 0.005) warnings.push('Result does not match cash out minus buy-in; used cash out and buy-in');
    }

    const hph = numish(cells[8]);
    if (hph && hph.error) { reject([hph.error]); continue; }
    if (hph !== null && hph < 0) { reject(['Hands per hour cannot be negative']); continue; }
    const hands = hph !== null ? Math.round(hph * durationHours) : null;

    if (game.straddle !== null) warnings.push('Game has a straddle; stored small blind and big blind only');

    const startIso = partsToIso(dp);
    const session = {
      kind: 'cash',
      start_time: startIso,
      end_time: new Date(new Date(startIso).getTime() + durationSeconds * 1000).toISOString(),
      duration_seconds: durationSeconds,
      break_seconds: 0,
      table_size: null,
      hands_count: hands,
      hands_count_estimated: false,
      comment: null,
      opponents: null,
      is_live: false,
      tracked_via_stack: false,
      small_blind: game.small_blind,
      big_blind: game.big_blind,
      buy_in: buyIn,
      cashed_out: cashedOut,
      tips: 0,
    };
    accepted.push({
      line,
      session,
      refs: {
        game: game.variant || null,
        location: cells[6].replace(/\s+/g, ' ') || null,
        bankroll: null,
        group: null,
        tournament_type: null,
      },
      currency: currencies.size === 1 ? [...currencies][0] : null,
      net_result: net,
      fingerprint: sessionFingerprint(session, net),
      warnings,
    });
  }

  const summary = {
    totalRows: accepted.length + rejected.length,
    accepted: accepted.length,
    rejected: rejected.length,
    duplicates: 0,
    netTotal: round2(accepted.reduce((a, d) => a + d.net_result, 0)),
  };
  const errors = rejected.flatMap(r => r.reasons.map(reason => ({ line: r.line, reason })));
  return { kind: 'bankrollcoach', accepted, rejected, errors, summary };
}

// ---------------------------------------------------------------- detection

function headersMatchSet(headers, set) {
  const cols = headers.map(normalizeHeader).filter(Boolean);
  return cols.length >= 5 && cols.every(h => set.has(h));
}

// PokerNow log columns (normalized: underscores became spaces). Ledger
// detection keys on its two unmistakable columns, like detectPokerNowFormat.
const LOG_SET = LOG_COLUMNS.map(normalizeHeader);

// One entry point for the import screen. Give it what you have: headers and
// rows (already extracted, e.g. from a spreadsheet), or the raw text. When
// only text is given, it is CSV-parsed first; text that is not a table is
// 'free-text' (paste-anything path). Always returns headers/rows when they
// are known so the caller does not have to parse twice.
export function detectFormat(input = {}) {
  const text = input.text == null ? null : String(input.text);
  let { headers = null, rows = null } = input;
  if ((!headers || !rows) && text && text.trim()) {
    const { records } = parseCsv(text);
    if (records.length && detectHeader(records)) {
      headers = records[0].cells.map(h => h.trim());
      rows = records.slice(1).map(r => r.cells);
    }
  }

  // PokerNow first: its column names are unmistakable.
  if (text && text.trim()) {
    const pn = detectPokerNowFormat(text);
    if (pn !== 'unknown') return { kind: 'pokernow', pokernowFormat: pn, headers, rows };
  }
  if (headers) {
    const cols = new Set(headers.map(normalizeHeader).filter(Boolean));
    if (cols.has('player nickname') || cols.has('player id')) return { kind: 'pokernow', pokernowFormat: 'ledger', headers, rows };
    if (LOG_SET.every(c => cols.has(c))) return { kind: 'pokernow', pokernowFormat: 'log', headers, rows };
  }

  if (headers) {
    // Every non-empty header is a PA27 session column (>= 5 of them): the
    // app's own export, round-trips through csv-import's mapper.
    if (headersMatchSet(headers, PA27_SET)) return { kind: 'pa27-export', headers, rows };
    // The fixed BankrollCoach template (all nine names, any order).
    const cols = headers.map(normalizeHeader).filter(Boolean);
    if (cols.length && BANKROLLCOACH_HEADERS.every(h => cols.includes(h))) return { kind: 'bankrollcoach', headers, rows };
    if (cols.length) return { kind: 'generic-table', headers, rows };
  }

  // A header row left inside `rows` (caller did not strip it).
  if (!headers && rows && rows.length) {
    const first = rows[0].map(c => String(c ?? ''));
    if (BANKROLLCOACH_HEADERS.every(h => first.map(normalizeHeader).includes(h))) {
      return { kind: 'bankrollcoach', headers: first, rows: rows.slice(1) };
    }
    if (headersMatchSet(first, PA27_SET)) return { kind: 'pa27-export', headers: first, rows: rows.slice(1) };
    return { kind: 'generic-table', headers: first, rows: rows.slice(1) };
  }

  if (rows && rows.length) return { kind: 'generic-table', headers, rows };
  if (text && text.trim()) return { kind: 'free-text', headers: null, rows: null };
  return { kind: 'unknown', headers: null, rows: null };
}

// ---------------------------------------------------------------- pasted text

const SYMBOL_CURRENCY = { $: 'USD', '€': 'EUR', '£': 'GBP' };

// One pasted line: "Oct 3 1/2 at Lodge +340 5h". Date leads; stakes come
// right after; location ("at X"), a signed or $-prefixed result, a duration
// and leftover junk are found anywhere. Returns a draft or { error }.
function parsePastedLine(line, nowMs, lineNo) {
  const warnings = [];
  const d = takePastedDate(line, nowMs);
  if (!d) return { error: 'No date found at the start (try "Oct 3" or "2025-10-03")' };
  warnings.push(...d.warnings);
  const rest = line.slice(d.length);
  const spans = [];

  // Stakes directly after the date: 1/2, $1/$2, 1/2/5 (straddle). BB is the
  // second number, the same rule as the BankrollCoach game cell.
  let stakes = null;
  const sm = rest.match(/^\s*([$€£])?\s*(\d+(?:[.,]\d+)?)\s*\/\s*(?:[$€£])?\s*(\d+(?:[.,]\d+)?)(?:\s*\/\s*(?:[$€£])?\s*(\d+(?:[.,]\d+)?))?(?![\d/])/);
  if (sm) {
    stakes = {
      small_blind: Number(sm[2].replace(',', '.')),
      big_blind: Number(sm[3].replace(',', '.')),
      currency: sm[1] ? SYMBOL_CURRENCY[sm[1]] : null,
    };
    spans.push([sm.index, sm.index + sm[0].length]);
  }

  // Result: signed ("+340", "-1100") or $-prefixed ("$40", "$-40"). A bare
  // number is deliberately not a result: it could be anything.
  let result = null, resultCurrency = null;
  const candidates = [];
  const signed = rest.match(/[+-]\s*[$€£]?\s*\d+(?:[.,]\d+)?/);
  if (signed) candidates.push(signed);
  const moneyed = rest.match(/[$€£]\s*-?\s*\d+(?:[.,]\d+)?/);
  if (moneyed) candidates.push(moneyed);
  const rm = candidates.sort((a, b) => a.index - b.index)[0];
  if (rm) {
    const t = rm[0].replace(/[$€£\s]/g, '');
    result = Number(t);
    const sym = rm[0].match(/[$€£]/);
    resultCurrency = sym ? SYMBOL_CURRENCY[sym[0]] : null;
    spans.push([rm.index, rm.index + rm[0].length]);
  }

  // Location: "at X" up to the result, duration or end of line.
  let location = null;
  const lm = rest.match(/\b(?:at|@)\s+([^,;+]*?)(?=\s*(?:[,;]|[+-]\s*[$€£]?\s*\d|[$€£]\s*-?\s*\d|\d{1,2}:\d{2}\b|\d+(?:[.,]\d+)?\s*(?:h(?:rs?|ours?)?\b|m(?:in(?:utes?)?)?\b)|\s*$))/i);
  if (lm && lm[1].trim()) {
    location = lm[1].trim().replace(/\s+/g, ' ').replace(/[.,;]+$/, '') || null;
    spans.push([lm.index, lm.index + lm[0].length]);
  }

  // Duration: H:MM, 5h, 4h45m, 5.5h, 2 hours 30, 90m. H:MM followed by
  // am/pm is a time of day, not a duration.
  const durPatterns = [
    /\b\d{1,2}:\d{2}\b(?!\s*[ap]\.?m?\b)/i,
    /\b\d+(?:[.,]\d+)?\s*h(?:rs?|ours?)?\s*(?:\d{1,2}\s*(?:m(?:in(?:utes?)?)?)?)?/i,
    /\b\d+\s*m(?:in(?:utes?)?)?\b/i,
  ];
  let durationSeconds = null, durMatch = null;
  for (const re of durPatterns) {
    const m = rest.match(re);
    if (m && (!durMatch || m.index < durMatch.index)) durMatch = m;
  }
  if (durMatch) {
    // "5h30" / "2 hours 30": parseDuration wants an explicit m, so add it.
    let durText = durMatch[0].trim();
    const hm = durText.match(/^(\d+(?:[.,]\d+)?)\s*h(?:ours?|rs?)?\s*(\d{1,2})$/i);
    if (hm) durText = `${hm[1]}h${hm[2]}m`;
    const p = parseDuration(durText);
    if (p && !p.error) {
      durationSeconds = p;
      spans.push([durMatch.index, durMatch.index + durMatch[0].length]);
    } else {
      warnings.push(`Could not read the duration "${durMatch[0].trim()}"`);
    }
  }

  // Anything unreadable left over? Blank the matched spans (same length, so
  // the indexes stay valid) and look for surviving letters or digits.
  spans.sort((a, b) => a[0] - b[0]);
  let junk = rest;
  for (const [a, b] of spans) junk = junk.slice(0, a) + ' '.repeat(b - a) + junk.slice(b);
  const leftover = junk.replace(/[^A-Za-z0-9]+/g, ' ').trim();
  if (leftover) warnings.push(`Could not read part of the line: "${leftover}"`);

  if (!stakes && result === null && durationSeconds === null) {
    return { error: 'No stakes, result or duration found after the date' };
  }

  const net = result === null ? 0 : round2(result);
  if (result === null) warnings.push('No result found; stored 0');
  const session = {
    kind: 'cash',
    start_time: d.iso,
    end_time: durationSeconds !== null ? new Date(Date.parse(d.iso) + durationSeconds * 1000).toISOString() : null,
    duration_seconds: durationSeconds,
    break_seconds: 0,
    table_size: null,
    hands_count: null,
    hands_count_estimated: false,
    comment: null,
    opponents: null,
    is_live: false,
    tracked_via_stack: false,
    small_blind: stakes ? stakes.small_blind : null,
    big_blind: stakes ? stakes.big_blind : null,
    buy_in: 0,
    cashed_out: net,
    tips: 0,
  };
  return {
    draft: {
      line: lineNo,
      session,
      refs: { game: null, location, bankroll: null, group: null, tournament_type: null },
      currency: (stakes && stakes.currency) || resultCurrency || null,
      net_result: net,
      fingerprint: sessionFingerprint(session, net),
      warnings,
    },
  };
}

// Date at the start of a pasted line. Month-name dates may omit the year
// ("Oct 3"): this year, or last year when that day is still ahead. Numeric
// dates need a year ("10/3/2025"); a bare "1/2" is stakes, not a date.
function takePastedDate(line, nowMs) {
  let m = line.match(/^([a-z]{3,9})\.?,?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i);
  if (m) {
    const mo = monthIndexOf(m[1]);
    const day = Number(m[2]);
    if (mo && day >= 1 && day <= 31) {
      const warnings = [];
      let year = m[3] ? Number(m[3]) : null;
      if (year === null) {
        year = new Date(nowMs).getFullYear();
        if (new Date(year, mo - 1, day).getTime() > nowMs) year -= 1;
        warnings.push(`No year in the date; assumed ${year}`);
      }
      const p = parseDateTime(`${MONTHS[mo - 1]} ${day} ${year}`, 'DMY');
      if (p && !p.error && p.hasDate) return { iso: partsToIso(p), warnings, length: m[0].length };
    }
  }
  m = line.match(/^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})(?!\d)/);
  if (m) {
    const p = parseDateTime(m[1], 'DMY');
    if (p && !p.error && p.hasDate) return { iso: partsToIso(p), warnings: [], length: m[1].length };
  }
  m = line.match(/^(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})(?!\d)/);
  if (m) {
    const p = parseDateTime(m[1], 'DMY');
    if (p && !p.error && p.hasDate) return { iso: partsToIso(p), warnings: [], length: m[1].length };
  }
  return null;
}

// Best-effort parser for pasted notes. Lines that parse become drafts in the
// csv-import shape; the rest come back in `unresolved` with a reason, so the
// screen can flag them instead of guessing.
export function parsePastedText(text, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const sessions = [], unresolved = [];
  String(text ?? '').split(/\r\n?|\n/).forEach((rawLine, idx) => {
    const line = rawLine.trim();
    if (!line) return;
    const lineNo = idx + 1;
    const parsed = parsePastedLine(line, nowMs, lineNo);
    if (parsed.error) unresolved.push({ line: lineNo, text: line, reason: parsed.error });
    else sessions.push(parsed.draft);
  });
  return { sessions, unresolved };
}

// ---------------------------------------------------------------- generic + delegation

// A table nobody's format matched: pass it through, prepared for the mapping
// screen. `mapping`/`suggestions` come from csv-import's suggestMapping; the
// suggested mapping already covers tournaments (buy-in, entries, place,
// prize) when those columns are present. Commit with importCsv(text,
// { mapping }) from js/csv-import.js.
export function parseGenericTable(headers, rows) {
  const h = (Array.isArray(headers) ? headers : []).map(c => String(c ?? '').trim());
  const r = (Array.isArray(rows) ? rows : []).map(row => (Array.isArray(row) ? row : []).map(c => String(c ?? '').trim()));
  const { mapping, suggestions } = suggestMapping(h, r.slice(0, 25));
  return { kind: 'generic-table', headers: h, rows: r, mapping, suggestions };
}

// PA27's own export: detectFormat tags it, csv-import does the rest.
export function parsePa27Export(text, opts = {}) {
  return importCsv(text, opts);
}

// PokerNow files: detectFormat tags them, pokernow-import does the rest.
// `files` is [{ name, text }], exactly what importPokerNow takes.
export function parsePokernowFiles(files, config = {}) {
  return importPokerNow(files, config);
}

// ---------------------------------------------------------------- XLSX

// Spreadsheet cells -> plain strings (the module's row currency). Dates keep
// their LOCAL calendar day: a midnight Date formatted with toISOString would
// shift a day in half the world.
function cellToString(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) {
    const p = n => String(n).padStart(2, '0');
    const date = `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
    const hasTime = v.getHours() || v.getMinutes() || v.getSeconds();
    return hasTime ? `${date} ${p(v.getHours())}:${p(v.getMinutes())}` : date;
  }
  return String(v);
}

// Reads the first sheet of an XLSX file (ArrayBuffer or Uint8Array) into
// headers + rows of strings. The reader is the vendored SheetJS standalone
// build, imported lazily so the module stays light. If the vendored reader
// is unavailable the caller gets 'xlsx-unsupported' with a friendly message.
export async function parseXlsx(data) {
  let XLSX = null;
  try {
    ({ XLSX } = await import('./vendor/xlsx.full.min.js'));
  } catch {
    return { kind: 'xlsx-unsupported', message: 'Spreadsheet reading is not available. Save the sheet as CSV and import that instead.' };
  }
  let wb = null;
  try {
    wb = XLSX.read(data, { type: 'array', cellDates: true });
  } catch {
    return { kind: 'xlsx-error', message: 'The spreadsheet could not be read.' };
  }
  const name = wb.SheetNames[0];
  if (!name) return { kind: 'xlsx-error', message: 'The spreadsheet has no sheets.' };
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' })
    .map(row => row.map(cellToString));
  const hasHeader = grid.length > 0 && detectHeader(grid.map(cells => ({ cells })));
  return {
    kind: 'xlsx',
    headers: hasHeader ? grid[0] : null,
    rows: hasHeader ? grid.slice(1) : grid,
    hasHeader,
  };
}
