// Statistics (brief 5.9): All / Cash games / Tournaments sections over ended
// sessions in the chosen date range. Cash and Tournament sections only show
// when the range has sessions of that kind. Gross vs net-of-staking toggle
// appears once any tournament has sell actions (formula 1).
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { fmtMetric, metricDef, metricTone, metricValue, SCOPES, SECTIONS, type ScopeId } from '../../../src/lib/metrics';
import { inRange, RANGES, type RangeId } from '../../../src/lib/range';
import { endedSessions, hasStaking } from '../../../src/lib/stats';
import type { StakingMode } from '../../../src/lib/types';
import { useDoc } from '../../../src/state/AppProvider';
import { useStakingMode } from '../../../src/state/prefs';
import { BigStatRow, Chips, Empty, Header, SectionHeader, Segmented } from '../../../src/ui/components';
import { LiveBanner } from '../../../src/ui/LiveBanner';
import { colors, toneColor } from '../../../src/ui/theme';

const SCOPE_ORDER: ScopeId[] = ['all', 'cash', 'tournament'];

export default function StatsScreen() {
  const doc = useDoc();
  const [range, setRange] = useState<RangeId>('all');
  const [mode, setMode] = useStakingMode();
  // Range is evaluated when the tab renders; minute-level drift is irrelevant here.
  const sessions = useMemo(() => inRange(endedSessions(doc), range, Date.now()), [doc, range]);
  const staked = sessions.some(s => hasStaking(doc, s));

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title="Statistics" />
      <LiveBanner />
      <Chips<RangeId> options={RANGES} value={range} onChange={setRange} />
      {staked ? (
        <Segmented<StakingMode> options={[{ id: 'net', label: 'Net of staking' }, { id: 'gross', label: 'Gross' }]} value={mode} onChange={setMode} />
      ) : null}
      <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
        {sessions.length === 0 ? (
          <Empty text={endedSessions(doc).length ? 'No sessions in this date range.' : 'Play a session to see your stats.'} />
        ) : SCOPE_ORDER.map(scope => {
          const list = SCOPES[scope].pick(sessions);
          if (scope !== 'all' && list.length === 0) return null;
          return (
            <View key={scope}>
              <SectionHeader title={SCOPES[scope].label} />
              {SECTIONS[scope].map(id => {
                const def = metricDef(id);
                const v = metricValue(doc, id, list, mode);
                return (
                  <BigStatRow key={id} label={def.label} value={fmtMetric(def, v, doc.settings.currency)}
                    color={toneColor(metricTone(def, v))}
                    onPress={() => router.push({ pathname: '/stat/[metric]', params: { metric: id, scope, range } })} />
                );
              })}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
