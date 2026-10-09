// Top 10 (brief 5.14): best and worst ten ended sessions by net result, a
// faithful port of the web app's js/rankings.js. `mode` follows the
// Statistics staking preference ('net' | 'gross').
//
// Ordering: best = net descending, worst = net ascending. Ties go to the more
// recent session (later start_time first), then id, so the order is total and
// stable across devices.

import { endedSessions, sessionNet } from './stats';
import type { Session, SessionChildren, StakingMode } from './types';

export type RankWhich = 'best' | 'worst';

export interface RankedSession { s: Session; net: number }

export function topSessions(
  doc: SessionChildren & { sessions: Session[] },
  which: RankWhich = 'best',
  n = 10,
  mode: StakingMode = 'net',
  sessions: Session[] = endedSessions(doc),
): RankedSession[] {
  const dir = which === 'worst' ? 1 : -1;
  return sessions
    .map(s => ({ s, net: sessionNet(doc, s, mode) }))
    .sort((a, b) =>
      dir * (a.net - b.net) ||
      Date.parse(b.s.start_time) - Date.parse(a.s.start_time) ||
      String(a.s.id).localeCompare(String(b.s.id)))
    .slice(0, n);
}
