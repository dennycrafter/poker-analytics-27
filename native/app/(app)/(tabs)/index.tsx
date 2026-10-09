// Feed (brief 5.1): sessions grouped by local month, newest first, month net
// on the header. SESSIONS shows ended sessions; ALL also shows the live one.
// Calendar drills in with ?month=YYYY-MM, shown as a clearable pill.
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';

import { getLiveSession } from '../../../src/lib/domain';
import { fmtMoney, moneyTone, monthLabel } from '../../../src/lib/format';
import { monthKeyOf, monthName } from '../../../src/lib/metrics';
import { groupByMonth, netResult } from '../../../src/lib/stats';
import type { Session } from '../../../src/lib/types';
import { useDoc, useNow } from '../../../src/state/AppProvider';
import { Button, Empty, Header, HeaderButton, Segmented, Sheet } from '../../../src/ui/components';
import { Icon } from '../../../src/ui/icons';
import { LiveBanner } from '../../../src/ui/LiveBanner';
import { SessionRow } from '../../../src/ui/SessionRow';
import { colors, PAD, toneColor, type } from '../../../src/ui/theme';

type Seg = 'all' | 'sessions';
type Item = { type: 'month'; key: string; label: string; total: number } | { type: 'session'; key: string; session: Session };

export default function FeedScreen() {
  const doc = useDoc();
  const now = useNow(30000);
  const { month } = useLocalSearchParams<{ month?: string }>();
  const [seg, setSeg] = useState<Seg>('sessions');
  const [menu, setMenu] = useState(false);
  const live = getLiveSession(doc);

  const items = useMemo<Item[]>(() => {
    let list = seg === 'all' ? doc.sessions : doc.sessions.filter(s => !s.is_live);
    if (month) list = list.filter(s => monthKeyOf(s) === month);
    return groupByMonth(list).flatMap(g => [
      { type: 'month' as const, key: 'm' + g.key, label: monthLabel(new Date(g.sessions[0].start_time)),
        total: g.sessions.filter(s => !s.is_live).reduce((a, s) => a + netResult(doc, s), 0) },
      ...g.sessions.map(s => ({ type: 'session' as const, key: s.id, session: s })),
    ]);
  }, [doc, seg, month]);

  const startNew = (kind: 'cash' | 'tournament') => {
    setMenu(false);
    if (live) { router.push({ pathname: '/session/[id]', params: { id: live.id } }); return; }
    router.push({ pathname: '/new/[kind]', params: { kind } });
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title="Feed" right={<HeaderButton label="Add session" icon="plus" onPress={() => setMenu(true)} />} />
      <LiveBanner />
      {month ? (
        <Pressable onPress={() => router.setParams({ month: '' })} accessibilityRole="button" accessibilityLabel="Clear month filter"
          style={{ flexDirection: 'row', alignSelf: 'flex-start', alignItems: 'center', gap: 6, marginHorizontal: PAD, marginBottom: 8,
            paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14, backgroundColor: colors.accentDim }}>
          <Text style={[type.small, { color: colors.accent }]}>{monthName(month)} {month.slice(0, 4)}</Text>
          <Icon name="close" size={14} color={colors.accent} />
        </Pressable>
      ) : null}
      <Segmented<Seg> options={[{ id: 'all', label: 'All' }, { id: 'sessions', label: 'Sessions' }]} value={seg} onChange={setSeg} />
      <FlatList
        data={items}
        keyExtractor={i => i.key}
        ListEmptyComponent={<Empty text={month ? 'No sessions in this month.' : 'No sessions yet. Tap + to log your first one.'} />}
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
    </View>
  );
}
