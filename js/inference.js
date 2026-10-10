// Winrate inference for the "Am I a winner?" card (brief iteration 2).
// Pure module: no DOM, no store, no clock. Same style as js/variance.js.
// Formulas are fixed by brief section 7 and pinned in
// tests/it2-inference.test.mjs, including the brief's own sanity anchor:
// 256 hours at $5/hr with SD $47/hr gives SE $2.94 and a 95% CI of about
// -$0.76 to $10.76 per hour.
//
// Rows come from sessionRows(): one entry per ended cash session in the
// caller's current filter. winrateStats() collapses rows into
// { wr, sd, se, z, ci, chanceWinner, n } in the requested unit. Any stat
// the data cannot support comes back null (no rows, or missing big blinds
// and hand counts), so screens can show a plain message instead of a
// misleading number. Callers guard small samples themselves with
// MIN_SESSIONS / NEED_MORE_MESSAGE.

import { netResult, sessionHours, effectiveHands } from './stats.js';
import { normalCdf } from './variance.js';

// Re-exported so the whole app keeps one normal CDF (variance.js, A&S erf).
export { normalCdf };

// Below this many filtered sessions a winrate is mostly noise: callers show
// NEED_MORE_MESSAGE instead of the card.
export const MIN_SESSIONS = 10;
export const NEED_MORE_MESSAGE = 'Need at least 10 sessions';

// ---------- inverse normal ----------

// Acklam's rational approximation of the inverse standard normal CDF
// (published relative error below 1.15e-9). Two-sided confidence always
// maps to p = 1 - alpha/2 >= 0.5, so only the central and upper regions of
// the algorithm can be reached here.
const ACKLAM_A = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
const ACKLAM_B = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
const ACKLAM_C = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
const ACKLAM_D = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
const ACKLAM_P_HIGH = 0.97575; // 1 - 0.02425

// Two-sided z score for a central confidence level: zFor(0.95) = 1.95996...
export function zFor(confidence) {
  if (!(confidence > 0 && confidence < 1)) {
    throw new RangeError('Confidence must be between 0 and 1.');
  }
  const p = 1 - (1 - confidence) / 2;
  if (p <= ACKLAM_P_HIGH) {
    const q = p - 0.5;
    const r = q * q;
    return (((((ACKLAM_A[0] * r + ACKLAM_A[1]) * r + ACKLAM_A[2]) * r + ACKLAM_A[3]) * r + ACKLAM_A[4]) * r + ACKLAM_A[5]) * q
      / (((((ACKLAM_B[0] * r + ACKLAM_B[1]) * r + ACKLAM_B[2]) * r + ACKLAM_B[3]) * r + ACKLAM_B[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((ACKLAM_C[0] * q + ACKLAM_C[1]) * q + ACKLAM_C[2]) * q + ACKLAM_C[3]) * q + ACKLAM_C[4]) * q + ACKLAM_C[5])
    / ((((ACKLAM_D[0] * q + ACKLAM_D[1]) * q + ACKLAM_D[2]) * q + ACKLAM_D[3]) * q + 1);
}

// ---------- rows ----------

// netResult reads stack events off the document for live-tracked sessions;
// without a doc there is nothing to score them from.
const EMPTY_DOC = { stack_events: [] };

// One row per ended cash session with playing time:
//   p      net result in currency (stats.js netResult, tips subtracted)
//   h      play hours (stats.js sessionHours, breaks excluded)
//   bb     big blind, or null when the session has no stakes
//   hands  effective hand count (stats.js effectiveHands), or null
// Filters mirror the stats.js conventions (ended + cash + withHours) so a
// stray tournament, a still-live session or a duration-0 log can never
// poison the card. Pass the store doc: live-tracked sessions keep their
// money in doc.stack_events and are skipped (not scored as 0) without it.
export function sessionRows(sessions, doc = null) {
  const rows = [];
  for (const s of sessions) {
    if (!s || s.kind !== 'cash' || s.is_live || !s.end_time) continue;
    if (s.tracked_via_stack && !doc) continue;
    const h = sessionHours(s);
    if (!(h > 0)) continue;
    const bb = Number(s.big_blind);
    const hands = Number(effectiveHands(s));
    rows.push({
      p: netResult(doc || EMPTY_DOC, s),
      h,
      bb: bb > 0 ? bb : null,
      hands: hands > 0 ? hands : null,
    });
  }
  return rows;
}

// ---------- stats ----------

const UNITS = ['usd', 'bb', 'per100'];

function nullStats(z, n) {
  return { wr: null, sd: null, se: null, z, ci: null, chanceWinner: null, n };
}

// Brief section 7 on the given rows, exactly:
//   WR = sum(p) / sum(h)
//   SD = sqrt( sum( (p_i - WR*h_i)^2 / h_i ) / (k - 1) )   (0 when k = 1)
//   SE = SD / sqrt(sum(h))
//   CI = WR +/- z*SE,  chance of winning = NormalCDF(WR / SE)
// unit selects the exposure axis: 'usd' uses hours, 'bb' divides each p_i
// by its session's big blind, 'per100' replaces h_i with hands_i / 100.
// The result is null where the unit's data is missing on any row, where a
// row is not usable (non-finite money or no time), or where there are no
// rows: never a number computed over a silent subset.
export function winrateStats(rows, { unit = 'usd', confidence = 0.95 } = {}) {
  if (!UNITS.includes(unit)) throw new RangeError('Unknown unit: use usd, bb or per100.');
  const z = zFor(confidence);
  const n = rows.length;
  if (!n) return nullStats(z, 0);
  const x = [], t = [];
  for (const r of rows) {
    const p = Number(r.p), h = Number(r.h);
    if (!Number.isFinite(p) || !(h > 0)) return nullStats(z, n);
    if (unit === 'per100') {
      const hands = Number(r.hands);
      if (!(hands > 0)) return nullStats(z, n);
      x.push(p); t.push(hands / 100);
    } else if (unit === 'bb') {
      const bb = Number(r.bb);
      if (!(bb > 0)) return nullStats(z, n);
      x.push(p / bb); t.push(h);
    } else {
      x.push(p); t.push(h);
    }
  }
  const totalT = t.reduce((a, b) => a + b, 0);
  const wr = x.reduce((a, b) => a + b, 0) / totalT;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += ((x[i] - wr * t[i]) ** 2) / t[i];
  const sd = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
  const se = sd / Math.sqrt(totalT);
  const chanceWinner = se > 0 ? normalCdf(wr / se) : (wr > 0 ? 1 : wr < 0 ? 0 : 0.5);
  return { wr, sd, se, z, ci: [wr - z * se, wr + z * se], chanceWinner, n };
}

// ---------- hours until you know ----------

// Hours of filtered play needed before the winrate CI spans +/- x per hour
// (brief: (1.96 * SD / X)^2; pass z = zFor(confidence) for other levels).
// Zero accuracy demand needs infinite hours; SD 0 is already known.
export function hoursToKnow(sd, x, z = 1.96) {
  if (!(x > 0)) return Infinity;
  return ((z * sd) / x) ** 2;
}
