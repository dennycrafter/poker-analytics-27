// Reports overview (brief 5.13), port of the web ReportsScreen. Highlights
// (best day / week / month / year, biggest win and loss), the Day Time
// Efficiency hour chart (tap a bar -> Feed narrowed to that hour), and one
// "Best" section per dimension opening /reports/[dim]. Like the web, Reports
// has no filter of its own and covers all ENDED sessions.
import { router } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';

import { hourBars } from '../../../src/lib/bar-chart';
import { fmtMoney, moneyTone } from '../../../src/lib/format';
import {
  bestOf, bestPeriod, bucketName, dayKeyOf, DIMENSIONS, dimensionBuckets, extremeSessions, MIN_REPORT_SESSIONS, periodLabel,
  type Bucket, type Dimension, type PeriodKind,
} from '../../../src/lib/reports';
import { endedSessions } from '../../../src/lib/stats';
import type { Session } from '../../../src/lib/types';
import { useDoc } from '../../../src/state/AppProvider';
import { drillToFilter, drillToPeriod } from '../../../src/state/drill';
import { useStakingMode } from '../../../src/state/prefs';
import { Empty, Header, HeaderButton, Row, SectionHeader } from '../../../src/ui/components';
import { Icon } from '../../../src/ui/icons';
import { ReportBarChart } from '../../../src/ui/ReportBarChart';
import { colors, PAD, toneColor, type } from '../../../src/ui/theme';

const PERIODS: [PeriodKind, string][] = [['day', 'Best day'], ['week', 'Best week'], ['month', 'Best month'], ['year', 'Best year']];

const plural = (n: number) => `${n} ${n === 1 ? 'session' : 'sessions'}`;
const sessionSub = (s: Session) => `${periodLabel('day', dayKeyOf(s))} · ${s.kind === 'cash' ? 'Cash' : 'Tournament'}`;

/** One "Best" line; a null amount means no bucket qualified and shows "--". */
function BestRow({ what, name, amount, text }: { what: string; name: string | null; amount: number | null; text: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, paddingVertical: 4 }}>
      <Text style={[type.small, { width: 108 }]}>{what}</Text>
      <Text style={[type.body, { flex: 1 }]} numberOfLines={1}>{name ?? '--'}</Text>
      <Text style={[type.body, { color: amount === null ? colors.text3 : toneColor(moneyTone(amount)) }]}>{amount === null ? '--' : text}</Text>
    </View>
  );
}

function DimensionSection({ dim, buckets, currency, chart }: { dim: Dimension; buckets: Bucket[]; currency: string; chart?: React.ReactNode }) {
  const { byNet, byRate } = bestOf(buckets);
  const money = (n: number) => fmtMoney(n, currency);
  const open = () => router.push({ pathname: '/reports/[dim]', params: { dim: dim.id } });
  const netAmt = byNet ? byNet.net : null;
  const rateAmt = byRate ? byRate.rate : null;
  return (
    <View>
      <Pressable onPress={open} accessibilityRole="button" accessibilityLabel={`${dim.title}, open report`}
        style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: PAD, paddingTop: 22, paddingBottom: 6, gap: 8 }}>
        <Text style={[type.label, { color: colors.text, flex: 1 }]}>{dim.title}</Text>
        <Text style={[type.label, { color: colors.accent }]}>Best</Text>
        <Icon name="chevron" size={16} color={colors.text3} />
      </Pressable>
      {chart}
      <Pressable onPress={open} accessibilityRole="button" style={{ paddingHorizontal: PAD, borderBottomWidth: 1, borderBottomColor: colors.border, paddingBottom: 8 }}>
        <BestRow what="Net result" name={byNet ? bucketName(dim, byNet, money) : null} amount={netAmt} text={money(netAmt ?? 0)} />
        <BestRow what="Net hourly rate" name={byRate ? bucketName(dim, byRate, money) : null} amount={rateAmt} text={money(rateAmt ?? 0) + '/h'} />
      </Pressable>
    </View>
  );
}

export default function ReportsScreen() {
  const doc = useDoc();
  const [mode] = useStakingMode();
  const { width } = useWindowDimensions();
  const chartWidth = Math.min(width, 520) - PAD * 2;
  const back = <HeaderButton label="Back" icon="back" tone="plain" onPress={() => router.back()} />;
  const cur = doc.settings.currency;

  const all = useMemo(() => endedSessions(doc), [doc]);
  const data = useMemo(() => {
    if (all.length < MIN_REPORT_SESSIONS) return null;
    const periods = PERIODS.map(([kind, title]) => ({ title, best: bestPeriod(doc, all, kind, mode) }));
    const extremes = extremeSessions(doc, all, mode);
    const sections = DIMENSIONS.map(dim => ({ dim, buckets: dimensionBuckets(doc, dim, all, mode) }));
    return { periods, extremes, sections };
  }, [doc, all, mode]);

  if (!data) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <Header title="Reports" left={back} />
        <Empty text="Log at least 5 sessions to unlock reports." />
      </View>
    );
  }
  const hour = data.sections[0];
  const { win, loss } = data.extremes;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title="Reports" left={back} />
      <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
        <SectionHeader title="Highlights" />
        {data.periods.map(({ title, best }) => best ? (
          <Row key={title} label={title} sub={`${periodLabel(best.kind, best.key)} · ${plural(best.count)}`}
            value={fmtMoney(best.net, cur)} valueColor={toneColor(moneyTone(best.net))}
            onPress={() => drillToPeriod(best.kind, best.key)} />
        ) : null)}
        {win ? <Row label="Biggest win" sub={sessionSub(win.session)} value={fmtMoney(win.net, cur)} valueColor={toneColor(moneyTone(win.net))}
          onPress={() => router.push({ pathname: '/session/[id]', params: { id: win.session.id } })} /> : null}
        {loss ? <Row label="Biggest loss" sub={sessionSub(loss.session)} value={fmtMoney(loss.net, cur)} valueColor={toneColor(moneyTone(loss.net))}
          onPress={() => router.push({ pathname: '/session/[id]', params: { id: loss.session.id } })} /> : null}
        {data.sections.map(({ dim, buckets }) => {
          if (!buckets.some(b => b.count > 0)) return null;
          const chart = dim.hourly ? (
            <View style={{ marginHorizontal: PAD, padding: 8, borderRadius: 16, backgroundColor: colors.bg2 }}>
              <ReportBarChart bars={hourBars(hour.buckets, 'net')} width={chartWidth - 16} height={180} labelEvery={3}
                label="Net result by hour of day" onSelect={k => drillToFilter({ hour: Number(k) })} />
              <Text style={[type.small, { textAlign: 'center', paddingTop: 4 }]}>Net result by hour · tap a bar for its sessions</Text>
            </View>
          ) : undefined;
          return <DimensionSection key={dim.id} dim={dim} buckets={buckets} currency={cur} chart={chart} />;
        })}
      </ScrollView>
    </View>
  );
}
