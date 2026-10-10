// STEP F — two-device sync sweep (deterministic, offline).
//
// Drives TWO independent instances of the REAL js/store.js (one per device,
// imported under distinct query strings so each gets its own module state)
// against ONE shared scripted Supabase server. The stub delivers
// postgres_changes events to each device's registered channel bindings —
// reproducing the server-side owner-filter trigger (replica identity full, so
// DELETE payloads carry the old row including user_id).
//
// Sweep assertions (assignment: converge within seconds, LWW per the
// documented policy, no data loss either way):
//   s1  both devices boot the same fresh account empty (no demo rows);
//   s2  every realtime DELETE binding carries the user_id owner filter;
//   s3  create on A converges on B via realtime with zero extra pulls;
//   s4  edit on B converges on A via realtime;
//   s5  an account-wide outage queues edits/creations on both devices; on
//       reconnect everything converges — nothing lost in either direction;
//   s6  last-write-wins per row: a confirmed remote edit loses to a local
//       unsaved edit that flushes later; both devices agree afterwards;
//   s7  deletes propagate online to the other device;
//   s8  a DELETE event for an id this account never saw is ignored.
//
// Usage: node tests/stepf-two-device-sync.test.mjs  (no network; re-execs
// with --experimental-websocket on Node 20 for the vendored client import)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// js/supabase-client.js builds the vendored client at import; Node 20 needs
// the WebSocket flag for that (same re-exec as the stepd/cloud harnesses).
if (typeof globalThis.WebSocket === 'undefined') {
  const r = spawnSync(process.execPath, ['--experimental-websocket', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: process.env });
  process.exit(r.status ?? 1);
}

// --- browser stubs (shared infra; each store instance sees the same stubs) ---
const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k), clear: () => mem.clear(),
};
const docHandlers = new Map();
globalThis.document = {
  visibilityState: 'visible',
  addEventListener: (t, fn) => { (docHandlers.get(t) || docHandlers.set(t, []).get(t)).push(fn); },
  removeEventListener: (t, fn) => { const l = docHandlers.get(t) || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); },
};
const winHandlers = new Map();
globalThis.window = {
  addEventListener: (t, fn) => { (winHandlers.get(t) || winHandlers.set(t, []).get(t)).push(fn); },
  removeEventListener: (t, fn) => { const l = winHandlers.get(t) || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); },
};
globalThis.location = new URL('http://localhost/');

const { supabase } = await import('../js/supabase-client.js');
// Two devices = two separate store module instances (module state is per URL).
const storeA = await import('../js/store.js?device=a');
const storeB = await import('../js/store.js?device=b');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- scripted Supabase server -------------------------------------------------
const UID = '00000000-0000-4000-8000-0000000000e2';
const net = {
  online: true,
  selects: 0,
  tables: { sessions: [], bankroll_transactions: [], user_settings: [] },
  reset() { net.online = true; net.selects = 0; net.tables = { sessions: [], bankroll_transactions: [], user_settings: [] }; },
};

// Each registered channel mirrors one device's realtime subscription.
const channels = [];
function makeChannel(name) {
  const ch = {
    name, bindings: [], stateCb: null, muted: false, delivered: 0,
    on(event, opts, cb) { ch.bindings.push({ event: opts.event, table: opts.table, filter: opts.filter || null, cb }); return ch; },
    subscribe(cb) { ch.stateCb = cb; setTimeout(() => cb('SUBSCRIBED', null), 0); return ch; },
  };
  channels.push(ch);
  return ch;
}

// Server-side delivery: the pa27_owner_filter trigger forces user_id=<sub> on
// every subscription, and replica identity full puts user_id into DELETE old
// rows — so an event leaves the server only when the row's user_id matches a
// binding's filter. A muted channel is a device that cannot receive (offline).
function deliver(table, eventType, row, { evenMuted = false } = {}) {
  const payload = eventType === 'DELETE' ? { old: row } : { new: row };
  for (const ch of channels) {
    if (ch.muted && !evenMuted) continue;
    for (const b of ch.bindings) {
      if (b.event !== eventType || b.table !== table) continue;
      const want = b.filter && b.filter.startsWith('user_id=eq.') ? b.filter.slice('user_id=eq.'.length) : null;
      // Unfiltered bindings receive everything the trigger lets through
      // (the trigger itself is the owner wall); filtered ones must match.
      if (want && row.user_id !== want) continue;
      ch.delivered++;
      b.cb({ table, eventType, ...payload });
    }
  }
}

function applyUpsert(table, rowsArg) {
  if (!net.online) throw new TypeError('Failed to fetch');
  const rows = Array.isArray(rowsArg) ? rowsArg : [rowsArg];
  const t = net.tables[table];
  for (const row of rows) {
    const k = row.id ?? row.user_id;
    const i = t.findIndex(r => (r.id ?? r.user_id) === k);
    const isNew = i < 0;
    if (isNew) t.push(row); else t[i] = row;
    // The flush loop upserts whole batches; deliver rows one by one after the
    // batch lands, like postgres triggers would.
    queueMicrotask(() => deliver(table, isNew ? 'INSERT' : 'UPDATE', { ...row }));
  }
  return { error: null, status: 201 };
}

function makeBuilder(table) {
  const q = {
    select: () => q, eq: () => q, order: () => q,
    range: async () => {
      if (!net.online) throw new TypeError('Failed to fetch');
      net.selects++;
      return { data: net.tables[table].map(r => ({ ...r })), error: null };
    },
    upsert: async rows => applyUpsert(table, rows),
    delete: () => ({
      in: async (_c, ids) => {
        if (!net.online) throw new TypeError('Failed to fetch');
        const t = net.tables[table];
        const removed = t.filter(r => ids.includes(r.id));
        net.tables[table] = t.filter(r => !ids.includes(r.id));
        for (const row of removed) queueMicrotask(() => deliver(table, 'DELETE', { ...row }));
        return { error: null, status: 204 };
      },
    }),
  };
  return q;
}
supabase.from = table => makeBuilder(table);
supabase.channel = name => makeChannel(name);
supabase.removeChannel = async () => {};

// While the account is offline the store's queue retries by design; keep the
// expected retry chatter out of the output without hiding any other error.
const realConsoleError = console.error;
console.error = (...args) => {
  if (!net.online && typeof args[0] === 'string' && args[0].startsWith('sync:')) return;
  realConsoleError(...args);
};

// Reconnect helpers: the window `online` event plus the realtime
// resubscribe (SUBSCRIBED again -> catch-up pull), exactly the two triggers
// js/store.js reacts to.
async function reconnect() {
  net.online = true;
  for (const [t, fns] of winHandlers) if (t === 'online') for (const fn of [...fns]) fn();
  for (const ch of channels) { ch.muted = false; ch.stateCb && ch.stateCb('SUBSCRIBED', null); }
  await sleep(50);
}
const setOffline = (store) => { net.online = false; for (const ch of channels) ch.muted = true; };

// --- fixtures -------------------------------------------------------------------
const H = 3600e3;
const T0 = Date.parse('2026-09-01T19:00:00Z');
const cash = (id, startH, extra = {}) => ({
  id, kind: 'cash', game_id: null, location_id: null, bankroll_id: 'bk-live', group_id: null,
  table_size: 9, start_time: new Date(T0 + startH * H).toISOString(),
  end_time: new Date(T0 + startH * H + 3 * H).toISOString(), duration_seconds: 3 * 3600,
  break_seconds: 0, hands_count: 90, hands_count_estimated: false, is_live: false,
  tracked_via_stack: false, small_blind: 0.1, big_blind: 0.2, buy_in: 20, cashed_out: 35, tips: 0,
  comment: null, opponents: null,
  created_at: new Date(T0).toISOString(), updated_at: new Date().toISOString(), ...extra,
});
const commentOf = (store, id) => store.getState().sessions.find(s => s.id === id).comment;
const idsOf = store => store.getState().sessions.map(s => s.id).sort();

console.log('STEP F — two-device sweep (one account, devices A + B)');

// s1: both devices boot the same fresh account ----------------------------------
net.reset();
channels.length = 0;
await storeA.startSync(UID);
await storeB.startSync(UID);
test('s1: both devices converge on the empty account (no demo rows)', () => {
  assert.equal(storeA.getState().sessions.length, 0);
  assert.equal(storeB.getState().sessions.length, 0);
  assert.ok(storeA.getState().bankrolls.length === 1, 'device A: default bankroll');
  assert.ok(storeB.getState().bankrolls.length === 1, 'device B: default bankroll');
});

// s2: DELETE bindings carry the owner filter (store-change queue #1) -------------
test('s2: every DELETE binding is owner-filtered to the signed-in user', () => {
  const del = channels.flatMap(c => c.bindings.filter(b => b.event === 'DELETE'));
  assert.equal(del.length, 4, `expected 2 DELETE bindings per device, got ${del.length}`);
  for (const b of del) assert.equal(b.filter, `user_id=eq.${UID}`, 'DELETE binding missing user_id filter');
  for (const b of channels.flatMap(c => c.bindings.filter(x => x.event !== 'DELETE'))) {
    assert.equal(b.filter, `user_id=eq.${UID}`, 'INSERT/UPDATE binding missing user_id filter');
  }
});

// s3: create on A -> realtime on B ------------------------------------------------
{
  net.selects = 0;
  const s = cash('sess-A1', 10);
  storeA.mutate(d => { d.sessions.push(s); });
  assert.ok(await storeA.whenSaved(20000));
  await sleep(20); // let the server deliveries land
  test('s3: A\u2019s create reached the cloud', () => assert.equal(net.tables.sessions.length, 1));
  test('s3: B converged via realtime with zero extra pulls', () => {
    assert.deepEqual(idsOf(storeB), ['sess-A1']);
    assert.equal(net.selects, 0, `B pulled (${net.selects} selects) instead of using realtime`);
  });
}

// s4: edit on B -> realtime on A ---------------------------------------------------
{
  net.selects = 0;
  storeB.mutate(d => { d.sessions.find(s => s.id === 'sess-A1').comment = 'edited on B'; });
  assert.ok(await storeB.whenSaved(20000));
  await sleep(20);
  test('s4: B\u2019s edit converged on A via realtime', () => {
    assert.equal(commentOf(storeA, 'sess-A1'), 'edited on B');
    assert.equal(net.selects, 0);
  });
}

// s5: the account goes offline — edits/creations queue on both sides --------
// The stubbed client is shared by both devices, so "offline" models an
// account-wide outage; the per-device asymmetry is covered by the live
// browser sweep on real Supabase.
{
  setOffline();
  storeA.mutate(d => {
    d.sessions.find(s => s.id === 'sess-A1').comment = 'edited offline on A';
    d.sessions.push(cash('sess-A2', 8));
  });
  storeB.mutate(d => { d.sessions.push(cash('sess-B1', 6)); });
  await reconnect();
  assert.ok(await storeA.whenSaved(30000));
  assert.ok(await storeB.whenSaved(20000));
  await sleep(50);

  const expect = ['sess-A1', 'sess-A2', 'sess-B1'];
  test('s5: no data loss — both devices and the cloud hold all three sessions', () => {
    assert.deepEqual(idsOf(storeA), expect, 'device A');
    assert.deepEqual(idsOf(storeB), expect, 'device B');
    assert.deepEqual(net.tables.sessions.map(r => r.id).sort(), expect, 'cloud');
  });
  test('s5: A\u2019s offline edit converged on B', () => {
    assert.equal(commentOf(storeA, 'sess-A1'), 'edited offline on A');
    assert.equal(commentOf(storeB, 'sess-A1'), 'edited offline on A');
  });
}

// s6: last-write-wins per row (documented policy) ----------------------------------
{
  // B's write confirms on the server first.
  storeB.mutate(d => { d.sessions.find(s => s.id === 'sess-A1').comment = 'B wrote first'; });
  assert.ok(await storeB.whenSaved(20000));
  await sleep(20);
  // A's write queues during the outage and flushes after B's — the later
  // confirmed write wins the row.
  setOffline();
  storeA.mutate(d => { d.sessions.find(s => s.id === 'sess-A1').comment = 'A writes last'; });
  await reconnect();
  assert.ok(await storeA.whenSaved(30000));
  assert.ok(await storeB.whenSaved(20000));
  await sleep(50);
  test('s6: the later confirmed write wins the row on every device', () => {
    assert.equal(commentOf(storeA, 'sess-A1'), 'A writes last');
    assert.equal(commentOf(storeB, 'sess-A1'), 'A writes last');
    assert.equal(net.tables.sessions.find(r => r.id === 'sess-A1').comment, 'A writes last');
  });
  test('s6: LWW is per row — no other row was touched', () => {
    const expect = ['sess-A1', 'sess-A2', 'sess-B1'];
    assert.deepEqual(idsOf(storeA), expect);
    assert.deepEqual(idsOf(storeB), expect);
  });
}

// s7: online delete propagates ------------------------------------------------------
{
  storeB.mutate(d => { d.sessions = d.sessions.filter(s => s.id !== 'sess-A2'); });
  assert.ok(await storeB.whenSaved(20000));
  await sleep(50);
  test('s7: B\u2019s delete converged on A via realtime', () => {
    assert.deepEqual(idsOf(storeA), ['sess-A1', 'sess-B1']);
    assert.deepEqual(idsOf(storeB), ['sess-A1', 'sess-B1']);
    assert.equal(net.tables.sessions.length, 2);
  });
}

// s8: a DELETE for a never-seen id is ignored ---------------------------------------
{
  const before = idsOf(storeA).join(',');
  for (const ch of channels) for (const b of ch.bindings) {
    if (b.event === 'DELETE' && b.table === 'sessions' && b.filter === `user_id=eq.${UID}`) {
      b.cb({ table: 'sessions', eventType: 'DELETE', old: { id: '00000000-0000-4000-8000-0000000000e9', user_id: UID } });
    }
  }
  await sleep(20);
  test('s8: hostile/unknown DELETE event left A\u2019s document unchanged', () => {
    assert.equal(idsOf(storeA).join(','), before);
  });
}

storeA.stopSync();
storeB.stopSync();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
