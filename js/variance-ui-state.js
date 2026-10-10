// Pure state and derivation helpers for the Variance screen (brief sections
// 4-6). No DOM, no store, no clock: everything takes plain data, and the
// simulation contracts (js/variance-cash.js, js/variance-tour.js) are injected
// as functions where shaping needs them, so tests run without the parallel
// math modules or a browser. js/screens/variance.js owns wiring; the math
// modules own simulation; js/variance.js supplies the seeded RNG machinery.

import { mulberry32, normalSampler } from './variance.js';
import { cashOnly, tournamentsOnly, sessionNet, sessionHours, effectiveHands, roi, avgBuyIn } from './stats.js';
import { fmtNum } from './format.js';

// ---------- tabs and small state ----------

export const TABS = [
  { key: 'cash', label: 'Cash' },
  { key: 'tournaments', label: 'Tournaments' },
  { key: 'year', label: 'Your Year' },
];

export function normalizeTab(tab) {
  return TABS.some(t => t.key === tab) ? tab : 'cash';
}

// Deterministic seed bump for "Re-roll" buttons (same pattern as the old
// variance screen: mix the seed, keep it small for display).
export function nextSeed(seed) {
  return (Math.imul((Number(seed) >>> 0) + 1, 2654435761) >>> 0) % 1000000;
}

// ---------- brief-7 moments over a filtered cash session list ----------

// WR = sum(p) / sum(h); SD = sqrt( sum( (p - WR*h)^2 / h ) / (k - 1) ).
// Returns null for k < 2 (SD needs k-1 > 0) or no hours at all.
export function moments(pairs) {
  if (!Array.isArray(pairs) || pairs.length < 2) return null;
  let sp = 0, sh = 0;
  for (const { p, h } of pairs) {
    if (!(Number.isFinite(p) && Number.isFinite(h) && h > 0)) return null;
    sp += p; sh += h;
  }
  if (!(sh > 0)) return null;
  const wr = sp / sh;
  let ss = 0;
  for (const { p, h } of pairs) ss += ((p - wr * h) ** 2) / h;
  return { wr, sd: Math.sqrt(ss / (pairs.length - 1)), k: pairs.length, hours: sh };
}

// Unit variants of the same filtered cash list: $/hour, BB/hour, $/100 hands,
// BB/100 hands. Each is null when the sessions it needs are missing. A hand
// count the app estimated for the user still counts as a count.
export function cashStats(doc, sessions) {
  const rows = cashOnly(sessions || [])
    .map(s => {
      const hands = effectiveHands(s);
      return {
        p: sessionNet(doc, s), h: sessionHours(s),
        bb: Number(s.big_blind) || null,
        hands: Number.isFinite(hands) && hands > 0 ? hands : null,
      };
    })
    .filter(r => r.h > 0);
  const usd = moments(rows.map(({ p, h }) => ({ p, h })));
  const bbRows = rows.filter(r => r.bb);
  const handRows = rows.filter(r => r.hands);
  const bothRows = rows.filter(r => r.bb && r.hands);
  const bb = moments(bbRows.map(({ p, h, bb }) => ({ p: p / bb, h })));
  const h100 = moments(handRows.map(({ p, hands }) => ({ p, h: hands / 100 })));
  const bb100 = moments(bothRows.map(({ p, h, bb, hands }) => ({ p: p / bb, h: hands / 100 })));
  let hands = 0, handsHours = 0;
  for (const r of handRows) { hands += r.hands; handsHours += r.h; }
  return {
    n: rows.length,
    usd, bb, h100, bb100,
    hours: usd ? usd.hours : 0,
    hands: handRows.length ? hands : null,
    hasHands: Boolean(h100 && usd && h100.k === usd.k),
    hasBB: Boolean(bb && usd && bb.k === usd.k),
    handsPerHour: handsHours > 0 ? hands / handsHours : null,
  };
}

// Picks the moments variant matching the tab's unit mode; null when the
// filtered data cannot support it (the screen then shows a plain message).
export function pickCashStats(stats, unit, volumeUnit) {
  if (!stats) return null;
  if (volumeUnit === 'hands') return unit === 'BB' ? stats.bb100 : stats.h100;
  return unit === 'BB' ? stats.bb : stats.usd;
}

// Most common big blind among the filtered cash sessions, for the BB-size
// input in BB mode.
export function commonBB(doc, sessions) {
  const m = new Map();
  for (const s of cashOnly(sessions || [])) {
    const bb = Number(s.big_blind);
    if (!(bb > 0)) continue;
    m.set(bb, (m.get(bb) || 0) + 1);
  }
  let best = null;
  for (const [bb, count] of [...m.entries()].sort((a, b) => a[0] - b[0])) {
    if (!best || count > best[1]) best = [bb, count];
  }
  return best ? best[0] : null;
}

export function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export const CASH_NEED_MESSAGE = 'Need at least 2 filtered cash sessions with recorded hours.';

// Cash tab prefill from the stats variant the user is looking at. Volume is
// total hours (hours mode) or total hands (hands mode).
export function cashPrefill(stats, unit = '$', volumeUnit = 'hours') {
  const m = pickCashStats(stats, unit, volumeUnit);
  if (!m) return null;
  return {
    wr: round2(m.wr),
    sd: round2(m.sd),
    volume: round2(volumeUnit === 'hands' ? stats.hands || 0 : stats.hours),
    k: m.k,
  };
}

// "Use my stats" for the Tournaments tab. Average field comes from the
// entries count recorded per tournament when present.
export function tourStats(doc, sessions) {
  const t = tournamentsOnly(sessions || []);
  if (!t.length) return null;
  const r = roi(doc, t);
  const fields = t.map(s => Number(s.entries)).filter(Number.isFinite);
  return {
    n: t.length,
    avgBuyIn: avgBuyIn(doc, t),
    avgField: fields.length ? fields.reduce((a, b) => a + b, 0) / fields.length : null,
    roiPct: r === null ? null : r * 100,
  };
}

// ---------- simulate() output shaping ----------

// Histogram buckets for the tournament distribution chart: even buckets over
// the finite value range, returned in barChart bar shape (y = count).
export function binsOf(values, buckets = 16) {
  const xs = (values || []).filter(Number.isFinite);
  if (!xs.length) return [];
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const width = (hi - lo) / buckets || 1;
  const counts = Array.from({ length: buckets }, () => 0);
  for (const x of xs) {
    const i = Math.min(buckets - 1, Math.max(0, Math.floor((x - lo) / width)));
    counts[i]++;
  }
  return counts.map((count, i) => {
    const a = lo + i * width;
    return {
      key: i,
      label: `${compactNum(a)} to ${compactNum(a + width)}`,
      short: compactNum(a),
      count,
      y: count,
    };
  });
}

function compactNum(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return fmtNum(v / 1e6) + 'M';
  if (a >= 1e3) return fmtNum(Math.round(v / 100) / 10) + 'k';
  return fmtNum(Math.round(v));
}

// Linear-interpolated quantile of an unsorted list; null when empty.
export function quantile(values, p) {
  const xs = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const pos = (xs.length - 1) * Math.min(1, Math.max(0, p));
  const i = Math.floor(pos);
  const frac = pos - i;
  return i + 1 < xs.length ? xs[i] + (xs[i + 1] - xs[i]) * frac : xs[i];
}

// Tournament risk of ruin from per-run minimum running totals (the simulate()
// contract's minRunning list): RoR(B) = share of runs whose running total
// ever drops below -B. Bankroll for risk r = minus the r-quantile.
export function tourRor(minRunning, B) {
  const xs = (minRunning || []).filter(Number.isFinite);
  if (!xs.length || !Number.isFinite(B)) return null;
  return xs.filter(m => m < -B).length / xs.length;
}

export function tourBankrollFor(minRunning, r) {
  const q = quantile(minRunning, r);
  if (q === null) return null;
  return Math.max(0, -q);
}

// ---------- projection chart data ----------

// Two-sided 95% normal deviate: the brief fixes the projection band at 95%.
export const Z95 = 1.959963984540054;

// EV line and 95% band over the projection: mean wr*t, SD sd*sqrt(t).
export function bandCurve({ wr, sd, hoursT, steps = 20 }) {
  if (!(Number.isFinite(wr) && Number.isFinite(sd) && sd >= 0 && hoursT > 0)) return [];
  const n = Math.max(2, steps);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = (hoursT * i) / n;
    const ev = wr * t;
    const spread = Z95 * sd * Math.sqrt(t);
    out.push({ t, ev, lo: ev - spread, hi: ev + spread });
  }
  return out;
}

// Seeded sample paths for the projection chart: `count` walks of `steps`
// draws from Normal(wr, sd) per unit. Same seed, same paths, byte for byte.
export function samplePaths({ wr, sd, hoursT, count = 20, seed = 0, steps = 20 }) {
  if (!(Number.isFinite(wr) && Number.isFinite(sd) && sd >= 0 && hoursT > 0) || count < 1) return [];
  const normal = normalSampler(mulberry32(Number(seed) >>> 0));
  const n = Math.max(2, steps);
  const stepH = hoursT / n;
  const mean = wr * stepH;
  const stepSd = sd * Math.sqrt(stepH);
  const out = [];
  for (let p = 0; p < count; p++) {
    const pts = [{ t: 0, v: 0 }];
    let cum = 0;
    for (let i = 1; i <= n; i++) {
      cum += mean + stepSd * normal();
      pts.push({ t: (hoursT * i) / n, v: cum });
    }
    out.push(pts);
  }
  return out;
}

// ---------- percentile shaping ----------

// Percentile object (e.g. {1: v, 5: v, ...}) -> display rows in a fixed order.
export function percentileRows(pct, keys) {
  if (!pct) return [];
  return keys.map(k => ({ label: `${k}%`, value: pct[k] }));
}

// Percentile object -> [{p, value}] sorted by p, for the distribution ladder.
export function percentileLadder(pct) {
  if (!pct) return [];
  return Object.keys(pct)
    .map(k => ({ p: Number(k), value: pct[k] }))
    .filter(x => Number.isFinite(x.p) && Number.isFinite(x.value))
    .sort((a, b) => a.p - b.p);
}

// Downswing contract output -> size / length display rows. The downswings()
// contract uses named percentile keys (p5, p25, p50, p75, p95).
export function downswingRows(d) {
  if (!d || !d.size || !d.lengthHours) return null;
  const keys = ['p5', 'p25', 'p50', 'p75', 'p95'];
  const rows = obj => keys.map(k => ({ label: `${Number(k.slice(1))}%`, value: obj[k] }));
  return { size: rows(d.size), length: rows(d.lengthHours) };
}

// P(downswing of at least x) from the simulated percentile ladder: piecewise
// linear through (0, 1), (p5, .95), (p25, .75), (p50, .5), (p75, .25),
// (p95, .05); above p95 the tail decays linearly to 0 at p95 + (p95 - p50).
// The contract returns percentiles, not per-path shares, so this is the
// honest interpolation between anchors.
export function downswingChance(x, size) {
  if (!size || !Number.isFinite(x) || x < 0) return null;
  if (x === 0) return 1;
  const anchors = [[0, 1], [size.p5, 0.95], [size.p25, 0.75], [size.p50, 0.5], [size.p75, 0.25], [size.p95, 0.05]];
  for (let i = 1; i < anchors.length; i++) {
    const [x0, y0] = anchors[i - 1];
    const [x1, y1] = anchors[i];
    if (x <= x1) {
      if (!(x1 > x0)) continue; // zero-width anchor gap: carry the previous y
      return clamp01(y0 + ((x - x0) / (x1 - x0)) * (y1 - y0));
    }
  }
  const span = Math.max(0, size.p95 - size.p50);
  if (!(span > 0)) return 0;
  return clamp01(0.05 * (1 - (x - size.p95) / span));
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// ---------- downswing horizons ----------

export const MIN_HPM = 10;
export const HANDS_PER_HOUR_FALLBACK = 30; // matches the app's own hand estimate

export function floorHpm(hpm) {
  return Math.max(MIN_HPM, Number(hpm) || 0);
}

// Total volume per horizon in the step units the downswings() contract expects
// (hours, or 100-hand units when the projection runs on hand counts).
export function downswingHorizons({ hpm, volumeUnit = 'hours', handsPerHour = 0 }) {
  const h = floorHpm(hpm);
  if (volumeUnit === 'hands') {
    const hph = handsPerHour > 0 ? handsPerHour : HANDS_PER_HOUR_FALLBACK;
    const per = (h * hph) / 100; // 100-hand steps per month
    return { month: per, quarter: per * 3, year: per * 12 };
  }
  return { month: h, quarter: h * 3, year: h * 12 };
}

// ---------- bankroll block (risk of ruin) ----------

// Rows for the "bankroll needed" table plus your current bankroll's risk of
// ruin. rorFn / bankrollForFn are the js/variance-cash.js contract functions
// (ror(B, wr, sd), bankrollFor(r, wr, sd)), injected so this module stays
// independent of the parallel math lanes.
export function rorRows({ wr, sd, bankroll, rorFn, bankrollForFn }) {
  if (!(Number.isFinite(bankroll) && bankroll > 0) || !Number.isFinite(wr) || !Number.isFinite(sd) || !(sd > 0)) return null;
  return {
    current: typeof rorFn === 'function' ? rorFn(bankroll, wr, sd) : null,
    table: [0.5, 0.2, 0.05, 0.01].map(r => ({
      label: `${r * 100}%`,
      risk: r,
      bankroll: typeof bankrollForFn === 'function' ? bankrollForFn(r, wr, sd) : null,
    })),
  };
}

// Smallest B with rorFn(B) <= target. Simulated tournament RoR falls as the
// bankroll grows, so a bisection over [0, hi] finds the crossing; null when
// even a huge bankroll cannot get under the target.
export function bankrollForRorTarget(rorFn, target, { hi = 1000, iterations = 40 } = {}) {
  if (typeof rorFn !== 'function' || !(target > 0) || target >= 1) return null;
  let lo = 0;
  let top = hi > 0 ? hi : 1000;
  let guard = 0;
  while (rorFn(top) > target && top < 1e12 && guard++ < 60) top *= 2;
  if (rorFn(top) > target) return null;
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + top) / 2;
    if (rorFn(mid) > target) lo = mid; else top = mid;
  }
  return (lo + top) / 2;
}

// ---------- tournament type inputs ----------

// One variance type. UI fields are percents (rakePct, percentPaidPct, roiPct);
// the simulate() contract boundary does the fraction conversions.
export function defaultTourType() {
  return { name: 'Type 1', buyin: 50, rakePct: 10, entries: 200, percentPaidPct: 15, roiPct: 0, events: 500 };
}

export function defaultTourTypes() {
  return [defaultTourType()];
}

export function addTourType(types) {
  const list = normalizeTourTypes(types);
  return [...list, { ...defaultTourType(), name: `Type ${list.length + 1}` }];
}

const fin = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

export function normalizeTourType(t, i = 0) {
  const s = t && typeof t === 'object' ? t : {};
  return {
    name: typeof s.name === 'string' && s.name.trim() ? s.name.trim().slice(0, 40) : `Type ${i + 1}`,
    buyin: Math.max(0, fin(s.buyin, 50)),
    rakePct: Math.min(100, Math.max(0, fin(s.rakePct, 10))),
    entries: Math.max(2, Math.round(fin(s.entries, 200))),
    percentPaidPct: Math.min(100, Math.max(0, fin(s.percentPaidPct, 15))),
    roiPct: fin(s.roiPct, 0),
    events: Math.max(1, Math.round(fin(s.events, 500))),
  };
}

export function normalizeTourTypes(list) {
  const arr = Array.isArray(list) ? list : [];
  return arr.slice(0, 8).map((t, i) => normalizeTourType(t, i));
}

// ---------- tournament simulate() output shaping ----------

// simulate().paths holds 20 sampled paths; accept running-total numbers
// (one per checkpoint) or {x, y} points, and return [{t, v}].
export function normalizePath(path) {
  if (!Array.isArray(path) || !path.length) return [];
  if (typeof path[0] === 'number') return path.map((v, i) => ({ t: i + 1, v }));
  return path.map(pt => {
    const o = pt && typeof pt === 'object' ? pt : {};
    const t = pickNum(o.t, pickNum(o.x, pickNum(o.unit, 0)));
    const v = pickNum(o.v, pickNum(o.y, pickNum(o.value, pickNum(o.bankroll, 0))));
    return { t, v };
  });
}

function pickNum(a, b) {
  return Number.isFinite(Number(a)) ? Number(a) : b;
}

// ---------- year tab shaping ----------

const MONTHS3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// One row per simulated month with the luck flags from brief section 6:
// z > +1 lucky, z < -1 unlucky.
export function yearRows(year) {
  const months = year && Array.isArray(year.months) ? year.months : [];
  return months.slice(0, 12).map((m, i) => {
    const z = m && Number.isFinite(m.z) ? m.z : null;
    return {
      label: MONTHS3[i] || `Month ${i + 1}`,
      result: m ? m.result : null,
      ev: m ? m.ev : null,
      z,
      luck: z === null ? null : z > 1 ? 'lucky' : z < -1 ? 'unlucky' : null,
    };
  });
}

// Luckiest / unluckiest month recomputed from the z-scores, so the screen does
// not depend on how the contract indexes its own luckiest/unluckiest fields.
export function yearExtremes(year) {
  const months = year && Array.isArray(year.months) ? year.months : [];
  let li = null, ui = null;
  months.forEach((m, i) => {
    if (!m || !Number.isFinite(m.z)) return;
    if (li === null || m.z > months[li].z) li = i;
    if (ui === null || m.z < months[ui].z) ui = i;
  });
  return {
    luckiest: li,
    unluckiest: ui,
    luckiestLabel: li === null ? null : MONTHS3[li] || null,
    unluckiestLabel: ui === null ? null : MONTHS3[ui] || null,
  };
}

// ---------- saved-state merge (localStorage persistence) ----------

export const DEFAULT_CASH_INPUTS = Object.freeze({
  wr: 10, sd: 80, volume: 500, volumeUnit: 'hours', unit: '$',
  bankroll: 2000, bbSize: 1, x: null, hpm: null,
});

// Optional numeric fields: absent stays null instead of becoming 0
// (Number(null) === 0 would silently fill inputs with zeros).
const opt = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

// Merges saved UI state over defaults so new fields survive old saves.
export function mergeUiState(saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const cash = { ...DEFAULT_CASH_INPUTS, ...(s.cash || {}) };
  cash.volumeUnit = cash.volumeUnit === 'hands' ? 'hands' : 'hours';
  cash.unit = cash.unit === 'BB' ? 'BB' : '$';
  for (const k of ['wr', 'sd', 'volume', 'bankroll', 'bbSize']) cash[k] = fin(cash[k], DEFAULT_CASH_INPUTS[k]);
  cash.x = opt(cash.x);
  cash.hpm = opt(cash.hpm);
  const tour = s.tournaments && typeof s.tournaments === 'object' ? s.tournaments : {};
  return {
    tab: normalizeTab(s.tab),
    cash,
    tournaments: {
      types: tour.types !== undefined ? normalizeTourTypes(tour.types) : defaultTourTypes(),
      bankroll: fin(tour.bankroll, 2000),
      statsN: tour.statsN === null || tour.statsN === undefined ? null : fin(tour.statsN, null),
    },
    year: { hpm: opt(s.year && s.year.hpm) },
    seeds: {
      cash: fin(s.seeds && s.seeds.cash, 27),
      tour: fin(s.seeds && s.seeds.tour, 27),
      year: fin(s.seeds && s.seeds.year, 27),
    },
  };
}
