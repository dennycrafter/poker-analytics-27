// Staking for one tournament (brief 5.6 + formula 1): the sell actions with
// add/delete (a port of the web sell sheet, js/screens/sell.js) plus the
// ledger: what each backer paid and receives, the player's retained result
// and gross = retained + backers. Works for live and ended tournaments.
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { getSession } from '../../../src/lib/domain';
import { fmtMoney, fmtNum, moneyTone } from '../../../src/lib/format';
import { sessionTitle } from '../../../src/lib/present';
import { addSellAction, deleteSellAction, sellActionError, sellActionsOf, sellLedger } from '../../../src/lib/staking';
import type { SellAction } from '../../../src/lib/types';
import { newId, useDoc, useStore } from '../../../src/state/AppProvider';
import {
  Button, ConfirmSheet, Empty, ErrorText, Field, Header, HeaderButton, Row, SectionHeader, Sheet,
} from '../../../src/ui/components';
import { Icon } from '../../../src/ui/icons';
import { colors, PAD, toneColor, type } from '../../../src/ui/theme';

/** "30% · x1.1 · Bob", the same line as the web sell sheet. */
function actionLine(a: SellAction): string {
  const mk = a.markup === null || a.markup === undefined ? 1 : Number(a.markup);
  return `${fmtNum(a.percentage)}% · x${fmtNum(mk)}${a.backer_name ? ' · ' + a.backer_name : ''}`;
}

export default function StakingScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const doc = useDoc();
  const store = useStore();
  const [adding, setAdding] = useState<number | null>(null);
  const [toDelete, setToDelete] = useState<SellAction | null>(null);

  const back = <HeaderButton label="Back" icon="back" tone="plain" onPress={() => router.back()} />;
  const s = getSession(doc, id);
  if (!s || s.kind !== 'tournament') {
    return <View style={{ flex: 1, backgroundColor: colors.bg }}><Header title="Sell action" left={back} /><Empty text="Sell actions apply to tournaments only." /></View>;
  }
  const cur = doc.settings.currency;
  const actions = sellActionsOf(doc, s.id);
  const L = sellLedger(doc, s);
  const left = Math.max(0, 100 - L.soldPct);
  const money = (v: number) => ({ value: fmtMoney(v, cur), valueColor: toneColor(moneyTone(v)) });

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title="Sell action" left={back}
        right={<HeaderButton label="Add sell action" icon="plus" disabled={left <= 0} onPress={() => setAdding(n => (n ?? 0) + 1)} />} />
      <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
        <Text style={[type.small, { paddingHorizontal: PAD }]}>{sessionTitle(doc, s)}{s.is_live ? ' · live' : ''}</Text>
        <View style={{ flexDirection: 'row', paddingHorizontal: PAD, paddingVertical: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={type.label}>Sold</Text>
            <Text style={type.big}>{fmtNum(L.soldPct)}%</Text>
          </View>
          <View style={{ flex: 1, alignItems: 'flex-end' }}>
            <Text style={type.label}>Your result</Text>
            <Text style={[type.big, { color: toneColor(moneyTone(L.retained)) }]}>{fmtMoney(L.retained, cur)}</Text>
          </View>
        </View>

        <SectionHeader title="Backers" right={<Text style={type.small}>{fmtNum(left)}% left</Text>} />
        {actions.length === 0 ? <Empty text="No action sold yet." /> : L.entries.map(e => {
          const a = actions.find(x => x.id === e.id);
          return (
            <View key={e.id} style={{ minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: PAD,
              borderBottomWidth: 1, borderBottomColor: colors.border }}>
              <View style={{ flex: 1 }}>
                <Text style={type.body}>{a ? actionLine(a) : `${fmtNum(e.percentage)}%`}</Text>
                <Text style={type.small}>Paid {fmtMoney(e.cost, cur)} · receives {fmtMoney(e.payout, cur)}</Text>
              </View>
              <Text style={[type.body, { color: toneColor(moneyTone(e.backer_net)) }]}>{fmtMoney(e.backer_net, cur)}</Text>
              {a ? (
                <Pressable onPress={() => setToDelete(a)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Delete sell action">
                  <Icon name="trash" size={18} color={colors.text3} />
                </Pressable>
              ) : null}
            </View>
          );
        })}

        <SectionHeader title="Ledger" />
        <Row label="Total buy-in" value={fmtMoney(Number(s.total_buy_in || 0), cur)} />
        <Row label="Prize" value={fmtMoney(Number(s.prize || 0), cur)} />
        <Row label="Received from backers" {...money(L.received)} />
        <Row label="Paid out to backers" {...money(-L.paidOut)} />
        <Row label="Gross result" {...money(L.gross)} />
        <Row label="Backers' result" {...money(L.backersNet)} />
        <Row label="Your result (net of staking)" {...money(L.retained)} />
        <Text style={[type.small, { paddingHorizontal: PAD, paddingTop: 10 }]}>
          Markup 1.2 = 20% premium on the share&apos;s buy-in. Gross = your result + backers&apos; result.
        </Text>
        {left > 0 ? (
          <View style={{ padding: PAD }}>
            <Button label="Sell action" onPress={() => setAdding(n => (n ?? 0) + 1)} />
          </View>
        ) : null}
      </ScrollView>

      {adding !== null ? (
        <SellSheet key={adding} existing={actions} left={left} onClose={() => setAdding(null)}
          onSave={input => { store.mutate(d => { addSellAction(d, s.id, input, newId); }); setAdding(null); }} />
      ) : null}
      <ConfirmSheet visible={toDelete !== null} title="Delete sell action" confirmLabel="Delete"
        message={toDelete ? `Remove ${actionLine(toDelete)}? Your result changes accordingly.` : ''}
        onClose={() => setToDelete(null)}
        onConfirm={() => { const a = toDelete; if (a) store.mutate(d => deleteSellAction(d, a.id)); }} />
    </View>
  );
}

/** Percentage, markup (default 1.0), backer name; validated by sellActionError (total <= 100%). */
function SellSheet({ existing, left, onClose, onSave }: {
  existing: SellAction[]; left: number; onClose: () => void;
  onSave: (input: { percentage: string; markup: string; backer_name: string }) => void;
}) {
  const [pct, setPct] = useState('');
  const [markup, setMarkup] = useState('1.0');
  const [backer, setBacker] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const p = pct.trim().replace(',', '.');
    const m = markup.trim().replace(',', '.');
    const err = sellActionError(existing, p, m);
    if (err) { setError(err); return; }
    onSave({ percentage: p, markup: m, backer_name: backer });
  };
  return (
    <Sheet visible title="Sell action" onClose={onClose}>
      <Text style={[type.small, { paddingHorizontal: PAD }]}>{fmtNum(left)}% left to sell</Text>
      <Field label="Percentage (%)" value={pct} onChangeText={setPct} keyboardType="decimal-pad" placeholder="e.g. 30" autoFocus />
      <Field label="Markup" value={markup} onChangeText={setMarkup} keyboardType="decimal-pad" />
      <Field label="Backer name" value={backer} onChangeText={setBacker} placeholder="Optional" />
      <ErrorText text={error} />
      <Button label="Save" onPress={save} style={{ marginHorizontal: PAD, marginTop: 8 }} />
    </Sheet>
  );
}
