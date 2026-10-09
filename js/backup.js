// Settings > Export / Import JSON and Reset demo data (brief 5.16). Pure:
// builds and validates documents; the screen applies them with replaceDoc.
//
// Export format: { app: 'poker-analytics-27', format: 1, exported_at, data }
// where data is the full in-memory document minus device UI state. Import also
// accepts a bare document (the Tier 1/2 localStorage shape), so any earlier
// export or local backup round-trips. Non-uuid ids are re-keyed through the
// same legacyToDoc mapping the localStorage migration uses.

import { legacyToDoc } from './cloud-map.js';
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

  const doc = legacyToDoc(data, newId);
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
