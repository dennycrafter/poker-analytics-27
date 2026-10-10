// More: navigation to the money and analytics screens, account, currency
// (synced via user_settings like the web), sync status and sign-out. Players,
// the variance simulator, the equity calculator and data export are web-only.
import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { useAuth, useDoc, useStore, useSyncStatus } from '../../../src/state/AppProvider';
import { Button, ErrorText, Header, Row, SectionHeader, useSheets } from '../../../src/ui/components';
import { LiveBanner } from '../../../src/ui/LiveBanner';
import { colors, PAD, type } from '../../../src/ui/theme';

const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'];
const SYNC_LABEL = { idle: 'Up to date', saving: 'Saving…', saved: 'Saved', offline: 'Offline, will retry', error: 'Sync error' } as const;

export default function MoreScreen() {
  const doc = useDoc();
  const store = useStore();
  const sync = useSyncStatus();
  const { session, signOut } = useAuth();
  const { prompt, pick, sheets } = useSheets();
  const [error, setError] = useState<string | null>(null);
  const setCurrency = (c: string) => store.mutate(d => { d.settings = { ...d.settings, currency: c }; });

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title="More" />
      <LiveBanner />
      <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
        <SectionHeader title="Account" />
        <Row label="Email" value={session?.user.email ?? '--'} />
        <Row label="Sync" value={SYNC_LABEL[sync.state]} valueColor={sync.state === 'error' ? colors.negative : undefined} />
        <SectionHeader title="Settings" />
        <Row label="Currency" value={doc.settings.currency} onPress={() => pick({
          title: 'Currency',
          options: [...new Set([...CURRENCIES, doc.settings.currency])].map(c => ({ id: c, label: c })),
          selected: doc.settings.currency,
          onPick: setCurrency,
          onAdd: raw => {
            const code = raw.trim().toUpperCase();
            if (/^[A-Z]{3}$/.test(code)) setCurrency(code);
            else prompt({ title: 'Currency', label: 'Three-letter code, e.g. SEK', initial: code,
              onSave: v => { const c = v.trim().toUpperCase(); if (!/^[A-Z]{3}$/.test(c)) return 'Use a three-letter code.'; setCurrency(c); return null; } });
          },
        })} />
        <SectionHeader title="Explore" />
        <Row label="Bankroll" onPress={() => router.push('/bankroll')} />
        <Row label="Top 10" onPress={() => router.push('/top10')} />
        <Row label="Reports" onPress={() => router.push('/reports')} />
        <Row label="Settings" onPress={() => router.push('/settings')} />
        <Text style={[type.small, { paddingHorizontal: PAD, paddingTop: 12 }]}>
          Players, the variance simulator, the equity calculator and data export are available in the web app with the same account.
        </Text>
        <ErrorText text={error} />
        <View style={{ padding: PAD }}>
          <Button label="Log out" kind="secondary" onPress={() => {
            setError(null);
            signOut().catch((e: unknown) => {
              console.error('auth: sign out failed', e);
              setError('Could not log out. Check your connection and try again.');
            });
          }} />
        </View>
      </ScrollView>
      {sheets}
    </View>
  );
}
