// "What if your winrate is wrong?" (brief section 4, bankroll part). Pure
// module: no DOM, no store, no clock.
//
// ror() and bankrollFor() restate the brief section 7 formulas locally so
// this screen's import graph never depends on js/variance-cash.js (that
// module belongs to the it4-cash-math lane and may not be on a branch yet).
// tests/it4-bankroll-ui.test.mjs cross-checks both implementations against
// each other once variance-cash.js exists. The row-builder still accepts
// rorFn / bankrollForFn overrides so tests can inject their own math.

// The table walks the observed winrate: my winrate, 70% of it, 30% of it,
// and break even. Multiplying a negative winrate by these fractions walks
// it toward zero, which is the honest "what if I am less bad than this".
export const SENSITIVITY_FRACTIONS = [
  { fraction: 1, label: 'Your winrate' },
  { fraction: 0.7, label: '70% of it' },
  { fraction: 0.3, label: '30% of it' },
  { fraction: 0, label: 'Break even' },
];

// Brief section 7: risk of ruin for bankroll B = exp(-2 x WR x B / SD^2),
// 100% when WR is 0 or less. Returns a fraction 0..1.
export function ror(B, wr, sd) {
  if (!(wr > 0)) return 1;
  const b = Math.max(0, Number(B) || 0);
  if (!(b > 0)) return 1; // nothing behind you: certain ruin
  if (!(sd > 0)) return 0; // no variance and a winning rate never crosses zero
  return Math.exp((-2 * wr * b) / (sd * sd));
}

// Brief section 7: bankroll for risk r = -SD^2 x ln(r) / (2 x WR).
// Null when no bankroll can hold that risk (WR <= 0, no variance, or a
// meaningless target outside 0..1).
export function bankrollFor(risk, wr, sd) {
  if (!(wr > 0) || !(sd > 0) || !(risk > 0 && risk < 1)) return null;
  return (-(sd * sd) * Math.log(risk)) / (2 * wr);
}

// One row per fraction of the observed winrate. `ror` is a fraction
// (0..1, 1 = certain ruin); `bankrollFor5` is a bankroll size, or null when
// no bankroll reaches a 5% risk. Returns null when there are no observed
// moments to scale, so the screen can hide the table.
export function buildWinrateSensitivityRows({ winrate, sd, bankroll, rorFn = ror, bankrollForFn = bankrollFor }) {
  if (!Number.isFinite(winrate) || !Number.isFinite(sd) || !(sd >= 0)) return null;
  return SENSITIVITY_FRACTIONS.map(({ fraction, label }) => {
    const wr = winrate * fraction;
    // Brief section 7: risk of ruin is 100% when WR is 0 or less, and no
    // bankroll gets a non-winning rate down to a 5% risk, so that row never
    // calls the math.
    if (!(wr > 0)) return { fraction, label, winrate: wr, ror: 1, bankrollFor5: null };
    return {
      fraction, label, winrate: wr,
      ror: rorFn(bankroll, wr, sd),
      bankrollFor5: bankrollForFn(0.05, wr, sd),
    };
  });
}

// Fraction -> integer percent, the Bankroll screen's RoR precision
// (riskOfRuin in stats.js also rounds to a whole percent).
export function rorPercent(fraction) {
  return Number.isFinite(fraction) ? Math.round(fraction * 100) : null;
}
