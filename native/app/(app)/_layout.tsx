// Signed-in area. Holds the tab bar plus full-screen flows pushed over it
// (new session forms, session detail / live view, stack screen, stat detail).
// Data loads once per sign-in; a failed first load shows a retry, not a spinner forever.
import { Stack } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';

import { useAuth, useStoreReady } from '../../src/state/AppProvider';
import { Button, Empty, ErrorText } from '../../src/ui/components';
import { colors } from '../../src/ui/theme';

export const unstable_settings = { initialRouteName: '(tabs)' };

export default function AppLayout() {
  const ready = useStoreReady();
  const { loadError, retryLoad, signOut } = useAuth();
  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: 'center' }}>
        {loadError ? (
          <>
            <Empty text="Could not load your sessions." />
            <ErrorText text={loadError} />
            <Button label="Try again" onPress={retryLoad} style={{ marginHorizontal: 16, marginTop: 8 }} />
            <Button label="Log out" kind="secondary" style={{ margin: 16 }}
              onPress={() => { signOut().catch(e => console.error('auth: sign out failed', e)); }} />
          </>
        ) : <ActivityIndicator color={colors.accent} accessibilityLabel="Loading your sessions" />}
      </View>
    );
  }
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="new/[kind]" options={{ presentation: 'modal' }} />
      <Stack.Screen name="session/[id]" />
      <Stack.Screen name="stack/[id]" />
      <Stack.Screen name="stat/[metric]" />
    </Stack>
  );
}
