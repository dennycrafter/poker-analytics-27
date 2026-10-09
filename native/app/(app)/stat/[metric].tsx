// Stat detail (brief 5.10): header card (scope, number of games, big total)
// and a chart. Line = cumulative metric up to each point; bar = each bucket on
// its own. Group by Unit (session #) | Month | Year | Duration (cum. hours).
// Cash money metrics offer a BB toggle that swaps in their BB counterpart.
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, useWindowDimensions, View } from 'react-native';

import {
  buildSeries, fmtMetric, metricDef, metricTone, metricValue, METRICS, SCOPES,
  type ChartKind, type MetricId, type ScopeId, type SeriesGroup,
} from '../../../src/lib/metrics';
import { inRange, isRangeId } from '../../../src/lib/range';
import { endedSessions } from '../../../src/lib/stats';
import { useDoc } from '../../../src/state/AppProvider';
import { useStakingMode } from '../../../src/state/prefs';
import { BarChart, Empty, Header, HeaderButton, LineChart, Segmented } from '../../../src/ui/components';
import { colors, PAD, toneColor, type } from '../../../src/ui/theme';

/** Cash money metric -> its big-blind twin. */
const BB_TWIN: Partial<Record<MetricId, MetricId>> = {
  net: 'net_bb', hourly: 'hourly_bb', avg_net: 'avg_net_bb', stddev: 'stddev_bb',
};

const isMetricId = (v: unknown): v is MetricId => typeof v === 'string' && v in METRICS;
const isScopeId = (v: unknown): v is ScopeId => v === 'all' || v === 'cash' || v === 'tournament';

export default function StatDetailScreen() {
  const params = useLocalSearchParams<{ metric: string; scope?: string; range?: string }>();
  const doc = useDoc();
  const { width } = useWindowDimensions();
  const [mode] = useStakingMode();
  const [group, setGroup] = useState<SeriesGroup>('unit');
  const [chart, setChart] = useState<ChartKind>('line');
  const [bb, setBb] = useState(false);
  const back = <HeaderButton label="Back" icon="back" tone="plain" onPress={() => router.back()} />;

  if (!isMetricId(params.metric)) {
    return <View style={{ flex: 1, backgroundColor: colors.bg }}><Header title="Statistic" left={back} /><Empty text="Unknown statistic." /></View>;
  }
  const scope: ScopeId = isScopeId(params.scope) ? params.scope : 'all';
  const range = isRangeId(params.range) ? params.range : 'all';
  const twin = scope === 'cash' ? BB_TWIN[params.metric] : undefined;
  const id: MetricId = bb && twin ? twin : params.metric;
  const def = metricDef(id);
  const sessions = SCOPES[scope].pick(inRange(endedSessions(doc), range, Date.now()));
  const total = metricValue(doc, id, sessions, mode);
  const points = buildSeries(doc, id, sessions, { group, chart, mode });
  const chartWidth = Math.min(width, 520) - PAD * 2;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title={def.label} left={back} />
      <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
        <View style={{ marginHorizontal: PAD, padding: PAD, borderRadius: 16, backgroundColor: colors.bg2, gap: 6 }}>
          <Text style={type.label}>{SCOPES[scope].label} · {sessions.length} {sessions.length === 1 ? 'game' : 'games'}</Text>
          <Text style={[type.big, { color: toneColor(metricTone(def, total)) }]} accessibilityLabel={`${def.label} ${fmtMetric(def, total, doc.settings.currency)}`}>
            {fmtMetric(def, total, doc.settings.currency)}
          </Text>
        </View>
        <View style={{ paddingHorizontal: PAD, paddingVertical: 16 }}>
          {chart === 'line'
            ? <LineChart points={points} width={chartWidth} height={220} />
            : <BarChart points={points} width={chartWidth} height={220} />}
        </View>
        <Segmented<SeriesGroup> value={group} onChange={setGroup}
          options={[{ id: 'unit', label: 'Unit' }, { id: 'month', label: 'Month' }, { id: 'year', label: 'Year' }, { id: 'duration', label: 'Duration' }]} />
        <Segmented<ChartKind> value={chart} onChange={setChart} options={[{ id: 'line', label: 'Line' }, { id: 'bar', label: 'Bar' }]} />
        {twin ? (
          <Segmented<'money' | 'bb'> value={bb ? 'bb' : 'money'} onChange={v => setBb(v === 'bb')}
            options={[{ id: 'money', label: doc.settings.currency }, { id: 'bb', label: 'BB' }]} />
        ) : null}
      </ScrollView>
    </View>
  );
}
