// Live cloud proof for the MONEY port (bankroll, risk of ruin, staking, Top 10).
// Drives the app's own CloudStore + native mutators against the live Supabase
// project with the publishable key, on a disposable nm-test.<ts>@example.com
// account:
//
//   1. sign up; device A logs cash sessions and tournaments, sells action
//      (30% @ 1.1 and a partial 25% @ 1.0 + 15% @ 1.2) and adds deposit /
//      withdrawal / "other" transactions through the native mutators
//   2. device B (fresh client, same account, empty cache) pulls everything from
//      the cloud; sell actions survive the jsonb round trip
//   3. on B's pulled document the native ledger, bankroll summary, RoR and Top 10
//      equal the WEB modules' output (js/staking.js, bankroll.js, rankings.js)
//      and the hand-computed numbers below
//   4. B deletes a sell action and a transaction; A sees both over realtime and
//      its retained net / bankroll total move by the expected amounts
//   5. cleanup via the Management API: delete the account, prove 0 users and
//      0 sessions / transactions / settings rows remain for it.
//
// Run: SECRET_SUPABASE_ACCESS_TOKEN=... npm run test:integration:money

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

import * as WB from '../../js/bankroll.js';
import * as WR from '../../js/rankings.js';
import * as WK from '../../js/staking.js';

import * as B from '../src/lib/bankroll';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '../src/lib/config';
import * as D from '../src/lib/domain';
import * as R from '../src/lib/rankings';
import * as K from '../src/lib/staking';
import { CloudStore, type KeyValueStorage } from '../src/lib/sync';
import type { Doc } from '../src/lib/types';

const PROJECT_REF = new URL(SUPABASE_URL).hostname.split('.')[0];
const TOKEN = process.env.SECRET_SUPABASE_ACCESS_TOKEN;
const RUN = Date.now();
const EMAIL = `nm-test.${RUN}@example.com`;
const PASSWORD = `Nm-${randomUUID()}`;
const H = 3600e3;

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
    realtime: { transport: WebSocket as never },
  });
}

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

/** JSON-normalised copy, so native and web outputs compare structurally (no undefined vs missing noise). */
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
const close = (a: number, b: number, label: string): void => assert.ok(Math.abs(a - b) < 1e-9, `${label}: ${a} != ${b}`);

function step(n: number, msg: string): void { console.log(`\n[${n}] ${msg}`); }
function ok(msg: string): void { console.log(`    ok  ${msg}`); }

/** Native vs web on one document: every money output must be identical. */
function assertParity(doc: Doc, bankrollId: string): void {
  for (const id of [null, bankrollId]) {
    assert.deepEqual(plain(B.bankrollSummary(doc, id)), plain(WB.bankrollSummary(doc, id as null)), `bankrollSummary(${id})`);
    assert.deepEqual(plain(B.bankrollSeries(doc, id)), plain(WB.bankrollSeries(doc, id as null)), `bankrollSeries(${id})`);
  }
  for (const s of doc.sessions.filter(x => x.kind === 'tournament')) {
    assert.deepEqual(plain(K.sellLedger(doc, s)), plain(WK.sellLedger(doc, s)), `sellLedger(${s.tournament_name})`);
  }
  for (const which of ['best', 'worst'] as const) {
    for (const mode of ['net', 'gross'] as const) {
      const n = R.topSessions(doc, which, 10, mode).map(x => [x.s.id, x.net]);
      const w = (WR.topSessions(doc, which, 10, mode) as { s: { id: string }; net: number }[]).map(x => [x.s.id, x.net]);
      assert.deepEqual(n, w, `topSessions(${which}, ${mode})`);
    }
  }
}

async function main(): Promise<void> {
  console.log(`project ${PROJECT_REF}  run ${RUN}  account ${EMAIL}`);
  const stores: CloudStore[] = [];
  const clients: SupabaseClient[] = [];
  let uid = '';
  let failure: unknown = null;

  try {
    step(1, `sign up ${EMAIL}; device A logs sessions, sell actions and transactions`);
    const a = client(); clients.push(a);
    const { data, error } = await a.auth.signUp({ email: EMAIL, password: PASSWORD });
    if (error) throw new Error(`signUp: ${error.message}`);
    if (!data.session || !data.user) throw new Error('signUp: no session (is email confirmation enabled?)');
    uid = data.user.id;
    const storeA = new CloudStore(a, memoryStorage()); stores.push(storeA);
    await storeA.start(uid);
    await storeA.waitForRealtime();
    const d0 = storeA.getState();
    const game = d0.games[0].id;
    const bk = d0.bankrolls[0].id;
    assert.equal(d0.sessions.length, 0, 'new account starts empty');

    const now = Date.now();
    const at = (daysAgo: number, hours: number) => {
      const start = new Date(now - daysAgo * 24 * H);
      return { start, end: new Date(start.getTime() + hours * H) };
    };
    const ids: Record<string, string> = {};
    storeA.mutate(d => {
      const cash = (key: string, daysAgo: number, hours: number, buy: number, out: number) => {
        const t = at(daysAgo, hours);
        ids[key] = D.logPastSession(d, {
          kind: 'cash', game_id: game, location_id: null, bankroll_id: bk, group_id: null, table_size: 9,
          start: t.start, end: t.end, tips: 0, hands_count: Math.round(hours * 30),
          small_blind: 0.25, big_blind: 0.5, buy_in: buy, cashed_out: out,
        }, randomUUID);
      };
      const tourney = (key: string, daysAgo: number, buy: number, prize: number) => {
        const t = at(daysAgo, 5);
        ids[key] = D.logPastSession(d, {
          kind: 'tournament', game_id: game, location_id: null, bankroll_id: bk, group_id: null, table_size: 9,
          start: t.start, end: t.end, tips: 0, hands_count: null, tournament_type_id: null, tournament_name: key,
          initial_buy_in: buy, total_buy_in: buy, prize, position: prize > 0 ? 3 : null, entries: 60,
        }, randomUUID);
      };
      cash('c1', 30, 4, 50, 130);   // +80
      cash('c2', 25, 3, 50, 0);     // -50
      cash('c3', 20, 5, 100, 160);  // +60
      cash('c4', 15, 2, 50, 30);    // -20
      tourney('deep', 12, 50, 600);  // gross +550; 30% @ 1.1 sold
      tourney('split', 8, 40, 200);  // gross +160; 25% @ 1.0 + 15% @ 1.2 sold
      tourney('bust', 4, 20, 0);     // gross -20; 50% @ 1.0 sold
      K.addSellAction(d, ids.deep, { percentage: 30, markup: 1.1, backer_name: 'Bob' }, randomUUID);
      K.addSellAction(d, ids.split, { percentage: 25, markup: 1.0, backer_name: 'Ann' }, randomUUID);
      K.addSellAction(d, ids.split, { percentage: 15, markup: 1.2, backer_name: null }, randomUUID);
      K.addSellAction(d, ids.bust, { percentage: 50, markup: 1, backer_name: 'Cy' }, randomUUID);
      const txn = (kind: 'deposit' | 'withdrawal' | 'other', amount: number, daysAgo: number, description: string | null) =>
        B.addTransaction(d, { bankroll_id: bk, kind, amount, description, occurred_at: new Date(now - daysAgo * 24 * H).toISOString() }, randomUUID);
      ids.dep = txn('deposit', B.signedAmount('deposit', 300), 40, 'Starting roll');
      ids.wd = txn('withdrawal', B.signedAmount('withdrawal', 50), 10, null);
      ids.exp = txn('other', B.signedAmount('other', 12, 'out'), 5, 'Parking');
    });
    assert.equal((await storeA.whenSettled()).state, 'saved');
    const { count: sessRows } = await a.from('sessions').select('id', { count: 'exact', head: true });
    const { count: txnRows } = await a.from('bankroll_transactions').select('id', { count: 'exact', head: true });
    assert.equal(sessRows, 7); assert.equal(txnRows, 3);
    const { data: deepRow } = await a.from('sessions').select('sell_actions').eq('id', ids.deep).single();
    assert.equal((deepRow?.sell_actions as unknown[]).length, 1);
    ok('7 session rows + 3 transaction rows saved; sell actions stored in the session jsonb');

    step(2, 'device B pulls the account from the cloud (empty cache)');
    const b = client(); clients.push(b);
    const { error: inErr } = await b.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
    if (inErr) throw new Error(`signIn: ${inErr.message}`);
    const storeB = new CloudStore(b, memoryStorage()); stores.push(storeB);
    await storeB.start(uid);
    await storeB.waitForRealtime();
    const docB = storeB.getState();
    assert.equal(docB.sessions.length, 7);
    assert.equal(docB.sell_actions.length, 4);
    assert.equal(docB.transactions.length, 3);
    ok('B has 7 sessions, 4 sell actions, 3 transactions');

    step(3, 'native == web on the pulled document, and both == hand-computed numbers');
    assertParity(docB, bk);
    const sess = (key: string) => docB.sessions.find(s => s.id === ids[key])!;
    // deep: B=50, P=600, 30% @ 1.1 -> retained = 600*0.7 - 50*(1-0.33) = 420 - 33.5 = 386.5
    const deep = K.sellLedger(docB, sess('deep'));
    close(deep.retained, 386.5, 'deep retained'); close(deep.gross, 550, 'deep gross');
    close(deep.received, 16.5, 'deep received'); close(deep.paidOut, 180, 'deep paid out');
    close(deep.backersNet, 163.5, 'deep backers'); close(deep.retained + deep.backersNet, deep.gross, 'deep identity');
    // split: B=40, P=200, 25%@1.0 + 15%@1.2 -> sold 40%, pm = .25 + .18 = .43
    //   retained = 200*0.6 - 40*(1-0.43) = 120 - 22.8 = 97.2
    const split = K.sellLedger(docB, sess('split'));
    close(split.soldPct, 40, 'split sold'); close(split.retained, 97.2, 'split retained');
    // bust: B=20, P=0, 50%@1 -> retained = -20*0.5 = -10
    close(K.sellLedger(docB, sess('bust')).retained, -10, 'bust retained');
    // bankroll: sessions net (staked) = 80-50+60-20 + 386.5 + 97.2 - 10 = 543.7; txns 300-50-12 = 238
    const sum = B.bankrollSummary(docB, bk);
    close(sum.net, 543.7, 'bankroll net'); close(sum.banked, 250, 'banked'); close(sum.total, 781.7, 'bankroll total');
    assert.ok(sum.ror !== null && sum.ror >= 1 && sum.ror <= 100, `RoR in 1..100 (got ${sum.ror})`);
    const best = R.topSessions(docB, 'best', 3, 'net').map(x => x.s.id);
    assert.deepEqual(best, [ids.deep, ids.split, ids.c1], 'best 3 (net)');
    // Gross: bust (-20, 4 days ago) ties c4 (-20, 15 days ago); the more recent one ranks first.
    const worstGross = R.topSessions(docB, 'worst', 3, 'gross').map(x => x.s.id);
    assert.deepEqual(worstGross, [ids.c2, ids.bust, ids.c4], 'worst 3 (gross, tie -> more recent first)');
    // Net: bust retains only -10, so c4 (-20) moves ahead of it.
    const worstNet = R.topSessions(docB, 'worst', 3, 'net').map(x => x.s.id);
    assert.deepEqual(worstNet, [ids.c2, ids.c4, ids.bust], 'worst 3 (net)');
    ok(`ledgers deep 386.5 / split 97.2 / bust -10, bankroll ${sum.total} (RoR ${sum.ror}%), Top 10 order — native == web`);

    step(4, 'B deletes a sell action and a transaction; A sees both over realtime');
    const splitPartial = docB.sell_actions.find(x => x.session_id === ids.split && Number(x.markup) === 1.2)!;
    storeB.mutate(d => { K.deleteSellAction(d, splitPartial.id); B.deleteTransaction(d, ids.exp); });
    assert.equal((await storeB.whenSettled()).state, 'saved');
    const ms = await waitFor(storeA, d =>
      d.sell_actions.length === 3 && !d.transactions.some(t => t.id === ids.exp), 'A sees sell + txn deletes');
    const docA = storeA.getState();
    // split now 25% @ 1.0: retained = 200*0.75 - 40*0.75 = 120
    close(K.sellLedger(docA, docA.sessions.find(s => s.id === ids.split)!).retained, 120, 'split retained after delete');
    close(B.bankrollSummary(docA, bk).total, 781.7 + (120 - 97.2) + 12, 'total after deletes');
    assertParity(docA, bk);
    ok(`A updated after ${ms} ms: split retained 120, bankroll ${B.bankrollSummary(docA, bk).total}; native == web`);
  } catch (e) {
    failure = e;
  } finally {
    for (const s of stores) await s.stop().catch(e => console.error('store stop failed', e));
    for (const c of clients) await c.removeAllChannels().catch(e => console.error('channel cleanup failed', e));

    step(5, 'cleanup via Management API');
    try {
      await sql(`delete from auth.users where email = '${EMAIL}'`);
      const id = uid || '00000000-0000-0000-0000-000000000000';
      const [left] = await sql<{ users: number; sessions: number; txns: number; settings: number }>(`
        select
          (select count(*) from auth.users where email = '${EMAIL}')::int as users,
          (select count(*) from public.sessions where user_id = '${id}')::int as sessions,
          (select count(*) from public.bankroll_transactions where user_id = '${id}')::int as txns,
          (select count(*) from public.user_settings where user_id = '${id}')::int as settings`);
      console.log(`    remaining for ${EMAIL}: ${JSON.stringify(left)}`);
      assert.deepEqual(left, { users: 0, sessions: 0, txns: 0, settings: 0 });
      ok('test account deleted; 0 users / 0 rows remain for it');
    } catch (e) {
      failure = failure ?? e;
      console.error('cleanup failed', e);
    }
  }

  if (failure) {
    console.error('\nMONEY INTEGRATION FAILED:', failure);
    process.exit(1);
  }
  console.log('\nMONEY INTEGRATION PASSED');
  process.exit(0);
}

void main();
