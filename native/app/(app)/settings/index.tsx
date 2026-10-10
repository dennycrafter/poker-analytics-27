// Settings (brief 5.16), port of the web SettingsScreen: currency; manage
// Games / Locations / Tournament types / Groups; Bankrolls; Export JSON (same
// bytes as the web export); Import JSON and Reset demo data, both confirmed
// and both REPLACING the account's cloud rows via replaceDoc, then waiting for
// the cloud so the message reflects what was actually saved.
import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { exportFilename, exportText, parseImport, demoDoc, type ImportCounts } from '../../../src/lib/backup';
import { pickJsonText, shareJson } from '../../../src/lib/backup-io';
import { getLiveSession } from '../../../src/lib/domain';
import { currencyError, currencyOptions, MANAGED, MASTER_META, setCurrency } from '../../../src/lib/master-data';
import { replaceDoc, replaceOutcome } from '../../../src/lib/replace';
import type { Doc } from '../../../src/lib/types';
import { newId, useDoc, useStore } from '../../../src/state/AppProvider';
import { ConfirmSheet, ErrorText, Header, HeaderButton, Row, SectionHeader, useSheets } from '../../../src/ui/components';
import { colors, PAD, type } from '../../../src/ui/theme';

type Pending = { title: string; message: string; confirmLabel: string; next: Doc; okMsg: string } | null;
type Notice = { text: string; error: boolean } | null;

const importMessage = (c: ImportCounts) =>
  `Import ${c.sessions} sessions, ${c.transactions} transactions, ${c.notes} player notes and ${c.hands} hand histories. ` +
  'This REPLACES everything in your account on every device. Export first if you want a backup.';

export default function SettingsScreen() {
  const doc = useDoc();
  const store = useStore();
  const { prompt, pick, sheets } = useSheets();
  const [pending, setPending] = useState<Pending>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const say = (text: string, error = false) => setNotice({ text, error });
  const back = <HeaderButton label="Back" icon="back" tone="plain" onPress={() => router.back()} />;

  const applyCurrency = (raw: string): string | null => {
    const code = raw.trim().toUpperCase();
    const err = currencyError(code);
    if (err) return err;
    store.mutate(d => setCurrency(d, code));
    say(`Currency set to ${code}`);
    return null;
  };

  const pickCurrency = () => pick({
    title: 'Currency',
    options: currencyOptions(doc.settings.currency).map(c => ({ id: c, label: c })),
    selected: doc.settings.currency,
    onPick: c => { applyCurrency(c); },
    onAdd: raw => {
      const err = applyCurrency(raw);
      if (err) prompt({ title: 'Currency', label: 'Three-letter code, e.g. SEK', initial: raw.trim().toUpperCase(), onSave: applyCurrency });
    },
  });

  const doExport = async () => {
    try {
      await shareJson(exportFilename(), exportText(doc));
      say(`Exported ${doc.sessions.length} sessions`);
    } catch (e) {
      console.error('export: failed', e);
      say('Could not export. ' + (e instanceof Error ? e.message : ''), true);
    }
  };

  const doImport = async () => {
    try {
      const picked = await pickJsonText();
      if (!picked) return;
      const res = parseImport(picked.text, newId);
      if (!res.ok) { say(res.error, true); return; }
      setPending({ title: 'Replace your data?', message: importMessage(res.counts), confirmLabel: 'Import and replace',
        next: res.doc, okMsg: `Imported ${res.counts.sessions} sessions` });
    } catch (e) {
      console.error('import: read failed', e);
      say('Could not read that file', true);
    }
  };

  const doReset = () => {
    if (getLiveSession(doc)) { say('End the live session before resetting', true); return; }
    setPending({
      title: 'Reset demo data?',
      message: 'This REPLACES all sessions, transactions, notes and settings in your account with the demo dataset (about 40 sessions). Export first if you want to keep your data.',
      confirmLabel: 'Reset to demo', next: demoDoc(Date.now(), newId), okMsg: 'Demo data loaded',
    });
  };

  const applyReplacement = async (next: Doc, okMsg: string) => {
    setBusy(true);
    say('Saving to your account…');
    try {
      const status = await replaceDoc(store, next);
      const msg = replaceOutcome(status, okMsg);
      say(msg, msg !== okMsg);
    } catch (e) {
      console.error('replace: failed', e);
      say('Saved on this device; some changes are still syncing to your account.', true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title="Settings" left={back} />
      <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
        <SectionHeader title="General" />
        <Row label="Currency" value={doc.settings.currency} onPress={pickCurrency} />
        <SectionHeader title="Manage" />
        {MANAGED.map(k => (
          <Row key={k} label={MASTER_META[k].title} value={String(doc[k].length)}
            onPress={() => router.push({ pathname: '/settings/[list]', params: { list: k } })} />
        ))}
        <Row label="Bankrolls" value={String(doc.bankrolls.length)} onPress={() => router.push('/bankroll')} />
        <SectionHeader title="Data" />
        <Row label="Export all data (JSON)" onPress={busy ? undefined : () => { void doExport(); }} />
        <Row label="Import JSON" onPress={busy ? undefined : () => { void doImport(); }} />
        <Row label="Reset demo data" onPress={busy ? undefined : doReset} />
        {notice ? (
          notice.error ? <ErrorText text={notice.text} />
            : <Text accessibilityLiveRegion="polite" style={[type.small, { color: colors.accent, paddingHorizontal: PAD, paddingTop: 12 }]}>{notice.text}</Text>
        ) : null}
        <Text style={[type.small, { paddingHorizontal: PAD, paddingTop: 12 }]}>
          Import and Reset replace everything in your account (synced to all your devices). Filters and display preferences stay on this device.
        </Text>
      </ScrollView>
      <ConfirmSheet visible={pending !== null} title={pending?.title ?? ''} message={pending?.message ?? ''}
        confirmLabel={pending?.confirmLabel ?? ''} onClose={() => setPending(null)}
        onConfirm={() => { if (pending) void applyReplacement(pending.next, pending.okMsg); }} />
      {sheets}
    </View>
  );
}
