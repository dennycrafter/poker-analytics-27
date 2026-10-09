// Display-cluster parity: Reports, Filters, Settings (backup + master data).
//
// 1. Live parity: the web modules and the native ports run the SAME corpus
//    (web demo seed + edge sessions) through `runCases` and must agree
//    exactly — every filter outcome, report bucket, export byte and import
//    result.
// 2. Golden parity: the native output must match the committed fixture that
//    scripts/gen-display-golden.ts produced from the WEB modules alone, so a
//    later change to either side that drifts is caught even if both drift.
// 3. Worked examples: small hand-checked cases (hour split across midnight,
//    hour filter semantics, export shape) so a bug shared by both fails.
//
// Run: npm test  (and npm run test:tz for UTC / Dublin / Los Angeles)

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { before, describe, it } from 'node:test';

import {
  EXPORTED_AT, NOW, counterIds, currentZone, forGolden, goldenPath, loadNative, loadWeb, runCases,
  type CaseOutput, type DisplayImpl,
} from './display-cases';
import * as NB from '../src/lib/backup';
import * as NF from '../src/lib/filters';
import * as NH from '../src/lib/hours';
import * as NM from '../src/lib/master-data';
import { buildSeed } from '../src/lib/seed';
import type { Doc, Session } from '../src/lib/types';

let web: DisplayImpl;
let nat: DisplayImpl;
let webOut: CaseOutput;
let natOut: CaseOutput;

before(async () => {
  web = await loadWeb();
  nat = await loadNative();
  webOut = runCases(web);
  natOut = runCases(nat);
});


describe('live parity: native ports === web modules', () => {
  it('seed: native buildSeed deep-equals web buildSeed', () => {
    assert.deepStrictEqual(nat.buildSeed(NOW), web.buildSeed(NOW));
  });
  it('hours: splitByHour for every corpus session + labels', () => {
    assert.deepStrictEqual(natOut.hours, webOut.hours);
  });
  it('filters: every case (feed + stats outcome, summary, active, bounds)', () => {
    assert.deepStrictEqual(Object.keys(natOut.filters), Object.keys(webOut.filters));
    for (const k of Object.keys(webOut.filters)) assert.deepStrictEqual(natOut.filters[k], webOut.filters[k], `filter case ${k}`);
  });
  it('filters: stakes options', () => {
    assert.deepStrictEqual(natOut.stakes, webOut.stakes);
  });
  it('reports: every dimension bucket, best-of, best period, extremes (net + gross)', () => {
    for (const mode of ['net', 'gross']) {
      const n = natOut.reports[mode] as { dims: Record<string, unknown> };
      const w = webOut.reports[mode] as { dims: Record<string, unknown> };
      assert.deepStrictEqual(Object.keys(n.dims), Object.keys(w.dims), `${mode} dimension ids`);
      for (const d of Object.keys(w.dims)) assert.deepStrictEqual(n.dims[d], w.dims[d], `${mode} ${d}`);
      assert.deepStrictEqual(n, w, `${mode} periods / extremes`);
    }
  });
  it('reports: period ranges and labels', () => {
    assert.deepStrictEqual(natOut.periodInfo, webOut.periodInfo);
  });
  it('backup: export text is byte-identical to the web download', () => {
    assert.equal(natOut.backup.exportText, webOut.backup.exportText);
    assert.equal(natOut.backup.filename, webOut.backup.filename);
  });
  it('backup: import of the export, re-export round-trip, bare doc, two-live guard', () => {
    assert.deepStrictEqual(natOut.backup.import, webOut.backup.import);
    assert.deepStrictEqual(natOut.backup.roundTrip, webOut.backup.roundTrip);
    assert.deepStrictEqual(natOut.backup.bare, webOut.backup.bare);
    assert.equal(natOut.backup.twoLive, webOut.backup.twoLive);
  });
  it('backup: every import error message', () => {
    assert.deepStrictEqual(natOut.backup.errors, webOut.backup.errors);
  });
  it('backup: reset-demo document', () => {
    assert.deepStrictEqual(natOut.backup.demo, webOut.backup.demo);
  });
  it('settings: master-data usage, name/delete validation, currency validation', () => {
    assert.deepStrictEqual(natOut.master, webOut.master);
  });
});

describe(`golden parity (${currentZone()})`, () => {
  const path = goldenPath(currentZone());
  it('native output matches the web-generated golden fixture', { skip: !existsSync(path) && `no golden for ${currentZone()}` }, () => {
    const golden = JSON.parse(readFileSync(path, 'utf8'));
    const mine = JSON.parse(JSON.stringify(forGolden(natOut)));
    for (const k of Object.keys(golden)) assert.deepStrictEqual(mine[k], golden[k], `golden section ${k}`);
    assert.deepStrictEqual(Object.keys(mine).sort(), Object.keys(golden).sort());
  });
  it('golden fixture still matches the web modules (fixture is not stale)', { skip: !existsSync(path) }, () => {
    const golden = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(forGolden(webOut))), golden);
  });
});

// ---------------------------------------------------------------------------
// Worked examples (independent of the web code).

function localIso(y: number, mo: number, d: number, h: number, mi = 0): string {
  return new Date(y, mo - 1, d, h, mi, 0, 0).toISOString();
}

function sess(id: string, start: string, end: string | null, patch: Partial<Session> = {}): Session {
  return {
    id, kind: 'cash', game_id: 'g-nlh', location_id: 'loc-ucd', bankroll_id: 'bk-live', group_id: null, table_size: 9,
    start_time: start, end_time: end, duration_seconds: end ? (Date.parse(end) - Date.parse(start)) / 1000 : null,
    break_seconds: 0, hands_count: null, hands_count_estimated: false, comment: null, opponents: null,
    is_live: !end, tracked_via_stack: false, paused_at: null, small_blind: 0.5, big_blind: 1, buy_in: 100, cashed_out: 150, tips: 0,
    ...patch,
  } as Session;
}

describe('worked examples', () => {
  it('brief 5.13: a 22:30-02:15 session splits 30/60/60/60/15 across 22,23,0,1,2', () => {
    const m = NH.splitByHour(sess('a', localIso(2026, 3, 4, 22, 30), localIso(2026, 3, 5, 2, 15)));
    assert.deepStrictEqual([m[22], m[23], m[0], m[1], m[2]], [30, 60, 60, 60, 15]);
    assert.equal(m.reduce((a, b) => a + b, 0), 225);
  });
  it('hour filter: overlap of any minute counts; ending exactly on the hour does not', () => {
    const s = sess('a', localIso(2026, 3, 4, 20, 0), localIso(2026, 3, 4, 22, 0));
    const f = (hour: number) => ({ ...NF.emptyFilter(), hour });
    assert.equal(NF.matches(f(20), s, NOW), true);
    assert.equal(NF.matches(f(21), s, NOW), true);
    assert.equal(NF.matches(f(22), s, NOW), false);
    assert.equal(NF.matches(f(19), s, NOW), false);
  });
  it('stakes filter alone narrows to cash; tournament type alone narrows to tournaments', () => {
    const cash = sess('c', localIso(2026, 3, 4, 20), localIso(2026, 3, 4, 22));
    const tourn = sess('t', localIso(2026, 3, 4, 20), localIso(2026, 3, 4, 22), { kind: 'tournament', tournament_type_id: 'tt-mtt' } as Partial<Session>);
    const stakes = { ...NF.emptyFilter(), stakes: ['0.5/1'] };
    const tt = { ...NF.emptyFilter(), tournament_type_ids: ['tt-mtt'] };
    assert.deepStrictEqual(NF.applyFilter(stakes, [cash, tourn], NOW).map(s => s.id), ['c']);
    assert.deepStrictEqual(NF.applyFilter(tt, [cash, tourn], NOW).map(s => s.id), ['t']);
  });
  it('custom range is local-inclusive on both ends', () => {
    const s = sess('a', localIso(2026, 3, 4, 23, 59), localIso(2026, 3, 5, 1, 0));
    const f = { ...NF.emptyFilter(), range: 'custom' as const, from: '2026-03-04', to: '2026-03-04' };
    assert.equal(NF.matches(f, s, NOW), true);
    assert.equal(NF.matches({ ...f, from: '2026-03-05', to: '2026-03-05' }, s, NOW), false);
  });
  it('export: web envelope with all 11 collections and currency; import re-keys to uuids', () => {
    const seed = buildSeed(NOW) as unknown as Doc;
    const payload = NB.exportPayload({ ...seed, extra_master: {} }, EXPORTED_AT);
    assert.equal(payload.app, 'poker-analytics-27');
    assert.equal(payload.format, 1);
    assert.equal(payload.exported_at, EXPORTED_AT);
    assert.deepStrictEqual(Object.keys(payload.data).sort(), ['settings', ...NB.COLLECTIONS].sort());
    assert.equal('extra_master' in payload.data, false);
    const res = NB.parseImport(JSON.stringify(payload), counterIds());
    assert.ok(res.ok);
    assert.equal(res.doc.sessions.length, 40);
    assert.ok(res.doc.sessions.every(s => /^[0-9a-f-]{36}$/.test(s.id)));
    const ids = new Set(res.doc.sessions.map(s => s.id));
    assert.ok(res.doc.sell_actions.every(a => ids.has(a.session_id)), 'sell actions re-pointed');
  });
  it('master data: case-insensitive duplicate names; in-use items cannot be deleted', () => {
    const seed = buildSeed(NOW) as unknown as Doc;
    assert.match(NM.masterNameError(seed, 'locations', ' ucd ') ?? '', /already exists/i);
    assert.equal(NM.masterNameError(seed, 'locations', 'Brand new'), null);
    assert.notEqual(NM.masterDeleteError(seed, 'locations', 'loc-ucd'), null);
    assert.equal(NM.currencyError('usd'), null);
    assert.notEqual(NM.currencyError('EURO'), null);
  });
});
