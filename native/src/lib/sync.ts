// Cloud store: in-memory document + pub/sub backed by Supabase. A port of the
// web app's js/store.js sync engine, framework-free so the headless
// integration test (tests/integration.ts) drives exactly this code.
//
// Persistence is a snapshot diff: after every mutation each cloud entity (one
// session row, one transaction row, the settings row) is fingerprinted and
// compared with the fingerprint the server last confirmed; anything that
// differs is upserted/deleted in the background (optimistic UI). Realtime
// postgres_changes flow the other way and are merged with the same
// fingerprints, so this device's own echoes are no-ops and unsaved local
// edits are never clobbered by a stale event.

import type { RealtimeChannel, RealtimePostgresChangesPayload, SupabaseClient } from '@supabase/supabase-js';
import {
  applySettingsRow, defaultMasterData, rowToSessionParts, rowToTransaction, sessionToRow,
  settingsToRow, stableStringify, transactionToRow, type DbRow, type SessionParts,
} from './cloud-map';
import { blankDoc, type Doc, type SellAction, type StackEvent, type Transaction } from './types';

/** AsyncStorage-compatible key/value store (in-memory in tests). */
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export type SyncState = 'idle' | 'saving' | 'saved' | 'offline' | 'error';
export interface SyncStatus { state: SyncState; error: unknown }
export type ChangeSource = 'local' | 'remote';

type TableTag = 's' | 't' | 'settings';
type CloudTable = 'sessions' | 'bankroll_transactions' | 'user_settings';
const TABLE: Record<TableTag, CloudTable> = { s: 'sessions', t: 'bankroll_transactions', settings: 'user_settings' };
const PAGE = 1000;
const ECHO_WINDOW_MS = 15000;

interface LocalEntry { table: TableTag; row: DbRow; fp: string }
type Incoming =
  | { key: string; fp: string; kind: 'session'; parts: SessionParts }
  | { key: string; fp: string; kind: 'txn'; txn: Transaction }
  | { key: string; fp: string; kind: 'settings'; settings: Doc };

interface WriteFailure { error: { message?: string; code?: string; status?: number }; keys: string[] }

const cacheKey = (uid: string) => `pa27:cache:${uid}`;

function groupBySession<T extends { session_id: string }>(list: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of list) {
    const arr = m.get(x.session_id);
    if (arr) arr.push(x); else m.set(x.session_id, [x]);
  }
  return m;
}

function keyOf(table: string, id: unknown): string {
  if (table === 'sessions') return 's:' + String(id);
  if (table === 'bankroll_transactions') return 't:' + String(id);
  return 'settings';
}

function isTransient(error: WriteFailure['error']): boolean {
  const msg = String(error.message || '');
  const st = error.status ?? 0;
  return st === 401 || st >= 500 || /fetch|network|timeout/i.test(msg) || (!error.code && !error.status);
}

export class CloudStore {
  private doc: Doc = blankDoc();
  private listeners = new Set<(doc: Doc, source: ChangeSource) => void>();
  private statusListeners = new Set<(s: SyncStatus) => void>();
  private status: SyncStatus = { state: 'idle', error: null };

  private userId: string | null = null;
  private channel: RealtimeChannel | null = null;
  private ready = false;
  private serverFp = new Map<string, string>();
  private inFlight = new Set<string>();
  private flushQueued = false;
  private flushing: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 2000;
  private subscribedOnce = false;
  private recentWrites = new Map<string, Map<string, number>>();
  /** Resolves once the realtime channel reports SUBSCRIBED (tests await it). */
  private subscribedWaiters: (() => void)[] = [];

  constructor(private supabase: SupabaseClient, private storage: KeyValueStorage) {}

  // --- public API -------------------------------------------------------------

  getState(): Doc { return this.doc; }
  getUserId(): string | null { return this.userId; }
  getStatus(): SyncStatus { return this.status; }
  isReady(): boolean { return this.ready; }

  subscribe(fn: (doc: Doc, source: ChangeSource) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  onStatus(fn: (s: SyncStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => { this.statusListeners.delete(fn); };
  }

  /**
   * Apply a local edit. The document is copied shallowly so React consumers
   * see a new reference; mutators may mutate the arrays on the draft freely.
   */
  mutate(fn: (draft: Doc) => void): void {
    const draft: Doc = {
      ...this.doc,
      settings: { ...this.doc.settings },
      bankrolls: [...this.doc.bankrolls],
      locations: [...this.doc.locations],
      games: [...this.doc.games],
      tournament_types: [...this.doc.tournament_types],
      groups: [...this.doc.groups],
      sessions: this.doc.sessions.map(s => ({ ...s })),
      stack_events: [...this.doc.stack_events],
      sell_actions: [...this.doc.sell_actions],
      transactions: [...this.doc.transactions],
    };
    fn(draft);
    this.doc = draft;
    void this.saveLocal();
    this.notify('local');
    this.scheduleFlush();
  }

  /** Resolve when nothing is dirty or on the wire (or the last flush failed). */
  async whenSettled(): Promise<SyncStatus> {
    for (let i = 0; i < 50; i++) {
      if (this.flushing) await this.flushing;
      await new Promise(r => setTimeout(r, 0));
      if (!this.flushing && !this.flushQueued) break;
    }
    return this.status;
  }

  waitForRealtime(timeoutMs = 10000): Promise<void> {
    if (this.subscribedOnce) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('realtime subscribe timed out')), timeoutMs);
      this.subscribedWaiters.push(() => { clearTimeout(t); resolve(); });
    });
  }

  // Sign-in: hydrate from the device cache (instant paint), subscribe, then pull.
  async start(uid: string): Promise<void> {
    if (this.userId === uid) return;
    await this.stop();
    this.userId = uid;
    this.ready = false;
    this.subscribedOnce = false;
    let hadCache = false;
    try {
      const raw = await this.storage.getItem(cacheKey(uid));
      const cached = raw ? (JSON.parse(raw) as { doc?: Partial<Doc>; serverFp?: [string, string][] }) : null;
      if (cached && cached.doc) {
        this.doc = { ...blankDoc(), ...cached.doc };
        this.serverFp = new Map(cached.serverFp || []);
        hadCache = true;
        this.notify('remote');
      }
    } catch (e) {
      console.error('store: unreadable cache, ignoring', e);
    }
    this.channel = this.subscribeRealtime(uid);
    this.setStatus('saving');
    const res = await this.pull({ preferServer: !hadCache });
    if (!res || uid !== this.userId) return;
    if (!res.settingsFound && !this.serverFp.has('settings')) {
      // Brand-new account: default master data, no demo sessions.
      const defaults = defaultMasterData(new Date().toISOString());
      this.doc = { ...this.doc, ...defaults };
    }
    this.ready = true;
    await this.saveLocal();
    this.notify('remote');
    this.scheduleFlush();
  }

  async stop(): Promise<void> {
    if (this.channel) { await this.supabase.removeChannel(this.channel); this.channel = null; }
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.userId = null;
    this.ready = false;
    this.serverFp = new Map();
    this.inFlight.clear();
    this.recentWrites.clear();
    this.doc = blankDoc();
    this.setStatus('idle');
    this.notify('remote');
  }

  async clearCache(uid: string): Promise<void> {
    await this.storage.removeItem(cacheKey(uid));
  }

  /** Background reconcile; notifies only when the server state differed. */
  refresh(reason: string): void {
    if (!this.userId || !this.ready) return;
    this.pull()
      .then(async res => {
        await this.saveLocal();
        if (res && res.changed) this.notify('remote');
        this.scheduleFlush();
      })
      .catch(e => console.error(`sync: ${reason} failed`, e));
  }

  // --- internals --------------------------------------------------------------

  private notify(source: ChangeSource): void {
    for (const fn of [...this.listeners]) {
      try { fn(this.doc, source); } catch (e) { console.error('store subscriber failed', e); }
    }
  }

  private setStatus(state: SyncState, error: unknown = null): void {
    this.status = { state, error };
    for (const fn of [...this.statusListeners]) {
      try { fn(this.status); } catch (e) { console.error('sync status listener failed', e); }
    }
  }

  private async saveLocal(): Promise<void> {
    if (!this.userId) return;
    try {
      await this.storage.setItem(cacheKey(this.userId), JSON.stringify({ doc: this.doc, serverFp: [...this.serverFp] }));
    } catch (e) {
      console.error('store: failed to write local cache', e);
    }
  }

  private localEntries(): Map<string, LocalEntry> {
    const out = new Map<string, LocalEntry>();
    const evs = groupBySession<StackEvent>(this.doc.stack_events);
    const sells = groupBySession<SellAction>(this.doc.sell_actions);
    for (const s of this.doc.sessions) {
      const row = sessionToRow({ stack_events: evs.get(s.id) || [], sell_actions: sells.get(s.id) || [] }, s, this.userId);
      out.set('s:' + s.id, { table: 's', row, fp: stableStringify(row) });
    }
    for (const t of this.doc.transactions) {
      const row = transactionToRow(t, this.userId);
      out.set('t:' + t.id, { table: 't', row, fp: stableStringify(row) });
    }
    const srow = settingsToRow(this.doc, this.userId);
    out.set('settings', { table: 'settings', row: srow, fp: stableStringify(srow) });
    return out;
  }

  private localFpOf(key: string): string | undefined {
    if (key === 'settings') return stableStringify(settingsToRow(this.doc, this.userId));
    const id = key.slice(2);
    if (key.startsWith('s:')) {
      const s = this.doc.sessions.find(x => x.id === id);
      return s ? stableStringify(sessionToRow(this.doc, s, this.userId)) : undefined;
    }
    const t = this.doc.transactions.find(x => x.id === id);
    return t ? stableStringify(transactionToRow(t, this.userId)) : undefined;
  }

  private fromServer(table: string, row: DbRow): Incoming {
    if (table === 'sessions') {
      const parts = rowToSessionParts(row);
      return { key: 's:' + String(row.id), fp: stableStringify(sessionToRow(parts, parts.session, this.userId)), kind: 'session', parts };
    }
    if (table === 'bankroll_transactions') {
      const txn = rowToTransaction(row);
      return { key: 't:' + String(row.id), fp: stableStringify(transactionToRow(txn, this.userId)), kind: 'txn', txn };
    }
    const tmp = blankDoc();
    applySettingsRow(tmp, row);
    return { key: 'settings', fp: stableStringify(settingsToRow(tmp, this.userId)), kind: 'settings', settings: tmp };
  }

  /** Replace (or remove, when incoming is null) one entity; produces a new doc reference. */
  private applyEntity(key: string, incoming: Incoming | null): void {
    const d: Doc = { ...this.doc };
    if (key === 'settings') {
      if (incoming && incoming.kind === 'settings') {
        const src = incoming.settings;
        d.bankrolls = src.bankrolls; d.locations = src.locations; d.games = src.games;
        d.tournament_types = src.tournament_types; d.groups = src.groups;
        d.extra_master = src.extra_master; d.settings = src.settings;
        d.player_notes = src.player_notes; d.hand_histories = src.hand_histories;
      }
      this.doc = d;
      return;
    }
    const id = key.slice(2);
    if (key.startsWith('t:')) {
      d.transactions = d.transactions.filter(x => x.id !== id);
      if (incoming && incoming.kind === 'txn') d.transactions.push(incoming.txn);
      this.doc = d;
      return;
    }
    const existing = d.sessions.findIndex(x => x.id === id);
    d.stack_events = d.stack_events.filter(e => e.session_id !== id);
    d.sell_actions = d.sell_actions.filter(a => a.session_id !== id);
    d.sessions = [...d.sessions];
    if (!incoming || incoming.kind !== 'session') {
      if (existing >= 0) d.sessions.splice(existing, 1);
    } else {
      if (existing >= 0) d.sessions[existing] = incoming.parts.session; else d.sessions.push(incoming.parts.session);
      d.stack_events.push(...incoming.parts.stack_events);
      d.sell_actions.push(...incoming.parts.sell_actions);
    }
    this.doc = d;
  }

  private isDirty(key: string): boolean {
    return this.inFlight.has(key) || this.localFpOf(key) !== this.serverFp.get(key);
  }

  private async fetchAll(table: CloudTable): Promise<DbRow[]> {
    const rows: DbRow[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await this.supabase.from(table).select('*')
        .eq('user_id', this.userId as string)
        .order(table === 'user_settings' ? 'user_id' : 'id')
        .range(from, from + PAGE - 1);
      if (error) throw error;
      const page = (data ?? []) as DbRow[];
      rows.push(...page);
      if (page.length < PAGE) return rows;
    }
  }

  /** Full reconcile with the server; dirty local entities survive unless discarded. */
  private async pull({ discard = new Set<string>(), preferServer = false } = {}) {
    const uid = this.userId;
    const [sessions, txns, settings] = await Promise.all(
      (['sessions', 'bankroll_transactions', 'user_settings'] as const).map(t => this.fetchAll(t)));
    if (uid !== this.userId) return null;

    const incoming = new Map<string, Incoming>();
    for (const r of sessions) { const x = this.fromServer('sessions', r); incoming.set(x.key, x); }
    for (const r of txns) { const x = this.fromServer('bankroll_transactions', r); incoming.set(x.key, x); }
    let settingsFound = false;
    for (const r of settings) { const x = this.fromServer('user_settings', r); incoming.set(x.key, x); settingsFound = true; }

    const keys = new Set([...incoming.keys(), ...this.serverFp.keys(), ...this.localEntries().keys()]);
    let changed = 0;
    for (const key of keys) {
      if (!preferServer && !discard.has(key) && this.isDirty(key)) continue;
      const next = incoming.get(key) || null;
      if ((next ? next.fp : undefined) === this.localFpOf(key)) continue;
      if (key === 'settings' && !next) continue;
      this.applyEntity(key, next);
      changed++;
    }
    this.serverFp = new Map([...incoming].map(([k, v]) => [k, v.fp]));
    return { changed, settingsFound };
  }

  private scheduleFlush(): void {
    if (!this.userId || !this.ready || this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => { this.flushQueued = false; void this.flush(); });
  }

  private flush(): Promise<void> {
    if (this.flushing || !this.userId || !this.ready) return this.flushing ?? Promise.resolve();
    this.flushing = this.runFlush().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async runFlush(): Promise<void> {
    try {
      for (;;) {
        const local = this.localEntries();
        const ups: Record<TableTag, [string, LocalEntry][]> = { s: [], t: [], settings: [] };
        const dels: Record<'s' | 't', string[]> = { s: [], t: [] };
        for (const [key, e] of local) {
          if (!this.inFlight.has(key) && this.serverFp.get(key) !== e.fp) ups[e.table].push([key, e]);
        }
        for (const key of this.serverFp.keys()) {
          if (!local.has(key) && !this.inFlight.has(key) && key !== 'settings') dels[key.slice(0, 1) as 's' | 't'].push(key);
        }
        const jobs: Promise<WriteFailure | null>[] = [];
        for (const t of ['s', 't', 'settings'] as const) if (ups[t].length) jobs.push(this.writeUpserts(t, ups[t]));
        for (const t of ['s', 't'] as const) if (dels[t].length) jobs.push(this.writeDeletes(t, dels[t]));
        if (!jobs.length) { this.setStatus('saved'); return; }
        this.setStatus('saving');
        const results = await Promise.all(jobs);
        const failed = results.find((r): r is WriteFailure => !!r);
        if (failed) {
          if (isTransient(failed.error)) {
            this.setStatus('offline', failed.error);
            this.scheduleRetry();
          } else {
            console.error('sync: server rejected a write', failed.error);
            this.setStatus('error', failed.error);
            const discard = new Set(results.flatMap(r => (r ? r.keys : [])));
            const res = await this.pull({ discard });
            await this.saveLocal();
            if (res && res.changed) this.notify('remote');
          }
          return;
        }
        this.retryDelay = 2000;
        await this.saveLocal();
      }
    } catch (e) {
      console.error('sync: flush failed', e);
      this.setStatus('offline', e);
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.flush(); }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 30000);
  }

  private async writeUpserts(table: TableTag, entries: [string, LocalEntry][]): Promise<WriteFailure | null> {
    const keys = entries.map(([k]) => k);
    keys.forEach(k => this.inFlight.add(k));
    try {
      const q = this.supabase.from(TABLE[table]);
      const rows = entries.map(([, e]) => e.row);
      const { error, status } = table === 'settings'
        ? await q.upsert(rows[0], { onConflict: 'user_id' })
        : await q.upsert(rows, { onConflict: 'id' });
      if (error) return { error: { message: error.message, code: error.code, status }, keys };
      entries.forEach(([k, e]) => { this.serverFp.set(k, e.fp); this.rememberWrite(k, e.fp); });
      return null;
    } finally {
      keys.forEach(k => this.inFlight.delete(k));
    }
  }

  private async writeDeletes(table: 's' | 't', keys: string[]): Promise<WriteFailure | null> {
    keys.forEach(k => this.inFlight.add(k));
    try {
      const ids = keys.map(k => k.slice(2));
      const { error, status } = await this.supabase.from(TABLE[table]).delete().in('id', ids);
      if (error) return { error: { message: error.message, code: error.code, status }, keys };
      keys.forEach(k => this.serverFp.delete(k));
      return null;
    } finally {
      keys.forEach(k => this.inFlight.delete(k));
    }
  }

  // --- realtime -----------------------------------------------------------------

  // Echoes of this device's own writes can arrive after a newer write was
  // confirmed (pause, then resume quickly); applying such a stale echo would
  // flicker the UI back a step, so recent own fingerprints are ignored briefly.
  private rememberWrite(key: string, fp: string): void {
    const now = Date.now();
    let m = this.recentWrites.get(key);
    if (!m) { m = new Map(); this.recentWrites.set(key, m); }
    m.set(fp, now);
    for (const [f, t] of m) if (now - t > ECHO_WINDOW_MS) m.delete(f);
  }

  private isStaleOwnEcho(key: string, fp: string): boolean {
    const t = this.recentWrites.get(key)?.get(fp);
    return t !== undefined && Date.now() - t <= ECHO_WINDOW_MS && this.serverFp.get(key) !== fp;
  }

  private onRealtime = (payload: RealtimePostgresChangesPayload<DbRow>): void => {
    const table = payload.table;
    const row = (payload.eventType === 'DELETE' ? payload.old : payload.new) as DbRow | undefined;
    if (!row) return;
    if (table !== 'user_settings' && !row.id) return;
    if (row.user_id && row.user_id !== this.userId) return;
    if (payload.eventType === 'DELETE' && table === 'user_settings') return;
    const key = keyOf(table, row.id);
    // DELETE events cannot be filtered server-side: ignore ids never seen here.
    if (payload.eventType === 'DELETE' && !this.serverFp.has(key) && !this.localFpOf(key)) return;

    const incoming = payload.eventType === 'DELETE' ? null : this.fromServer(table, row);
    if (incoming && this.isStaleOwnEcho(key, incoming.fp)) return;
    const dirty = this.isDirty(key);
    if (incoming) this.serverFp.set(key, incoming.fp); else this.serverFp.delete(key);
    if (dirty) { this.scheduleFlush(); return; }
    if ((incoming ? incoming.fp : undefined) === this.localFpOf(key)) return; // own echo
    this.applyEntity(key, incoming);
    void this.saveLocal();
    this.notify('remote');
  };

  private subscribeRealtime(uid: string): RealtimeChannel {
    const filter = `user_id=eq.${uid}`;
    let ch = this.supabase.channel(`pa27-native:${uid}:${Date.now()}`);
    for (const table of ['sessions', 'bankroll_transactions', 'user_settings']) {
      ch = ch
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table, filter }, this.onRealtime)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table, filter }, this.onRealtime);
    }
    for (const table of ['sessions', 'bankroll_transactions']) {
      ch = ch.on('postgres_changes', { event: 'DELETE', schema: 'public', table }, this.onRealtime);
    }
    return ch.subscribe((state, err) => {
      if (state === 'SUBSCRIBED') {
        if (this.subscribedOnce && this.ready) this.refresh('catch-up after reconnect');
        this.subscribedOnce = true;
        this.subscribedWaiters.splice(0).forEach(fn => fn());
      } else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT') {
        console.error('sync: realtime channel', state, err);
        this.setStatus('offline', err || new Error(state));
      }
    });
  }
}
