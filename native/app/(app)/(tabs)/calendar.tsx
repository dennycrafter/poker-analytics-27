// Calendar (brief 5.11): ALL | MONTH | YEAR periods, scrollable metric tabs,
// a rolling "30 last days" row, then one row per period (months grouped by
// year, every month from the first session to now). Tap a month: Feed
// filtered to it. The heatmap grid (5.12) is web-only for now (README).
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import {
  calendarValue, CALENDAR_METRICS, fmtMetric, groupBy, last30Days, metricDef, metricTone, monthName, monthSpan,
  sessionsInMonth, yearKeyOf, type MetricId,
} from '../../../src/lib/metrics';
import { endedSessions } from '../../../src/lib/stats';
import type { Session } from '../../../src/lib/types';
import { useDoc } from '../../../src/state/AppProvider';
import { useStakingMode } from '../../../src/state/prefs';
import { Empty, Header, SectionHeader, Segmented } from '../../../src/ui/components';
import { Icon } from '../../../src/ui/icons';
import { LiveBanner } from '../../../src/ui/LiveBanner';
import { colors, PAD, toneColor, type } from '../../../src/ui/theme';

type Period = 'all' | 'month' | 'year';

export default function CalendarScreen() {
  const doc = useDoc();
  const [mode] = useStakingMode();
  const [period, setPeriod] = useState<Period>('month');
  const [metric, setMetric] = useState<MetricId>('net');
  const cm = CALENDAR_METRICS.find(m => m.id === metric) ?? CALENDAR_METRICS[0];
  const def = metricDef(cm.id);
  const sessions = useMemo(() => endedSessions(doc), [doc]);
  const cur = doc.settings.currency;
  const cell = (list: Session[]) => {
    const v = calendarValue(doc, cm, list, mode);
    return { text: list.length ? fmtMetric(def, v, cur) : '--', color: list.length ? toneColor(metricTone(def, v)) : colors.text3 };
  };

  const body = (() => {
    if (!sessions.length) return <Empty text="Play a session to see your stats." />;
    if (period === 'all') return <PeriodRow label="All time" sub={`${sessions.length} sessions`} {...cell(sessions)} />;
    if (period === 'year') {
      const byYear = groupBy(sessions, yearKeyOf);
      const years = [...byYear.keys()].sort().reverse();
      return years.map(y => {
        const list = byYear.get(y) ?? [];
        return <PeriodRow key={y} label={y} sub={`${list.length} sessions`} {...cell(list)} />;
      });
    }
    const months = monthSpan(sessions);
    const years = [...new Set(months.map(k => k.slice(0, 4)))];
    return years.map(y => (
      <View key={y}>
        <SectionHeader title={y} />
        {months.filter(k => k.startsWith(y)).map(k => {
          const list = sessionsInMonth(sessions, k);
          return (
            <PeriodRow key={k} label={monthName(k)} sub={list.length ? `${list.length} sessions` : 'No sessions'} {...cell(list)}
              onPress={list.length ? () => router.navigate({ pathname: '/', params: { month: k } }) : undefined} />
          );
        })}
      </View>
    ));
  })();

  const recent = last30Days(sessions);
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title="Calendar" />
      <LiveBanner />
      <Segmented<Period> value={period} onChange={setPeriod}
        options={[{ id: 'all', label: 'All' }, { id: 'month', label: 'Month' }, { id: 'year', label: 'Year' }]} />
      <Segmented<MetricId> scroll value={metric} onChange={setMetric}
        options={CALENDAR_METRICS.map(m => ({ id: m.id, label: metricDef(m.id).label }))} />
      <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
        {sessions.length ? <PeriodRow label="30 last days" sub={`${recent.length} sessions`} {...cell(recent)} /> : null}
        {body}
      </ScrollView>
    </View>
  );
}

function PeriodRow({ label, sub, text, color, onPress }: { label: string; sub: string; text: string; color: string; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? 'button' : 'text'} accessibilityLabel={`${label}, ${text}`}
      style={({ pressed }) => ({ minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: PAD,
        borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: pressed ? colors.bg2 : 'transparent' })}>
      <View style={{ flex: 1 }}>
        <Text style={type.body}>{label}</Text>
        <Text style={type.small}>{sub}</Text>
      </View>
      <Text style={[type.mid, { fontSize: 20, color }]}>{text}</Text>
      {onPress ? <Icon name="chevron" size={16} color={colors.text3} /> : <View style={{ width: 16 }} />}
    </Pressable>
  );
}
