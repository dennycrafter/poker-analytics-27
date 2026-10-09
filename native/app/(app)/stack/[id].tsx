// Stack screen (brief 5.4). Buy-in for stack-tracked cash sessions is the sum
// of buy_in + top_up events (single source of truth), so editing buy-in here
// means adding or deleting events. Chart: x = hours since start, y = running
// stack movement (adds up, cash-outs down), as on the web.
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';

import { addStackEvent, deleteStackEvent, getSession } from '../../../src/lib/domain';
import { fmtDur, fmtMoney, fmtNum, fromLocalInput, moneyTone, parseAmount, toLocalInput } from '../../../src/lib/format';
import { netResult, playSeconds, stackSeries } from '../../../src/lib/stats';
import type { StackEvent, StackEventKind } from '../../../src/lib/types';
import { newId, useDoc, useNow, useStore } from '../../../src/state/AppProvider';
import {
  Button, ConfirmSheet, Empty, ErrorText, Field, Header, HeaderButton, LineChart, Segmented, SectionHeader, Sheet,
} from '../../../src/ui/components';
import { Icon } from '../../../src/ui/icons';
import { colors, PAD, toneColor, type } from '../../../src/ui/theme';

type ChangeKind = Exclude<StackEventKind, 'buy_in'>;

export default function StackScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const doc = useDoc();
  const store = useStore();
  const { width } = useWindowDimensions();
  const s = getSession(doc, id);
  const now = useNow(s?.is_live ? 1000 : 60000);
  const [recording, setRecording] = useState(false);
  const [toDelete, setToDelete] = useState<StackEvent | null>(null);

  const back = <HeaderButton label="Back" icon="back" tone="plain" onPress={() => router.back()} />;
  if (!s || s.kind !== 'cash') {
    return <View style={{ flex: 1, backgroundColor: colors.bg }}><Header title="Stack" left={back} /><Empty text="No stack for this session." /></View>;
  }
  const cur = doc.settings.currency;
  const net = netResult(doc, s);
  const startMs = Date.parse(s.start_time);
  const events = doc.stack_events
    .filter(e => e.session_id === s.id)
    .sort((a, b) => Date.parse(b.occurred_at ?? '') - Date.parse(a.occurred_at ?? ''));
  const chronological = [...events].reverse();
  const runningAfter = new Map<string, number>();
  let run = 0;
  for (const e of chronological) {
    run += e.kind === 'cash_out' ? -e.amount : e.amount;
    runningAfter.set(e.id, run);
  }
  const buyIns = events.filter(e => e.kind !== 'cash_out');
  const chartWidth = Math.min(width, 520) - PAD * 2;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title="Stack" left={back} />
      <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
        <View style={{ flexDirection: 'row', paddingHorizontal: PAD, paddingBottom: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={type.label}>Time</Text>
            <Text style={type.big}>{fmtDur(playSeconds(s, now))}</Text>
          </View>
          <View style={{ flex: 1, alignItems: 'flex-end' }}>
            <Text style={type.label}>Net result</Text>
            <Text style={[type.big, { color: toneColor(moneyTone(net)) }]}>{fmtMoney(net, cur)}</Text>
          </View>
        </View>
        <View style={{ paddingHorizontal: PAD }}>
          <LineChart points={stackSeries(doc, s)} width={chartWidth} />
        </View>

        <SectionHeader title="Stack events" />
        {!s.tracked_via_stack ? (
          <Empty text="This session was logged after the fact; its buy-in and cash-out are edited on the session itself." />
        ) : events.length === 0 ? (
          <Empty text="No stack events yet." />
        ) : events.map(e => {
          const at = (Date.parse(e.occurred_at ?? s.start_time) - startMs) / 1000;
          const add = e.kind !== 'cash_out';
          // The only buy-in cannot be removed: a stack-tracked session needs one.
          const removable = !(e.kind === 'buy_in' && buyIns.length === 1);
          return (
            <View key={e.id} style={{ minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: PAD,
              borderBottomWidth: 1, borderBottomColor: colors.border }}>
              <Text style={[type.body, { color: colors.text2, width: 56, fontVariant: ['tabular-nums'] }]}>{fmtDur(Math.max(0, at))}</Text>
              <View style={{ flex: 1 }}>
                <Text style={[type.body, { color: add ? colors.accent : colors.negative }]}>
                  {add ? '+' : '-'}{fmtNum(e.amount)} {e.kind === 'buy_in' ? 'buy-in' : e.kind === 'top_up' ? 'top-up' : 'cash-out'}
                </Text>
              </View>
              <Text style={[type.body, { fontVariant: ['tabular-nums'] }]}>{fmtNum(runningAfter.get(e.id) ?? 0)}</Text>
              {removable ? (
                <Pressable onPress={() => setToDelete(e)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Delete stack event">
                  <Icon name="trash" size={18} color={colors.text3} />
                </Pressable>
              ) : <View style={{ width: 18 }} />}
            </View>
          );
        })}
        {s.tracked_via_stack ? (
          <View style={{ padding: PAD }}>
            <Button label="Record stack change" onPress={() => setRecording(true)} />
          </View>
        ) : null}
      </ScrollView>

      <RecordSheet visible={recording} startMs={startMs} endMs={s.end_time ? Date.parse(s.end_time) : null}
        onClose={() => setRecording(false)}
        onSave={(kind, amount, at) => {
          store.mutate(d => addStackEvent(d, s.id, { kind, amount, occurred_at: at.toISOString() }, newId));
          setRecording(false);
        }} />
      <ConfirmSheet visible={toDelete !== null} title="Delete stack event" confirmLabel="Delete"
        message={toDelete ? `Remove this ${fmtMoney(toDelete.amount, cur)} event? The session result changes accordingly.` : ''}
        onClose={() => setToDelete(null)}
        onConfirm={() => { const e = toDelete; if (e) store.mutate(d => deleteStackEvent(d, e.id)); }} />
    </View>
  );
}

/** Top up / Cash out, amount, time (default now; must fall within the session). */
function RecordSheet({ visible, startMs, endMs, onClose, onSave }: {
  visible: boolean; startMs: number; endMs: number | null; onClose: () => void;
  onSave: (kind: ChangeKind, amount: number, at: Date) => void;
}) {
  const [kind, setKind] = useState<ChangeKind>('top_up');
  const [amount, setAmount] = useState('');
  const [time, setTime] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const v = parseAmount(amount);
    if (v === null || v <= 0) { setError('Enter an amount above zero.'); return; }
    const at = time.trim() === '' ? new Date(endMs ?? Date.now()) : fromLocalInput(time);
    if (!at) { setError('Use the format YYYY-MM-DD HH:MM.'); return; }
    const latest = endMs ?? Date.now();
    // Minute precision in the input, so allow the start minute itself.
    if (at.getTime() < startMs - 60000 || at.getTime() > latest + 60000) { setError('The time must fall within the session.'); return; }
    setAmount(''); setTime(''); setError(null);
    onSave(kind, v, new Date(Math.max(startMs, Math.min(at.getTime(), latest))));
  };
  return (
    <Sheet visible={visible} title="Record stack change" onClose={onClose}>
      <Segmented<ChangeKind> options={[{ id: 'top_up', label: 'Top up' }, { id: 'cash_out', label: 'Cash out' }]} value={kind} onChange={setKind} />
      <Field label="Amount" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" autoFocus />
      <Field label="Time (empty = now)" value={time} onChangeText={setTime} placeholder={toLocalInput(new Date(endMs ?? Date.now()))} />
      <ErrorText text={error} />
      <Button label="Save" onPress={submit} style={{ marginHorizontal: PAD, marginTop: 8 }} />
    </Sheet>
  );
}
