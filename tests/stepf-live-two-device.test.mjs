// STEP F — LIVE two-device sweep (real Supabase project, ONE account, two
// sessions). The offline sweep (stepf-two-device-sync.test.mjs) proves the
// store's queue/LWW mechanics against a scripted server; this suite proves
// the same contract against the real cloud:
//
//   l1  two devices sign into one account and boot empty (no demo rows);
//   l2  a create on device A reaches device B via realtime within seconds;
//   l3  an edit on device B reaches device A via realtime within seconds;
//   l4  device A goes dark (unsubscribed), an edit is buffered locally and
//       device B writes meanwhile; on reconnect A's catch-up pull + flush
//       converge BOTH devices with no data loss and the later confirmed
//       write wins the row (documented last-write-wins policy);
//   l5  a delete on B reaches A via realtime within seconds;
//   l6  both devices and the cloud hold the same final rows.
//
// Usage: node tests/stepf-live-two-device.test.mjs  (needs network; the
// se2-test account is deleted afterwards via the management API, which
// cascades to every app row — final assertion: 0 users / 0 rows).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Node 20 only exposes WebSocket behind a flag; re-exec with it when missing.
if (typeof globalThis.WebSocket === 'undefined') {
  const r = spawnSync(process.execPath, ['--experimental-websocket', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: process.env });
  process.exit(r.status ?? 1);
}

const { createClient } = await import('../js/vendor/supabase.js');
const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = await import('../js/config.js');
const PROJECT_REF = new URL(SUPABASE_URL).hostname.split('.')[0];
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const email = `se2-test+${run}@example.com`;
const password = `pa27-${run}-Xy9!`;
const SYNC_WINDOW_MS = 5000; // "converge within seconds"

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

function newClient() {
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function mgmtQuery(sql) {
  const token = process.env.SECRET_SUPABASE_ACCESS_TOKEN;
  if (!token) throw new Error('SECRET_SUPABASE_ACCESS_TOKEN not set');
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`management API ${res.status}: ${body}`);
  return JSON.parse(body);
}

// The store's exact binding shape (subscribeRealtime): per table, owner
// filter, INSERT/UPDATE/DELETE — DELETE only on the two row tables.
function bindStoreLike(c, uid, sink) {
  const filter = `user_id=eq.${uid}`;
  let ch = c.channel(`pa27:${uid}`);
  for (const table of ['sessions', 'bankroll_transactions']) {
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      ch = ch.on('postgres_changes', { event, schema: 'public', table, filter }, p => sink(p));
    }
  }
  for (const event of ['INSERT', 'UPDATE']) {
    ch = ch.on('postgres_changes', { event, schema: 'public', table: 'user_settings', filter }, p => sink(p));
  }
  return ch;
}

function subscribe(c, uid, label, sink) {
  return new Promise((resolve, reject) => {
    const ch = bindStoreLike(c, uid, sink);
    const t = setTimeout(() => reject(new Error(`${label}: subscribe timed out`)), 15000);
    ch.subscribe((state, err) => {
      if (state === 'SUBSCRIBED') { clearTimeout(t); resolve(ch); }
      else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT') { clearTimeout(t); reject(err || new Error(`${label}: ${state}`)); }
    });
  });
}

const cashRow = comment => ({
  kind: 'cash', start_time: new Date(Date.now() - 3600e3).toISOString(), end_time: new Date().toISOString(),
  small_blind: 0.1, big_blind: 0.2, buy_in: 20, cashed_out: 35, comment,
});
const one = async (q, what) => { const { data, error } = await q; if (error) throw new Error(`${what}: ${error.message}`); return data; };

const uids = [];
try {
  // Device A signs the account up; device B signs in with the same
  // credentials — two independent sessions, one uid, exactly the brief's
  // "two authenticated browser contexts sharing one account".
  const A = newClient();
  const { data: su, error: suErr } = await A.auth.signUp({ email, password });
  if (suErr || !su.session) throw new Error(`signUp: ${(suErr || 'no session').message || suErr}`);
  const uid = su.user.id; uids.push(uid);
  const B = newClient();
  const { error: siErr } = await B.auth.signInWithPassword({ email, password });
  if (siErr) throw new Error(`device B sign-in: ${siErr.message}`);
  console.log(`  account: ${email} uid=${uid}`);

  const events = { A: [], B: [] };
  const sink = label => p => events[label].push({ at: Date.now(), ...p });
  let chA = await subscribe(A, uid, 'A', sink('A'));
  const chB = await subscribe(B, uid, 'B', sink('B'));

  // l1: fresh account boots empty on both devices — no demo rows.
  for (const [label, c] of [['A', A], ['B', B]]) {
    const res = await c.from('sessions').select('id', { count: 'exact' }).eq('user_id', uid);
    if (res.error) throw new Error(`${label} pull: ${res.error.message}`);
    test(`l1: device ${label} boots an empty account (no demo rows)`, () => assert.equal(res.count, 0));
  }

  // l2: A creates; B must hear about it via realtime within seconds.
  {
    events.B.length = 0;
    const t0 = Date.now();
    const s = await one(A.from('sessions').insert(cashRow('created on A')).select('id').single(), 'A insert');
    const ev = await waitFor(() => events.B.find(e => e.eventType === 'INSERT' && e.new?.id === s.id));
    const ms = ev ? ev.at - t0 : NaN;
    test(`l2: A's create reached B via realtime in ${ms}ms (< ${SYNC_WINDOW_MS}ms)`, () => {
      assert.ok(ev, 'no INSERT event on B');
      assert.ok(ms < SYNC_WINDOW_MS, `took ${ms}ms`);
      assert.equal(ev.new.comment, 'created on A');
    });
  }

  // l3: B edits A's row (same account = same owner); A hears the UPDATE.
  {
    events.A.length = 0;
    const t0 = Date.now();
    const row = await one(A.from('sessions').select('id').eq('user_id', uid).limit(1).single(), 'fetch A row');
    await one(B.from('sessions').update({ comment: 'edited on B' }).eq('id', row.id), 'B update');
    const ev = await waitFor(() => events.A.find(e => e.eventType === 'UPDATE' && e.new?.id === row.id && e.new.comment === 'edited on B'));
    const ms = ev ? ev.at - t0 : NaN;
    test(`l3: B's edit reached A via realtime in ${ms}ms (< ${SYNC_WINDOW_MS}ms)`, () => {
      assert.ok(ev, 'no UPDATE event on A');
      assert.ok(ms < SYNC_WINDOW_MS, `took ${ms}ms`);
    });
  }

  // l4: A goes dark; its edit is buffered (what the store's durable queue
  // does); B writes meanwhile; reconnect converges everything.
  {
    await A.removeChannel(chA);
    const row = await one(A.from('sessions').select('id').eq('user_id', uid).limit(1).single(), 'fetch A row');

    // A's offline edit — held on the device, not sent.
    const offlineEdit = { id: row.id, comment: 'edited offline on A' };
    // B stays live: a create lands on the server and (with A dark) cannot
    // reach A until it reconnects.
    events.B.length = 0;
    const bRow = await one(B.from('bankroll_transactions').insert({ bankroll_id: 'bk-live', kind: 'deposit', amount: 300, description: 'B while A dark' })
      .select('id').single(), 'B insert while A dark');
    // B also edits the shared session row first — A's queued edit flushes
    // AFTER this confirmed write, so the later write must win.
    await one(B.from('sessions').update({ comment: 'B wrote first' }).eq('id', row.id), 'B update first');
    await sleep(1000);

    // A reconnects: resubscribe (realtime) + catch-up pull + flush, exactly
    // the store's reconnect sequence.
    events.B.length = 0;
    chA = await subscribe(A, uid, 'A', sink('A'));
    const pulled = await one(A.from('bankroll_transactions').select('id').eq('user_id', uid), 'A catch-up pull');
    await one(A.from('sessions').update({ comment: 'edited offline on A' }).eq('id', offlineEdit.id), 'A flush offline edit');
    const evA = await waitFor(() => events.B.find(e => e.eventType === 'UPDATE' && e.new?.id === offlineEdit.id && e.new.comment === 'edited offline on A'));
    test('l4: A\u2019s offline edit reached B via realtime after reconnect', () => assert.ok(evA, 'no UPDATE event on B'));

    const aSessions = await one(A.from('sessions').select('id,comment').eq('user_id', uid), 'A final sessions');
    const bSessions = await one(B.from('sessions').select('id,comment').eq('user_id', uid), 'B final sessions');
    const cloud = await one(A.from('bankroll_transactions').select('id').eq('user_id', uid), 'cloud txns');
    test('l4: no data loss — B\u2019s write reached A via the catch-up pull', () =>
      assert.ok(pulled.some(r => r.id === bRow.id), 'A missing the row B wrote while A was dark'));
    test('l4: last-write-wins — A\u2019s later flush beat B\u2019s confirmed write on both devices', () => {
      assert.equal(aSessions.find(r => r.id === offlineEdit.id).comment, 'edited offline on A');
      assert.equal(bSessions.find(r => r.id === offlineEdit.id).comment, 'edited offline on A');
    });
    test('l4: no data loss — cloud holds B\u2019s row and the shared session', () =>
      assert.ok(cloud.some(r => r.id === bRow.id) && aSessions.length === 1));
  }

  // l5: a delete on B reaches A via realtime within seconds.
  {
    events.A.length = 0;
    const t0 = Date.now();
    const row = await one(A.from('sessions').select('id').eq('user_id', uid).limit(1).single(), 'fetch row for delete');
    await one(B.from('sessions').delete().eq('id', row.id), 'B delete');
    const ev = await waitFor(() => events.A.find(e => e.eventType === 'DELETE' && e.old?.id === row.id));
    const ms = ev ? ev.at - t0 : NaN;
    test(`l5: B\u2019s delete reached A via realtime in ${ms}ms (< ${SYNC_WINDOW_MS}ms)`, () => {
      assert.ok(ev, 'no DELETE event on A');
      assert.ok(ms < SYNC_WINDOW_MS, `took ${ms}ms`);
      // Measured payload: old carries only the row id (Realtime does not
      // include full old rows even with replica identity full). The owner
      // wall is the server-side forced user_id filter, which is why this
      // event arrived at all — the row belonged to the signed-in account.
      assert.equal(ev.old.id, row.id, 'DELETE event must reference the deleted row id');
    });
  }

  // l6: both devices agree with the cloud on what remains.
  {
    const ids = async c => (await one(c.from('bankroll_transactions').select('id').eq('user_id', uid), 'final txns')).map(r => r.id).sort();
    const a = await ids(A), b = await ids(B);
    test('l6: both devices and the cloud hold the same final rows', () => assert.deepEqual(a, b));
  }

  await A.removeChannel(chA);
  await B.removeChannel(chB);
} catch (e) {
  fail++;
  console.log('  FAIL setup/teardown: ' + e.message);
}

async function waitFor(fn, windowMs = SYNC_WINDOW_MS) {
  const deadline = Date.now() + windowMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(100);
  }
}

// Cleanup: deleting the auth user cascades to every app row (owner columns
// are ON DELETE CASCADE), so the account and its rows cease to exist.
try {
  const list = uids.map(u => `'${u}'`).join(',') || "''";
  await mgmtQuery(`delete from auth.users where id in (${list})`);
  const [left] = await mgmtQuery(`select
      (select count(*) from auth.users where id in (${list}) or email like 'se2-test+${run}@%') users,
      (select count(*) from public.sessions where user_id in (${list})) sessions,
      (select count(*) from public.bankroll_transactions where user_id in (${list})) txns,
      (select count(*) from public.user_settings where user_id in (${list})) settings`);
  console.log(`  cleanup: remaining rows for this run ${JSON.stringify(left)}`);
  test('cleanup: the se2-test account and its rows are gone (0 users / 0 rows)', () =>
    assert.deepEqual(Object.values(left).map(Number), [0, 0, 0, 0]));
} catch (e) {
  fail++;
  console.log(`  FAIL cleanup: ${e.message}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
