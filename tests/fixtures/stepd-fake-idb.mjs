// Minimal IndexedDB mock for the STEP D suite: a single implicit object store
// backed by an exported Map (`mirror`), request callbacks fired on the next
// microtask — the same async shape js/idb.js expects.
export const mirror = new Map();

class FakeReq {
  constructor() { this.onsuccess = null; this.onerror = null; this.result = undefined; }
  settle(value) {
    this.result = value;
    queueMicrotask(() => this.onsuccess && this.onsuccess({ target: this }));
  }
}

class FakeDb {
  constructor() { this.objectStoreNames = { contains: () => true }; }
  transaction() {
    const store = {
      put: (v, k) => { const r = new FakeReq(); mirror.set(k, v); r.settle(k); return r; },
      get: k => { const r = new FakeReq(); r.settle(mirror.has(k) ? mirror.get(k) : undefined); return r; },
      delete: k => { const r = new FakeReq(); mirror.delete(k); r.settle(undefined); return r; },
    };
    return { objectStore: () => store };
  }
}

export function installFakeIdb() {
  mirror.clear();
  globalThis.indexedDB = {
    open() {
      const req = new FakeReq();
      req.result = new FakeDb();
      queueMicrotask(() => req.onsuccess && req.onsuccess({ target: req }));
      return req;
    },
  };
  return mirror;
}
