// Iteration 1.4 verification: smart-import batch bookkeeping in the store.
//
// stageImport / commitImport / undoImport / importBatches / findDuplicates must:
//   - stage rows purely (nothing written to the doc, the cache or the cloud),
//   - flag duplicates (same local day + same kind + profit within $1 of an
//     existing session), boundary inclusive, flagging without dropping,
//   - commit ONLY accepted rows through the SAME write path as every other
//     import (refs resolved, offline queue, realtime sync, fingerprint and
//     import_key dedupe, db guards), stamping importBatch (uuid) + importSource,
//   - undo exactly one batch (own rows only), also after an offline commit has
//     been flushed, and re-open the import_key registry for PokerNow re-import,
//   - keep batch tags device-local (no cloud columns: cloud rows never carry
//     them) while surviving reloads from the local cache and own echoes.
//
// Drives the REAL js/store.js against a scripted in-memory Supabase — no
// network. Usage: TZ=UTC node tests/it1-batches.test.mjs

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
const { supabase } = await import('../js/supabase-client.js');
const { importPokerNow } = await import('../js/pokernow-import.js');
const { join, dirname } = await import('node:path');

// --- scripted Supabase (same harness as stepd/stepe) --------------------------
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

function applyUpsert(table, rowsArg) {
  if (!net.online) throw new TypeError('Failed to fetch');
  const rows = Array.isArray(rowsArg) ? rowsArg : [rowsArg];
  net.upserts.push({ table, rows });
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

// Realtime callbacks are captured so tests can deliver server events.
const pgHandlers = {};
supabase.from = table => makeBuilder(table);
supabase.channel = () => {
  const ch = {
    on(_type, cfg, cb) { pgHandlers[cfg.event] = cb; return ch; },
    subscribe() { return ch; },
  };
  return ch;
};
supabase.removeChannel = async () => {};

// --- fixtures -------------------------------------------------------------------
// Raw session-shaped rows (the smart importer's parse output), not drafts.
const DAY1 = Date.UTC(2026, 8, 12, 20, 0, 0); // 2026-09-12 20:00 UTC
const cashRow = (over = {}, i = 0) => ({
  kind: 'cash',
  start_time: new Date(DAY1).toISOString(),
  end_time: new Date(DAY1 + 4 * 3600e3).toISOString(),
  duration_seconds: 4 * 3600, break_seconds: 0, table_size: 9,
  hands_count: 120, hands_count_estimated: false,
  comment: null, opponents: null, is_live: false, tracked_via_stack: false, paused_at: null,
  small_blind: 5, big_blind: 10, buy_in: 500, cashed_out: 900, tips: 0,
  game_name: "NL Hold'em", location_name: 'Bellagio',
  line: i + 2,
  ...over,
});
const tournRow = (over = {}, i = 0) => ({
  kind: 'tournament',
  start_time: new Date(DAY1 + 3600e3).toISOString(),
  end_time: new Date(DAY1 + 3 * 3600e3).toISOString(),
  duration_seconds: 2 * 3600, break_seconds: 0, table_size: 9,
  hands_count: null, hands_count_estimated: false,
  comment: null, opponents: null, is_live: false, tracked_via_stack: false, paused_at: null,
  tournament_name: 'Nightly', initial_buy_in: 500, total_buy_in: 500, prize: 900,
  position: null, entries: 120, tips: 0,
  location_name: 'Bellagio',
  line: i + 2,
  ...over,
});

// One existing session in the account, profit 400 on DAY1 (2026-09-12).
function seedExisting(over = {}) {
  store.mutate(d => {
    d.sessions.push({
      id: store.genId(), kind: 'cash', game_id: null, location_id: null,
      bankroll_id: d.bankrolls[0].id, group_id: null, table_size: 9,
      start_time: new Date(DAY1 - 3600e3).toISOString(),
      end_time: new Date(DAY1 + 3 * 3600e3).toISOString(),
      duration_seconds: 4 * 3600, break_seconds: 0, hands_count: 120, hands_count_estimated: false,
      comment: null, opponents: null, is_live: false, tracked_via_stack: false, paused_at: null,
      small_blind: 5, big_blind: 10, buy_in: 500, cashed_out: 900, tips: 0,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      ...over,
    });
  });
  return store.getState().sessions[0].id;
}

const PN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pokernow');
const pnFile = rel => ({ name: rel.split('/').pop(), text: readFileSync(join(PN_DIR, rel), 'utf8') });
// Live fixture: the one that carries stack events (closed sessions keep their
// money in buy_in/cashed_out with no events).
const pnLiveDrafts = () => importPokerNow(
  [pnFile('live/ledger_pglPa27Home01.csv'), pnFile('live/poker_now_log_pglPa27Home01.csv')],
  { me: 'Denis' });

async function signIn() {
  await store.startSync(UID);
  const until = Date.now() + 5000;
  while (!['saved', 'offline'].includes(store.getSyncStatus().state) && Date.now() < until) {
    await new Promise(r => setTimeout(r, 10));
  }
  assert.equal(await store.whenSaved(5000), true, 'sign-in sync failed');
}

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

await test('stage is pure: prepares drafts, flags nothing written to doc or cloud, batch ids are uuids', async () => {
  const d0 = store.getState();
  const rows = [cashRow(), tournRow(), null, { kind: 'cash' }];
  const { batchId, prepared, duplicates } = store.stageImport(d0, rows);
  assert.match(batchId, /^[0-9a-f-]{36}$/i, 'batchId is a uuid');
  assert.equal(prepared.length, 4);
  assert.equal(duplicates.length, 0);
  for (const p of prepared.slice(0, 2)) {
    assert.equal(p.error, null, 'valid rows carry no error');
    assert.equal(p.duplicate, false);
    assert.equal(p.duplicateOf, null);
    assert.equal(p.batchId, batchId);
    assert.equal(p.import_source, 'unknown', 'source defaults to unknown');
    assert.ok(p.session && p.refs, 'rows are normalized to importSessions drafts');
  }
  assert.match(prepared[2].error, /not a readable session/i);
  assert.match(prepared[3].error, /not a readable session/i);
  // An import_source on the row is kept, not overwritten.
  const tagged = store.stageImport(store.getState(), [cashRow({ import_source: 'bankrollcoach' })]);
  assert.equal(tagged.prepared[0].import_source, 'bankrollcoach');
  // Nothing was written anywhere.
  assert.equal(store.getState().sessions.length, 0, 'no sessions in the doc');
  assert.equal(store.getState().locations.length, 0, 'no master data created');
  assert.equal(net.upserts.filter(u => u.table === 'sessions').length, 0, 'no session upserts');
  // Staging is stateless: a second stage gets its own batch id.
  const again = store.stageImport(store.getState(), rows);
  assert.notEqual(again.batchId, batchId);
  // Non-array input is tolerated.
  assert.deepEqual(store.stageImport(store.getState(), null).prepared, []);
  assert.deepEqual(store.findDuplicates(store.getState(), null), []);
});

await test('duplicate rule: same local day + same kind + profit within $1; boundary inclusive at exactly $1', async () => {
  const existingId = seedExisting(); // profit 400 on 2026-09-12
  const rows = [
    cashRow({ cashed_out: 900.5 }, 0),                                        // +0.50 -> duplicate
    cashRow({ cashed_out: 901 }, 1),                                          // +1.00 -> duplicate (boundary)
    cashRow({ cashed_out: 901.01 }, 2),                                       // +1.01 -> not a duplicate
    cashRow({ start_time: new Date(DAY1 + 24 * 3600e3).toISOString(),
      end_time: new Date(DAY1 + 28 * 3600e3).toISOString() }, 3),             // next day -> not a duplicate
    tournRow({}, 4),                                                          // tournament profit 400 -> not a duplicate
  ];
  const doc = store.getState();
  const { duplicates, prepared } = store.stageImport(doc, rows);
  assert.equal(duplicates.length, 2, 'exactly two rows flagged');
  const flagged = prepared.filter(p => p.duplicate);
  assert.equal(flagged[0].duplicateOf, existingId, 'duplicate points at the existing session');
  assert.equal(flagged[1].duplicateOf, existingId);
  assert.equal(flagged[0].line, 2, 'input order preserved');
  for (const p of prepared.filter(p => !p.duplicate)) assert.equal(p.duplicateOf, null);
  // findDuplicates standalone: the same two rows, same objects, input order.
  const dups = store.findDuplicates(doc, rows);
  assert.equal(dups.length, 2);
  assert.equal(dups[0], rows[0]);
  assert.equal(dups[1], rows[1]);
});

await test('commit persists only accepted rows through the import path: refs resolved, tags stamped, cloud synced', async () => {
  const doc = store.getState();
  const rows = [cashRow(), cashRow({ start_time: new Date(DAY1 + 3600e3).toISOString(),
    end_time: new Date(DAY1 + 5 * 3600e3).toISOString() }, 1), tournRow()];
  const { batchId, prepared } = store.stageImport(doc, rows.slice(0, 2));
  const accepted = [prepared[0], { ...prepared[1], import_source: 'ai-csv' }];
  const res = store.commitImport(store.getState(), batchId, accepted);
  assert.equal(res.imported.length, 2, 'both accepted rows imported');
  assert.equal(res.skipped.length, 0);
  assert.equal(store.getState().sessions.length, 2, 'nothing else written');
  for (const s of store.getState().sessions) {
    assert.equal(s.import_batch, batchId, 'import_batch stamped');
    assert.ok(['unknown', 'ai-csv'].includes(s.import_source), 'import_source stamped');
  }
  assert.equal(store.getState().sessions[1].import_source, 'ai-csv');
  // Same write path: refs resolved to master data by name.
  const d = store.getState();
  assert.equal(d.games.filter(g => g.name === "NL Hold'em").length, 1, 'game resolved');
  assert.equal(d.locations.filter(l => l.name === 'Bellagio').length, 1, 'location created once');
  for (const s of d.sessions) {
    assert.equal(s.game_id, d.games.find(g => g.name === "NL Hold'em").id);
    assert.equal(s.location_id, d.locations[0].id);
    assert.ok(d.bankrolls.find(b => b.id === s.bankroll_id), 'bankroll resolved');
  }
  assert.equal(await store.whenSaved(5000), true, 'synced');
  assert.equal(net.tables.sessions.length, 2, 'cloud holds both rows');
  for (const row of net.tables.sessions) {
    assert.equal('import_batch' in row, false, 'batch tags are device-local: no cloud column');
    assert.equal('import_source' in row, false, 'source tag is device-local: no cloud column');
  }
  assert.deepEqual(store.importBatches(d), [{
    batchId, source: 'unknown', count: 2, createdAt: d.sessions[0].created_at,
  }], 'history derives one batch from the sessions');
  // Re-accepting a row that is already in the account: honest skip, no dup row.
  const res2 = store.commitImport(store.getState(), batchId, accepted.slice(0, 1));
  assert.equal(res2.imported.length, 0);
  assert.equal(res2.skipped.length, 1);
  assert.match(res2.skipped[0].reason, /already have/i);
  assert.equal(store.getState().sessions.length, 2);
  // A bad batchId is a programming error, not a silent no-op.
  assert.throws(() => store.commitImport(store.getState(), 'not-a-uuid', []), TypeError);
  // Empty acceptance writes nothing.
  const empty = store.commitImport(store.getState(), batchId, []);
  assert.equal(empty.imported.length, 0);
  assert.equal(empty.skipped.length, 0);
  assert.equal(store.getState().sessions.length, 2);
});

await test('commit surfaces db-guard rejections per row and still imports the valid ones', async () => {
  const doc = store.getState();
  const { batchId, prepared } = store.stageImport(doc, [
    cashRow({ table_size: 12 }, 0),
    cashRow({}, 1),
  ]);
  assert.match(prepared[0].error, /table size/i, 'the preview already knows the row is bad');
  const res = store.commitImport(store.getState(), batchId, prepared); // even if accepted wholesale
  assert.equal(res.imported.length, 1);
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].reason, /table size/i);
  assert.equal(store.getState().sessions.length, 1);
});

await test('undo deletes exactly that batch: other batches and manual sessions survive, repeats are no-ops', async () => {
  const doc = store.getState();
  const a = store.stageImport(doc, [cashRow(), cashRow({ start_time: new Date(DAY1 + 3600e3).toISOString(),
    end_time: new Date(DAY1 + 5 * 3600e3).toISOString() }, 1)]);
  const ra = store.commitImport(store.getState(), a.batchId, a.prepared);
  assert.equal(ra.imported.length, 2);
  const b = store.stageImport(store.getState(), [tournRow()]);
  const rb = store.commitImport(store.getState(), b.batchId, b.prepared);
  assert.equal(rb.imported.length, 1);
  store.mutate(d => {
    d.sessions.push({
      id: store.genId(), kind: 'cash', game_id: null, location_id: null, bankroll_id: d.bankrolls[0].id,
      group_id: null, table_size: 9, start_time: new Date(DAY1 - 48 * 3600e3).toISOString(),
      end_time: new Date(DAY1 - 44 * 3600e3).toISOString(), duration_seconds: 4 * 3600,
      break_seconds: 0, hands_count: 90, hands_count_estimated: false, comment: null, opponents: null,
      is_live: false, tracked_via_stack: false, paused_at: null, small_blind: 1, big_blind: 2,
      buy_in: 100, cashed_out: 160, tips: 0,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
  });
  // History shows both batches with their own counts.
  const batches = store.importBatches(store.getState());
  assert.equal(batches.length, 2);
  const byId = new Map(batches.map(x => [x.batchId, x]));
  assert.equal(byId.get(a.batchId).count, 2);
  assert.equal(byId.get(b.batchId).count, 1);

  const undo = store.undoImport(store.getState(), a.batchId);
  assert.equal(undo.deleted, 2, 'only batch A deleted');
  assert.equal(store.getState().sessions.length, 2, 'batch B row + the manual session remain');
  assert.ok(store.getState().sessions.some(s => s.import_batch === b.batchId), 'batch B survives');
  assert.ok(store.getState().sessions.every(s => !s.import_batch || s.import_batch !== a.batchId), 'no A rows left');
  assert.equal(await store.whenSaved(5000), true);
  assert.equal(net.tables.sessions.length, 2, 'cloud dropped exactly the A rows');
  assert.equal(store.importBatches(store.getState()).length, 1);
  // Repeats and unknown ids are honest no-ops.
  assert.deepEqual(store.undoImport(store.getState(), a.batchId), { deleted: 0, ids: [] });
  assert.deepEqual(store.undoImport(store.getState(), store.genId()), { deleted: 0, ids: [] });
  assert.equal(store.getState().sessions.length, 2);
  assert.throws(() => store.undoImport(store.getState(), 'garbage'), TypeError);
  // Undo the second batch too; the manual session must still stand.
  assert.equal(store.undoImport(store.getState(), b.batchId).deleted, 1);
  assert.equal(store.getState().sessions.length, 1);
  assert.equal(store.getState().sessions[0].import_batch, undefined);
  assert.deepEqual(store.importBatches(store.getState()), []);
  assert.equal(await store.whenSaved(5000), true);
  assert.equal(net.tables.sessions.length, 1, 'cloud keeps only the manual session');
});

await test('queued-offline commit flushes on reconnect with batch fields intact; undo then clears the cloud too', async () => {
  const doc = store.getState();
  const { batchId, prepared } = store.stageImport(doc, [cashRow(), tournRow({ import_source: 'ai-text' })]);
  net.online = false;
  const res = store.commitImport(store.getState(), batchId, prepared);
  assert.equal(res.imported.length, 2);
  assert.equal(store.getState().sessions.length, 2, 'queued locally');
  assert.equal(net.tables.sessions.length, 0, 'cloud untouched while offline');
  await new Promise(r => setTimeout(r, 50)); // let the failing flush land
  assert.equal(store.getSyncStatus().state, 'offline');
  // Reconnect: the queue flushes and the batch tags survive the flush.
  net.online = true;
  assert.equal(typeof winHandlers.get('online'), 'function', 'store listens for the window "online" event');
  winHandlers.get('online')();
  assert.equal(await store.whenSaved(5000), true, 'flushed after reconnect');
  assert.equal(net.tables.sessions.length, 2);
  for (const s of store.getState().sessions) assert.equal(s.import_batch, batchId, 'batch tag survives the flush');
  assert.equal(store.importBatches(store.getState())[0].count, 2);
  // Undo after the flush: local and cloud both end up clean.
  const undo = store.undoImport(store.getState(), batchId);
  assert.equal(undo.deleted, 2);
  assert.equal(await store.whenSaved(5000), true);
  assert.equal(net.tables.sessions.length, 0, 'cloud rows deleted');
  assert.equal(store.getState().sessions.length, 0);
  assert.deepEqual(store.importBatches(store.getState()), []);
});

await test('batch tags ride the per-user cache: they survive a reload on the importing device', async () => {
  const doc = store.getState();
  const { batchId, prepared } = store.stageImport(doc, [cashRow()]);
  store.commitImport(store.getState(), batchId, prepared);
  assert.equal(await store.whenSaved(5000), true);
  store.stopSync();
  await store.startSync(UID);
  const until = Date.now() + 5000;
  while (!['saved', 'offline'].includes(store.getSyncStatus().state) && Date.now() < until) {
    await new Promise(r => setTimeout(r, 10));
  }
  const s = store.getState().sessions[0];
  assert.equal(s.import_batch, batchId, 'import_batch restored from cache');
  assert.equal(s.import_source, 'unknown');
  assert.equal(store.importBatches(store.getState())[0].batchId, batchId);
});

await test('own-echo UPDATE for an unchanged server row does not wipe batch tags', async () => {
  const doc = store.getState();
  const { batchId, prepared } = store.stageImport(doc, [cashRow()]);
  store.commitImport(store.getState(), batchId, prepared);
  assert.equal(await store.whenSaved(5000), true);
  const row = { ...net.tables.sessions[0] };
  pgHandlers.UPDATE({ table: 'sessions', eventType: 'UPDATE', new: row });
  const s = store.getState().sessions[0];
  assert.equal(store.getState().sessions.length, 1, 'no duplicate applied');
  assert.equal(s.import_batch, batchId, 'tags intact after the echo');
});

await test('PokerNow drafts through the batch path: stack events, import_key registry, undo frees the registry', async () => {
  // pnLive: the live fixture is what carries stack events (closed sessions
  // keep their money in buy_in/cashed_out with no events).
  const parsed = pnLiveDrafts();
  assert.equal(parsed.status, 'ok');
  const doc = store.getState();
  const { batchId, prepared } = store.stageImport(doc, parsed.sessions);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].error, null, 'PokerNow drafts stage cleanly');
  const res = store.commitImport(store.getState(), batchId,
    [{ ...prepared[0], import_source: 'pokernow' }]);
  assert.equal(res.imported.length, 1);
  const d = store.getState();
  const s = d.sessions[0];
  assert.equal(s.import_batch, batchId, 'batch tag on a stack-tracked import too');
  assert.equal(s.import_source, 'pokernow');
  assert.equal(s.is_live, true);
  assert.ok(d.stack_events.filter(e => e.session_id === s.id).length >= 1, 'stack events written');
  assert.equal(d.import_keys[parsed.sessions[0].source.import_key], s.id, 'import_key registered');
  assert.equal(await store.whenSaved(5000), true);
  const cloudRow = net.tables.sessions.find(r => r.id === s.id);
  assert.ok(cloudRow.stack_events.length >= 1, 'stack events synced with the session');
  // Undo: session, events and registry entry all go; the same file can be
  // imported again afterwards.
  assert.equal(store.undoImport(store.getState(), batchId).deleted, 1);
  assert.equal(store.getState().stack_events.length, 0, 'stack events deleted with the session');
  assert.equal(await store.whenSaved(5000), true);
  assert.equal(net.tables.sessions.length, 0);
  const again = store.stageImport(store.getState(), pnLiveDrafts().sessions);
  const res2 = store.commitImport(store.getState(), again.batchId, again.prepared);
  assert.equal(res2.imported.length, 1, 're-import after undo works (registry pruned)');
  assert.equal(await store.whenSaved(5000), true);
  assert.equal(net.tables.sessions.length, 1);
});

// --- summary -----------------------------------------------------------------
console.log(`\n${pass.length} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
