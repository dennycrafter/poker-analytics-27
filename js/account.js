// Account actions shared by the shell and the More screen.

import { supabase } from './supabase-client.js';
import { whenSaved, stopSync, clearUserCache } from './store.js';

export async function currentUser() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session ? data.session.user : null;
}

// Drain pending writes first so nothing entered on this device is lost, then
// drop the device cache so the next person using this browser sees nothing.
// Returns an error message, or null on success.
export async function signOut() {
  const user = await currentUser();
  const saved = await whenSaved(8000);
  if (!saved) console.error('sign-out: some changes had not reached the server');
  const { error } = await supabase.auth.signOut();
  if (error) {
    console.error('sign-out failed', error);
    return 'Could not sign out. Try again.';
  }
  stopSync();
  if (user) clearUserCache(user.id);
  return null;
}
