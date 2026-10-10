// Tournament variance module (Iteration 5 of the variance + import brief,
// formulas in its section 7). Pure module: no DOM, no store, no clock.
//
// Three entry points:
//   payoutCurve({entries, rakePct, percentPaid})
//       Prize money per paid place, in BUY-IN UNITS, plus the pool and the
//       number of paid places. Shape documented at the constants below.
//   solveSkill({roi, buyIn, entries, percentPaid, rakePct})
//       Skill parameter s: finish odds for place j are proportional to
//       exp(-s * j / entries) over the whole field, solved by bisection so
//       the expected profit per event is exactly roi * buyIn. Positive for a
//       winning player, 0 for a break-even one, negative for a losing one.
//   simulate({types, runs, seed})
//       Seeded Monte Carlo over a schedule of tournament types: each event
//       draws a finish place from that type's skill distribution and adds
//       prize - buyIn to the running total. Returns aggregate stats,
//       percentiles, 20 sample paths and risk-of-ruin curves for the chosen
//       schedule and for a 2000-event long run.
//
// Every draw comes from mulberry32 (the same PRNG as js/variance.js), so the
// same inputs + seed give byte-identical output (tests and the screen's
// "Re-roll" rely on it).

import { mulberry32, quantileSorted } from './variance.js';

// ---------- limits and shape constants ----------

export const LIMITS = Object.freeze({
  maxField: 100000,        // entries per type (matches variance.js field cap)
  maxRuns: 100000,         // Monte Carlo runs
  maxEventsPerType: 20000, // events of one type in the chosen schedule
  maxWork: 2e8,            // runs * (schedule + long run) draws, like variance.js maxSteps
  maxLongRunEvents: 100000,
});

const DEFAULT_RUNS = 10000;    // brief section 5: 10,000 runs
const DEFAULT_SEED = 27;       // same default seed as js/variance.js
const DEFAULT_LONG_RUN = 2000; // brief section 5: long-run horizon
const SAMPLE_PATHS = 20;       // paths returned for the projection chart
const PCTL_KEYS = [1, 5, 10, 25, 50, 75, 90, 95, 99];

// Payout shape (the exact curve, recorded in docs/ASSUMPTIONS.md):
//   paid = round(entries * percentPaid), clamped to [1, entries];
//   pool = entries * (1 - rakePct) buy-ins.
//   1st place share s1 = 0.22 + 0.43 * exp(-(paid - 2) / 3.2), capped at 0.65:
//   65% for a 2-place payout (heads-up style), about 53% for a 9-man SNG
//   (3 paid), fading to 22% for big fields, where the brief asks for 20-25%.
//   Min-cash anchor: 1.75 buy-ins (inside the brief's 1.5-2 band).
//   Places in between follow w(j) = exp(-a * (j-1)^p) normalized to the pool,
//   with a = log(s1 / minShare) / (paid-1)^p and p solved by bisection so the
//   weights sum to 1/s1, which lands the 1st-place share exactly on s1 and
//   the min-cash on the anchor. Pools too small to fund both anchors (tiny
//   fields) fall back to a flat tail: 1st takes s1, the rest split (1 - s1)
//   evenly.
const FIRST_SHARE_BASE = 0.22;
const FIRST_SHARE_BOOST = 0.43;
const FIRST_SHARE_DECAY = 3.2;
const FIRST_SHARE_CAP = 0.65;
const MIN_CASH_BUYS = 1.75;
const SKILL_S_BOUND = 60;      // |s| cap: past this the distribution is degenerate

// ---------- small helpers ----------

function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

// First index of an ascending Float64Array whose value is strictly greater
// than v (upper bound). length - that index = count of values > v.
function upperBound(sorted, v) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= v) lo = mid + 1; else hi = mid; }
  return lo;
}

function countBelow(values, v) {
  let c = 0;
  for (let i = 0; i < values.length; i++) if (values[i] < v) c++;
  return c;
}

// ---------- validation ----------

// Returns null when valid, else a user-facing message (no em dashes).
function curveError(entries, rakePct, percentPaid) {
  if (!(Number.isInteger(entries) && entries >= 2 && entries <= LIMITS.maxField)) {
    return `Field size must be a whole number from 2 to ${LIMITS.maxField}.`;
  }
  if (!(Number.isFinite(rakePct) && rakePct >= 0 && rakePct < 1)) return 'Rake must be from 0% to under 100%.';
  if (!(Number.isFinite(percentPaid) && percentPaid > 0 && percentPaid <= 1)) return 'Percent paid must be between 0% and 100%.';
  return null;
}

// ---------- payout curve ----------

// Prize money per paid place, in buy-in units. Returns { prizes, pool, paid }:
// prizes[j-1] is what place j wins (buy-ins), pool is the whole pool in
// buy-ins, paid the number of paid places. Multiply by the buy-in for currency.
export function payoutCurve({ entries, rakePct = 0, percentPaid } = {}) {
  const err = curveError(entries, rakePct, percentPaid);
  if (err) throw new RangeError(err);
  const rake = clamp(rakePct, 0, 0.99);
  const paid = clamp(Math.round(entries * percentPaid), 1, entries);
  const pool = entries * (1 - rake); // buy-in units
  if (paid === 1) return { prizes: [pool], pool, paid }; // winner takes all

  const s1 = Math.min(FIRST_SHARE_CAP, FIRST_SHARE_BASE + FIRST_SHARE_BOOST * Math.exp(-(paid - 2) / FIRST_SHARE_DECAY));
  if (paid === 2) return { prizes: [pool * s1, pool * (1 - s1)], pool, paid }; // 65/35 split

  const flatShare = (1 - s1) / (paid - 1); // even split of what 1st leaves
  const minShare = MIN_CASH_BUYS / pool;   // min-cash anchor as a share of the pool
  if (minShare >= flatShare) {
    const prizes = [pool * s1];
    for (let k = 1; k < paid; k++) prizes.push(pool * flatShare);
    return { prizes, pool, paid };
  }

  // Both anchors fit: w(j) = exp(-a * (j-1)^p) with a = L / (paid-1)^p and
  // L = log(s1 / minShare); p is solved so the weights sum to 1/s1.
  const L = Math.log(s1 / minShare);
  const p = solveShapeExponent(paid, L, s1);
  const a = L / Math.pow(paid - 1, p);
  const w = [];
  let W = 0;
  for (let j = 1; j <= paid; j++) { const v = Math.exp(-a * Math.pow(j - 1, p)); w.push(v); W += v; }
  const prizes = w.map((v) => (pool * v) / W);
  return { prizes, pool, paid };
}

// F(p) = sum of weights - 1/s1 with the min-cash anchor folded into a.
// Each weight exp(-L * ((j-1)/(paid-1))^p) increases with p, so F is strictly
// increasing for paid >= 3 and bisection is exact.
function solveShapeExponent(paid, L, s1) {
  const target = 1 / s1;
  const sumAt = (p) => {
    const a = L / Math.pow(paid - 1, p);
    let sum = 0;
    for (let j = 1; j <= paid; j++) sum += Math.exp(-a * Math.pow(j - 1, p));
    return sum;
  };
  let lo = 0.05, hi = 3;
  if (sumAt(lo) >= target) return lo;
  if (sumAt(hi) <= target) return 1; // unreachable: fall back to a geometric curve
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (sumAt(mid) < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------- skill solve ----------

// Finish probabilities over places 1..field: P(j) proportional to
// exp(-s * j / field), scaled so the largest weight is 1 before normalizing
// (no overflow for extreme s). Reuses `out` when given so bisection does not
// allocate.
function skillProbs(s, field, out) {
  // Largest weight sits at place 1 for s >= 0 and at the last place for s < 0.
  const shift = s >= 0 ? -s / field : -s;
  const w = out || new Float64Array(field);
  let Z = 0;
  for (let j = 1; j <= field; j++) { const v = Math.exp((-s * j) / field - shift); w[j - 1] = v; Z += v; }
  for (let j = 0; j < field; j++) w[j] /= Z;
  return w;
}

// Expected profit per event in buy-in units for skill s (curve in buy-in
// units, probabilities from skillProbs).
function evPerEventBuys(s, curve, field, probsOut) {
  const probs = skillProbs(s, field, probsOut);
  let ev = 0;
  for (let j = 1; j <= curve.paid; j++) ev += probs[j - 1] * curve.prizes[j - 1];
  return ev - 1; // every entry pays one buy-in
}

// Skill parameter s (a number) for one tournament type. Bisection on
// [-SKILL_S_BOUND, SKILL_S_BOUND]; EV is strictly increasing in s because
// higher s shifts finish probability toward better-paying places. If the
// target ROI is out of reach (above roughly 1st prize minus the buy-in) s
// saturates at the bound instead of failing.
export function solveSkill({ roi, buyIn, entries, percentPaid, rakePct = 0 } = {}) {
  if (!(Number.isFinite(buyIn) && buyIn > 0)) throw new RangeError('Buy-in must be greater than 0.');
  if (!(Number.isFinite(roi) && roi > -1)) throw new RangeError('ROI must be greater than -100%.');
  const err = curveError(entries, rakePct, percentPaid);
  if (err) throw new RangeError(err);
  // s is scale-free: the EV target roi * buyIn is roi in buy-in units.
  const curve = payoutCurve({ entries, rakePct, percentPaid });
  const probs = new Float64Array(entries);
  const evAt = (s) => evPerEventBuys(s, curve, entries, probs);
  let lo = -SKILL_S_BOUND, hi = SKILL_S_BOUND;
  if (evAt(lo) >= roi) return lo;
  if (evAt(hi) <= roi) return hi;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (evAt(mid) < roi) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------- per-type profile ----------

// Validates one schedule entry and derives its analytic stats: the payout
// curve, the solved skill parameter, the finish distribution and its moments.
// Internal: simulate consumes this; only the public row lands in perType.
function buildType(raw, index) {
  if (!raw || typeof raw !== 'object') throw new RangeError(`Type ${index + 1}: expected an object.`);
  const buyIn = Number(raw.buyin ?? raw.buyIn);
  const rakePct = raw.rakePct === undefined ? 0 : Number(raw.rakePct);
  const percentPaid = raw.percentPaid === undefined ? 0.15 : Number(raw.percentPaid);
  const roi = raw.roi === undefined ? 0 : Number(raw.roi);
  const events = raw.events === undefined ? 0 : Number(raw.events);
  if (!(Number.isFinite(buyIn) && buyIn > 0)) throw new RangeError(`Type ${index + 1}: buy-in must be greater than 0.`);
  if (!(Number.isFinite(roi) && roi > -1)) throw new RangeError(`Type ${index + 1}: ROI must be greater than -100%.`);
  if (!(Number.isInteger(events) && events >= 0 && events <= LIMITS.maxEventsPerType)) {
    throw new RangeError(`Type ${index + 1}: events must be a whole number from 0 to ${LIMITS.maxEventsPerType}.`);
  }
  const err = curveError(raw.entries, rakePct, percentPaid);
  if (err) throw new RangeError(`Type ${index + 1}: ${err}`);

  const entries = raw.entries;
  const curve = payoutCurve({ entries, rakePct, percentPaid });
  const s = solveSkill({ roi, buyIn, entries, percentPaid, rakePct });
  const probs = skillProbs(s, entries);

  // Moments over every place (prize 0 past paid): EV, E[X^2], cash rate.
  let ev = 0, ex2 = 0, itm = 0;
  for (let j = 1; j <= entries; j++) {
    const x = (j <= curve.paid ? curve.prizes[j - 1] : 0) - 1; // net, buy-in units
    const p = probs[j - 1];
    ev += p * x;
    ex2 += p * x * x;
    if (j <= curve.paid) itm += p;
  }
  const variance = Math.max(0, ex2 - ev * ev);

  const cdf = new Float64Array(entries + 1);
  for (let j = 1; j <= entries; j++) cdf[j] = cdf[j - 1] + probs[j - 1];
  cdf[entries] = 1; // float drift guard so every draw lands on a place

  return {
    index, buyIn, entries, rakePct, percentPaid, roi, events,
    paid: curve.paid, pool: curve.pool * buyIn, firstPrize: curve.prizes[0] * buyIn,
    skillS: s, itmPct: itm, evPerEvent: ev * buyIn, sdPerEvent: Math.sqrt(variance) * buyIn,
    prizeCurrency: Float64Array.from(curve.prizes, (v) => v * buyIn),
    cdf,
  };
}

// ---------- Monte Carlo ----------

// One pass of `runs` full schedules. Each run walks the types in order
// (counts[t] events each), draws a place per event from the type's cumulative
// distribution and tracks the running total, its minimum, and the running
// series for up to SAMPLE_PATHS evenly sampled runs.
function runPass(profiles, counts, rng, runs, wantPaths) {
  const finals = new Float64Array(runs);
  const dips = new Float64Array(runs); // deepest dip below the start, >= 0
  const stride = Math.max(1, Math.floor(runs / SAMPLE_PATHS));
  const paths = [];
  for (let r = 0; r < runs; r++) {
    let total = 0, min = 0;
    const path = wantPaths && paths.length < SAMPLE_PATHS && r % stride === 0 ? [0] : null;
    for (let t = 0; t < profiles.length; t++) {
      const prof = profiles[t];
      const count = counts ? counts[t] : prof.events;
      if (!count) continue;
      const cdf = prof.cdf, places = prof.entries, prizes = prof.prizeCurrency, paid = prof.paid, buyIn = prof.buyIn;
      for (let e = 0; e < count; e++) {
        const u = rng();
        let lo = 1, hi = places;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < u) lo = mid + 1; else hi = mid; }
        const prize = lo <= paid ? prizes[lo - 1] : 0;
        total += prize - buyIn;
        if (total < min) min = total;
        if (path) path.push(total);
      }
    }
    finals[r] = total;
    dips[r] = -min;
    if (path) paths.push(path);
  }
  return { finals, dips, paths };
}

// Simulates a schedule of tournament types.
//   types: [{ buyin (or buyIn), rakePct, entries, percentPaid, roi, events }]
//   runs:  Monte Carlo runs (default 10000)
//   seed:  PRNG seed (default 27, whole number >= 0)
//   longRunEvents: horizon of the extra long run (default 2000)
// Returns mean, sd (sample, n-1), chanceLoss (share of runs ending below 0),
// percentiles {1,5,10,25,50,75,90,95,99} of final totals (R type 7),
// perType (analytic ITM %, prize pool, 1st prize, EV and SD per event,
// events), 20 sample paths (arrays of running totals starting at 0),
// rorForBankroll(B) / bankrollForRisk(r) over the chosen schedule and
// rorLongRun(B) / bankrollForRiskLong(r) over the long run.
export function simulate({ types = [], runs = DEFAULT_RUNS, seed = DEFAULT_SEED, longRunEvents = DEFAULT_LONG_RUN } = {}) {
  if (!Array.isArray(types) || types.length === 0) throw new RangeError('At least one tournament type is required.');
  if (!(Number.isInteger(runs) && runs >= 1 && runs <= LIMITS.maxRuns)) {
    throw new RangeError(`Simulations must be a whole number from 1 to ${LIMITS.maxRuns}.`);
  }
  if (!(Number.isInteger(seed) && seed >= 0)) throw new RangeError('Seed must be a whole number of 0 or more.');
  if (!(Number.isInteger(longRunEvents) && longRunEvents >= 0 && longRunEvents <= LIMITS.maxLongRunEvents)) {
    throw new RangeError(`Long run must be a whole number from 0 to ${LIMITS.maxLongRunEvents}.`);
  }

  const profiles = types.map((t, i) => buildType(t, i));
  const totalEvents = profiles.reduce((a, p) => a + p.events, 0);
  if (runs * (totalEvents + longRunEvents) > LIMITS.maxWork) {
    throw new RangeError('Too much work: lower simulations or events.');
  }
  const rng = mulberry32(seed);

  // Chosen-schedule pass: finals, dips, sample paths.
  const { finals, dips, paths } = runPass(profiles, null, rng, runs, true);

  const sortedFinals = Float64Array.from(finals).sort();
  let sum = 0;
  for (let i = 0; i < runs; i++) sum += finals[i];
  const mean = sum / runs;
  let ss = 0;
  for (let i = 0; i < runs; i++) ss += (finals[i] - mean) ** 2;
  const sd = runs > 1 ? Math.sqrt(ss / (runs - 1)) : 0;
  const percentiles = {};
  for (const k of PCTL_KEYS) percentiles[k] = quantileSorted(sortedFinals, k / 100);
  const chanceLoss = countBelow(finals, 0) / runs;

  // Risk of ruin: share of runs whose running total ever drops below -B,
  // i.e. whose deepest dip exceeds B. bankrollForRisk(r) returns the
  // (floor(r * runs) + 1)-th largest dip: the smallest bankroll whose ruin
  // count stays within r * runs.
  const dd = Float64Array.from(dips).sort();
  const rorFromDips = (d) => (B) => (d.length - upperBound(d, Number(B))) / d.length;
  const bankrollFromDips = (d, risk) => {
    const allowed = Math.floor(clamp(Number(risk) || 0, 0, 1) * d.length);
    if (allowed >= d.length) return 0;
    return d[d.length - 1 - allowed];
  };
  const rorForBankroll = rorFromDips(dd);
  const bankrollForRisk = (risk) => bankrollFromDips(dd, risk);

  // Long run: scale the type mix proportionally to its events so the total is
  // longRunEvents (largest-remainder rounding), then record dips only. The
  // RNG stream continues from the main pass, so results stay deterministic.
  let longCounts = null;
  if (totalEvents > 0 && longRunEvents > 0) {
    const scale = longRunEvents / totalEvents;
    longCounts = profiles.map((p) => Math.floor(p.events * scale));
    let assigned = longCounts.reduce((a, b) => a + b, 0);
    const order = profiles
      .map((p, i) => [i, p.events * scale - Math.floor(p.events * scale)])
      .filter(([i]) => profiles[i].events > 0)
      .sort((a, b) => b[1] - a[1]);
    let k = 0;
    while (assigned < longRunEvents) { longCounts[order[k % order.length][0]]++; assigned++; k++; }
  }
  const longDips = new Float64Array(runs);
  if (longCounts) {
    const pass = runPass(profiles, longCounts, rng, runs, false);
    longDips.set(pass.dips);
  }
  const ddLong = Float64Array.from(longDips).sort();
  const rorLongRun = rorFromDips(ddLong);
  const bankrollForRiskLong = (risk) => bankrollFromDips(ddLong, risk);

  const perType = profiles.map((p) => ({
    index: p.index, buyIn: p.buyIn, entries: p.entries, rakePct: p.rakePct,
    percentPaid: p.percentPaid, roi: p.roi, events: p.events, paid: p.paid,
    prizePool: p.pool, firstPrize: p.firstPrize, skillS: p.skillS,
    itmPct: p.itmPct, evPerEvent: p.evPerEvent, sdPerEvent: p.sdPerEvent,
  }));

  return {
    mean, sd, chanceLoss, percentiles, perType, paths,
    rorForBankroll, bankrollForRisk, rorLongRun, bankrollForRiskLong,
    runs, seed, totalEvents, longEvents: longCounts ? longRunEvents : 0,
  };
}
