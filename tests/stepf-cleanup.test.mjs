// STEP F verification harness (cleanup for real use):
//   (a) empty-start guard: a brand-new account gets basic configuration and
//       ZERO demo rows — no sessions, transactions, notes or hand histories;
//       nothing in the app shell seeds the demo dataset on its own;
//   (b) the demo dataset is reachable ONLY through the explicit Settings
//       loader (demoDoc), which still builds and syncs the full seed;
//   (c) table players: players met at the table are derived from the user's
//       own sessions (Opponents field) and merged with player notes;
//   (d) scope pins: sw.js VERSION bumped for STEP F, DELETE realtime
//       bindings carry the owner filter (store-change queue #1).
//
// Usage: node tests/stepf-cleanup.test.mjs  (no network)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// js/supabase-client.js builds the vendored client at import; Node 20 needs
// the WebSocket flag for that (same re-exec as the stepd/cloud harnesses).
if (typeof globalThis.WebSocket === 'undefined') {
  const r = spawnSync(process.execPath, ['--experimental-websocket', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: process.env });
  process.exit(r.status ?? 1);
}

// --- browser stubs (js/store.js touches them at import; stepd pattern) ------
const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k), clear: () => mem.clear(),
};
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.location = new URL('http://localhost/');

const manage = await import('../js/manage.js');
const backup = await import('../js/backup.js');
const store = await import('../js/store.js');
const { supabase } = await import('../js/supabase-client.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');

// --- scripted Supabase: empty account, records what the store flushes -------
const net = {
  tables: { sessions: [], bankroll_transactions: [], user_settings: [] },
  reset() { net.tables = { sessions: [], bankroll_transactions: [], user_settings: [] }; },
};
function applyUpsert(table, rowsArg) {
  const rows = Array.isArray(rowsArg) ? rowsArg : [rowsArg];
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
    range: async () => ({ data: net.tables[table].map(r => ({ ...r })), error: null }),
    upsert: async rows => applyUpsert(table, rows),
    delete: () => ({ in: async (_c, ids) => {
      net.tables[table] = net.tables[table].filter(r => !ids.includes(r.id));
      return { error: null, status: 204 };
    } }),
  };
  return q;
}
supabase.from = table => makeBuilder(table);
supabase.channel = () => ({ on() { return this; }, subscribe() { return this; } });
supabase.removeChannel = async () => {};

// --- fixtures ----------------------------------------------------------------
const H = 3600e3;
const T0 = Date.parse('2026-09-01T19:00:00Z');
const cash = (id, startH, extra = {}) => ({
  id, kind: 'cash', game_id: 'g-nlh', location_id: null, bankroll_id: 'bk-live', group_id: null,
  table_size: 9, start_time: new Date(T0 + startH * H).toISOString(),
  end_time: new Date(T0 + startH * H + 3 * H).toISOString(), duration_seconds: 3 * 3600,
  break_seconds: 0, hands_count: 90, hands_count_estimated: false, is_live: false,
  tracked_via_stack: false, small_blind: 0.1, big_blind: 0.2, buy_in: 20, cashed_out: 35, tips: 0,
  comment: null, opponents: null, created_at: new Date(T0).toISOString(), updated_at: new Date(T0).toISOString(),
  ...extra,
});

console.log('STEP F — cleanup for real use');

// (a) empty-start guard --------------------------------------------------------
{
  net.reset();
  const uid = '00000000-0000-4000-8000-0000000000f1';
  await store.startSync(uid);
  const d = store.getState();
  test('fresh account: zero sessions after the first cloud reconcile', () => {
    assert.equal(d.sessions.length, 0, `sessions: ${d.sessions.length}`);
  });
  test('fresh account: zero demo rows anywhere (txns, notes, hands, sells, events)', () => {
    assert.equal(d.transactions.length, 0);
    assert.equal(d.player_notes.length, 0);
    assert.equal(d.hand_histories.length, 0);
    assert.equal(d.stack_events.length, 0);
    assert.equal(d.sell_actions.length, 0);
  });
  test('fresh account: basic configuration seeded (bankroll, games, tournament types, EUR)', () => {
    assert.ok(d.bankrolls.length === 1 && d.bankrolls[0].is_default, 'one default bankroll');
    assert.ok(d.games.some(g => g.name === "NL Hold'em"), 'NLH game');
    assert.ok(d.tournament_types.some(t => t.name === 'MTT'), 'MTT type');
    assert.equal(d.settings.currency, 'EUR');
  });
  test('fresh account: the basic configuration is the only thing synced up', () => {
    assert.equal(net.tables.sessions.length, 0, 'no session rows pushed');
    assert.equal(net.tables.user_settings.length, 1, 'exactly the settings row');
    assert.equal(net.tables.user_settings[0].player_notes.length, 0, 'settings carry no notes');
    assert.equal(net.tables.user_settings[0].hand_histories.length, 0, 'settings carry no hand histories');
  });
  test('app shell never seeds the demo dataset on its own', () => {
    for (const f of ['js/main.js', 'js/store.js', 'js/screens/auth.js']) {
      const src = read('../' + f);
      assert.ok(!/buildSeed|demoDoc/.test(src), `${f} references the demo seed`);
    }
  });
  store.stopSync();
}

// (b) demo loader strictly on demand ------------------------------------------
{
  test('demoDoc still builds the full demo dataset when explicitly asked', () => {
    const doc = backup.demoDoc(Date.now(), store.genId);
    assert.equal(doc.sessions.length, 40, `demo sessions: ${doc.sessions.length}`);
    assert.ok(doc.player_notes.length >= 3, 'demo notes present');
    assert.ok(doc.transactions.length >= 3, 'demo transactions present');
  });
  test('Settings labels the demo loader as a load, not a silent reset', () => {
    const src = read('../js/screens/settings.js');
    const hasLoad = /Load demo data/.test(src);
    const resetGone = !/Reset demo data/.test(src);
    assert.ok(hasLoad && resetGone, `hasLoad=${hasLoad} resetGone=${resetGone}`);
  });
}

// (c) table players derivation -------------------------------------------------
{
  const doc = {
    sessions: [
      cash('s1', 10, { opponents: 'Paddy O\u2019Shea, Eoin K.' }),
      cash('s2', 8, { opponents: 'eoin k.; Sandra M' }),
      cash('s3', 5, { opponents: 'Sandra M\nBig Al' }),
      cash('s4', 2, { opponents: null }),
    ],
    player_notes: [
      { id: 'n1', session_id: 's1', player_name: 'Eoin K.', note: 'Tight.', created_at: new Date(T0 + 20 * H).toISOString(), updated_at: new Date(T0 + 20 * H).toISOString() },
      { id: 'n2', session_id: null, player_name: 'Dee', note: 'Home regular.', created_at: new Date(T0 + 30 * H).toISOString(), updated_at: new Date(T0 + 30 * H).toISOString() },
    ],
  };

  test('opponentsNames splits on comma, semicolon and newline, and trims', () => {
    assert.deepEqual(manage.opponentsNames('A, B; C\nD'), ['A', 'B', 'C', 'D']);
    assert.deepEqual(manage.opponentsNames('  Solo  '), ['Solo']);
    assert.deepEqual(manage.opponentsNames(null), []);
    assert.deepEqual(manage.opponentsNames(' , ; \n '), []);
  });

  const dirOf = () => manage.playersDirectory(doc);
  test('playersDirectory merges table opponents with note players (case-insensitive)', () => {
    const names = dirOf().map(p => p.name).sort();
    assert.deepEqual(names, ['Big Al', 'Dee', 'Eoin K.', 'Paddy O\u2019Shea', 'Sandra M']);
  });
  test('a note spelling wins over the Opponents spelling', () => {
    const eoin = dirOf().find(p => p.name.toLowerCase() === 'eoin k.');
    assert.equal(eoin.name, 'Eoin K.');
  });
  test('session counts and last-seen derive from the user\u2019s own sessions', () => {
    const eoin = dirOf().find(p => p.name.toLowerCase() === 'eoin k.');
    assert.equal(eoin.sessionCount, 2, 'Eoin in s1 and s2');
    const sandra = dirOf().find(p => p.name.toLowerCase() === 'sandra m');
    assert.equal(sandra.sessionCount, 2, 'Sandra in s2 and s3');
    assert.equal(sandra.notes.length, 0, 'no notes for Sandra');
  });
  test('notes-only players appear with sessionCount 0', () => {
    const dee = dirOf().find(p => p.name.toLowerCase() === 'dee');
    assert.equal(dee.sessionCount, 0);
    assert.equal(dee.notes.length, 1);
  });
  test('directory is sorted by most recent activity, then name', () => {
    const dee = dirOf().find(p => p.name.toLowerCase() === 'dee');
    assert.equal(dirOf()[0].name.toLowerCase(), dee.name.toLowerCase(), 'most recent note first');
  });
  test('privacy: the derivation reads only the document handed to it', () => {
    const empty = manage.playersDirectory({ sessions: [], player_notes: [] });
    assert.equal(empty.length, 0);
  });
  test('sessionsForPlayer lists only sessions naming that player, newest first', () => {
    const ids = manage.sessionsForPlayer(doc, 'sandra m').map(s => s.id);
    assert.deepEqual(ids, ['s2', 's3'], 's2 (start +8h) is newer than s3 (+5h)');
    assert.deepEqual(manage.sessionsForPlayer(doc, 'nobody').map(s => s.id), []);
  });
  test('Players screen renders table players with session counts (source-level)', () => {
    const src = read('../js/screens/players.js');
    assert.match(src, /playersDirectory/, 'screen must use the merged directory');
    assert.match(src, /sessionsForPlayer/, 'detail must list sessions together');
    assert.match(src, /sessionRowHtml/, 'detail reuses the feed session row');
  });
}

// (d) scope pins ---------------------------------------------------------------
test('sw.js VERSION is the STEP F build', () => {
  const swSrc = read('../sw.js');
  const ver = /const VERSION = 'pa27-2026-10-10-stepf-1';/.test(swSrc);
  const precache = /'js\/screens\/variance\.js'/.test(swSrc);
  assert.ok(ver && precache, `VERSION bumped=${ver} precache retained=${precache}`);
});
test('store.js DELETE realtime bindings carry the owner filter (queue #1)', () => {
  const src = read('../js/store.js');
  const ok = /event: 'DELETE', schema: 'public', table, filter/.test(src);
  assert.ok(ok, 'DELETE bindings must pass the user_id filter');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
