// Cash variance math for the Variance screen (brief sections 4 and 7).
// Pure module: no DOM, no store, no clock (callers pass nowMs where needed).
// Reuses the seeded PRNG, CDF and quantile helpers from js/variance.js and
// never edits them. Everything here is closed form or a seeded Monte Carlo,
// so the same inputs + seed give the same output byte-for-byte (tests and
// the screen's "Re-roll" button rely on that).
//
// Formulas follow the brief exactly:
//   projection   mean = WR x T, SD = SD x sqrt(T), chance of loss = NormalCDF(-mean / SD)
//   risk of ruin ror = exp(-2 x WR x B / SD^2), 100% when WR <= 0
//   bankroll for risk r = -SD^2 x ln(r) / (2 x WR)
//   downswings   2000 seeded paths, 1-hour steps drawn Normal(WR, SD);
//                size = biggest drop from a running peak, length = longest
//                stretch from a peak until that peak is reached again.

import { mulberry32, normalSampler, normalCdf, quantileSorted, LIMITS } from './variance.js';
import { playSeconds } from './stats.js';

const MONTHS_IN_90_DAYS = 3; // the brief treats the last 90 days as 3 months

// ---------- inverse normal CDF ----------

// High-accuracy erf for |x| up to about 4 via the alternating Maclaurin
// series  erf(x) = (2/sqrt(pi)) x SUM (-1)^n x^2n / (n! (2n+1)).  Inside that
// range cancellation costs at most a digit or two, so the result stays near
// 1e-15 absolute. (js/variance.js keeps the A&S 7.1.26 erf, whose 1.5e-7
// error is fine for probabilities but too coarse to invert.)
function erfSeries(x) {
  const x2 = x * x;
  let term = 1, sum = 1;
  for (let n = 1; n < 200; n++) {
    term *= (-x2 * (2 * n - 1)) / (n * (2 * n + 1));
    sum += term;
    if (Math.abs(term) <= 1e-19 * Math.abs(sum)) break;
  }
  return (2 / Math.sqrt(Math.PI)) * x * sum;
}

// Standard normal CDF, about 1e-15 accurate for |z| up to 6.
function cdfHi(z) {
  return 0.5 * (1 + erfSeries(z / Math.SQRT2));
}

// Quantile z with NormalCDF(z) = p, for p in (1e-8, 1 - 1e-8); throws outside
// that window (every percentile and confidence use here is far inside).
// Plain bisection on the series CDF: no fitted constants to get wrong,
// converges to full double precision, deterministic for the same p.
export function invNorm(p) {
  if (!(p > 1e-8 && p < 1 - 1e-8)) throw new RangeError('Probability must be between 0.00000001 and 0.99999999.');
  let lo = -5.7, hi = 5.7; // cdfHi(-5.7) < 1e-8 and cdfHi(5.7) > 1 - 1e-8
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (cdfHi(mid) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------- projection over T hours ----------

function projectError(p) {
  if (!Number.isFinite(p.wr)) return 'Win rate must be a number.';
  if (!(Number.isFinite(p.sd) && p.sd >= 0)) return 'Standard deviation must be 0 or more.';
  if (!(Number.isFinite(p.hoursT) && p.hoursT > 0)) return 'Hours must be greater than 0.';
  return null;
}

// Closed-form projection of T more hours at winrate wr and SD sd (both per
// hour, any currency or BB unit). percentiles are keyed 1, 5, 25, 50, 75, 95, 99.
export function project(input) {
  const err = projectError(input);
  if (err) throw new RangeError(err);
  const { wr, sd, hoursT } = input;
  const mean = wr * hoursT;
  const sdT = sd * Math.sqrt(hoursT);
  // Degenerate no-variance case: the result is the mean with certainty.
  const chanceLoss = sdT > 0 ? normalCdf(-mean / sdT) : mean > 0 ? 0 : mean < 0 ? 1 : 0;
  const percentiles = {};
  for (const q of [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99]) {
    percentiles[q * 100] = mean + invNorm(q) * sdT;
  }
  return { mean, sd: sdT, chanceLoss, percentiles };
}

// ---------- downswings (seeded Monte Carlo) ----------

function downswingError(p) {
  if (!Number.isFinite(p.wr)) return 'Win rate must be a number.';
  if (!(Number.isFinite(p.sd) && p.sd >= 0)) return 'Standard deviation must be 0 or more.';
  const isInt = v => Number.isInteger(v);
  if (!(isInt(p.totalHours) && p.totalHours >= 1 && p.totalHours <= LIMITS.maxUnits)) return `Hours must be a whole number from 1 to ${LIMITS.maxUnits}.`;
  if (!(isInt(p.paths) && p.paths >= 1 && p.paths <= LIMITS.maxPaths)) return `Simulations must be a whole number from 1 to ${LIMITS.maxPaths}.`;
  if (p.seed !== undefined && !(isInt(p.seed) && p.seed >= 0)) return 'Seed must be a whole number of 0 or more.';
  if (p.paths * p.totalHours > LIMITS.maxSteps) return 'Too much work: lower hours or simulations.';
  return null;
}

// Simulates `paths` (default 2000) walks of `totalHours` 1-hour steps drawn
// from Normal(wr, sd) with a seeded PRNG.
//   size        biggest drop from a running peak (same definition as
//               js/variance.js maxDownswing)
//   lengthHours longest stretch, in hours, from setting a peak until that
//               peak is reached again (touching it ends the downswing); a
//               stretch still below the peak when the horizon ends counts
//               up to the horizon.
// finalsMean (mean final result) is a diagnostic the tests use for
// distribution sanity; the screen does not need it.
export function downswings(input) {
  const p = { paths: 2000, seed: 27, ...input };
  const err = downswingError(p);
  if (err) throw new RangeError(err);
  const normal = normalSampler(mulberry32(p.seed));
  const sizes = new Float64Array(p.paths);
  const lengths = new Float64Array(p.paths);
  let finalsSum = 0;
  for (let path = 0; path < p.paths; path++) {
    let cum = 0, peak = 0, peakHour = 0, maxDrop = 0, maxLen = 0;
    for (let t = 1; t <= p.totalHours; t++) {
      cum += p.wr + p.sd * normal();
      if (cum >= peak) {
        if (t - peakHour > maxLen) maxLen = t - peakHour;
        peak = cum;
        peakHour = t;
      } else {
        if (peak - cum > maxDrop) maxDrop = peak - cum;
        if (t - peakHour > maxLen) maxLen = t - peakHour;
      }
    }
    sizes[path] = maxDrop;
    lengths[path] = maxLen;
    finalsSum += cum;
  }
  const pct = arr => ({
    p5: quantileSorted(arr, 0.05), p25: quantileSorted(arr, 0.25), p50: quantileSorted(arr, 0.5),
    p75: quantileSorted(arr, 0.75), p95: quantileSorted(arr, 0.95),
  });
  return {
    paths: p.paths,
    totalHours: p.totalHours,
    finalsMean: finalsSum / p.paths,
    size: pct(Float64Array.from(sizes).sort()),
    lengthHours: pct(Float64Array.from(lengths).sort()),
  };
}

// ---------- risk of ruin and bankroll ----------

// Chance of eventually going broke with bankroll B: exp(-2 x wr x B / sd^2).
// Certain (1) when wr <= 0 or B <= 0; 0 when there is no variance and the
// winrate is positive. Matches js/variance.js brownianRuin at an infinite
// horizon (tested).
export function ror(B, wr, sd) {
  if (!(wr > 0)) return 1;
  if (!(B > 0)) return 1;
  if (!(sd > 0)) return 0;
  return Math.exp((-2 * wr * B) / (sd * sd));
}

// Bankroll needed for risk of ruin r (0 < r <= 1) at winrate wr.
// Returns null when no finite bankroll achieves it (wr <= 0, or r outside (0, 1]).
export function bankrollFor(r, wr, sd) {
  if (!(wr > 0) || !(r > 0 && r <= 1)) return null;
  const v = (-sd * sd * Math.log(r)) / (2 * wr);
  return v === 0 ? 0 : v; // normalize -0 so strict equality tests hold
}

// "What if your winrate is wrong?" rows (brief section 4): the observed
// winrate, 70% and 30% of it, and break even. Each row carries the risk of
// ruin at the current bankroll and the bankroll needed for a 5% risk of ruin.
// For a losing player every row is certain ruin and bankrollFor5 is null.
export function sensitivityRows(wr, sd, B) {
  const defs = [
    ['My winrate', 1],
    ['70% of it', 0.7],
    ['30% of it', 0.3],
    ['Break even', 0],
  ];
  return defs.map(([label, frac]) => {
    const w = wr * frac;
    return { label, wr: w, ror: ror(B, w, sd), bankrollFor5: bankrollFor(0.05, w, sd) };
  });
}

// ---------- volume from real sessions ----------

// Average played hours per month over the last 90 days (the brief's default
// volume input). Sessions are credited to the window when they START; play
// time uses the app's own rule (js/stats.js playSeconds: breaks and ongoing
// pauses excluded, live sessions run to nowMs).
export function avgHoursPerMonth(sessions, nowMs = Date.now()) {
  const windowStart = nowMs - 90 * 24 * 3600 * 1000;
  let total = 0;
  for (const s of sessions || []) {
    const start = Date.parse(s.start_time);
    if (!Number.isFinite(start) || start < windowStart || start > nowMs) continue;
    total += playSeconds(s, nowMs) / 3600;
  }
  return total / MONTHS_IN_90_DAYS;
}
