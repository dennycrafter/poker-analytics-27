// Per-tab filters (brief 9): Feed and Statistics each keep their own filter,
// device-local and persisted, like the web's doc.ui.filters (never synced).
// A tiny module-level store so every screen (Feed, Stats, stat detail,
// Reports drill-downs) reads and writes the same value.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import { emptyFilter, normalizeFilter, type Filter, type FilterTab } from '../lib/filters';

const KEY = 'pa27.filters';
const TABS: FilterTab[] = ['feed', 'stats'];

let state: Record<FilterTab, Filter> = { feed: emptyFilter(), stats: emptyFilter() };
const listeners = new Set<() => void>();
let hydrated = false;

function emit(): void { for (const fn of [...listeners]) fn(); }

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  AsyncStorage.getItem(KEY)
    .then(raw => {
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // A filter set on this device before hydration finished wins.
      const next = { ...state };
      for (const t of TABS) if (isEmptyDefault(state[t])) next[t] = normalizeFilter(parsed[t]);
      state = next;
      emit();
    })
    .catch(e => console.error('filters: could not read saved filters', e));
}

function isEmptyDefault(f: Filter): boolean {
  return JSON.stringify(f) === JSON.stringify(emptyFilter());
}

function persist(): void {
  AsyncStorage.setItem(KEY, JSON.stringify(state)).catch(e => console.error('filters: could not save filters', e));
}

export function getFilter(tab: FilterTab): Filter { return state[tab]; }

export function setFilter(tab: FilterTab, f: Filter): void {
  state = { ...state, [tab]: normalizeFilter(f) };
  persist();
  emit();
}

export function clearFilter(tab: FilterTab): void { setFilter(tab, emptyFilter()); }

/** Subscribe a component to one tab's filter; returns [filter, setFilter]. */
export function useFilter(tab: FilterTab): [Filter, (f: Filter) => void] {
  hydrate();
  const f = useSyncExternalStore(
    cb => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => state[tab],
  );
  return [f, (next: Filter) => setFilter(tab, next)];
}
