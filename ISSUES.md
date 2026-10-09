# ISSUES — independent bug hunt of the shipped web app

Audit of `origin/main` @ `33bddd8` (Tiers 1-4 + sync + auth), run locally against
the production Supabase project with disposable `bh-test+…@example.com`
accounts (all deleted afterwards). **Nothing in app code was changed.**

Every node-testable issue has a regression test that asserts the *correct*
behaviour and therefore **fails today**:

- `tests/bughunt-offline.test.mjs` — no network; currently 0 passed / 16 failed.
- `tests/bughunt-cloud-import.test.mjs` — needs `SECRET_SUPABASE_ACCESS_TOKEN`
  (creates and deletes its own account); currently 2 passed (setup checks) / 3 failed.

UI-only issues have screenshot evidence uploaded as project files (ids below).

Ranked by severity.

---

## #1 — CRITICAL: importing a file the database rejects wipes the whole account

**Repro (browser, signed in):**
1. Have 3 sessions in the account.
2. Settings → Import JSON → choose a file whose session has `table_size: 12`
   (or `end_time` before `start_time`, `hands_count: -5`, `break_seconds: -100`,
   `duration_seconds: -1`). Confirm "Import and replace".
3. Toast: *"Saved on this device; some changes are still syncing to your account."*
4. Feed is empty. Reload: still empty. The 3 original sessions are gone from the
   cloud; the imported session never landed either.

**Expected:** the import is refused up front (validation error), or applied
atomically so a rejected row leaves the existing data untouched.
**Actual:** 0 of 3 original sessions survive in the cloud; the local document
ends with 0 sessions. The toast implies the data is merely "still syncing".

**Mechanism:** `parseImport` (js/backup.js) does not enforce the DB check
constraints (`supabase/migrations/20261009120000_step_a_backend.sql`).
`replaceDoc` → the sync flush runs the deletes of the old rows and the upsert
of the new row as independent parallel jobs (js/store.js). The deletes succeed;
the upsert is rejected (non-transient); the error path re-pulls and discards
the rejected local key, so the device converges on the now-empty server.

**Evidence:** `tests/bughunt-cloud-import.test.mjs` (#1 cases),
`tests/bughunt-offline.test.mjs` (5 × "#1 parseImport refuses a session the DB rejects").
Screenshots: before `fl_1tEQNfaL`, after reload `fl_Az7VIbLj`.

**Suspected files:** js/backup.js (`parseImport` validation), js/store.js
(replace flush is not atomic; *store-change ticket below*), js/screens/settings.js
(`applyReplacement` toast wording).

---

## #2 — HIGH (security): stored XSS through an imported backup

**Repro:** import a JSON backup whose session has
`"table_size": "<img src=x onerror=\"document.title='XSS-FIRED'\">"`. Open Feed.

**Expected:** value rejected or coerced by the importer, and escaped on render.
**Actual:** `parseImport` keeps the string; `sessionRowHtml` interpolates
`${s.table_size}-max` without `esc()` (js/screens/feed.js:39; same pattern in
js/screens/detail.js:101 and :121). In Chromium the handler ran:
`document.title === 'XSS-FIRED'`. A shared "backup file" is a realistic vector.
Other unescaped numeric fields (blinds, position, entries) follow the same
pattern and should be audited together.

**Evidence:** `tests/bughunt-offline.test.mjs` (2 × #2). Screenshot `fl_uUCgbBXo`
(broken `<img>` rendered in the row). Persistence of the payload through the
cloud round-trip was **not** verified (the column is `smallint`).

**Suspected files:** js/backup.js, js/screens/feed.js, js/screens/detail.js.

---

## #3 — HIGH: duplicate session ids in an import → data loss and device/cloud divergence

**Repro:** import a file containing two sessions with the same `id`.
**Expected:** refused, or de-duplicated, with device and cloud agreeing.
**Actual:** `parseImport` remaps both to the *same* new id. Device shows 2
sessions, cloud stores 1 (sync keys entities by id), so stats differ by device;
and as in #1, the 3 pre-existing cloud sessions are deleted (0/3 survived in the
cloud run).

**Evidence:** `tests/bughunt-cloud-import.test.mjs` (#3: device 2 vs cloud 1),
`tests/bughunt-offline.test.mjs` (#3: both remapped ids identical).
**Suspected files:** js/backup.js (id remap map keyed by old id).

---

## #4 — HIGH (stats correctness): ending a session while paused counts the pause as play time

**Repro:** start a live session, Pause, wait, End session without resuming.
**Expected:** the ongoing pause (now − `paused_at`) is added to `break_seconds`.
**Actual:** `endCommon` (js/domain.js:115) sets `paused_at = null` and leaves
`break_seconds` unchanged. A 3h session with a 10-min break plus a 1h pause at
the end records 2:50 played instead of 1:50, inflating hours and depressing
hourly rate, std-dev/hour, and RoR inputs. Applies to cash and tournament.

**Evidence:** `tests/bughunt-offline.test.mjs` (2 × #4: `break_seconds 600`, expected ~4200).
**Suspected files:** js/domain.js (`endCommon`).

---

## #5 — MEDIUM: offline edit resurrects a session deleted on another device

**Repro (two browser contexts, same account):** A goes offline and edits a
session's comment; B deletes the session; A reconnects.
**Expected:** the delete wins (or the user is asked).
**Actual:** after A reconnects, the session is back on both devices (B: 0 rows
after delete → 1 row after A reconnects). Last-writer upsert, no tombstones.
(Control: an edit saved *online* after B's delete did **not** resurrect it.)

**Evidence:** screenshot `fl_eBEN2SSP`. UI/cloud only, no node test.
**Suspected files:** js/store.js (dirty-local upsert on reconnect without delete awareness).

---

## #6 — MEDIUM: Session detail accepts a start time after the end time, then silently reverts

**Repro:** open a saved session, tap Start time, pick a time after End time
(still in the past), Save.
**Expected:** inline error "Start time must be before end time" (the End-time
editor already has the mirror check).
**Actual:** the sheet closes; the DB rejects the row (`sessions_end_after_start`)
and the change is rolled back with a generic toast *"A change could not be saved
and was undone."* Also `saveTime` clamps `duration_seconds` to 0 for the
optimistic write.

**Evidence:** screenshot `fl_AG3A4RPV`. UI only.
**Suspected files:** js/screens/detail.js `editTimeSheet` (lines ~177-184).

---

## #7 — MEDIUM: import accepts sell actions totalling more than 100%

**Repro:** import a tournament (buy-in 100, prize 1000) with one sell action of 300%.
**Expected:** refused (the Sell sheet enforces ≤100%, brief §5.6).
**Actual:** accepted; staked net result = **−1800** while gross = 900.
**Evidence:** `tests/bughunt-offline.test.mjs` (#7). **Suspected files:** js/backup.js.

---

## #8 — MEDIUM: `parseImport` throws on `null` entries instead of returning an error

**Repro:** import `{ "sessions": [...], "stack_events": [null] }` (same for
`sell_actions`, `player_notes`, `hand_histories`).
**Expected:** `{ ok: false, error: "…" }` → toast.
**Actual:** `TypeError: Cannot read properties of null (reading 'session_id')`,
thrown inside `FileReader.onload` (js/screens/settings.js:69) — the user gets
no feedback at all.
**Evidence:** `tests/bughunt-offline.test.mjs` (4 × #8). **Suspected files:** js/backup.js.

---

## #9 — LOW: money formatting shows a negative zero

`fmtMoney(-0.004, 'EUR')` → `"-EUR 0"` (sign taken before rounding).
Reachable through tiny float residues (e.g. staking math).
**Evidence:** `tests/bughunt-offline.test.mjs` (#9). **Suspected files:** js/format.js:19.

---

## Store-change ticket (not edited — js/store.js is off-limits)

- **File/function:** js/store.js, the flush path used after `replaceDoc`.
- **Change:** a replace (import/demo reset) must be applied atomically —
  upsert new rows first and only delete old rows once every upsert succeeded,
  or use a single RPC/transaction. On a non-transient rejection during a
  replace, restore the pre-replace snapshot instead of pulling an empty server.
- **Why:** #1 and #3 delete all user data on one bad row. Fixing `parseImport`
  validation removes the known triggers but not the class.

## Checked and NOT reproduced

- DST hour splitting (Europe/Dublin spring-forward / fall-back): 4h spans sum to 240 min.
- Hour filter at 0 and 23 for a 23:00-01:00 session: matches 23 and 0, not 1;
  24h and 26h sessions match every hour.
- Wrong password ×6: consistent "Wrong email or password." (no lockout or
  rate-limit message surfaced — Supabase rate limit not hit at that count).
- Sign up with an existing email: "An account with this email already exists. Log in instead."

## Not covered

Password-reset email round-trip (no inbox for disposable accounts), double-tap
on Save/Start (static check only: no busy guard seen in js/screens/start.js,
not reproduced), back-button mid-flow, 500-char/emoji names in browser,
currency mismatch across devices, live session spanning several days in browser.
