// Pure mappings between the in-memory document (the shape every screen reads)
// and the Supabase rows defined in supabase/migrations. No I/O here, so the
// sync engine (store.js) and the legacy migration share one tested contract.
//
// Embedding: a session row carries its own stack_events and sell_actions as
// jsonb arrays; in memory they live in flat doc.stack_events / doc.sell_actions
// lists keyed by session_id (unchanged from the localStorage era).

export const SESSION_COLUMNS = [
  'id', 'kind', 'game_id', 'location_id', 'bankroll_id', 'group_id', 'table_size',
  'start_time', 'end_time', 'duration_seconds', 'break_seconds',
  'is_live', 'paused_at', 'hands_count', 'hands_count_estimated',
  'comment', 'opponents', 'tracked_via_stack',
  'small_blind', 'big_blind', 'buy_in', 'cashed_out', 'tips',
  'tournament_type_id', 'tournament_name', 'initial_buy_in', 'total_buy_in',
  'prize', 'position', 'entries', 'created_at',
];

export const TRANSACTION_COLUMNS = ['id', 'bankroll_id', 'kind', 'amount', 'description', 'occurred_at', 'created_at'];

export const MASTER_LISTS = ['bankrolls', 'locations', 'games', 'tournament_types', 'groups'];

const INT_COLS = new Set(['table_size', 'duration_seconds', 'break_seconds', 'hands_count', 'position', 'entries']);
const NUM_COLS = new Set(['small_blind', 'big_blind', 'buy_in', 'cashed_out', 'tips', 'initial_buy_in', 'total_buy_in', 'prize', 'amount']);
const TS_COLS = new Set(['start_time', 'end_time', 'paused_at', 'created_at', 'updated_at', 'occurred_at']);
const BOOL_COLS = new Set(['is_live', 'hands_count_estimated', 'tracked_via_stack']);

// JSON with sorted object keys: jsonb does not preserve key order, so this is
// the only safe way to compare a server row with a locally built one.
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort()
    .filter(k => v[k] !== undefined)
    .map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }

// Canonical ISO-8601 UTC (ms precision). Postgres/realtime may send
// "2026-10-09 20:31:00.123456+00" or a bare timestamp without zone; a bare
// value is UTC (the database runs in UTC), never local time.
export function normTs(v) {
  if (v === null || v === undefined || v === '') return null;
  let s = String(v).trim().replace(' ', 'T');
  if (!/(Z|[+-]\d\d(:?\d\d)?)$/i.test(s)) s += 'Z';
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function tsMs(v) {
  const iso = normTs(v);
  return iso === null ? null : Date.parse(iso);
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function coerce(col, v) {
  if (BOOL_COLS.has(col)) return !!v;
  if (TS_COLS.has(col)) return normTs(v);
  if (INT_COLS.has(col)) { const n = numOrNull(v); return n === null ? null : Math.round(n); }
  if (NUM_COLS.has(col)) return numOrNull(v);
  return v === undefined || v === '' ? null : v;
}

function stackEventOut(e) {
  return { id: e.id, kind: e.kind, amount: numOrNull(e.amount) ?? 0, occurred_at: normTs(e.occurred_at) };
}

function sellActionOut(a) {
  return {
    id: a.id,
    percentage: numOrNull(a.percentage) ?? 0,
    markup: numOrNull(a.markup) ?? 1,
    backer_name: a.backer_name ?? null,
  };
}

// --- sessions ---------------------------------------------------------------

// Write payload for one session. Column order is fixed, so JSON.stringify of
// the result is a stable fingerprint for change detection.
export function sessionToRow(doc, s, userId) {
  const row = { user_id: userId };
  for (const c of SESSION_COLUMNS) row[c] = coerce(c, s[c]);
  row.break_seconds = row.break_seconds ?? 0;
  // An explicit null would override the column default and violate NOT NULL;
  // fall back to a deterministic value so the fingerprint survives the echo.
  row.created_at = row.created_at ?? row.start_time;
  row.stack_events = doc.stack_events.filter(e => e.session_id === s.id).map(stackEventOut);
  row.sell_actions = doc.sell_actions.filter(a => a.session_id === s.id).map(sellActionOut);
  return row;
}

// Server row -> in-memory entities.
export function rowToSessionParts(row) {
  const session = {};
  for (const c of SESSION_COLUMNS) session[c] = coerce(c, row[c]);
  session.break_seconds = session.break_seconds ?? 0;
  session.updated_at = normTs(row.updated_at);
  const stack_events = (Array.isArray(row.stack_events) ? row.stack_events : [])
    .map(e => ({ ...stackEventOut(e), session_id: row.id }));
  const sell_actions = (Array.isArray(row.sell_actions) ? row.sell_actions : [])
    .map(a => ({ ...sellActionOut(a), session_id: row.id }));
  return { session, stack_events, sell_actions };
}

// --- bankroll transactions --------------------------------------------------

export function transactionToRow(t, userId) {
  const row = { user_id: userId };
  for (const c of TRANSACTION_COLUMNS) row[c] = coerce(c, t[c]);
  // Legacy transactions carry no created_at (see sessionToRow for why).
  row.created_at = row.created_at ?? row.occurred_at;
  return row;
}

export function rowToTransaction(row) {
  const t = {};
  for (const c of TRANSACTION_COLUMNS) t[c] = coerce(c, row[c]);
  t.updated_at = normTs(row.updated_at);
  return t;
}

// --- user settings (master data, notes, hand histories, currency) ----------

export function settingsToRow(doc, userId) {
  const master_data = {};
  for (const k of MASTER_LISTS) master_data[k] = doc[k] || [];
  return {
    user_id: userId,
    currency: (doc.settings && doc.settings.currency) || 'EUR',
    master_data,
    player_notes: doc.player_notes || [],
    hand_histories: doc.hand_histories || [],
  };
}

export function applySettingsRow(doc, row) {
  const md = row.master_data || {};
  for (const k of MASTER_LISTS) doc[k] = Array.isArray(md[k]) ? md[k] : [];
  doc.settings = { ...(doc.settings || {}), currency: row.currency || 'EUR' };
  doc.player_notes = Array.isArray(row.player_notes) ? row.player_notes : [];
  doc.hand_histories = Array.isArray(row.hand_histories) ? row.hand_histories : [];
}

// Master data for a brand-new account. Ids are deterministic so two devices
// signing in for the first time at once cannot fork the lists.
export function defaultSettings(nowIso) {
  return {
    settings: { currency: 'EUR' },
    bankrolls: [{ id: 'bk-live', name: 'Live', is_default: true, created_at: nowIso }],
    games: [
      { id: 'g-nlh', name: "NL Hold'em" },
      { id: 'g-plo', name: 'PLO' },
      { id: 'g-plo5', name: 'PLO5' },
    ],
    tournament_types: [
      { id: 'tt-mtt', name: 'MTT' },
      { id: 'tt-sng', name: 'SNG' },
      { id: 'tt-spin', name: 'Spin & Go' },
      { id: 'tt-sat', name: 'Satellite' },
    ],
    locations: [],
    groups: [],
    player_notes: [],
    hand_histories: [],
  };
}

// --- legacy localStorage document (Tier 1 / Tier 2) -> cloud rows -----------

export function legacyCounts(legacy) {
  if (!legacy || typeof legacy !== 'object') return { sessions: 0, transactions: 0, notes: 0, hands: 0 };
  return {
    sessions: (legacy.sessions || []).length,
    transactions: (legacy.transactions || []).length,
    notes: (legacy.player_notes || []).length,
    hands: (legacy.hand_histories || []).length,
  };
}

export function legacyHasRecords(legacy) {
  const c = legacyCounts(legacy);
  return c.sessions + c.transactions + c.notes + c.hands > 0;
}

// Legacy document -> cloud-ready document of the same shape. Session and
// transaction ids become uuids (primary keys) and every session_id reference
// is re-pointed; master-data ids are text columns and kept as-is. Device UI
// state (legacy.ui) is intentionally dropped. The store's diff sync uploads it.
export function legacyToDoc(legacy, newId) {
  const idMap = new Map();
  const remap = id => {
    if (isUuid(id)) return id;
    if (!idMap.has(id)) idMap.set(id, newId());
    return idMap.get(id);
  };
  const reSession = x => ({ ...x, session_id: x.session_id ? remap(x.session_id) : null });
  const fallback = defaultSettings(new Date().toISOString());
  const pick = k => (Array.isArray(legacy[k]) && legacy[k].length ? legacy[k] : fallback[k]);
  return {
    settings: { currency: (legacy.settings && legacy.settings.currency) || 'EUR' },
    bankrolls: pick('bankrolls'),
    locations: legacy.locations || [],
    games: pick('games'),
    tournament_types: pick('tournament_types'),
    groups: legacy.groups || [],
    sessions: (legacy.sessions || []).map(s => ({ ...s, id: remap(s.id) })),
    stack_events: (legacy.stack_events || []).map(reSession),
    sell_actions: (legacy.sell_actions || []).map(reSession),
    transactions: (legacy.transactions || []).map(t => ({ ...t, id: isUuid(t.id) ? t.id : newId() })),
    player_notes: (legacy.player_notes || []).map(reSession),
    hand_histories: (legacy.hand_histories || []).map(reSession),
  };
}
