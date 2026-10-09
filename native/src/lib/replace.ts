// Whole-document replacement (Settings > Import JSON / Reset demo data), the
// native equivalent of the web's replaceDoc() + whenSaved(). CloudStore has no
// replace method, but its snapshot-diff flush already does the right thing for
// a wholesale swap: every entity in the new doc is upserted, every server
// entity missing from it is deleted, and the settings row is overwritten.
// Framework-free so the integration test drives exactly this code.
import type { CloudStore, SyncStatus } from './sync';
import type { Doc } from './types';

/** Swap the store's document for `next` (in one mutation) and wait for the cloud. */
export async function replaceDoc(store: Pick<CloudStore, 'mutate' | 'whenSettled'>, next: Doc): Promise<SyncStatus> {
  store.mutate(d => { Object.assign(d, next); });
  return store.whenSettled();
}

/** User-facing outcome, worded like the web toast. */
export function replaceOutcome(status: SyncStatus, okMsg: string): string {
  return status.state === 'saved' || status.state === 'idle'
    ? okMsg
    : 'Saved on this device; some changes are still syncing to your account.';
}
