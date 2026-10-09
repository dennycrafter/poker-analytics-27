// Master data + players helpers for Settings and Players (brief 5.14, 5.16).
// Pure: no DOM, no store writes.

export const MASTER_META = {
  games: { title: 'Games', singular: 'game', ref: 'game_id' },
  locations: { title: 'Locations', singular: 'location', ref: 'location_id' },
  tournament_types: { title: 'Tournament types', singular: 'tournament type', ref: 'tournament_type_id' },
  groups: { title: 'Groups', singular: 'group', ref: 'group_id' },
  bankrolls: { title: 'Bankrolls', singular: 'bankroll', ref: 'bankroll_id' },
};

export const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'JPY'];

// How many records point at a master item. Bankrolls also own transactions.
export function masterUsage(doc, listKey, id) {
  const meta = MASTER_META[listKey];
  if (!meta) return 0;
  let n = doc.sessions.filter(s => s[meta.ref] === id).length;
  if (listKey === 'bankrolls') n += (doc.transactions || []).filter(t => t.bankroll_id === id).length;
  return n;
}

// Returns an error message or null. Names are unique per list (case-insensitive).
export function masterNameError(doc, listKey, name, exceptId = null) {
  const v = String(name ?? '').trim();
  if (!v) return 'Enter a name';
  if (v.length > 60) return 'Keep the name under 60 characters';
  const clash = (doc[listKey] || []).some(x => x.id !== exceptId && String(x.name).trim().toLowerCase() === v.toLowerCase());
  return clash ? 'That name already exists' : null;
}

export function masterDeleteError(doc, listKey, id) {
  const used = masterUsage(doc, listKey, id);
  if (used) return `Used by ${used} ${used === 1 ? 'record' : 'records'} — reassign them first`;
  if (listKey === 'bankrolls' && doc.bankrolls.length <= 1) return 'Keep at least one bankroll';
  return null;
}

export function currencyError(code) {
  const v = String(code ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(v) ? null : 'Use a 3-letter currency code (e.g. EUR)';
}

// Players are derived from player notes (grouped by trimmed, case-insensitive
// name). Sorted by most recent note first, then name.
export function playersFromNotes(notes) {
  const map = new Map();
  for (const n of notes || []) {
    const name = String(n.player_name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!map.has(key)) map.set(key, { name, notes: [], last: 0 });
    const p = map.get(key);
    p.notes.push(n);
    const t = Date.parse(n.updated_at || n.created_at) || 0;
    if (t > p.last) p.last = t;
  }
  const out = [...map.values()];
  for (const p of out) p.notes.sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0));
  return out.sort((a, b) => b.last - a.last || a.name.localeCompare(b.name));
}

export function notesForPlayer(notes, name) {
  const key = String(name || '').trim().toLowerCase();
  return playersFromNotes(notes).find(p => p.name.toLowerCase() === key) || null;
}

export function playerNoteError(name, note) {
  if (!String(name ?? '').trim()) return 'Enter the player name';
  if (!String(note ?? '').trim()) return 'Write a note';
  return null;
}
