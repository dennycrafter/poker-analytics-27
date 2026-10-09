// One form for the four auth screens (login, signup, forgot, new password);
// copy and behaviour mirror the web app's js/screens/auth.js.
import * as Linking from 'expo-linking';
import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';

import { authErrorMessage, MIN_PASSWORD, supabase, validateAuthInput, type AuthMode } from '../lib/supabase';
import { useAuth } from '../state/AppProvider';
import { Button, ErrorText, Field } from './components';
import { colors, PAD, type } from './theme';

const COPY: Record<AuthMode, { title: string; sub: string; cta: string }> = {
  login: { title: 'Log in', sub: 'Welcome back. Your sessions are waiting.', cta: 'Log in' },
  signup: { title: 'Create account', sub: 'Track every session, on every device.', cta: 'Create account' },
  forgot: { title: 'Reset password', sub: 'We will email you a link to choose a new password.', cta: 'Send reset link' },
  recovery: { title: 'Choose a new password', sub: `At least ${MIN_PASSWORD} characters.`, cta: 'Save password' },
};

/** Where reset emails point. Resolves to the app scheme in builds, exp:// in Expo Go, http(s) on web. */
export const resetRedirectUrl = (): string => Linking.createURL('/reset-password');

export function AuthForm({ mode }: { mode: AuthMode }) {
  const { setRecovering } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const copy = COPY[mode];

  async function submit() {
    if (busy) return;
    const invalid = validateAuthInput(mode, { email, password });
    if (invalid) { setError(invalid); return; }
    setBusy(true); setError(null); setNotice(null);
    const e = email.trim();
    try {
      if (mode === 'login') {
        const { error: err } = await supabase.auth.signInWithPassword({ email: e, password });
        if (err) throw err;
      } else if (mode === 'signup') {
        const { data, error: err } = await supabase.auth.signUp({ email: e, password, options: { emailRedirectTo: resetRedirectUrl() } });
        if (err) throw err;
        // With email confirmation on, no session comes back; the gate handles the instant-signup case.
        if (!data.session) setNotice('Check your inbox to confirm your email, then log in.');
      } else if (mode === 'forgot') {
        const { error: err } = await supabase.auth.resetPasswordForEmail(e, { redirectTo: resetRedirectUrl() });
        if (err) throw err;
        setNotice('If that email has an account, a reset link is on its way.');
      } else {
        const { error: err } = await supabase.auth.updateUser({ password });
        if (err) throw err;
        setRecovering(false); // gate now routes into the app
      }
    } catch (err) {
      console.error(`auth: ${mode} failed`, err);
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const showEmail = mode !== 'recovery';
  const showPassword = mode !== 'forgot';
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingVertical: 48 }} keyboardShouldPersistTaps="handled">
        <View style={{ paddingHorizontal: PAD, marginBottom: 24 }}>
          <Text style={[type.label, { color: colors.accent }]}>Poker Analytics 27</Text>
          <Text style={[type.big, { fontSize: 34, marginTop: 8 }]} accessibilityRole="header">{copy.title}</Text>
          <Text style={[type.small, { marginTop: 6 }]}>{copy.sub}</Text>
        </View>
        {showEmail ? (
          <Field label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoComplete="email"
            placeholder="you@example.com" onSubmit={showPassword ? undefined : submit} />
        ) : null}
        {showPassword ? (
          <Field label={mode === 'recovery' ? 'New password' : 'Password'} value={password} onChangeText={setPassword} secure
            autoComplete={mode === 'login' ? 'password' : 'new-password'} onSubmit={submit} />
        ) : null}
        <ErrorText text={error} />
        {notice ? <Text style={[type.small, { color: colors.accent, paddingHorizontal: PAD, paddingVertical: 8 }]} accessibilityRole="alert">{notice}</Text> : null}
        <Button label={busy ? 'Please wait…' : copy.cta} onPress={submit} disabled={busy} style={{ marginHorizontal: PAD, marginTop: 12 }} />
        <View style={{ alignItems: 'center', gap: 16, marginTop: 24 }}>
          {mode === 'login' ? <Link label="Forgot password?" to="/forgot" /> : null}
          {mode === 'login' ? <Link label="No account? Create one" to="/signup" /> : null}
          {mode === 'signup' || mode === 'forgot' ? <Link label="Back to log in" to="/login" /> : null}
        </View>
        <Text style={[type.small, { textAlign: 'center', marginTop: 32, color: colors.text3 }]}>Your sessions sync across all your devices.</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Link({ label, to }: { label: string; to: '/login' | '/signup' | '/forgot' }) {
  return (
    <Pressable onPress={() => router.replace(to)} accessibilityRole="link" hitSlop={8}>
      <Text style={[type.body, { color: colors.accent }]}>{label}</Text>
    </Pressable>
  );
}
