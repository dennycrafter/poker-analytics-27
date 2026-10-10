// Category bar chart geometry for Reports (brief 5.13), ported from the web
// app's js/charts/svg.js (niceScale + barChart) and js/screens/reports.js
// (hourBars, compactMoney). Pure: the React component only draws what this
// returns, so the scale and bar maths are testable against the web in Node.
import { fmtNum } from './format';
import { hourRangeLabel } from './hours';
import type { Bucket, BucketKey } from './reports';

export interface Bar {
  key: BucketKey;
  label: string;
  /** Axis label under the bar (falls back to label). */
  short?: string;
  y: number;
  /** No sessions in this bucket: drawn grey and not tappable. */
  empty?: boolean;
}

export interface Scale { y0: number; y1: number; gridLines: number }

/** Round axis bounds to a 1 / 2 / 2.5 / 5 step that always includes zero. */
export function niceScale(ys: number[], gridLines = 4): Scale {
  let y0 = Math.min(0, ...ys), y1 = Math.max(0, ...ys);
  if (y1 === y0) { y1 += 1; y0 -= y0 === 0 ? 0 : 1; }
  const raw = (y1 - y0) / gridLines;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(v => v >= raw) || 10 * mag;
  y0 = Math.floor(y0 / step) * step; y1 = Math.ceil(y1 / step) * step;
  return { y0, y1, gridLines: Math.max(1, Math.round((y1 - y0) / step)) };
}

/** Axis labels: 1.2k above a thousand, plain number below. */
export function compactMoney(v: number): string {
  if (Math.abs(v) >= 1000) return fmtNum(v / 1000) + 'k';
  return fmtNum(v);
}

export type ReportMetric = 'net' | 'rate';

/** Hour-of-day bars: all 24 buckets, empty ones kept so the axis stays 0-23. */
export function hourBars(buckets: Bucket[], metric: ReportMetric): Bar[] {
  return buckets.map(b => ({
    key: b.key, label: hourRangeLabel(Number(b.key)), short: String(b.key),
    y: metric === 'rate' ? (b.rate ?? 0) : b.net, empty: b.count === 0,
  }));
}

export type BarTone = 'pos' | 'neg' | 'empty';

export interface BarGeom {
  key: BucketKey;
  label: string;
  value: number;
  tone: BarTone;
  /** Full-height tap target for the slot. */
  slotX: number; slotW: number;
  /** The drawn bar. */
  x: number; y: number; w: number; h: number;
  cx: number;
  /** Axis label, or null when thinned out by labelEvery. */
  axisLabel: string | null;
}

export interface BarLayout {
  width: number; height: number;
  padL: number; padR: number; padT: number; innerH: number;
  grid: { y: number; value: number }[];
  /** Solid zero line when the axis goes negative. */
  zeroY: number | null;
  bars: BarGeom[];
}

/** Same paddings, slot width (68%) and gridlines as the web barChart. */
export function barLayout(bars: Bar[], width: number, height: number, labelEvery = 1, gridLines = 4): BarLayout | null {
  if (!bars.length || width <= 0) return null;
  const padL = 40, padR = 8, padT = 12, padB = 24;
  const ys = bars.map(b => (Number.isFinite(b.y) ? b.y : 0));
  const sc = niceScale(ys, gridLines);
  const { y0, y1 } = sc;
  const innerW = width - padL - padR, innerH = height - padT - padB;
  const Y = (v: number) => padT + innerH - ((v - y0) / (y1 - y0)) * innerH;
  const slot = innerW / bars.length;
  const w = Math.max(2, slot * 0.68);
  const grid = Array.from({ length: sc.gridLines + 1 }, (_, i) => {
    const value = y0 + ((y1 - y0) * i) / sc.gridLines;
    return { y: Y(value), value };
  });
  return {
    width, height, padL, padR, padT, innerH, grid,
    zeroY: y0 < 0 ? Y(0) : null,
    bars: bars.map((b, i) => {
      const cx = padL + slot * i + slot / 2;
      const v = ys[i];
      const yTop = Y(Math.max(0, v)), yBot = Y(Math.min(0, v));
      return {
        key: b.key, label: b.label, value: v,
        tone: b.empty ? 'empty' : v < 0 ? 'neg' : 'pos',
        slotX: cx - slot / 2, slotW: slot,
        x: cx - w / 2, y: yTop, w, h: Math.max(0.8, yBot - yTop), cx,
        axisLabel: i % labelEvery === 0 ? (b.short ?? b.label) : null,
      };
    }),
  };
}
