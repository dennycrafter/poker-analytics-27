// BUG HUNT (ISSUES.md #1): importing a file the server rejects destroys the
// account's existing data. Drives the REAL app modules (js/backup.js parseImport
// + js/store.js replaceDoc/whenSaved/flush) against the live Supabase project
// with one disposable account (bh-test+<run>@example.com), exactly like
// Settings > Import JSON does (js/screens/settings.js applyReplacement).
//
// Scenario: account has 3 saved sessions. User imports a file parseImport
// accepts but Postgres rejects: (a) table_size 12 (check 2..10), (b) two
// sessions with the same id (ON CONFLICT cannot affect a row twice). Expected: the import fails as a
// whole and the 3 original sessions survive (or the import is refused up
// front). This test FAILS while the bug exists.
//
// Usage: node tests/bughunt-cloud-import.test.mjs
// Needs SECRET_SUPABASE_ACCESS_TOKEN to delete the disposable account.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (typeof globalThis.WebSocket === 'undefined') {
  const r = spawnSync(process.execPath, ['--experimental-websocket', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: process.env });
  process.exit(r.status ?? 1);
}

// Minimal browser globals js/store.js and js/supabase-client.js touch.
const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k), clear: () => mem.clear(), key: i => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
globalThis.location = new URL('http://localhost/');
globalThis.window = globalThis;

const { supabase } = await import('../js/supabase-client.js');
const store = await import('../js/store.js');
const { parseImport } = await import('../js/backup.js');
const { SUPABASE_URL } = await import('../js/config.js');
const PROJECT_REF = new URL(SUPABASE_URL).hostname.split('.')[0];

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const email = `bh-test+${run}@example.com`;
const password = `pa27-${run}-Xy9!`;
const quiet = console.error; console.error = () => {}; // sync logs the expected rejection

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

async function mgmtQuery(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.SECRET_SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`management API ${res.status}: ${body}`);
  return JSON.parse(body);
}

const H = 3600e3;
const cash = (startMsAgo, extra = {}) => ({
  id: store.genId(), kind: 'cash', game_id: null, location_id: null, bankroll_id: 'b1', group_id: null, table_size: 9,
  start_time: new Date(Date.now() - startMsAgo).toISOString(), end_time: new Date(Date.now() - startMsAgo + 3 * H).toISOString(),
  duration_seconds: 3 * 3600, break_seconds: 0, hands_count: 90, hands_count_estimated: false, is_live: false,
  tracked_via_stack: false, small_blind: 0.1, big_blind: 0.2, buy_in: 20, cashed_out: 35, tips: 0,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...extra,
});

let uid = null;
try {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw new Error(`signUp: ${error.message}`);
  if (!data.session) throw new Error('signUp returned no session');
  uid = data.user.id;
  console.log(`  account ${email} (${uid})`);

  await store.startSync(uid);
  async function seedOriginals() {
    const originals = [cash(10 * 24 * H), cash(9 * 24 * H), cash(8 * 24 * H)];
    store.mutate(d => { d.sessions = originals.map(s => ({ ...s })); });
    const seeded = await store.whenSaved(20000);
    const before = await supabase.from('sessions').select('id');
    return { originals, ok: seeded === true && !before.error && before.data.length === 3 };
  }
  async function importText(text) {
    const parsed = parseImport(text, store.genId);
    if (parsed.ok) {
      store.replaceDoc(parsed.doc);           // settings.js applyReplacement()
      await store.whenSaved(20000);
      await new Promise(r => setTimeout(r, 1500));
    }
    const after = await supabase.from('sessions').select('id');
    return { parsed, cloud: after.data || [], local: store.getState().sessions };
  }

  // ISSUES.md #1: a file Postgres rejects (table_size 12; check is 2..10).
  // Expected: the import fails as a whole and the 3 originals survive.
  {
    const seed = await seedOriginals();
    test('#1 setup: 3 original sessions in the cloud', () => assert.ok(seed.ok));
    const r = await importText(JSON.stringify({ sessions: [cash(2 * 24 * H, { table_size: 12 })] }));
    const survivors = r.cloud.filter(x => seed.originals.some(o => o.id === x.id)).length;
    console.log(`  #1 parseImport ok=${r.parsed.ok}; cloud sessions after: ${r.cloud.length}, originals surviving: ${survivors}; local: ${r.local.length}`);
    test('#1 rejected import must not delete the 3 existing cloud sessions', () =>
      assert.equal(survivors, 3, `only ${survivors}/3 original sessions remain in the cloud`));
    test('#1 rejected import must not leave the local document empty', () =>
      assert.ok(r.local.length >= 3, `local doc has ${r.local.length} sessions`));
  }

  // ISSUES.md #3: a file with two sessions sharing one id. Expected: refused
  // up front, or device and cloud agree afterwards. Actual: device keeps 2,
  // cloud stores 1 (sync keys entities by id), so stats differ per device.
  {
    const seed = await seedOriginals();
    test('#3 setup: 3 original sessions in the cloud', () => assert.ok(seed.ok));
    const s = cash(2 * 24 * H);
    const r = await importText(JSON.stringify({ sessions: [s, { ...s, cashed_out: 99 }] }));
    console.log(`  #3 parseImport ok=${r.parsed.ok}; cloud sessions after: ${r.cloud.length}; local: ${r.local.length}`);
    test('#3 duplicate-id import is refused, or device and cloud hold the same session count', () =>
      assert.ok(!r.parsed.ok || r.local.length === r.cloud.length,
        `device has ${r.local.length} sessions, cloud has ${r.cloud.length}`));
  }
} catch (e) {
  fail++; console.log('  FAIL harness error\n       ' + (e && e.stack || e));
} finally {
  store.stopSync();
  await supabase.auth.signOut().catch(() => {});
  if (uid && process.env.SECRET_SUPABASE_ACCESS_TOKEN) {
    try {
      await mgmtQuery(`delete from auth.users where id = '${uid}'`);
      const [left] = await mgmtQuery(`select
        (select count(*) from auth.users where id = '${uid}' or email = '${email}') users,
        (select count(*) from public.sessions where user_id = '${uid}') sessions,
        (select count(*) from public.bankroll_transactions where user_id = '${uid}') txns,
        (select count(*) from public.user_settings where user_id = '${uid}') settings`);
      console.log(`  cleanup: remaining rows for ${email}: ${JSON.stringify(left)}`);
      if (Object.values(left).some(v => Number(v) !== 0)) { fail++; console.log('  FAIL cleanup left rows'); }
    } catch (e) { fail++; console.log('  FAIL cleanup ' + e.message); }
  } else if (uid) console.log(`  WARN delete ${email} manually`);
}
console.error = quiet;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
