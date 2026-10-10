// Master-data list (Games / Locations / Tournament types / Groups), port of
// the web MasterListScreen: add, rename, and delete only when no session uses
// the item. Validation is lib/master-data.ts, parity-tested against the web.
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import {
  addMasterItem, deleteMasterItem, isManagedKey, masterDeleteError, masterNameError, masterUsage, MASTER_META, renameMasterItem,
} from '../../../src/lib/master-data';
import type { NamedItem } from '../../../src/lib/types';
import { newId, useDoc, useStore } from '../../../src/state/AppProvider';
import { Button, ConfirmSheet, Empty, ErrorText, Header, HeaderButton, Row, Sheet, useSheets } from '../../../src/ui/components';
import { colors, PAD } from '../../../src/ui/theme';

export default function MasterListScreen() {
  const { list } = useLocalSearchParams<{ list: string }>();
  const doc = useDoc();
  const store = useStore();
  const { prompt, sheets } = useSheets();
  const [item, setItem] = useState<NamedItem | null>(null);
  const [confirmDel, setConfirmDel] = useState<NamedItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const back = <HeaderButton label="Back" icon="back" tone="plain" onPress={() => router.back()} />;

  if (!isManagedKey(list) || list === 'bankrolls') {
    return <View style={{ flex: 1, backgroundColor: colors.bg }}><Header title="Settings" left={back} /><Empty text="Unknown list." /></View>;
  }
  const key = list;
  const meta = MASTER_META[key];
  const items = doc[key];

  const add = () => prompt({
    title: `New ${meta.singular}`, label: 'Name', initial: '',
    onSave: v => {
      const err = masterNameError(store.getState(), key, v);
      if (err) return err;
      store.mutate(d => addMasterItem(d, key, v.trim(), newId()));
      return null;
    },
  });
  const rename = (it: NamedItem) => prompt({
    title: `Rename ${meta.singular}`, label: 'Name', initial: it.name,
    onSave: v => {
      const err = masterNameError(store.getState(), key, v, it.id);
      if (err) return err;
      store.mutate(d => renameMasterItem(d, key, it.id, v.trim()));
      return null;
    },
  });
  const askDelete = (it: NamedItem) => {
    const err = masterDeleteError(store.getState(), key, it.id);
    if (err) { setError(err); return; }
    setConfirmDel(it);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title={meta.title} left={back} right={<HeaderButton label={`Add ${meta.singular}`} icon="plus" onPress={add} />} />
      <ErrorText text={error} />
      <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
        {items.length ? items.map(it => {
          const used = masterUsage(doc, key, it.id);
          return <Row key={it.id} label={it.name} value={`${used} ${used === 1 ? 'session' : 'sessions'}`}
            onPress={() => { setError(null); setItem(it); }} />;
        }) : <Empty text={`No ${meta.title.toLowerCase()} yet. Tap + to add one.`} />}
      </ScrollView>
      <Sheet visible={item !== null} title={item?.name ?? ''} onClose={() => setItem(null)}>
        <View style={{ gap: 10, paddingHorizontal: PAD }}>
          <Button label="Rename" kind="secondary" onPress={() => { const it = item; setItem(null); if (it) rename(it); }} />
          <Button label="Delete" kind="danger" onPress={() => { const it = item; setItem(null); if (it) askDelete(it); }} />
        </View>
      </Sheet>
      <ConfirmSheet visible={confirmDel !== null} title={`Delete ${meta.singular}?`}
        message={`"${confirmDel?.name ?? ''}" is not used by any session.`} confirmLabel="Delete"
        onClose={() => setConfirmDel(null)}
        onConfirm={() => { const it = confirmDel; if (it) store.mutate(d => deleteMasterItem(d, key, it.id)); }} />
      {sheets}
    </View>
  );
}
