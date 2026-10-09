// Pure presentation helpers shared by screens (and unit-tested): row titles,
// stakes parsing, name lookups and integer parsing. No React imports.
import { parseAmount } from './format';
import type { Doc, NamedItem, Session } from './types';

export const STAKE_CHIPS: { sb: number; bb: number }[] = [
  { sb: 0.1, bb: 0.2 }, { sb: 0.25, bb: 0.5 }, { sb: 0.5, bb: 1 }, { sb: 1, bb: 2 }, { sb: 2, bb: 5 }, { sb: 5, bb: 10 },
];

export const TABLE_SIZES = [2, 3, 4, 5, 6, 7, 8, 9, 10];

export function tableLabel(n: number | null): string {
  if (!n) return '--';
  return n === 2 ? 'Heads-up' : `${n}-max`;
}

export function nameOf(list: NamedItem[], id: string | null): string | null {
  if (!id) return null;
  return list.find(x => x.id === id)?.name ?? null;
}

/** Feed row title, same text as the web feed: "EUR 0.1/0.2 NL Hold'em" / "EUR 10 NL Hold'em". */
export function sessionTitle(doc: Pick<Doc, 'games' | 'settings'>, s: Session): string {
  const cur = doc.settings.currency;
  const game = nameOf(doc.games, s.game_id) ?? '';
  const amount = s.kind === 'cash' ? `${s.small_blind}/${s.big_blind}` : `${s.initial_buy_in}`;
  return `${cur} ${amount} ${game}`.trim();
}

/** "0.25/0.5" (or "0,25/0,5") -> blinds. Null unless 0 < sb <= bb. */
export function parseStakes(raw: string): { sb: number; bb: number } | null {
  const m = /^\s*([\d.,]+)\s*\/\s*([\d.,]+)\s*$/.exec(raw || '');
  if (!m) return null;
  const sb = parseAmount(m[1]);
  const bb = parseAmount(m[2]);
  if (sb === null || bb === null || sb <= 0 || bb <= 0 || sb > bb) return null;
  return { sb, bb };
}

/** Non-negative whole number from user input. Null for empty; NaN for invalid. */
export function parseCount(raw: string): number | null {
  const t = String(raw ?? '').trim();
  if (t === '') return null;
  if (!/^\d+$/.test(t)) return NaN;
  return Number(t);
}

/** Last-used value of a session field, for form defaults ("default last used"). */
export function lastUsed<K extends keyof Session>(sessions: Session[], key: K): Session[K] | null {
  let best: Session | null = null;
  for (const s of sessions) {
    if (s[key] === null || s[key] === undefined) continue;
    if (!best || Date.parse(s.start_time) > Date.parse(best.start_time)) best = s;
  }
  return best ? best[key] : null;
}

export function defaultBankrollId(doc: Pick<Doc, 'bankrolls'>): string | null {
  return (doc.bankrolls.find(b => b.is_default) ?? doc.bankrolls[0])?.id ?? null;
}
