// Per-tab session filters (brief section 9). Feed and Statistics each keep
// their own filter, persisted in the store document under `ui.filters`.
// Pure matching / summary logic lives here; the sheet UI is screens/filter.js.

import { getState, mutate } from './store.js';
import { fmtNum } from './format.js';

export const RANGES = [
  ['7d', 'Last 7d', 'Last 7 days'],
  ['30d', 'Last 30d', 'Last 30 days'],
  ['90d', 'Last 90d', 'Last 90 days'],
  ['year', 'This year', 'This year'],
  ['all', 'All time', 'All time'],
  ['custom', 'Custom', 'Custom'],
];

export function emptyFilter() {
  return {
    range: 'all', from: null, to: null, // from/to: local 'YYYY-MM-DD' (custom only)
    kind: 'both',                       // 'both' | 'cash' | 'tournament'
    game_ids: [], stakes: [], tournament_type_ids: [],
    location_ids: [], bankroll_ids: [], group_ids: [],
  };
}

export function getFilter(doc, tab) {
  const f = doc && doc.ui && doc.ui.filters && doc.ui.filters[tab];
  return { ...emptyFilter(), ...(f || {}) };
}

export function setFilter(tab, filter) {
  mutate(d => {
    d.ui = d.ui || {};
    d.ui.filters = d.ui.filters || {};
    d.ui.filters[tab] = { ...emptyFilter(), ...filter };
  });
}

export function clearFilter(tab) { setFilter(tab, emptyFilter()); }

export function isActive(f) {
  return f.range !== 'all' || f.kind !== 'both' ||
    ['game_ids', 'stakes', 'tournament_type_ids', 'location_ids', 'bankroll_ids', 'group_ids']
      .some(k => (f[k] || []).length > 0);
}

// "0.1/0.2" — the stakes key for a cash session (string, fmtNum-normalized).
export function stakesKey(s) {
  return fmtNum(s.small_blind) + '/' + fmtNum(s.big_blind);
}

// Distinct stakes present in cash sessions, ordered by big blind.
export function stakesOptions(doc) {
  const m = new Map();
  for (const s of doc.sessions) {
    if (s.kind !== 'cash' || !s.big_blind) continue;
    m.set(stakesKey(s), Number(s.big_blind));
  }
  return [...m.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k);
}

function localDate(str, endOfDay) {
  if (!str) return null;
  const [y, mo, d] = str.split('-').map(Number);
  if (![y, mo, d].every(Number.isFinite)) return null;
  return endOfDay ? new Date(y, mo - 1, d, 23, 59, 59, 999) : new Date(y, mo - 1, d, 0, 0, 0, 0);
}

// [fromMs, toMs] window for the date range, or null for no date bound.
export function rangeBounds(f, nowMs = Date.now()) {
  const day = 86400000;
  switch (f.range) {
    case '7d': return [nowMs - 7 * day, Infinity];
    case '30d': return [nowMs - 30 * day, Infinity];
    case '90d': return [nowMs - 90 * day, Infinity];
    case 'year': return [new Date(new Date(nowMs).getFullYear(), 0, 1).getTime(), Infinity];
    case 'custom': {
      const a = localDate(f.from, false), b = localDate(f.to, true);
      return [a ? a.getTime() : -Infinity, b ? b.getTime() : Infinity];
    }
    default: return null;
  }
}

// Kind-specific filters: stakes only apply to cash, tournament type only to
// tournaments. Picking stakes alone narrows to cash; picking a tournament
// type alone narrows to tournaments; picking both filters each kind by its own.
export function matches(f, s, nowMs = Date.now()) {
  const b = rangeBounds(f, nowMs);
  if (b) {
    const t = Date.parse(s.start_time);
    if (t < b[0] || t > b[1]) return false;
  }
  if (f.kind !== 'both' && s.kind !== f.kind) return false;
  const inList = (list, v) => !list || !list.length || list.includes(v);
  if (!inList(f.game_ids, s.game_id)) return false;
  if (!inList(f.location_ids, s.location_id)) return false;
  if (!inList(f.bankroll_ids, s.bankroll_id)) return false;
  if (!inList(f.group_ids, s.group_id)) return false;
  const hasStakes = f.stakes && f.stakes.length;
  const hasTT = f.tournament_type_ids && f.tournament_type_ids.length;
  if (s.kind === 'cash') {
    if (hasStakes && !f.stakes.includes(stakesKey(s))) return false;
    if (!hasStakes && hasTT) return false;
  } else {
    if (hasTT && !f.tournament_type_ids.includes(s.tournament_type_id)) return false;
    if (!hasTT && hasStakes) return false;
  }
  return true;
}

export function applyFilter(f, sessions, nowMs = Date.now()) {
  return sessions.filter(s => matches(f, s, nowMs));
}

function names(list, ids) {
  return ids.map(id => (list.find(x => x.id === id) || {}).name).filter(Boolean);
}

function compact(arr) {
  if (arr.length <= 2) return arr.join(', ');
  return arr.slice(0, 2).join(', ') + ' +' + (arr.length - 2);
}

function fmtDay(str) {
  const d = localDate(str, false);
  if (!d) return '…';
  return d.getDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
}

// "Last 30 days · Cash · UCD"
export function summary(doc, f) {
  const parts = [];
  if (f.range === 'custom') parts.push(fmtDay(f.from) + ' – ' + fmtDay(f.to));
  else if (f.range !== 'all') parts.push(RANGES.find(r => r[0] === f.range)[2]);
  if (f.kind === 'cash') parts.push('Cash');
  if (f.kind === 'tournament') parts.push('Tournament');
  const add = arr => { if (arr.length) parts.push(compact(arr)); };
  add(names(doc.games, f.game_ids || []));
  add(f.stakes || []);
  add(names(doc.tournament_types, f.tournament_type_ids || []));
  add(names(doc.locations, f.location_ids || []));
  add(names(doc.bankrolls, f.bankroll_ids || []));
  add(names(doc.groups, f.group_ids || []));
  return parts.join(' · ');
}

export function currentFilter(tab) { return getFilter(getState(), tab); }
