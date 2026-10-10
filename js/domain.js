// Domain mutations. Every write goes through store.mutate(), which persists
// and notifies subscribers. Pure entity lookup lives in stats.js.

import { mutate, genId } from './store.js';
import { endLiveCashIn, endLiveTournamentIn } from './session-math.js';

export function getLiveSession(doc) {
  return doc.sessions.find(s => s.is_live) || null;
}

export function getSession(doc, id) {
  return doc.sessions.find(s => s.id === id) || null;
}

function nowIso() { return new Date().toISOString(); }

// Base fields shared by every session (live or past, cash or tournament).
function baseSession(kind, fields, startIso) {
  return {
    id: fields.id,
    kind,
    game_id: fields.game_id,
    location_id: fields.location_id || null,
    bankroll_id: fields.bankroll_id,
    group_id: fields.group_id || null,
    table_size: fields.table_size,
    start_time: startIso,
    end_time: null,
    duration_seconds: null,
    break_seconds: 0,
    hands_count: null,
    hands_count_estimated: true,
    comment: null,
    opponents: null,
    is_live: true,
    tracked_via_stack: false,
    paused_at: null,
    created_at: startIso,
    updated_at: startIso,
  };
}

// Starting a live cash session creates the first buy_in stack event and
// sets tracked_via_stack = true — buy-in is then always derived from events.
export function startLiveCash({ game_id, location_id, bankroll_id, group_id, table_size, small_blind, big_blind, buy_in, start_time }) {
  const id = genId('sess');
  const t = start_time || nowIso();
  mutate(d => {
    const s = baseSession('cash', { id, game_id, location_id, bankroll_id, group_id, table_size }, t);
    s.tracked_via_stack = true;
    s.small_blind = small_blind;
    s.big_blind = big_blind;
    s.buy_in = null;      // derived from stack events
    s.cashed_out = null;  // recorded as cash_out stack events
    s.tips = 0;
    d.sessions.push(s);
    d.stack_events.push({ id: genId('stk'), session_id: id, kind: 'buy_in', amount: buy_in, occurred_at: t });
  });
  return id;
}

export function startLiveTournament({ game_id, location_id, bankroll_id, group_id, table_size, tournament_type_id, tournament_name, initial_buy_in, start_time }) {
  const id = genId('sess');
  const t = start_time || nowIso();
  mutate(d => {
    const s = baseSession('tournament', { id, game_id, location_id, bankroll_id, group_id, table_size }, t);
    s.tournament_type_id = tournament_type_id || null;
    s.tournament_name = tournament_name || null;
    s.initial_buy_in = initial_buy_in;
    s.total_buy_in = initial_buy_in;
    s.prize = null;
    s.position = null;
    s.entries = null;
    s.tips = 0;
    d.sessions.push(s);
  });
  return id;
}

// After-the-fact session (both kinds). Times already validated by the caller.
export function logPastSession(fields) {
  const id = genId('sess');
  mutate(d => {
    const startIso = fields.start_time.toISOString();
    const endIso = fields.end_time.toISOString();
    const s = baseSession(fields.kind, { ...fields, id }, startIso);
    s.is_live = false;
    s.end_time = endIso;
    s.duration_seconds = Math.max(0, Math.round((fields.end_time - fields.start_time) / 1000));
    if (fields.kind === 'cash') {
      s.tracked_via_stack = false;
      s.small_blind = fields.small_blind;
      s.big_blind = fields.big_blind;
      s.buy_in = fields.buy_in;
      s.cashed_out = fields.cashed_out || 0;
      s.tips = fields.tips || 0;
      s.hands_count = fields.hands_count ?? null;
      s.hands_count_estimated = false;
    } else {
      s.tournament_type_id = fields.tournament_type_id || null;
      s.tournament_name = fields.tournament_name || null;
      s.initial_buy_in = fields.initial_buy_in;
      s.total_buy_in = fields.total_buy_in || fields.initial_buy_in;
      s.prize = fields.prize || 0;
      s.position = fields.position ?? null;
      s.entries = fields.entries ?? null;
      s.tips = fields.tips || 0;
      s.hands_count = fields.hands_count ?? null;
      s.hands_count_estimated = false;
    }
    d.sessions.push(s);
  });
  return id;
}

// Ending folds an open pause into break_seconds (native rule) — see session-math.js.
export function endLiveCash(sessionId, cashedOut, nowMs = Date.now()) {
  mutate(d => { endLiveCashIn(d, sessionId, cashedOut, genId, nowMs); });
}

export function endLiveTournament(sessionId, result, nowMs = Date.now()) {
  mutate(d => { endLiveTournamentIn(d, sessionId, result, nowMs); });
}

export function updateSession(sessionId, patch) {
  mutate(d => {
    const s = d.sessions.find(x => x.id === sessionId);
    if (!s) return;
    Object.assign(s, patch, { updated_at: nowIso() });
  });
}

export function deleteSession(sessionId) {
  mutate(d => {
    d.sessions = d.sessions.filter(s => s.id !== sessionId);
    d.stack_events = d.stack_events.filter(e => e.session_id !== sessionId);
    d.sell_actions = d.sell_actions.filter(x => x.session_id !== sessionId);
  });
}

export function addStackEvent(sessionId, { kind, amount, occurred_at }) {
  mutate(d => {
    d.stack_events.push({ id: genId('stk'), session_id: sessionId, kind, amount, occurred_at });
  });
}

export function deleteStackEvent(eventId) {
  mutate(d => {
    d.stack_events = d.stack_events.filter(e => e.id !== eventId);
  });
}

export function addTournamentRebuy(sessionId, amount) {
  mutate(d => {
    const s = d.sessions.find(x => x.id === sessionId);
    if (!s) return;
    s.total_buy_in = Number(s.total_buy_in || 0) + Number(amount || 0);
    s.updated_at = nowIso();
  });
}

// Find-or-create a named entity. Must be called INSIDE a mutate() callback —
// used by forms that accept "add new" values committed at save time.
export function ensureByName(d, list, name, idPrefix) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  const found = list.find(x => x.name.toLowerCase() === trimmed.toLowerCase());
  if (found) return found.id;
  const item = { id: genId(idPrefix), name: trimmed };
  list.push(item);
  return item.id;
}

// ===========================================================================
// Tier 4 mutations: sell actions, bankrolls, transactions, master data,
// player notes, currency. Sell actions ride on their session row; the rest
// sync through bankroll_transactions and user_settings (see store.js).
// ===========================================================================

export function addSellAction(sessionId, action) {
  const id = genId('sell');
  mutate(d => {
    d.sell_actions.push({ ...action, id, session_id: sessionId });
    const s = d.sessions.find(x => x.id === sessionId);
    if (s) s.updated_at = nowIso();
  });
  return id;
}

// Attach the start form's pending sell actions in one write.
export function addSellActions(sessionId, actions) {
  mutate(d => {
    for (const a of actions) d.sell_actions.push({ ...a, id: a.id || genId('sell'), session_id: sessionId });
    const s = d.sessions.find(x => x.id === sessionId);
    if (s) s.updated_at = nowIso();
  });
}

export function deleteSellAction(actionId) {
  mutate(d => {
    const a = d.sell_actions.find(x => x.id === actionId);
    d.sell_actions = d.sell_actions.filter(x => x.id !== actionId);
    const s = a && d.sessions.find(x => x.id === a.session_id);
    if (s) s.updated_at = nowIso();
  });
}

export function addTransaction({ bankroll_id, kind, amount, description, occurred_at }) {
  const id = genId('txn');
  const now = nowIso();
  mutate(d => {
    d.transactions.push({ id, bankroll_id, kind, amount, description: description || null, occurred_at, created_at: now });
  });
  return id;
}

export function updateTransaction(txnId, patch) {
  mutate(d => {
    const t = d.transactions.find(x => x.id === txnId);
    if (t) Object.assign(t, patch);
  });
}

export function deleteTransaction(txnId) {
  mutate(d => { d.transactions = d.transactions.filter(x => x.id !== txnId); });
}

export function addBankroll(name, { makeDefault = false } = {}) {
  const id = genId('bk');
  mutate(d => {
    if (makeDefault) d.bankrolls.forEach(b => { b.is_default = false; });
    d.bankrolls.push({ id, name, is_default: makeDefault || d.bankrolls.length === 0, created_at: nowIso() });
  });
  return id;
}

export function setDefaultBankroll(bankrollId) {
  mutate(d => { d.bankrolls.forEach(b => { b.is_default = b.id === bankrollId; }); });
}

// Master data lists: 'bankrolls' | 'games' | 'locations' | 'tournament_types' | 'groups'.
export function renameMasterItem(listKey, id, name) {
  mutate(d => {
    const item = d[listKey].find(x => x.id === id);
    if (item) item.name = name;
  });
}

export function addMasterItem(listKey, name) {
  const id = genId(listKey);
  mutate(d => {
    const item = { id, name };
    if (listKey === 'bankrolls') { item.is_default = d.bankrolls.length === 0; item.created_at = nowIso(); }
    d[listKey].push(item);
  });
  return id;
}

// Callers check usage first (screens refuse to delete referenced items).
// Deleting the default bankroll hands the default to the first remaining one.
export function deleteMasterItem(listKey, id) {
  mutate(d => {
    const wasDefault = listKey === 'bankrolls' && (d.bankrolls.find(b => b.id === id) || {}).is_default;
    d[listKey] = d[listKey].filter(x => x.id !== id);
    if (wasDefault && d.bankrolls.length) d.bankrolls[0].is_default = true;
  });
}

export function setCurrency(code) {
  mutate(d => { d.settings = { ...(d.settings || {}), currency: code }; });
}

export function addPlayerNote({ player_name, note, session_id = null }) {
  const id = genId('note');
  mutate(d => {
    d.player_notes.push({ id, session_id, player_name, note, created_at: nowIso() });
  });
  return id;
}

export function updatePlayerNote(noteId, patch) {
  mutate(d => {
    const n = d.player_notes.find(x => x.id === noteId);
    if (n) Object.assign(n, patch, { updated_at: nowIso() });
  });
}

export function deletePlayerNote(noteId) {
  mutate(d => { d.player_notes = d.player_notes.filter(x => x.id !== noteId); });
}

// Renaming a player re-labels every note filed under that name. Matching is
// trimmed + case-insensitive, the same grouping the Players list uses.
export function renamePlayer(oldName, newName) {
  const key = String(oldName || '').trim().toLowerCase();
  const now = nowIso();
  mutate(d => {
    for (const n of d.player_notes) {
      if (String(n.player_name || '').trim().toLowerCase() === key) { n.player_name = newName; n.updated_at = now; }
    }
  });
}
