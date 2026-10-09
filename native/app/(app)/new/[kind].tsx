// Start / log a session (brief 5.2 cash, 5.5 tournament). "Start" creates a
// live session (cash: tracked via stack with the first buy_in event);
// "Log past session" switches to after-the-fact fields and saves an ended one.
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';

import {
  ensureByName, getLiveSession, logPastSession, startLiveCash, startLiveTournament, validateTimes, type SetupFields,
} from '../../../src/lib/domain';
import { fmtMoney, fromLocalInput, parseAmount, toLocalInput } from '../../../src/lib/format';
import {
  defaultBankrollId, lastUsed, nameOf, parseCount, parseStakes, STAKE_CHIPS, TABLE_SIZES, tableLabel,
} from '../../../src/lib/present';
import type { Doc, NamedItem } from '../../../src/lib/types';
import { newId, useDoc, useStore } from '../../../src/state/AppProvider';
import { Button, Chips, ErrorText, Header, HeaderButton, Row, SectionHeader, useSheets } from '../../../src/ui/components';
import { colors, PAD } from '../../../src/ui/theme';

type Kind = 'cash' | 'tournament';
type MasterKey = 'games' | 'locations' | 'tournament_types' | 'groups' | 'bankrolls';

interface Form {
  game_id: string | null; location_id: string | null; bankroll_id: string | null; group_id: string | null;
  table_size: number; tournament_type_id: string | null; tournament_name: string;
  sb: number; bb: number; buy_in: string; initial_buy_in: string;
  start: string; end: string; cashed_out: string; tips: string; hands: string;
  total_buy_in: string; prize: string; position: string; entries: string;
}

/** Defaults: NL Hold'em, last used location / stakes, default bankroll, 9-max. */
function initialForm(doc: Doc, kind: Kind): Form {
  const sameKind = doc.sessions.filter(s => s.kind === kind);
  const nl = doc.games.find(g => /hold/i.test(g.name)) ?? doc.games[0];
  const now = new Date();
  const threeHoursAgo = new Date(now.getTime() - 3 * 3600000);
  return {
    game_id: lastUsed(sameKind, 'game_id') ?? nl?.id ?? null,
    location_id: lastUsed(doc.sessions, 'location_id'),
    bankroll_id: defaultBankrollId(doc),
    group_id: null,
    table_size: lastUsed(sameKind, 'table_size') ?? 9,
    tournament_type_id: lastUsed(sameKind, 'tournament_type_id') ?? doc.tournament_types[0]?.id ?? null,
    tournament_name: '',
    sb: lastUsed(sameKind, 'small_blind') ?? 0.1,
    bb: lastUsed(sameKind, 'big_blind') ?? 0.2,
    buy_in: '', initial_buy_in: '10',
    start: toLocalInput(threeHoursAgo), end: toLocalInput(now),
    cashed_out: '', tips: '', hands: '', total_buy_in: '', prize: '', position: '', entries: '',
  };
}

const optional = (raw: string): number | null => parseAmount(raw);

export default function NewSessionScreen() {
  const { kind: rawKind } = useLocalSearchParams<{ kind: string }>();
  const kind: Kind = rawKind === 'tournament' ? 'tournament' : 'cash';
  const doc = useDoc();
  const store = useStore();
  const { prompt, pick, sheets } = useSheets();
  const [form, setForm] = useState<Form>(() => initialForm(doc, kind));
  const [past, setPast] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cur = doc.settings.currency;
  const set = (patch: Partial<Form>) => setForm(f => ({ ...f, ...patch }));
  const live = getLiveSession(doc);

  const options = (list: NamedItem[]) => list.map(x => ({ id: x.id, label: x.name }));
  /** Picker over a master-data list; "add new" creates the entry by name. */
  const pickMaster = (title: string, key: MasterKey, field: keyof Form, allowNone = false) => {
    const list = doc[key] as NamedItem[];
    pick({
      title,
      options: [...(allowNone ? [{ id: '', label: 'None' }] : []), ...options(list)],
      selected: (form[field] as string | null) ?? '',
      onPick: id => set({ [field]: id || null } as Partial<Form>),
      onAdd: key === 'bankrolls' ? undefined : name => {
        let id: string | null = null;
        store.mutate(d => { id = ensureByName(d[key] as NamedItem[], name, newId); });
        set({ [field]: id } as Partial<Form>);
      },
    });
  };
  const promptText = (title: string, field: keyof Form, numeric = true, placeholder?: string) => prompt({
    title, label: title, initial: String(form[field] ?? ''), placeholder,
    keyboardType: numeric ? 'decimal-pad' : 'default',
    onSave: raw => {
      if (numeric && raw.trim() !== '' && parseAmount(raw) === null) return 'Enter a number.';
      if (numeric && (parseAmount(raw) ?? 0) < 0) return 'Must be zero or more.';
      set({ [field]: raw.trim() } as Partial<Form>);
      return null;
    },
  });
  const promptCount = (title: string, field: keyof Form) => prompt({
    title, label: title, initial: String(form[field] ?? ''), keyboardType: 'number-pad',
    onSave: raw => {
      if (Number.isNaN(parseCount(raw))) return 'Enter a whole number.';
      set({ [field]: raw.trim() } as Partial<Form>);
      return null;
    },
  });
  const promptTime = (title: string, field: 'start' | 'end') => prompt({
    title, label: 'YYYY-MM-DD HH:MM (local time)', initial: form[field],
    onSave: raw => {
      if (!fromLocalInput(raw)) return 'Use the format YYYY-MM-DD HH:MM.';
      set({ [field]: raw.trim() });
      return null;
    },
  });

  const stakesLabel = `${form.sb}/${form.bb}`;
  const stakeChips = useMemo(() => STAKE_CHIPS.map(c => ({ id: `${c.sb}/${c.bb}`, label: `${c.sb}/${c.bb}` })), []);

  function submit() {
    setError(null);
    const setup: SetupFields = {
      game_id: form.game_id, location_id: form.location_id, bankroll_id: form.bankroll_id,
      group_id: form.group_id, table_size: form.table_size,
    };
    if (!form.game_id) { setError('Pick a game.'); return; }
    if (!form.bankroll_id) { setError('Pick a bankroll.'); return; }
    let id = '';
    if (!past) {
      if (live) { setError('A session is already live. End it first.'); return; }
      const start_time = new Date().toISOString();
      if (kind === 'cash') {
        const buyIn = parseAmount(form.buy_in);
        if (buyIn === null || buyIn <= 0) { setError('Enter the starting buy-in.'); return; }
        store.mutate(d => { id = startLiveCash(d, { ...setup, small_blind: form.sb, big_blind: form.bb, buy_in: buyIn, start_time }, newId); });
      } else {
        const ib = parseAmount(form.initial_buy_in);
        if (ib === null || ib < 0) { setError('Enter the buy-in.'); return; }
        store.mutate(d => {
          id = startLiveTournament(d, {
            ...setup, tournament_type_id: form.tournament_type_id, tournament_name: form.tournament_name.trim() || null,
            initial_buy_in: ib, start_time,
          }, newId);
        });
      }
      router.replace({ pathname: '/session/[id]', params: { id } });
      return;
    }
    const start = fromLocalInput(form.start);
    const end = fromLocalInput(form.end);
    const timeErr = validateTimes(start, end);
    if (timeErr || !start || !end) { setError(timeErr ?? 'Enter valid times.'); return; }
    const hands = parseCount(form.hands);
    const common = { ...setup, start, end, tips: optional(form.tips), hands_count: Number.isNaN(hands) ? null : hands };
    if (kind === 'cash') {
      const buyIn = parseAmount(form.buy_in);
      if (buyIn === null || buyIn <= 0) { setError('Enter the buy-in.'); return; }
      store.mutate(d => {
        id = logPastSession(d, { ...common, kind: 'cash', small_blind: form.sb, big_blind: form.bb, buy_in: buyIn, cashed_out: optional(form.cashed_out) }, newId);
      });
    } else {
      const ib = parseAmount(form.initial_buy_in);
      if (ib === null || ib < 0) { setError('Enter the buy-in.'); return; }
      const total = optional(form.total_buy_in);
      if (total !== null && total < ib) { setError('Total buy-in cannot be less than the initial buy-in.'); return; }
      const position = parseCount(form.position);
      const entries = parseCount(form.entries);
      if (position !== null && entries !== null && position > entries) { setError('Position cannot exceed entries.'); return; }
      store.mutate(d => {
        id = logPastSession(d, {
          ...common, kind: 'tournament', tournament_type_id: form.tournament_type_id,
          tournament_name: form.tournament_name.trim() || null, initial_buy_in: ib, total_buy_in: total,
          prize: optional(form.prize), position: Number.isNaN(position) ? null : position,
          entries: Number.isNaN(entries) ? null : entries,
        }, newId);
      });
    }
    router.replace({ pathname: '/session/[id]', params: { id } });
  }

  const money = (raw: string) => (raw === '' ? '--' : fmtMoney(parseAmount(raw), cur));
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header
        title={kind === 'cash' ? 'Cash game' : 'Tournament'}
        left={<HeaderButton label="Cancel" tone="plain" onPress={() => router.back()} />}
        right={<HeaderButton label={past ? 'Save' : 'Start'} onPress={submit} />}
      />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 48 }}>
        <ErrorText text={error} />
        <Row label="Game" value={nameOf(doc.games, form.game_id) ?? '--'} onPress={() => pickMaster('Game', 'games', 'game_id')} />
        {kind === 'cash' ? (
          <>
            <Row label="Stakes" value={stakesLabel} onPress={() => prompt({
              title: 'Stakes', label: 'Small blind / big blind', initial: stakesLabel, keyboardType: 'numbers-and-punctuation',
              onSave: raw => { const p = parseStakes(raw); if (!p) return 'Use SB/BB, e.g. 0.5/1.'; set({ sb: p.sb, bb: p.bb }); return null; },
            })} />
            <View style={{ paddingTop: 10 }}>
              <Chips options={stakeChips} value={stakesLabel} onChange={v => { const p = parseStakes(v); if (p) set({ sb: p.sb, bb: p.bb }); }} />
            </View>
            <Row label={past ? 'Buy-in' : 'Starting buy-in'} value={money(form.buy_in)} onPress={() => promptText('Buy-in', 'buy_in')} />
          </>
        ) : (
          <>
            <Row label="Initial buy-in" value={money(form.initial_buy_in)} onPress={() => promptText('Initial buy-in', 'initial_buy_in')} />
            <Row label="Tournament type" value={nameOf(doc.tournament_types, form.tournament_type_id) ?? '--'}
              onPress={() => pickMaster('Tournament type', 'tournament_types', 'tournament_type_id', true)} />
            <Row label="Name" value={form.tournament_name || '--'} onPress={() => promptText('Name', 'tournament_name', false, 'Optional')} />
          </>
        )}
        <Row label="Location" value={nameOf(doc.locations, form.location_id) ?? '--'} onPress={() => pickMaster('Location', 'locations', 'location_id', true)} />
        <Row label="Table size" value={tableLabel(form.table_size)} onPress={() => pick({
          title: 'Table size', options: TABLE_SIZES.map(n => ({ id: String(n), label: tableLabel(n) })),
          selected: String(form.table_size), onPick: id => set({ table_size: Number(id) }),
        })} />
        <Row label="Bankroll" value={nameOf(doc.bankrolls, form.bankroll_id) ?? '--'} onPress={() => pickMaster('Bankroll', 'bankrolls', 'bankroll_id')} />
        <Row label="Group" value={nameOf(doc.groups, form.group_id) ?? '--'} onPress={() => pickMaster('Group', 'groups', 'group_id', true)} />

        {past ? (
          <>
            <SectionHeader title="Result" />
            <Row label="Start time" value={form.start} onPress={() => promptTime('Start time', 'start')} />
            <Row label="End time" value={form.end} onPress={() => promptTime('End time', 'end')} />
            {kind === 'cash' ? (
              <Row label="Cashed out" value={money(form.cashed_out)} onPress={() => promptText('Cashed out', 'cashed_out')} />
            ) : (
              <>
                <Row label="Total buy-in" value={form.total_buy_in === '' ? 'Same as initial' : money(form.total_buy_in)}
                  onPress={() => promptText('Total buy-in (incl. rebuys/add-ons)', 'total_buy_in')} />
                <Row label="Prize" value={form.prize === '' ? 'Busted' : money(form.prize)} onPress={() => promptText('Prize', 'prize')} />
                <Row label="Position" value={form.position || '--'} onPress={() => promptCount('Position', 'position')} />
                <Row label="Entries" value={form.entries || '--'} onPress={() => promptCount('Entries', 'entries')} />
              </>
            )}
            <Row label="Tips" value={money(form.tips)} onPress={() => promptText('Tips', 'tips')} />
            <Row label="Hands count" value={form.hands || '--'} onPress={() => promptCount('Hands count', 'hands')} />
          </>
        ) : (
          <Row label="Date" value="Now" />
        )}

        <View style={{ padding: PAD, gap: 10 }}>
          <Button label={past ? 'Save session' : 'Start session'} onPress={submit} />
          <Button label={past ? 'Track live instead' : 'Log past session'} kind="secondary" onPress={() => { setError(null); setPast(p => !p); }} />
        </View>
      </ScrollView>
      {sheets}
    </View>
  );
}
