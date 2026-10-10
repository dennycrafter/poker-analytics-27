// Feed (brief 5.1): sessions grouped by local month, newest first, month net
// on the header. SESSIONS shows ended sessions; ALL also shows the live one.
// Feed keeps its own filter (brief 9, device-local); live sessions stay
// visible on ALL so the running session is never hidden by a filter (web
// parity). Calendar drills in with ?month=YYYY-MM, which becomes the same
// custom-month Feed filter the web's drillToPeriod applies.
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { FlatList, Text, View } from 'react-native';

import { getLiveSession } from '../../../src/lib/domain';
import { applyFilter, isActive } from '../../../src/lib/filters';
import { fmtMoney, moneyTone, monthLabel } from '../../../src/lib/format';
import { groupByMonth, sessionNet } from '../../../src/lib/stats';
import type { Session } from '../../../src/lib/types';
import { useDoc, useNow } from '../../../src/state/AppProvider';
import { periodFilter } from '../../../src/state/drill';
import { setFilter, useFilter } from '../../../src/state/filters';
import { useStakingMode } from '../../../src/state/prefs';
import { Button, Empty, Header, HeaderButton, Segmented, Sheet } from '../../../src/ui/components';
import { FilterButton, FilterPill, FilterSheet } from '../../../src/ui/FilterSheet';
import { LiveBanner } from '../../../src/ui/LiveBanner';
import { SessionRow } from '../../../src/ui/SessionRow';
import { colors, PAD, toneColor, type } from '../../../src/ui/theme';

type Seg = 'all' | 'sessions';
type Item = { type: 'month'; key: string; label: string; total: number } | { type: 'session'; key: string; session: Session };

export default function FeedScreen() {
  const doc = useDoc();
  const now = useNow(30000);
  const [mode] = useStakingMode();
  const { month } = useLocalSearchParams<{ month?: string }>();
  const [seg, setSeg] = useState<Seg>('sessions');
  const [menu, setMenu] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter] = useFilter('feed');
  const live = getLiveSession(doc);
  const drillMonth = month && /^\d{4}-\d{2}$/.test(month) ? month : null;

  // A month drill lands on SESSIONS. Local state is adjusted during render
  // (React's recommended alternative to setState in an effect); the effect
  // below only writes the external filter store and clears the param.
  const [drilled, setDrilled] = useState<string | null>(null);
  if (drillMonth !== drilled) {
    setDrilled(drillMonth);
    if (drillMonth) setSeg('sessions');
  }

  useEffect(() => {
    if (!drillMonth) return;
    setFilter('feed', periodFilter('month', drillMonth));
    router.setParams({ month: '' });
  }, [drillMonth]);

  const base = useMemo(() => (seg === 'all' ? doc.sessions : doc.sessions.filter(s => !s.is_live)), [doc, seg]);
  const items = useMemo<Item[]>(() => {
    const shown = base.filter(s => s.is_live || applyFilter(filter, [s], now).length > 0);
    return groupByMonth(shown).flatMap(g => [
      { type: 'month' as const, key: 'm' + g.key, label: monthLabel(new Date(g.sessions[0].start_time)),
        total: g.sessions.filter(s => !s.is_live).reduce((a, s) => a + sessionNet(doc, s, mode), 0) },
      ...g.sessions.map(s => ({ type: 'session' as const, key: s.id, session: s })),
    ]);
  }, [doc, base, filter, now, mode]);

  const startNew = (kind: 'cash' | 'tournament') => {
    setMenu(false);
    if (live) { router.push({ pathname: '/session/[id]', params: { id: live.id } }); return; }
    router.push({ pathname: '/new/[kind]', params: { kind } });
  };
  const emptyText = base.length && isActive(filter) ? 'No sessions match this filter.' : 'No sessions yet. Tap + to log your first one.';

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title="Feed" left={<FilterButton tab="feed" onPress={() => setFilterOpen(true)} />}
        right={<HeaderButton label="Add session" icon="plus" onPress={() => setMenu(true)} />} />
      <LiveBanner />
      <FilterPill doc={doc} tab="feed" onEdit={() => setFilterOpen(true)} />
      <Segmented<Seg> options={[{ id: 'all', label: 'All' }, { id: 'sessions', label: 'Sessions' }]} value={seg} onChange={setSeg} />
      <FlatList
        data={items}
        keyExtractor={i => i.key}
        ListEmptyComponent={<Empty text={emptyText} />}
        renderItem={({ item }) => item.type === 'month' ? (
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: PAD, paddingTop: 18, paddingBottom: 6 }}>
            <Text style={[type.label, { color: colors.accent }]}>{item.label}</Text>
            <Text style={[type.label, { color: toneColor(moneyTone(item.total)) }]}>{fmtMoney(item.total, doc.settings.currency)}</Text>
          </View>
        ) : <SessionRow doc={doc} session={item.session} now={now} />}
      />
      <Sheet visible={menu} title="Add" onClose={() => setMenu(false)}>
        {live ? <Text style={[type.small, { paddingHorizontal: PAD, paddingBottom: 8 }]}>A session is live. End it before starting another.</Text> : null}
        <View style={{ gap: 10, paddingHorizontal: PAD }}>
          <Button label={live ? 'Open live session' : 'Cash game'} onPress={() => startNew('cash')} />
          {live ? null : <Button label="Tournament" kind="secondary" onPress={() => startNew('tournament')} />}
        </View>
      </Sheet>
      <FilterSheet doc={doc} tab="feed" visible={filterOpen} onClose={() => setFilterOpen(false)} />
    </View>
  );
}
