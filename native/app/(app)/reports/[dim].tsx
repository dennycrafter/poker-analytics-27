// Report dimension detail (brief 5.13), port of the web ReportDetailScreen:
// bar chart of every bucket (Net result | Net hourly rate) and the bucket
// list. Tapping a bar or row selects it and lists its sessions, with "View in
// Feed" where the Feed filter can express the bucket (dim.feed).
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';

import { hourBars, type Bar, type ReportMetric } from '../../../src/lib/bar-chart';
import { fmtHours, fmtMoney, fmtNum, moneyTone } from '../../../src/lib/format';
import {
  bucketName, dimensionById, dimensionBuckets, MIN_REPORT_SESSIONS, shortLabel, type Bucket, type BucketKey,
} from '../../../src/lib/reports';
import { endedSessions } from '../../../src/lib/stats';
import { useDoc, useNow } from '../../../src/state/AppProvider';
import { drillToFilter } from '../../../src/state/drill';
import { useStakingMode } from '../../../src/state/prefs';
import { Button, Empty, Header, HeaderButton, Segmented } from '../../../src/ui/components';
import { ReportBarChart } from '../../../src/ui/ReportBarChart';
import { SessionRow } from '../../../src/ui/SessionRow';
import { colors, PAD, toneColor, type } from '../../../src/ui/theme';

const sameKey = (a: BucketKey | null, b: BucketKey) => a !== null && String(a) === String(b);
const plural = (n: number) => `${n} ${n === 1 ? 'session' : 'sessions'}`;

export default function ReportDetailScreen() {
  const params = useLocalSearchParams<{ dim: string }>();
  const doc = useDoc();
  const now = useNow(60000);
  const [mode] = useStakingMode();
  const { width } = useWindowDimensions();
  const [metric, setMetric] = useState<ReportMetric>('net');
  const [sel, setSel] = useState<BucketKey | null>(null);
  const back = <HeaderButton label="Back" icon="back" tone="plain" onPress={() => router.back()} />;
  const dim = dimensionById(String(params.dim ?? ''));
  const cur = doc.settings.currency;
  const money = (n: number) => fmtMoney(n, cur);

  const all = useMemo(() => endedSessions(doc), [doc]);
  const buckets = useMemo<Bucket[]>(() => (dim ? dimensionBuckets(doc, dim, all, mode) : []), [doc, dim, all, mode]);

  if (!dim) {
    return <View style={{ flex: 1, backgroundColor: colors.bg }}><Header title="Report" left={back} /><Empty text="Unknown report." /></View>;
  }
  if (all.length < MIN_REPORT_SESSIONS) {
    return <View style={{ flex: 1, backgroundColor: colors.bg }}><Header title={dim.title} left={back} /><Empty text="Log at least 5 sessions to unlock reports." /></View>;
  }

  const shown = dim.hourly ? buckets : buckets.filter(b => b.count > 0);
  const valOf = (b: Bucket) => (metric === 'rate' ? b.rate : b.net);
  const bars: Bar[] = dim.hourly
    ? hourBars(buckets, metric)
    : shown.map(b => ({ key: b.key, label: bucketName(dim, b, money), short: shortLabel(dim, b, fmtNum), y: valOf(b) ?? 0, empty: false }));
  const select = (k: BucketKey) => setSel(sameKey(sel, k) ? null : k);
  const selB = sel === null ? null : buckets.find(b => sameKey(sel, b.key)) ?? null;
  const feedF = selB && selB.count && dim.feed ? dim.feed(selB.key) : null;
  const chartWidth = Math.min(width, 520) - PAD * 2;
  const suffix = metric === 'rate' ? '/h' : '';

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title={dim.title} left={back} />
      <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
        <View style={{ marginHorizontal: PAD, padding: 8, borderRadius: 16, backgroundColor: colors.bg2 }}>
          <ReportBarChart bars={bars} width={chartWidth - 16} height={210} labelEvery={dim.hourly ? 3 : 1} selected={sel}
            onSelect={select} label={`${dim.title} by ${metric === 'rate' ? 'net hourly rate' : 'net result'}`} />
          <Text style={[type.small, { textAlign: 'center', paddingTop: 4 }]}>{metric === 'rate' ? 'Net hourly rate' : 'Net result'} · tap a bar</Text>
        </View>
        <Segmented<ReportMetric> value={metric} onChange={setMetric}
          options={[{ id: 'net', label: 'Net result' }, { id: 'rate', label: 'Net hourly rate' }]} />
        {shown.filter(b => b.count > 0).map(b => {
          const v = valOf(b);
          const on = sameKey(sel, b.key);
          const name = bucketName(dim, b, money);
          return (
            <Pressable key={String(b.key)} onPress={() => select(b.key)} accessibilityRole="button" accessibilityState={{ selected: on }}
              accessibilityLabel={`${name}, ${plural(b.count)}, ${v === null ? 'no value' : money(v) + suffix}`}
              style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: PAD, minHeight: 64, borderBottomWidth: 1,
                borderBottomColor: colors.border, backgroundColor: on ? colors.bg2 : undefined }}>
              <View style={{ flex: 1 }}>
                <Text style={type.body}>{name}</Text>
                <Text style={type.small}>{plural(b.count)} · {fmtHours(b.hours)}</Text>
              </View>
              <Text style={[type.body, { color: v === null ? colors.text3 : toneColor(moneyTone(v)) }]}>{v === null ? '--' : money(v) + suffix}</Text>
            </Pressable>
          );
        })}
        {selB && selB.count ? (
          <View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: PAD, paddingTop: 18, paddingBottom: 6 }}>
              <Text style={[type.label, { color: colors.accent }]}>{bucketName(dim, selB, money)}</Text>
              <Text style={[type.label, { color: toneColor(moneyTone(selB.net)) }]}>{money(selB.net)}</Text>
            </View>
            {dim.hourly ? <Text style={[type.small, { paddingHorizontal: PAD, paddingBottom: 6 }]}>Each session counts only the minutes it spent in this hour.</Text> : null}
            {feedF ? <Button label="View in Feed" kind="secondary" style={{ marginHorizontal: PAD, marginBottom: 8 }} onPress={() => drillToFilter(feedF)} /> : null}
            {[...selB.sessions].sort((a, b) => Date.parse(b.start_time) - Date.parse(a.start_time)).map(s => (
              <SessionRow key={s.id} doc={doc} session={s} now={now} />
            ))}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}
