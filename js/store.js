// In-memory document + pub/sub, backed by Supabase (cloud is the source of truth).
//
// Screens keep reading synchronously via getState() and writing via mutate()
// exactly as in the localStorage era. Persistence is a snapshot diff: after
// every mutation each cloud entity (one session row, one transaction row, the
// settings row) is fingerprinted and compared with the last fingerprint the
// server confirmed. Anything that differs is upserted/deleted in the
// background (optimistic UI). Realtime postgres_changes events flow the other
// way and are merged with the same fingerprints, so a device's own echoes are
// no-ops and unsaved local edits are never clobbered by a stale event.
//
// Per-device UI state (doc.ui: filters, staking toggle) never leaves the device.

import { supabase } from './supabase-client.js';
import { idbSet, idbGet, idbDel } from './idb.js';
import {
  stableStringify, sessionToRow, rowToSessionParts, transactionToRow, rowToTransaction,
  settingsToRow, applySettingsRow, defaultSettings,
} from './cloud-map.js';
import { sessionDbError } from './backup.js';
import { sessionFingerprint, draftNetResult } from './csv-import.js';
import { netResult } from './stats.js';

// Sync & conflict policy (STEP D), also logged in README.md "Offline and sync":
//  - The cloud is the source of truth; screens read a synchronous in-memory
//    document and write optimistically.
//  - Merge is last-write-wins per entity row (per-field merge is not
//    attempted). An unsaved local edit survives stale remote echoes until it
//    is confirmed; after that the newest confirmed write wins.
//  - Offline: mutations keep applying locally (localStorage + IndexedDB
//    mirror). They flush on reconnect — immediately on the window `online`
//    event, otherwise on a backoff timer. Live sessions tick from row data, so
//    they run offline and land in the cloud when the connection returns.
//  - Replaces (import / demo reset) flush atomically: every upsert is
//    confirmed before any delete runs, and a rejected write rolls the
//    document back to the pre-replace snapshot (ISSUES.md #1/#3).

const UI_KEY = 'pa27:ui';
const cacheKey = uid => `pa27:cache:${uid}`;
const PAGE = 1000;

let doc = blank();
const listeners = new Set();

// --- sync state (per signed-in user) ---------------------------------------
let userId = null;
let channel = null;
let ready = false;              // first cloud pull finished; flushes wait for it
let serverFp = new Map();       // key -> fingerprint last confirmed by the server
const inFlight = new Set();     // keys with a write on the wire
let flushQueued = false;
let flushing = false;
let retryTimer = null;
let retryDelay = 2000;
let subscribedOnce = false;
let rejectedWrites = 0;         // bumps on every server-rejected (discarded) write
let status = { state: 'idle', error: null };
const statusListeners = new Set();
// Pre-replace document (data only, no ui). Set by replaceDoc; cleared when the
// replace has fully landed or has been rolled back. Non-null while a replace
// flush is still in flight, so a rejected write can restore the old account.
let replaceSnapshot = null;
// Offline-at-load sign-in retry: the pending first reconcile (see bootstrap).
let bootCtx = null;
let bootTimer = null;
let bootDelay = 2000;

function blank() {
  return {
    version: 1,
    settings: { currency: 'EUR' },
    bankrolls: [], locations: [], games: [], tournament_types: [], groups: [],
    sessions: [], stack_events: [], sell_actions: [], transactions: [],
    player_notes: [], hand_histories: [],
    import_keys: {},   // PokerNow import_key -> session id (per-user cache)
    ui: loadUi(),
  };
}

function loadUi() {
  try { return JSON.parse(localStorage.getItem(UI_KEY) || '{}') || {}; } catch (e) {
    console.error('store: unreadable ui state, resetting', e);
    return {};
  }
}

function saveLocal() {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify(doc.ui || {}));
    if (userId) {
      const { ui, ...data } = doc;
      const payload = JSON.stringify({ doc: data, serverFp: [...serverFp] });
      localStorage.setItem(cacheKey(userId), payload);
      // Durable mirror of the offline queue (js/idb.js): survives localStorage
      // eviction and is read back when the primary copy is gone. Fire-and-
      // forget — it must never slow a mutation down.
      idbSet(cacheKey(userId), payload);
    }
  } catch (e) {
    console.error('store: failed to write local cache', e);
  }
}

// --- public API (unchanged for screens) -------------------------------------

export function getState() { return doc; }

// fn(doc, { source: 'local' | 'remote' })
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(source) {
  for (const fn of [...listeners]) {
    try { fn(doc, { source }); } catch (e) { console.error('subscriber failed', e); }
  }
}

export function mutate(fn) {
  fn(doc);
  doc.updated_at = new Date().toISOString();
  saveLocal();
  notify('local');
  scheduleFlush();
}

// Replace every cloud-backed collection (import / demo reset); diffs sync the rest.
export function replaceDoc(next) {
  // Remember the pre-replace account so flush can roll back if the cloud
  // rejects the replace (ISSUES.md #1/#3): a broken import must cost the user
  // nothing, not wipe their existing sessions.
  const { ui: _ui, ...snapshot } = doc;
  replaceSnapshot = snapshot;
  doc = { ...blank(), ...next, version: 1, ui: doc.ui };
  saveLocal();
  notify('local');
  scheduleFlush();
}

// Every id doubles as a Postgres uuid primary key. The prefix is kept in the
// signature for call-site readability only.
export function genId(_prefix) {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function getSyncStatus() { return status; }
export function onSyncStatus(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn); }

function setStatus(state, error = null) {
  status = { state, error };
  for (const fn of [...statusListeners]) {
    try { fn(status); } catch (e) { console.error('sync status listener failed', e); }
  }
}

// --- fingerprints ----------------------------------------------------------------

const TABLE = { s: 'sessions', t: 'bankroll_transactions', settings: 'user_settings' };

function groupBySession(list) {
  const m = new Map();
  for (const x of list) {
    if (!m.has(x.session_id)) m.set(x.session_id, []);
    m.get(x.session_id).push(x);
  }
  return m;
}

// key -> { table, row, fp } for everything the cloud should hold right now.
function localEntries(d) {
  const out = new Map();
  const evs = groupBySession(d.stack_events);
  const sells = groupBySession(d.sell_actions);
  for (const s of d.sessions) {
    const row = sessionToRow({ stack_events: evs.get(s.id) || [], sell_actions: sells.get(s.id) || [] }, s, userId);
    out.set('s:' + s.id, { table: 's', row, fp: stableStringify(row) });
  }
  for (const t of d.transactions) {
    const row = transactionToRow(t, userId);
    out.set('t:' + t.id, { table: 't', row, fp: stableStringify(row) });
  }
  const srow = settingsToRow(d, userId);
  out.set('settings', { table: 'settings', row: srow, fp: stableStringify(srow) });
  return out;
}

function localFpOf(key) {
  const [table, id] = key === 'settings' ? ['settings', null] : [key.slice(0, 1), key.slice(2)];
  if (table === 'settings') return stableStringify(settingsToRow(doc, userId));
  if (table === 's') {
    const s = doc.sessions.find(x => x.id === id);
    return s ? stableStringify(sessionToRow(doc, s, userId)) : undefined;
  }
  const t = doc.transactions.find(x => x.id === id);
  return t ? stableStringify(transactionToRow(t, userId)) : undefined;
}

// Server row -> { key, fp, apply(d) } in the same canonical form as localEntries.
function fromServer(table, row) {
  if (table === 'sessions') {
    const parts = rowToSessionParts(row);
    const fp = stableStringify(sessionToRow(parts, parts.session, userId));
    return { key: 's:' + row.id, fp, parts };
  }
  if (table === 'bankroll_transactions') {
    const t = rowToTransaction(row);
    return { key: 't:' + row.id, fp: stableStringify(transactionToRow(t, userId)), txn: t };
  }
  const tmp = blank();
  applySettingsRow(tmp, row);
  return { key: 'settings', fp: stableStringify(settingsToRow(tmp, userId)), settings: tmp };
}

function keyOf(table, id) {
  if (table === 'sessions') return 's:' + id;
  if (table === 'bankroll_transactions') return 't:' + id;
  return 'settings';
}

// Replace (or remove, when incoming is null) one entity in the document.
function applyEntity(key, incoming) {
  if (key === 'settings') {
    if (incoming) {
      for (const k of ['bankrolls', 'locations', 'games', 'tournament_types', 'groups', 'player_notes', 'hand_histories', 'settings']) {
        doc[k] = incoming.settings[k];
      }
    }
    return;
  }
  const id = key.slice(2);
  if (key.startsWith('t:')) {
    const i = doc.transactions.findIndex(x => x.id === id);
    if (!incoming) { if (i >= 0) doc.transactions.splice(i, 1); return; }
    if (i >= 0) doc.transactions[i] = incoming.txn; else doc.transactions.push(incoming.txn);
    return;
  }
  const i = doc.sessions.findIndex(x => x.id === id);
  doc.stack_events = doc.stack_events.filter(e => e.session_id !== id);
  doc.sell_actions = doc.sell_actions.filter(a => a.session_id !== id);
  if (!incoming) { if (i >= 0) doc.sessions.splice(i, 1); return; }
  if (i >= 0) doc.sessions[i] = incoming.parts.session; else doc.sessions.push(incoming.parts.session);
  doc.stack_events.push(...incoming.parts.stack_events);
  doc.sell_actions.push(...incoming.parts.sell_actions);
}

function isDirty(key) {
  return inFlight.has(key) || localFpOf(key) !== serverFp.get(key);
}

// --- pull ----------------------------------------------------------------------

async function fetchAll(table) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(table).select('*')
      .eq('user_id', userId).order(table === 'user_settings' ? 'user_id' : 'id').range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
}

// Full reconcile with the server. Local entities that are dirty (unsaved edits)
// survive unless listed in `discard` (writes the server rejected) or the
// device has no trustworthy local state yet (`preferServer`: first sign-in on
// this device, where the blank document is not an edit).
async function pull({ discard = new Set(), preferServer = false } = {}) {
  const uid = userId;
  const [sessions, txns, settings] = await Promise.all(
    ['sessions', 'bankroll_transactions', 'user_settings'].map(fetchAll));
  if (uid !== userId) return; // signed out / switched user mid-flight

  const incoming = new Map();
  for (const r of sessions) { const x = fromServer('sessions', r); incoming.set(x.key, x); }
  for (const r of txns) { const x = fromServer('bankroll_transactions', r); incoming.set(x.key, x); }
  let settingsFound = false;
  for (const r of settings) { const x = fromServer('user_settings', r); incoming.set(x.key, x); settingsFound = true; }

  const keys = new Set([...incoming.keys(), ...serverFp.keys(), ...localEntries(doc).keys()]);
  let changed = 0;
  for (const key of keys) {
    const keepLocal = !preferServer && !discard.has(key) && isDirty(key);
    if (keepLocal) continue;
    const next = incoming.get(key) || null;
    if ((next ? next.fp : undefined) === localFpOf(key)) continue;
    if (key === 'settings' && !next) continue; // no row yet: keep local defaults
    applyEntity(key, next);
    changed++;
  }
  serverFp = new Map([...incoming].map(([k, v]) => [k, v.fp]));
  return { changed, settingsFound, sessionCount: sessions.length, txnCount: txns.length };
}

// --- flush ---------------------------------------------------------------------

function scheduleFlush() {
  if (!userId || !ready || flushQueued) return;
  flushQueued = true;
  queueMicrotask(() => { flushQueued = false; flush(); });
}

function isTransient(error) {
  if (!error) return false;
  const msg = String(error.message || '');
  return error.status === 401 || error.status >= 500 || /fetch|network|timeout/i.test(msg) || (!error.code && !error.status);
}

async function flush() {
  if (flushing || !userId || !ready) return;
  flushing = true;
  try {
    for (;;) {
      const local = localEntries(doc);
      const ups = { s: [], t: [], settings: [] };
      const dels = { s: [], t: [] };
      for (const [key, e] of local) {
        if (!inFlight.has(key) && serverFp.get(key) !== e.fp) ups[e.table].push([key, e]);
      }
      for (const key of serverFp.keys()) {
        if (!local.has(key) && !inFlight.has(key) && key !== 'settings') dels[key.slice(0, 1)].push(key);
      }
      if (!ups.s.length && !ups.t.length && !ups.settings.length && !dels.s.length && !dels.t.length) {
        replaceSnapshot = null;
        setStatus('saved');
        return;
      }
      setStatus('saving');
      // Atomic replace-flush (ISSUES.md #1/#3): upserts are confirmed BEFORE
      // any delete is issued. Parallel calls could delete the old rows and
      // then fail to write the new ones, wiping the account on partial failure.
      // Transient failures (offline / 5xx) just reschedule; permanent
      // rejections roll back via flushFailed.
      const upsFailed = [];
      for (const t of ['s', 't', 'settings']) {
        if (!ups[t].length) continue;
        const r = await writeUpserts(t, ups[t]);
        if (!r) continue;
        if (isTransient(r.error)) { setStatus('offline', r.error); scheduleRetry(); return; }
        upsFailed.push(r);
        break; // fail fast: stop before any delete
      }
      if (upsFailed.length) { if (await flushFailed(upsFailed)) continue; return; }

      const delFailed = [];
      for (const t of ['s', 't']) {
        if (!dels[t].length) continue;
        const r = await writeDeletes(t, dels[t]);
        if (!r) continue;
        if (isTransient(r.error)) { setStatus('offline', r.error); scheduleRetry(); return; }
        delFailed.push(r);
        break;
      }
      if (delFailed.length) { if (await flushFailed(delFailed)) continue; return; }

      retryDelay = 2000;
      saveLocal();
    }
  } catch (e) {
    console.error('sync: flush failed', e);
    setStatus('offline', e);
    scheduleRetry();
  } finally {
    flushing = false;
  }
}

// A cloud write was rejected (non-transient). If this flush was carrying a
// replace (import / demo reset), restore the pre-replace document: the user
// keeps their old data, and the flush loop recomputes from the restored doc —
// re-pushing the old rows and deleting any half-landed import rows. Otherwise
// discard just the rejected keys and re-pull their server state.
// Returns true when the flush loop should continue with recomputed work.
async function flushFailed(results) {
  const failed = results[0].error;
  console.error('sync: server rejected a write', failed);
  rejectedWrites++;
  setStatus('error', failed);
  const discard = new Set(results.flatMap(r => r.keys));
  if (replaceSnapshot) {
    doc = { ...blank(), ...replaceSnapshot, ui: doc.ui };
    replaceSnapshot = null;
    saveLocal();
    notify('remote'); // screens re-render with the restored data
    return true;      // loop recomputes: no re-entrant scheduleFlush from inside a flush
  }
  const res = await pull({ discard });
  saveLocal();
  if (res && res.changed) notify('remote');
  return false;
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => { retryTimer = null; flush(); }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 30000);
}

async function writeUpserts(table, entries) {
  const keys = entries.map(([k]) => k);
  keys.forEach(k => inFlight.add(k));
  try {
    const q = supabase.from(TABLE[table]);
    const rows = entries.map(([, e]) => e.row);
    const { error, status: httpStatus } = table === 'settings'
      ? await q.upsert(rows[0], { onConflict: 'user_id' })
      : await q.upsert(rows, { onConflict: 'id' });
    if (error) return { error: { ...error, status: httpStatus }, keys };
    entries.forEach(([k, e]) => { serverFp.set(k, e.fp); rememberWrite(k, e.fp); });
    return null;
  } finally {
    keys.forEach(k => inFlight.delete(k));
  }
}

async function writeDeletes(table, keys) {
  keys.forEach(k => inFlight.add(k));
  try {
    const ids = keys.map(k => k.slice(2));
    const { error, status: httpStatus } = await supabase.from(TABLE[table]).delete().in('id', ids);
    if (error) return { error: { ...error, status: httpStatus }, keys };
    keys.forEach(k => serverFp.delete(k));
    return null;
  } finally {
    keys.forEach(k => inFlight.delete(k));
  }
}

// --- realtime ------------------------------------------------------------------

// Echoes of this device's own writes can arrive after a newer write has
// already been confirmed (rapid edits: pause, then resume). Applying such a
// stale echo would flicker the UI back a step, so recent own fingerprints are
// remembered briefly and ignored unless they are the current server state.
const ECHO_WINDOW_MS = 15000;
const recentWrites = new Map(); // key -> Map<fp, writtenAtMs>

function rememberWrite(key, fp) {
  const now = Date.now();
  let m = recentWrites.get(key);
  if (!m) { m = new Map(); recentWrites.set(key, m); }
  m.set(fp, now);
  for (const [f, t] of m) if (now - t > ECHO_WINDOW_MS) m.delete(f);
}

function isStaleOwnEcho(key, fp) {
  const m = recentWrites.get(key);
  const t = m && m.get(fp);
  return t !== undefined && Date.now() - t <= ECHO_WINDOW_MS && serverFp.get(key) !== fp;
}

function onRealtime(payload) {
  const table = payload.table;
  const row = payload.eventType === 'DELETE' ? payload.old : payload.new;
  if (!row) return;
  if (table !== 'user_settings' && !row.id) return;
  if (row.user_id && row.user_id !== userId) return;
  // DELETE events cannot be filtered server-side and carry only the primary
  // key, so ignore ids this account has never seen (another user's rows).
  if (payload.eventType === 'DELETE' && table === 'user_settings') return;
  const key = keyOf(table, row.id);
  if (payload.eventType === 'DELETE' && !serverFp.has(key) && !localFpOf(key)) return;

  const incoming = payload.eventType === 'DELETE' ? null : fromServer(table, row);
  if (incoming && isStaleOwnEcho(key, incoming.fp)) return;
  const dirty = isDirty(key);
  if (incoming) serverFp.set(key, incoming.fp); else serverFp.delete(key);
  if (dirty) { scheduleFlush(); return; }
  if ((incoming ? incoming.fp : undefined) === localFpOf(key)) return; // own echo
  applyEntity(key, incoming);
  saveLocal();
  notify('remote');
}

function subscribeRealtime(uid) {
  const filter = `user_id=eq.${uid}`;
  let ch = supabase.channel(`pa27:${uid}`);
  for (const table of ['sessions', 'bankroll_transactions', 'user_settings']) {
    ch = ch
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table, filter }, onRealtime)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table, filter }, onRealtime);
  }
  for (const table of ['sessions', 'bankroll_transactions']) {
    ch = ch.on('postgres_changes', { event: 'DELETE', schema: 'public', table }, onRealtime);
  }
  return ch.subscribe((state, err) => {
    if (state === 'SUBSCRIBED') {
      // After a reconnect, catch up on anything missed while disconnected.
      if (subscribedOnce && ready) refresh('catch-up after reconnect');
      subscribedOnce = true;
    } else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT') {
      console.error('sync: realtime channel', state, err);
      setStatus('offline', err || new Error(state));
    }
  });
}

// Background reconcile; re-renders only when the server state differed.
function refresh(reason) {
  if (!userId || !ready) return;
  pull()
    .then(res => {
      saveLocal();
      if (res && res.changed) notify('remote');
      scheduleFlush();
    })
    .catch(e => console.error(`sync: ${reason} failed`, e));
}

function onVisible() {
  if (document.visibilityState === 'visible') refresh('refresh on focus');
}

// --- lifecycle -----------------------------------------------------------------

// Reconnect: flush the offline queue as soon as the network (or, at load, the
// first reconcile) can run — do not wait out the backoff timer.
function onOnline() {
  if (bootCtx) { clearTimeout(bootTimer); bootTimer = null; bootstrap(bootCtx); }
  else if (userId && ready) { retryDelay = 2000; flush(); }
}

// `online` is a browser-only event; some non-browser harnesses alias window to
// globalThis without EventTarget methods, so guard the wiring.
const canListenOnline = typeof window !== 'undefined'
  && typeof window.addEventListener === 'function'
  && typeof window.removeEventListener === 'function';

// Sign-in: hydrate from the device cache (instant paint), subscribe, then pull.
// Returns { cloudEmpty } so the shell can offer the legacy-data migration.
// Being offline at load is not an error: the cached document (localStorage,
// else the IndexedDB mirror) paints immediately, keeps accepting writes, and
// re-syncs when the connection returns.
export async function startSync(uid) {
  if (userId === uid) return { cloudEmpty: false };
  stopSync();
  userId = uid;
  ready = false;
  subscribedOnce = false;
  let hadCache = false;
  try {
    let cached = null;
    try {
      cached = JSON.parse(localStorage.getItem(cacheKey(uid)) || 'null');
    } catch (e) {
      console.error('store: unreadable cache, ignoring', e);
    }
    if (!(cached && cached.doc)) {
      // localStorage was evicted/cleared: fall back to the IndexedDB mirror
      // (js/idb.js) so an offline queue written earlier is not lost.
      const mirrored = await idbGet(cacheKey(uid));
      if (mirrored) {
        try { cached = JSON.parse(mirrored); } catch (e) { console.error('store: unreadable mirrored cache', e); }
      }
    }
    if (cached && cached.doc) {
      doc = { ...blank(), ...cached.doc };
      serverFp = new Map(cached.serverFp || []);
      hadCache = true;
      notify('remote'); // instant paint from cache while the pull runs
    }
  } catch (e) {
    console.error('store: cache restore failed, ignoring', e);
  }
  channel = subscribeRealtime(uid);
  document.addEventListener('visibilitychange', onVisible);
  if (canListenOnline) window.addEventListener('online', onOnline);
  setStatus('saving');

  // First full reconcile. If the device is offline at load this fails, leaves
  // the cache painted (usable offline) and retries on a backoff timer.
  const boot = { uid, hadCache, cloudEmpty: false };
  bootCtx = boot;
  bootDelay = 2000;
  await bootstrap(boot);
  return { cloudEmpty: boot.cloudEmpty };
}

// Runs the first full reconcile of a sign-in; sets `ready` on success. On
// failure it schedules itself for retry while `bootCtx` stays set so
// `onOnline` can trigger it immediately.
async function bootstrap(boot) {
  try {
    const res = await pull({ preferServer: !boot.hadCache });
    if (!res || boot.uid !== userId) { bootCtx = null; return; }
    if (!res.settingsFound && !serverFp.has('settings')) {
      // Brand-new account: default master data (no demo sessions).
      const defaults = defaultSettings(new Date().toISOString());
      for (const [k, v] of Object.entries(defaults)) doc[k] = v;
    }
    ready = true;
    bootCtx = null;
    bootDelay = 2000;
    boot.cloudEmpty = res.sessionCount === 0 && res.txnCount === 0;
    saveLocal();
    notify('remote');
    scheduleFlush();
  } catch (e) {
    console.error('sync: offline at sign-in, will retry', e);
    setStatus('offline', e);
    bootDelay = Math.min(bootDelay * 2, 30000);
    clearTimeout(bootTimer);
    bootTimer = setTimeout(() => {
      bootTimer = null;
      if (bootCtx && bootCtx.uid === userId) bootstrap(bootCtx);
    }, bootDelay);
  }
}

export function stopSync() {
  if (channel) { supabase.removeChannel(channel); channel = null; }
  document.removeEventListener('visibilitychange', onVisible);
  if (canListenOnline) window.removeEventListener('online', onOnline);
  clearTimeout(retryTimer);
  clearTimeout(bootTimer);
  bootTimer = null;
  bootCtx = null;
  replaceSnapshot = null;
  userId = null;
  ready = false;
  serverFp = new Map();
  inFlight.clear();
  recentWrites.clear();
  doc = blank();
  setStatus('idle');
}

export function clearUserCache(uid) {
  try { localStorage.removeItem(cacheKey(uid)); } catch (e) { console.error('store: cache clear failed', e); }
  idbDel(cacheKey(uid)); // the mirror must not outlive a sign-out either
}

// Wait until every local change has reached the server (used before sign-out
// and after the migration bulk insert). Returns false on timeout, and also when
// the server rejected a write meanwhile: the rejected change was rolled back to
// server state, so "nothing pending" would otherwise read as success.
export async function whenSaved(timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  const rejectedAtStart = rejectedWrites;
  for (;;) {
    if (rejectedWrites !== rejectedAtStart) return false;
    const pending = [...localEntries(doc)].some(([k, e]) => serverFp.get(k) !== e.fp) ||
      [...serverFp.keys()].some(k => k !== 'settings' && !localFpOf(k)) || inFlight.size > 0;
    if (!pending) return true;
    if (Date.now() > until) return false;
    scheduleFlush();
    await new Promise(r => setTimeout(r, 150));
  }
}


// --- import (STEP E) ---------------------------------------------------------

// Additive import path for the CSV and PokerNow importers (js/csv-import.js,
// js/pokernow-import.js). Resolves ref names to ids, assigns ids/timestamps
// and lands the whole batch in ONE mutate -> one flush -> one upsert batch per
// table. Rejections are per-row and honest: a rejected draft is skipped with a
// reason, valid rows in the same batch still import, and nothing is
// half-written (a draft is fully built before the document changes).
//
// Drafts come in two shapes, discriminated by `source`:
//   - CSV drafts { session, refs, net_result, fingerprint, line } — the app
//     contract is enforced here: is_live=false, tracked_via_stack=false,
//     paused_at=null (imported cash money lives in the buy_in column).
//   - PokerNow drafts { session, stack_events, source{import_key}, line } —
//     is_live/tracked_via_stack come from the parser; stack events are given
//     ids and written for live sessions.
//
// Dedupe layers:
//   - fingerprint (kind, start minute, duration, net) against the existing
//     document and within the batch — the same identity the preview uses,
//   - source.import_key (PokerNow): stored on doc.import_keys { key -> id }.
//     Device-local on purpose — it rides the per-user offline cache, not a
//     cloud column, so re-importing the same file on another device dedupes
//     by fingerprint instead. Registry entries pointing at deleted sessions
//     are pruned here, making a deliberate delete-then-re-import work.
//   - the one-live-session rule: live drafts are refused while any other
//     session is live (the importer only warns; the store enforces).
//
// Rows the database would refuse are rejected with the same guard the JSON
// import uses (sessionDbError), so an import can never produce a row the
// flush would get rejected.
export function importSessions(drafts, { bankrollId } = {}) {
  const imported = [];
  const skipped = [];
  mutate(d => {
    d.import_keys = d.import_keys || {};
    // Prune registry entries whose session is gone (deleted after an import).
    const sessionIds = new Set(d.sessions.map(s => s.id));
    for (const key of Object.keys(d.import_keys)) {
      if (!sessionIds.has(d.import_keys[key])) delete d.import_keys[key];
    }
    const now = new Date().toISOString();
    let live = d.sessions.find(s => s.is_live) || null;
    const known = new Set(d.sessions.map(s => sessionFingerprint(s, netResult(d, s))));

    // Find-or-create a master-data item by name (case-insensitive). The first
    // bankroll ever created becomes the default.
    const master = (list, name) => {
      const clean = String(name ?? '').replace(/\s+/g, ' ').trim();
      if (!clean) return null;
      const found = d[list].find(x => (x.name || '').toLowerCase() === clean.toLowerCase());
      if (found) return found;
      const item = { id: genId(), name: clean, created_at: now, updated_at: now };
      if (list === 'bankrolls' && !d[list].length) item.is_default = true;
      d[list].push(item);
      return item;
    };
    // Bankroll for a row: the per-row Bankroll column wins, then the screen's
    // choice, then the account default — and a brand-new account gets a
    // default bankroll rather than a dangling id.
    const resolveBankroll = (name) => {
      const byName = master('bankrolls', name);
      if (byName) return byName.id;
      if (bankrollId && d.bankrolls.some(b => b.id === bankrollId)) return bankrollId;
      const def = d.bankrolls.find(b => b.is_default) || d.bankrolls[0];
      if (def) return def.id;
      const bk = { id: genId(), name: 'Live', is_default: true, created_at: now, updated_at: now };
      d.bankrolls.push(bk);
      return bk.id;
    };

    for (const draft of Array.isArray(drafts) ? drafts : []) {
      const line = draft && draft.line;
      const skip = reason => skipped.push({ line, reason });
      const session = draft && draft.session;
      if (!session || typeof session !== 'object' || !session.kind
          || !session.start_time || !Number.isFinite(Date.parse(session.start_time))) {
        skip('Row is not a readable session'); continue;
      }
      const dbError = sessionDbError(session);
      if (dbError) { skip(dbError); continue; }

      const isPokerNow = Boolean(draft.source);
      if (!isPokerNow) {
        // E1 contract: generic CSV imports are always ended direct-money rows.
        session.is_live = false;
        session.tracked_via_stack = false;
        session.paused_at = null;
      }
      const importKey = isPokerNow && draft.source.import_key ? String(draft.source.import_key) : null;
      if (importKey && d.import_keys[importKey]) { skip('Already imported from this file'); continue; }
      if (session.is_live && live) {
        skip(`Another session is already live${live.start_time ? ` (started ${live.start_time.slice(0, 16).replace('T', ' ')})` : ''} — end it before importing this one`);
        continue;
      }

      const net = Number.isFinite(draft.net_result) ? draft.net_result
        : Number.isFinite(draftNetResult(session)) ? draftNetResult(session) : 0;
      const fingerprint = draft.fingerprint || sessionFingerprint(session, net);
      if (known.has(fingerprint)) { skip('Matches a session you already have'); continue; }
      known.add(fingerprint);

      const id = genId();
      const refs = { ...(draft.refs || {}) };
      if (isPokerNow) {
        // PokerNow drafts carry display names on the session (game_name /
        // location_name); resolve them to ids and strip them — cloud rows
        // keep only the *_id columns.
        refs.game = refs.game || session.game_name || null;
        refs.location = refs.location || session.location_name || null;
      }
      const row = {
        ...session,
        id,
        game_id: refs.game ? master('games', refs.game)?.id ?? null : null,
        location_id: refs.location ? master('locations', refs.location)?.id ?? null : null,
        bankroll_id: resolveBankroll(refs.bankroll),
        group_id: refs.group ? master('groups', refs.group)?.id ?? null : null,
        tournament_type_id: refs.tournament_type ? master('tournament_types', refs.tournament_type)?.id ?? null : null,
        created_at: now,
        updated_at: now,
      };
      if (isPokerNow) { delete row.game_name; delete row.location_name; }
      d.sessions.push(row);
      for (const e of Array.isArray(draft.stack_events) ? draft.stack_events : []) {
        if (!e || !['buy_in', 'top_up', 'cash_out'].includes(e.kind)) continue;
        d.stack_events.push({ ...e, id: genId(), session_id: id });
      }
      if (importKey) d.import_keys[importKey] = id;
      if (session.is_live) live = row;
      imported.push({ id, line });
    }
  });
  return { imported, skipped };
}
