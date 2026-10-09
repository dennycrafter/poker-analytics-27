// Settings > Export / Import JSON and Reset demo data (brief 5.16), ported
// 1:1 from the web app's js/backup.js (+ legacyToDoc from js/cloud-map.js).
// Pure: builds and validates documents; the Settings screen applies them with
// replaceDoc() (src/state/replace.ts).
//
// Export format: { app: 'poker-analytics-27', format: 1, exported_at, data }
// where data is the full document minus device UI state. Import also accepts
// a bare document (the web's Tier 1/2 localStorage shape), so any web or
// native export round-trips on either client. Non-uuid ids are re-keyed the
// same way the web's localStorage migration does it.
import { defaultMasterData, isUuid } from './cloud-map';
import { buildSeed } from './seed';
import type { Bankroll, Doc, JsonValue, NamedItem, SellAction, Session, StackEvent, Transaction } from './types';

export const EXPORT_APP = 'poker-analytics-27';
export const EXPORT_FORMAT = 1;

export const COLLECTIONS = [
  'bankrolls', 'locations', 'games', 'tournament_types', 'groups',
  'sessions', 'stack_events', 'sell_actions', 'transactions',
  'player_notes', 'hand_histories',
] as const;
type Collection = (typeof COLLECTIONS)[number];

/** One untyped record from a JSON file (validated before it becomes a Doc entity). */
export type RawRecord = Record<string, unknown>;
/** A bare document as found in a file or produced by the seed. */
export type RawDoc = { [k: string]: unknown; settings?: { currency?: unknown } } & Partial<Record<Collection, RawRecord[]>>;

export type ExportData = { settings: { currency: string } } & Record<Collection, unknown[]>;
export interface ExportPayload { app: typeof EXPORT_APP; format: typeof EXPORT_FORMAT; exported_at: string; data: ExportData }

export function exportPayload(doc: Doc, nowIso: string = new Date().toISOString()): ExportPayload {
  const data = { settings: { currency: doc.settings?.currency || 'EUR' } } as ExportData;
  // extra_master (unknown web master keys) is device-sync plumbing, not part
  // of the web export format, so it is intentionally not written.
  for (const k of COLLECTIONS) data[k] = Array.isArray(doc[k]) ? (doc[k] as unknown[]) : [];
  return { app: EXPORT_APP, format: EXPORT_FORMAT, exported_at: nowIso, data };
}

/** Same pretty-printing as the web download (JSON.stringify(payload, null, 2)). */
export function exportText(doc: Doc, nowIso?: string): string {
  return JSON.stringify(exportPayload(doc, nowIso), null, 2);
}

export function exportFilename(nowMs: number = Date.now()): string {
  const d = new Date(nowMs);
  const p = (n: number) => String(n).padStart(2, '0');
  return `poker-analytics-27-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export interface ImportCounts { sessions: number; transactions: number; notes: number; hands: number }
export type ImportResult = { ok: true; doc: Doc; counts: ImportCounts } | { ok: false; error: string };

/** Validate and re-key an export (or bare document). Error wording matches the web. */
export function parseImport(text: string, newId: () => string): ImportResult {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch {
    return { ok: false, error: 'This file is not valid JSON.' };
  }
  if (!isObj(raw)) return { ok: false, error: 'This file does not contain Poker Analytics data.' };
  let data: Record<string, unknown> = raw;
  if (raw.app !== undefined || raw.data !== undefined) {
    if (raw.app !== EXPORT_APP || !isObj(raw.data)) return { ok: false, error: 'This file is not a Poker Analytics 27 export.' };
    if (Number(raw.format) > EXPORT_FORMAT) return { ok: false, error: 'This export was made by a newer version of the app.' };
    data = raw.data;
  }
  if (!Array.isArray(data.sessions)) return { ok: false, error: 'This file has no sessions list.' };
  for (const k of COLLECTIONS) {
    if (data[k] !== undefined && !Array.isArray(data[k])) return { ok: false, error: `"${k}" must be a list.` };
  }
  const sessions = data.sessions as unknown[];
  const bad = sessions.find(s => !isObj(s) || !s.id || !['cash', 'tournament'].includes(String(s.kind)) || !Number.isFinite(Date.parse(String(s.start_time))));
  if (bad !== undefined) return { ok: false, error: 'A session is missing its id, kind or start time.' };
  const txns = (data.transactions as unknown[] | undefined) || [];
  const badTxn = txns.find(t => !isObj(t) || !['deposit', 'withdrawal', 'other'].includes(String(t.kind)) || !Number.isFinite(Number(t.amount)));
  if (badTxn !== undefined) return { ok: false, error: 'A transaction has an unknown kind or amount.' };
  const doc = legacyToDoc(data as RawDoc, newId);
  // A file can never import a second live session or a ghost live one.
  const live = doc.sessions.filter(s => s.is_live);
  for (const s of live.slice(1)) s.is_live = false;
  return { ok: true, doc, counts: importCounts(doc) };
}

export function importCounts(doc: Pick<Doc, 'sessions' | 'transactions' | 'player_notes' | 'hand_histories'>): ImportCounts {
  return {
    sessions: doc.sessions.length,
    transactions: doc.transactions.length,
    notes: doc.player_notes.length,
    hands: doc.hand_histories.length,
  };
}

/**
 * Legacy / exported document -> cloud-ready Doc of the same shape (port of the
 * web's legacyToDoc). Session and transaction ids become uuids (primary keys)
 * and every session_id reference is re-pointed; master-data ids are text
 * columns and kept. Records are otherwise copied verbatim, exactly as on the
 * web, so the exported JSON is byte-compatible across clients; the cloud row
 * mapping (cloud-map.ts) canonicalises types on write.
 */
export function legacyToDoc(legacy: RawDoc, newId: () => string): Doc {
  const idMap = new Map<unknown, string>();
  const remap = (id: unknown): string => {
    if (isUuid(id)) return id;
    let v = idMap.get(id);
    if (v === undefined) { v = newId(); idMap.set(id, v); }
    return v;
  };
  const list = (k: Collection): RawRecord[] => (Array.isArray(legacy[k]) ? (legacy[k] as unknown[]).map(x => (isObj(x) ? x : {})) : []);
  const reSession = (x: RawRecord): RawRecord => ({ ...x, session_id: x.session_id ? remap(x.session_id) : null });
  const fallback = defaultMasterData(new Date().toISOString());
  const pick = <T,>(k: 'bankrolls' | 'games' | 'tournament_types'): T[] => {
    const l = list(k);
    return (l.length ? l : fallback[k]) as unknown as T[];
  };
  const currency = legacy.settings && typeof legacy.settings.currency === 'string' && legacy.settings.currency ? legacy.settings.currency : 'EUR';
  return {
    settings: { currency },
    bankrolls: pick<Bankroll>('bankrolls'),
    locations: list('locations') as unknown as NamedItem[],
    games: pick<NamedItem>('games'),
    tournament_types: pick<NamedItem>('tournament_types'),
    groups: list('groups') as unknown as NamedItem[],
    // Imports replace the document wholesale; unknown master keys from a
    // newer web build are dropped, as the web's replaceDoc does.
    extra_master: {},
    sessions: list('sessions').map(s => ({ ...s, id: remap(s.id) })) as unknown as Session[],
    stack_events: list('stack_events').map(reSession) as unknown as StackEvent[],
    sell_actions: list('sell_actions').map(reSession) as unknown as SellAction[],
    transactions: list('transactions').map(t => ({ ...t, id: isUuid(t.id) ? t.id : newId() })) as unknown as Transaction[],
    player_notes: list('player_notes').map(reSession) as unknown as JsonValue[],
    hand_histories: list('hand_histories').map(reSession) as unknown as JsonValue[],
  };
}

/**
 * Demo dataset (brief section 10) re-keyed to uuids. For a signed-in account
 * "Reset demo data" REPLACES the account's data with this seed (confirmed
 * first): the cloud has no separate demo layer.
 */
export function demoDoc(nowMs: number, newId: () => string): Doc {
  return legacyToDoc(buildSeed(nowMs), newId);
}
