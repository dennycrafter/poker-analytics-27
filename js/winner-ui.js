// Pure UI helpers for the "Am I a winner?" card (variance brief, iteration 2).
// No DOM, no store, no clock, no js/inference.js import: everything here runs
// under plain node (tests/it2-ui.test.mjs) and the statistical math itself
// stays in js/inference.js per the pinned contract (winrateStats,
// hoursToKnow, MIN_SESSIONS, NEED_MORE_MESSAGE). This module only prepares
// rows for winrateStats and turns its outputs into UI shapes.

import { netResult, sessionHours } from './stats.js';
import { fmtNum, fmtMoney } from './format.js';

// Rows for winrateStats over already-filtered CASH sessions, the pinned row
// shape [{p, h, bb, hands}]: profit, hours, big blind, hand count.
export function cashRows(doc, sessions) {
  return sessions.filter(s => s.kind === 'cash').map(s => ({
    p: netResult(doc, s),
    h: sessionHours(s),
    bb: Number(s.big_blind) || 0,
    hands: Number(s.hands_count) || 0,
  }));
}

// The brief-7 SD formula divides by each session's hours, so 0-hour sessions
// are excluded before calling winrateStats (same rule as netHourlyRate).
export function usableRows(rows) {
  return rows.filter(r => Number(r.h) > 0);
}

// SD/100 hands shows only when every cash session in the filter recorded hands.
export function hasAllHands(rows) {
  return rows.length > 0 && rows.every(r => Number(r.hands) > 0);
}

// BB mode divides every profit by its session's big blind, so the toggle only
// exists when every row has one.
export function bbAvailable(rows) {
  return rows.length > 0 && rows.every(r => Number(r.bb) > 0);
}

export const CONFIDENCE_DEFAULT = 95;
export const CONFIDENCE_MIN = 50;
export const CONFIDENCE_MAX = 99;

// Confidence percent input guard: whole numbers in [50, 99], anything else
// falls back to the 95 default. An empty field is "no input", not zero.
export function clampConfidence(pct) {
  if (pct === null || pct === undefined || pct === '') return CONFIDENCE_DEFAULT;
  const n = Math.round(Number(pct));
  if (!Number.isFinite(n)) return CONFIDENCE_DEFAULT;
  return Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, n));
}

// Accuracy input default: plus or minus 2 currency/hr, or 0.5 BB/hr in BB mode.
export function accuracyDefault(unit) {
  return unit === 'bb' ? 0.5 : 2;
}

// Compact rate for sentences and intervals. Money rates round to whole units
// (brief example: "between -$1/hr and $11/hr" from -0.77 and 10.77); BB keeps
// decimals because a BB/hr is small. Currency spelled out like fmtMoney.
export function fmtRateShort(v, unit, currency = 'EUR') {
  if (!Number.isFinite(Number(v))) return '--';
  if (unit === 'bb') return fmtNum(v) + ' BB/hr';
  const r = Math.round(v);
  return (r < 0 ? '-' : '') + currency + ' ' + fmtNum(Math.abs(r)) + '/hr';
}

// Full-precision rate for card values, matching the metric units "rate"
// (fmtMoney + "/h") and "bbrate" (fmtNum + " BB/h").
export function fmtRateFull(v, unit, currency = 'EUR') {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '--';
  if (unit === 'bb') return fmtNum(v) + ' BB/h';
  return fmtMoney(v, currency) + '/h';
}

// The one plain sentence under the card. `confidence` is a whole percent (95),
// `ci` is [lo, hi] from winrateStats in the chosen unit.
export function ciSentence({ confidence, ci, unit = 'usd', currency = 'EUR' }) {
  const pct = clampConfidence(confidence);
  const [lo, hi] = Array.isArray(ci) ? ci : [NaN, NaN];
  return 'Based on your filtered sessions, you can be ' + pct + '% sure ' +
    'your true winrate is between ' + fmtRateShort(lo, unit, currency) +
    ' and ' + fmtRateShort(hi, unit, currency) + '.';
}

// Whole percent for "Chance you're a winner: N%". Null when the input is not
// a finite probability.
export function chancePct(chanceWinner) {
  const p = Number(chanceWinner);
  return Number.isFinite(p) ? Math.round(p * 100) : null;
}

// Geometry for the bell curve of the possible true winrate: a normal density
// centered on the observed winrate with the standard error as its spread.
// Returns path strings and key x positions for the screen's SVG, or null when
// there is nothing to draw (no usable standard error). Pure: numbers in,
// strings and numbers out.
//
// The curve is drawn over wr +/- 3 se, extended so the break-even line at 0
// and both interval bounds are always inside the picture (plus a 0.5 se
// margin), so the shaded interval and the zero line stay visible.
export function bellCurveGeom({ wr, se, ci, width = 340, height = 160 }) {
  wr = Number(wr);
  se = Number(se);
  if (!Number.isFinite(wr) || !(se > 0)) return null;
  const lo = Array.isArray(ci) && Number.isFinite(Number(ci[0])) ? Number(ci[0]) : wr - 1.96 * se;
  const hi = Array.isArray(ci) && Number.isFinite(Number(ci[1])) ? Number(ci[1]) : wr + 1.96 * se;
  const SPAN = 3;
  const MARGIN = 0.5;
  const anchors = [wr - SPAN * se, wr + SPAN * se, 0, lo, hi];
  const x0 = Math.min(...anchors) - MARGIN * se;
  const x1 = Math.max(...anchors) + MARGIN * se;
  const N = 60;
  const y = x => Math.exp(-0.5 * ((x - wr) / se) ** 2);

  const padL = 8, padR = 8, padT = 8, padB = 16;
  const innerW = width - padL - padR, innerH = height - padT - padB;
  const X = v => padL + ((v - x0) / (x1 - x0)) * innerW;
  const Y = v => padT + innerH * (1 - v); // density is normalized to peak 1

  const pts = [];
  for (let i = 0; i <= N; i++) {
    const x = x0 + ((x1 - x0) * i) / N;
    pts.push({ x, y: y(x) });
  }
  const curvePath = pts.map((p, i) => (i ? 'L' : 'M') + X(p.x).toFixed(1) + ' ' + Y(p.y).toFixed(1)).join(' ');

  // Shaded band under the curve between the interval bounds, with exact edges.
  let bandPath = null;
  if (hi > lo) {
    const inner = pts.filter(p => p.x > lo && p.x < hi);
    bandPath = 'M' + X(lo).toFixed(1) + ' ' + Y(0).toFixed(1) +
      ' L' + X(lo).toFixed(1) + ' ' + Y(y(lo)).toFixed(1) +
      inner.map(p => ' L' + X(p.x).toFixed(1) + ' ' + Y(p.y).toFixed(1)).join('') +
      ' L' + X(hi).toFixed(1) + ' ' + Y(y(hi)).toFixed(1) +
      ' L' + X(hi).toFixed(1) + ' ' + Y(0).toFixed(1) + ' Z';
  }

  return {
    width, height, x0, x1, points: pts, curvePath, bandPath,
    zeroX: +X(0).toFixed(1), loX: +X(lo).toFixed(1), hiX: +X(hi).toFixed(1),
    yTop: +Y(1).toFixed(1), yBase: +Y(0).toFixed(1), padL, padR, padT, padB,
  };
}
