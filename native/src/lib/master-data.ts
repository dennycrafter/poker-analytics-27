// Settings master data (brief 5.16), ported 1:1 from the web app's
// js/manage.js (validation) and js/domain.js (add / rename / delete /
// setCurrency mutators). Pure: validators read a Doc, mutators edit a draft
// handed in by CloudStore.mutate().
import type { Doc } from './types';

export type MasterKey = 'games' | 'locations' | 'tournament_types' | 'groups' | 'bankrolls';
type SessionRef = 'game_id' | 'location_id' | 'tournament_type_id' | 'group_id' | 'bankroll_id';

export const MASTER_META: Record<MasterKey, { title: string; singular: string; ref: SessionRef }> = {
  games: { title: 'Games', singular: 'game', ref: 'game_id' },
  locations: { title: 'Locations', singular: 'location', ref: 'location_id' },
  tournament_types: { title: 'Tournament types', singular: 'tournament type', ref: 'tournament_type_id' },
  groups: { title: 'Groups', singular: 'group', ref: 'group_id' },
  bankrolls: { title: 'Bankrolls', singular: 'bankroll', ref: 'bankroll_id' },
};

/** The lists Settings manages directly (bankrolls live on the Bankroll screen). */
export const MANAGED: MasterKey[] = ['games', 'locations', 'tournament_types', 'groups'];

export function isManagedKey(v: unknown): v is MasterKey {
  return typeof v === 'string' && (MANAGED as string[]).includes(v);
}

export const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'JPY'];

type UsageDoc = Pick<Doc, 'sessions' | 'transactions'>;

/** How many records point at a master item. Bankrolls also own transactions. */
export function masterUsage(doc: UsageDoc, listKey: MasterKey, id: string): number {
  const ref = MASTER_META[listKey].ref;
  let n = doc.sessions.filter(s => s[ref] === id).length;
  if (listKey === 'bankrolls') n += doc.transactions.filter(t => t.bankroll_id === id).length;
  return n;
}

/** Error message or null. Names are unique per list (case-insensitive). */
export function masterNameError(doc: Pick<Doc, MasterKey>, listKey: MasterKey, name: string, exceptId: string | null = null): string | null {
  const v = String(name ?? '').trim();
  if (!v) return 'Enter a name';
  if (v.length > 60) return 'Keep the name under 60 characters';
  const clash = doc[listKey].some(x => x.id !== exceptId && String(x.name).trim().toLowerCase() === v.toLowerCase());
  return clash ? 'That name already exists' : null;
}

export function masterDeleteError(doc: UsageDoc & Pick<Doc, 'bankrolls'>, listKey: MasterKey, id: string): string | null {
  const used = masterUsage(doc, listKey, id);
  if (used) return `Used by ${used} ${used === 1 ? 'record' : 'records'} — reassign them first`;
  if (listKey === 'bankrolls' && doc.bankrolls.length <= 1) return 'Keep at least one bankroll';
  return null;
}

export function currencyError(code: string): string | null {
  const v = String(code ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(v) ? null : 'Use a 3-letter currency code (e.g. EUR)';
}

/** Current code first, then the presets (deduplicated), as in the web picker. */
export function currencyOptions(current: string): string[] {
  return [...new Set([current, ...CURRENCIES])];
}

// --- draft mutators (use inside store.mutate) -------------------------------------

export function addMasterItem(d: Doc, listKey: MasterKey, name: string, id: string, nowIso: string = new Date().toISOString()): void {
  if (listKey === 'bankrolls') d.bankrolls.push({ id, name, is_default: d.bankrolls.length === 0, created_at: nowIso });
  else d[listKey].push({ id, name });
}

export function renameMasterItem(d: Doc, listKey: MasterKey, id: string, name: string): void {
  // Replace the item object: CloudStore.mutate copies lists shallowly.
  d[listKey] = d[listKey].map(x => (x.id === id ? { ...x, name } : x));
}

/** Callers check masterDeleteError first (screens refuse to delete referenced items). */
export function deleteMasterItem(d: Doc, listKey: MasterKey, id: string): void {
  if (listKey === 'bankrolls') {
    const wasDefault = !!d.bankrolls.find(b => b.id === id)?.is_default;
    d.bankrolls = d.bankrolls.filter(x => x.id !== id);
    if (wasDefault && d.bankrolls.length) d.bankrolls[0] = { ...d.bankrolls[0], is_default: true };
    return;
  }
  d[listKey] = d[listKey].filter(x => x.id !== id);
}

export function setCurrency(d: Doc, code: string): void {
  d.settings = { ...d.settings, currency: code };
}
