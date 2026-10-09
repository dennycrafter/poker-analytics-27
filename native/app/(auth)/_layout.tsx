import { Stack } from 'expo-router';

import { colors } from '../../src/ui/theme';

// Auth routes have their own paths (/login, /signup, ...) so they never
// collide with the signed-in Feed at "/".
export const unstable_settings = { initialRouteName: 'login' };

export default function AuthLayout() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />;
}
