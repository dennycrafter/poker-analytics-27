// STEP D verification harness: offline safety for the sync engine.
//
// (a) offline queue + flush on reconnect (including a reload while offline and
//     the IndexedDB mirror when localStorage is empty),
// (b) atomic replace-flush: a partial cloud failure must not lose local data
//     and must not leave dangling remote rows (ISSUES.md store ticket #1/#3),
// (c) realtime reconnect catch-up after an offline window.
//
// Drives the REAL js/store.js against a scripted in-memory Supabase — no
// network, no WebSocket (Node 20 has no native WebSocket without a flag).
// Usage: node tests/stepd-offline-sync.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
const { sessionToRow } = await import('../js/cloud-map.js');
const { supabase } = await import('../js/supabase-client.js');

// --- scripted Supabase (tables + failure switches) ----------------------------
const UID = '00000000-0000-4000-8000-000000000001';
const net = {
  online: true,
  failUpsert: null,   // sticky: every upsert resolves with this error until cleared
  failDelete: null,
  upserts: [], deletes: [], calls: [],
  tables: { sessions: [], bankroll_transactions: [], user_settings: [] },
  reset() {
    net.online = true; net.failUpsert = null; net.failDelete = null;
    net.upserts = []; net.deletes = []; net.calls = [];
    net.tables = { sessions: [], bankroll_transactions: [], user_settings: [] };
  },
};
const postgrestError = (message, code) => ({ error: { message, ...(code ? { code } : {}) }, status: 400 });

function applyUpsert(table, rowsArg) {
  if (!net.online) throw new TypeError('Failed to fetch');
  const rows = Array.isArray(rowsArg) ? rowsArg : [rowsArg]; // settings upserts a single row
  net.upserts.push({ table, rows });
  net.calls.push('upsert:' + table);
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
        net.calls.push('delete:' + table);
        if (net.failDelete) {
          const e = net.failDelete;
          net.failDelete = null; // consume-once: a realistic rejection, so the rollback can converge
          return postgrestError(e.message, e.code);
        }
        net.tables[table] = net.tables[table].filter(r => !ids.includes(r.id));
        return { error: null, status: 204 };
      },
    }),
  };
  return q;
}

let channelCb = null;
supabase.from = table => makeBuilder(table);
supabase.channel = () => {
  const ch = { on() { return ch; }, subscribe(cb) { channelCb = cb; return ch; } };
  return ch;
};
supabase.removeChannel = async () => { channelCb = null; };

// --- fixtures -------------------------------------------------------------------
const H = 3600e3;
const cash = (startAgoMs, extra = {}) => ({
  id: store.genId(), kind: 'cash', game_id: null, location_id: null, bankroll_id: 'bk-live', group_id: null,
  table_size: 9, start_time: new Date(Date.now() - startAgoMs).toISOString(),
  end_time: new Date(Date.now() - startAgoMs + 3 * H).toISOString(), duration_seconds: 3 * 3600,
  break_seconds: 0, hands_count: 90, hands_count_estimated: false, is_live: false, tracked_via_stack: false,
  small_blind: 0.1, big_blind: 0.2, buy_in: 20, cashed_out: 35, tips: 0,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...extra,
});
const pushRemoteSession = s => net.tables.sessions.push(sessionToRow({ stack_events: [], sell_actions: [] }, s, UID));
const blankish = over => ({
  settings: { currency: 'EUR' }, bankrolls: [], locations: [], games: [], tournament_types: [], groups: [],
  sessions: [], stack_events: [], sell_actions: [], transactions: [], player_notes: [], hand_histories: [], ...over,
});

async function seedThreeSessions() {
  const originals = [cash(10 * 24 * H), cash(9 * 24 * H), cash(8 * 24 * H)];
  store.mutate(d => { d.sessions = originals.map(s => ({ ...s })); });
  assert.equal(await store.whenSaved(5000), true, 'seed sync failed');
  net.calls = []; net.upserts = []; net.deletes = [];
  return originals;
}

const tick = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function test(name, fn) {
  const run = async () => {
    try { await fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); }
  };
  pending.push(run);
}
const pending = [];

// Every test starts from a signed-in, fully synced store.
async function freshSync() {
  store.stopSync(); // drop the previous test's session so startSync runs its full path
  net.reset(); mem.clear(); channelCb = null;
  await store.startSync(UID);
  await store.whenSaved(5000);
  net.calls = []; net.upserts = []; net.deletes = [];
}

// --- (a) offline queue + flush on reconnect --------------------------------------

test('a1: writes made offline are queued locally and flush on the window "online" event', async () => {
  await freshSync();
  net.online = false;
  const s = cash(H);
  store.mutate(d => { d.sessions.push(s); });
  await tick(30);
  assert.equal(store.getSyncStatus().state, 'offline', 'status is offline');
  assert.equal(store.getState().sessions.length, 1, 'local doc keeps the queued session');
  assert.equal(net.tables.sessions.length, 0, 'nothing reached the server yet');
  assert.equal(net.upserts.length, 0, 'no successful upsert');

  net.online = true;
  assert.equal(typeof winHandlers.get('online'), 'function', 'store listens for the window "online" event');
  winHandlers.get('online')();
  await tick(60);
  assert.equal(net.tables.sessions.length, 1, 'queued write reached the server');
  assert.equal(store.getSyncStatus().state, 'saved', 'converged');
  assert.ok(net.tables.sessions.some(r => r.id === s.id), 'same session id');
});

test('a2: reload while offline paints from the queue, then converges on reconnect', async () => {
  await freshSync();
  const online = cash(2 * 24 * H);
  store.mutate(d => { d.sessions.push(online); });
  assert.equal(await store.whenSaved(5000), true);
  net.online = false;
  const queued = cash(H);
  store.mutate(d => { d.sessions.push(queued); });
  await tick(30);
  assert.equal(store.getSyncStatus().state, 'offline');
  store.stopSync(); // the "old page" dies with its queue persisted in storage

  // Fresh page: a brand-new module instance must restore the queued state.
  const store2 = await import('../js/store.js?stepd-reload-a2');
  const err = await store2.startSync(UID).then(() => null, e => e);
  assert.equal(err, null, `startSync must survive being offline at load: ${err}`);
  assert.equal(store2.getState().sessions.length, 2, 'cache paints the queued document');
  assert.equal(net.tables.sessions.length, 1, 'server still only has the pre-reload rows');

  net.online = true;
  winHandlers.get('online')();
  assert.equal(await store2.whenSaved(5000), true, 'queued write flushed after reconnect');
  assert.equal(net.tables.sessions.length, 2, 'both sessions on the server');
  assert.equal(store2.getState().sessions.length, 2, 'local doc intact');
  store2.stopSync();
});

test('a3: the write queue survives losing localStorage (IndexedDB mirror)', async () => {
  const { installFakeIdb, mirror } = await import('./fixtures/stepd-fake-idb.mjs');
  const idbMap = installFakeIdb();
  await freshSync();
  const s = cash(H);
  store.mutate(d => { d.sessions.push(s); });
  assert.equal(await store.whenSaved(5000), true);
  for (let i = 0; i < 50 && !mirror.has(`pa27:cache:${UID}`); i++) await tick(5);
  assert.ok(mirror.has(`pa27:cache:${UID}`), 'cache mirrored into IndexedDB');
  const mirrored = JSON.parse(mirror.get(`pa27:cache:${UID}`));
  assert.ok(mirrored.doc.sessions.some(x => x.id === s.id), 'mirror holds the queued session');

  mem.clear(); // localStorage evicted; only the IndexedDB copy remains
  store.stopSync();
  const store2 = await import('../js/store.js?stepd-reload-a3');
  await store2.startSync(UID);
  await store2.whenSaved(5000);
  assert.equal(store2.getState().sessions.length, 1, 'document restored from the IndexedDB mirror');
  assert.equal(net.tables.sessions.length, 1, 'and re-synced, no loss, no duplicate');
  store2.stopSync();
  globalThis.indexedDB = undefined;
});

// --- (b) atomic replace-flush (ISSUES.md store ticket: #1 and #3) ---------------

test('b1: replace with a rejected upsert rolls back locally and never deletes the old rows', async () => {
  await freshSync();
  const originals = await seedThreeSessions();
  net.failUpsert = { message: 'new row for table "sessions" violates check constraint "sessions_table_size_check"', code: '23514' };
  const statuses = [];
  const off = store.onSyncStatus(s => statuses.push(s.state));

  const bad = cash(1 * 24 * H, { table_size: 12 });
  store.replaceDoc(blankish({ sessions: [bad] }));
  await tick(80);
  off();

  assert.equal(store.getState().sessions.length, 3, 'local doc restored to the 3 originals');
  assert.deepEqual(store.getState().sessions.map(s => s.id).sort(), originals.map(s => s.id).sort(), 'same sessions back');
  assert.equal(net.deletes.length, 0, 'no delete was ever issued (upserts run first)');
  assert.equal(net.tables.sessions.length, 3, 'cloud account untouched');
  assert.deepEqual(net.tables.sessions.map(r => r.id).sort(), originals.map(s => s.id).sort(), 'originals survive in the cloud');
  assert.ok(statuses.includes('error'), 'the rejection is surfaced as an error status');
});

test('b2: replace whose deletes are rejected rolls back and removes the half-imported rows (no dangling)', async () => {
  await freshSync();
  const originals = await seedThreeSessions();
  net.failDelete = { message: 'delete rejected', code: '42501' };
  const bad = cash(1 * 24 * H); // valid row: upserts succeed, deletes are refused
  store.replaceDoc(blankish({ sessions: [bad] }));
  await tick(120);
  assert.equal(store.getState().sessions.length, 3, 'local doc rolled back');
  assert.deepEqual(store.getState().sessions.map(s => s.id).sort(), originals.map(s => s.id).sort(), 'originals restored locally');
  assert.equal(net.tables.sessions.length, 3, 'cloud back to the originals');
  assert.ok(!net.tables.sessions.some(r => r.id === bad.id), 'half-imported row removed from the cloud (no dangling)');
  assert.deepEqual(store.getState().sessions.map(s => s.id).sort(), net.tables.sessions.map(r => r.id).sort(), 'device and cloud agree');
});

test('b3: a clean replace still lands fully — upserts confirmed before deletes run', async () => {
  await freshSync();
  await seedThreeSessions();
  const fresh = [cash(1 * 24 * H), cash(12 * H)];
  store.replaceDoc(blankish({ sessions: fresh }));
  assert.equal(await store.whenSaved(5000), true);
  assert.equal(net.tables.sessions.length, 2, 'cloud holds exactly the imported rows');
  assert.equal(store.getState().sessions.length, 2, 'local doc holds the import');
  const firstUpsert = net.calls.indexOf('upsert:sessions');
  const firstDelete = net.calls.indexOf('delete:sessions');
  assert.ok(firstUpsert !== -1 && firstDelete !== -1, 'both happened');
  assert.ok(firstUpsert < firstDelete, 'upserts are confirmed before any delete is issued');
});

test('b4: replace made offline stays queued and lands atomically on reconnect', async () => {
  await freshSync();
  const originals = await seedThreeSessions();
  net.online = false;
  const fresh = [cash(1 * 24 * H)];
  store.replaceDoc(blankish({ sessions: fresh }));
  await tick(30);
  assert.equal(store.getSyncStatus().state, 'offline');
  assert.equal(store.getState().sessions.length, 1, 'import applied locally');
  assert.equal(net.tables.sessions.length, 3, 'cloud untouched while offline');

  net.online = true;
  winHandlers.get('online')();
  await tick(80);
  assert.equal(net.tables.sessions.length, 1, 'cloud converged to the import');
  assert.ok(net.tables.sessions.every(r => r.id === fresh[0].id), 'old rows deleted only after the upsert landed');
  assert.equal(store.getState().sessions.length, 1, 'local matches');
  assert.notDeepEqual(net.tables.sessions.map(r => r.id).sort(), originals.map(s => s.id).sort(), 'the replace replaced');
});

test('b5: a plain (non-replace) edit the server rejects is still rolled back to server state', async () => {
  await freshSync();
  const originals = await seedThreeSessions();
  net.failUpsert = { message: 'check constraint "sessions_hands_count_check" is violated', code: '23514' };
  const statuses = [];
  const off = store.onSyncStatus(s => statuses.push(s.state));
  store.mutate(d => { d.sessions[0].hands_count = -5; }); // DB rejects; local optimistic
  await tick(80);
  off();
  assert.ok(statuses.includes('error'), 'rejection surfaced');
  const local = store.getState().sessions.find(s => s.id === originals[0].id);
  assert.notEqual(local.hands_count, -5, 'rejected edit undone locally');
  assert.equal(net.tables.sessions.length, 3, 'no rows lost');
});

// --- (c) realtime reconnect after offline -----------------------------------------

test('c1: realtime CHANNEL_ERROR marks offline; SUBSCRIBED after reconnect pulls what was missed', async () => {
  await freshSync();
  channelCb('SUBSCRIBED'); // initial handshake (no WebSocket involved: faked channel)
  const remote = cash(5 * 24 * H); // "another device" writes while we are offline
  net.online = false;
  channelCb('CHANNEL_ERROR', new Error('socket closed'));
  assert.equal(store.getSyncStatus().state, 'offline', 'channel error surfaces as offline');
  net.online = true;
  pushRemoteSession(remote);
  channelCb('SUBSCRIBED'); // supabase-js auto-resubscribes after the socket returns
  await tick(80);
  assert.ok(store.getState().sessions.some(s => s.id === remote.id), 'missed remote row pulled after reconnect');
  assert.equal(store.getSyncStatus().state, 'saved', 'converged');
});

// --- shell + policy ---------------------------------------------------------------

test('d1: sw.js precaches the offline-queue module and VERSION names the current step', async () => {
  const { readFileSync } = await import('node:fs');
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  // STEP D pinned the exact string it shipped; later steps legitimately bump
  // the version when the shell changes, so assert the step-version scheme.
  // Wave iterations build as it<N>-<n> (e.g. pa27-2026-10-10-it5-1), so the
  // scheme accepts any lowercase step/iteration tag instead of only 'step*'.
  assert.match(sw, /const VERSION = 'pa27-\d{4}-\d{2}-\d{2}-[a-z0-9]+-\d+';/);
  assert.match(sw, /'js\/idb\.js',/);
});

test('d2: the sync policy (offline queue, LWW merge, reconnect) is logged in README.md', async () => {
  const { readFileSync } = await import('node:fs');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /offline/i);
  assert.match(readme, /last-write-wins/i);
  assert.match(readme, /reconnect/i);
});

for (const run of pending) await run();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
