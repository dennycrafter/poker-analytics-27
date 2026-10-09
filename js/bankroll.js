// Bankroll math (brief 5.15 + formula 12). Pure: no DOM, no store writes.
//
// Bankroll value = Σ session net results in that bankroll + Σ its transactions.
// Session results count the player's RETAINED share (formula 1, net of
// staking): money paid to backers was never the player's, so the balance is
// independent of the Statistics gross/net display toggle.

import { endedSessions, sessionNet, cashOnly, riskOfRuin, hourlyMoments } from './stats.js';

export const TXN_KINDS = [
  { id: 'deposit', label: 'Deposit', plural: 'Deposits' },
  { id: 'withdrawal', label: 'Withdrawal', plural: 'Withdrawals' },
  { id: 'other', label: 'Other', plural: 'Other' },
];

// Signed effect of a transaction on the bankroll. Deposits always add and
// withdrawals always subtract, whatever sign an imported row carries;
// "other" keeps its stored sign (expense < 0, income > 0).
export function txnSigned(t) {
  const a = Number(t && t.amount);
  if (!Number.isFinite(a)) return 0;
  if (t.kind === 'deposit') return Math.abs(a);
  if (t.kind === 'withdrawal') return -Math.abs(a);
  return a;
}

// Stored (signed) amount for a transaction typed in the UI as a positive
// number. `direction` only matters for "other": 'out' (expense) | 'in'.
export function signedAmount(kind, amount, direction = 'out') {
  const a = Math.abs(Number(amount));
  if (kind === 'deposit') return a;
  if (kind === 'withdrawal') return -a;
  return direction === 'in' ? a : -a;
}

// Validation for the transaction sheet. Returns an error message or null.
export function transactionError({ kind, amountRaw, occurredAt, nowMs = Date.now() }) {
  if (!TXN_KINDS.some(k => k.id === kind)) return 'Pick a transaction type';
  const raw = String(amountRaw ?? '').trim();
  const a = Number(raw);
  if (raw === '' || !Number.isFinite(a) || a <= 0) return 'Enter an amount greater than 0';
  const t = occurredAt instanceof Date ? occurredAt.getTime() : Date.parse(occurredAt);
  if (!Number.isFinite(t)) return 'Enter a valid date';
  if (t > nowMs) return 'Date cannot be in the future';
  return null;
}

const inBankroll = id => x => id === null || x.bankroll_id === id;

export function bankrollSessions(doc, bankrollId = null) {
  return endedSessions(doc).filter(inBankroll(bankrollId));
}

export function bankrollTransactions(doc, bankrollId = null) {
  return (doc.transactions || []).filter(inBankroll(bankrollId));
}

// Everything the Bankroll screens show for one bankroll (or all, id = null).
export function bankrollSummary(doc, bankrollId = null) {
  const sessions = bankrollSessions(doc, bankrollId);
  const txns = bankrollTransactions(doc, bankrollId);
  const net = sessions.reduce((a, s) => a + sessionNet(doc, s, 'net'), 0);
  const byKind = { deposit: 0, withdrawal: 0, other: 0 };
  for (const t of txns) if (t.kind in byKind) byKind[t.kind] += txnSigned(t);
  const txnTotal = byKind.deposit + byKind.withdrawal + byKind.other;
  const total = net + txnTotal;
  const cash = cashOnly(sessions);
  return {
    total,
    net,
    banked: byKind.deposit + byKind.withdrawal, // deposits - withdrawals
    deposits: byKind.deposit,
    withdrawals: byKind.withdrawal,
    other: byKind.other,
    sessionCount: sessions.length,
    txnCount: txns.length,
    cashCount: cash.length,
    moments: hourlyMoments(doc, cash),
    ror: riskOfRuin(doc, cash, total),
  };
}

// Brief formula 12 colour bands: red > 30%, yellow 10-30%, green < 10%.
export function rorBand(ror) {
  if (ror === null || ror === undefined) return '';
  if (ror > 30) return 'ror-high';
  if (ror >= 10) return 'ror-mid';
  return 'ror-low';
}

// Running bankroll over time: every transaction at occurred_at and every
// ended session at end_time, in chronological order. [{t: ms, y: balance}]
export function bankrollSeries(doc, bankrollId = null) {
  const events = [];
  for (const t of bankrollTransactions(doc, bankrollId)) {
    events.push({ t: Date.parse(t.occurred_at), d: txnSigned(t) });
  }
  for (const s of bankrollSessions(doc, bankrollId)) {
    events.push({ t: Date.parse(s.end_time), d: sessionNet(doc, s, 'net') });
  }
  events.sort((a, b) => a.t - b.t);
  let run = 0;
  return events.filter(e => Number.isFinite(e.t)).map(e => { run += e.d; return { t: e.t, y: run }; });
}

// Sessions and transactions referencing a bankroll (guards deletion).
export function bankrollUsage(doc, bankrollId) {
  return {
    sessions: doc.sessions.filter(s => s.bankroll_id === bankrollId).length,
    transactions: (doc.transactions || []).filter(t => t.bankroll_id === bankrollId).length,
  };
}
