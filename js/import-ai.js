// Import AI client (brief section 1.3). Pure module: no DOM, no store, no
// network. Client side of the /api/import-ai contract for the smart import
// screen. The server owns every AI call: the browser only POSTs small request
// bodies to IMPORT_AI_URL and never talks to a model directly.
//
// Request builders (what the screen sends to the server):
//   buildTableRequest(headers, firstRows)   {kind:'table', headers, rows<=20}
//   textToSessions(content)                 {kind:'text', content}
//   imageToSessions(base64, mime)           {kind:'image', base64, mime}
//   interpretAiResponse(status, json)       200 -> {ok:true, data};
//                                           any non-200 -> {ok:false,
//                                           aiUnavailable:true} so the screen
//                                           falls back to the manual mapping.
//
// Table path. Only headers plus the first 20 rows go to the AI; it returns a
// mapping and CODE applies that mapping to every row, so big files stay cheap:
//   manualMappingShape(headers)  starting point for the no-AI manual screen
//   applyMapping(rows, mapping)  mapping -> a draft row for every row
//   scoreConfidence(session, mapping)  0..1; below NEEDS_CHECK_THRESHOLD the
//                                      preview flags the row "Check this"
//
// Text and image path. The AI returns session rows directly, max 300 per run;
// bigger inputs are split into chunks and the results concatenated:
//   rowsFromAi(aiJson)           one or many run replies -> draft rows
//   chunkIntoRuns(rows, max)     the splitter, exported for callers that send
//                                big inputs in several runs
//
// A draft row mirrors the accepted drafts csv-import.js produces:
//   { line, session, refs, currency, net_result, warnings, confidence,
//     needsCheck }
// with the PA27 session object on .session. Nothing here writes to the store;
// the screen wiring resolves refs to ids and saves. line is the data row the
// draft came from: row 2 for applyMapping (the header is line 1, same rule as
// csv-import) and row 1 for rowsFromAi (pasted rows have no header).
//
// A mapping is plain JSON so a UI can edit it and hand it back:
//   { columns: [{index, header, role, suggestedRole?}],
//     confidence: 0..1 | null,                  how sure the AI was overall
//     rules: { dateFormat, currency, kind, hoursUnit } }
// roles (MAPPING_ROLES): date, start_time, end_time, hours, buyin, cashout,
//   profit, stakes, game, location, type, entries, finish, rebuys, hands,
//   name, notes, currency, ignore. applyMapping reads role, falling back to
//   suggestedRole, so hand-built and AI mappings flow through identically.
// The first column mapped to a role wins. rules.kind forces every row to one
// kind; otherwise the type column decides per row; default cash.
// Dates without a zone are local time (same rule as csv-import.js).

export const IMPORT_AI_URL = '/api/import-ai';
export const MAX_TABLE_SAMPLE_ROWS = 20;
export const MAX_AI_ROWS_PER_RUN = 300;
export const NEEDS_CHECK_THRESHOLD = 0.7;

export const MAPPING_ROLES = Object.freeze([
  'date', 'start_time', 'end_time', 'hours', 'buyin', 'cashout', 'profit',
  'stakes', 'game', 'location', 'type', 'entries', 'finish', 'rebuys',
  'hands', 'name', 'notes', 'currency', 'ignore',
]);

const DATE_FORMATS = ['auto', 'ymd', 'mdy', 'dmy'];
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const SYMBOL_CURRENCY = { $: 'USD', '£': 'GBP', '€': 'EUR', '¥': 'JPY' };

// Same canonical names as csv-import.js so both importers resolve one game.
const GAME_NAMES = new Map([
  ['nl hold em', "NL Hold'em"], ['nlh', "NL Hold'em"], ['nlhe', "NL Hold'em"], ['nl holdem', "NL Hold'em"],
  ['no limit hold em', "NL Hold'em"], ['no limit holdem', "NL Hold'em"], ['hold em', "NL Hold'em"], ['holdem', "NL Hold'em"],
  ['texas hold em', "NL Hold'em"], ['texas holdem', "NL Hold'em"], ['nl', "NL Hold'em"],
  ['plo', 'PLO'], ['plo4', 'PLO'], ['omaha', 'PLO'], ['pot limit omaha', 'PLO'], ['plo 4', 'PLO'],
  ['plo5', 'PLO5'], ['plo 5', 'PLO5'], ['5 card plo', 'PLO5'], ['5 card omaha', 'PLO5'], ['pot limit omaha 5', 'PLO5'],
]);

function round2(x) {
  return Math.round(x * 100) / 100;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

// ---------------------------------------------------------------- parsing

// Money cell -> { value, currency } | null (empty) | undefined (unparseable).
// Accepts $, £, EUR prefixes, thousands commas, European decimal commas,
// accounting negatives "(65)" and trailing minus "340-".
export function parseAiMoney(raw) {
  let s = String(raw ?? '').trim();
  if (!s || s === '-') return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
  let currency = null;
  const sym = /[$£€¥]/.exec(s);
  if (sym) currency = SYMBOL_CURRENCY[sym[0]];
  s = s.replace(/[$£€¥]/g, '');
  const code = /^(usd|eur|gbp|jpy|cad|aud)\b\s*/i.exec(s);
  if (code) { currency = currency || code[1].toUpperCase(); s = s.slice(code[0].length); }
  s = s.replace(/\s/g, '');
  if (/,\d{1,2}$/.test(s) && !s.includes('.')) s = s.replace(',', '.');
  s = s.replace(/,/g, '');
  if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d*\.?\d+$/.test(s) || s === '' || s === '.') return undefined;
  const value = parseFloat(s);
  if (!Number.isFinite(value)) return undefined;
  return { value: (neg ? -1 : 1) * value, currency };
}

// Hours cell -> number | null (empty) | undefined (unparseable).
// "4.75", "4:45" (H:MM), "4h45", "4h 45m", "290 min"; a bare number uses the
// mapping's hoursUnit.
export function parseAiHours(raw, unit = 'hours') {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  let m = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(s);
  if (m) return +m[1] + (+m[2]) / 60 + (m[3] ? (+m[3]) / 3600 : 0);
  m = /^(\d+(?:[.,]\d+)?)\s*h(?:\s*(\d{1,2})\s*m?)?$/.exec(s);
  if (m) return parseFloat(m[1].replace(',', '.')) + (m[2] ? +m[2] / 60 : 0);
  m = /^(\d+(?:[.,]\d+)?)\s*(?:m|min|mins|minutes)$/.exec(s);
  if (m) return parseFloat(m[1].replace(',', '.')) / 60;
  m = /^(\d+(?:[.,]\d+)?)$/.exec(s);
  if (m) return parseFloat(m[1].replace(',', '.')) * (unit === 'minutes' ? 1 / 60 : 1);
  return undefined;
}

// Integer cell -> int | null (empty) | undefined (unparseable). Commas ok.
export function parseAiInt(raw) {
  const s = String(raw ?? '').trim().replace(/,/g, '');
  if (!s) return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  const f = parseFloat(s);
  return Number.isFinite(f) ? Math.round(f) : undefined;
}

// Stakes cell. Brief 1.2: "5/10/20 PLO" has SB 5, BB 10, straddle 20 (the
// straddle is ignored); BB is always the second number. Returns
// { smallBlind, bigBlind, straddle, game } or null.
export function parseAiStakes(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const m = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?/.exec(s);
  return {
    smallBlind: m ? +m[1] : null,
    bigBlind: m ? +m[2] : null,
    straddle: m && m[3] ? +m[3] : null,
    game: variantFrom(s),
  };
}

// Variant words inside a stakes or game string -> canonical game name.
function variantFrom(s) {
  const t = String(s ?? '').toLowerCase();
  if (!t) return null;
  if (/hi[ -]?lo|\/8|\bo8\b/.test(t)) return 'PLO Hi-Lo';
  if (/limit/.test(t)) return "Limit Hold'em";
  if (/plo\s?5|5\s?card plo|5\s?card omaha/.test(t)) return 'PLO5';
  if (/plo\s?6/.test(t)) return 'PLO6';
  if (/plo|omaha/.test(t)) return 'PLO';
  if (/short deck|6\+/.test(t)) return 'Short Deck';
  if (/stud/.test(t)) return 'Stud';
  if (/nl|hold|texas/.test(t)) return "NL Hold'em";
  return null;
}

// Game cell -> canonical name, unknown spellings kept as typed (csv-import
// rule) with a variant scan as a second chance.
export function canonicalAiGame(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const key = s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return GAME_NAMES.get(key) || variantFrom(s) || s.replace(/\s+/g, ' ');
}

// Type cell -> 'cash' | 'tournament' | null (undecided).
export function parseAiKind(raw) {
  const t = String(raw ?? '').trim().toLowerCase();
  if (!t) return null;
  if (/tourna?ment|tourney|\bmtt\b|\bsng\b|sit\s*(?:and|&|n)?\s*go|bounty|\bevent\b/.test(t)) return 'tournament';
  if (/\bcash\b|\bring\b/.test(t)) return 'cash';
  return null;
}

// Tournament flavour for refs.tournament_type.
function tournamentTypeFrom(raw) {
  const t = String(raw ?? '').toLowerCase();
  if (/\bsng\b|sit\s*(?:and|&|n)?\s*go/.test(t)) return 'SNG';
  if (/\bmtt\b/.test(t)) return 'MTT';
  if (/bounty/.test(t)) return 'Bounty';
  return 'Tournament';
}

// Dates. Naive values are local time. Returns { iso, warning? } | { error }
// | null (empty). Supported: ISO instants with a zone, YYYY-MM-DD with an
// optional time, month-name dates ("Oct 3, 2025", "3 Oct 2025", "Oct 3 7pm"),
// numeric a/b/c and a/b with dateFormat 'ymd' | 'mdy' | 'dmy' or auto order.
// A missing year assumes the current year, rolled back one if that lands in
// the future.
export function parseAiDate(raw, dateFormat = 'auto', nowMs = Date.now()) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  // ISO instant with an explicit zone: honour it exactly.
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? { error: `Unreadable date: ${s}` } : { iso: new Date(ms).toISOString() };
  }
  // Time of day, 24h or am/pm, possibly trailing the date.
  let hh = 0, mi = 0, rest = s;
  const tm = extractTime(s);
  if (tm) {
    hh = tm.hh;
    mi = tm.mi;
    rest = (s.slice(0, tm.index) + ' ' + s.slice(tm.index + tm.length)).replace(/\s+/g, ' ').trim();
  }
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(rest);
  if (m) return withDate(+m[1], +m[2], +m[3], hh, mi);
  // "Oct 3, 2025" / "Oct 3 2025" / "Oct 3"
  m = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?$/i.exec(rest);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo == null) return { error: `Unreadable date: ${s}` };
    const y = m[3] != null ? +m[3] : inferYear(nowMs, mo, +m[2], hh, mi);
    return withDate(y, mo + 1, +m[2], hh, mi);
  }
  // "3 Oct 2025" / "3 Oct"
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?(?:,?\s*(\d{4}))?$/i.exec(rest);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo == null) return { error: `Unreadable date: ${s}` };
    const y = m[3] != null ? +m[3] : inferYear(nowMs, mo, +m[1], hh, mi);
    return withDate(y, mo + 1, +m[1], hh, mi);
  }
  // "2025/09/15" - leading 4-digit year, checked before the a/b/c form so
  // the trailing 15 is not mistaken for a 2-digit year.
  m = /^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/.exec(rest);
  if (m) return withDate(+m[1], +m[2], +m[3], hh, mi);
  // "a/b/c" or "a-b-c" numerics
  m = /^(\d{1,4})[\/-](\d{1,2})[\/-](\d{4}|\d{2})$/.exec(rest);
  if (m) return numericTriple(+m[1], +m[2], m[3], dateFormat, hh, mi, s);
  // "a/b"
  m = /^(\d{1,2})[\/-](\d{1,2})$/.exec(rest);
  if (m) return numericPair(+m[1], +m[2], dateFormat, nowMs, hh, mi, s);
  return { error: `Unreadable date: ${s}` };
}

function inferYear(nowMs, mo, d, hh, mi) {
  const now = new Date(nowMs);
  let y = now.getFullYear();
  if (new Date(y, mo, d, hh, mi).getTime() > nowMs + 86400000) y -= 1;
  return y;
}

function withDate(y, mo, d, hh, mi) {
  const dt = new Date(y, mo - 1, d, hh, mi);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) {
    return { error: `Impossible date: ${y}-${mo}-${d}` };
  }
  return { iso: dt.toISOString() };
}

function numericTriple(a, b, yRaw, dateFormat, hh, mi, raw) {
  let y = +yRaw;
  if (yRaw.length === 2) y += y < 70 ? 2000 : 1900;
  if (a > 999) return withDate(a, b, y, hh, mi); // 2025/09/15
  const mdyOk = a >= 1 && a <= 12; // a is the month under mdy
  const dmyOk = b >= 1 && b <= 12; // b is the month under dmy
  if (dateFormat === 'ymd') return withDate(a, b, y, hh, mi);
  if (dateFormat === 'mdy') {
    if (mdyOk || !dmyOk) return withDate(y, a, b, hh, mi);
    return { ...withDate(y, b, a, hh, mi), warning: `Date ${raw} does not fit the month/day format; used day/month` };
  }
  if (dateFormat === 'dmy') {
    if (dmyOk || !mdyOk) return withDate(y, b, a, hh, mi);
    return { ...withDate(y, a, b, hh, mi), warning: `Date ${raw} does not fit the day/month format; used month/day` };
  }
  // auto: whichever number cannot be a month settles the order.
  if (b > 12) return withDate(y, a, b, hh, mi); // m/d/y
  if (a > 12) return withDate(y, b, a, hh, mi); // d/m/y
  return { ...withDate(y, a, b, hh, mi), warning: 'Date order is ambiguous; assumed month/day/year' };
}

function numericPair(a, b, dateFormat, nowMs, hh, mi, raw) {
  const moGuess = a - 1;
  const y = inferYear(nowMs, moGuess, b, hh, mi);
  const mdyOk = a >= 1 && a <= 12;
  const dmyOk = b >= 1 && b <= 12;
  if (dateFormat === 'dmy' || (dateFormat === 'auto' && a > 12)) return withDate(y, b, a, hh, mi);
  if (dateFormat === 'mdy' || (dateFormat === 'auto' && b > 12)) return withDate(y, a, b, hh, mi);
  return { ...withDate(y, a, b, hh, mi), warning: 'Date order is ambiguous; assumed month/day/year' };
}

// Time-only cell ("7:00 pm", "19:00", "7pm") -> { hh, mi, index, length } | null.
function extractTime(raw) {
  const s = String(raw ?? '');
  let m = /(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(s);
  if (m) {
    return { hh: withMeridiem(parseInt(m[1], 10) % 24, m[3]), mi: parseInt(m[2], 10), index: m.index, length: m[0].length };
  }
  m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(s);
  if (m) {
    return { hh: withMeridiem(parseInt(m[1], 10) % 24, m[3]), mi: m[2] ? parseInt(m[2], 10) : 0, index: m.index, length: m[0].length };
  }
  return null;
}

function withMeridiem(hh, meridiem) {
  if (!meridiem) return hh;
  const pm = meridiem.toLowerCase() === 'pm';
  if (pm && hh < 12) return hh + 12;
  if (!pm && hh === 12) return 0;
  return hh;
}

function retime(iso, hh, mi) {
  const d = new Date(iso);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mi).toISOString();
}

// ---------------------------------------------------------------- requests

// Body for POST /api/import-ai. Only headers plus the first 20 rows travel;
// the server returns a mapping and applyMapping runs it over every row.
export function buildTableRequest(headers, firstRows = []) {
  if (!Array.isArray(headers) || !headers.length) throw new TypeError('headers must be a non-empty array');
  if (!Array.isArray(firstRows)) throw new TypeError('firstRows must be an array of rows');
  const rows = firstRows.slice(0, MAX_TABLE_SAMPLE_ROWS).map((row, i) => {
    if (!Array.isArray(row)) throw new TypeError(`Row ${i + 1} must be an array of cells`);
    return row.map(cell => (cell == null ? '' : String(cell)));
  });
  return { kind: 'table', headers: headers.map(h => String(h)), rows };
}

// Pasted-notes request. The AI returns the rows directly as JSON.
export function textToSessions(content) {
  const text = String(content ?? '').trim();
  if (!text) throw new TypeError('content must be non-empty text');
  return { kind: 'text', content: text };
}

// Screenshot request (brief 1.1 allows PNG and JPG).
export function imageToSessions(base64, mime = 'image/png') {
  const data = String(base64 ?? '').trim();
  if (!data) throw new TypeError('base64 must be non-empty');
  let m = String(mime ?? 'image/png').trim().toLowerCase();
  if (m === 'image/jpg') m = 'image/jpeg';
  if (!/^image\/(png|jpeg|webp)$/.test(m)) throw new TypeError('mime must be image/png, image/jpeg or image/webp');
  return { kind: 'image', base64: data, mime: m };
}

// Server reply classification. 200 hands the payload through; ANY non-200
// (503 when the key is missing, 500 on a crash, 400 on a bad body) is
// { aiUnavailable: true } so the screen offers manual mapping instead.
export function interpretAiResponse(status, json) {
  if (Number(status) === 200) return { ok: true, aiUnavailable: false, data: json ?? null };
  const message = json && typeof json === 'object' && json.error ? String(json.error) : null;
  return { ok: false, aiUnavailable: true, error: message || `Import AI unavailable (HTTP ${status})` };
}

// ---------------------------------------------------------------- mapping

// Starting point for the no-AI manual mapping screen: every column with a
// suggested role from its header text.
export function manualMappingShape(headers) {
  if (!Array.isArray(headers) || !headers.length) throw new TypeError('headers must be a non-empty array');
  return {
    columns: headers.map((h, index) => ({ index, header: String(h), suggestedRole: suggestRole(h) })),
    rules: { dateFormat: 'auto', currency: null, kind: null, hoursUnit: 'hours' },
  };
}

const HEADER_ALIASES = new Map([
  ['date', 'date'], ['date played', 'date'], ['played', 'date'], ['played on', 'date'],
  ['session date', 'date'], ['day', 'date'], ['when', 'date'],
  ['start', 'start_time'], ['start time', 'start_time'], ['started', 'start_time'], ['time started', 'start_time'],
  ['end', 'end_time'], ['end time', 'end_time'], ['ended', 'end_time'], ['time out', 'end_time'],
  ['duration', 'hours'], ['duration h mm', 'hours'], ['duration h', 'hours'], ['duration hours', 'hours'],
  ['hours', 'hours'], ['hours played', 'hours'], ['length', 'hours'], ['time played', 'hours'],
  ['session length', 'hours'], ['minutes', 'hours'], ['mins', 'hours'],
  ['buy in', 'buyin'], ['buyin', 'buyin'], ['buy ins', 'buyin'], ['buyins', 'buyin'],
  ['invested', 'buyin'], ['cost', 'buyin'], ['entry fee', 'buyin'],
  ['cashed out', 'cashout'], ['cash out', 'cashout'], ['cashout', 'cashout'], ['cashedout', 'cashout'],
  ['end stack', 'cashout'], ['final stack', 'cashout'],
  ['won lost', 'profit'], ['wonlost', 'profit'], ['win loss', 'profit'], ['winloss', 'profit'],
  ['net', 'profit'], ['net result', 'profit'], ['profit', 'profit'], ['p l', 'profit'], ['pnl', 'profit'],
  ['result', 'profit'], ['profit loss', 'profit'],
  ['stake', 'stakes'], ['stakes', 'stakes'], ['blinds', 'stakes'], ['limit', 'stakes'],
  ['game', 'game'], ['variant', 'game'], ['game name', 'game'], ['poker game', 'game'],
  ['location', 'location'], ['venue', 'location'], ['casino', 'location'], ['room', 'location'],
  ['club', 'location'], ['site', 'location'], ['where', 'location'],
  ['type', 'type'], ['kind', 'type'], ['session type', 'type'], ['game type', 'type'],
  ['format', 'type'], ['cash or tournament', 'type'], ['category', 'type'],
  ['entries', 'entries'], ['entrants', 'entries'], ['field size', 'entries'], ['field', 'entries'], ['runners', 'entries'],
  ['place', 'finish'], ['finish', 'finish'], ['finished', 'finish'], ['position', 'finish'], ['rank', 'finish'], ['pos', 'finish'],
  ['rebuys', 'rebuys'], ['rebuys count', 'rebuys'], ['re buy', 'rebuys'],
  ['hands', 'hands'], ['hands count', 'hands'], ['hands played', 'hands'], ['number of hands', 'hands'],
  ['name', 'name'], ['event', 'name'], ['event name', 'name'], ['tournament name', 'name'], ['title', 'name'],
  ['notes', 'notes'], ['note', 'notes'], ['comment', 'notes'], ['comments', 'notes'], ['memo', 'notes'],
  ['currency', 'currency'], ['cur', 'currency'], ['ccy', 'currency'],
]);

// Ordered first-match-wins fallbacks for headers the alias table missed.
const HEADER_PATTERNS = [
  [/date|played|when/, 'date'],
  [/start/, 'start_time'],
  [/duration|hours|length|h mm/, 'hours'],
  [/buy|invested|cost/, 'buyin'],
  [/cash ?out|cashed|stack/, 'cashout'],
  [/won|lost|win|loss|net|profit|pnl|result|p l/, 'profit'],
  [/stake|blind|limit/, 'stakes'],
  [/game|variant|hold|plo|omaha/, 'game'],
  [/location|casino|venue|room|club|site|where/, 'location'],
  [/type|kind|format|category/, 'type'],
  [/entr|field|runners/, 'entries'],
  [/finish|place|position|rank/, 'finish'],
  [/rebuy|re.buy/, 'rebuys'],
  [/hands/, 'hands'],
  [/name|event|title/, 'name'],
  [/note|comment|memo/, 'notes'],
  [/currency|ccy/, 'currency'],
];

export function suggestRole(header) {
  const key = String(header ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!key) return 'ignore';
  if (HEADER_ALIASES.has(key)) return HEADER_ALIASES.get(key);
  for (const [re, role] of HEADER_PATTERNS) if (re.test(key)) return role;
  return 'ignore';
}

// Validate and fill defaults. Tolerates manual-mapping shapes (suggestedRole
// instead of role) and clamps the AI's confidence to 0..1.
export function normalizeMapping(mapping) {
  if (!mapping || typeof mapping !== 'object' || !Array.isArray(mapping.columns)) {
    throw new TypeError('mapping must have a columns array');
  }
  const columns = mapping.columns.map((c, i) => ({
    index: c && Number.isInteger(c.index) && c.index >= 0 ? c.index : i,
    header: c && c.header != null ? String(c.header) : '',
    role: MAPPING_ROLES.includes(c && c.role) ? c.role
      : MAPPING_ROLES.includes(c && c.suggestedRole) ? c.suggestedRole
      : 'ignore',
  }));
  const r = (mapping && mapping.rules) || {};
  return {
    columns,
    confidence: mapping && typeof mapping.confidence === 'number' ? clamp01(mapping.confidence) : null,
    rules: {
      dateFormat: DATE_FORMATS.includes(r.dateFormat) ? r.dateFormat : 'auto',
      currency: r.currency != null && String(r.currency).trim() ? String(r.currency).trim().toUpperCase() : null,
      kind: r.kind === 'cash' || r.kind === 'tournament' ? r.kind : null,
      hoursUnit: r.hoursUnit === 'minutes' ? 'minutes' : 'hours',
    },
  };
}

// 0..1 confidence for one session draft. Penalties are documented so the
// preview can explain a "Check this" flag:
//   no start time -0.25, no duration -0.1;
//   cash: no big blind -0.1, no result information at all -0.35,
//         result incomplete (one side of buy-in/cash-out missing) -0.2;
//   tournament: no buy-in -0.3, no entries -0.15, no finish place -0.05,
//         no result information -0.1;
//   the AI's overall mapping confidence scales the row (a 0.6 mapping never
//   clears the flag), and net_result may ride on the session object.
export function scoreConfidence(session, mapping = {}) {
  const s = session || {};
  let score = 1;
  if (!s.start_time) score -= 0.25;
  if (!(s.duration_seconds > 0)) score -= 0.1;
  if (s.kind === 'tournament') {
    if (s.initial_buy_in == null) score -= 0.3;
    if (s.entries == null) score -= 0.15;
    if (s.position == null) score -= 0.05;
    if (s.net_result == null && !(s.prize > 0)) score -= 0.1;
  } else {
    if (!(s.big_blind > 0)) score -= 0.1;
    const hasBuy = s.buy_in != null;
    const hasOut = s.cashed_out != null;
    if (!hasBuy && !hasOut && s.net_result == null) score -= 0.35;
    else if (!hasBuy && s.net_result == null) score -= 0.2;
    else if (!hasOut && s.net_result == null) score -= 0.2;
  }
  if (mapping && typeof mapping.confidence === 'number') score *= clamp01(mapping.confidence);
  return round2(clamp01(score));
}

const WARNING_PENALTY = 0.12;
const WARNING_PENALTY_MAX = 3;

// Map every row through the mapping. rows: array of cell arrays. Returns
// draft rows (shape in the header comment); nothing is rejected: broken rows
// come back with warnings and needsCheck so the preview can show them.
export function applyMapping(rows, mapping, opts = {}) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array of cell arrays');
  const norm = normalizeMapping(mapping);
  const nowMs = opts.nowMs ?? Date.now();
  const roleIndex = {};
  for (const col of norm.columns) {
    if (col.role !== 'ignore' && !(col.role in roleIndex)) roleIndex[col.role] = col.index;
  }
  return rows.map((cells, i) => {
    if (!Array.isArray(cells)) throw new TypeError(`Row ${i + 1} must be an array of cells`);
    const warnings = [];
    const cell = role => {
      const idx = roleIndex[role];
      if (idx == null) return '';
      const v = cells[idx];
      return v == null ? '' : String(v).trim();
    };
    const money = role => {
      const raw = cell(role);
      const parsed = parseAiMoney(raw);
      if (raw && parsed === undefined) warnings.push(`Could not read the ${role} amount: ${raw}`);
      return parsed === undefined ? null : parsed;
    };
    const buyinM = money('buyin');
    const cashoutM = money('cashout');
    const profitM = money('profit');
    const currency = (buyinM && buyinM.currency) || (cashoutM && cashoutM.currency) || (profitM && profitM.currency) || norm.rules.currency;
    const dateP = parseAiDate(cell('date'), norm.rules.dateFormat, nowMs);
    if (dateP && dateP.error) warnings.push(dateP.error);
    else if (dateP && dateP.warning) warnings.push(dateP.warning);
    let startIso = dateP && dateP.iso;
    if (!startIso && cell('start_time')) {
      const startP = parseAiDate(cell('start_time'), norm.rules.dateFormat, nowMs);
      if (startP && startP.error) warnings.push(startP.error);
      else if (startP && startP.warning) warnings.push(startP.warning);
      else startIso = startP.iso;
    }
    if (startIso && cell('start_time')) {
      const t = extractTime(cell('start_time'));
      if (t) startIso = retime(startIso, t.hh, t.mi);
    }
    let endIso = null;
    if (startIso && cell('end_time')) {
      const endRaw = cell('end_time');
      const t = extractTime(endRaw);
      if (/^\s*\d{1,2}:\d{2}/.test(endRaw) && t) {
        // Time-only end: same day as the start, overnight rolls forward.
        endIso = retime(startIso, t.hh, t.mi);
        if (Date.parse(endIso) <= Date.parse(startIso)) {
          endIso = new Date(Date.parse(endIso) + 86400000).toISOString();
        }
      } else {
        const endP = parseAiDate(endRaw, norm.rules.dateFormat, nowMs);
        if (endP && endP.error) warnings.push(endP.error);
        else if (endP && endP.iso) {
          endIso = t ? retime(endP.iso, t.hh, t.mi) : endP.iso;
          if (Date.parse(endIso) <= Date.parse(startIso)) {
            endIso = new Date(Date.parse(endIso) + 86400000).toISOString();
          }
        }
      }
    }
    const hoursP = parseAiHours(cell('hours'), norm.rules.hoursUnit);
    if (cell('hours') && hoursP === undefined) warnings.push(`Could not read the hours: ${cell('hours')}`);
    const durationSeconds = hoursP && hoursP > 0 ? Math.round(hoursP * 3600) : null;
    const hands = parseAiInt(cell('hands'));
    if (cell('hands') && (hands === undefined || hands < 0)) warnings.push(`Could not read the hands count: ${cell('hands')}`);

    const stakes = parseAiStakes(cell('stakes'));
    const gameCell = canonicalAiGame(cell('game'));
    const kind = norm.rules.kind || parseAiKind(cell('type')) || 'cash';
    const sb = stakes && stakes.smallBlind != null ? stakes.smallBlind : null;
    const bb = stakes && stakes.bigBlind != null ? stakes.bigBlind : null;
    if (sb != null && bb != null && sb > bb) warnings.push('Small blind is bigger than the big blind');

    const session = {
      kind,
      start_time: startIso || null,
      end_time: endIso,
      duration_seconds: durationSeconds,
      break_seconds: 0,
      table_size: null,
      hands_count: hands != null && hands >= 0 ? hands : null,
      hands_count_estimated: false,
      comment: cell('notes') || null,
      opponents: null,
      is_live: false,
      tracked_via_stack: false,
    };
    let netResult;
    if (kind === 'cash') {
      const buyIn = buyinM ? buyinM.value : null;
      const cashOut = cashoutM ? cashoutM.value : null;
      const profit = profitM ? profitM.value : null;
      if (profit != null && buyIn != null && cashOut != null && Math.abs(cashOut - buyIn - profit) > 0.005) {
        warnings.push('Profit does not match cash out minus buy-in; used the profit column');
      }
      if (profit != null) netResult = profit;
      else if (buyIn != null && cashOut != null) netResult = round2(cashOut - buyIn);
      else {
        netResult = null;
        if (cashOut != null && buyIn == null) warnings.push('Buy-in is missing; result could not be computed');
        if (buyIn != null && cashOut == null) warnings.push('Result is missing');
        if (buyIn == null && cashOut == null) warnings.push('Result is missing');
      }
      Object.assign(session, { small_blind: sb, big_blind: bb, buy_in: buyIn, cashed_out: cashOut, tips: 0 });
    } else {
      const initial = buyinM ? buyinM.value : null;
      const rebuys = parseAiInt(cell('rebuys'));
      if (cell('rebuys') && (rebuys === undefined || rebuys < 0)) warnings.push(`Could not read the rebuys: ${cell('rebuys')}`);
      if (rebuys != null && rebuys > 0 && initial == null) warnings.push('Rebuys given without a buy-in; ignored');
      const total = initial != null ? round2(initial * (1 + Math.max(0, rebuys || 0))) : null;
      const cashOut = cashoutM ? cashoutM.value : null;
      const profit = profitM ? profitM.value : null;
      let prize;
      if (cashOut != null) prize = cashOut;
      else if (profit != null && total != null) prize = round2(profit + total);
      else if (profit != null) prize = round2(Math.max(0, profit));
      else prize = 0;
      if (profit != null && total != null && profit + total < 0) warnings.push('Result loses more than the total buy-in');
      const position = parseAiInt(cell('finish'));
      if (cell('finish') && (position === undefined || position < 1)) warnings.push(`Could not read the finish place: ${cell('finish')}`);
      const entries = parseAiInt(cell('entries'));
      if (cell('entries') && (entries === undefined || entries < 1)) warnings.push(`Could not read the entries: ${cell('entries')}`);
      if (position != null && entries != null && position > entries) warnings.push('Finish place is worse than the number of entries');
      netResult = total != null ? round2(prize - total) : (profit != null ? profit : null);
      Object.assign(session, {
        tournament_name: cell('name') || null,
        initial_buy_in: initial,
        total_buy_in: total,
        prize,
        position: position != null && position >= 1 ? position : null,
        entries: entries != null && entries >= 1 ? entries : null,
        tips: 0,
      });
    }
    const refs = {
      game: gameCell || (stakes && stakes.game) || null,
      location: cell('location').replace(/\s+/g, ' ') || null,
      bankroll: null,
      group: null,
      tournament_type: kind === 'tournament' ? tournamentTypeFrom(cell('type')) : null,
    };
    return finalizeDraft({
      session, refs, currency, netResult, warnings,
      confidence: scoreConfidence({ ...session, net_result: netResult }, norm) - WARNING_PENALTY * Math.min(warnings.length, WARNING_PENALTY_MAX),
      line: i + 2,
    });
  });
}

// ---------------------------------------------------------------- ai rows

// Split rows into runs of at most max (the per-run cap the server and the AI
// work in). Empty input -> no chunks.
export function chunkIntoRuns(rows, max = MAX_AI_ROWS_PER_RUN) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  if (!Number.isInteger(max) || max < 1) throw new RangeError('max must be a positive integer');
  const out = [];
  for (let i = 0; i < rows.length; i += max) out.push(rows.slice(i, i + max));
  return out;
}

// Normalize one AI reply into a list of runs. Accepts {rows}, {runs:[{rows}]},
// an array of run objects, or a bare array of row objects.
function normalizeRuns(aiJson) {
  if (Array.isArray(aiJson)) {
    if (aiJson.length && aiJson.every(r => r && typeof r === 'object' && Array.isArray(r.rows))) {
      return aiJson.map(r => r.rows);
    }
    return [aiJson];
  }
  if (!aiJson || typeof aiJson !== 'object') throw new TypeError('AI reply must be an object with rows');
  if (Array.isArray(aiJson.runs)) {
    return aiJson.runs.map(r => {
      if (!r || !Array.isArray(r.rows)) throw new TypeError('Each run must have a rows array');
      return r.rows;
    });
  }
  if (Array.isArray(aiJson.rows)) return [aiJson.rows];
  throw new TypeError('AI reply has no rows');
}

// Turn AI row objects (text/image path: the AI returns the rows directly)
// into draft rows. Row keys accept both friendly names and PA27 field names.
function aiRowToDraft(row, line, opts) {
  const warnings = [];
  const get = (...keys) => {
    for (const k of keys) if (row[k] != null && row[k] !== '') return row[k];
    return null;
  };
  const money = (...keys) => {
    const raw = get(...keys);
    const parsed = parseAiMoney(raw);
    if (raw != null && parsed === undefined) warnings.push(`Could not read the amount: ${raw}`);
    return parsed === undefined ? null : parsed;
  };
  const nowMs = opts.nowMs ?? Date.now();
  const kind = parseAiKind(get('kind', 'type')) || 'cash';
  const buyinM = money('buy_in', 'buyin', 'invested', 'cost');
  const cashoutM = money('cashed_out', 'cash_out', 'cashout', 'payout', 'winnings');
  const profitM = money('net_result', 'profit', 'net', 'won_lost', 'wonlost');
  const currency = (buyinM && buyinM.currency) || (cashoutM && cashoutM.currency) || (profitM && profitM.currency) || (row.currency != null ? String(row.currency).toUpperCase() : null);

  const dateP = parseAiDate(get('start_time', 'date', 'played_at', 'session_date'), 'auto', nowMs);
  if (dateP && dateP.error) warnings.push(dateP.error);
  else if (dateP && dateP.warning) warnings.push(dateP.warning);
  const endP = parseAiDate(get('end_time', 'ended_at', 'end'), 'auto', nowMs);
  if (endP && endP.error) warnings.push(endP.error);
  else if (endP && endP.warning) warnings.push(endP.warning);
  const hoursP = parseAiHours(get('hours', 'duration_hours', 'duration'), 'hours');
  if (get('hours', 'duration_hours', 'duration') != null && hoursP === undefined) warnings.push('Could not read the hours');
  const minutesP = parseAiHours(get('minutes'), 'minutes');
  const hours = hoursP != null && hoursP > 0 ? hoursP : (minutesP != null && minutesP > 0 ? minutesP : null);
  const durationSeconds = hours ? Math.round(hours * 3600) : null;
  const hands = parseAiInt(get('hands_count', 'hands'));

  const stakes = parseAiStakes(get('stakes', 'blinds'));
  const gameCell = canonicalAiGame(get('game', 'variant'));
  const typeCell = get('type', 'kind') || (kind === 'tournament' ? 'tournament' : '');
  const sb = stakes && stakes.smallBlind != null ? stakes.smallBlind : null;
  const bb = stakes && stakes.bigBlind != null ? stakes.bigBlind : null;
  if (sb != null && bb != null && sb > bb) warnings.push('Small blind is bigger than the big blind');

  const session = {
    kind,
    start_time: dateP && dateP.iso ? dateP.iso : null,
    end_time: endP && endP.iso ? endP.iso : null,
    duration_seconds: durationSeconds,
    break_seconds: 0,
    table_size: null,
    hands_count: hands != null && hands >= 0 ? hands : null,
    hands_count_estimated: false,
    comment: get('comment', 'notes', 'note') != null ? String(get('comment', 'notes', 'note')) : null,
    opponents: null,
    is_live: false,
    tracked_via_stack: false,
  };
  let netResult;
  if (kind === 'cash') {
    const buyIn = buyinM ? buyinM.value : null;
    const cashOut = cashoutM ? cashoutM.value : null;
    const profit = profitM ? profitM.value : null;
    if (profit != null && buyIn != null && cashOut != null && Math.abs(cashOut - buyIn - profit) > 0.005) {
      warnings.push('Profit does not match cash out minus buy-in; used the profit column');
    }
    if (profit != null) netResult = profit;
    else if (buyIn != null && cashOut != null) netResult = round2(cashOut - buyIn);
    else {
      netResult = null;
      if (cashOut != null && buyIn == null) warnings.push('Buy-in is missing; result could not be computed');
      if (buyIn == null && cashOut == null) warnings.push('Result is missing');
    }
    Object.assign(session, { small_blind: sb, big_blind: bb, buy_in: buyIn, cashed_out: cashOut, tips: 0 });
  } else {
    const initial = buyinM ? buyinM.value : null;
    const rebuys = parseAiInt(get('rebuys', 'rebuy_count'));
    if (rebuys != null && rebuys > 0 && initial == null) warnings.push('Rebuys given without a buy-in; ignored');
    const total = initial != null ? round2(initial * (1 + Math.max(0, rebuys || 0))) : null;
    const cashOut = cashoutM ? cashoutM.value : null;
    const profit = profitM ? profitM.value : null;
    let prize;
    if (cashOut != null) prize = cashOut;
    else if (profit != null && total != null) prize = round2(profit + total);
    else if (profit != null) prize = round2(Math.max(0, profit));
    else prize = 0;
    const position = parseAiInt(get('position', 'finish', 'place', 'finished'));
    const entries = parseAiInt(get('entries', 'entrants', 'field_size', 'field'));
    if (position != null && entries != null && position > entries) warnings.push('Finish place is worse than the number of entries');
    netResult = total != null ? round2(prize - total) : (profit != null ? profit : null);
    Object.assign(session, {
      tournament_name: get('tournament_name', 'name', 'event', 'title') != null ? String(get('tournament_name', 'name', 'event', 'title')) : null,
      initial_buy_in: initial,
      total_buy_in: total,
      prize,
      position: position != null && position >= 1 ? position : null,
      entries: entries != null && entries >= 1 ? entries : null,
      tips: 0,
    });
  }
  const locationRaw = get('location', 'casino', 'room', 'venue');
  const refs = {
    game: gameCell || (stakes && stakes.game) || null,
    location: locationRaw != null ? String(locationRaw).replace(/\s+/g, ' ') : null,
    bankroll: null,
    group: null,
    tournament_type: kind === 'tournament' ? tournamentTypeFrom(typeCell) : null,
  };
  const rowConfidence = typeof row.confidence === 'number' ? clamp01(row.confidence) : null;
  const confidence = rowConfidence != null
    ? rowConfidence
    : scoreConfidence({ ...session, net_result: netResult }, {});
  return finalizeDraft({
    session, refs, currency, netResult, warnings,
    confidence: confidence - WARNING_PENALTY * Math.min(warnings.length, WARNING_PENALTY_MAX),
    line,
  });
}

function finalizeDraft({ session, refs, currency, netResult, warnings, confidence, line }) {
  const clamped = round2(clamp01(confidence));
  return {
    line,
    session,
    refs,
    currency: currency || null,
    net_result: netResult != null ? round2(netResult) : null,
    warnings,
    confidence: clamped,
    needsCheck: clamped < NEEDS_CHECK_THRESHOLD,
  };
}

// AI rows -> draft rows. Handles one run, a merged multi-run reply
// ({runs:[...]}) or a bare row array; anything over the per-run cap is
// processed in chunks and concatenated, so nothing is lost.
export function rowsFromAi(aiJson, opts = {}) {
  const runs = normalizeRuns(aiJson);
  const out = [];
  let line = 0;
  for (const run of runs) {
    for (const chunk of chunkIntoRuns(run)) {
      for (const row of chunk) {
        if (!row || typeof row !== 'object') throw new TypeError('Each AI row must be an object');
        line += 1;
        out.push(aiRowToDraft(row, line, opts));
      }
    }
  }
  return out;
}
