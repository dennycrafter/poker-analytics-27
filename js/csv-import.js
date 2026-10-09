// CSV import (pure, dependency-free). Turns a CSV file from a spreadsheet or
// another tracker into session drafts shaped like the build brief's Session
// model, without touching the store. Imports nothing: the screen/store wiring
// resolves reference names to ids and writes the drafts.
//
// Pipeline:
//   analyzeCsv(text)                 parse + header detection + suggested mapping
//   buildImport(analysis, mapping)   validate every row -> accepted / rejected + summary
//   importCsv(text, opts)            both in one call (uses the suggested mapping)
//
// A mapping is an array with one entry per file column: a field key from
// IMPORT_FIELDS, or null to ignore the column. It is plain JSON so a UI can
// edit it column by column and hand it back.
//
// Accepted draft: { line, session, refs, currency, net_result, fingerprint, warnings }
//   session  - brief Session fields (no ids, no created_at), is_live false,
//              tracked_via_stack false: imported cash buy-ins live in the
//              buy_in column, never in stack events (brief section 4).
//   refs     - names to resolve to ids: { game, location, bankroll, group,
//              tournament_type }; null means "use the app default".
// Rejected row: { line, reasons: [string], cells }. `line` is the physical
// file line the record starts on (header = line 1), as a text editor shows it.
//
// Times without a zone are local time (brief section 7); a trailing Z or
// +hh:mm offset is honoured. Output timestamps are ISO-8601 UTC.

export const IMPORT_FIELDS = [
  { key: 'kind', label: 'Session type', aliases: ['kind', 'type', 'session type', 'game type', 'format', 'cash tournament', 'category'] },
  { key: 'date', label: 'Date', aliases: ['date', 'day', 'session date', 'played on', 'played'] },
  { key: 'start_time', label: 'Start time', aliases: ['start', 'start time', 'started', 'start date', 'starttime', 'begin', 'from'] },
  { key: 'end_time', label: 'End time', aliases: ['end', 'end time', 'ended', 'end date', 'endtime', 'stop', 'until'] },
  { key: 'duration', label: 'Duration (hours or H:MM)', aliases: ['duration', 'length', 'hours', 'time played', 'playing time', 'hours played', 'session length'] },
  { key: 'duration_minutes', label: 'Duration (minutes)', aliases: ['duration minutes', 'duration min', 'minutes', 'minutes played', 'mins'] },
  { key: 'break', label: 'Break (minutes or H:MM)', aliases: ['break', 'breaks', 'break time', 'pause', 'break minutes'] },
  { key: 'game', label: 'Game', aliases: ['game', 'variant', 'game name', 'poker game'] },
  { key: 'stakes', label: 'Stakes (SB/BB)', aliases: ['stakes', 'blinds', 'stake', 'limit'] },
  { key: 'small_blind', label: 'Small blind', aliases: ['sb', 'small blind', 'smallblind'] },
  { key: 'big_blind', label: 'Big blind', aliases: ['bb', 'big blind', 'bigblind'] },
  { key: 'buy_in', label: 'Buy-in', aliases: ['buy in', 'buyin', 'buyins', 'buy ins', 'invested', 'cost'] },
  { key: 'cashed_out', label: 'Cashed out', aliases: ['cashed out', 'cash out', 'cashout', 'cashedout', 'end stack', 'final stack'] },
  { key: 'net_result', label: 'Net result', aliases: ['net', 'net result', 'profit', 'result', 'win loss', 'winloss', 'p l', 'pnl', 'profit loss', 'won lost'] },
  { key: 'tips', label: 'Tips', aliases: ['tips', 'tip', 'dealer tips', 'tokes'] },
  { key: 'hands_count', label: 'Hands count', aliases: ['hands', 'hands count', 'hands played', 'number of hands', 'hand count'] },
  { key: 'table_size', label: 'Table size', aliases: ['table size', 'tablesize', 'table', 'max', 'seats', 'table type'] },
  { key: 'location', label: 'Location', aliases: ['location', 'venue', 'casino', 'room', 'where', 'club', 'site'] },
  { key: 'bankroll', label: 'Bankroll', aliases: ['bankroll', 'account', 'wallet'] },
  { key: 'group', label: 'Group', aliases: ['group', 'series', 'league'] },
  { key: 'tournament_type', label: 'Tournament type', aliases: ['tournament type', 'tourney type', 'tournament format'] },
  { key: 'tournament_name', label: 'Tournament name', aliases: ['tournament name', 'tournament', 'tourney', 'event', 'event name', 'name', 'title'] },
  { key: 'initial_buy_in', label: 'Initial buy-in', aliases: ['initial buy in', 'initial buyin', 'entry fee', 'entry', 'base buy in'] },
  { key: 'total_buy_in', label: 'Total buy-in', aliases: ['total buy in', 'total buyin', 'total invested', 'total cost'] },
  { key: 'prize', label: 'Prize', aliases: ['prize', 'winnings', 'payout', 'prize money', 'cashed'] },
  { key: 'position', label: 'Position', aliases: ['position', 'finish', 'finished', 'rank', 'pos', 'place', 'finishing position'] },
  { key: 'entries', label: 'Entries', aliases: ['entries', 'entrants', 'field size', 'field', 'runners'] },
  { key: 'currency', label: 'Currency', aliases: ['currency', 'cur', 'ccy', 'curr'] },
  { key: 'comment', label: 'Comment', aliases: ['comment', 'comments', 'note', 'notes', 'description', 'memo'] },
  { key: 'opponents', label: 'Opponents', aliases: ['opponents', 'villains'] },
];

export const FIELD_KEYS = IMPORT_FIELDS.map(f => f.key);
const FIELD_BY_KEY = Object.fromEntries(IMPORT_FIELDS.map(f => [f.key, f]));
const MONEY_FIELDS = ['buy_in', 'cashed_out', 'net_result', 'tips', 'initial_buy_in', 'total_buy_in', 'prize'];
const DATE_FIELDS = ['date', 'start_time', 'end_time'];

export const DEFAULT_MAX_ROWS = 50000;

// ---------------------------------------------------------------- RFC 4180

const DELIMITERS = [',', ';', '\t', '|'];

// Delimiter with the most consistent per-line count over the first lines.
// Semicolon matters: European spreadsheet exports use it with decimal commas.
export function detectDelimiter(text) {
  const sample = text.slice(0, 64 * 1024);
  let best = ',', bestScore = 0;
  for (const d of DELIMITERS) {
    const counts = delimiterCounts(sample, d, 20);
    const mode = modeOf(counts);
    if (!mode) continue;
    const score = counts.filter(c => c === mode).length * 1000 + mode;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

function delimiterCounts(text, d, maxLines) {
  const out = [];
  let n = 0, inQuote = false, content = false;
  for (let i = 0; i < text.length && out.length < maxLines; i++) {
    const c = text[i];
    if (c === '"') { inQuote = !inQuote; content = true; } else if (inQuote) continue;
    else if (c === d) { n++; content = true; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (content) out.push(n);
      n = 0; content = false;
    } else if (c.trim()) content = true;
  }
  if (content && out.length < maxLines) out.push(n);
  return out;
}

function modeOf(nums) {
  const freq = new Map();
  let best = 0, bestN = 0;
  for (const n of nums) {
    const f = (freq.get(n) || 0) + 1;
    freq.set(n, f);
    if (f > bestN || (f === bestN && n > best)) { best = n; bestN = f; }
  }
  return best;
}

function countLineBreaks(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\n') n++;
    else if (c === '\r' && s[i + 1] !== '\n') n++;
  }
  return n;
}

// Parses RFC 4180 CSV: quoted fields with "" escapes, delimiters and line
// breaks inside quotes, CRLF / LF / CR endings, a leading UTF-8 BOM.
// Lenient where real exports are sloppy: a quote inside an unquoted field is
// literal text. Fully blank records (including ",,,") are skipped.
// Returns { delimiter, records: [{ line, cells, error? }] }; a record with
// `error` is malformed and will be rejected by buildImport.
export function parseCsv(text, { delimiter } = {}) {
  if (typeof text !== 'string') throw new TypeError('parseCsv expects a string');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const d = delimiter || detectDelimiter(text);
  const len = text.length;
  const records = [];
  let cells = [], field = '', error = null;
  let line = 1, recordLine = 1, atFieldStart = true, i = 0;

  const endRecord = () => {
    cells.push(field);
    const blank = cells.every(c => c.trim() === '');
    if (error) records.push({ line: recordLine, cells, error });
    else if (!blank) records.push({ line: recordLine, cells });
    cells = []; field = ''; error = null;
  };

  while (i < len) {
    if (atFieldStart && text[i] === '"') {
      const openLine = line;
      let buf = '';
      i++;
      for (;;) {
        const q = text.indexOf('"', i);
        if (q === -1) {
          buf += text.slice(i);
          i = len;
          error = error || `Unterminated quoted field (opened on line ${openLine})`;
          break;
        }
        if (text[q + 1] === '"') { buf += text.slice(i, q + 1); i = q + 2; continue; }
        buf += text.slice(i, q);
        i = q + 1;
        break;
      }
      line += countLineBreaks(buf);
      field = buf.replace(/\r\n?/g, '\n');
      atFieldStart = false;
      if (i < len && text[i] !== d && text[i] !== '\n' && text[i] !== '\r') {
        error = error || `Unexpected text after a closing quote on line ${line}`;
      }
      continue;
    }
    let j = i;
    while (j < len) {
      const c = text[j];
      if (c === d || c === '\n' || c === '\r') break;
      j++;
    }
    field += text.slice(i, j);
    i = j;
    atFieldStart = false;
    if (i >= len) break;
    if (text[i] === d) {
      cells.push(field); field = ''; atFieldStart = true; i++;
      continue;
    }
    i += (text[i] === '\r' && text[i + 1] === '\n') ? 2 : 1;
    endRecord();
    line++; recordLine = line; atFieldStart = true;
  }
  if (!(cells.length === 0 && field === '' && atFieldStart)) endRecord();
  return { delimiter: d, records };
}

// ---------------------------------------------------------------- headers

export function normalizeHeader(h) {
  return String(h ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9#]+/g, ' ')
    .replace(/#/g, ' number of ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NORMALIZED_ALIASES = IMPORT_FIELDS.map(f => ({
  key: f.key,
  canonical: new Set([normalizeHeader(f.label), normalizeHeader(f.key)]),
  aliases: f.aliases.map(normalizeHeader),
}));

// Best field for one header: the field's own name = 1, any other exact alias
// = 0.95 (so "Net result" beats "Profit" for the same field), every word of a
// multi-word alias present = 0.7 (+0.01 per word, so the more specific alias
// wins a tie), a single-word alias present as a word = 0.5.
// A money header measured in big blinds ("Net (BB)", "Result in BB") is left
// unmapped: importing it as currency would silently corrupt every result.
// Checked against any money match, not just the winner, because "bb" itself
// is a Big blind alias and could otherwise win the tie.
export function matchHeader(header) {
  const h = normalizeHeader(header);
  if (!h) return { field: null, score: 0 };
  const words = new Set(h.split(' '));
  let field = null, score = 0, moneyMatched = false;
  for (const f of NORMALIZED_ALIASES) {
    for (const a of f.aliases) {
      let s = 0;
      if (a === h) s = f.canonical.has(h) ? 1 : 0.95;
      else {
        const aw = a.split(' ');
        if (aw.every(w => words.has(w))) s = aw.length > 1 ? 0.7 + 0.01 * aw.length : 0.5;
      }
      if (s > 0 && MONEY_FIELDS.includes(f.key)) moneyMatched = true;
      if (s > score) { score = s; field = f.key; }
    }
  }
  if (moneyMatched && /\bbbs?\b|big blinds/.test(String(header).toLowerCase())) return { field: null, score: 0 };
  return { field, score };
}

// Currency hinted by a header such as "Buy-in (EUR)" or "Profit €".
export function headerCurrency(header) {
  const found = findCurrencies(String(header ?? ''));
  return found.length === 1 ? found[0] : null;
}

function looksLikeValue(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return false;
  if (parseAmount(s, '.') && !parseAmount(s, '.').error) return true;
  if (parseAmount(s, ',') && !parseAmount(s, ',').error) return true;
  const dt = parseDateTime(s, 'DMY');
  if (dt && !dt.error) return true;
  return STAKES_RE.test(s);
}

// First record is a header when none of its cells read as a value, and it
// either names a known field or sits above a row that does contain values.
export function detectHeader(records) {
  if (!records.length) return false;
  const first = records[0].cells;
  if (first.some(looksLikeValue)) return false;
  if (first.some(c => matchHeader(c).score >= 0.5)) return true;
  const second = records[1] && records[1].cells;
  return Boolean(second && second.some(looksLikeValue));
}

// ---------------------------------------------------------------- mapping

// Suggests one field per column. Header aliases first; columns still unmapped
// (or every column when there is no header) are sniffed from sample values.
// Each field is used at most once; the strongest match wins a conflict.
// Returns { mapping: (fieldKey|null)[], suggestions: [{ column, header, field, confidence, source }] }.
export function suggestMapping(headers, sampleRows = []) {
  const columnCount = Math.max(headers ? headers.length : 0, ...sampleRows.map(r => r.length), 0);
  const candidates = [];
  if (headers) {
    headers.forEach((h, column) => {
      const { field, score } = matchHeader(h);
      if (field) candidates.push({ column, field, confidence: score, source: 'header' });
    });
  }
  for (let column = 0; column < columnCount; column++) {
    const values = sampleRows.map(r => (r[column] ?? '').trim()).filter(Boolean).slice(0, 25);
    for (const c of sniffColumn(values)) candidates.push({ column, ...c, source: 'values' });
  }
  candidates.sort((a, b) => b.confidence - a.confidence || a.column - b.column);
  const mapping = new Array(columnCount).fill(null);
  const used = new Set();
  const suggestions = [];
  for (const c of candidates) {
    if (mapping[c.column] !== null || used.has(c.field)) continue;
    mapping[c.column] = c.field;
    used.add(c.field);
    suggestions.push({ column: c.column, header: headers ? headers[c.column] ?? '' : null, field: c.field, confidence: c.confidence, source: c.source });
  }
  suggestions.sort((a, b) => a.column - b.column);
  return { mapping, suggestions };
}

const share = (values, pred) => (values.length ? values.filter(pred).length / values.length : 0);

function sniffColumn(values) {
  if (!values.length) return [];
  const out = [];
  const dt = values.map(v => parseDateTime(v, 'DMY'));
  if (share(dt, p => p && !p.error && p.hasDate) >= 0.8) {
    const withTime = share(dt, p => p && p.hasTime) >= 0.8;
    out.push({ field: withTime ? 'start_time' : 'date', confidence: 0.3 });
    if (withTime) out.push({ field: 'end_time', confidence: 0.29 });
  } else if (share(dt, p => p && !p.error && !p.hasDate && p.hasTime) >= 0.8) {
    out.push({ field: 'start_time', confidence: 0.28 }, { field: 'end_time', confidence: 0.27 });
  }
  if (share(values, (v, i) => STAKES_RE.test(v) && !(dt[i] && !dt[i].error)) >= 0.8) out.push({ field: 'stakes', confidence: 0.35 });
  if (share(values, v => parseKind(v)) >= 0.8) out.push({ field: 'kind', confidence: 0.35 });
  if (share(values, v => /max|^hu$|heads/i.test(v) && Number.isInteger(parseTableSize(v))) >= 0.8) out.push({ field: 'table_size', confidence: 0.35 });
  if (share(values, v => /^[A-Za-z]{3}$|^[€$£¥₹]$/.test(v) && findCurrencies(v).length === 1) >= 0.8) out.push({ field: 'currency', confidence: 0.35 });
  return out;
}

// Problems that make the mapping unusable as a whole (vs per-row errors).
export function validateMapping(mapping) {
  const errors = [];
  if (!Array.isArray(mapping)) return { ok: false, errors: ['Mapping must be a list with one entry per column.'] };
  const seen = new Map();
  mapping.forEach((key, column) => {
    if (key === null || key === undefined || key === '') return;
    if (!FIELD_BY_KEY[key]) { errors.push(`Column ${column + 1} is mapped to an unknown field "${key}".`); return; }
    if (seen.has(key)) errors.push(`${FIELD_BY_KEY[key].label} is mapped to more than one column (${seen.get(key) + 1} and ${column + 1}).`);
    else seen.set(key, column);
  });
  const has = k => seen.has(k);
  if (!has('start_time') && !has('date')) errors.push('Map a Start time or Date column.');
  if (!has('end_time') && !has('duration') && !has('duration_minutes')) errors.push('Map an End time or Duration column.');
  if (has('duration') && has('duration_minutes')) errors.push('Map Duration in hours or in minutes, not both.');
  if (!has('buy_in') && !has('initial_buy_in') && !has('total_buy_in')) errors.push('Map a Buy-in column.');
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------- values

const CURRENCY_SYMBOLS = [['€', 'EUR'], ['£', 'GBP'], ['$', 'USD'], ['¥', 'JPY'], ['₹', 'INR'], ['zł', 'PLN']];
export const CURRENCY_CODES = new Set([
  'EUR', 'USD', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK', 'ISK', 'PLN', 'CZK', 'HUF', 'RON', 'BGN',
  'JPY', 'CNY', 'HKD', 'SGD', 'KRW', 'INR', 'THB', 'PHP', 'BRL', 'MXN', 'ARS', 'ZAR', 'TRY', 'UAH', 'ILS', 'AED',
]);
const CODE_RE = /(?:^|[^A-Za-z])([A-Za-z]{3})(?![A-Za-z])/g;

function findCurrencies(s) {
  const out = new Set();
  for (const [sym, code] of CURRENCY_SYMBOLS) if (s.includes(sym)) out.add(code);
  for (const m of s.matchAll(CODE_RE)) {
    const code = m[1].toUpperCase();
    if (CURRENCY_CODES.has(code)) out.add(code);
  }
  return [...out];
}

function stripCurrency(s) {
  let out = s;
  for (const [sym] of CURRENCY_SYMBOLS) out = out.split(sym).join(' ');
  return out.replace(CODE_RE, (m, code) => (CURRENCY_CODES.has(code.toUpperCase()) ? m.slice(0, m.length - 3) + ' ' : m));
}

// Currency column cell: a code or symbol. Returns code, null (empty) or { error }.
export function parseCurrencyCell(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const found = findCurrencies(s);
  if (found.length === 1 && stripCurrency(s).trim() === '') return found[0];
  if (/^[A-Za-z]{3}$/.test(s)) return s.toUpperCase();
  return { error: `Unknown currency "${s}"` };
}

// Money cell. decimal is the file's decimal separator ('.' or ','); the other
// one may appear only as a thousands separator in groups of three.
// Accepts "€1,234.50", "-12", "(12)", "12-", "EUR 16.8", "1.234,5" (decimal ',').
// Returns { value, currency|null }, null for an empty cell, or { error }.
export function parseAmount(raw, decimal = '.') {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  const currencies = findCurrencies(s);
  if (currencies.length > 1) return { error: `"${s}" mixes currencies` };
  let t = stripCurrency(s).replace(/[\s\u00a0\u202f']/g, '').replace(/\u2212/g, '-');
  let negative = false;
  if (/^\(.*\)$/.test(t)) { negative = true; t = t.slice(1, -1); }
  if (/^[+-]/.test(t)) { negative = negative !== (t[0] === '-'); t = t.slice(1); }
  if (/-$/.test(t)) { negative = !negative; t = t.slice(0, -1); }
  if (!/^[\d.,]+$/.test(t) || !/\d/.test(t)) return { error: `"${s}" is not an amount` };
  const thousands = decimal === ',' ? '.' : ',';
  const [intPart, fracPart, extra] = t.split(decimal);
  if (extra !== undefined) return { error: `"${s}" is not an amount` };
  if (fracPart !== undefined && !/^\d+$/.test(fracPart)) return { error: `"${s}" is not an amount` };
  if (intPart.includes(thousands)) {
    if (!new RegExp(`^\\d{1,3}(\\${thousands}\\d{3})+$`).test(intPart)) return { error: `"${s}" is not an amount` };
  } else if (intPart !== '' && !/^\d+$/.test(intPart)) return { error: `"${s}" is not an amount` };
  const value = Number((intPart.split(thousands).join('') || '0') + (fracPart !== undefined ? '.' + fracPart : ''));
  if (!Number.isFinite(value)) return { error: `"${s}" is not an amount` };
  return { value: negative && value !== 0 ? -value : value, currency: currencies[0] || null };
}

// Votes for the file's decimal separator from sample money / stakes cells.
// "1,5" or "12,25" (not a 3-digit group) votes ','; "1.5" votes '.'; with both
// separators the last one is the decimal. Undecided -> fallback.
export function detectDecimal(values, fallback = '.') {
  let comma = 0, dot = 0;
  for (const raw of values) {
    for (const part of String(raw ?? '').split('/')) {
      const t = stripCurrency(part).replace(/[^\d.,]/g, '');
      if (!t) continue;
      const lc = t.lastIndexOf(','), ld = t.lastIndexOf('.');
      if (lc >= 0 && ld >= 0) { if (lc > ld) comma++; else dot++; } else if (lc >= 0) { if (!/^\d{1,3}(,\d{3})+$/.test(t)) comma++; } else if (ld >= 0) { if (!/^\d{1,3}(\.\d{3})+$/.test(t)) dot++; }
    }
  }
  if (comma > dot) return ',';
  if (dot > comma) return '.';
  return fallback;
}

// Whole numbers: "1234", "1,234" / "1.234" / "1 234" (3-digit groups), "3.0".
export function parseInteger(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^\d{1,3}([,.'\s\u00a0]\d{3})+$/.test(s)) return Number(s.replace(/\D/g, ''));
  const m = s.match(/^(\d+)(?:[.,]0+)?$/);
  if (!m) return { error: `"${s}" is not a whole number` };
  return Number(m[1]);
}

// "9", "9-max", "6 max", "HU", "heads-up". Returns 2..10, null or { error }.
export function parseTableSize(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  let n = null;
  if (/^(hu|heads[\s-]?up)$/.test(s)) n = 2;
  else {
    const m = s.match(/^(\d{1,2})\s*-?\s*(max|handed|players?|seats?)?$/);
    if (m) n = Number(m[1]);
  }
  if (n === null) return { error: `Table size "${String(raw).trim()}" is not readable` };
  if (n < 2 || n > 10) return { error: 'Table size must be between 2 and 10' };
  return n;
}

const STAKES_RE = /^\D{0,6}?\d+(?:[.,]\d+)?\s*[/]\s*\D{0,3}?\d+(?:[.,]\d+)?(?:\s*[/]\s*\D{0,3}?\d+(?:[.,]\d+)?)?\D{0,20}$/;

// "0.1/0.2", "€0.25/€0.5", "$1/$2 NL", "0,5/1" (decimal ','), "1/2/5"
// (straddle: first two). Returns { small_blind, big_blind, currency, straddle } or null / { error }.
export function parseStakes(raw, decimal = '.') {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (!STAKES_RE.test(s)) return { error: `Stakes "${s}" are not readable (expected SB/BB, e.g. 0.1/0.2)` };
  const currencies = findCurrencies(s);
  if (currencies.length > 1) return { error: `Stakes "${s}" mix currencies` };
  const nums = s.match(/\d+(?:[.,]\d+)?/g).map(n => Number(decimal === ',' ? n.replace(',', '.') : n.replace(',', '')));
  return { small_blind: nums[0], big_blind: nums[1], currency: currencies[0] || null, straddle: nums.length > 2 };
}

const KIND_WORDS = new Map([
  ['cash', ['cash', null]], ['cash game', ['cash', null]], ['cashgame', ['cash', null]], ['ring', ['cash', null]],
  ['ring game', ['cash', null]], ['live cash', ['cash', null]], ['c', ['cash', null]],
  ['tournament', ['tournament', null]], ['tourney', ['tournament', null]], ['tourn', ['tournament', null]], ['t', ['tournament', null]],
  ['mtt', ['tournament', 'MTT']], ['sng', ['tournament', 'SNG']], ['sit n go', ['tournament', 'SNG']],
  ['sit and go', ['tournament', 'SNG']], ['sit go', ['tournament', 'SNG']], ['spin', ['tournament', 'Spin & Go']],
  ['spin go', ['tournament', 'Spin & Go']], ['spin and go', ['tournament', 'Spin & Go']], ['satellite', ['tournament', 'Satellite']],
]);

// Returns { kind, tournamentType|null } or null when the word is unknown.
export function parseKind(raw) {
  const s = String(raw ?? '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  const hit = KIND_WORDS.get(s);
  return hit ? { kind: hit[0], tournamentType: hit[1] } : null;
}

const GAME_NAMES = new Map([
  ['nl hold em', "NL Hold'em"], ['nlh', "NL Hold'em"], ['nlhe', "NL Hold'em"], ['nl holdem', "NL Hold'em"],
  ['no limit hold em', "NL Hold'em"], ['no limit holdem', "NL Hold'em"], ['hold em', "NL Hold'em"], ['holdem', "NL Hold'em"],
  ['texas hold em', "NL Hold'em"], ['texas holdem', "NL Hold'em"], ['nl', "NL Hold'em"],
  ['plo', 'PLO'], ['plo4', 'PLO'], ['omaha', 'PLO'], ['pot limit omaha', 'PLO'], ['plo 4', 'PLO'],
  ['plo5', 'PLO5'], ['plo 5', 'PLO5'], ['5 card plo', 'PLO5'], ['5 card omaha', 'PLO5'], ['pot limit omaha 5', 'PLO5'],
]);

// Canonical names for common spellings so "NLHE" and "NL Hold'em" become one
// game; anything else is kept as typed (trimmed).
export function canonicalGame(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  return GAME_NAMES.get(s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()) || s.replace(/\s+/g, ' ');
}

function canonicalTournamentType(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const k = parseKind(s);
  return (k && k.tournamentType) || s.replace(/\s+/g, ' ');
}

// Durations. "3:23" / "3:23:10" = H:MM(:SS); "3h 20m", "200 min", "3.5h";
// a bare number uses `bareUnit` ('hours' for Duration, 'minutes' for Break).
// Returns seconds, null or { error }.
export function parseDuration(raw, bareUnit = 'hours') {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  let m = s.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (m) {
    if (Number(m[2]) > 59 || (m[3] && Number(m[3]) > 59)) return { error: `Duration "${s}" is not valid` };
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0);
  }
  m = s.match(/^(?:(\d+(?:[.,]\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+(?:[.,]\d+)?)\s*m(?:in(?:utes?|s)?)?)?$/);
  if (m && (m[1] || m[2])) {
    return Math.round(num(m[1]) * 3600 + num(m[2]) * 60);
  }
  m = s.match(/^\d+(?:[.,]\d+)?$/);
  if (m) return Math.round(num(s) * (bareUnit === 'minutes' ? 60 : 3600));
  if (/^-/.test(s)) return { error: 'Duration cannot be negative' };
  return { error: `Duration "${String(raw).trim()}" is not readable` };
}
const num = v => (v ? Number(String(v).replace(',', '.')) : 0);

// ---------------------------------------------------------------- dates

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const TIME_TAIL_RE = /(?:^|[\sT,]+)(\d{1,2})[:h](\d{2})(?::(\d{2})(?:\.\d+)?)?\s*([ap])?\.?(?:m\.?)?\s*(z|utc|gmt|[+-]\d{2}:?\d{2})?$/i;
const NUMERIC_DATE_RE = /^(\d{1,4})([/.\-])(\d{1,2})\2(\d{1,4})$/;
const DAY_MONTH_NAME_RE = /^(\d{1,2})[\s\-.]+([a-z]{3,})\.?,?[\s\-.]+(\d{4})$/i;
const MONTH_NAME_DAY_RE = /^([a-z]{3,})\.?[\s\-]+(\d{1,2})(?:st|nd|rd|th)?,?[\s\-]+(\d{4})$/i;

function monthIndex(word) {
  const i = MONTHS.indexOf(word.slice(0, 3).toLowerCase());
  return i < 0 ? null : i + 1;
}

function validYmd(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2999)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function parseOffset(z) {
  if (!z) return null;
  if (/^(z|utc|gmt)$/i.test(z)) return 0;
  const m = z.match(/^([+-])(\d{2}):?(\d{2})$/);
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

// Parses a date, a date-time, or a time of day. `order` resolves numeric
// dates whose first part is not a year: 'DMY' (04/09/2026 = 4 Sep) or 'MDY'.
// Returns null for empty, { error } when unreadable, otherwise
// { hasDate, hasTime, y, m, d, h, mi, s, offset (minutes|null), format }.
export function parseDateTime(raw, order = 'DMY') {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  const bad = { error: `Date "${s}" is not readable` };
  s = s.replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i, '');
  let h = 0, mi = 0, sec = 0, hasTime = false, offset = null, timeFmt = '';
  const tm = s.match(TIME_TAIL_RE);
  if (tm) {
    h = Number(tm[1]); mi = Number(tm[2]); sec = Number(tm[3] || 0);
    if (tm[4]) {
      if (h < 1 || h > 12) return { error: `Time "${s}" is not valid` };
      const pm = tm[4].toLowerCase() === 'p';
      if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12;
    }
    if (h > 23 || mi > 59 || sec > 59) return { error: `Time "${s}" is not valid` };
    offset = parseOffset(tm[5]);
    hasTime = true;
    timeFmt = tm[4] ? 'h:mm A' : (tm[3] ? 'HH:mm:ss' : 'HH:mm');
    s = s.slice(0, tm.index).trim();
  }
  if (!s) {
    if (!hasTime) return bad;
    return { hasDate: false, hasTime, y: null, m: null, d: null, h, mi, s: sec, offset, format: timeFmt };
  }
  let y, m, d, dateFmt;
  let mm = s.match(NUMERIC_DATE_RE);
  if (mm) {
    const [a, sep, b, c] = [mm[1], mm[2], mm[3], mm[4]];
    if (a.length === 4) {
      y = Number(a); m = Number(b); d = Number(c);
      dateFmt = `YYYY${sep}MM${sep}DD`;
    } else if (c.length === 4 || c.length === 2) {
      y = Number(c.length === 2 ? '20' + c : c);
      const yy = c.length === 2 ? 'YY' : 'YYYY';
      if (order === 'MDY') { m = Number(a); d = Number(b); dateFmt = `MM${sep}DD${sep}${yy}`; } else { d = Number(a); m = Number(b); dateFmt = `DD${sep}MM${sep}${yy}`; }
    } else return bad;
  } else if ((mm = s.match(DAY_MONTH_NAME_RE))) {
    d = Number(mm[1]); m = monthIndex(mm[2]); y = Number(mm[3]); dateFmt = 'D MMM YYYY';
  } else if ((mm = s.match(MONTH_NAME_DAY_RE))) {
    m = monthIndex(mm[1]); d = Number(mm[2]); y = Number(mm[3]); dateFmt = 'MMM D, YYYY';
  } else return bad;
  if (!m || !validYmd(y, m, d)) return { error: `Date "${String(raw).trim()}" does not exist` };
  const isoLike = dateFmt === 'YYYY-MM-DD';
  const format = hasTime ? (isoLike && offset !== null ? 'ISO 8601' : `${dateFmt} ${timeFmt}`) : dateFmt;
  return { hasDate: true, hasTime, y, m, d, h, mi, s: sec, offset, format };
}

// Day/month order for numeric dates such as 04/09/2026, from every date cell
// in the file: a first part > 12 proves DMY, a second part > 12 proves MDY.
// Returns { order, ambiguous, conflict }. Year-first dates do not vote.
export function detectDateOrder(values, fallback = 'DMY') {
  let dmy = 0, mdy = 0;
  for (const raw of values) {
    const s = String(raw ?? '').trim().replace(TIME_TAIL_RE, '').trim();
    const m = s.match(NUMERIC_DATE_RE);
    if (!m || m[1].length === 4) continue;
    const a = Number(m[1]), b = Number(m[3]);
    if (a > 12 && b <= 12) dmy++;
    else if (b > 12 && a <= 12) mdy++;
  }
  if (dmy && mdy) return { order: dmy >= mdy ? 'DMY' : 'MDY', ambiguous: false, conflict: true };
  if (dmy) return { order: 'DMY', ambiguous: false, conflict: false };
  if (mdy) return { order: 'MDY', ambiguous: false, conflict: false };
  return { order: fallback, ambiguous: true, conflict: false };
}

function partsToMs(p, dayShift = 0) {
  if (p.offset !== null && p.offset !== undefined) {
    return Date.UTC(p.y, p.m - 1, p.d + dayShift, p.h, p.mi, p.s) - p.offset * 60000;
  }
  return new Date(p.y, p.m - 1, p.d + dayShift, p.h, p.mi, p.s, 0).getTime();
}

// ---------------------------------------------------------------- drafts

// Net result of a draft, same formula as the brief's derived net_result.
export function draftNetResult(session) {
  if (session.kind === 'cash') return session.cashed_out - session.buy_in - (session.tips ?? 0);
  return (session.prize ?? 0) - session.total_buy_in;
}

// Identity for duplicate detection: kind, start minute, length, net result.
// The wiring can compute it for existing sessions (with stats' netResult) to
// feed the isDuplicate hook.
export function sessionFingerprint(session, net) {
  const minute = new Date(Math.floor(Date.parse(session.start_time) / 60000) * 60000).toISOString();
  return [session.kind, minute, Math.round(session.duration_seconds || 0), Number(net ?? 0).toFixed(2)].join('|');
}

const round2 = v => Math.round(v * 100) / 100;

function colIndex(mapping) {
  const out = {};
  mapping.forEach((k, i) => { if (k) out[k] = i; });
  return out;
}

// Validates and normalizes one record. Returns { reasons } or a draft.
function normalizeRow(cells, col, ctx) {
  const reasons = [];
  const warnings = [];
  const get = key => (col[key] === undefined ? '' : String(cells[col[key]] ?? '').trim());
  const label = key => FIELD_BY_KEY[key].label;
  const currencies = new Set();

  const amount = key => {
    const p = parseAmount(get(key), ctx.decimal);
    if (p === null) return null;
    if (p.error) { reasons.push(`${label(key)}: ${p.error}`); return null; }
    const cur = p.currency || ctx.columnCurrency[col[key]];
    if (cur) currencies.add(cur);
    return p.value;
  };
  const integer = (key, min) => {
    const p = parseInteger(get(key));
    if (p === null) return null;
    if (typeof p === 'object') { reasons.push(`${label(key)}: ${p.error}`); return null; }
    if (p < min) { reasons.push(`${label(key)} must be at least ${min}`); return null; }
    return p;
  };
  const nonNegative = (key, v) => {
    if (v !== null && v < 0) { reasons.push(`${label(key)} cannot be negative`); return null; }
    return v;
  };

  // Session type: explicit column, else inferred from which columns are filled.
  let kind = null, kindType = null;
  const kindRaw = get('kind');
  if (kindRaw) {
    const k = parseKind(kindRaw);
    if (k) { kind = k.kind; kindType = k.tournamentType; } else reasons.push(`Session type "${kindRaw}" is not cash or tournament`);
  } else if (['prize', 'total_buy_in', 'initial_buy_in', 'position', 'entries', 'tournament_name', 'tournament_type'].some(k => get(k))) kind = 'tournament';
  else if (['stakes', 'small_blind', 'big_blind', 'cashed_out'].some(k => get(k))) kind = 'cash';
  else if (ctx.defaultKind) kind = ctx.defaultKind;
  else reasons.push('Cannot tell whether this is a cash game or a tournament (map a Session type column)');

  // Currency column.
  const curCell = parseCurrencyCell(get('currency'));
  if (curCell && typeof curCell === 'object') reasons.push(curCell.error);
  else if (curCell) currencies.add(curCell);

  // Times.
  const dt = key => {
    const p = parseDateTime(get(key), ctx.dateOrder);
    if (p && p.error) { reasons.push(`${label(key)}: ${p.error}`); return undefined; }
    return p;
  };
  const dateP = dt('date'), startP = dt('start_time'), endP = dt('end_time');
  let startParts = null;
  if (startP && startP.hasDate) startParts = startP;
  else if (startP) {
    if (dateP && dateP.hasDate) startParts = { ...startP, y: dateP.y, m: dateP.m, d: dateP.d, hasDate: true, offset: startP.offset ?? dateP.offset };
    else if (dateP !== undefined) reasons.push('Start time has no date (map a Date column)');
  } else if (dateP && dateP.hasDate) startParts = dateP;
  else if (dateP && !dateP.hasDate) reasons.push('Date: no day, month and year found');
  else if (startP === null && dateP === null) reasons.push('Start time is missing');
  if (startParts && !startParts.hasTime) warnings.push('No start time of day; assumed 00:00');

  const durHours = parseDuration(get('duration'), 'hours');
  const durMinutes = parseDuration(get('duration_minutes'), 'minutes');
  let durationSec = null, durationBad = false;
  for (const [key, p] of [['duration', durHours], ['duration_minutes', durMinutes]]) {
    if (p && typeof p === 'object') { reasons.push(`${label(key)}: ${p.error}`); durationBad = true; } else if (p !== null) durationSec = p;
  }
  const breakP = parseDuration(get('break'), 'minutes');
  let breakSec = 0;
  if (breakP && typeof breakP === 'object') reasons.push(`Break: ${breakP.error}`);
  else if (breakP !== null) breakSec = breakP;

  let startMs = null, endMs = null;
  if (startParts) {
    startMs = partsToMs(startParts);
    if (endP && endP.hasDate) endMs = partsToMs(endP);
    else if (endP) {
      const endParts = { ...endP, y: startParts.y, m: startParts.m, d: startParts.d, offset: endP.offset ?? startParts.offset };
      endMs = partsToMs(endParts);
      if (endMs <= startMs) endMs = partsToMs(endParts, 1); // overnight session
    }
    if (endMs === null && durationSec !== null) endMs = startMs + durationSec * 1000;
    else if (endMs !== null && durationSec !== null && Math.abs((endMs - startMs) / 1000 - durationSec) > 60) {
      warnings.push('Duration does not match start and end times; used the times');
    }
    // endP undefined / durationBad: that cell already produced its own reason.
    if (endMs === null && endP !== undefined && !durationBad) reasons.push('End time or duration is missing');
    if (startMs > ctx.nowMs) reasons.push('Start time is in the future');
    if (endMs !== null && endMs < startMs) reasons.push('End time is before start time');
    else if (endMs !== null && endMs > ctx.nowMs) reasons.push('End time is in the future');
  }
  const durationSeconds = startMs !== null && endMs !== null ? Math.max(0, Math.round((endMs - startMs) / 1000)) : null;
  if (durationSeconds !== null && breakSec > durationSeconds) reasons.push('Break is longer than the session');

  const tableSize = parseTableSize(get('table_size'));
  if (tableSize && typeof tableSize === 'object') reasons.push(`Table size: ${tableSize.error}`);
  const hands = integer('hands_count', 0);
  const tips = nonNegative('tips', amount('tips'));
  const net = amount('net_result');

  const session = {
    kind,
    start_time: startMs !== null ? new Date(startMs).toISOString() : null,
    end_time: endMs !== null ? new Date(endMs).toISOString() : null,
    duration_seconds: durationSeconds,
    break_seconds: breakSec,
    table_size: typeof tableSize === 'number' ? tableSize : null,
    hands_count: hands,
    hands_count_estimated: false,
    comment: get('comment') || null,
    opponents: get('opponents') || null,
    is_live: false,
    tracked_via_stack: false,
  };
  const refs = {
    game: canonicalGame(get('game')),
    location: get('location').replace(/\s+/g, ' ') || null,
    bankroll: get('bankroll').replace(/\s+/g, ' ') || null,
    group: get('group').replace(/\s+/g, ' ') || null,
    tournament_type: null,
  };

  if (kind === 'cash') {
    let sb = null, bb = null;
    const st = parseStakes(get('stakes'), ctx.decimal);
    if (st && st.error) reasons.push(st.error);
    else if (st) {
      sb = st.small_blind; bb = st.big_blind;
      if (st.currency) currencies.add(st.currency);
      if (st.straddle) warnings.push('Stakes have more than two blinds; used the first two');
    }
    const sbCol = nonNegative('small_blind', amount('small_blind'));
    const bbCol = nonNegative('big_blind', amount('big_blind'));
    if (sbCol !== null) sb = sbCol;
    if (bbCol !== null) bb = bbCol;
    if (bb === null) reasons.push('Big blind is missing (map Stakes or Big blind)');
    else if (bb <= 0) reasons.push('Big blind must be more than 0');
    else if (sb === null) { sb = round2(bb / 2); warnings.push('No small blind; assumed half the big blind'); } else if (sb > bb) reasons.push('Small blind is bigger than the big blind');

    const buyIn = nonNegative('buy_in', amount('buy_in'));
    let cashedOut = nonNegative('cashed_out', amount('cashed_out'));
    if (buyIn === null && !get('buy_in')) reasons.push('Buy-in is missing');
    if (cashedOut === null && !get('cashed_out') && net !== null && buyIn !== null) {
      cashedOut = round2(net + buyIn + (tips ?? 0));
      if (cashedOut < 0) { reasons.push('Net result loses more than the buy-in'); cashedOut = null; }
    } else if (cashedOut !== null && net !== null && buyIn !== null && Math.abs(cashedOut - buyIn - (tips ?? 0) - net) > 0.005) {
      warnings.push('Net result does not match cashed out - buy-in - tips; used the amounts');
    }
    if (cashedOut === null && !get('cashed_out') && net === null) reasons.push('Cashed out is missing (map Cashed out or Net result)');
    Object.assign(session, { small_blind: sb, big_blind: bb, buy_in: buyIn, cashed_out: cashedOut, tips: tips ?? 0 });
  } else if (kind === 'tournament') {
    let initial = nonNegative('initial_buy_in', amount('initial_buy_in'));
    if (initial === null) initial = nonNegative('buy_in', amount('buy_in'));
    let total = nonNegative('total_buy_in', amount('total_buy_in'));
    if (initial === null && total === null) {
      if (!get('initial_buy_in') && !get('buy_in') && !get('total_buy_in')) reasons.push('Buy-in is missing');
    } else {
      if (initial === null) initial = total;
      if (total === null) total = initial;
      if (total < initial) reasons.push('Total buy-in is less than the initial buy-in');
    }
    let prize = nonNegative('prize', amount('prize'));
    if (prize === null && !get('prize')) prize = nonNegative('cashed_out', amount('cashed_out'));
    if (prize === null && net !== null && total !== null && !get('prize') && !get('cashed_out')) {
      prize = round2(net + total);
      if (prize < 0) { reasons.push('Net result loses more than the buy-in'); prize = null; }
    }
    const position = integer('position', 1);
    const entries = integer('entries', 1);
    if (position !== null && entries !== null && position > entries) reasons.push('Position is worse than the number of entries');
    refs.tournament_type = canonicalTournamentType(get('tournament_type')) || kindType;
    Object.assign(session, {
      tournament_name: get('tournament_name').replace(/\s+/g, ' ') || null,
      initial_buy_in: initial, total_buy_in: total, prize: prize ?? 0,
      position, entries, tips: tips ?? 0,
    });
  }

  if (currencies.size > 1) reasons.push(`Row mixes currencies (${[...currencies].sort().join(', ')})`);
  const currency = currencies.size === 1 ? [...currencies][0] : null;
  if (currencies.size === 1 && ctx.expectedCurrency && currency !== ctx.expectedCurrency) {
    reasons.push(`Amounts are in ${currency} but the import currency is ${ctx.expectedCurrency} (no conversion)`);
  }
  if (reasons.length) return { reasons, currency };
  const netResult = round2(draftNetResult(session));
  return { session, refs, currency: currency || ctx.expectedCurrency, net_result: netResult, fingerprint: sessionFingerprint(session, netResult), warnings };
}

// File-level detection over all data rows: decimal separator, date order,
// date formats and currencies.
function detectFileTraits(records, col, columnCurrency, opts) {
  const pick = keys => keys.filter(k => col[k] !== undefined).map(k => col[k]);
  const moneyCols = pick([...MONEY_FIELDS, 'small_blind', 'big_blind', 'stakes']);
  const dateCols = pick(DATE_FIELDS);
  const moneyValues = [], dateValues = [];
  for (const r of records) {
    for (const c of moneyCols) if (r.cells[c]) moneyValues.push(r.cells[c]);
    for (const c of dateCols) if (r.cells[c]) dateValues.push(r.cells[c]);
  }
  const decimal = opts.decimal === '.' || opts.decimal === ',' ? opts.decimal : detectDecimal(moneyValues, '.');
  const order = opts.dateOrder === 'DMY' || opts.dateOrder === 'MDY'
    ? { order: opts.dateOrder, ambiguous: false, conflict: false, forced: true }
    : detectDateOrder(dateValues, opts.dateOrderFallback === 'MDY' ? 'MDY' : 'DMY');
  const formats = new Set();
  for (const v of dateValues) {
    const p = parseDateTime(v, order.order);
    if (p && !p.error) formats.add(p.format);
  }
  const currencyCounts = {};
  for (const r of records) {
    const rowCur = new Set();
    for (const c of [...moneyCols, ...pick(['currency'])]) {
      const v = r.cells[c];
      if (v) for (const code of findCurrencies(v)) rowCur.add(code);
      if (v && columnCurrency[c]) rowCur.add(columnCurrency[c]);
    }
    if (col.currency !== undefined) {
      const cc = parseCurrencyCell(r.cells[col.currency]);
      if (typeof cc === 'string') rowCur.add(cc);
    }
    for (const code of rowCur) currencyCounts[code] = (currencyCounts[code] || 0) + 1;
  }
  return { decimal, dateOrder: order, dateFormats: [...formats].sort(), currencyCounts };
}

function dominant(counts) {
  let best = null, n = 0;
  for (const [k, v] of Object.entries(counts)) if (v > n || (v === n && k < best)) { best = k; n = v; }
  return best;
}

const tally = (obj, key) => { if (key) obj[key] = (obj[key] || 0) + 1; };

// ---------------------------------------------------------------- public API

// Parse + header detection + suggested mapping. Options: delimiter,
// hasHeader (force), maxRows. Returns { ok, fileError?, delimiter, hasHeader,
// headers, columnCount, records, mapping, suggestions, columnCurrency }.
export function analyzeCsv(text, opts = {}) {
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const { delimiter, records: all } = parseCsv(String(text ?? ''), { delimiter: opts.delimiter });
  const base = { delimiter, hasHeader: false, headers: null, columnCount: 0, records: [], mapping: [], suggestions: [], columnCurrency: [] };
  if (!all.length) return { ok: false, fileError: 'The file is empty.', ...base };
  const hasHeader = typeof opts.hasHeader === 'boolean' ? opts.hasHeader : detectHeader(all);
  const headers = hasHeader ? all[0].cells.map(h => h.trim()) : null;
  const records = hasHeader ? all.slice(1) : all;
  const columnCount = headers ? headers.length : modeOf(records.map(r => r.cells.length));
  const out = { ...base, delimiter, hasHeader, headers, columnCount, records };
  out.columnCurrency = Array.from({ length: columnCount }, (_, i) => (headers ? headerCurrency(headers[i]) : null));
  if (!records.length) return { ok: false, fileError: 'The file has a header but no rows.', ...out };
  if (records.length > maxRows) return { ok: false, fileError: `The file has ${records.length} rows; the limit is ${maxRows}.`, ...out };
  const { mapping, suggestions } = suggestMapping(headers, records.slice(0, 25).filter(r => !r.error).map(r => r.cells));
  mapping.length = columnCount;
  for (let i = 0; i < columnCount; i++) if (mapping[i] === undefined) mapping[i] = null;
  return { ok: true, ...out, mapping, suggestions: suggestions.filter(s => s.column < columnCount) };
}

// Validates every data row against a mapping (default: the suggestion).
// Options:
//   currency     the account currency; rows in another currency are rejected.
//                Default: the file's most common currency.
//   nowMs        "now" for future-time checks (default Date.now()).
//   dateOrder    'DMY' | 'MDY' to force; default auto-detect, falling back to
//                dateOrderFallback (default 'DMY').
//   decimal      '.' | ',' to force; default auto-detect.
//   defaultKind  'cash' | 'tournament' for rows with no type signal.
//   isDuplicate  (draft) => boolean | string. Hook for matches against
//                existing sessions; a string is used as the rejection reason.
// Returns { ok, fileError?, mappingErrors, accepted, rejected, errors, summary }.
export function buildImport(analysis, mapping = analysis.mapping, opts = {}) {
  const empty = { accepted: [], rejected: [], errors: [], mappingErrors: [] };
  if (!analysis.ok) return { ok: false, fileError: analysis.fileError, ...empty, summary: summarize(analysis, [], [], null, null) };
  const mv = validateMapping(mapping);
  if (!mv.ok) return { ok: false, ...empty, mappingErrors: mv.errors, summary: summarize(analysis, [], [], null, null) };

  const col = colIndex(mapping);
  const traits = detectFileTraits(analysis.records.filter(r => !r.error), col, analysis.columnCurrency, opts);
  const expectedCurrency = opts.currency ? String(opts.currency).toUpperCase() : dominant(traits.currencyCounts);
  const ctx = {
    decimal: traits.decimal,
    dateOrder: traits.dateOrder.order,
    nowMs: opts.nowMs ?? Date.now(),
    defaultKind: opts.defaultKind === 'cash' || opts.defaultKind === 'tournament' ? opts.defaultKind : null,
    expectedCurrency,
    columnCurrency: analysis.columnCurrency,
  };
  const accepted = [], rejected = [], seen = new Map();
  let duplicates = 0;
  const reject = (r, reasons) => rejected.push({ line: r.line, reasons, cells: r.cells });

  for (const r of analysis.records) {
    if (r.error) { reject(r, [r.error]); continue; }
    const n = r.cells.length;
    if (n < analysis.columnCount) { reject(r, [`Expected ${analysis.columnCount} columns, found ${n}`]); continue; }
    if (n > analysis.columnCount && r.cells.slice(analysis.columnCount).some(c => c.trim())) {
      reject(r, [`Expected ${analysis.columnCount} columns, found ${n}`]); continue;
    }
    const res = normalizeRow(r.cells, col, ctx);
    if (res.reasons) { reject(r, res.reasons); continue; }
    const draft = { line: r.line, ...res };
    const prev = seen.get(draft.fingerprint);
    if (prev !== undefined) { duplicates++; reject(r, [`Duplicate of line ${prev}`]); continue; }
    const hook = typeof opts.isDuplicate === 'function' ? opts.isDuplicate(draft) : false;
    if (hook) { duplicates++; reject(r, [typeof hook === 'string' ? hook : 'Matches a session you already have']); continue; }
    seen.set(draft.fingerprint, r.line);
    accepted.push(draft);
  }
  const errors = rejected.flatMap(r => r.reasons.map(reason => ({ line: r.line, reason })));
  const summary = summarize(analysis, accepted, rejected, traits, expectedCurrency, col, duplicates);
  return { ok: true, mappingErrors: [], accepted, rejected, errors, summary };
}

function summarize(analysis, accepted, rejected, traits, expectedCurrency, col = {}, duplicates = 0) {
  const games = {}, locations = {}, kinds = { cash: 0, tournament: 0 };
  for (const r of analysis.records) {
    if (r.error) continue;
    if (col.game !== undefined) tally(games, canonicalGame(r.cells[col.game]));
    if (col.location !== undefined) tally(locations, String(r.cells[col.location] ?? '').trim().replace(/\s+/g, ' '));
  }
  let first = null, last = null, net = 0, warnings = 0;
  for (const a of accepted) {
    kinds[a.session.kind]++;
    if (!first || a.session.start_time < first) first = a.session.start_time;
    if (!last || a.session.start_time > last) last = a.session.start_time;
    net += a.net_result;
    warnings += a.warnings.length;
  }
  const currencies = traits ? traits.currencyCounts : {};
  return {
    totalRows: analysis.records.length,
    accepted: accepted.length,
    rejected: rejected.length,
    duplicates,
    warnings,
    delimiter: analysis.delimiter,
    hasHeader: analysis.hasHeader,
    decimal: traits ? traits.decimal : null,
    dateFormats: traits ? traits.dateFormats : [],
    dateOrder: traits ? traits.dateOrder.order : null,
    dateOrderAmbiguous: traits ? traits.dateOrder.ambiguous : false,
    dateOrderConflict: traits ? traits.dateOrder.conflict : false,
    currency: expectedCurrency,
    currencies,
    mixedCurrencies: Object.keys(currencies).length > 1,
    games,
    locations,
    kinds,
    firstStart: first,
    lastStart: last,
    netTotal: round2(net),
  };
}

// One call: analyze, use the suggested mapping (or opts.mapping), validate.
export function importCsv(text, opts = {}) {
  const analysis = analyzeCsv(text, opts);
  const result = buildImport(analysis, opts.mapping || analysis.mapping, opts);
  return { analysis, ...result };
}
