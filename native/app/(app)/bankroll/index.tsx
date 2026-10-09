// Bankroll overview (brief 5.15), a port of the web BankrollScreen: total and
// risk of ruin across every bankroll, bankroll-over-time chart, one row per
// bankroll with its current total, add bankroll / add transaction.
import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { addBankroll, bankrollNameError, bankrollSummary } from '../../../src/lib/bankroll';
import { fmtMoney, moneyTone } from '../../../src/lib/format';
import { newId, useDoc, useStore } from '../../../src/state/AppProvider';
import { Button, Empty, Header, HeaderButton, Row, SectionHeader, useSheets } from '../../../src/ui/components';
import { BankrollChart, rorColor, rorText, TransactionSheet, type TxnSheetTarget } from '../../../src/ui/money';
import { colors, PAD, toneColor, type } from '../../../src/ui/theme';

export default function BankrollScreen() {
  const doc = useDoc();
  const store = useStore();
  const { width } = useWindowDimensions();
  const { prompt, sheets } = useSheets();
  const [txnSheet, setTxnSheet] = useState<{ target: TxnSheetTarget; seq: number } | null>(null);
  const cur = doc.settings.currency;
  const all = bankrollSummary(doc, null);
  const chartWidth = Math.min(width, 520) - PAD * 2;

  const newBankroll = () => prompt({
    title: 'New bankroll', label: 'Name', initial: '', placeholder: 'e.g. Online',
    onSave: raw => {
      const err = bankrollNameError(store.getState(), raw);
      if (err) return err;
      let id = '';
      store.mutate(d => { id = addBankroll(d, raw, newId); });
      router.push({ pathname: '/bankroll/[id]', params: { id } });
      return null;
    },
  });

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title="Bankroll"
        left={<HeaderButton label="Back" icon="back" tone="plain" onPress={() => router.back()} />}
        right={<HeaderButton label="Add bankroll" icon="plus" onPress={newBankroll} />} />
      <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
        <View style={{ flexDirection: 'row', paddingHorizontal: PAD, paddingBottom: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={type.label}>Total</Text>
            <Text numberOfLines={1} adjustsFontSizeToFit style={[type.big, s2.half, { color: toneColor(moneyTone(all.total)) }]} accessibilityLabel={`Total ${fmtMoney(all.total, cur)}`}>
              {fmtMoney(all.total, cur)}
            </Text>
          </View>
          <View style={{ flex: 1, alignItems: 'flex-end' }}>
            <Text style={type.label}>Risk of ruin</Text>
            <Text numberOfLines={1} adjustsFontSizeToFit style={[type.big, s2.half, { color: rorColor(all.ror) }]} accessibilityLabel={`Risk of ruin ${rorText(all.ror)}`}>
              {rorText(all.ror)}
            </Text>
          </View>
        </View>
        <View style={{ paddingHorizontal: PAD }}>
          <BankrollChart doc={doc} bankrollId={null} width={chartWidth} />
          <Text style={[type.small, { textAlign: 'center', paddingTop: 4 }]}>Bankroll over time</Text>
        </View>
        <Text style={[type.small, { paddingHorizontal: PAD, paddingTop: 12 }]}>
          Risk of ruin = exp(-2 · mean · bankroll / variance) from your cash hourly results
          {all.moments ? ` (mean ${fmtMoney(all.moments.mean, cur)}/h, SD ${fmtMoney(Math.sqrt(all.moments.variance), cur)}/h)` : ''}.
        </Text>

        <SectionHeader title="Bankrolls" />
        {doc.bankrolls.length === 0 ? <Empty text="No bankrolls yet." /> : doc.bankrolls.map(b => {
          const s = bankrollSummary(doc, b.id);
          return (
            <Row key={b.id} label={b.name} sub={b.is_default ? 'Default' : undefined}
              value={fmtMoney(s.total, cur)} valueColor={toneColor(moneyTone(s.total))}
              onPress={() => router.push({ pathname: '/bankroll/[id]', params: { id: b.id } })} />
          );
        })}
        <View style={{ padding: PAD }}>
          <Button label="Add transaction" disabled={doc.bankrolls.length === 0}
            onPress={() => setTxnSheet(p => ({ target: {}, seq: (p?.seq ?? 0) + 1 }))} />
        </View>
      </ScrollView>
      {sheets}
      {txnSheet ? <TransactionSheet key={txnSheet.seq} doc={doc} target={txnSheet.target} onClose={() => setTxnSheet(null)} /> : null}
    </View>
  );
}

// Two big numbers share one row at 390pt; keep each on one line.
const s2 = StyleSheet.create({ half: { fontSize: 34 } });
