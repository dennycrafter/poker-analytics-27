// Live cloud proof for the DISPLAY port (Settings, backup, Filters, Reports).
// Drives the app's own CloudStore + the exact native helpers the Settings
// screen calls (master-data mutators, backup.ts, replace.ts) against the live
// Supabase project with the publishable key, on a disposable
// nd-test.<ts>@example.com account:
//
//   1. sign up; device A changes currency and adds + renames a location
//      (Settings) -> device B (fresh client, empty cache) pulls the same
//      user_settings row
//   2. A exports JSON: the payload carries the cloud-saved settings and is
//      byte-identical to the WEB js/backup.js export of the same document
//   3. A imports the display corpus (web export of seed + edge sessions) via
//      replaceDoc; the DB holds exactly that many rows; B pulls it, and the
//      native filters + report buckets on B's CLOUD-ROUND-TRIPPED document
//      equal the web golden fixture (tests/golden/display-<zone>.json)
//   4. B exports, A re-imports that file through the SAME rows: no row is
//      added or lost, ids are kept (uuids), and the re-export is identical
//   5. A resets demo data via replaceDoc: the corpus extras are DELETED from
//      the cloud (row count drops to the seed's 40)
//   6. cleanup via the Management API: delete the account, prove 0 users and
//      0 sessions / transactions / settings rows remain for it.
//
// Run: SECRET_SUPABASE_ACCESS_TOKEN=... TZ=UTC npm run test:integration:display

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

import { NOW, corpusDoc, currentZone, filterCases, goldenPath, loadWeb } from '../tests/display-cases';
import * as BK from '../src/lib/backup';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '../src/lib/config';
import * as F from '../src/lib/filters';
import * as M from '../src/lib/master-data';
import * as R from '../src/lib/reports';
import { replaceDoc, replaceOutcome } from '../src/lib/replace';
import { endedSessions } from '../src/lib/stats';
import { CloudStore, type KeyValueStorage } from '../src/lib/sync';
import type { Doc, Session } from '../src/lib/types';

const PROJECT_REF = new URL(SUPABASE_URL).hostname.split('.')[0];
const TOKEN = process.env.SECRET_SUPABASE_ACCESS_TOKEN;
const RUN = Date.now();
const EMAIL = `nd-test.${RUN}@example.com`;
const PASSWORD = `Nd-${randomUUID()}`;
const EXPORTED_AT = '2026-10-09T12:00:00.000Z';

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

type Counts = { sessions: number; txns: number; settings: number };
async function rowCounts(uid: string): Promise<Counts> {
  const [c] = await sql<Counts>(`
    select
      (select count(*) from public.sessions where user_id = '${uid}')::int as sessions,
      (select count(*) from public.bankroll_transactions where user_id = '${uid}')::int as txns,
      (select count(*) from public.user_settings where user_id = '${uid}')::int as settings`);
  return c;
}

function step(n: number, msg: string): void { console.log(`\n[${n}] ${msg}`); }
function ok(msg: string): void { console.log(`    ok  ${msg}`); }

/** A fresh device: new client signed in to the same account, empty cache, full pull. */
async function freshDevice(stores: CloudStore[], clients: SupabaseClient[]): Promise<CloudStore> {
  const c = client(); clients.push(c);
  const { data, error } = await c.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (error || !data.user) throw new Error(`signIn: ${error?.message ?? 'no user'}`);
  const store = new CloudStore(c, memoryStorage()); stores.push(store);
  await store.start(data.user.id);
  return store;
}

async function settle(store: CloudStore, label: string): Promise<void> {
  const st = await store.whenSettled();
  assert.equal(replaceOutcome(st, 'ok'), 'ok', `${label}: sync status ${JSON.stringify(st)}`);
}

const exportBody = (doc: Doc) => BK.exportText(doc, EXPORTED_AT);

type GoldenBucket = { key: string | number; count: number; net: number | null; ids: string[] };
type Golden = {
  filters: Record<string, { feed: string[]; stats: string[] }>;
  reports: { net: { dims: Record<string, { buckets: GoldenBucket[] }> } };
};

const r12 = (n: number | null) => (n === null || !Number.isFinite(n) ? n : Number(n.toPrecision(12)));

async function main(): Promise<void> {
  const zone = currentZone();
  console.log(`project ${PROJECT_REF}  run ${RUN}  account ${EMAIL}  zone ${zone}`);
  const golden = JSON.parse(readFileSync(goldenPath(zone), 'utf8')) as Golden;
  const web = await loadWeb();
  const stores: CloudStore[] = [];
  const clients: SupabaseClient[] = [];
  let uid = '';
  let failure: unknown = null;

  try {
    step(1, `sign up ${EMAIL}; A sets currency + adds/renames a location; B pulls`);
    const a = client(); clients.push(a);
    const { data, error } = await a.auth.signUp({ email: EMAIL, password: PASSWORD });
    if (error) throw new Error(`signUp: ${error.message}`);
    if (!data.session || !data.user) throw new Error('signUp: no session (is email confirmation enabled?)');
    uid = data.user.id;
    const storeA = new CloudStore(a, memoryStorage()); stores.push(storeA);
    await storeA.start(uid);
    assert.equal(storeA.getState().sessions.length, 0, 'new account starts empty');

    const locId = randomUUID();
    assert.equal(M.currencyError('USD'), null);
    assert.equal(M.masterNameError(storeA.getState(), 'locations', 'Club Nord'), null);
    storeA.mutate(d => { M.setCurrency(d, 'USD'); M.addMasterItem(d, 'locations', 'Club Nord', locId); });
    await settle(storeA, 'settings save');
    storeA.mutate(d => M.renameMasterItem(d, 'locations', locId, 'Club Nord Dublin'));
    await settle(storeA, 'rename');
    const [srow] = await sql<{ currency: string; locs: string }>(
      `select currency, master_data->'locations' as locs from public.user_settings where user_id = '${uid}'`);
    assert.equal(srow.currency, 'USD');
    assert.match(JSON.stringify(srow.locs), /Club Nord Dublin/);
    const storeB = await freshDevice(stores, clients);
    const docB1 = storeB.getState();
    assert.equal(docB1.settings.currency, 'USD');
    assert.deepEqual(docB1.locations.map(l => [l.id, l.name]), [[locId, 'Club Nord Dublin']]);
    ok('user_settings row has USD + renamed location; fresh device B pulled the same');

    step(2, 'A exports JSON: carries cloud-saved settings; bytes == web js/backup.js export');
    const exp1 = exportBody(storeA.getState());
    const p1 = JSON.parse(exp1) as BK.ExportPayload;
    assert.equal(p1.app, 'poker-analytics-27');
    assert.equal(p1.data.settings.currency, 'USD');
    assert.equal(JSON.stringify(web.exportPayload(storeB.getState() as never, EXPORTED_AT), null, 2), exportBody(storeB.getState()),
      'native export of the pulled doc === web export of the same doc');
    // jsonb normalises object key order (shorter keys first), so a cloud-pulled
    // document serialises master items with a different key order than A's
    // local draft — same on the web client. Content must be identical.
    assert.deepEqual(JSON.parse(exportBody(storeB.getState())), p1, 'A and B export the same content');
    ok(`export ${exp1.length} bytes; native bytes == web bytes on the pulled doc; A == B by content`);

    step(3, 'A imports the display corpus via replaceDoc; filters + reports on B == web golden');
    const corpusText = JSON.stringify(web.exportPayload(corpusDoc(web), EXPORTED_AT), null, 2);
    const raw = (JSON.parse(corpusText) as { data: { sessions: { id: string }[] } }).data.sessions;
    const imp = BK.parseImport(corpusText, randomUUID);
    if (!imp.ok) throw new Error(`import: ${imp.error}`);
    // parseImport keeps session order, so index i maps the new uuid back to the corpus id.
    const toCorpus = new Map(imp.doc.sessions.map((s, i) => [s.id, raw[i].id]));
    const st3 = await replaceDoc(storeA, imp.doc);
    assert.equal(replaceOutcome(st3, 'ok'), 'ok', `import sync ${JSON.stringify(st3)}`);
    const c3 = await rowCounts(uid);
    assert.deepEqual(c3, { sessions: imp.counts.sessions, txns: imp.counts.transactions, settings: 1 });
    ok(`cloud rows after import: ${JSON.stringify(c3)}`);

    const storeB2 = await freshDevice(stores, clients);
    const docB = storeB2.getState();
    assert.equal(docB.sessions.length, imp.counts.sessions);
    assert.equal(docB.settings.currency, imp.doc.settings.currency, 'import replaced the currency');
    assert.equal(docB.locations.some(l => l.id === locId), false, 'import replaced the master lists');
    // Corpus order, so filter output order matches the golden arrays.
    const order = new Map(raw.map((s, i) => [s.id, i]));
    const cid = (s: Session) => toCorpus.get(s.id) ?? `?${s.id}`;
    const sessions = [...docB.sessions].sort((x, y) => (order.get(cid(x)) ?? 0) - (order.get(cid(y)) ?? 0));
    const ended = sessions.filter(s => !s.is_live);
    let nFilters = 0;
    for (const [name, f] of filterCases(F.emptyFilter())) {
      const g = golden.filters[name];
      assert.ok(g, `golden filter ${name}`);
      assert.deepEqual(F.applyFilter(f, sessions, NOW).map(cid), g.feed, `filter ${name} (feed)`);
      assert.deepEqual(F.applyFilter(f, ended, NOW).map(cid), g.stats, `filter ${name} (stats)`);
      nFilters++;
    }
    const docSorted = { ...docB, sessions };
    let nBuckets = 0;
    for (const dim of R.DIMENSIONS) {
      const got = R.dimensionBuckets(docSorted, dim, endedSessions(docSorted), 'net')
        .map(b => ({ key: b.key, count: b.count, net: r12(b.net), ids: b.sessions.map(cid) }));
      const want = golden.reports.net.dims[dim.id].buckets.map(b => ({ key: b.key, count: b.count, net: b.net, ids: b.ids }));
      assert.deepEqual(got, want, `report ${dim.id}`);
      nBuckets += got.length;
    }
    ok(`${nFilters} filter cases (feed + stats) and ${nBuckets} report buckets on the cloud-pulled doc match the web golden (${zone})`);

    step(4, 'B exports; A re-imports that file through the same rows');
    const expB = exportBody(docB);
    const re = BK.parseImport(expB, randomUUID);
    if (!re.ok) throw new Error(`re-import: ${re.error}`);
    assert.deepEqual(re.doc.sessions.map(s => s.id).sort(), docB.sessions.map(s => s.id).sort(), 'uuid ids preserved');
    const st4 = await replaceDoc(storeA, re.doc);
    assert.equal(replaceOutcome(st4, 'ok'), 'ok', `re-import sync ${JSON.stringify(st4)}`);
    assert.deepEqual(await rowCounts(uid), c3, 'same rows: nothing added or lost');
    const storeB3 = await freshDevice(stores, clients);
    assert.equal(exportBody(storeB3.getState()), expB, 'export after re-import === export before');
    ok('re-import is a no-op on the cloud rows; re-export byte-identical');

    step(5, 'A resets demo data (replaceDoc): corpus extras are deleted from the cloud');
    const demo = BK.demoDoc(Date.now(), randomUUID);
    const st5 = await replaceDoc(storeA, demo);
    assert.equal(replaceOutcome(st5, 'Demo data loaded'), 'Demo data loaded');
    const c5 = await rowCounts(uid);
    assert.deepEqual(c5, { sessions: demo.sessions.length, txns: demo.transactions.length, settings: 1 });
    assert.equal(demo.sessions.length, 40);
    assert.ok(c5.sessions < c3.sessions, 'rows deleted');
    const storeB4 = await freshDevice(stores, clients);
    assert.equal(storeB4.getState().sessions.length, 40);
    assert.equal(storeB4.getState().settings.currency, 'EUR');
    ok(`cloud rows after reset: ${JSON.stringify(c5)} (was ${c3.sessions} sessions)`);
  } catch (e) {
    failure = e;
  } finally {
    for (const s of stores) await s.stop().catch(e => console.error('store stop failed', e));
    for (const c of clients) await c.removeAllChannels().catch(e => console.error('channel cleanup failed', e));

    step(6, 'cleanup via Management API');
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
    console.error('\nDISPLAY INTEGRATION FAILED:', failure);
    process.exit(1);
  }
  console.log('\nDISPLAY INTEGRATION PASSED');
  process.exit(0);
}

void main();
