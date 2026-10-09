// Supabase client for React Native. Auth tokens persist in AsyncStorage
// (localStorage on web); PKCE so password-reset links carry a one-time code
// that only this device (holder of the verifier) can exchange.
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';

import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './config';

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: AsyncStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    flowType: 'pkce',
  },
});

// Native apps have no visibility events: refresh tokens only while foregrounded
// (Supabase's documented React Native pattern). The web build handles this itself.
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', state => {
    if (state === 'active') void supabase.auth.startAutoRefresh();
    else void supabase.auth.stopAutoRefresh();
  });
}

/** Supabase error -> sentence a player can act on (same mapping as web js/screens/auth.js). */
export function authErrorMessage(error: unknown): string {
  const msg = String((error as { message?: string } | null)?.message ?? '');
  if (/invalid login credentials/i.test(msg)) return 'Wrong email or password.';
  if (/already registered|already exists/i.test(msg)) return 'An account with this email already exists. Log in instead.';
  if (/rate limit|too many/i.test(msg)) return 'Too many attempts. Wait a minute and try again.';
  if (/fetch|network/i.test(msg)) return 'Could not reach the server. Check your connection.';
  return msg || 'Something went wrong. Try again.';
}

export const MIN_PASSWORD = 8;
export type AuthMode = 'login' | 'signup' | 'forgot' | 'recovery';

/** Pure validation, identical rules to the web auth screen. Null when valid. */
export function validateAuthInput(mode: AuthMode, f: { email: string; password: string }): string | null {
  if (mode !== 'recovery' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) return 'Enter a valid email address.';
  if (mode !== 'forgot' && f.password.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  return null;
}
