// Session screen. Live (brief 5.3 / 5.7): ticking timer computed from
// start_time (survives restarts), live hourly rate, pause/resume (break
// time), stack screen, End session. Saved (5.8): same rows, every one
// editable, total duration instead of a timer, Delete at the bottom.
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  addTournamentRebuy, deleteSession, endLiveCash, endLiveTournament, ensureByName, getSession, togglePause,
  updateSession, validateTimes,
} from '../../../src/lib/domain';
import { fmtDateTime, fmtDur, fmtMoney, fmtTimer, fromLocalInput, moneyTone, parseAmount, toLocalInput } from '../../../src/lib/format';
import { nameOf, parseCount, parseStakes, TABLE_SIZES, tableLabel } from '../../../src/lib/present';
import {
  breakSecondsNow, effectiveHands, hourlyRate, liveHourlyRate, netResult, playSeconds, stackBuyIn, stackCashedOut,
} from '../../../src/lib/stats';
import type { NamedItem, Session } from '../../../src/lib/types';
import { newId, useDoc, useNow, useStore } from '../../../src/state/AppProvider';
import {
  Button, ConfirmSheet, Empty, ErrorText, Field, Header, HeaderButton, Row, SectionHeader, Sheet, useSheets,
} from '../../../src/ui/components';
import { Icon } from '../../../src/ui/icons';
import { LiveBadge } from '../../../src/ui/SessionRow';
import { colors, PAD, toneColor, type } from '../../../src/ui/theme';

type MasterKey = 'games' | 'locations' | 'tournament_types' | 'groups' | 'bankrolls';

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const doc = useDoc();
  const store = useStore();
  const insets = useSafeAreaInsets();
  const s = getSession(doc, id);
  const now = useNow(s?.is_live ? 1000 : 60000);
  const { prompt, pick, sheets } = useSheets();
  const [ending, setEnding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (!s) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <Header title="Session" left={<HeaderButton label="Back" icon="back" tone="plain" onPress={() => router.back()} />} />
        <Empty text="This session no longer exists. It may have been deleted on another device." />
      </View>
    );
  }

  const cur = doc.settings.currency;
  const cash = s.kind === 'cash';
  const net = netResult(doc, s);
  const rate = s.is_live ? liveHourlyRate(doc, s, now) : hourlyRate(doc, s, now);
  const patch = (p: Partial<Session>) => store.mutate(d => updateSession(d, s.id, p));
  const money = (v: number | null) => (v === null ? '--' : fmtMoney(v, cur));

  // --- editors ---------------------------------------------------------------
  const editAmount = (title: string, key: 'buy_in' | 'cashed_out' | 'tips' | 'prize', allowEmpty = true) => prompt({
    title, label: `Amount (${cur})`, initial: s[key] === null ? '' : String(s[key]), keyboardType: 'decimal-pad',
    onSave: raw => {
      const v = parseAmount(raw);
      if (raw.trim() === '' && allowEmpty) { patch({ [key]: key === 'tips' ? 0 : null }); return null; }
      if (v === null || v < 0) return 'Enter an amount of zero or more.';
      patch({ [key]: v });
      return null;
    },
  });
  const editCount = (title: string, key: 'position' | 'entries') => prompt({
    title, label: title, initial: s[key] === null ? '' : String(s[key]), keyboardType: 'number-pad',
    onSave: raw => {
      const v = parseCount(raw);
      if (Number.isNaN(v)) return 'Enter a whole number.';
      const position = key === 'position' ? v : s.position;
      const entries = key === 'entries' ? v : s.entries;
      if (position !== null && entries !== null && position > entries) return 'Position cannot exceed entries.';
      patch({ [key]: v });
      return null;
    },
  });
  const editText = (title: string, key: 'comment' | 'opponents' | 'tournament_name') => prompt({
    title, label: title, initial: s[key] ?? '',
    onSave: raw => { patch({ [key]: raw.trim() || null }); return null; },
  });
  const editHands = () => prompt({
    title: 'Hands count', label: 'Hands played', initial: s.hands_count_estimated ? '' : String(s.hands_count ?? ''),
    keyboardType: 'number-pad', placeholder: s.is_live ? `~${effectiveHands(s, now) ?? 0} (estimate)` : undefined,
    onSave: raw => {
      const v = parseCount(raw);
      if (Number.isNaN(v)) return 'Enter a whole number.';
      // Empty while live = back to the ~30 hands/hour estimate.
      if (v === null && s.is_live) patch({ hands_count: null, hands_count_estimated: true });
      else patch({ hands_count: v, hands_count_estimated: false });
      return null;
    },
    extra: s.is_live && !s.hands_count_estimated
      ? { label: 'Use estimate', onPress: () => patch({ hands_count: null, hands_count_estimated: true }) } : undefined,
  });
  const editMaster = (title: string, key: MasterKey, field: 'game_id' | 'location_id' | 'bankroll_id' | 'group_id' | 'tournament_type_id', allowNone: boolean) => {
    const list = doc[key] as NamedItem[];
    pick({
      title,
      options: [...(allowNone ? [{ id: '', label: 'None' }] : []), ...list.map(x => ({ id: x.id, label: x.name }))],
      selected: s[field] ?? '',
      onPick: v => patch({ [field]: v || null }),
      onAdd: key === 'bankrolls' ? undefined : name => store.mutate(d => {
        const newItem = ensureByName(d[key] as NamedItem[], name, newId);
        updateSession(d, s.id, { [field]: newItem });
      }),
    });
  };
  const editTime = (which: 'start' | 'end') => prompt({
    title: which === 'start' ? 'Start time' : 'End time', label: 'YYYY-MM-DD HH:MM (local time)',
    initial: toLocalInput(new Date(which === 'start' ? s.start_time : (s.end_time ?? s.start_time))),
    onSave: raw => {
      const t = fromLocalInput(raw);
      if (!t) return 'Use the format YYYY-MM-DD HH:MM.';
      const start = which === 'start' ? t : new Date(s.start_time);
      const end = s.is_live ? null : which === 'end' ? t : new Date(s.end_time ?? s.start_time);
      const err = validateTimes(start, end, Date.now());
      if (err) return err;
      if (end) {
        const dur = Math.round((end.getTime() - start.getTime()) / 1000);
        if (dur < s.break_seconds) return 'The session would be shorter than its break time.';
        patch({ start_time: start.toISOString(), end_time: end.toISOString(), duration_seconds: dur });
      } else {
        patch({ start_time: start.toISOString() });
      }
      return null;
    },
  });
  const editBreak = () => prompt({
    title: 'Break time', label: 'Minutes', initial: String(Math.round(s.break_seconds / 60)), keyboardType: 'number-pad',
    onSave: raw => {
      const m = parseCount(raw);
      if (m === null || Number.isNaN(m)) return 'Enter whole minutes.';
      if (s.duration_seconds !== null && m * 60 > s.duration_seconds) return 'Break cannot exceed the session length.';
      patch({ break_seconds: m * 60 });
      return null;
    },
  });
  const editRebuy = () => prompt({
    title: 'Add rebuy / add-on', label: `Amount (${cur})`, initial: String(s.initial_buy_in ?? ''), keyboardType: 'decimal-pad',
    onSave: raw => {
      const v = parseAmount(raw);
      if (v === null || v <= 0) return 'Enter an amount above zero.';
      store.mutate(d => addTournamentRebuy(d, s.id, v));
      return null;
    },
  });
  const editTotalBuyIn = () => prompt({
    title: 'Total buy-in', label: 'Initial + rebuys + add-ons', initial: String(s.total_buy_in ?? ''), keyboardType: 'decimal-pad',
    onSave: raw => {
      const v = parseAmount(raw);
      if (v === null || v < (s.initial_buy_in ?? 0)) return 'Total buy-in cannot be below the initial buy-in.';
      patch({ total_buy_in: v });
      return null;
    },
  });
  const editStakes = () => prompt({
    title: 'Stakes', label: 'Small blind / big blind', initial: `${s.small_blind}/${s.big_blind}`, keyboardType: 'numbers-and-punctuation',
    onSave: raw => { const p = parseStakes(raw); if (!p) return 'Use SB/BB, e.g. 0.5/1.'; patch({ small_blind: p.sb, big_blind: p.bb }); return null; },
  });
  const openStack = () => router.push({ pathname: '/stack/[id]', params: { id: s.id } });

  // --- rows ------------------------------------------------------------------
  const handsValue = s.hands_count_estimated
    ? (s.is_live ? `~${effectiveHands(s, now) ?? 0} (est.)` : '--')
    : String(s.hands_count ?? '--');
  const resultRows = cash ? (
    <>
      {s.tracked_via_stack ? (
        <>
          <Row label="Buy-in" value={fmtMoney(stackBuyIn(doc, s), cur)} onPress={openStack} />
          <Row label="Cashed out" value={s.is_live ? 'On end' : fmtMoney(stackCashedOut(doc, s), cur)} onPress={s.is_live ? undefined : openStack} />
        </>
      ) : (
        <>
          <Row label="Buy-in" value={money(s.buy_in)} onPress={() => editAmount('Buy-in', 'buy_in', false)} />
          <Row label="Cashed out" value={money(s.cashed_out)} onPress={() => editAmount('Cashed out', 'cashed_out')} />
        </>
      )}
    </>
  ) : (
    <>
      <Row label="Buy-in" value={money(s.total_buy_in)} sub={s.total_buy_in !== s.initial_buy_in ? `Initial ${money(s.initial_buy_in)}` : undefined}
        onPress={s.is_live ? editRebuy : editTotalBuyIn} />
      {s.is_live ? <Row label="Add rebuy / add-on" onPress={editRebuy} /> : null}
      <Row label="Prize" value={s.is_live ? 'On end' : money(s.prize)} onPress={s.is_live ? undefined : () => editAmount('Prize', 'prize')} />
      <Row label="Position" value={s.position === null ? '--' : String(s.position)} onPress={() => editCount('Position', 'position')} />
      <Row label="Entries" value={s.entries === null ? '--' : String(s.entries)} onPress={() => editCount('Entries', 'entries')} />
    </>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header
        title={s.is_live ? (cash ? 'Live cash game' : 'Live tournament') : (cash ? 'Cash game' : 'Tournament')}
        left={<HeaderButton label="Back" icon="back" tone="plain" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />}
        right={cash ? <HeaderButton label="Stack" icon="stack" onPress={openStack} /> : undefined}
      />
      <ScrollView contentContainerStyle={{ paddingBottom: s.is_live ? 160 : 48 }}>
        <HeaderCard session={s} net={net} rate={rate} now={now} currency={cur} />

        <SectionHeader title="Result" />
        {resultRows}
        <Row label="Tips" value={s.tips ? fmtMoney(-s.tips, cur) : '--'} onPress={() => editAmount('Tips', 'tips')} />
        <Row label="Hands count" value={handsValue} onPress={editHands} />
        <Row label="Comment" value={s.comment ?? '--'} onPress={() => editText('Comment', 'comment')} />
        <Row label="Opponents" value={s.opponents ?? '--'} onPress={() => editText('Opponents', 'opponents')} />
        <Row label="Break time" value={fmtDur(breakSecondsNow(s, now))} onPress={s.is_live ? undefined : editBreak} />

        <SectionHeader title="Setup" />
        <Row label="Game" value={nameOf(doc.games, s.game_id) ?? '--'} onPress={() => editMaster('Game', 'games', 'game_id', false)} />
        {cash ? <Row label="Stakes" value={`${s.small_blind}/${s.big_blind}`} onPress={editStakes} /> : (
          <>
            <Row label="Tournament type" value={nameOf(doc.tournament_types, s.tournament_type_id) ?? '--'}
              onPress={() => editMaster('Tournament type', 'tournament_types', 'tournament_type_id', true)} />
            <Row label="Name" value={s.tournament_name ?? '--'} onPress={() => editText('Name', 'tournament_name')} />
          </>
        )}
        <Row label="Location" value={nameOf(doc.locations, s.location_id) ?? '--'} onPress={() => editMaster('Location', 'locations', 'location_id', true)} />
        <Row label="Table size" value={tableLabel(s.table_size)} onPress={() => pick({
          title: 'Table size', options: TABLE_SIZES.map(n => ({ id: String(n), label: tableLabel(n) })),
          selected: String(s.table_size ?? ''), onPick: v => patch({ table_size: Number(v) }),
        })} />
        <Row label="Bankroll" value={nameOf(doc.bankrolls, s.bankroll_id) ?? '--'} onPress={() => editMaster('Bankroll', 'bankrolls', 'bankroll_id', false)} />
        <Row label="Group" value={nameOf(doc.groups, s.group_id) ?? '--'} onPress={() => editMaster('Group', 'groups', 'group_id', true)} />
        <Row label="Start" value={fmtDateTime(new Date(s.start_time))} onPress={() => editTime('start')} />
        {s.end_time ? <Row label="End" value={fmtDateTime(new Date(s.end_time))} onPress={() => editTime('end')} /> : null}

        <View style={{ padding: PAD }}>
          <Button label="Delete session" kind="danger" onPress={() => setConfirmDelete(true)} />
        </View>
      </ScrollView>

      {s.is_live ? (
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, paddingBottom: insets.bottom + 12, paddingTop: 12,
          paddingHorizontal: PAD, backgroundColor: colors.bg3, borderTopWidth: 1, borderTopColor: colors.border, gap: 10 }}>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Pressable onPress={() => store.mutate(d => togglePause(d, s.id))} accessibilityRole="button"
              accessibilityLabel={s.paused_at ? 'Resume' : 'Pause'}
              style={{ flex: 1, flexDirection: 'row', gap: 8, height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg2 }}>
              <Icon name={s.paused_at ? 'play' : 'pause'} color={colors.text} size={18} />
              <Text style={type.body}>{s.paused_at ? 'Resume' : 'Pause'}</Text>
            </Pressable>
            {cash ? (
              <Pressable onPress={openStack} accessibilityRole="button" accessibilityLabel="Stack"
                style={{ flex: 1, flexDirection: 'row', gap: 8, height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg2 }}>
                <Icon name="stack" color={colors.text} size={18} />
                <Text style={type.body}>Stack</Text>
              </Pressable>
            ) : null}
          </View>
          <Button label="End session" onPress={() => setEnding(true)} />
        </View>
      ) : null}

      <EndSheet visible={ending} session={s} currency={cur} onClose={() => setEnding(false)}
        onEnd={r => {
          store.mutate(d => (r.kind === 'cash'
            ? endLiveCash(d, s.id, r.cashedOut, newId)
            : endLiveTournament(d, s.id, { position: r.position, prize: r.prize })));
          setEnding(false);
          router.replace('/');
        }} />
      <ConfirmSheet visible={confirmDelete} title="Delete session" confirmLabel="Delete"
        message="This removes the session and its stack history on every device. It cannot be undone."
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => { store.mutate(d => deleteSession(d, s.id)); router.replace('/'); }} />
      {sheets}
    </View>
  );
}

function HeaderCard({ session: s, net, rate, now, currency }: {
  session: Session; net: number; rate: number | null; now: number; currency: string;
}) {
  const secs = s.is_live ? playSeconds(s, now) : playSeconds(s);
  const timer = fmtTimer(secs);
  return (
    <View style={{ marginHorizontal: PAD, marginTop: 4, padding: PAD, borderRadius: 16, backgroundColor: colors.bg2, gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {s.is_live ? <LiveBadge /> : null}
        <Text style={type.label}>{s.is_live ? (s.paused_at ? 'Paused' : 'Playing') : 'Duration'}</Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'baseline' }} accessibilityLabel={`Play time ${timer.main}`}>
        <Text style={[type.big, { fontSize: 56 }]}>{timer.main}</Text>
        {s.is_live ? <Text style={[type.mid, { color: colors.text2 }]}>{timer.sec}</Text> : null}
      </View>
      <View style={{ flexDirection: 'row' }}>
        <View style={{ flex: 1 }}>
          <Text style={type.label}>Net hourly rate</Text>
          <Text style={[type.mid, { fontSize: 20, color: rate === null ? colors.text3 : toneColor(moneyTone(rate)) }]}>
            {rate === null ? (s.is_live ? 'After 15 min' : '--') : `${fmtMoney(rate, currency)}/h`}
          </Text>
        </View>
        <View style={{ flex: 1, alignItems: 'flex-end' }}>
          <Text style={type.label}>Net result</Text>
          <Text style={[type.mid, { fontSize: 20, color: toneColor(moneyTone(net)) }]}>{fmtMoney(net, currency)}</Text>
        </View>
      </View>
    </View>
  );
}

type EndResult = { kind: 'cash'; cashedOut: number } | { kind: 'tournament'; position: number | null; prize: number | null };

/** End-of-session sheet: cash asks for the cash-out amount, tournaments for position and prize. */
function EndSheet({ visible, session: s, currency, onClose, onEnd }: {
  visible: boolean; session: Session; currency: string; onClose: () => void; onEnd: (r: EndResult) => void;
}) {
  const [amount, setAmount] = useState('');
  const [position, setPosition] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const v = amount.trim() === '' ? 0 : parseAmount(amount);
    if (v === null || v < 0) { setError('Enter an amount of zero or more.'); return; }
    if (s.kind === 'cash') { onEnd({ kind: 'cash', cashedOut: v }); return; }
    const p = parseCount(position);
    if (Number.isNaN(p)) { setError('Position must be a whole number.'); return; }
    if (p !== null && s.entries !== null && p > s.entries) { setError('Position cannot exceed entries.'); return; }
    onEnd({ kind: 'tournament', position: p, prize: v });
  };
  return (
    <Sheet visible={visible} title="End session" onClose={onClose}>
      {s.kind === 'cash' ? (
        <Field label={`Cashed out (${currency})`} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" autoFocus onSubmit={submit} />
      ) : (
        <>
          <Field label="Position" value={position} onChangeText={setPosition} keyboardType="number-pad" autoFocus />
          <Field label={`Prize (${currency}, empty = busted)`} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" onSubmit={submit} />
        </>
      )}
      <ErrorText text={error} />
      <Button label="End session" onPress={submit} style={{ marginHorizontal: PAD, marginTop: 8 }} />
    </Sheet>
  );
}
