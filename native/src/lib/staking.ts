// Sell action ("staking") math for tournaments (brief 5.6 + formula 1), a
// faithful port of the web app's js/staking.js. The share/markup totals come
// from stats.sellTotals so the ledger and every statistic share one
// implementation. tests/native-parity-money.test.ts checks every function
// here against the web module on golden fixtures.
//
// Ledger per sell action (share p_i, markup m_i, total buy-in B, prize P):
//   cost       = B * p_i * m_i   backer pays the player for the share
//   payout     = P * p_i         player pays the backer their cut of the prize
//   backer_net = payout - cost
// and the player's retained result is formula 1:
//   retained = P * (1 - sum p) - B * (1 - sum p_i m_i)
// so gross (P - B) = retained + sum backer_net exactly.

import type { IdFn } from './domain';
import { fmtNum } from './format';
import { netResult, sellTotals, stakedNetResult } from './stats';
import type { Doc, SellAction, Session, SessionChildren } from './types';

const EPS = 1e-9;

/** Raw user input as typed in the sheet (strings) or already numeric. */
type Raw = string | number | null | undefined;

export function sellActionsOf(doc: SessionChildren, sessionId: string): SellAction[] {
  return (doc.sell_actions || []).filter(a => a.session_id === sessionId);
}

/** Markup as stored; legacy rows may carry null/'' which means 1.0 (same rule as stats.sellTotals). */
function markupOf(a: SellAction): number {
  const m = a.markup as Raw;
  return m === null || m === undefined || m === '' || !Number.isFinite(Number(m)) ? 1 : Number(m);
}

/** Sum of percentage already sold (0..100) across a list of actions. */
export function soldPercent(actions: Pick<SellAction, 'percentage'>[]): number {
  return actions.reduce((a, x) => a + Math.max(0, Number(x.percentage) || 0), 0);
}

function fmtPct(v: number): string { return String(parseFloat((Math.round(v * 100) / 100).toFixed(2))); }

/**
 * Validation for the Sell Action form. `existing` = actions already on the
 * session. Returns an error message or null (messages identical to web).
 */
export function sellActionError(existing: Pick<SellAction, 'percentage'>[], pctRaw: Raw, markupRaw: Raw): string | null {
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

export interface SellInput { percentage: Raw; markup?: Raw; backer_name?: string | null }

/** Normalized sell action ready to store (markup defaults to 1.0). Validate with sellActionError first. */
export function makeSellAction(id: string, sessionId: string, input: SellInput): SellAction {
  const mRaw = String(input.markup ?? '').trim();
  const name = String(input.backer_name ?? '').trim();
  return {
    id,
    session_id: sessionId,
    percentage: Number(input.percentage),
    markup: mRaw === '' ? 1 : Number(mRaw),
    backer_name: name || null,
  };
}

/** "30% sold" / "None" (web sell.js sellSummary). */
export function sellSummary(actions: Pick<SellAction, 'percentage'>[]): string {
  const p = soldPercent(actions);
  return p > 0 ? `${fmtNum(p)}% sold` : 'None';
}

export interface LedgerEntry {
  id: string;
  backer_name: string | null;
  percentage: number;
  markup: number;
  cost: number;
  payout: number;
  backer_net: number;
}

export interface SellLedger {
  entries: LedgerEntry[];
  soldPct: number;
  weightedMarkupShare: number;
  gross: number;
  retained: number;
  received: number;
  paidOut: number;
  backersNet: number;
}

/** Full staking ledger for one tournament. */
export function sellLedger(doc: SessionChildren, s: Session): SellLedger {
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

// --- mutators (ported from js/domain.js; drive them through CloudStore.mutate) ---

/** Attach a validated sell action to a session. Sell actions live inside the session row, so it is touched. */
export function addSellAction(d: Doc, sessionId: string, input: SellInput, newId: IdFn): string {
  const action = makeSellAction(newId(), sessionId, input);
  d.sell_actions.push(action);
  const s = d.sessions.find(x => x.id === sessionId);
  if (s) s.updated_at = new Date().toISOString();
  return action.id;
}

export function deleteSellAction(d: Doc, actionId: string): void {
  const a = d.sell_actions.find(x => x.id === actionId);
  d.sell_actions = d.sell_actions.filter(x => x.id !== actionId);
  const s = a ? d.sessions.find(x => x.id === a.session_id) : undefined;
  if (s) s.updated_at = new Date().toISOString();
}
