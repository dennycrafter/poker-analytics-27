// Filter bottom sheet + header affordances (brief 9), port of the web's
// js/screens/filter.js. The sheet edits a draft; only Apply (or Clear all)
// commits it. The hour chip only appears when a Reports drill-down set it and
// can only be removed here, exactly as on the web.
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import {
  customRangeError, emptyFilter, hasHour, isActive, RANGES, stakesOptions, summary, toggleListValue, withRange,
  type Filter, type FilterKind, type FilterTab, type ListKey,
} from '../lib/filters';
import { hourRangeLabel } from '../lib/hours';
import type { Doc, NamedItem } from '../lib/types';
import { useFilter } from '../state/filters';
import { Button, ErrorText, Field, Sheet } from './components';
import { Icon } from './icons';
import { colors, PAD, type } from './theme';

const KINDS: [FilterKind, string][] = [['cash', 'Cash'], ['tournament', 'Tournament'], ['both', 'Both']];
const isDayText = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: on }}
      style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, borderWidth: 1,
        borderColor: on ? colors.accent : colors.border, backgroundColor: on ? colors.accentDim : colors.bg3 }}>
      <Text style={[type.small, { color: on ? colors.accent : colors.text2 }]}>{label}</Text>
    </Pressable>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ paddingHorizontal: PAD, paddingVertical: 8, gap: 8 }}>
      <Text style={type.label}>{title}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{children}</View>
    </View>
  );
}

function FilterBody({ doc, tab, onClose }: { doc: Doc; tab: FilterTab; onClose: () => void }) {
  const [saved, setSaved] = useFilter(tab);
  const [draft, setDraft] = useState<Filter>(saved);
  const [error, setError] = useState<string | null>(null);

  const multi = (title: string, key: ListKey, options: NamedItem[], emptyText: string) => (
    <Section title={title}>
      {options.length ? options.map(o => (
        <Chip key={o.id} label={o.name} on={draft[key].includes(o.id)} onPress={() => setDraft(toggleListValue(draft, key, o.id))} />
      )) : <Text style={[type.small, { color: colors.text3 }]}>{emptyText}</Text>}
    </Section>
  );
  const dayField = (label: string, k: 'from' | 'to') => (
    <View style={{ flex: 1 }}>
      <Field label={label} value={draft[k] ?? ''} placeholder="YYYY-MM-DD" keyboardType="numbers-and-punctuation"
        onChangeText={v => setDraft({ ...draft, [k]: v.trim() || null })} />
    </View>
  );

  const apply = () => {
    for (const k of ['from', 'to'] as const) {
      const v = draft[k];
      if (draft.range === 'custom' && v !== null && !isDayText(v)) { setError('Use dates like 2026-07-04'); return; }
    }
    const err = customRangeError(draft);
    if (err) { setError(err); return; }
    setSaved(draft);
    onClose();
  };

  return (
    <>
      <ScrollView style={{ maxHeight: 520 }} keyboardShouldPersistTaps="handled">
        <Section title="Date range">
          {RANGES.map(([id, label]) => <Chip key={id} label={label} on={draft.range === id} onPress={() => setDraft(withRange(draft, id))} />)}
        </Section>
        {draft.range === 'custom' ? <View style={{ flexDirection: 'row' }}>{dayField('From', 'from')}{dayField('To', 'to')}</View> : null}
        <Section title="Session kind">
          {KINDS.map(([id, label]) => <Chip key={id} label={label} on={draft.kind === id} onPress={() => setDraft({ ...draft, kind: id })} />)}
        </Section>
        {multi('Game', 'game_ids', doc.games, 'No games yet')}
        {multi('Stakes', 'stakes', stakesOptions(doc).map(k => ({ id: k, name: k })), 'No cash stakes yet')}
        {multi('Tournament type', 'tournament_type_ids', doc.tournament_types, 'No tournament types yet')}
        {multi('Location', 'location_ids', doc.locations, 'No locations yet')}
        {multi('Bankroll', 'bankroll_ids', doc.bankrolls, 'No bankrolls yet')}
        {multi('Group', 'group_ids', doc.groups, 'No groups yet')}
        {hasHour(draft) ? (
          <Section title="Hour of day (from Reports)">
            <Chip label={`${hourRangeLabel(draft.hour)}  ×`} on onPress={() => setDraft({ ...draft, hour: null })} />
          </Section>
        ) : null}
      </ScrollView>
      <ErrorText text={error} />
      <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: PAD, paddingTop: 8 }}>
        <Button label="Clear all" kind="secondary" style={{ flex: 1 }} onPress={() => { setSaved(emptyFilter()); onClose(); }} />
        <Button label="Apply" style={{ flex: 1 }} onPress={apply} />
      </View>
    </>
  );
}

/** Mounted per opening so the draft starts from the saved filter. */
export function FilterSheet({ doc, tab, visible, onClose }: { doc: Doc; tab: FilterTab; visible: boolean; onClose: () => void }) {
  if (!visible) return null;
  return (
    <Sheet visible title={tab === 'feed' ? 'Filter feed' : 'Filter statistics'} onClose={onClose}>
      <FilterBody doc={doc} tab={tab} onClose={onClose} />
    </Sheet>
  );
}

/** Header Filter button with the green "active" dot. */
export function FilterButton({ tab, onPress }: { tab: FilterTab; onPress: () => void }) {
  const [f] = useFilter(tab);
  const active = isActive(f);
  return (
    <Pressable onPress={onPress} hitSlop={12} accessibilityRole="button" accessibilityLabel={`Filter${active ? ' (active)' : ''}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <Text style={[type.body, { color: colors.accent, fontWeight: '600' }]}>Filter</Text>
      {active ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent }} /> : null}
    </Pressable>
  );
}

/** Summary pill under the header, e.g. "Last 30 days · Cash · UCD", with X to clear. */
export function FilterPill({ doc, tab, onEdit }: { doc: Doc; tab: FilterTab; onEdit: () => void }) {
  const [f, setF] = useFilter(tab);
  if (!isActive(f)) return null;
  const text = summary(doc, f);
  return (
    <View style={{ flexDirection: 'row', alignSelf: 'flex-start', alignItems: 'center', marginHorizontal: PAD, marginBottom: 8,
      borderRadius: 14, backgroundColor: colors.accentDim, maxWidth: '92%' }}>
      <Pressable onPress={onEdit} accessibilityRole="button" accessibilityLabel={`Edit filter: ${text}`} style={{ paddingLeft: 10, paddingVertical: 5, flexShrink: 1 }}>
        <Text style={[type.small, { color: colors.accent }]} numberOfLines={1}>{text}</Text>
      </Pressable>
      <Pressable onPress={() => setF(emptyFilter())} hitSlop={8} accessibilityRole="button" accessibilityLabel="Clear filter"
        style={{ paddingHorizontal: 8, paddingVertical: 5 }}>
        <Icon name="close" size={14} color={colors.accent} />
      </Pressable>
    </View>
  );
}
