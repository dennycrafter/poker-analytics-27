# Poker Analytics 27

A mobile-first poker session tracker web app: log live or past cash-game and
tournament sessions, track your stack event by event during live play, and see
month-grouped results with correct net/hourly math.

Dark mode only. No build step, no dependencies — vanilla ES modules, hand-rolled
SVG charts, data stored in your browser (localStorage) with JSON export/import.

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
- Statistics / Calendar / Reports / More are placeholders until later tiers.
- Demo data: ~40 realistic seeded sessions over the last 5 months
  (deterministic; Settings → Reset demo data restores them in later tiers).

## Architecture

```
index.html          app entry
css/styles.css      design system (brief section 2)
js/
  main.js           shell: tab bar, live banner, routing + 1s tick wiring
  router.js         hash-based router (#/feed, #/live/:id, #/session/:id, ...)
  store.js          versioned localStorage document + pub/sub mutations
  seed.js           deterministic demo data (seeded PRNG)
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

Buy-in single source of truth: live-tracked cash sessions derive buy-in from
stack events (`tracked_via_stack = true`); past sessions store it directly.
Derived values (`net_result`, `hours`, `hourly_rate`, ...) are never stored.
