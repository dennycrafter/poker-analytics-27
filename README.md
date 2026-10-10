# Poker Analytics 27

A mobile-first poker session tracker web app: log live or past cash-game and
tournament sessions, track your stack event by event during live play, and see
month-grouped results with correct net/hourly math.

Dark mode only. No build step — vanilla ES modules, hand-rolled SVG charts.
Data lives in your Supabase account and syncs across devices in real time
(see Backend).

## Run locally

Any static file server from this directory, e.g.:

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

(Opening `index.html` via `file://` will not work — ES modules need http(s).)

## What works (Tier 1)

- Feed: month-grouped session list with net totals, ALL / SESSIONS / HANDS /
  NOTES tabs, live-session banner and pulsing LIVE badge.
- Start session (cash or tournament) as live-tracked or "log past session"
  with validation (no future starts, no end before start).
- Live view: ticking timer computed from `start_time` (survives refresh),
  pause/resume with break accounting, editable rows, end-session flow.
- Stack screen (live cash): stack events (buy-in / top-up / cash-out),
  cumulative result chart, reverse-chronological event list.
- Session detail: every row editable, red delete.
- Statistics (Tier 2): every formula, stat detail charts, per-tab Filter sheet.
- New accounts start empty (default games/locations/bankroll, no demo
  sessions); `js/seed.js` is kept only for tests and legacy migration checks.

## Architecture

```
index.html          app entry
css/styles.css      design system (brief section 2)
js/
  main.js           shell: tab bar, live banner, routing + 1s tick wiring
  router.js         hash-based router (#/feed, #/live/:id, #/session/:id, ...)
  store.js          in-memory document + pub/sub; syncs to Supabase (see Backend)
  cloud-map.js      pure document <-> database row mapping, legacy migration
  config.js         Supabase URL + publishable key (public by design)
  supabase-client.js shared Supabase client
  account.js        sign-out
  vendor/supabase.js vendored supabase-js v2.109.0 (ESM, no runtime CDN)
  screens/auth.js   log in / sign up / forgot + set new password
  seed.js           deterministic demo data (no longer loaded by the app)
  domain.js         all mutations (start/end/log/update/delete, stack events)
  stats.js          derived values computed on read (net, hours, rate, BB)
  format.js         money/time/date formatting helpers
  dates.js          local <-> UTC conversion for inputs
  ui.js             escaping, toasts, bottom sheets, small editors
  screens/picker.js  shared pickers for rows
  tick.js           per-second refresh of live regions
  icons.js          inline SVG icon set
  charts/svg.js     dependency-free SVG line chart
  screens/          feed, start, live, stack, detail, simple (placeholders)
```

## Backend

- **Stack:** Supabase (Postgres, Auth, Realtime), project
  `assutwkylxjncaqhbjtv`. Schema: `supabase/migrations/20261009120000_step_a_backend.sql`
  — tables `sessions`, `bankroll_transactions`, `user_settings`.
- **Data model:** a `sessions` row carries every session field plus its stack
  events and sell actions as jsonb. `user_settings` holds per-user master data
  (bankrolls, locations, games, tournament types, groups), currency, player
  notes and hand histories. UI preferences (filters, staking toggle) stay
  local per device.
- **Auth:** email + password via Supabase Auth. Email confirmation is off
  (`mailer_autoconfirm`), so sign-up is instant. "Forgot password" sends a
  reset link that opens the app's set-new-password screen.
- **Security:** row level security on every table; each policy is
  `auth.uid() = user_id` and `user_id` defaults to `auth.uid()`. Realtime does
  not apply RLS to DELETE events, so a trigger on `realtime.subscription`
  (`supabase/migrations/20261010120000_realtime_owner_filter.sql`) forces a
  `user_id = <jwt sub>` filter onto every subscription to these tables;
  signed-out subscriptions are rejected. Verify with
  `node tests/realtime-delete-privacy.test.mjs` (live project, disposable
  accounts; set `SECRET_SUPABASE_ACCESS_TOKEN` for cleanup). Re-apply that
  migration if a Supabase Realtime upgrade ever drops the trigger.
- **Sync:** screens read a synchronous in-memory document. Writes apply
  optimistically, then a diff of changed entities is upserted/deleted.
  Realtime `postgres_changes` pushes other devices' writes within about a
  second; a full pull runs on sign-in, reconnect and tab focus. Last write
  wins. A per-user localStorage cache paints instantly and is cleared on sign-out.
  Live timers are computed from `start_time`/pauses in the row, so they match on
  every device. A write the server rejects is rolled back and surfaced as a toast.
- **Offline and sync:** the merge policy is last-write-wins per entity row
  (per-field merges are not attempted). With no network the app keeps working:
  writes stay local (localStorage plus a durable IndexedDB mirror in
  `js/idb.js`, so the queue survives eviction and browser restarts), live
  sessions keep ticking, and the service-worker shell keeps the app loadable.
  When the connection returns — the window `online` event, a realtime
  resubscribe, or the sync backoff timer — the queue flushes and a catch-up
  pull merges anything other devices wrote meanwhile. Imports and demo resets
  flush atomically: every upsert is confirmed before any delete runs, and a
  rejected write rolls the document back to the pre-replace state, so a bad
  import can never wipe an account.
- **Legacy data:** if this browser has pre-backend localStorage data and the
  account is empty, the app offers a one-tap "Migrate local data".
- **Keys:** only the project URL and the *publishable* key live in the repo
  (`js/config.js`); they are safe in browsers because of RLS. The service_role
  key and management tokens are never committed.
- **Applying the schema:** run the migration SQL files in order in the Supabase
  SQL editor (or `supabase db push`). It also creates the RLS policies and `updated_at`
  triggers, and adds the tables to the `supabase_realtime` publication.

Buy-in single source of truth: live-tracked cash sessions derive buy-in from
stack events (`tracked_via_stack = true`); past sessions store it directly.
Derived values (`net_result`, `hours`, `hourly_rate`, ...) are never stored.
