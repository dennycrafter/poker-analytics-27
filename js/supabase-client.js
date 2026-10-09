// Single shared Supabase client (vendored supabase-js, no runtime CDN).
// PKCE flow: password-reset links come back as ?code=..., which leaves the
// hash router (#/feed) untouched.

import { createClient } from './vendor/supabase.js';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    flowType: 'pkce',
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'pa27:auth',
  },
  realtime: { params: { eventsPerSecond: 20 } },
});
