// Statistics (brief 5.9): All / Cash games / Tournaments sections over ended
// sessions matching the Stats tab's own filter (brief 9, same semantics as the
// web's statsSessions). Cash and Tournament sections only show when the
// filtered set has sessions of that kind. Gross vs net-of-staking toggle
// appears once any tournament has sell actions (formula 1).
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { fmtMetric, metricDef, metricTone, metricValue, SCOPES, SECTIONS, type ScopeId } from '../../../src/lib/metrics';
import { applyFilter, isActive } from '../../../src/lib/filters';
import { endedSessions, hasStaking } from '../../../src/lib/stats';
import type { StakingMode } from '../../../src/lib/types';
import { useDoc, useNow } from '../../../src/state/AppProvider';
import { useFilter } from '../../../src/state/filters';
import { useStakingMode } from '../../../src/state/prefs';
import { BigStatRow, Empty, Header, HeaderButton, SectionHeader, Segmented } from '../../../src/ui/components';
import { FilterButton, FilterPill, FilterSheet } from '../../../src/ui/FilterSheet';
import { LiveBanner } from '../../../src/ui/LiveBanner';
import { colors, toneColor } from '../../../src/ui/theme';

const SCOPE_ORDER: ScopeId[] = ['all', 'cash', 'tournament'];

export default function StatsScreen() {
  const doc = useDoc();
  const [filter] = useFilter('stats');
  const [filterOpen, setFilterOpen] = useState(false);
  const [mode, setMode] = useStakingMode();
  const now = useNow(60000);
  const sessions = useMemo(() => applyFilter(filter, endedSessions(doc), now), [doc, filter, now]);
  const staked = sessions.some(s => hasStaking(doc, s));

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title="Statistics" left={<FilterButton tab="stats" onPress={() => setFilterOpen(true)} />}
        right={<HeaderButton label="Reports" onPress={() => router.push('/reports')} />} />
      <LiveBanner />
      <FilterPill doc={doc} tab="stats" onEdit={() => setFilterOpen(true)} />
      {staked ? (
        <Segmented<StakingMode> options={[{ id: 'net', label: 'Net of staking' }, { id: 'gross', label: 'Gross' }]} value={mode} onChange={setMode} />
      ) : null}
      <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
        {sessions.length === 0 ? (
          <Empty text={endedSessions(doc).length ? (isActive(filter) ? 'No sessions match this filter.' : 'Play a session to see your stats.') : 'Play a session to see your stats.'} />
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
                    onPress={() => router.push({ pathname: '/stat/[metric]', params: { metric: id, scope } })} />
                );
              })}
            </View>
          );
        })}
      </ScrollView>
      <FilterSheet doc={doc} tab="stats" visible={filterOpen} onClose={() => setFilterOpen(false)} />
    </View>
  );
}
