// Bankroll math (brief 5.15 + formula 12), a faithful port of the web app's
// js/bankroll.js, plus the bankroll/transaction mutators from js/domain.js
// and the bankroll guards from js/manage.js. Pure apart from mutating the
// Doc draft CloudStore.mutate hands out.
//
// Bankroll value = sum of session net results in that bankroll + sum of its
// transactions. Session results count the player's RETAINED share (formula 1,
// net of staking): money paid to backers was never the player's, so the
// balance is independent of the Statistics gross/net display toggle.

import type { IdFn } from './domain';
import { cashOnly, endedSessions, hourlyMoments, riskOfRuin, sessionNet, type HourlyMoments } from './stats';
import type { Bankroll, Doc, Session, Transaction, TransactionKind } from './types';

export const TXN_KINDS: { id: TransactionKind; label: string; plural: string }[] = [
  { id: 'deposit', label: 'Deposit', plural: 'Deposits' },
  { id: 'withdrawal', label: 'Withdrawal', plural: 'Withdrawals' },
  { id: 'other', label: 'Other', plural: 'Other' },
];

/** Direction of an "other" transaction: expense (out) or income (in). */
export type TxnDirection = 'out' | 'in';

type MoneyDoc = Pick<Doc, 'sessions' | 'stack_events' | 'sell_actions' | 'transactions'>;

/**
 * Signed effect of a transaction on the bankroll. Deposits always add and
 * withdrawals always subtract, whatever sign an imported row carries;
 * "other" keeps its stored sign (expense < 0, income > 0).
 */
export function txnSigned(t: Pick<Transaction, 'kind' | 'amount'> | null | undefined): number {
  const a = Number(t && t.amount);
  if (!t || !Number.isFinite(a)) return 0;
  if (t.kind === 'deposit') return Math.abs(a);
  if (t.kind === 'withdrawal') return -Math.abs(a);
  return a;
}

/** Stored (signed) amount for a transaction typed as a positive number. */
export function signedAmount(kind: TransactionKind, amount: number | string, direction: TxnDirection = 'out'): number {
  const a = Math.abs(Number(amount));
  if (kind === 'deposit') return a;
  if (kind === 'withdrawal') return -a;
  return direction === 'in' ? a : -a;
}

/** Validation for the transaction sheet (messages identical to web). Error message or null. */
export function transactionError({ kind, amountRaw, occurredAt, nowMs = Date.now() }: {
  kind: string; amountRaw: string | number | null | undefined; occurredAt: Date | string | null; nowMs?: number;
}): string | null {
  if (!TXN_KINDS.some(k => k.id === kind)) return 'Pick a transaction type';
  const raw = String(amountRaw ?? '').trim();
  const a = Number(raw);
  if (raw === '' || !Number.isFinite(a) || a <= 0) return 'Enter an amount greater than 0';
  const t = occurredAt instanceof Date ? occurredAt.getTime() : Date.parse(String(occurredAt));
  if (!Number.isFinite(t)) return 'Enter a valid date';
  if (t > nowMs) return 'Date cannot be in the future';
  return null;
}

const inBankroll = (id: string | null) => (x: { bankroll_id: string | null }) => id === null || x.bankroll_id === id;

export function bankrollSessions(doc: Pick<Doc, 'sessions'>, bankrollId: string | null = null): Session[] {
  return endedSessions(doc).filter(inBankroll(bankrollId));
}

export function bankrollTransactions(doc: Pick<Doc, 'transactions'>, bankrollId: string | null = null): Transaction[] {
  return (doc.transactions || []).filter(inBankroll(bankrollId));
}

export interface BankrollSummary {
  total: number;
  net: number;
  /** deposits - withdrawals ("Net banked amount") */
  banked: number;
  deposits: number;
  withdrawals: number;
  other: number;
  sessionCount: number;
  txnCount: number;
  cashCount: number;
  moments: HourlyMoments | null;
  ror: number | null;
}

/** Everything the Bankroll screens show for one bankroll (or all, id = null). */
export function bankrollSummary(doc: MoneyDoc, bankrollId: string | null = null): BankrollSummary {
  const sessions = bankrollSessions(doc, bankrollId);
  const txns = bankrollTransactions(doc, bankrollId);
  const net = sessions.reduce((a, s) => a + sessionNet(doc, s, 'net'), 0);
  const byKind: Record<TransactionKind, number> = { deposit: 0, withdrawal: 0, other: 0 };
  for (const t of txns) if (t.kind in byKind) byKind[t.kind] += txnSigned(t);
  const txnTotal = byKind.deposit + byKind.withdrawal + byKind.other;
  const total = net + txnTotal;
  const cash = cashOnly(sessions);
  return {
    total,
    net,
    banked: byKind.deposit + byKind.withdrawal,
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

export type RorBand = 'high' | 'mid' | 'low' | '';

/** Brief formula 12 colour bands: red > 30%, yellow 10-30%, green < 10%. */
export function rorBand(ror: number | null | undefined): RorBand {
  if (ror === null || ror === undefined) return '';
  if (ror > 30) return 'high';
  if (ror >= 10) return 'mid';
  return 'low';
}

export interface BalancePoint { t: number; y: number }

/**
 * Running bankroll over time: every transaction at occurred_at and every
 * ended session at end_time, in chronological order.
 */
export function bankrollSeries(doc: MoneyDoc, bankrollId: string | null = null): BalancePoint[] {
  const events: { t: number; d: number }[] = [];
  for (const t of bankrollTransactions(doc, bankrollId)) {
    events.push({ t: Date.parse(String(t.occurred_at)), d: txnSigned(t) });
  }
  for (const s of bankrollSessions(doc, bankrollId)) {
    events.push({ t: Date.parse(String(s.end_time)), d: sessionNet(doc, s, 'net') });
  }
  // Same comparator as web, so equal timestamps keep their insertion order (stable sort).
  events.sort((a, b) => a.t - b.t);
  let run = 0;
  return events.filter(e => Number.isFinite(e.t)).map(e => { run += e.d; return { t: e.t, y: run }; });
}

/** Sessions and transactions referencing a bankroll (guards deletion). */
export function bankrollUsage(doc: Pick<Doc, 'sessions' | 'transactions'>, bankrollId: string): { sessions: number; transactions: number } {
  return {
    sessions: doc.sessions.filter(s => s.bankroll_id === bankrollId).length,
    transactions: (doc.transactions || []).filter(t => t.bankroll_id === bankrollId).length,
  };
}

/** Bankroll name check (web manage.masterNameError for 'bankrolls'). Error message or null. */
export function bankrollNameError(doc: Pick<Doc, 'bankrolls'>, name: string, exceptId: string | null = null): string | null {
  const v = String(name ?? '').trim();
  if (!v) return 'Enter a name';
  if (v.length > 60) return 'Keep the name under 60 characters';
  const clash = doc.bankrolls.some(x => x.id !== exceptId && String(x.name).trim().toLowerCase() === v.toLowerCase());
  return clash ? 'That name already exists' : null;
}

/** Bankroll delete guard (web manage.masterDeleteError for 'bankrolls'). Error message or null. */
export function bankrollDeleteError(doc: Pick<Doc, 'sessions' | 'transactions' | 'bankrolls'>, bankrollId: string): string | null {
  const u = bankrollUsage(doc, bankrollId);
  const used = u.sessions + u.transactions;
  if (used) return `Used by ${used} ${used === 1 ? 'record' : 'records'} — reassign them first`;
  if (doc.bankrolls.length <= 1) return 'Keep at least one bankroll';
  return null;
}

// --- mutators (ported from js/domain.js; drive them through CloudStore.mutate) ---

export interface TransactionFields {
  bankroll_id: string;
  kind: TransactionKind;
  amount: number;
  description: string | null;
  occurred_at: string;
}

export function addTransaction(d: Doc, f: TransactionFields, newId: IdFn): string {
  const id = newId();
  d.transactions.push({
    id, bankroll_id: f.bankroll_id, kind: f.kind, amount: f.amount,
    description: f.description || null, occurred_at: f.occurred_at, created_at: new Date().toISOString(),
  });
  return id;
}

export function updateTransaction(d: Doc, txnId: string, patch: Partial<TransactionFields>): void {
  // Replace the object rather than mutating it: CloudStore.mutate copies the array shallowly.
  d.transactions = d.transactions.map(t => (t.id === txnId ? { ...t, ...patch } : t));
}

export function deleteTransaction(d: Doc, txnId: string): void {
  d.transactions = d.transactions.filter(t => t.id !== txnId);
}

export function addBankroll(d: Doc, name: string, newId: IdFn, makeDefault = false): string {
  const id = newId();
  const first = d.bankrolls.length === 0;
  if (makeDefault) d.bankrolls = d.bankrolls.map(b => ({ ...b, is_default: false }));
  const b: Bankroll = { id, name: name.trim(), is_default: makeDefault || first, created_at: new Date().toISOString() };
  d.bankrolls.push(b);
  return id;
}

export function setDefaultBankroll(d: Doc, bankrollId: string): void {
  d.bankrolls = d.bankrolls.map(b => ({ ...b, is_default: b.id === bankrollId }));
}

export function renameBankroll(d: Doc, bankrollId: string, name: string): void {
  d.bankrolls = d.bankrolls.map(b => (b.id === bankrollId ? { ...b, name: name.trim() } : b));
}

/** Delete an unused bankroll (check bankrollDeleteError first); the default moves to the first remaining one. */
export function deleteBankroll(d: Doc, bankrollId: string): void {
  const wasDefault = !!d.bankrolls.find(b => b.id === bankrollId)?.is_default;
  d.bankrolls = d.bankrolls.filter(b => b.id !== bankrollId);
  if (wasDefault && d.bankrolls.length) d.bankrolls[0] = { ...d.bankrolls[0], is_default: true };
}
