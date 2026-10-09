// Root: providers + auth gate. Signed-out (or mid password recovery) users
// only reach the (auth) group; signed-in users only reach (app). The
// reset-password deep link lives outside both so it works in either state.
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AppProvider, useAuth } from '../src/state/AppProvider';
import { colors } from '../src/ui/theme';

function Gate() {
  const { session, recovering } = useAuth();
  if (session === undefined) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.accent} accessibilityLabel="Loading" />
      </View>
    );
  }
  const signedIn = !!session && !recovering;
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
      <Stack.Screen name="reset-password" />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <StatusBar style="light" />
        <Gate />
      </AppProvider>
    </SafeAreaProvider>
  );
}
