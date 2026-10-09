// Cross-user realtime privacy harness (live Supabase project, two disposable
// accounts). Account A subscribes to postgres_changes twice:
//   1. "client" channel - the exact bindings js/store.js ships (INSERT/UPDATE
//      filtered by user_id, DELETE unfiltered on sessions + transactions);
//   2. "hostile" channel - unfiltered '*' on every table, i.e. what any signed-in
//      user could ask for with the public publishable key.
// Account B then inserts, updates and deletes rows in all three tables while A
// does the same to its own rows. Pass = A never receives a single event about
// B's rows (no row id, no user id) AND A still receives its own INSERT, UPDATE
// and DELETE in realtime AND REST reads stay owner-only.
//
// Usage: node tests/realtime-delete-privacy.test.mjs
// Accounts are deleted at the end when SECRET_SUPABASE_ACCESS_TOKEN is set
// (management API); otherwise their emails are printed for manual cleanup.

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
const TABLES = ['sessions', 'bankroll_transactions', 'user_settings'];
const SETTLE_MS = 4000;
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const emailA = `fx2a-test+${run}@example.com`;
const emailB = `fx2b-test+${run}@example.com`;
const password = `pa27-${run}-Xy9!`;

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

async function signUp(email) {
  const c = newClient();
  const { data, error } = await c.auth.signUp({ email, password });
  if (error) throw new Error(`signUp ${email}: ${error.message}`);
  if (!data.session) throw new Error(`signUp ${email}: no session (is email confirmation on?)`);
  return { c, uid: data.user.id, email };
}

function subscribe(c, name, bind) {
  return new Promise((resolve, reject) => {
    const ch = bind(c.channel(`${name}:${run}`));
    const t = setTimeout(() => reject(new Error(`${name}: subscribe timed out`)), 15000);
    ch.subscribe((state, err) => {
      if (state === 'SUBSCRIBED') { clearTimeout(t); resolve(ch); }
      else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT') { clearTimeout(t); reject(err || new Error(`${name}: ${state}`)); }
    });
  });
}

// Mutations one account performs on its own rows; returns the ids it touched.
async function churn(acct, tag) {
  const { c } = acct;
  const one = async (q, what) => { const { data, error } = await q; if (error) throw new Error(`${tag} ${what}: ${error.message}`); return data; };
  const s = await one(c.from('sessions').insert({ kind: 'cash', start_time: new Date(Date.now() - 3600e3).toISOString(),
    end_time: new Date().toISOString(), small_blind: 0.1, big_blind: 0.2, buy_in: 20, cashed_out: 25, comment: `${tag} secret` })
    .select('id').single(), 'insert session');
  const t = await one(c.from('bankroll_transactions').insert({ bankroll_id: 'b1', kind: 'deposit', amount: 300, description: `${tag} secret` })
    .select('id').single(), 'insert txn');
  await one(c.from('user_settings').insert({ currency: 'EUR' }).select('user_id').single(), 'insert settings');
  await sleep(300);
  await one(c.from('sessions').update({ comment: `${tag} edited` }).eq('id', s.id).select('id'), 'update session');
  await one(c.from('bankroll_transactions').update({ amount: 301 }).eq('id', t.id).select('id'), 'update txn');
  await one(c.from('user_settings').update({ currency: 'USD' }).eq('user_id', acct.uid).select('user_id'), 'update settings');
  await sleep(300);
  await one(c.from('sessions').delete().eq('id', s.id).select('id'), 'delete session');
  await one(c.from('bankroll_transactions').delete().eq('id', t.id).select('id'), 'delete txn');
  await one(c.from('user_settings').delete().eq('user_id', acct.uid).select('user_id'), 'delete settings');
  return { session: s.id, txn: t.id };
}

async function mgmtQuery(sql) {
  const token = process.env.SECRET_SUPABASE_ACCESS_TOKEN;
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`management API ${res.status}: ${body}`);
  return JSON.parse(body);
}

async function cleanup(uids) {
  if (!process.env.SECRET_SUPABASE_ACCESS_TOKEN) {
    console.log(`  WARN no SECRET_SUPABASE_ACCESS_TOKEN - delete ${emailA}, ${emailB} manually`);
    return;
  }
  const list = uids.map(u => `'${u}'`).join(',');
  // auth.users cascades to every app table (on delete cascade).
  await mgmtQuery(`delete from auth.users where id in (${list})`);
  const [left] = await mgmtQuery(`select
      (select count(*) from auth.users where id in (${list}) or email in ('${emailA}','${emailB}')) users,
      (select count(*) from public.sessions where user_id in (${list})) sessions,
      (select count(*) from public.bankroll_transactions where user_id in (${list})) txns,
      (select count(*) from public.user_settings where user_id in (${list})) settings`);
  console.log(`  cleanup: remaining rows for this run ${JSON.stringify(left)}`);
  test('cleanup: both disposable accounts and their rows are gone', () =>
    assert.deepEqual(Object.values(left).map(Number), [0, 0, 0, 0]));
}

// The fix lives in a trigger on Realtime's own table; a Realtime upgrade that
// recreates realtime.subscription would silently drop it, so assert it exists.
async function checkServerConfig() {
  if (!process.env.SECRET_SUPABASE_ACCESS_TOKEN) return;
  const rows = await mgmtQuery(`select tgname from pg_trigger
    where tgrelid = 'realtime.subscription'::regclass and tgname = 'pa27_owner_filter' and tgenabled <> 'D'`);
  test('server: pa27_owner_filter trigger is installed on realtime.subscription', () => assert.equal(rows.length, 1));
}

const uids = [];
try {
  await checkServerConfig();
  const A = await signUp(emailA); uids.push(A.uid);
  const B = await signUp(emailB); uids.push(B.uid);
  console.log(`  accounts: A=${A.uid} B=${B.uid}`);

  const seen = { client: [], hostile: [] };
  const log = which => p => seen[which].push({ table: p.table, type: p.eventType, new: p.new, old: p.old });
  await subscribe(A.c, 'client', ch => {
    const filter = `user_id=eq.${A.uid}`;
    for (const table of TABLES) {
      ch = ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table, filter }, log('client'))
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table, filter }, log('client'));
    }
    for (const table of ['sessions', 'bankroll_transactions']) {
      ch = ch.on('postgres_changes', { event: 'DELETE', schema: 'public', table }, log('client'));
    }
    return ch;
  });
  await subscribe(A.c, 'hostile', ch => {
    for (const table of TABLES) ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, log('hostile'));
    return ch;
  });
  // Signed-out client (publishable key only): must not see anyone's changes.
  const anon = newClient();
  const anonSeen = [];
  const anonSub = await subscribe(anon, 'anon', ch => {
    for (const table of TABLES) ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, p => anonSeen.push(p));
    return ch;
  }).then(() => 'subscribed', e => `rejected: ${e && e.message || e}`);
  console.log(`  anon channel: ${anonSub}`);
  await sleep(1500); // let the server register the subscriptions

  const bIds = await churn(B, 'B');
  const aIds = await churn(A, 'A');
  await sleep(SETTLE_MS);

  const bMarkers = [bIds.session, bIds.txn, B.uid];
  const mentionsB = e => bMarkers.some(m => JSON.stringify([e.new, e.old]).includes(m))
    || (e.type === 'DELETE' && e.table === 'user_settings' && !JSON.stringify(e.old).includes(A.uid));
  for (const which of ['client', 'hostile']) {
    const all = seen[which];
    console.log(`  ${which} channel received ${all.length} events:`);
    for (const e of all) console.log(`    ${e.type.padEnd(6)} ${e.table.padEnd(21)} old=${JSON.stringify(e.old)} new.id=${e.new && (e.new.id || e.new.user_id)}`);
  }

  test(`anon channel: signed-out subscriber receives nothing (got ${anonSeen.length})`,
    () => assert.equal(anonSeen.length, 0));
  await anon.removeAllChannels();

  for (const which of ['client', 'hostile']) {
    const leaked = seen[which].filter(mentionsB);
    test(`${which} channel: A receives no event about B's rows (got ${leaked.length})`,
      () => assert.equal(leaked.length, 0, `leaked: ${JSON.stringify(leaked)}`));
    const foreignDeletes = seen[which].filter(e => e.type === 'DELETE' && !JSON.stringify(e.old).includes(aIds.session)
      && !JSON.stringify(e.old).includes(aIds.txn) && !JSON.stringify(e.old).includes(A.uid));
    test(`${which} channel: every DELETE A receives is one of A's own rows (foreign ${foreignDeletes.length})`,
      () => assert.equal(foreignDeletes.length, 0));
  }

  const has = (which, type, table, id) => seen[which].some(e => e.type === type && e.table === table
    && JSON.stringify(type === 'DELETE' ? e.old : e.new).includes(id));
  for (const [table, id] of [['sessions', aIds.session], ['bankroll_transactions', aIds.txn]]) {
    for (const type of ['INSERT', 'UPDATE', 'DELETE']) {
      test(`client channel: A receives its own ${type} on ${table}`, () => assert.ok(has('client', type, table, id)));
    }
  }
  test('client channel: A receives its own INSERT on user_settings', () => assert.ok(has('client', 'INSERT', 'user_settings', A.uid)));
  test('client channel: A receives its own UPDATE on user_settings', () => assert.ok(has('client', 'UPDATE', 'user_settings', A.uid)));
  test('hostile channel: A still receives its own DELETE on user_settings', () => assert.ok(has('hostile', 'DELETE', 'user_settings', A.uid)));
  test('own DELETE payload carries the row id the client keys on', () => {
    const d = seen.client.find(e => e.type === 'DELETE' && e.table === 'sessions' && e.old && e.old.id === aIds.session);
    assert.ok(d, 'no DELETE with old.id for A\'s session');
  });

  // REST reads: RLS must still be owner-only and unchanged by the fix.
  const probe = await B.c.from('sessions').insert({ kind: 'cash', start_time: new Date(Date.now() - 60e3).toISOString(), comment: 'B probe' }).select('id').single();
  if (probe.error) throw new Error(`B probe insert: ${probe.error.message}`);
  const aSees = await A.c.from('sessions').select('id,user_id');
  const bSees = await B.c.from('sessions').select('id,user_id');
  test('REST: A cannot read B\'s session row', () => {
    assert.equal(aSees.error, null);
    assert.ok(!aSees.data.some(r => r.id === probe.data.id) && aSees.data.every(r => r.user_id === A.uid));
  });
  test('REST: B reads its own session row', () => {
    assert.equal(bSees.error, null);
    assert.ok(bSees.data.some(r => r.id === probe.data.id));
  });
  const aDel = await A.c.from('sessions').delete().eq('id', probe.data.id).select('id');
  test('REST: A cannot delete B\'s session row', () => assert.deepEqual(aDel.data, []));

  await A.c.removeAllChannels();
} catch (e) {
  fail++;
  console.log('  FAIL harness error\n       ' + (e && e.stack || e));
} finally {
  if (uids.length) await cleanup(uids).catch(e => { fail++; console.log('  FAIL cleanup\n       ' + e.message); });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
