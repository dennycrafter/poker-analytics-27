// Public client configuration, identical to the web app's js/config.js.
// The publishable key is designed to ship in clients: every table is
// protected by owner-only row level security (supabase/migrations).
// Never put a service_role key or management token here.
export const SUPABASE_URL = 'https://assutwkylxjncaqhbjtv.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_KOU-LURyKlFoQ594hKKKGQ_EdQNTTY_';

/** Deep link used by password-reset emails (must be allow-listed in Supabase Auth > URL configuration). */
export const AUTH_REDIRECT_URL = 'pokeranalytics27://reset-password';
