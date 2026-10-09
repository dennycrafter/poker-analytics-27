// Deep-link target of the password-reset email (pokeranalytics27://reset-password?code=...).
// PKCE: exchanging the one-time code emits PASSWORD_RECOVERY, which flips the
// app into recovery mode and the gate routes to the new-password screen.
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { authErrorMessage, supabase } from '../src/lib/supabase';
import { useAuth } from '../src/state/AppProvider';
import { Button, Empty, ErrorText } from '../src/ui/components';
import { colors } from '../src/ui/theme';

export default function ResetPasswordLink() {
  const { code, error_description: linkError } = useLocalSearchParams<{ code?: string; error_description?: string }>();
  const { setRecovering } = useAuth();
  const [error, setError] = useState<string | null>(linkError ?? null);

  useEffect(() => {
    if (!code) { if (!linkError) setError('This reset link is incomplete. Request a new one.'); return; }
    let alive = true;
    supabase.auth.exchangeCodeForSession(code).then(({ error: err }) => {
      if (!alive) return;
      if (err) {
        console.error('auth: reset code exchange failed', err);
        setError(`${authErrorMessage(err)} Request a new reset link from this device.`);
        return;
      }
      setRecovering(true);
      router.replace('/new-password');
    });
    return () => { alive = false; };
  }, [code, linkError, setRecovering]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: 'center' }}>
      {error ? (
        <>
          <Empty text="Could not open the reset link." />
          <ErrorText text={error} />
          <Button label="Back to log in" kind="secondary" style={{ margin: 16 }} onPress={() => router.replace('/login')} />
        </>
      ) : <ActivityIndicator color={colors.accent} accessibilityLabel="Verifying reset link" />}
    </View>
  );
}
