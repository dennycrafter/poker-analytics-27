// Headless end-to-end proof of the backend contract the native app relies on.
// Drives the app's own CloudStore (src/lib/sync.ts) + domain mutators against
// the live Supabase project with the publishable key:
//
//   1. sign up a fresh account (nativetest.<ts>@…, instant: confirmation off)
//   2. device A logs a session through CloudStore -> row lands in `sessions`
//   3. device B (second client, same account) receives it over realtime
//   4. device A edits it -> B observes the UPDATE echo; A's own echo is a no-op
//   5. live session + stack events + pause round-trip through jsonb
//   6. delete -> B observes the DELETE
//   7. RLS: a second fresh account cannot read account 1's rows
//   8. cleanup via the Management API (SECRET_SUPABASE_ACCESS_TOKEN):
//      delete both auth users, then prove 0 users / 0 rows remain.
//
// Run: SECRET_SUPABASE_ACCESS_TOKEN=... npm run test:integration

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '../src/lib/config';
import * as D from '../src/lib/domain';
import * as S from '../src/lib/stats';
import { CloudStore, type KeyValueStorage } from '../src/lib/sync';
import type { Doc } from '../src/lib/types';

const PROJECT_REF = new URL(SUPABASE_URL).hostname.split('.')[0];
const TOKEN = process.env.SECRET_SUPABASE_ACCESS_TOKEN;
const RUN = Date.now();
const EMAIL_A = `nativetest.${RUN}@example.com`;
const EMAIL_B = `nativetest.${RUN}.rls@example.com`;
const PASSWORD = `Nt-${randomUUID()}`;

function memoryStorage(): KeyValueStorage {
  const m = new Map<string, string>();
  return {
    getItem: async k => m.get(k) ?? null,
    setItem: async (k, v) => { m.set(k, v); },
    removeItem: async k => { m.delete(k); },
  };
}

function client(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, storage: memoryStorage() },
    // Node 20 has no global WebSocket; the app on device uses the RN one.
    realtime: { transport: WebSocket as never },
  });
}

/** Run SQL as the project owner via the Supabase Management API. */
async function sql<T = Record<string, unknown>>(query: string): Promise<T[]> {
  if (!TOKEN) throw new Error('SECRET_SUPABASE_ACCESS_TOKEN is not set');
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`management API ${res.status}: ${body}`);
  return JSON.parse(body) as T[];
}

/** Resolve once `pred` holds for the store's document (checked on every change). */
function waitFor(store: CloudStore, pred: (d: Doc) => boolean, label: string, ms = 15000): Promise<number> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    if (pred(store.getState())) { resolve(0); return; }
    const timer = setTimeout(() => { off(); reject(new Error(`timed out waiting for: ${label}`)); }, ms);
    const off = store.subscribe((doc, source) => {
      if (source === 'remote' && pred(doc)) { clearTimeout(timer); off(); resolve(Date.now() - t0); }
    });
  });
}

async function signUp(email: string): Promise<{ sb: SupabaseClient; uid: string }> {
  const sb = client();
  const { data, error } = await sb.auth.signUp({ email, password: PASSWORD });
  if (error) throw new Error(`signUp ${email}: ${error.message}`);
  if (!data.session || !data.user) throw new Error(`signUp ${email}: no session (is email confirmation enabled?)`);
  return { sb, uid: data.user.id };
}

async function signIn(email: string): Promise<SupabaseClient> {
  const sb = client();
  const { error } = await sb.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`signIn ${email}: ${error.message}`);
  return sb;
}

function step(n: number, msg: string): void { console.log(`\n[${n}] ${msg}`); }
function ok(msg: string): void { console.log(`    ok  ${msg}`); }

async function main(): Promise<void> {
  console.log(`project ${PROJECT_REF}  run ${RUN}`);
  const uids: string[] = [];
  const stores: CloudStore[] = [];
  const clients: SupabaseClient[] = [];
  let failure: unknown = null;

  try {
    step(1, `sign up ${EMAIL_A}`);
    const a = await signUp(EMAIL_A);
    uids.push(a.uid); clients.push(a.sb);
    ok(`user ${a.uid}, session issued immediately`);

    const storeA = new CloudStore(a.sb, memoryStorage());
    stores.push(storeA);
    await storeA.start(a.uid);
    await storeA.waitForRealtime();
    assert.equal(storeA.getState().sessions.length, 0, 'new account starts empty (no demo data)');
    assert.ok(storeA.getState().games.length > 0, 'default master data created');
    assert.equal((await storeA.whenSettled()).state, 'saved');
    ok(`device A ready: 0 sessions, ${storeA.getState().games.length} games, settings row saved`);

    const bSb = await signIn(EMAIL_A);
    clients.push(bSb);
    const storeB = new CloudStore(bSb, memoryStorage());
    stores.push(storeB);
    await storeB.start(a.uid);
    await storeB.waitForRealtime();
    ok('device B signed in to the same account, realtime SUBSCRIBED');

    step(2, 'device A logs a past cash session');
    const doc0 = storeA.getState();
    const end = new Date(Date.now() - 3600e3);
    const start = new Date(end.getTime() - 4 * 3600e3);
    assert.equal(D.validateTimes(start, end), null);
    let sid = '';
    storeA.mutate(d => {
      sid = D.logPastSession(d, {
        kind: 'cash', game_id: doc0.games[0].id, location_id: null, bankroll_id: doc0.bankrolls[0].id, group_id: null,
        table_size: 9, start, end, tips: 5, hands_count: 120, small_blind: 0.25, big_blind: 0.5, buy_in: 100, cashed_out: 180,
      }, randomUUID);
    });
    assert.equal((await storeA.whenSettled()).state, 'saved');
    const { data: rows, error: selErr } = await a.sb.from('sessions').select('*').eq('id', sid);
    assert.ifError(selErr);
    assert.equal(rows?.length, 1);
    assert.equal(Number(rows![0].cashed_out), 180);
    ok(`row ${sid} in public.sessions (cashed_out 180)`);

    step(3, 'device B receives the INSERT over realtime');
    const insMs = await waitFor(storeB, d => d.sessions.some(s => s.id === sid), 'B sees insert');
    const onB = storeB.getState().sessions.find(s => s.id === sid)!;
    assert.equal(S.netResult(storeB.getState(), onB), 75, 'net = 180 - 100 - 5');
    ok(`B has the session after ${insMs} ms, net result 75 computed on B`);

    step(4, 'device A edits it; B observes the UPDATE echo');
    let remoteOnA = 0;
    const offA = storeA.subscribe((_d, src) => { if (src === 'remote') remoteOnA++; });
    storeA.mutate(d => D.updateSession(d, sid, { cashed_out: 250, comment: 'edited on device A' }));
    assert.equal((await storeA.whenSettled()).state, 'saved');
    const updMs = await waitFor(storeB, d => d.sessions.find(s => s.id === sid)?.cashed_out === 250, 'B sees update');
    const edited = storeB.getState().sessions.find(s => s.id === sid)!;
    assert.equal(edited.comment, 'edited on device A');
    assert.equal(S.netResult(storeB.getState(), edited), 145);
    await new Promise(r => setTimeout(r, 1500));
    offA();
    assert.equal(remoteOnA, 0, "A's own realtime echo must be a no-op (fingerprint match)");
    ok(`B updated after ${updMs} ms (net 145); A ignored its own echo`);

    step(5, 'live cash session with stack events and a pause round-trips');
    let liveId = '';
    const liveStart = new Date(Date.now() - 2 * 3600e3).toISOString();
    storeA.mutate(d => {
      liveId = D.startLiveCash(d, { game_id: doc0.games[0].id, location_id: null, bankroll_id: doc0.bankrolls[0].id,
        group_id: null, table_size: 6, small_blind: 0.5, big_blind: 1, buy_in: 100, start_time: liveStart }, randomUUID);
      D.addStackEvent(d, liveId, { kind: 'top_up', amount: 50, occurred_at: new Date().toISOString() }, randomUUID);
      D.togglePause(d, liveId);
    });
    await waitFor(storeB, d => {
      const s = d.sessions.find(x => x.id === liveId);
      return !!s && !!s.paused_at && S.stackBuyIn(d, s) === 150;
    }, 'B sees live session paused with 150 buy-in');
    assert.equal(D.getLiveSession(storeB.getState())?.id, liveId);
    storeA.mutate(d => { D.togglePause(d, liveId); D.endLiveCash(d, liveId, 220, randomUUID); });
    await waitFor(storeB, d => {
      const s = d.sessions.find(x => x.id === liveId);
      return !!s && !s.is_live && S.netResult(d, s) === 70;
    }, 'B sees ended live session');
    assert.equal(D.getLiveSession(storeB.getState()), null);
    ok('B saw live -> paused (buy-in 150 from stack events) -> ended (cash_out event, net 70)');

    step(6, 'device A deletes both; B observes the DELETEs');
    storeA.mutate(d => { D.deleteSession(d, sid); D.deleteSession(d, liveId); });
    assert.equal((await storeA.whenSettled()).state, 'saved');
    const delMs = await waitFor(storeB, d => d.sessions.length === 0, 'B sees deletes');
    const { count } = await a.sb.from('sessions').select('id', { count: 'exact', head: true });
    assert.equal(count, 0);
    ok(`B empty after ${delMs} ms; sessions table has 0 rows for this user`);

    step(7, 'RLS: another account cannot see account A rows');
    storeA.mutate(d => {
      sid = D.logPastSession(d, {
        kind: 'tournament', game_id: doc0.games[0].id, location_id: null, bankroll_id: doc0.bankrolls[0].id, group_id: null,
        table_size: 9, start, end, tips: 0, hands_count: null, tournament_type_id: null, tournament_name: 'RLS probe',
        initial_buy_in: 20, total_buy_in: 20, prize: 110, position: 2, entries: 30,
      }, randomUUID);
    });
    assert.equal((await storeA.whenSettled()).state, 'saved');
    const other = await signUp(EMAIL_B);
    uids.push(other.uid); clients.push(other.sb);
    const peek = await other.sb.from('sessions').select('id').eq('id', sid);
    assert.ifError(peek.error);
    assert.equal(peek.data?.length, 0, 'foreign row invisible');
    const hijack = await other.sb.from('sessions').update({ comment: 'hijack' }).eq('id', sid).select('id');
    assert.equal(hijack.data?.length ?? 0, 0, 'foreign row not updatable');
    ok('second account reads 0 rows and updates 0 rows of account A');
  } catch (e) {
    failure = e;
  } finally {
    for (const s of stores) await s.stop().catch(e => console.error('store stop failed', e));
    for (const c of clients) await c.removeAllChannels().catch(e => console.error('channel cleanup failed', e));

    step(8, 'cleanup via Management API');
    try {
      const like = `nativetest.${RUN}%`;
      await sql(`delete from auth.users where email like '${like}'`);
      const idList = uids.map(u => `'${u}'`).join(',') || `'00000000-0000-0000-0000-000000000000'`;
      const [left] = await sql<{ users: number; sessions: number; txns: number; settings: number }>(`
        select
          (select count(*) from auth.users where email like '${like}')::int as users,
          (select count(*) from public.sessions where user_id in (${idList}))::int as sessions,
          (select count(*) from public.bankroll_transactions where user_id in (${idList}))::int as txns,
          (select count(*) from public.user_settings where user_id in (${idList}))::int as settings`);
      console.log(`    remaining: ${JSON.stringify(left)}`);
      assert.deepEqual(left, { users: 0, sessions: 0, txns: 0, settings: 0 });
      ok(`deleted ${uids.length} test users; 0 users / 0 rows remain (FK cascade)`);
    } catch (e) {
      failure = failure ?? e;
      console.error('cleanup failed', e);
    }
  }

  if (failure) {
    console.error('\nINTEGRATION FAILED:', failure);
    process.exit(1);
  }
  console.log('\nINTEGRATION PASSED');
  process.exit(0);
}

void main();
