// Top 10 (brief 5.14): best and worst ten ended sessions by net result.
// Pure. `mode` follows the Statistics staking preference ('net' | 'gross').
//
// Ordering: best = net descending, worst = net ascending. Ties go to the more
// recent session (later start_time first), then id, so the order is total and
// stable across devices.

import { endedSessions, sessionNet } from './stats.js';

export function topSessions(doc, which = 'best', n = 10, mode = 'net', sessions = endedSessions(doc)) {
  const dir = which === 'worst' ? 1 : -1;
  return sessions
    .map(s => ({ s, net: sessionNet(doc, s, mode) }))
    .sort((a, b) =>
      dir * (a.net - b.net) ||
      Date.parse(b.s.start_time) - Date.parse(a.s.start_time) ||
      String(a.s.id).localeCompare(String(b.s.id)))
    .slice(0, n);
}
