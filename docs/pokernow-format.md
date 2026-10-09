# PokerNow export formats (target of `js/pokernow-import.js`)

PokerNow (pokernow.club) has no published CSV spec. The formats below were
taken from **real exports committed to public GitHub repositories**. Each file
was downloaded and checked byte-for-byte (`cmp`) against the copy used during
research on 2026-10-09. No real export is committed here: every fixture under
`tests/fixtures/pokernow/` is synthetic (`generate.mjs`, made-up players and
ids). The quoted lines below are trimmed; in this note nicknames are replaced
with `<nick>` and PokerNow player ids with `<id>`.

## Sources

| Kind | Repository / path | Verified |
|---|---|---|
| Ledger | `andrebhu/poker` · `logs/ledger_pglVcvZMY0ia6u7lju0csvbWE.csv` | identical bytes |
| Log (same game as the ledger above) | `andrebhu/poker` · `logs/poker_now_log_pglVcvZMY0ia6u7lju0csvbWE.csv` | identical bytes |
| Log (PLO, run-it-twice) | `andrebhu/poker` · `logs/poker_now_log_pglyAxJWJfsiiHfm0EXYDJcMY.csv` | identical bytes |
| Ledger | `ObfuscatedFuture/pokerNow_Stats` · `testFiles/ledger_pglrqTDi9-nBInG5U2wGN-Tbh.csv` | downloaded, header checked |
| Ledger ×2 | `mjgusev/pokernow-log-analyzer` · `backend/uploads/ledger_pglgbTFNeg2OQuYJGIibletHi.csv`, `ledger_pgltMXVG4GtuP3nq-Me8rorZr.csv` | downloaded, header checked |
| Ledger | `mmuoio/poker-manager` · `website/static/uploads/ledgers/ledger_pgliPKiJz7ggsbOtc_Lb4oAPC.csv` | downloaded, header checked |
| Log (2025, hand ids, game rotation, id change) | `atran39/paulies` · `2025-06-11_clean.csv` | identical bytes |
| Log (2026, PLO5, integer chips, config block) | `paramt/poker-analytics` · `public/demo.csv` | identical bytes |
| Log (2022, integer chips, straddles) | `arashrai/poker-with-the-boys` · `logs/poker_night_20220630.csv` | identical bytes |

Raw URL pattern: `https://raw.githubusercontent.com/<repo>/HEAD/<path>`.

PokerNow names the downloads `ledger_<gameId>.csv` and
`poker_now_log_<gameId>.csv`, where the game id starts with `pgl`. The importer
reads the id from the file name to pair the two files from the same table.

## 1. Session ledger

Header, the same in all five ledgers listed above:

```
player_nickname,player_id,session_start_at,session_end_at,buy_in,buy_out,stack,net
```

Sample rows (andrebhu, ObfuscatedFuture):

```
"<nick>",<id>,2022-06-02T04:00:21.908Z,,4000,,3088,-912
"<nick>",<id>,2024-12-20T04:50:46.997Z,2024-12-20T05:27:02.201Z,5000,0,0,-5000
```

What the samples show:

- **Each row is a seat stint**, not a player. If someone quits and rejoins, they get two rows.
- **An empty `session_end_at` means the player was still seated at export.** `stack` then holds their current chips; a closed row has `stack` 0 (true for every row in all five ledgers).
- `buy_out` is usually empty on open rows, but not always: one andrebhu row is open with `buy_in 10000, buy_out 5000, stack 7493` (chips taken off mid-seat). The importer therefore decides "open" from `session_end_at` only, and uses `buy_out` emptiness only when that column is missing.
- `net = buy_out + stack - buy_in` holds for every row in all five ledgers (138 rows).
- Times are ISO-8601 UTC with `Z`.
- **The unit is cents for decimal-chip games.** The andrebhu pair proves it: the ledger's first data row has buy_in `4000`; the log's join line for the same player id says `joined the game with a stack of 40.00.` Games that use whole-number chips have no decimals, so the ledger can't show which unit it uses. Without a log, the importer assumes chips and warns `ledger_unit_assumed`. Override this with `ledgerUnit`.
- **The nickname is not unique; `player_id` is.**

`nit_escrow` is accepted when present and added to `stack`. **It does not appear in any sample listed above.** Support for it is defensive, based on an unverified report of newer exports.

## 2. Full game log

Header: `entry,at,order`. `entry` is free text, `at` is ISO UTC, and `order` is an
increasing integer. Lines are exported newest first. Players appear as
`"<nick> @ <player_id>"`. The importer relies on these real line shapes:

```
"-- starting hand #166  (No Limit Texas Hold'em) (dealer: ""<nick> @ <id>"") --",2022-06-02T04:15:30.654Z,...       (andrebhu 2022)
"-- starting hand #119 (id: caxrxymi6fdx)  (No Limit Texas Hold'em) (dealer: ...) --",2025-06-11T04:09:57.528Z,...        (atran39 2025)
"-- starting hand #133 (id: avccxhbeooqo)  Pot Limit Omaha 5 Hi (dealer: ...) --",2026-03-30T03:23:29.058Z,...             (paramt 2026, no parentheses)
"Player stacks: #1 ""<nick> @ <id>"" (79.07) | #2 ""<nick> @ <id>"" (70.06) | ..."
"""<nick> @ <id>"" posts a small blind of 0.25"
"""<nick> @ <id>"" posts a big blind of 0.50"
"The player ""<nick> @ <id>"" joined the game with a stack of 40.00."
"The player ""<nick> @ <id>"" quits the game with a stack of 0.00."
"The player ""<nick> @ <id>"" stand up with the stack of 88.59."
"The player ""<nick> @ <id>"" sit back with the stack of 88.59."
"The admin approved the player ""<nick> @ <id>"" participation with a stack of 40.00."
"The admin updated the player ""<nick> @ <id>"" stack from 214.00 to 214.50."
"The player ""<nick> @ <id>"" changed the ID from <id> to <id> because authenticated login."
"The game's big blind was changed from 0.20 to 0.50."
"Poker variant defined as ""No Limit Texas Hold'em"" by the game type rotation."
"Game Config Changes\n* Poker Variant: Pot Limit Omaha Hi » Pot Limit Omaha 5 Hi"   (multi-line quoted cell)
"Your hand is K♦, Q♠"
"""<nick> @ <id>"" collected 3.50 from pot"
```

What the samples show:

- **Amounts end with a sentence period** (`stack of 40.00.`), so number matching has to be exact.
- **Some games use whole-number chips** (paramt, arashrai: `posts a big blind of 10`); others use two decimals.
- **`Your hand is` lines come only from the player who exported the log.** That identifies the exporter's own hands. The importer also checks showdown cards to confirm which player exported the log.
- **Variants observed:** `No Limit Texas Hold'em`, `Pot Limit Omaha Hi`, `Pot Limit Omaha 5 Hi`. Other names in `mapVariant` follow the same pattern but haven't been seen in a real file.
- **Players who were seated before the game started have no `joined` line.** Only an `approved ... participation` line exists for them, and the ledger leaves `session_start_at` blank. The importer uses the approval time as the start.
- **A player's ID can change mid-game when they log in** (the `changed the ID ... because authenticated login` line above). The importer maps the old id to the new one.

## Mapping to the Session model (brief §4)

| Session field | From |
|---|---|
| `kind` | always `'cash'` (ledgers are cash tables) |
| `start_time` / `end_time` | first seat start / last seat end. An open seat leaves `end_time` null and sets `is_live`. |
| `buy_in`, `cashed_out` | sum of `buy_in` / `buy_out` over my seats. This is the ledger when it exists, otherwise the log. Unit is scaled by `ledgerUnit` and `chipValue`. |
| live sessions | `tracked_via_stack = true`, `buy_in`/`cashed_out` left null, and stack events built from joins, admin top-ups and quits (brief: single source of truth) |
| `break_seconds` | stand-up → sit-back gaps plus gaps between seats |
| `small_blind`, `big_blind` | the most-played blind level in my hands (log only) |
| `game_name` | the most-played variant, mapped (log only) |
| `hands_count` | hands where I was in `Player stacks`; `hands_count_estimated = false` |
| `table_size` | max seats in one of my hands, clamped to 2–10 (log only). A real 6-max table can show fewer seats. |
| `opponents` | other nicknames at my hands, ordered by most frequent first |

Stakes, game and table size are **not in the ledger**. A ledger-only import leaves them null with warnings, unless `defaults` supplies them.

## Unverified
- **The parser hasn't been run against a fresh export from the live site.** PokerNow can change its wording without notice. Unknown lines are ignored, and the importer warns when it sees no hands.
- **Tournament exports weren't researched.** The module imports cash tables only.
