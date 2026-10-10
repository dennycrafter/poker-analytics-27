// Reports bar-chart parity: native lib/bar-chart.ts against the web
// js/charts/svg.js (niceScale + barChart). The web chart emits an SVG string,
// so the test parses its bar rects / gridlines / axis labels and compares them
// with the native barLayout() geometry at the same 1-decimal precision the
// web prints. hourBars is compared against the hour buckets of the web
// reports module on the shared display corpus.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { corpusDoc, loadWeb, type DisplayImpl } from './display-cases';
import { barLayout, compactMoney, hourBars, niceScale, type Bar } from '../src/lib/bar-chart';
import { DIMENSIONS, dimensionBuckets } from '../src/lib/reports';
import { endedSessions } from '../src/lib/stats';
import type { Doc } from '../src/lib/types';

type WebBar = { key: string | number; label: string; short?: string; y: number; empty?: boolean };
interface WebSvg {
  niceScale(ys: number[], gridLines?: number): { y0: number; y1: number; gridLines: number };
  barChart(o: { bars: WebBar[]; width?: number; height?: number; labelEvery?: number; fmtY?: (v: number) => string }): string;
}

let svg: WebSvg;
let web: DisplayImpl;

before(async () => {
  web = await loadWeb(); // installs the globals the web modules need
  svg = (await import('../../js/charts/svg.js')) as unknown as WebSvg;
});

const f1 = (n: number) => n.toFixed(1);

/** Bars as the web prints them: [slotX, slotW, x, y, w, h, fill] per bar group. */
function webBarRects(out: string) {
  const re = /<g class="bar" data-key="([^"]*)"[^>]*><rect x="([^"]+)" y="[^"]+" width="([^"]+)"[^>]*\/><rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" rx="1.5" fill="([^"]+)"/g;
  return [...out.matchAll(re)].map(m => ({ key: m[1], slotX: m[2], slotW: m[3], x: m[4], y: m[5], w: m[6], h: m[7], fill: m[8] }));
}
const webGridYs = (out: string) => [...out.matchAll(/<line x1="40" y1="([^"]+)" x2="[^"]+" y2="[^"]+" stroke="#2a2a2a"/g)].map(m => m[1]);
const webZeroY = (out: string) => out.match(/<line x1="40" y1="([^"]+)" x2="[^"]+" y2="[^"]+" stroke="#6b6b6b"/)?.[1] ?? null;
const webAxisLabels = (out: string) => [...out.matchAll(/text-anchor="middle">([^<]*)<\/text>/g)].map(m => m[1]);
const FILL = { pos: 'var(--accent)', neg: 'var(--negative)', empty: '#2a2a2a' } as const;

function assertSameGeometry(bars: Bar[], width: number, height: number, labelEvery: number, msg: string) {
  const out = svg.barChart({ bars: bars as WebBar[], width, height, labelEvery, fmtY: compactMoney });
  const lay = barLayout(bars, width, height, labelEvery);
  assert.ok(lay, msg);
  const wb = webBarRects(out);
  assert.equal(lay.bars.length, wb.length, `${msg}: bar count`);
  lay.bars.forEach((b, i) => {
    assert.deepStrictEqual(
      { key: String(b.key), slotX: f1(b.slotX), slotW: f1(b.slotW), x: f1(b.x), y: f1(b.y), w: f1(b.w), h: f1(b.h), fill: FILL[b.tone] },
      wb[i], `${msg}: bar ${i}`);
  });
  assert.deepStrictEqual(lay.grid.map(g => f1(g.y)), webGridYs(out), `${msg}: gridlines`);
  assert.equal(lay.zeroY === null ? null : f1(lay.zeroY), webZeroY(out), `${msg}: zero line`);
  assert.deepStrictEqual(lay.bars.map(b => b.axisLabel).filter((l): l is string => l !== null), webAxisLabels(out), `${msg}: axis labels`);
}

describe('bar chart: native === web svg.js', () => {
  it('niceScale over mixed, all-positive, all-negative, flat and tiny series', () => {
    const cases = [[0], [5], [-5], [12.5, -3], [1234, 87, -455], [0.03, 0.11], [-0.2, -9.7], [99999, 1], [3, 3, 3]];
    for (const ys of cases) for (const g of [3, 4, 5]) assert.deepStrictEqual(niceScale(ys, g), svg.niceScale(ys, g), `${ys} / ${g}`);
  });
  it('geometry for hand-made bar sets (negative axis, empty bars, label thinning)', () => {
    const mk = (ys: number[], empty: number[] = []): Bar[] => ys.map((y, i) => ({ key: i, label: `B${i}`, short: String(i), y, empty: empty.includes(i) }));
    assertSameGeometry(mk([10, -4, 0, 22.5]), 340, 210, 1, 'mixed');
    assertSameGeometry(mk([5, 6, 7], [1]), 300, 180, 1, 'empty bar');
    assertSameGeometry(mk([-1, -2, -3]), 340, 210, 1, 'all negative');
    assertSameGeometry(mk(Array.from({ length: 24 }, (_, i) => (i % 5) * 13 - 20), [2, 3]), 358, 180, 3, '24 hours');
    assertSameGeometry([{ key: 'x', label: 'Only', y: Number.NaN }], 200, 120, 1, 'non-finite y');
  });
  it('geometry for every report dimension on the corpus (net + rate)', () => {
    const doc = corpusDoc(web) as unknown as Doc;
    const all = endedSessions(doc);
    for (const dim of DIMENSIONS) {
      const buckets = dimensionBuckets(doc, dim, all, 'net');
      for (const metric of ['net', 'rate'] as const) {
        const bars: Bar[] = dim.hourly
          ? hourBars(buckets, metric)
          : buckets.filter(b => b.count > 0).map(b => ({ key: b.key, label: String(b.key), y: (metric === 'rate' ? b.rate : b.net) ?? 0 }));
        if (bars.length) assertSameGeometry(bars, 358, 210, dim.hourly ? 3 : 1, `${dim.id}/${metric}`);
      }
    }
  });
  it('compactMoney: thousands abbreviated, small values plain', () => {
    assert.equal(compactMoney(1500), '1.5k');
    assert.equal(compactMoney(-2250), '-2.25k');
    assert.equal(compactMoney(999), '999');
    assert.equal(compactMoney(12.5), '12.5');
  });
});

describe('hourBars', () => {
  it('24 bars, empty hours kept grey, values from the web hour buckets', () => {
    const doc = corpusDoc(web) as unknown as Doc;
    const all = endedSessions(doc);
    const dim = DIMENSIONS.find(d => d.hourly);
    assert.ok(dim);
    const nat = dimensionBuckets(doc, dim, all, 'net');
    const wDim = web.DIMENSIONS.find(d => d.id === dim.id);
    assert.ok(wDim);
    const wb = web.dimensionBuckets(corpusDoc(web), wDim, all, 'net');
    assert.equal(wb.length, 24);
    const bars = hourBars(nat, 'net');
    assert.equal(bars.length, 24);
    assert.deepStrictEqual(bars.map(b => b.short), Array.from({ length: 24 }, (_, i) => String(i)));
    bars.forEach((b, i) => {
      assert.equal(b.empty, wb[i].count === 0, `hour ${i} empty`);
      assert.ok(Math.abs(b.y - wb[i].net) < 1e-9, `hour ${i} net`);
    });
    hourBars(nat, 'rate').forEach((b, i) => assert.ok(Math.abs(b.y - (wb[i].rate ?? 0)) < 1e-9, `hour ${i} rate`));
  });
});
