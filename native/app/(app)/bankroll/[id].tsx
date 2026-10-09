// Bankroll detail (brief 5.15), a port of the web BankrollDetailScreen: chart,
// Global section (total, net result, net banked amount, RoR), transactions
// grouped by kind, add/edit transaction, rename, make default, guarded delete.
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, useWindowDimensions, View } from 'react-native';

import {
  bankrollDeleteError, bankrollNameError, bankrollSummary, bankrollTransactions, deleteBankroll, renameBankroll,
  setDefaultBankroll, txnSigned, TXN_KINDS,
} from '../../../src/lib/bankroll';
import { fmtMoney, moneyTone } from '../../../src/lib/format';
import { useDoc, useStore } from '../../../src/state/AppProvider';
import {
  Button, ConfirmSheet, Empty, ErrorText, Header, HeaderButton, Row, SectionHeader, useSheets,
} from '../../../src/ui/components';
import {
  BankrollChart, rorColor, rorText, TransactionRow, TransactionSheet, txnTime, type TxnSheetTarget,
} from '../../../src/ui/money';
import { colors, PAD, toneColor, type } from '../../../src/ui/theme';

export default function BankrollDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const doc = useDoc();
  const store = useStore();
  const { width } = useWindowDimensions();
  const { prompt, sheets } = useSheets();
  const [txnSheet, setTxnSheet] = useState<{ target: TxnSheetTarget; seq: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const back = <HeaderButton label="Back" icon="back" tone="plain" onPress={() => router.back()} />;
  const b = doc.bankrolls.find(x => x.id === id);
  if (!b) {
    return <View style={{ flex: 1, backgroundColor: colors.bg }}><Header title="Bankroll" left={back} /><Empty text="This bankroll no longer exists." /></View>;
  }
  const cur = doc.settings.currency;
  const s = bankrollSummary(doc, b.id);
  const txns = bankrollTransactions(doc, b.id).slice()
    .sort((x, y) => txnTime(y) - txnTime(x));
  const openTxn = (target: TxnSheetTarget) => setTxnSheet(p => ({ target, seq: (p?.seq ?? 0) + 1 }));
  const money = (v: number) => ({ value: fmtMoney(v, cur), valueColor: toneColor(moneyTone(v)) });

  const rename = () => prompt({
    title: 'Rename bankroll', label: 'Name', initial: b.name,
    onSave: raw => {
      const err = bankrollNameError(store.getState(), raw, b.id);
      if (err) return err;
      store.mutate(d => renameBankroll(d, b.id, raw));
      return null;
    },
  });
  const askDelete = () => {
    const err = bankrollDeleteError(store.getState(), b.id);
    setDeleteError(err);
    if (!err) setConfirmDelete(true);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title={b.name} left={back} right={<HeaderButton label="Rename" onPress={rename} />} />
      <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
        <View style={{ paddingHorizontal: PAD }}>
          <BankrollChart doc={doc} bankrollId={b.id} width={Math.min(width, 520) - PAD * 2} />
          <Text style={[type.small, { textAlign: 'center', paddingTop: 4 }]}>{b.name} over time · RoR {rorText(s.ror)}</Text>
        </View>

        <SectionHeader title="Global" />
        <Row label="Bankroll total" {...money(s.total)} />
        <Row label="Net result" {...money(s.net)} />
        <Row label="Net banked amount" {...money(s.banked)} />
        <Row label="Risk of ruin" value={rorText(s.ror)} valueColor={rorColor(s.ror)} />
        <Row label="Sessions · transactions" value={`${s.sessionCount} · ${s.txnCount}`} />

        <SectionHeader title="Transactions" />
        {txns.length === 0 ? <Empty text="No transactions yet." /> : TXN_KINDS.map(k => {
          const list = txns.filter(t => t.kind === k.id);
          if (!list.length) return null;
          const total = list.reduce((a, t) => a + txnSigned(t), 0);
          return (
            <View key={k.id}>
              <SectionHeader title={k.plural}
                right={<Text style={[type.body, { color: toneColor(moneyTone(total)) }]}>{fmtMoney(total, cur)}</Text>} />
              {list.map(t => (
                <TransactionRow key={t.id} txn={t} signed={txnSigned(t)} currency={cur} onPress={() => openTxn({ txn: t })} />
              ))}
            </View>
          );
        })}

        <View style={{ padding: PAD, gap: 10 }}>
          <Button label="Add transaction" onPress={() => openTxn({ bankrollId: b.id })} />
          {b.is_default ? null : (
            <Button label="Make default" kind="secondary" onPress={() => store.mutate(d => setDefaultBankroll(d, b.id))} />
          )}
          <Button label="Delete bankroll" kind="danger" onPress={askDelete} />
        </View>
        <ErrorText text={deleteError} />
      </ScrollView>
      {sheets}
      {txnSheet ? <TransactionSheet key={txnSheet.seq} doc={doc} target={txnSheet.target} onClose={() => setTxnSheet(null)} /> : null}
      <ConfirmSheet visible={confirmDelete} title="Delete bankroll?" confirmLabel="Delete"
        message={`"${b.name}" has no sessions or transactions. Delete it?`}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => { store.mutate(d => deleteBankroll(d, b.id)); router.back(); }} />
    </View>
  );
}
