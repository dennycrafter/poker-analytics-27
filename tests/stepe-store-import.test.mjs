// STEP E verification: the store import wiring (store-change + PokerNow tickets).
//
// importSessions(drafts, { bankrollId }) must:
//   - resolve refs { game, location, bankroll, group, tournament_type } by name,
//     creating missing master items, reusing existing ones case-insensitively,
//     and falling back to the default bankroll,
//   - assign id / created_at / updated_at and insert the whole batch in ONE save,
//   - refuse rows the database would reject (same guards as the JSON import),
//   - skip duplicates: by fingerprint against the store, in-batch, and by
//     source.import_key (re-importing the same PokerNow file must not duplicate),
//   - enforce the one-live-session rule for live drafts with stack events,
//   - force is_live=false / tracked_via_stack=false on generic CSV drafts.
//
// Drives the REAL js/store.js against a scripted in-memory Supabase — no
// network. Usage: node tests/stepe-store-import.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (typeof globalThis.WebSocket === 'undefined') {
  const r = spawnSync(process.execPath, ['--experimental-websocket', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: process.env });
  process.exit(r.status ?? 1);
}

// --- browser stubs -----------------------------------------------------------
const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k), clear: () => mem.clear(),
};
const docHandlers = new Map();
globalThis.document = {
  visibilityState: 'visible',
  addEventListener: (t, fn) => docHandlers.set(t, fn),
  removeEventListener: t => docHandlers.delete(t),
};
const winHandlers = new Map();
globalThis.window = {
  addEventListener: (t, fn) => winHandlers.set(t, fn),
  removeEventListener: t => winHandlers.delete(t),
};
globalThis.location = new URL('http://localhost/');

const store = await import('../js/store.js');
const { sessionNet } = await import('../js/stats.js');
const { sessionFingerprint } = await import('../js/csv-import.js');
const { importPokerNow } = await import('../js/pokernow-import.js');
const { supabase } = await import('../js/supabase-client.js');
const { join, dirname } = await import('node:path');

// --- scripted Supabase (same harness as stepd-offline-sync) ------------------
const UID = '00000000-0000-4000-8000-000000000001';
const net = {
  online: true,
  failUpsert: null,
  upserts: [], deletes: [],
  tables: { sessions: [], bankroll_transactions: [], user_settings: [] },
  reset() {
    net.online = true; net.failUpsert = null; net.upserts = []; net.deletes = [];
    net.tables = { sessions: [], bankroll_transactions: [], user_settings: [] };
  },
};
const postgrestError = (message, code) => ({ error: { message, ...(code ? { code } : {}) }, status: 400 });

function applyUpsert(table, rowsArg) {
  if (!net.online) throw new TypeError('Failed to fetch');
  const rows = Array.isArray(rowsArg) ? rowsArg : [rowsArg];
  net.upserts.push({ table, rows });
  if (net.failUpsert) return postgrestError(net.failUpsert.message, net.failUpsert.code);
  const t = net.tables[table];
  for (const row of rows) {
    const k = row.id ?? row.user_id;
    const i = t.findIndex(r => (r.id ?? r.user_id) === k);
    if (i >= 0) t[i] = row; else t.push(row);
  }
  return { error: null, status: 201 };
}

function makeBuilder(table) {
  const q = {
    select: () => q, eq: () => q, order: () => q,
    range: async () => {
      if (!net.online) throw new TypeError('Failed to fetch');
      return { data: net.tables[table].map(r => ({ ...r })), error: null };
    },
    upsert: async rows => applyUpsert(table, rows),
    delete: () => ({
      in: async (_col, ids) => {
        if (!net.online) throw new TypeError('Failed to fetch');
        net.deletes.push({ table, ids });
        net.tables[table] = net.tables[table].filter(r => !ids.includes(r.id));
        return { error: null, status: 204 };
      },
    }),
  };
  return q;
}

supabase.from = table => makeBuilder(table);
supabase.channel = () => {
  const ch = { on() { return ch; }, subscribe(cb) { return ch; } };
  return ch;
};
supabase.removeChannel = async () => {};

// --- fixtures -------------------------------------------------------------------
const cashDraft = (over = {}, refs = {}, line = 2) => {
  const session = {
    kind: 'cash',
    start_time: new Date(Date.UTC(2026, 8, 1, 19, 0, 0)).toISOString(),
    end_time: new Date(Date.UTC(2026, 8, 1, 22, 0, 0)).toISOString(),
    duration_seconds: 3 * 3600, break_seconds: 0, table_size: 9,
    hands_count: 90, hands_count_estimated: false,
    comment: null, opponents: null, is_live: false, tracked_via_stack: false,
    small_blind: 0.1, big_blind: 0.2, buy_in: 20, cashed_out: 35, tips: 0,
    ...over,
  };
  return {
    line, session,
    refs: { game: "NL Hold'em", location: 'UCD', bankroll: null, group: null, tournament_type: null, ...refs },
    currency: 'EUR',
    net_result: over.net_result ?? 15,
    fingerprint: sessionFingerprint(session, over.net_result ?? 15),
    warnings: [],
  };
};
const tournDraft = (over = {}, refs = {}, line = 3) => {
  const session = {
    kind: 'tournament',
    start_time: new Date(Date.UTC(2026, 8, 2, 19, 0, 0)).toISOString(),
    end_time: new Date(Date.UTC(2026, 8, 2, 21, 0, 0)).toISOString(),
    duration_seconds: 2 * 3600, break_seconds: 0, table_size: 9,
    hands_count: null, hands_count_estimated: false,
    comment: null, opponents: null, is_live: false, tracked_via_stack: false,
    tournament_name: 'Wednesday Night', initial_buy_in: 20, total_buy_in: 20,
    prize: 0, position: null, entries: null, tips: 0,
    ...over,
  };
  return {
    line, session,
    refs: { game: 'PLO', location: null, bankroll: null, group: null, tournament_type: 'SNG', ...refs },
    currency: 'EUR',
    net_result: over.net_result ?? -20,
    fingerprint: sessionFingerprint(session, over.net_result ?? -20),
    warnings: [],
  };
};

const PN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pokernow');
const pnFile = rel => ({ name: rel.split('/').pop(), text: readFileSync(join(PN_DIR, rel), 'utf8') });
// Closed session (root fixture) and still-open seat (live/ fixture), both Denis.
const pnClosed = () => importPokerNow(
  [pnFile('ledger_pglPa27Home01.csv'), pnFile('poker_now_log_pglPa27Home01.csv')],
  { me: 'Denis' });
const pnLive = () => importPokerNow(
  [pnFile('live/ledger_pglPa27Home01.csv'), pnFile('live/poker_now_log_pglPa27Home01.csv')],
  { me: 'Denis' });

async function signIn() {
  await store.startSync(UID);
  // startSync returns before the first reconcile finishes; wait for the status
  // it sets when bootstrap completes ('saved', or 'offline' when it failed),
  // so tests never race the default master data.
  const until = Date.now() + 5000;
  while (!['saved', 'offline'].includes(store.getSyncStatus().state) && Date.now() < until) {
    await new Promise(r => setTimeout(r, 10));
  }
  assert.equal(await store.whenSaved(5000), true, 'sign-in sync failed');
}

// Real per-test setup: fresh store state per test.
async function freshAccount() {
  store.stopSync();
  mem.clear();
  net.reset();
  await signIn();
}

const pass = [];
let fail = 0;
async function test(name, fn) {
  try {
    await freshAccount();
    await fn();
    pass.push(name);
    console.log('  ok  ', name);
  } catch (e) {
    fail++;
    console.error('  FAIL', name, '\n     ', e.message, '\n     ', (e.stack || '').split('\n')[1] || '');
  }
}

// ---------------------------------------------------------------------------
await signIn(); // module-level bootstrap so the first test's freshAccount is warm

await test('resolves refs by name: creates missing game/location/group/type, reuses existing case-insensitively', async () => {
  const d = store.getState();
  assert.ok(d.bankrolls.find(b => b.is_default), 'account has a default bankroll');
  const r = store.importSessions([
    cashDraft({}, { game: "NL Hold'em", location: 'UCD', group: 'Home League' }),
    tournDraft({}, { game: 'plo', location: 'ucd', tournament_type: 'sng' }), // case-insensitive reuse
  ]);
  assert.equal(r.imported.length, 2, 'both drafts imported');
  assert.equal(r.skipped.length, 0);
  const doc = store.getState();
  // Master data: "NL Hold'em" already existed; PLO existed; UCD created once; SNG existed; group created.
  assert.equal(doc.games.filter(g => g.name === "NL Hold'em").length, 1, 'no duplicate game');
  assert.equal(doc.games.filter(g => g.name === 'PLO').length, 1, 'no duplicate game (case)');
  assert.equal(doc.locations.length, 1, 'one location created');
  assert.equal(doc.locations[0].name, 'UCD');
  assert.equal(doc.groups.length, 1);
  assert.equal(doc.groups[0].name, 'Home League');
  const [cash, tourn] = doc.sessions;
  assert.equal(cash.game_id, doc.games.find(g => g.name === "NL Hold'em").id);
  assert.equal(cash.location_id, doc.locations[0].id);
  assert.equal(cash.group_id, doc.groups[0].id);
  assert.equal(tourn.game_id, doc.games.find(g => g.name === 'PLO').id);
  assert.equal(tourn.location_id, doc.locations[0].id, 'same location reused');
  assert.equal(tourn.tournament_type_id, doc.tournament_types.find(t => t.name === 'SNG').id);
});

await test('falls back to the default bankroll, honours bankrollId opt, per-row bankroll column wins and is created', async () => {
  const doc0 = store.getState();
  const defaultBk = doc0.bankrolls.find(b => b.is_default);
  const r = store.importSessions([cashDraft()]);
  assert.equal(r.imported.length, 1);
  assert.equal(store.getState().sessions[0].bankroll_id, defaultBk.id);

  // A named option bankroll: an unknown bankrollId falls back to the default
  // rather than writing a dangling id. (Distinct start times — an identical
  // draft would be skipped as a duplicate of the row above.)
  const r2 = store.importSessions(
    [cashDraft({ start_time: new Date(Date.UTC(2026, 8, 1, 20, 0, 0)).toISOString(),
      end_time: new Date(Date.UTC(2026, 8, 1, 23, 0, 0)).toISOString() })],
    { bankrollId: 'no-such-id' });
  assert.equal(r2.imported.length, 1);
  assert.equal(store.getState().sessions[1].bankroll_id, defaultBk.id);

  // Per-row refs.bankroll column: created and used for that row.
  const r3 = store.importSessions(
    [cashDraft({ start_time: new Date(Date.UTC(2026, 8, 1, 21, 0, 0)).toISOString(),
      end_time: new Date(Date.UTC(2026, 8, 2, 0, 0, 0)).toISOString() }, { bankroll: 'Live Online' })]);
  assert.equal(r3.imported.length, 1);
  const bk = store.getState().bankrolls.find(b => b.name === 'Live Online');
  assert.ok(bk, 'bankroll from the column was created');
  assert.equal(store.getState().sessions[2].bankroll_id, bk.id);
});

await test('assigns id / created_at / updated_at and lands the batch in one flush upsert', async () => {
  const before = Date.now();
  const r = store.importSessions([cashDraft(), tournDraft()]);
  const doc = store.getState();
  for (const s of doc.sessions) {
    assert.match(s.id, /^[0-9a-f-]{36}$/i, 'uuid id');
    assert.equal(s.is_live, false);
    assert.ok(Date.parse(s.created_at) >= before - 1000 && Date.parse(s.created_at) <= Date.now() + 1000);
    assert.equal(s.created_at, s.updated_at);
  }
  assert.equal(await store.whenSaved(5000), true);
  const sessUpserts = net.upserts.filter(u => u.table === 'sessions');
  const last = sessUpserts[sessUpserts.length - 1];
  assert.equal(last.rows.length, 2, 'both rows in a single upsert call');
});

await test('generic CSV drafts are forced is_live=false / tracked_via_stack=false even when the draft claims otherwise', async () => {
  store.importSessions([
    cashDraft({ is_live: true, tracked_via_stack: true, paused_at: '2026-09-01T20:00:00Z' }),
  ]);
  const s = store.getState().sessions[0];
  assert.equal(s.is_live, false, 'imported CSV sessions are never live (E1 contract)');
  assert.equal(s.tracked_via_stack, false);
  assert.equal(s.buy_in, 20, 'money stays in the buy_in column');
  assert.equal(s.paused_at, null);
});

await test('duplicate guard: fingerprint match against the store and within the batch is skipped with a reason', async () => {
  // Seed the store with one session that matches the first draft.
  const existing = cashDraft().session;
  store.mutate(d => {
    d.sessions.push({
      ...existing, id: store.genId(), game_id: null, location_id: null, bankroll_id: d.bankrolls[0].id,
      group_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
  });
  const r = store.importSessions([
    cashDraft(),                                                     // duplicate of the store row
    cashDraft({}, {}, 5),                                            // duplicate within the batch (same fingerprint)
    cashDraft({ start_time: new Date(Date.UTC(2026, 7, 1, 19, 0, 0)).toISOString() }, {}, 6), // unique
  ]);
  assert.equal(r.imported.length, 1, 'only the unique row imported');
  assert.equal(r.skipped.length, 2);
  for (const sk of r.skipped) assert.match(sk.reason, /already|duplicate/i, `honest reason, got: ${sk.reason}`);
  assert.equal(store.getState().sessions.length, 2);
});

await test('refuses rows the database would reject (STEP D guards), per row, without blocking valid ones', async () => {
  const r = store.importSessions([
    cashDraft({ table_size: 12 }, {}, 2),                            // DB CHECK 2-10
    cashDraft({ hands_count: -5 }, {}, 3),                           // DB CHECK >= 0
    cashDraft({}, {}, 4),                                            // valid
  ]);
  assert.equal(r.imported.length, 1);
  assert.equal(r.skipped.length, 2);
  assert.match(r.skipped[0].reason, /table size/i);
  assert.match(r.skipped[1].reason, /hands/i);
});

await test('PokerNow wiring: writes sessions + stack events, resolves game/location names, registers import_key', async () => {
  const res = pnLive();
  assert.equal(res.status, 'ok');
  assert.equal(res.sessions.length, 1);
  const pn = res.sessions[0];
  assert.equal(pn.session.is_live, true);
  const r = store.importSessions(res.sessions);
  assert.equal(r.imported.length, 1);
  const doc = store.getState();
  const s = doc.sessions[0];
  assert.equal(s.is_live, true);
  assert.equal(s.tracked_via_stack, true);
  assert.equal(s.buy_in, null, 'buy-in derived from stack events (single source of truth)');
  assert.ok(doc.stack_events.filter(e => e.session_id === s.id).length >= 1, 'stack events written');
  for (const e of doc.stack_events.filter(e => e.session_id === s.id)) {
    assert.match(e.id, /^[0-9a-f-]{36}$/i, 'stack event ids assigned');
    assert.ok(['buy_in', 'top_up', 'cash_out'].includes(e.kind));
  }
  assert.equal(s.game_id, doc.games.find(g => g.name === "NL Hold'em").id, 'game_name resolved to the default game');
  const loc = doc.locations.find(l => l.name === (pn.session.location_name || 'PokerNow'));
  assert.ok(loc, 'location created from location_name');
  assert.equal(s.location_id, loc.id);
  assert.equal(doc.import_keys[pn.source.import_key], s.id, 'import_key registered');
});

await test('PokerNow dedupe: re-importing the same file imports nothing and says so', async () => {
  const first = store.importSessions(pnLive().sessions);
  assert.equal(first.imported.length, 1);
  const again = store.importSessions(pnLive().sessions); // fresh parse, same import_key
  assert.equal(again.imported.length, 0, 'no duplicates on re-import');
  assert.equal(again.skipped.length, 1);
  assert.match(again.skipped[0].reason, /already imported/i);
  assert.equal(store.getState().sessions.length, 1);
  assert.equal((await store.whenSaved(5000)), true);
  assert.equal(net.tables.sessions.length, 1, 'cloud never saw a second row');
});

await test('PokerNow dedupe prunes the registry when the session is deleted: re-import works again', async () => {
  const first = store.importSessions(pnClosed().sessions);
  assert.equal(first.imported.length, 1);
  const sid = store.getState().sessions[0].id;
  store.mutate(d => { d.sessions = d.sessions.filter(s => s.id !== sid); }); // user deleted it
  const again = store.importSessions(pnClosed().sessions);
  assert.equal(again.imported.length, 1, 're-import after delete is allowed');
  assert.equal(store.getState().sessions.length, 1);
});

await test('one-live-session rule: a live draft is skipped while another session is live, honest reason given', async () => {
  // The account already has a live session.
  store.mutate(d => {
    d.sessions.push({
      id: store.genId(), kind: 'cash', game_id: null, location_id: null, bankroll_id: d.bankrolls[0].id,
      group_id: null, table_size: 9, start_time: new Date().toISOString(), end_time: null,
      duration_seconds: null, break_seconds: 0, hands_count: null, hands_count_estimated: true,
      comment: null, opponents: null, is_live: true, tracked_via_stack: true, paused_at: null,
      small_blind: 0.1, big_blind: 0.2, buy_in: null, cashed_out: null, tips: 0,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
  });
  const res = pnLive();
  const r = store.importSessions(res.sessions);
  assert.equal(r.imported.length, 0, 'live draft skipped');
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /live/i);
  assert.equal(store.getState().stack_events.length, 0, 'no stack events written for the skipped draft');

  // Closed drafts from the same track are unaffected by the rule.
  const r2 = store.importSessions(pnClosed().sessions);
  assert.equal(r2.imported.length, 1);
});

await test('one-live-session rule within one batch: first live draft wins, later ones are skipped', async () => {
  const res = pnLive();
  const r = store.importSessions([...res.sessions, ...res.sessions.map(x => ({ ...x, source: { ...x.source } }))]);
  assert.equal(r.imported.length, 1);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /(live|already imported)/i);
  assert.equal(store.getState().sessions.filter(s => s.is_live).length, 1);
});

await test('import_keys rides the per-user cache: it survives a reload (saveLocal payload)', async () => {
  const res = pnClosed();
  const r = store.importSessions(res.sessions);
  const payload = JSON.parse(mem.get(`pa27:cache:${UID}`));
  assert.equal(payload.doc.import_keys[res.sessions[0].source.import_key], r.imported[0].id);
  // And a fresh startSync restores it from the cache.
  store.stopSync();
  await store.startSync(UID);
  assert.equal(store.getState().import_keys[res.sessions[0].source.import_key], r.imported[0].id);
});

await test('mixed batch: valid rows imported, bad rows skipped with reasons, nothing half-written', async () => {
  const res = pnClosed();
  const r = store.importSessions([
    res.sessions[0],                                  // fine
    cashDraft({ table_size: 12 }, {}, 9),             // DB guard
    null,                                             // garbage never throws
    { session: { kind: 'cash' }, refs: {} },          // missing times
  ]);
  assert.equal(r.imported.length, 1);
  assert.equal(r.skipped.length, 3);
  assert.ok(r.skipped.every(x => typeof x.reason === 'string' && x.reason.length));
});

await test('imported sessions compute the same net in stats as the draft promised', async () => {
  const draft = cashDraft();
  store.importSessions([draft]);
  const s = store.getState().sessions[0];
  assert.equal(sessionNet(store.getState(), s), draft.net_result);
});

// --- summary -----------------------------------------------------------------
console.log(`\n${pass.length} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
