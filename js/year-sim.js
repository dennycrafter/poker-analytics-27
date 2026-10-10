// Year simulator (brief section 6). Pure module: no DOM, no store, no clock.
// Plays out one 12-month year of cash sessions at the user's real winrate
// and SD, month by month, so "Your Year" can show what a normal year looks
// like. Every month is drawn from the seeded PRNG stream in js/variance.js,
// so the same inputs + seed give the same year byte-for-byte (the screen's
// "Re-roll year" passes a new seed).
//
// Per month m: result ~ Normal(wr x hours, (sd x sqrt(hours))^2), ev = wr x
// hours, z = (result - ev) / (sd x sqrt(hours)). A month is lucky when
// z > +1 and unlucky when z < -1 (brief section 6 thresholds).

import { mulberry32, normalSampler } from './variance.js';

function yearError(p) {
  if (!Number.isFinite(p.wr)) return 'Win rate must be a number.';
  if (!(Number.isFinite(p.sd) && p.sd >= 0)) return 'Standard deviation must be 0 or more.';
  if (!(Number.isFinite(p.hoursPerMonth) && p.hoursPerMonth > 0)) return 'Hours per month must be greater than 0.';
  if (p.seed !== undefined && !(Number.isInteger(p.seed) && p.seed >= 0)) return 'Seed must be a whole number of 0 or more.';
  return null;
}

// params: { wr (per hour), sd (per hour), hoursPerMonth, seed? }
// Returns { months: [{ result, ev, z } x 12], annual, annualEv, luckiest,
// unluckiest }. luckiest / unluckiest are 0-based indexes into months.
// With sd = 0 every month lands exactly on EV and z is 0.
export function simulateYear(input) {
  const p = { seed: 27, ...input }; // default seed matches js/variance.js
  const err = yearError(p);
  if (err) throw new RangeError(err);
  const { wr, sd, hoursPerMonth, seed } = p;
  const normal = normalSampler(mulberry32(seed));
  const ev = wr * hoursPerMonth;
  const sdMonth = sd * Math.sqrt(hoursPerMonth);
  const months = [];
  for (let m = 0; m < 12; m++) {
    const result = ev + sdMonth * normal();
    const z = sdMonth > 0 ? (result - ev) / sdMonth : 0;
    months.push({ result, ev, z });
  }
  const annual = months.reduce((a, m) => a + m.result, 0);
  const annualEv = months.reduce((a, m) => a + m.ev, 0);
  let luckiest = 0, unluckiest = 0;
  for (let m = 1; m < 12; m++) {
    if (months[m].result > months[luckiest].result) luckiest = m;
    if (months[m].result < months[unluckiest].result) unluckiest = m;
  }
  return { months, annual, annualEv, luckiest, unluckiest };
}
