// IndexedDB key-value mirror for the offline write queue (STEP D).
//
// The sync engine keeps each user's document + confirmed fingerprints in
// localStorage (synchronous, paints instantly). localStorage is small and can
// be evicted, so every write is mirrored here; on sign-in the store reads
// localStorage first and falls back to this copy. That mirror is what makes an
// offline queue durable: writes made with no network survive an eviction, a
// reload, and a browser restart, then flush on reconnect.
//
// Everything here degrades silently: when IndexedDB is unavailable (tests,
// private mode, old browsers) the helpers resolve to null/false and the
// localStorage copy remains the only cache.

const DB_NAME = 'pa27-offline';
const STORE = 'kv';
let dbHandle = null;
let opening = null;
let warned = false;

function warnOnce(e) {
  if (!warned) {
    warned = true;
    console.error('idb: mirror unavailable, localStorage only', e);
  }
}

function openDb() {
  if (dbHandle) return Promise.resolve(dbHandle);
  if (!globalThis.indexedDB) return Promise.resolve(null);
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const req = globalThis.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch(e => {
      warnOnce(e);
      opening = null; // retry on the next call (the failure may be transient)
      return null;
    });
  }
  return opening;
}

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Resolves false (never rejects) when the mirror is unavailable or fails.
export async function idbSet(key, value) {
  try {
    const db = await openDb();
    if (!db) return false;
    await reqAsPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key));
    return true;
  } catch (e) { warnOnce(e); return false; }
}

// Resolves null when missing or unavailable.
export async function idbGet(key) {
  try {
    const db = await openDb();
    if (!db) return null;
    return (await reqAsPromise(db.transaction(STORE).objectStore(STORE).get(key))) ?? null;
  } catch (e) { warnOnce(e); return null; }
}

export async function idbDel(key) {
  try {
    const db = await openDb();
    if (!db) return false;
    await reqAsPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key));
    return true;
  } catch (e) { warnOnce(e); return false; }
}
