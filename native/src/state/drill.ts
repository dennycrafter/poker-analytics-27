// Drill-down into the Feed (brief 5.11 / 5.12 / 5.13), port of the web's
// js/screens/drill.js: the Feed's filter is REPLACED with a fresh one narrowed
// to the tapped period or bucket, so the summary pill + X shows what was
// applied and clears it.
import { router } from 'expo-router';

import { emptyFilter, type Filter } from '../lib/filters';
import { periodRange, type PeriodKind } from '../lib/reports';
import { setFilter } from './filters';

/** The Feed filter a drill-down applies (pure, for tests and screens). */
export function drillFilter(partial: Partial<Filter>): Filter {
  return { ...emptyFilter(), ...partial };
}

export function periodFilter(kind: PeriodKind, key: string): Filter {
  const { from, to } = periodRange(kind, key);
  return drillFilter({ range: 'custom', from, to });
}

function openFeedWith(f: Filter): void {
  setFilter('feed', f);
  router.navigate('/');
}

export function drillToPeriod(kind: PeriodKind, key: string): void { openFeedWith(periodFilter(kind, key)); }

export function drillToFilter(partial: Partial<Filter>): void { openFeedWith(drillFilter(partial)); }
