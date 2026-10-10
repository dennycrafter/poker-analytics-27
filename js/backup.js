// Settings > Export / Import JSON and Reset demo data (brief 5.16). Pure:
// builds and validates documents; the screen applies them with replaceDoc.
//
// Export format: { app: 'poker-analytics-27', format: 1, exported_at, data }
// where data is the full in-memory document minus device UI state. Import also
// accepts a bare document (the Tier 1/2 localStorage shape), so any earlier
// export or local backup round-trips. Non-uuid ids are re-keyed through the
// same legacyToDoc mapping the localStorage migration uses.

import { legacyToDoc, isUuid } from './cloud-map.js';
import { buildSeed } from './seed.js';

export const EXPORT_APP = 'poker-analytics-27';
export const EXPORT_FORMAT = 1;

const COLLECTIONS = [
  'bankrolls', 'locations', 'games', 'tournament_types', 'groups',
  'sessions', 'stack_events', 'sell_actions', 'transactions',
  'player_notes', 'hand_histories',
];

export function exportPayload(doc, nowIso = new Date().toISOString()) {
  const data = { settings: { currency: (doc.settings && doc.settings.currency) || 'EUR' } };
  for (const k of COLLECTIONS) data[k] = Array.isArray(doc[k]) ? doc[k] : [];
  return { app: EXPORT_APP, format: EXPORT_FORMAT, exported_at: nowIso, data };
}

export function exportFilename(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const p = n => String(n).padStart(2, '0');
  return `poker-analytics-27-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`;
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

// Child collections are mapped by property access in legacyToDoc; a null
// entry would crash with a TypeError before any validation could report it
// (ISSUES.md #8). sessions/transactions have their own item checks above.
const CHILD_COLLECTIONS = COLLECTIONS.filter(k => k !== 'sessions' && k !== 'transactions');

// Mirrors the CHECK constraints on public.sessions
// (supabase/migrations/20261009120000_step_a_backend.sql). A row Postgres
// would refuse must never reach the sync flush — a rejected replace there
// costs the account its existing rows (ISSUES.md #1). Values are judged
// numerically so CSV-style numeric strings behave like the coerced row.
function sessionDbError(s) {
  const int = v => Number.isInteger(Number(v));
  const nonNeg = (v, label) => {
    if (v === null || v === undefined || v === '') return null;
    return !int(v) || Number(v) < 0 ? label : null;
  };
  if (s.table_size !== null && s.table_size !== undefined && s.table_size !== ''
      && (!int(s.table_size) || Number(s.table_size) < 2 || Number(s.table_size) > 10)) {
    return 'A session has an invalid table size (must be 2-10).';
  }
  const start = Date.parse(s.start_time);
  if (s.end_time !== null && s.end_time !== undefined && s.end_time !== '') {
    const end = Date.parse(s.end_time);
    if (!Number.isFinite(end)) return 'A session has an invalid end time.';
    if (end < start) return 'A session ends before it starts.';
  }
  return nonNeg(s.hands_count, 'A session has a negative hands count.')
      || nonNeg(s.duration_seconds, 'A session has a negative duration.')
      || nonNeg(s.break_seconds, 'A session has a negative break time.');
}

// Returns { ok: true, doc, counts } or { ok: false, error }.
export function parseImport(text, newId) {
  let raw;
  try { raw = JSON.parse(text); } catch (e) {
    return { ok: false, error: 'This file is not valid JSON.' };
  }
  if (!isObj(raw)) return { ok: false, error: 'This file does not contain Poker Analytics data.' };
  let data = raw;
  if (raw.app !== undefined || raw.data !== undefined) {
    if (raw.app !== EXPORT_APP || !isObj(raw.data)) return { ok: false, error: 'This file is not a Poker Analytics 27 export.' };
    if (Number(raw.format) > EXPORT_FORMAT) return { ok: false, error: 'This export was made by a newer version of the app.' };
    data = raw.data;
  }
  if (!Array.isArray(data.sessions)) return { ok: false, error: 'This file has no sessions list.' };
  for (const k of COLLECTIONS) {
    if (data[k] !== undefined && !Array.isArray(data[k])) return { ok: false, error: `"${k}" must be a list.` };
  }
  const bad = data.sessions.find(s => !isObj(s) || !s.id || !['cash', 'tournament'].includes(s.kind) || !Number.isFinite(Date.parse(s.start_time)));
  if (bad) return { ok: false, error: 'A session is missing its id, kind or start time.' };
  const badTxn = (data.transactions || []).find(t => !isObj(t) || !['deposit', 'withdrawal', 'other'].includes(t.kind) || !Number.isFinite(Number(t.amount)));
  if (badTxn) return { ok: false, error: 'A transaction has an unknown kind or amount.' };

  // (#8) Null child entries would crash legacyToDoc with a TypeError.
  for (const k of CHILD_COLLECTIONS) {
    if ((data[k] || []).some(x => !isObj(x))) return { ok: false, error: `"${k}" contains an invalid entry.` };
  }

  // (#1, #2) Refuse sessions the database would reject.
  for (const s of data.sessions) {
    const e = sessionDbError(s);
    if (e) return { ok: false, error: e };
  }

  // (#3) Two rows sharing an id collapse into one during the uuid remap; the
  // resulting double upsert of the same primary key is rejected by Postgres.
  if (new Set(data.sessions.map(s => s.id)).size !== data.sessions.length) {
    return { ok: false, error: 'Two sessions share the same id.' };
  }
  const txnIds = (data.transactions || []).filter(t => isUuid(t.id)).map(t => t.id);
  if (new Set(txnIds).size !== txnIds.length) {
    return { ok: false, error: 'Two transactions share the same id.' };
  }

  const doc = legacyToDoc(data, newId);

  // (#7) Total sold of a tournament can never exceed 100% — the Sell sheet
  // enforces this while editing; an import must not bypass it.
  const sold = new Map();
  for (const a of doc.sell_actions) {
    const pct = Number(a.percentage);
    if (!Number.isFinite(pct)) return { ok: false, error: 'A sell action has an invalid percentage.' };
    sold.set(a.session_id, (sold.get(a.session_id) || 0) + pct);
  }
  for (const pct of sold.values()) {
    if (pct > 100.000001) return { ok: false, error: 'Sell actions total more than 100% of a tournament.' };
  }

  // A file can never import a second live session or a ghost live one.
  const live = doc.sessions.filter(s => s.is_live);
  for (const s of live.slice(1)) s.is_live = false;
  return { ok: true, doc, counts: importCounts(doc) };
}

export function importCounts(doc) {
  return {
    sessions: doc.sessions.length,
    transactions: doc.transactions.length,
    notes: doc.player_notes.length,
    hands: doc.hand_histories.length,
  };
}

// Demo dataset (brief section 10) re-keyed to uuids for the cloud store.
// For a signed-in account "Reset demo data" REPLACES the account's data with
// this seed (confirmed first) — the cloud has no separate demo layer.
export function demoDoc(nowMs, newId) {
  return legacyToDoc(buildSeed(nowMs), newId);
}
