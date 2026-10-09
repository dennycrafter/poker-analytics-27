// App-wide state: the Supabase auth session and the signed-in user's
// CloudStore document. Screens read the document through useDoc() and write
// through useStore().mutate(...) with the pure mutators in lib/domain.ts.
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session as AuthSession } from '@supabase/supabase-js';
import * as Crypto from 'expo-crypto';
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { supabase } from '../lib/supabase';
import { CloudStore, type SyncStatus } from '../lib/sync';
import type { Doc } from '../lib/types';

export const newId = (): string => Crypto.randomUUID();

interface AuthState {
  /** undefined while the persisted session is still being read. */
  session: AuthSession | null | undefined;
  /** True between opening a reset link and saving the new password. */
  recovering: boolean;
  setRecovering: (v: boolean) => void;
  signOut: () => Promise<void>;
  /** First pull after sign-in failed (e.g. offline); null when fine. */
  loadError: string | null;
  retryLoad: () => void;
}

const store = new CloudStore(supabase, AsyncStorage);
const AuthContext = createContext<AuthState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null | undefined>(undefined);
  const [recovering, setRecovering] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data, error }) => {
      if (error) console.error('auth: could not read the stored session', error);
      if (alive) setSession(data.session ?? null);
    });
    const { data } = supabase.auth.onAuthStateChange((event, next) => {
      if (event === 'PASSWORD_RECOVERY') setRecovering(true);
      setSession(next);
    });
    return () => { alive = false; data.subscription.unsubscribe(); };
  }, []);

  const uid = session?.user.id ?? null;
  useEffect(() => {
    setLoadError(null);
    if (!uid) {
      void store.stop().catch(e => console.error('sync: stop failed', e));
      return;
    }
    // A retry must restart from scratch: start() is a no-op for the same uid.
    const run = attempt > 0 ? store.stop().then(() => store.start(uid)) : store.start(uid);
    run.catch(e => {
      console.error('sync: start failed', e);
      setLoadError(String((e as { message?: string } | null)?.message ?? e));
    });
  }, [uid, attempt]);

  // Realtime may have dropped while backgrounded: pull on return to foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active' && store.isReady()) store.refresh('foreground');
    });
    return () => sub.remove();
  }, []);

  const value = useMemo<AuthState>(() => ({
    session, recovering, setRecovering, loadError,
    retryLoad: () => setAttempt(n => n + 1),
    signOut: async () => {
      const id = store.getUserId();
      await store.stop();
      if (id) await store.clearCache(id);
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    },
  }), [session, recovering, loadError]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth outside AppProvider');
  return v;
}

export function useStore(): CloudStore { return store; }

export function useDoc(): Doc {
  return useSyncExternalStore(cb => store.subscribe(() => cb()), () => store.getState());
}

export function useStoreReady(): boolean {
  return useSyncExternalStore(cb => store.subscribe(() => cb()), () => store.isReady());
}

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(cb => store.onStatus(() => cb()), () => store.getStatus());
}

/** Wall clock that ticks every `ms` while mounted (live timers compute from start_time). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
