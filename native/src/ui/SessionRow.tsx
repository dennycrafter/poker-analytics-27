// Feed row (brief 5.1): weekday/day column, title, duration/table/location
// line, net result on the right, pulsing LIVE badge for the running session.
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import { dayNum, fmtDur, fmtMoney, moneyTone, weekdayAbbr } from '../lib/format';
import { nameOf, sessionTitle, tableLabel } from '../lib/present';
import { netResult, playSeconds } from '../lib/stats';
import type { Doc, Session } from '../lib/types';
import { Icon } from './icons';
import { colors, PAD, toneColor, type } from './theme';

export function LiveBadge() {
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 0.35, duration: 700, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return (
    <View style={s.badge} accessibilityLabel="Live session">
      <Animated.View style={[s.dot, { opacity: pulse }]} />
      <Text style={s.badgeText}>LIVE</Text>
    </View>
  );
}

export function SessionRow({ doc, session, now }: { doc: Doc; session: Session; now: number }) {
  const d = new Date(session.start_time);
  const net = netResult(doc, session);
  const secs = session.is_live ? playSeconds(session, now) : session.duration_seconds;
  const loc = nameOf(doc.locations, session.location_id);
  const title = sessionTitle(doc, session);
  const money = fmtMoney(net, doc.settings.currency);
  return (
    <Pressable onPress={() => router.push({ pathname: '/session/[id]', params: { id: session.id } })}
      accessibilityRole="button" accessibilityLabel={`${session.is_live ? 'Live, ' : ''}${title}, ${money}`}
      style={({ pressed }) => [s.row, pressed && { backgroundColor: colors.bg2 }]}>
      <View style={s.dateCol}>
        <Text style={s.dow}>{weekdayAbbr(d)}</Text>
        <Text style={s.dnum}>{dayNum(d)}</Text>
      </View>
      <View style={{ flex: 1, gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {session.is_live ? <LiveBadge /> : null}
          <Text style={type.body} numberOfLines={1}>{title}</Text>
        </View>
        <View style={s.sub}>
          <Icon name="clock" size={13} color={colors.text2} />
          <Text style={type.small}>{fmtDur(secs)}</Text>
          <Icon name="table" size={13} color={colors.text2} />
          <Text style={type.small}>{tableLabel(session.table_size)}</Text>
          {loc ? <><Icon name="pin" size={13} color={colors.text2} /><Text style={type.small} numberOfLines={1}>{loc}</Text></> : null}
        </View>
      </View>
      <Text style={[type.mid, { fontSize: 20, color: toneColor(moneyTone(net)) }]}>{money}</Text>
      <Icon name="chevron" size={16} color={colors.text3} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  row: {
    minHeight: 68, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: PAD,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  dateCol: { width: 34, alignItems: 'center' },
  dow: { color: colors.text2, fontSize: 11, fontWeight: '500', letterSpacing: 0.5 },
  dnum: { color: colors.text, fontSize: 20, fontWeight: '300' },
  sub: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: colors.accentDim },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent },
  badgeText: { color: colors.accent, fontSize: 10, fontWeight: '700', letterSpacing: 0.8 },
});
