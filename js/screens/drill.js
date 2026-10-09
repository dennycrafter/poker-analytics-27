// Drill-down into the Feed (brief 5.11 "Tap a month: Feed filtered to that
// month", 5.12, 5.13). Reuses the Tier 2 per-tab filter: the Feed's filter is
// replaced with a fresh one narrowed to the tapped period / bucket, so the
// usual summary pill + X shows what was applied and clears it.

import { navigate } from '../router.js';
import { emptyFilter, setFilter } from '../filters.js';
import { periodRange } from '../reports.js';

function openFeedWith(partial) {
  window.__feedSeg = 'sessions';
  setFilter('feed', { ...emptyFilter(), ...partial });
  navigate('/feed');
}

// kind: 'day' | 'week' | 'month' | 'year'; key from reports.js period keys.
export function drillToPeriod(kind, key) {
  const { from, to } = periodRange(kind, key);
  openFeedWith({ range: 'custom', from, to });
}

// Rolling "30 last days" row — the Feed's own Last 30 days range.
export function drillToLast30() { openFeedWith({ range: '30d' }); }

// All time: the Feed with no filter.
export function drillToAll() { openFeedWith({}); }

// Arbitrary filter fields (hour, kind, location_ids, stakes ...).
export function drillToFilter(partial) { openFeedWith(partial); }
