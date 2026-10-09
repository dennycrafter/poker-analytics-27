// Variance simulator (Tier 8). Pure module: no DOM, no store, no clock.
// Monte Carlo bankroll paths for two models:
//   cash        — each hour is Normal(winRate, stdDev²) (per-hour EV/SD)
//   tournament  — each tournament is a draw from a payout table built from
//                 buy-in, ROI, field size, ITM% and payout steepness
// Every run is driven by a seeded PRNG so the same inputs + seed give the
// same output byte-for-byte (tests and the screen's "Re-roll" rely on it).
//
// Ruin is absorbing: once bankroll + cumulative result <= 0 the path stops
// and stays at 0 — a busted player cannot keep playing.

// -ζ(1/2)/√(2π): Siegmund / Broadie-Glasserman-Kou continuity correction.
// A walk observed in steps of SD s crosses a barrier B about as often as
// continuous Brownian motion crosses B + β·s.
export const RUIN_CONTINUITY_BETA = 0.5825971579390106;

export const LIMITS = Object.freeze({
  maxPaths: 50000,
  maxUnits: 100000,
  maxSubsteps: 64,
  maxSteps: 2e8, // paths * units * substeps
});

const CHECKPOINTS = 60;
const SAMPLE_PATHS = 5;
const HISTOGRAM_BINS = 12;

// ---------- RNG ----------

// mulberry32: tiny, fast, well-distributed 32-bit PRNG. Returns [0, 1).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller standard normal sampler bound to one uniform stream.
// Caches the second variate so each pair of uniforms yields two normals.
export function normalSampler(rng) {
  let spare = null;
  return function normal() {
    if (spare !== null) { const z = spare; spare = null; return z; }
    const u1 = 1 - rng(); // (0, 1] so log() is finite
    const u2 = rng();
    const r = Math.sqrt(-2 * Math.log(u1));
    spare = r * Math.sin(2 * Math.PI * u2);
    return r * Math.cos(2 * Math.PI * u2);
  };
}

// ---------- closed-form helpers ----------

// Abramowitz & Stegun 7.1.26 erf (|error| < 1.5e-7).
function erf(x) {
  const s = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return s * y;
}

export function normalCdf(z) {
  if (z === Infinity) return 1;
  if (z === -Infinity) return 0;
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// Probability that Brownian motion with drift mu and volatility sigma (per
// unit) starting at bankroll B touches 0 within T units (T = Infinity for the
// classic exp(-2·mu·B/sigma²)). First-passage formula for drifted BM.
export function brownianRuin(mu, sigma, bankroll, horizon = Infinity) {
  const B = bankroll;
  if (!(B > 0)) return 1;
  if (!(sigma > 0)) {
    // Deterministic path: ruined only if the drift reaches -B in time.
    return mu < 0 && -mu * horizon >= B ? 1 : 0;
  }
  const v = sigma * sigma;
  if (horizon === Infinity) return mu <= 0 ? 1 : Math.exp((-2 * mu * B) / v);
  const sT = sigma * Math.sqrt(horizon);
  const first = normalCdf((-B - mu * horizon) / sT);
  const tail = normalCdf((-B + mu * horizon) / sT);
  // exp(..) can overflow for mu < 0 while the cdf underflows; combine in logs.
  const second = tail > 0 ? Math.exp((-2 * mu * B) / v + Math.log(tail)) : 0;
  const p = first + second;
  return Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 1;
}

// brownianRuin adjusted for a walk observed every `stepSd` of noise.
export function discreteRuin(mu, sigma, bankroll, horizon, stepSd) {
  return brownianRuin(mu, sigma, bankroll + RUIN_CONTINUITY_BETA * stepSd, horizon);
}

// ---------- tournament payout model ----------

// Builds the per-tournament outcome table.
//   paid places P = round(field * itm), prize pool = field buy-ins (rake is
//   folded into ROI), place k pays a share ∝ 1/k^steepness.
//   A break-even player finishes in each place with prob 1/field; skill
//   scales every paid probability by (1 + roi), so EV = buyIn * roi exactly.
export function tournamentOutcomes({ buyIn, roi, field, itm, steepness = 1 }) {
  const paid = paidPlaces(field, itm);
  const weights = [];
  for (let k = 1; k <= paid; k++) weights.push(1 / Math.pow(k, steepness));
  const wSum = weights.reduce((a, b) => a + b, 0);
  const pPlace = (1 + roi) / field;
  const outcomes = weights.map((w, i) => {
    const multiple = (field * w) / wSum;
    return { place: i + 1, multiple, net: buyIn * (multiple - 1), prob: pPlace };
  });
  const cashProb = pPlace * paid;
  outcomes.push({ place: null, multiple: 0, net: -buyIn, prob: Math.max(0, 1 - cashProb) });
  const mean = outcomes.reduce((a, o) => a + o.prob * o.net, 0);
  const variance = outcomes.reduce((a, o) => a + o.prob * (o.net - mean) ** 2, 0);
  return { outcomes, paid, cashProb, mean, sd: Math.sqrt(variance) };
}

function paidPlaces(field, itm) {
  return Math.min(field, Math.max(1, Math.round(field * itm)));
}

// ---------- validation ----------

const isInt = v => Number.isInteger(v);

function commonError(p, unitsKey, unitsLabel) {
  if (!(Number.isFinite(p.bankroll) && p.bankroll > 0)) return 'Bankroll must be greater than 0.';
  const units = p[unitsKey];
  if (!(isInt(units) && units >= 1 && units <= LIMITS.maxUnits)) return `${unitsLabel} must be a whole number from 1 to ${LIMITS.maxUnits}.`;
  if (!(isInt(p.paths) && p.paths >= 1 && p.paths <= LIMITS.maxPaths)) return `Simulations must be a whole number from 1 to ${LIMITS.maxPaths}.`;
  if (!(isInt(p.seed) && p.seed >= 0)) return 'Seed must be a whole number of 0 or more.';
  return null;
}

// Returns null when valid, else a user-facing message.
export function cashParamsError(p) {
  if (!Number.isFinite(p.winRate)) return 'Win rate must be a number.';
  if (!(Number.isFinite(p.stdDev) && p.stdDev >= 0)) return 'Standard deviation must be 0 or more.';
  const e = commonError(p, 'hours', 'Hours');
  if (e) return e;
  if (!(isInt(p.stepsPerHour) && p.stepsPerHour >= 1 && p.stepsPerHour <= LIMITS.maxSubsteps)) return `Steps per hour must be from 1 to ${LIMITS.maxSubsteps}.`;
  if (p.paths * p.hours * p.stepsPerHour > LIMITS.maxSteps) return 'Too much work: lower hours or simulations.';
  return null;
}

export function tournamentParamsError(p) {
  if (!(Number.isFinite(p.buyIn) && p.buyIn > 0)) return 'Buy-in must be greater than 0.';
  if (!(Number.isFinite(p.roi) && p.roi > -1)) return 'ROI must be greater than -100%.';
  if (!(isInt(p.field) && p.field >= 2 && p.field <= 100000)) return 'Field size must be a whole number from 2 to 100000.';
  if (!(Number.isFinite(p.itm) && p.itm > 0 && p.itm <= 1)) return 'ITM must be between 0% and 100%.';
  if (!(Number.isFinite(p.steepness) && p.steepness >= 0 && p.steepness <= 3)) return 'Payout steepness must be from 0 to 3.';
  if (((1 + p.roi) * paidPlaces(p.field, p.itm)) / p.field > 1) return 'ROI too high for this field and ITM: cash rate would exceed 100%.';
  const e = commonError(p, 'tournaments', 'Tournaments');
  if (e) return e;
  if (p.paths * p.tournaments > LIMITS.maxSteps) return 'Too much work: lower tournaments or simulations.';
  return null;
}

// Fills defaults without coercing types: bad input stays bad so validation reports it.
export function normalizeCash(p) {
  return { seed: 27, stepsPerHour: 1, ...p };
}
export function normalizeTournament(p) {
  return { seed: 27, itm: 0.15, steepness: 1, ...p };
}

// ---------- statistics on samples ----------

// Linear-interpolated quantile (R type 7) of an ascending-sorted array.
export function quantileSorted(sorted, q) {
  const n = sorted.length;
  if (!n) return null;
  const h = (n - 1) * q;
  const lo = Math.floor(h), hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

function sortedCopy(arr) { return Float64Array.from(arr).sort(); }

function summarize(values) {
  const s = sortedCopy(values);
  const n = s.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += s[i];
  const mean = sum / n;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (s[i] - mean) ** 2;
  return {
    p5: quantileSorted(s, 0.05), p50: quantileSorted(s, 0.5), p95: quantileSorted(s, 0.95),
    mean, sd: n > 1 ? Math.sqrt(ss / (n - 1)) : 0, min: s[0], max: s[n - 1],
  };
}

function histogram(sorted, bins) {
  const top = quantileSorted(sorted, 0.99);
  const width = top > 0 ? top / bins : 1;
  const out = Array.from({ length: bins }, (_, i) => ({ from: i * width, to: (i + 1) * width, count: 0 }));
  for (const v of sorted) out[Math.min(bins - 1, Math.floor(v / width))].count++;
  return out;
}

// Evenly spaced unit indices 1..units (at most `max`, always ending at units).
export function checkpointUnits(units, max = CHECKPOINTS) {
  const n = Math.min(units, max);
  const out = [];
  for (let i = 1; i <= n; i++) {
    const u = Math.round((i * units) / n);
    if (u !== out[out.length - 1]) out.push(u);
  }
  return out;
}

// ---------- core engine ----------

// Runs `paths` walks of `units` units, each unit made of `substeps` draws
// from `step()`. Shared by both models; all model specifics live in `step`.
function runPaths({ paths, units, substeps, bankroll, step }) {
  const cps = checkpointUnits(units);
  const C = cps.length;
  const atCheckpoint = new Float64Array(C * paths); // checkpoint-major
  const finals = new Float64Array(paths);
  const downswings = new Float64Array(paths);
  let ruined = 0;

  for (let p = 0; p < paths; p++) {
    let cum = 0, peak = 0, dd = 0, dead = false, c = 0;
    for (let u = 1; u <= units && !dead; u++) {
      for (let s = 0; s < substeps; s++) {
        cum += step();
        if (cum > peak) peak = cum;
        else if (peak - cum > dd) dd = peak - cum;
        if (bankroll + cum <= 0) { dead = true; cum = -bankroll; dd = Math.max(dd, peak - cum); break; }
      }
      if (u === cps[c]) { atCheckpoint[c * paths + p] = bankroll + cum; c++; }
    }
    // Ruined paths sit at 0 for every remaining checkpoint.
    for (; c < C; c++) atCheckpoint[c * paths + p] = 0;
    if (dead) ruined++;
    finals[p] = bankroll + cum;
    downswings[p] = dd;
  }

  const bands = [];
  const probDownAt = [];
  for (let c = 0; c < C; c++) {
    const slice = sortedCopy(atCheckpoint.subarray(c * paths, (c + 1) * paths));
    let down = 0;
    for (let i = 0; i < paths; i++) if (slice[i] < bankroll) down++;
    bands.push({ unit: cps[c], p5: quantileSorted(slice, 0.05), p50: quantileSorted(slice, 0.5), p95: quantileSorted(slice, 0.95) });
    probDownAt.push({ unit: cps[c], p: down / paths });
  }
  const samplePaths = [];
  for (let p = 0; p < Math.min(SAMPLE_PATHS, paths); p++) {
    const pts = [{ unit: 0, bankroll }];
    for (let c = 0; c < C; c++) pts.push({ unit: cps[c], bankroll: atCheckpoint[c * paths + p] });
    samplePaths.push(pts);
  }

  const net = finals.map(v => v - bankroll);
  let downCount = 0;
  for (let i = 0; i < paths; i++) if (net[i] < 0) downCount++;
  const ddSorted = sortedCopy(downswings);

  return {
    paths,
    units,
    riskOfRuin: ruined / paths,
    finalBankroll: summarize(finals),
    net: summarize(net),
    probDown: downCount / paths,
    probDownAt,
    maxDownswing: { ...summarize(downswings), histogram: histogram(ddSorted, HISTOGRAM_BINS) },
    bands,
    samplePaths,
  };
}

function analyticBlock(mu, sd, bankroll, units, stepSd) {
  return {
    meanPerUnit: mu,
    sdPerUnit: sd,
    expectedNet: mu * units,
    sdNet: sd * Math.sqrt(units),
    ruinInfinite: brownianRuin(mu, sd, bankroll, Infinity),
    ruinHorizon: brownianRuin(mu, sd, bankroll, units),
    ruinHorizonDiscrete: discreteRuin(mu, sd, bankroll, units, stepSd),
  };
}

// ---------- public simulators ----------

// params: { winRate, stdDev (per hour), bankroll, hours, paths, seed?, stepsPerHour? }
export function simulateCash(input) {
  const p = normalizeCash(input);
  const err = cashParamsError(p);
  if (err) throw new RangeError(err);
  const k = p.stepsPerHour;
  const mu = p.winRate / k;
  const sd = p.stdDev / Math.sqrt(k);
  const normal = normalSampler(mulberry32(p.seed));
  const result = runPaths({ paths: p.paths, units: p.hours, substeps: k, bankroll: p.bankroll, step: () => mu + sd * normal() });
  return {
    model: 'cash',
    params: p,
    unitLabel: 'hours',
    ...result,
    analytic: analyticBlock(p.winRate, p.stdDev, p.bankroll, p.hours, sd),
  };
}

// params: { buyIn, roi (fraction), field, itm (fraction), steepness, bankroll, tournaments, paths, seed? }
export function simulateTournament(input) {
  const p = normalizeTournament(input);
  const err = tournamentParamsError(p);
  if (err) throw new RangeError(err);
  const table = tournamentOutcomes(p);
  const cdf = [];
  let acc = 0;
  for (const o of table.outcomes) { acc += o.prob; cdf.push(acc); }
  const nets = table.outcomes.map(o => o.net);
  const last = nets.length - 1;
  const rng = mulberry32(p.seed);
  const step = () => {
    const u = rng() * acc; // acc ≈ 1; scaling keeps float drift from skipping the bust slot
    let lo = 0, hi = last;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (u < cdf[mid]) hi = mid; else lo = mid + 1; }
    return nets[lo];
  };
  const result = runPaths({ paths: p.paths, units: p.tournaments, substeps: 1, bankroll: p.bankroll, step });
  return {
    model: 'tournament',
    params: p,
    unitLabel: 'tournaments',
    payout: { paid: table.paid, cashProb: table.cashProb, top: table.outcomes[0].multiple, minCash: table.outcomes[table.paid - 1].multiple },
    ...result,
    analytic: analyticBlock(table.mean, table.sd, p.bankroll, p.tournaments, table.sd),
  };
}
