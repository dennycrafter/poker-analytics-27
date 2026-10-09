// Brief 6: while a session is live, every main screen links back to it.
import { router } from 'expo-router';
import { Pressable, Text } from 'react-native';

import { getLiveSession } from '../lib/domain';
import { fmtDur } from '../lib/format';
import { sessionTitle } from '../lib/present';
import { playSeconds } from '../lib/stats';
import { useDoc, useNow } from '../state/AppProvider';
import { Icon } from './icons';
import { LiveBadge } from './SessionRow';
import { colors, PAD, type } from './theme';

export function LiveBanner() {
  const doc = useDoc();
  const now = useNow(30000);
  const live = getLiveSession(doc);
  if (!live) return null;
  return (
    <Pressable onPress={() => router.push({ pathname: '/session/[id]', params: { id: live.id } })} accessibilityRole="button"
      accessibilityLabel="Return to live session"
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: PAD, marginBottom: 8, padding: 12,
        borderRadius: 12, backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.accentDim }}>
      <LiveBadge />
      <Text style={[type.body, { flex: 1 }]} numberOfLines={1}>{sessionTitle(doc, live)}</Text>
      <Text style={type.small}>{live.paused_at ? 'Paused' : fmtDur(playSeconds(live, now))}</Text>
      <Icon name="chevron" size={16} color={colors.text3} />
    </Pressable>
  );
}
