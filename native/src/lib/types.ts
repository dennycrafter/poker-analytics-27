// Domain types. Field names match the Supabase columns (supabase/migrations)
// and the web app's in-memory document 1:1, so both clients read and write
// the same rows.

export type SessionKind = 'cash' | 'tournament';
export type StackEventKind = 'buy_in' | 'top_up' | 'cash_out';
export type TransactionKind = 'deposit' | 'withdrawal' | 'other';
export type StakingMode = 'net' | 'gross';

export interface Session {
  id: string;
  kind: SessionKind;
  game_id: string | null;
  location_id: string | null;
  bankroll_id: string | null;
  group_id: string | null;
  table_size: number | null;
  start_time: string;
  end_time: string | null;
  duration_seconds: number | null;
  break_seconds: number;
  is_live: boolean;
  paused_at: string | null;
  hands_count: number | null;
  hands_count_estimated: boolean;
  comment: string | null;
  opponents: string | null;
  tracked_via_stack: boolean;
  // cash
  small_blind: number | null;
  big_blind: number | null;
  buy_in: number | null;
  cashed_out: number | null;
  tips: number | null;
  // tournament
  tournament_type_id: string | null;
  tournament_name: string | null;
  initial_buy_in: number | null;
  total_buy_in: number | null;
  prize: number | null;
  position: number | null;
  entries: number | null;
  created_at: string | null;
  updated_at?: string | null;
}

export interface StackEvent {
  id: string;
  session_id: string;
  kind: StackEventKind;
  amount: number;
  occurred_at: string | null;
}

export interface SellAction {
  id: string;
  session_id: string;
  percentage: number;
  markup: number;
  backer_name: string | null;
}

export interface Transaction {
  id: string;
  bankroll_id: string | null;
  kind: TransactionKind;
  amount: number | null;
  description: string | null;
  occurred_at: string | null;
  created_at: string | null;
  updated_at?: string | null;
}

export interface NamedItem {
  id: string;
  name: string;
}

export interface Bankroll extends NamedItem {
  is_default?: boolean;
  created_at?: string;
}

/** Values the native app never edits but must round-trip untouched. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export interface Doc {
  settings: { currency: string };
  bankrolls: Bankroll[];
  locations: NamedItem[];
  games: NamedItem[];
  tournament_types: NamedItem[];
  groups: NamedItem[];
  /** master_data keys written by newer web versions; preserved verbatim. */
  extra_master: Record<string, JsonValue>;
  sessions: Session[];
  stack_events: StackEvent[];
  sell_actions: SellAction[];
  transactions: Transaction[];
  player_notes: JsonValue[];
  hand_histories: JsonValue[];
}

/** The slice of the document the per-session formulas need. */
export type SessionChildren = Pick<Doc, 'stack_events' | 'sell_actions'>;

export function blankDoc(): Doc {
  return {
    settings: { currency: 'EUR' },
    bankrolls: [],
    locations: [],
    games: [],
    tournament_types: [],
    groups: [],
    extra_master: {},
    sessions: [],
    stack_events: [],
    sell_actions: [],
    transactions: [],
    player_notes: [],
    hand_histories: [],
  };
}
