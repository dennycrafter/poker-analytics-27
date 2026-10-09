// Sell action ("staking") math for tournaments (brief 5.6 + formula 1).
// Pure: the share/markup totals come from stats.sellTotals so the ledger and
// every statistic share one implementation.
//
// Ledger per sell action (share p_i, markup m_i, total buy-in B, prize P):
//   cost       = B * p_i * m_i   backer pays the player for the share
//   payout     = P * p_i         player pays the backer their cut of the prize
//   backer_net = payout - cost
// and the player's retained result is formula 1:
//   retained = P * (1 - Σp) - B * (1 - Σ p_i m_i)
// so gross (P - B) = retained + Σ backer_net exactly.

import { netResult, stakedNetResult, sellTotals } from './stats.js';

const EPS = 1e-9;

export function sellActionsOf(doc, sessionId) {
  return (doc.sell_actions || []).filter(a => a.session_id === sessionId);
}

function markupOf(a) {
  const m = a.markup;
  return m === null || m === undefined || m === '' || !Number.isFinite(Number(m)) ? 1 : Number(m);
}

// Σ percentage already sold (0..100) across a list of actions.
export function soldPercent(actions) {
  return actions.reduce((a, x) => a + Math.max(0, Number(x.percentage) || 0), 0);
}

// Validation for the Sell Action sheet. `existing` = actions already on the
// session (or pending on the start form). Returns an error message or null.
export function sellActionError(existing, pctRaw, markupRaw) {
  const pRaw = String(pctRaw ?? '').trim();
  const p = Number(pRaw);
  if (pRaw === '' || !Number.isFinite(p) || p <= 0) return 'Enter a percentage greater than 0';
  if (p > 100) return 'Percentage cannot exceed 100%';
  const mRaw = String(markupRaw ?? '').trim();
  const m = mRaw === '' ? 1 : Number(mRaw);
  if (!Number.isFinite(m) || m <= 0) return 'Markup must be a number above 0 (1.0 = no markup)';
  if (m > 10) return 'Markup looks too high (1.2 = 20% markup)';
  const left = 100 - soldPercent(existing);
  if (p > left + EPS) return `Only ${fmtPct(Math.max(0, left))}% left to sell (total cannot exceed 100%)`;
  return null;
}

function fmtPct(v) { return String(parseFloat((Math.round(v * 100) / 100).toFixed(2))); }

// Normalized sell action ready to store (markup defaults to 1.0).
export function makeSellAction(id, sessionId, { percentage, markup, backer_name }) {
  const mRaw = String(markup ?? '').trim();
  const name = String(backer_name ?? '').trim();
  return {
    id,
    session_id: sessionId,
    percentage: Number(percentage),
    markup: mRaw === '' ? 1 : Number(mRaw),
    backer_name: name || null,
  };
}

// Full ledger for one tournament.
export function sellLedger(doc, s) {
  const actions = sellActionsOf(doc, s.id);
  const B = Number(s.total_buy_in || 0);
  const P = Number(s.prize || 0);
  const entries = actions.map(a => {
    const share = Math.max(0, Number(a.percentage) || 0) / 100;
    const markup = markupOf(a);
    const cost = B * share * markup;
    const payout = P * share;
    return {
      id: a.id,
      backer_name: a.backer_name || null,
      percentage: Number(a.percentage) || 0,
      markup,
      cost,
      payout,
      backer_net: payout - cost,
    };
  });
  const { p, pm } = sellTotals(doc, s);
  return {
    entries,
    soldPct: p * 100,
    weightedMarkupShare: pm,
    gross: netResult(doc, s),
    retained: stakedNetResult(doc, s),
    received: entries.reduce((a, e) => a + e.cost, 0),
    paidOut: entries.reduce((a, e) => a + e.payout, 0),
    backersNet: entries.reduce((a, e) => a + e.backer_net, 0),
  };
}
