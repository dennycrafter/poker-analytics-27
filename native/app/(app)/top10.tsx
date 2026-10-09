// Top 10 (brief 5.14), a port of the web Top10Screen: best and worst ten ended
// sessions by net result. Results follow the Statistics staking preference so
// the numbers match the Statistics tab.
import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { topSessions, type RankWhich } from '../../src/lib/rankings';
import { useDoc } from '../../src/state/AppProvider';
import { useStakingMode } from '../../src/state/prefs';
import { Empty, Header, HeaderButton, Segmented } from '../../src/ui/components';
import { RankedSessionRow } from '../../src/ui/money';
import { colors, PAD, type } from '../../src/ui/theme';

export default function Top10Screen() {
  const doc = useDoc();
  const [mode] = useStakingMode();
  const [which, setWhich] = useState<RankWhich>('best');
  const list = topSessions(doc, which, 10, mode);
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title="Top 10" left={<HeaderButton label="Back" icon="back" tone="plain" onPress={() => router.back()} />} />
      <Segmented<RankWhich> options={[{ id: 'best', label: 'Best' }, { id: 'worst', label: 'Worst' }]} value={which} onChange={setWhich} />
      <Text style={[type.small, { paddingHorizontal: PAD, paddingVertical: 10 }]}>
        By net result{mode === 'net' ? ' (net of staking)' : ' (gross)'} · ties go to the more recent session
      </Text>
      <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
        {list.length === 0 ? <Empty text="Play a session to see your stats." /> : list.map((x, i) => (
          <RankedSessionRow key={x.s.id} doc={doc} rank={i + 1} session={x.s} net={x.net} />
        ))}
      </ScrollView>
    </View>
  );
}
