// UI pieces shared by the money screens (bankroll overview/detail, staking,
// Top 10): risk-of-ruin value, bankroll-over-time chart, the add/edit
// transaction sheet and the ranked session row. Layout follows the web
// screens (js/screens/bankroll.js, sell.js, top10.js).
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  bankrollSeries, signedAmount, transactionError, TXN_KINDS, addTransaction, deleteTransaction, updateTransaction,
  rorBand, type TxnDirection,
} from '../lib/bankroll';
import { dayNum, fmtDateShort, fmtMoney, fromLocalInput, moneyTone, parseAmount, toLocalInput, weekdayAbbr } from '../lib/format';
import { defaultBankrollId, nameOf, sessionTitle } from '../lib/present';
import type { Doc, Session, Transaction, TransactionKind } from '../lib/types';
import { newId, useStore } from '../state/AppProvider';
import { Button, ErrorText, Field, LineChart, Row, Segmented, Sheet } from './components';
import { Icon } from './icons';
import { colors, PAD, toneColor, type } from './theme';

// --- risk of ruin -----------------------------------------------------------------

export function rorColor(ror: number | null): string {
  const b = rorBand(ror);
  return b === 'high' ? colors.negative : b === 'mid' ? colors.warning : b === 'low' ? colors.accent : colors.text3;
}

export function rorText(ror: number | null): string {
  return ror === null ? '--' : `${ror}%`;
}

// --- chart ------------------------------------------------------------------------

/** Running bankroll over time (all bankrolls when id is null). */
export function BankrollChart({ doc, bankrollId, width }: { doc: Doc; bankrollId: string | null; width: number }) {
  const points = bankrollSeries(doc, bankrollId).map(p => ({ x: p.t, y: p.y }));
  return <LineChart points={points} width={width} />;
}

// --- transaction sheet ------------------------------------------------------------

/** Epoch ms of a transaction, NaN when missing/invalid (same as web's Date.parse on null). */
export function txnTime(t: Pick<Transaction, 'occurred_at'> | null | undefined): number {
  return t?.occurred_at ? Date.parse(t.occurred_at) : NaN;
}

export interface TxnSheetTarget {
  /** Edit this transaction; omit to add a new one. */
  txn?: Transaction;
  /** Preselected bankroll for a new transaction. */
  bankrollId?: string | null;
}

/** Mount with a fresh `key` per opening so the fields start from the target. */
export function TransactionSheet({ doc, target, onClose }: { doc: Doc; target: TxnSheetTarget; onClose: () => void }) {
  const store = useStore();
  const { txn } = target;
  const [kind, setKind] = useState<TransactionKind>(txn?.kind ?? 'deposit');
  const [direction, setDirection] = useState<TxnDirection>(txn && txn.kind === 'other' && Number(txn.amount) > 0 ? 'in' : 'out');
  const [amount, setAmount] = useState(txn ? String(Math.abs(Number(txn.amount) || 0)) : '');
  const [desc, setDesc] = useState(txn?.description ?? '');
  const [when, setWhen] = useState(() => {
    const at = txnTime(txn);
    return Number.isFinite(at) ? toLocalInput(new Date(at)) : '';
  });
  const [bankrollId, setBankrollId] = useState<string | null>(txn?.bankroll_id ?? target.bankrollId ?? defaultBankrollId(doc));
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = () => {
    // Empty date = now; a typed date must parse (transactionError reports "Enter a valid date").
    const occurred = when.trim() === '' ? new Date() : fromLocalInput(when);
    const amountNum = parseAmount(amount);
    const err = transactionError({ kind, amountRaw: amountNum === null ? amount : String(amountNum), occurredAt: occurred });
    if (err) { setError(err); return; }
    if (!bankrollId) { setError('Pick a bankroll'); return; }
    const fields = {
      bankroll_id: bankrollId,
      kind,
      amount: signedAmount(kind, amountNum as number, direction),
      description: desc.trim() || null,
      occurred_at: (occurred as Date).toISOString(),
    };
    if (txn) store.mutate(d => updateTransaction(d, txn.id, fields));
    else store.mutate(d => { addTransaction(d, fields, newId); });
    onClose();
  };

  return (
    <Sheet visible title={txn ? 'Edit transaction' : 'Add transaction'} onClose={onClose}>
      <Segmented<TransactionKind> options={TXN_KINDS.map(k => ({ id: k.id, label: k.label }))} value={kind} onChange={setKind} />
      {kind === 'other' ? (
        <Segmented<TxnDirection> options={[{ id: 'out', label: 'Expense' }, { id: 'in', label: 'Income' }]}
          value={direction} onChange={setDirection} />
      ) : null}
      <Field label="Amount" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0" autoFocus={!txn} />
      <Field label="Description" value={desc} onChangeText={setDesc} placeholder="Optional" />
      <Field label="Date (empty = now)" value={when} onChangeText={setWhen} placeholder={toLocalInput(new Date())} />
      {doc.bankrolls.length > 1 ? (
        <Segmented<string> scroll options={doc.bankrolls.map(b => ({ id: b.id, label: b.name }))}
          value={bankrollId ?? ''} onChange={setBankrollId} />
      ) : null}
      <ErrorText text={error} />
      <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: PAD, paddingTop: 8 }}>
        {txn ? (
          <Button label={confirmDelete ? 'Tap to delete' : 'Delete'} kind="danger" style={{ flex: 1 }}
            onPress={() => {
              if (!confirmDelete) { setConfirmDelete(true); return; }
              store.mutate(d => deleteTransaction(d, txn.id));
              onClose();
            }} />
        ) : null}
        <Button label="Save" onPress={save} style={{ flex: 1 }} />
      </View>
      {confirmDelete ? (
        <Text style={[type.small, { paddingHorizontal: PAD, paddingTop: 8 }]}>This removes it from the bankroll total.</Text>
      ) : null}
    </Sheet>
  );
}

/** One transaction in a bankroll detail list: description (or kind) + date, signed amount. */
export function TransactionRow({ txn, signed, currency, onPress }: { txn: Transaction; signed: number; currency: string; onPress: () => void }) {
  const label = txn.description || TXN_KINDS.find(k => k.id === txn.kind)?.label || txn.kind;
  const at = txnTime(txn);
  return (
    <Row label={label} sub={Number.isFinite(at) ? fmtDateShort(new Date(at)) : '--'}
      value={fmtMoney(signed, currency)} valueColor={toneColor(moneyTone(signed))} onPress={onPress} />
  );
}

// --- ranked session row ----------------------------------------------------------

/** Top 10 row: rank, date column, title, net in the chosen staking mode. Opens the session. */
export function RankedSessionRow({ doc, rank, session, net }: { doc: Doc; rank: number; session: Session; net: number }) {
  const d = new Date(session.start_time);
  const title = sessionTitle(doc, session);
  const loc = nameOf(doc.locations, session.location_id);
  const money = fmtMoney(net, doc.settings.currency);
  return (
    <Pressable onPress={() => router.push({ pathname: '/session/[id]', params: { id: session.id } })}
      accessibilityRole="button" accessibilityLabel={`Rank ${rank}, ${title}, ${money}`}
      style={({ pressed }) => [s.row, pressed && { backgroundColor: colors.bg2 }]}>
      <Text style={s.rank}>{rank}</Text>
      <View style={s.dateCol}>
        <Text style={s.dow}>{weekdayAbbr(d)}</Text>
        <Text style={s.dnum}>{dayNum(d)}</Text>
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={type.body} numberOfLines={1}>{title}</Text>
        <Text style={type.small} numberOfLines={1}>{fmtDateShort(d)}{loc ? ` · ${loc}` : ''}</Text>
      </View>
      <Text style={[type.mid, { fontSize: 20, color: toneColor(moneyTone(net)) }]}>{money}</Text>
      <Icon name="chevron" size={16} color={colors.text3} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  row: {
    minHeight: 68, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: PAD,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  rank: { width: 22, color: colors.text3, fontSize: 15, fontWeight: '500', textAlign: 'right', fontVariant: ['tabular-nums'] },
  dateCol: { width: 34, alignItems: 'center' },
  dow: { color: colors.text2, fontSize: 11, fontWeight: '500', letterSpacing: 0.5 },
  dnum: { color: colors.text, fontSize: 20, fontWeight: '300' },
});
