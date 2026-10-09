// Shared fixture + case runner for the display-cluster parity tests.
//
// `runCases(impl)` feeds ONE deterministic corpus through either the web
// modules (js/filters.js, js/reports.js, js/hours.js, js/backup.js,
// js/manage.js, js/seed.js) or their native ports and returns a plain,
// JSON-serialisable result. The test asserts native === web live, and
// native === the committed golden file produced from the web modules
// (scripts/gen-display-golden.ts) for the current timezone.
//
// Inputs are local-time based (hour filter, seed), so outputs are timezone
// dependent; the golden file is keyed by IANA zone.

import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { Filter } from '../src/lib/filters';
import type { Doc, Session, StakingMode } from '../src/lib/types';

/** Fixed "now" shared with metrics-parity.test.ts. */
export const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
export const EXPORTED_AT = '2026-10-09T12:00:00.000Z';

type Raw = Record<string, unknown>;
interface BucketLike { key: string | number; label: string; count: number; hours: number; net: number; rate: number | null; minutes?: number; sessions: Session[] }
interface DimLike { id: string; title: string }
type ImportLike = { ok: true; doc: Raw; counts: Raw } | { ok: false; error: string };

/**
 * The surface both implementations share. The web modules are untyped JS, so
 * they are adapted to this interface at the call site (tests only).
 */
export interface DisplayImpl {
  buildSeed(nowMs: number): Raw;
  splitByHour(s: Session): number[];
  hourRangeLabel(h: number): string;
  emptyFilter(): Filter;
  applyFilter(f: Filter, sessions: Session[], nowMs: number): Session[];
  summary(doc: Raw, f: Filter): string;
  isActive(f: Filter): boolean;
  stakesOptions(doc: Raw): string[];
  rangeBounds(f: Filter, nowMs: number): [number, number] | null;
  DIMENSIONS: DimLike[];
  dimensionBuckets(doc: Raw, dim: DimLike, sessions: Session[], mode: StakingMode): BucketLike[];
  bestOf(b: BucketLike[]): { byNet: BucketLike | null; byRate: BucketLike | null };
  bestPeriod(doc: Raw, sessions: Session[], kind: string, mode: StakingMode): Raw | null;
  extremeSessions(doc: Raw, sessions: Session[], mode: StakingMode): { win: { session: Session; net: number } | null; loss: { session: Session; net: number } | null };
  periodRange(kind: string, key: string): { from: string; to: string };
  periodLabel(kind: string, key: string): string;
  exportPayload(doc: Raw, nowIso: string): Raw;
  exportFilename(nowMs: number): string;
  parseImport(text: string, newId: () => string): ImportLike;
  demoDoc(nowMs: number, newId: () => string): Raw;
  masterUsage(doc: Raw, listKey: string, id: string): number;
  masterNameError(doc: Raw, listKey: string, name: string, exceptId?: string | null): string | null;
  masterDeleteError(doc: Raw, listKey: string, id: string): string | null;
  currencyError(code: string): string | null;
}

/** Deterministic uuid factory (both sides get a fresh one per case). */
export function counterIds(): () => string {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}

/** Round floats so tiny summation-order noise can never produce false diffs. */
function r(n: number | null | undefined): number | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return n === undefined ? null : (n as number | null);
  return Number(n.toPrecision(12));
}

// ---------------------------------------------------------------------------
// Corpus: the web demo seed plus edge cases the seed does not exercise.

function localIso(nowMs: number, daysBack: number, h: number, m = 0): string {
  const d = new Date(nowMs);
  d.setDate(d.getDate() - daysBack);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

function base(id: string, kind: 'cash' | 'tournament', start: string, end: string | null): Raw {
  const dur = end ? Math.round((Date.parse(end) - Date.parse(start)) / 1000) : null;
  return {
    id, kind, game_id: 'g-nlh', location_id: 'loc-ucd', bankroll_id: 'bk-live', group_id: null, table_size: 9,
    start_time: start, end_time: end, duration_seconds: dur, break_seconds: 0, hands_count: null,
    hands_count_estimated: false, comment: null, opponents: null, is_live: !end, tracked_via_stack: false, paused_at: null,
    small_blind: null, big_blind: null, buy_in: null, cashed_out: null, tips: 0,
    tournament_type_id: null, tournament_name: null, initial_buy_in: null, total_buy_in: null, prize: null, position: null, entries: null,
    created_at: start, updated_at: end ?? start,
  };
}

/** Seed document extended with a group, a midnight-crossing session, a PLO cash, a no-location SNG and a live session. */
export function corpusDoc(impl: Pick<DisplayImpl, 'buildSeed'>): Raw {
  const doc = impl.buildSeed(NOW);
  const groups = [{ id: 'grp-league', name: 'Winter League' }];
  const extras: Raw[] = [
    { ...base('x-midnight', 'cash', localIso(NOW, 3, 22, 30), localIso(NOW, 2, 2, 15)),
      small_blind: 0.5, big_blind: 1, buy_in: 100, cashed_out: 164, hands_count: 110, group_id: 'grp-league' },
    { ...base('x-plo', 'cash', localIso(NOW, 9, 19), localIso(NOW, 9, 23, 40)),
      game_id: 'g-plo', location_id: 'loc-home', table_size: 6, small_blind: 0.25, big_blind: 0.5, buy_in: 50, cashed_out: 21.5 },
    { ...base('x-sng', 'tournament', localIso(NOW, 1, 13), localIso(NOW, 1, 15, 5)),
      location_id: null, tournament_type_id: 'tt-sng', initial_buy_in: 20, total_buy_in: 20, prize: 0, group_id: 'grp-league' },
    { ...base('x-live', 'cash', localIso(NOW, 0, 9), null), small_blind: 0.1, big_blind: 0.2, tracked_via_stack: true },
  ];
  return { ...doc, groups, sessions: [...(doc.sessions as Raw[]), ...extras] };
}

const ended = (doc: Raw) => (doc.sessions as Session[]).filter(s => !s.is_live);

/** Filters exercised against the corpus: every range, kind, list, all 24 hours and combinations. */
export function filterCases(empty: Filter): [string, Filter][] {
  const f = (patch: Partial<Filter>): Filter => ({ ...empty, ...patch });
  const out: [string, Filter][] = [
    ['empty', f({})],
    ...(['7d', '30d', '90d', 'year', 'all'] as const).map((range): [string, Filter] => [`range:${range}`, f({ range })]),
    ['custom:day', f({ range: 'custom', from: '2026-10-07', to: '2026-10-07' })],
    ['custom:month', f({ range: 'custom', from: '2026-09-01', to: '2026-09-30' })],
    ['custom:year', f({ range: 'custom', from: '2026-01-01', to: '2026-12-31' })],
    ['custom:from-only', f({ range: 'custom', from: '2026-08-15', to: null })],
    ['custom:to-only', f({ range: 'custom', from: null, to: '2026-06-30' })],
    ['custom:span', f({ range: 'custom', from: '2026-07-04', to: '2026-08-20' })],
    ['kind:cash', f({ kind: 'cash' })],
    ['kind:tournament', f({ kind: 'tournament' })],
    ['game:plo', f({ game_ids: ['g-plo'] })],
    ['stakes:0.25/0.5', f({ stakes: ['0.25/0.5'] })],
    ['stakes:multi', f({ stakes: ['0.1/0.2', '0.5/1', '1/2'] })],
    ['tt:mtt', f({ tournament_type_ids: ['tt-mtt'] })],
    ['stakes+tt', f({ stakes: ['0.5/1'], tournament_type_ids: ['tt-sng'] })],
    ['location:ucd+home', f({ location_ids: ['loc-ucd', 'loc-home'] })],
    ['location:many', f({ location_ids: ['loc-ucd', 'loc-home', 'loc-casino'] })],
    ['bankroll:live', f({ bankroll_ids: ['bk-live'] })],
    ['bankroll:unknown', f({ bankroll_ids: ['bk-nope'] })],
    ['group:league', f({ group_ids: ['grp-league'] })],
    ['combo:30d-cash-h23', f({ range: '30d', kind: 'cash', hour: 23 })],
    ['combo:tourn-ucd-year', f({ range: 'year', kind: 'tournament', location_ids: ['loc-ucd'] })],
    ['combo:everything', f({ range: '90d', kind: 'cash', game_ids: ['g-nlh'], stakes: ['0.1/0.2', '0.25/0.5'], location_ids: ['loc-ucd'], bankroll_ids: ['bk-live'], hour: 21 })],
  ];
  for (let h = 0; h < 24; h++) out.push([`hour:${h}`, f({ hour: h })]);
  return out;
}

function bucketOut(b: BucketLike) {
  return {
    // The web's buy-in dimension returns the raw number as its label (JS
    // laxity); native types labels as strings. Neither client displays it
    // (buy-in buckets render from `key` via money formatting), so compare
    // the string form.
    key: b.key, label: String(b.label), count: b.count, hours: r(b.hours), net: r(b.net), rate: r(b.rate),
    minutes: b.minutes === undefined ? null : r(b.minutes), ids: b.sessions.map(s => s.id),
  };
}

const IMPORT_ERRORS: [string, string][] = [
  ['not-json', '{nope'],
  ['array', '[]'],
  ['wrong-app', JSON.stringify({ app: 'other', data: { sessions: [] } })],
  ['no-data', JSON.stringify({ app: 'poker-analytics-27', format: 1 })],
  ['newer-format', JSON.stringify({ app: 'poker-analytics-27', format: 2, data: { sessions: [] } })],
  ['no-sessions', JSON.stringify({ app: 'poker-analytics-27', format: 1, data: {} })],
  ['games-not-list', JSON.stringify({ sessions: [], games: {} })],
  ['bad-session-kind', JSON.stringify({ sessions: [{ id: 'a', kind: 'casino', start_time: EXPORTED_AT }] })],
  ['bad-session-time', JSON.stringify({ sessions: [{ id: 'a', kind: 'cash', start_time: 'yesterday' }] })],
  ['bad-session-id', JSON.stringify({ sessions: [{ kind: 'cash', start_time: EXPORTED_AT }] })],
  ['bad-txn', JSON.stringify({ sessions: [], transactions: [{ id: 't', kind: 'gift', amount: 5 }] })],
  ['bad-txn-amount', JSON.stringify({ sessions: [], transactions: [{ id: 't', kind: 'deposit', amount: 'lots' }] })],
];

function importOut(res: ImportLike) {
  if (!res.ok) return { ok: false, error: res.error };
  const { extra_master: _drop, ...doc } = res.doc as Raw & { extra_master?: unknown };
  void _drop; // native-only sync plumbing, never part of the web document
  return { ok: true, counts: res.counts, doc };
}

export function runCases(impl: DisplayImpl) {
  const doc = corpusDoc(impl);
  const sessions = doc.sessions as Session[];
  const done = ended(doc);

  // hours
  const hours = {
    split: Object.fromEntries(sessions.map(s => [s.id, impl.splitByHour(s).map(m => r(m))])),
    labels: Array.from({ length: 24 }, (_, h) => impl.hourRangeLabel(h)),
  };

  // filters (Feed corpus includes the live session; Stats uses ended only)
  const empty = impl.emptyFilter();
  const filters = Object.fromEntries(filterCases(empty).map(([name, f]) => [name, {
    feed: impl.applyFilter(f, sessions, NOW).map(s => s.id),
    stats: impl.applyFilter(f, done, NOW).map(s => s.id),
    summary: impl.summary(doc, f),
    active: impl.isActive(f),
    bounds: impl.rangeBounds(f, NOW)?.map(v => (Number.isFinite(v) ? v : String(v))) ?? null,
  }]));
  const stakes = impl.stakesOptions(doc);

  // reports (both staking modes; the seed has a 30% sell action)
  const reports: Record<string, unknown> = {};
  for (const mode of ['net', 'gross'] as StakingMode[]) {
    const dims = Object.fromEntries(impl.DIMENSIONS.map(dim => {
      const buckets = impl.dimensionBuckets(doc, dim, done, mode);
      const best = impl.bestOf(buckets);
      return [dim.id, {
        title: dim.title,
        buckets: buckets.map(bucketOut),
        bestNet: best.byNet ? { key: best.byNet.key, net: r(best.byNet.net) } : null,
        bestRate: best.byRate ? { key: best.byRate.key, rate: r(best.byRate.rate) } : null,
      }];
    }));
    const periods = Object.fromEntries(['day', 'week', 'month', 'year'].map(k => {
      const b = impl.bestPeriod(doc, done, k, mode);
      return [k, b ? { ...b, net: r(b.net as number) } : null];
    }));
    const ex = impl.extremeSessions(doc, done, mode);
    reports[mode] = {
      dims, periods,
      win: ex.win ? { id: ex.win.session.id, net: r(ex.win.net) } : null,
      loss: ex.loss ? { id: ex.loss.session.id, net: r(ex.loss.net) } : null,
    };
  }
  const periodKeys: [string, string][] = [
    ['day', '2026-10-07'], ['week', '2026-09-28'], ['week', '2026-12-28'], ['month', '2026-09'], ['month', '2028-02'],
    ['month', '2026-12'], ['year', '2026'],
  ];
  const periodInfo = periodKeys.map(([k, key]) => ({ kind: k, key, range: impl.periodRange(k, key), label: impl.periodLabel(k, key) }));

  // backup: export, import of that export, re-export round-trip, bare doc, errors, demo
  const exported = impl.exportPayload(doc, EXPORTED_AT);
  const exportedText = JSON.stringify(exported, null, 2);
  const imported = impl.parseImport(exportedText, counterIds());
  let roundTrip: unknown = null;
  if (imported.ok) {
    const again = JSON.stringify(impl.exportPayload(imported.doc, EXPORTED_AT), null, 2);
    const reimported = impl.parseImport(again, counterIds());
    roundTrip = { reexported: again, stable: reimported.ok && JSON.stringify(importOut(reimported)) === JSON.stringify(importOut(imported)) };
  }
  const twoLive = { ...doc, sessions: [...sessions, { ...(sessions.find(s => s.is_live) as unknown as Raw), id: 'x-live-2' }] };
  const backup = {
    filename: impl.exportFilename(NOW),
    exportText: exportedText,
    import: importOut(imported),
    roundTrip,
    bare: importOut(impl.parseImport(JSON.stringify(impl.buildSeed(NOW)), counterIds())),
    twoLive: (() => {
      const res = impl.parseImport(JSON.stringify(twoLive), counterIds());
      return res.ok ? (res.doc.sessions as Session[]).filter(s => s.is_live).length : res.error;
    })(),
    errors: Object.fromEntries(IMPORT_ERRORS.map(([name, text]) => [name, importOut(impl.parseImport(text, counterIds()))])),
    demo: (() => { const { extra_master: _x, ...d } = impl.demoDoc(NOW, counterIds()) as Raw & { extra_master?: unknown }; void _x; return d; })(),
  };

  // settings master data
  const lists = ['games', 'locations', 'tournament_types', 'groups', 'bankrolls'];
  const master = {
    usage: Object.fromEntries(lists.map(k => [k, (doc[k] as { id: string }[]).map(x => [x.id, impl.masterUsage(doc, k, x.id), impl.masterDeleteError(doc, k, x.id)])])),
    unusedDelete: impl.masterDeleteError({ ...doc, locations: [...(doc.locations as Raw[]), { id: 'loc-new', name: 'New' }] }, 'locations', 'loc-new'),
    lastBankroll: impl.masterDeleteError({ ...doc, sessions: [], transactions: [] }, 'bankrolls', 'bk-live'),
    names: [
      ['games', 'PLO', null], ['games', '  plo  ', null], ['games', 'PLO', 'g-plo'], ['games', '', null], ['games', '   ', null],
      ['games', 'x'.repeat(61), null], ['games', 'x'.repeat(60), null], ['locations', 'ucd', null], ['groups', 'Winter league', null],
      ['tournament_types', 'Bounty', null],
    ].map(([k, n, ex]) => impl.masterNameError(doc, k as string, n as string, ex as string | null)),
    currency: ['EUR', 'eur', ' usd ', 'EURO', 'E1R', '', 'ab'].map(c => impl.currencyError(c)),
  };

  return { hours, filters, stakes, reports, periodInfo, backup, master };
}

export type CaseOutput = ReturnType<typeof runCases>;

function digest(text: string): { sha256: string; bytes: number } {
  return { sha256: createHash('sha256').update(text).digest('hex'), bytes: text.length };
}

/** Golden form: large documents become digests so the committed fixture stays reviewable. */
export function forGolden(out: CaseOutput): unknown {
  const b = out.backup;
  const rt = b.roundTrip as { reexported: string; stable: boolean } | null;
  return {
    ...out,
    backup: {
      ...b,
      exportText: digest(b.exportText),
      import: b.import.ok ? { ok: true, counts: b.import.counts, doc: digest(JSON.stringify(b.import.doc)) } : b.import,
      roundTrip: rt ? { reexported: digest(rt.reexported), stable: rt.stable } : null,
      bare: b.bare.ok ? { ok: true, counts: b.bare.counts, doc: digest(JSON.stringify(b.bare.doc)) } : b.bare,
      demo: digest(JSON.stringify(b.demo)),
    },
  };
}

/** IANA zone of this process (golden files are keyed by it). */
export function currentZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** tests/golden/display-<zone>.json, e.g. display-Europe_Dublin.json. */
export function goldenPath(zone: string): string {
  return join(__dirname, 'golden', `display-${zone.replace(/\//g, '_')}.json`);
}

/** Install the globals js/store.js + vendored supabase-js need, then load the web modules. */
export async function loadWeb(): Promise<DisplayImpl> {
  const g = globalThis as Record<string, unknown>;
  if (!g.localStorage) {
    const m = new Map<string, string>();
    g.localStorage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
  }
  if (!g.WebSocket) g.WebSocket = (await import('ws')).default;
  const [F, R, H, B, M, Sd] = await Promise.all([
    import('../../js/filters.js'), import('../../js/reports.js'), import('../../js/hours.js'),
    import('../../js/backup.js'), import('../../js/manage.js'), import('../../js/seed.js'),
  ]);
  return { ...Sd, ...H, ...F, ...R, ...B, ...M } as unknown as DisplayImpl;
}

/** The native ports, adapted to the shared surface. */
export async function loadNative(): Promise<DisplayImpl> {
  const [F, R, H, B, M, Sd] = await Promise.all([
    import('../src/lib/filters'), import('../src/lib/reports'), import('../src/lib/hours'),
    import('../src/lib/backup'), import('../src/lib/master-data'), import('../src/lib/seed'),
  ]);
  return { ...Sd, ...H, ...F, ...R, ...B, ...M } as unknown as DisplayImpl;
}

export type { Doc };
