// Import AI proxy (brief 1.3, server side). Zero-dependency Node 20 module:
// plain node imports only, no npm. Pure request handlers with INJECTABLE
// fetch and env, so tests never touch the network and never need a real key.
//
// One route lives here: POST /api/import-ai, three request kinds:
//   {kind:'table', headers, rows}   headers + at most 20 sample rows -> the
//                                   model returns a column mapping (roles per
//                                   column plus parsing rules). The client
//                                   applies the mapping to every row itself,
//                                   so big files stay cheap.
//   {kind:'text', content}          pasted notes -> the model returns session
//                                   rows directly as JSON, at most
//                                   MAX_ROWS_PER_RUN rows per call. Bigger
//                                   inputs are split by lines into sequential
//                                   calls and the rows are concatenated.
//   {kind:'image', base64, mime}    screenshot -> one call, rows returned
//                                   directly (an image cannot be split).
//
// Response envelopes (what the web client codes against):
//   table -> 200 {ok:true, kind:'table', mapping:{roles:{header:role}, rules:{date_format, currency, session_type, notes}}}
//   text  -> 200 {ok:true, kind:'text', rows:[...], calls:n}
//   image -> 200 {ok:true, kind:'image', rows:[...]}
// Roles use the exact IMPORT_FIELDS vocabulary from js/csv-import.js (plus
// 'ignore'), so mapped columns plug straight into the existing importer.
// Rows use the same field names as keys, plus a `confidence` number in [0,1]
// on every row (0.5 when the model omits it) so the preview can flag
// "Check this" rows.
//
// Error contract (exact shapes):
//   400 {error:'bad_request', detail}  malformed client request
//   503 {error:'ai_unavailable'}       missing/unusable key, network failure,
//                                      or any non-OK Anthropic status; the
//                                      client then offers manual mapping
//   502 {error:'ai_bad_reply'}         HTTP 200 from Anthropic but an
//                                      unusable reply: no text blocks,
//                                      unparseable JSON, wrong shape
//
// The API key is read from env.ANTHROPIC_API_KEY and is only ever sent to the
// Anthropic Messages API. It is never logged, never returned to a client, and
// never embedded in an error message.

import { FIELD_KEYS } from '../js/csv-import.js';

export const MODEL = 'claude-sonnet-5-5';
export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
export const MAX_TABLE_ROWS = 20;        // sample rows sent to the model for mapping
export const MAX_ROWS_PER_RUN = 300;     // rows one AI call may return
export const MAX_CALLS_PER_REQUEST = 20; // safety cap: 20 x 300 = 6000 rows per request
export const MAX_TOKENS_MAPPING = 2048;
export const MAX_TOKENS_ROWS = 32000;
export const IMAGE_MIMES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const MAPPING_ROLES = Object.freeze([...FIELD_KEYS, 'ignore']);

// Transport/HTTP problems -> 503. An HTTP 200 whose payload we cannot use -> 502.
export class AiUnavailableError extends Error {}
export class AiBadReplyError extends Error {}

// ---------- prompt building ----------

// The row shape pasted-text and image replies must follow. Field names match
// the existing importer vocabulary (IMPORT_FIELDS) so downstream mapping,
// staging and preview code needs no translation.
const ROW_SHAPE = `{
  "kind": "cash" or "tournament",
  "date": "YYYY-MM-DD",
  "start_time": "YYYY-MM-DDTHH:mm",        (optional, only if known)
  "end_time": "YYYY-MM-DDTHH:mm",          (optional)
  "duration": hours as a number or H:MM,   (optional playing time)
  "duration_minutes": 0,                   (optional)
  "game": "NLH", "PLO", or similar,        (optional)
  "stakes": "1/2",                         (cash only, if known)
  "small_blind": 1, "big_blind": 2,        (cash only, numbers)
  "buy_in": 0, "cashed_out": 0,            (cash, numbers)
  "net_result": 0,                         (signed profit when buy-in or cash-out is unknown)
  "tips": 0,                               (optional number)
  "hands_count": 0,                        (optional integer)
  "location": "casino or room name",       (optional)
  "tournament_name": "name",               (tournament only)
  "initial_buy_in": 0, "total_buy_in": 0,  (tournament, numbers)
  "prize": 0, "position": 0, "entries": 0, (tournament)
  "comment": "free text",                  (optional)
  "confidence": number 0 to 1              (how sure you are this row is correct)
}`;

export function buildTablePrompt(headers, rows) {
  return [
    'You are a column mapper for a poker session tracker.',
    'Given spreadsheet headers and sample rows, decide the role of every column.',
    '',
    `Allowed roles, exactly one per column, or "ignore": ${MAPPING_ROLES.join(', ')}.`,
    'Prefer "stakes" for a combined SB/BB column like "1/2".',
    'Use "duration" for hours or H:MM values and "duration_minutes" for minutes.',
    'Use "net_result" for a signed profit or loss column and "cashed_out" for an ending stack column.',
    'For tournaments use initial_buy_in, total_buy_in, prize, position, entries as appropriate.',
    '',
    'Rules object:',
    '- date_format: how dates are written, for example "YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY", "MMM D YYYY"',
    '- currency: ISO code if visible, otherwise "USD"',
    '- session_type: "cash" or "tournament", the kind these rows describe',
    '- notes: at most 2 sentences the importer should know',
    '',
    `Headers: ${JSON.stringify(headers)}`,
    `Sample rows: ${JSON.stringify(rows)}`,
    '',
    'Reply with ONLY this JSON, no prose, no markdown fences:',
    '{"roles":{"<header>":"<role>"},"rules":{"date_format":"...","currency":"...","session_type":"cash or tournament","notes":"..."}}',
  ].join('\n');
}

const ROWS_TAIL = [
  '',
  'Reply with ONLY this JSON, no prose, no markdown fences:',
  '{"rows":[' + ROW_SHAPE.replace(/\n/g, ' ') + ' ]}',
].join('\n');

export function buildTextRowsPrompt(chunk) {
  return [
    'These lines come from a poker player\'s notes. Each line describes one session.',
    'Convert every session line into one row in the JSON shape below.',
    'Drop lines that are not sessions. If a value is unknown, leave the field out.',
    'Cash sessions need stakes and buy_in plus cashed_out or net_result.',
    'Tournaments need the tournament fields (initial_buy_in, total_buy_in, prize, position, entries).',
    '',
    'Lines:',
    chunk,
    ROWS_TAIL,
  ].join('\n');
}

export function buildImageRowsPrompt() {
  return [
    'The attached image is a poker session list: a screenshot, a spreadsheet photo, or a handwritten page.',
    'Read every session and return each one as a row in the JSON shape below.',
    'Cash sessions need stakes and buy_in plus cashed_out or net_result.',
    'Tournaments need the tournament fields (initial_buy_in, total_buy_in, prize, position, entries).',
    ROWS_TAIL,
  ].join('\n');
}

// ---------- reply parsing ----------

// The model often wraps JSON in markdown fences or adds prose around it.
// Pull the outermost {...} or [...] block and parse it.
export function extractJson(text) {
  if (typeof text !== 'string') throw new AiBadReplyError('reply text is not a string');
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  if (!t) throw new AiBadReplyError('reply contains no text');
  const firstObj = t.indexOf('{');
  const firstArr = t.indexOf('[');
  let start, close;
  if (firstObj === -1 || (firstArr !== -1 && firstArr < firstObj)) {
    start = firstArr; close = ']';
  } else {
    start = firstObj; close = '}';
  }
  if (start === -1) throw new AiBadReplyError('reply contains no JSON');
  const lastClose = t.lastIndexOf(close);
  if (lastClose <= start) throw new AiBadReplyError('reply JSON is truncated');
  try {
    return JSON.parse(t.slice(start, lastClose + 1));
  } catch {
    throw new AiBadReplyError('reply JSON does not parse');
  }
}

// Concatenated text of every text block in a Messages API response.
export function replyText(body) {
  if (!body || typeof body !== 'object') throw new AiBadReplyError('anthropic body is not an object');
  if (body.type === 'error') throw new AiUnavailableError('anthropic returned an error envelope');
  const blocks = Array.isArray(body.content) ? body.content : [];
  const text = blocks
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('');
  if (!text.trim()) throw new AiBadReplyError('anthropic reply has no text blocks');
  return text;
}

// A usable mapping is {roles:{header:role}, rules:{...}} with at least one
// column mapped to a real role. Unknown role names pass through; the client
// treats them as unmapped. Wrong shape -> AiBadReplyError.
export function parseMapping(text) {
  const parsed = extractJson(text);
  const mapping = parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
    parsed.mapping && typeof parsed.mapping === 'object' ? parsed.mapping : parsed;
  const roles = mapping && typeof mapping === 'object' ? mapping.roles : null;
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) {
    throw new AiBadReplyError('mapping has no roles object');
  }
  const entries = Object.entries(roles);
  if (!entries.length) throw new AiBadReplyError('mapping roles object is empty');
  for (const [, role] of entries) {
    if (typeof role !== 'string') throw new AiBadReplyError('mapping role is not a string');
  }
  if (!entries.some(([, role]) => role !== 'ignore')) {
    throw new AiBadReplyError('mapping maps every column to ignore');
  }
  const rules = mapping.rules === undefined ? {} : mapping.rules;
  if (typeof rules !== 'object' || rules === null || Array.isArray(rules)) {
    throw new AiBadReplyError('mapping rules is not an object');
  }
  return { roles, rules };
}

// Rows come back as {"rows":[...]} or a bare [...]. Every row must be an
// object and every row gets a numeric confidence in [0,1] (0.5 when the
// model omits it) so the preview can flag "Check this" rows.
export function parseRows(text) {
  const parsed = extractJson(text);
  const raw = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' ? parsed.rows : null;
  if (!Array.isArray(raw)) throw new AiBadReplyError('rows reply is not an array');
  return raw.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new AiBadReplyError('a row is not an object');
    }
    const c = row.confidence;
    const conf = typeof c === 'number' && Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0.5;
    return { ...row, confidence: conf };
  });
}

// ---------- one Anthropic call ----------

// Throws AiUnavailableError for transport/HTTP trouble, AiBadReplyError for
// an OK response we cannot read. parts: text and/or image content blocks.
export async function callAnthropic(fetchImpl, key, parts, maxTokens) {
  let res;
  try {
    res = await fetchImpl(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        // NOTE: no `temperature` — claude-sonnet-5-5 rejects it with
        // invalid_request_error ("temperature is deprecated for this model").
        messages: [{ role: 'user', content: parts }],
      }),
    });
  } catch (err) {
    throw new AiUnavailableError('anthropic fetch failed: ' + (err && err.message ? err.message : 'unknown'));
  }
  if (!res || typeof res.ok !== 'boolean' || typeof res.status !== 'number') {
    throw new AiUnavailableError('injectable fetch did not return a response');
  }
  if (!res.ok) throw new AiUnavailableError('anthropic http ' + res.status);
  let body;
  try {
    body = await res.json();
  } catch {
    try { body = JSON.parse(await res.text()); }
    catch { throw new AiBadReplyError('anthropic 200 body is not JSON'); }
  }
  return { text: replyText(body) };
}

// ---------- the handler ----------

function bad(detail) {
  return { status: 400, json: { error: 'bad_request', detail } };
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validateBody(body) {
  if (!isObject(body)) return bad('body must be a JSON object');
  if (body.kind === 'table') {
    const headers = body.headers;
    if (!Array.isArray(headers) || !headers.length ||
        !headers.every(h => typeof h === 'string' && h.trim() !== '')) {
      return bad('headers must be a non-empty array of strings');
    }
    if (!Array.isArray(body.rows)) return bad('rows must be an array');
    return null;
  }
  if (body.kind === 'text') {
    if (typeof body.content !== 'string' || body.content.trim() === '') {
      return bad('content must be a non-empty string');
    }
    return null;
  }
  if (body.kind === 'image') {
    if (typeof body.base64 !== 'string' || body.base64.trim() === '') {
      return bad('base64 must be a non-empty string');
    }
    if (!IMAGE_MIMES.includes(body.mime)) {
      return bad('mime must be one of ' + IMAGE_MIMES.join(', '));
    }
    if (!/^[A-Za-z0-9+/=\s]+$/.test(body.base64)) return bad('base64 is not valid base64');
    return null;
  }
  return bad("kind must be 'table', 'text' or 'image'");
}

async function importTable(body, fetchImpl, key) {
  // Rows arrive as JSON-safe values (arrays of cells or objects); send the
  // first MAX_TABLE_ROWS verbatim and let the model see real data.
  const sample = body.rows.slice(0, MAX_TABLE_ROWS);
  const { text } = await callAnthropic(
    fetchImpl, key,
    [{ type: 'text', text: buildTablePrompt(body.headers, sample) }],
    MAX_TOKENS_MAPPING,
  );
  const mapping = parseMapping(text);
  return { status: 200, json: { ok: true, kind: 'table', mapping } };
}

async function importText(body, fetchImpl, key) {
  const chunks = chunkText(body.content, MAX_ROWS_PER_RUN);
  if (!chunks.length) return bad('content has no session lines');
  if (chunks.length > MAX_CALLS_PER_REQUEST) {
    return bad('Content is too long. Split it into smaller pastes (at most 6000 lines).');
  }
  const rows = [];
  for (const chunk of chunks) {
    const { text } = await callAnthropic(
      fetchImpl, key,
      [{ type: 'text', text: buildTextRowsPrompt(chunk) }],
      MAX_TOKENS_ROWS,
    );
    rows.push(...parseRows(text));
  }
  return { status: 200, json: { ok: true, kind: 'text', rows, calls: chunks.length } };
}

async function importImage(body, fetchImpl, key) {
  const { text } = await callAnthropic(
    fetchImpl, key,
    [
      { type: 'image', source: { type: 'base64', media_type: body.mime, data: body.base64.replace(/\s+/g, '') } },
      { type: 'text', text: buildImageRowsPrompt() },
    ],
    MAX_TOKENS_ROWS,
  );
  const rows = parseRows(text);
  return { status: 200, json: { ok: true, kind: 'image', rows } };
}

// Split pasted text into chunks of at most maxLines non-empty lines so each
// AI call is asked for at most MAX_ROWS_PER_RUN rows (brief 1.3). Blank lines
// carry no sessions and are dropped.
export function chunkText(content, maxLines = MAX_ROWS_PER_RUN) {
  const lines = String(content).split(/\r?\n/).filter(l => l.trim() !== '');
  const chunks = [];
  for (let i = 0; i < lines.length; i += maxLines) {
    chunks.push(lines.slice(i, i + maxLines).join('\n'));
  }
  return chunks;
}

// Pure entry point. deps: { fetch, env } - both injectable so tests never
// touch the network and never need a real key. Returns {status, json}; it
// never throws for request-level problems (bad body, no key, bad reply).
export async function handleImportAi(body, deps) {
  const fetchImpl = deps && typeof deps.fetch === 'function' ? deps.fetch : null;
  if (!fetchImpl) throw new Error('handleImportAi needs an injectable fetch');
  const shape = validateBody(body);
  if (shape) return shape;
  const key = deps.env && deps.env.ANTHROPIC_API_KEY;
  if (typeof key !== 'string' || !key.trim()) {
    return { status: 503, json: { error: 'ai_unavailable' } };
  }
  try {
    if (body.kind === 'table') return await importTable(body, fetchImpl, key.trim());
    if (body.kind === 'text') return await importText(body, fetchImpl, key.trim());
    return await importImage(body, fetchImpl, key.trim());
  } catch (err) {
    if (err instanceof AiUnavailableError) return { status: 503, json: { error: 'ai_unavailable' } };
    if (err instanceof AiBadReplyError) return { status: 502, json: { error: 'ai_bad_reply' } };
    throw err;
  }
}
