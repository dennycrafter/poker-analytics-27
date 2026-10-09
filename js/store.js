// Single versioned localStorage document + tiny pub/sub.
// ALL mutations flow through mutate(); derived fields are never stored here.

const STORAGE_KEY = 'poker-analytics-27:v1';

let doc = null;
const listeners = new Set();

function blank() {
  return {
    version: 1,
    settings: { currency: 'EUR' },
    bankrolls: [], locations: [], games: [], tournament_types: [], groups: [],
    sessions: [], stack_events: [], sell_actions: [], transactions: [],
    player_notes: [], hand_histories: [],
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return d && d.version === 1 ? d : null;
  } catch (e) {
    console.error('store: failed to load saved data', e);
    return null;
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
  } catch (e) {
    console.error('store: failed to persist data', e);
  }
}

// Seeds on first load only; otherwise reloads the persisted document.
export function initStore(seedFn) {
  doc = load();
  if (!doc) {
    doc = seedFn(Date.now());
    persist();
  }
}

export function getState() { return doc; }

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of [...listeners]) {
    try { fn(doc); } catch (e) { console.error('subscriber failed', e); }
  }
}

export function mutate(fn) {
  fn(doc);
  doc.updated_at = new Date().toISOString();
  persist();
  notify();
}

// Replace the whole document (used later by import / reset demo data).
export function replaceDoc(next) {
  doc = { ...blank(), ...next, version: 1 };
  persist();
  notify();
}

export function genId(prefix) {
  return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
