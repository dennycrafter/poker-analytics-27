# Poker Analytics 27 — native app (Expo / React Native)

iOS and Android companion to the web app in the repo root. It talks to the
**same Supabase project** (same accounts, same `sessions`,
`bankroll_transactions` and `user_settings` rows, same owner-only RLS and
realtime), so a session logged on the phone appears in the web app instantly
and vice versa. New accounts start empty (no demo data).

- Expo SDK 57, React Native 0.86, React 19, TypeScript (strict)
- Expo Router (file-based routes in `app/`)
- Statistics formulas ported 1:1 from `js/metrics.js` / `js/stats.js` and
  checked against the web implementation by `tests/metrics-parity.test.ts`

## Setup

Requirements: Node 20+, npm. For running on a device: the Expo Go app or a
development build; for store builds: an [Expo](https://expo.dev) account and EAS CLI.

```bash
cd native
npm install
```

### Config

There is no `.env`. `src/lib/config.ts` holds the Supabase project URL and
the **publishable (anon) key**, the same values as `js/config.js` in the web
app. Both are public by design: every table is protected by row-level
security, so the key alone cannot read anyone's data. To point the app at a
different Supabase project, change both values there.

Password-reset links open `pokeranalytics27://reset-password` (the `scheme`
in `app.json`). **Supabase must allow that redirect:** add
`pokeranalytics27://**` (and, for Expo Go, `exp://**`) under Authentication →
URL Configuration → Redirect URLs. Until it's added, Supabase sends the reset
link to the web Site URL instead, and the password is reset in the web app.
Either way the new password works in both apps.

## Run

```bash
npm start            # Metro dev server; press i / a, or scan the QR with Expo Go
npm run ios          # iOS simulator (macOS + Xcode)
npm run android      # Android emulator (Android Studio)
npm run web          # in-browser preview via react-native-web
```

## Checks

```bash
npm run typecheck          # tsc for the app and for tests/scripts
npm run lint               # expo lint (eslint-config-expo)
npm test                   # metrics parity + domain tests (node:test via tsx)
npm run test:tz            # the same suite under UTC, Europe/Dublin, America/Los_Angeles
npm run export:web         # production web bundle -> dist/ (proves the app bundles)
npx expo export --platform android --platform ios   # native bundles

# Live backend contract test. Creates throwaway nativetest.<ts>@example.com
# accounts, then deletes them via the Supabase Management API.
SECRET_SUPABASE_ACCESS_TOKEN=<personal access token> npm run test:integration
```

`test:integration` drives the app's own `CloudStore` (the same sync code the
screens use) with two clients on one account plus a second account. It
checks sign-up, initial settings, insert, edit, a realtime echo on the
other client, a live paused cash session with stack events, delete, and that
the second account can neither read nor update the first account's rows.
Then it deletes both users and verifies 0 users and 0 rows remain.

## Ship to TestFlight (iOS)

This needs **Denis's own Apple Developer Program membership** ($99/yr) and an
Apple ID with App Manager or Admin access in App Store Connect. None of these
credentials are in this repo, and no automation here holds them.

1. `npm install -g eas-cli && eas login` (Expo account).
2. `eas init`: links the project and writes `extra.eas.projectId` into
   `app.json`. Commit that.
3. `eas build:configure`: creates `eas.json`. The defaults (`development`,
   `preview`, `production` profiles) are fine. Add
   `"autoIncrement": true` to the `production` profile so each upload gets a
   new build number.
4. `eas build --platform ios --profile production`. When prompted, sign in
   with the Apple ID; EAS creates and stores the distribution certificate and
   provisioning profile for the bundle ID `global.starpool.pokeranalytics27`
   (change it in `app.json` first if you want a different one; it's permanent
   once it's on the App Store).
5. `eas submit --platform ios --latest`: uploads to App Store Connect. The
   first time, EAS can create the App Store Connect app record for you, or
   you can create it by hand (My Apps → + → New App, same bundle ID).
6. In App Store Connect → TestFlight: wait for processing (about 10–30 min),
   fill in the export-compliance answer (already declared in `app.json`:
   `ITSAppUsesNonExemptEncryption: false`), add internal testers, or create
   an external group (that needs a one-off Beta App Review).

Shortcut once configured: `eas build -p ios --profile production --auto-submit`.

## Android (APK / AAB)

- **Installable APK for testers (EAS):** add a profile to `eas.json`:
  `"preview": { "distribution": "internal", "android": { "buildType": "apk" } }`,
  then `eas build -p android --profile preview` and share the download link/QR.
- **Play Store AAB (EAS):** `eas build -p android --profile production` (AAB
  is the default), then `eas submit -p android --latest`. This needs a Google
  Play Console account ($25 one-off) and a service-account JSON key for
  `eas submit`. Upload the first release manually in Play Console.
- **Local build, no EAS:**
  ```bash
  npx expo prebuild --platform android      # generates android/
  cd android
  ./gradlew assembleRelease                 # APK -> app/build/outputs/apk/release/
  ./gradlew bundleRelease                   # AAB -> app/build/outputs/bundle/release/
  ```
  This needs the Android SDK and JDK 17. Configure a release keystore in
  `android/app/build.gradle` before distributing; the template signs release
  builds with the debug key. Keystores are git-ignored (`*.jks`). Don't commit
  them, and don't commit the generated `android/` and `ios/` folders unless you
  want to stop using prebuild.

## Folder layout

```
app/                       Expo Router routes
  _layout.tsx              providers + auth gate (signed out -> (auth), recovery -> new-password)
  reset-password.tsx       deep-link target of the reset email (PKCE code exchange)
  (auth)/                  login, signup, forgot, new-password
  (app)/(tabs)/            Feed (index), Statistics, Calendar, More
  (app)/new/[kind].tsx     start live / log past session (cash | tournament)
  (app)/session/[id].tsx   live view and saved-session detail/edit
  (app)/stack/[id].tsx     stack events + chart (live-tracked cash)
  (app)/stat/[metric].tsx  stat detail: line/bar, Unit/Month/Year/Duration, BB toggle
src/lib/                   framework-free logic (unit-tested in Node)
  types.ts                 domain types (Session, StackEvent, SellAction, Doc, …)
  stats.ts                 per-session + aggregate formulas (port of web)
  metrics.ts               metric registry, formatting, calendar periods, chart series
  domain.ts                start/pause/end/edit/stack operations on the document
  cloud-map.ts             row <-> domain mapping, canonical fingerprints (matches web)
  sync.ts                  CloudStore: cache, pull, optimistic push, realtime, echo guard
  format.ts present.ts range.ts   display helpers
  supabase.ts config.ts    client (AsyncStorage session, PKCE) + public config
src/state/                 React glue: AppProvider (auth + store hooks), prefs
src/ui/                    theme tokens, SVG icons, shared components, rows, banners
tests/                     metrics-parity.test.ts (native vs web on the 40-session seed)
scripts/integration-test.ts  live Supabase contract test
```

## Dependencies

| Package | Why |
|---|---|
| `expo`, `react`, `react-native` | the runtime |
| `expo-router` (+ `react-native-screens`, `react-native-safe-area-context`, `expo-linking`, `expo-constants`) | file-based navigation with typed params and deep links for free; the reset-password link is a plain route. These peers are required by expo-router. |
| `@supabase/supabase-js` | the same client and API the web app uses |
| `@react-native-async-storage/async-storage` | persists the auth session and the offline document cache |
| `react-native-url-polyfill` | supabase-js needs a spec-compliant `URL` on Hermes |
| `expo-crypto` | `randomUUID()` for row ids (the same UUID shape as web) |
| `react-native-svg` | charts and icons drawn by hand, so no chart library and no icon font |
| `expo-splash-screen`, `expo-status-bar` | dark splash and status bar |
| `react-dom`, `react-native-web` | `expo export --platform web` (headless bundle check, browser preview) |
| dev: `typescript`, `@types/*` | type checking |
| dev: `eslint`, `eslint-config-expo` | `expo lint` |
| dev: `tsx` | runs TS tests/scripts on Node without a build step |
| dev: `ws` | WebSocket for realtime in the Node integration test (Node 20 has no global one) |

AsyncStorage over SecureStore for the auth session: Supabase sessions often
exceed SecureStore's ~2 KB value limit on iOS, and the document cache needs
a plain KV store anyway. The tokens are refresh-scoped and RLS-limited.

`npm audit` reports advisories in the Expo/Metro toolchain packages
(`@expo/cli`, `metro*`, `micromatch`, `node-forge`, …). They're the versions
pinned by SDK 57. `npm audit fix --force` would break SDK alignment, so
leave them until the next Expo SDK patch release, then run `npx expo install --fix`.

## What's implemented

- Email/password **auth**: log in, sign up (instant, since confirmation is off), forgot password,
  reset via deep link, set a new password, log out (clears the on-device cache)
- **Feed**: sessions grouped by local month with monthly net totals, LIVE badge, All/Sessions
  segments, month filter (from Calendar), and a banner linking to the running live session on every tab
- **Session logging**: cash and tournament, either live (Start) or after the fact (Log past session),
  with game, stakes (quick chips), buy-in, location, table size, bankroll, group, tournament type and
  name, prize, position and entries. Games, locations and types can be added inline. Future starts and
  ends before starts are rejected.
- **Live tracking**: a timer computed from `start_time` (survives app restarts), live net and hourly
  rate, Pause/Resume (break time excluded from hours), estimated hands (~30/h) until you override,
  rebuys and add-ons for tournaments, End session (cash-out amount, or position and prize)
- **Stack screen** (live-tracked cash): profit chart, reverse-chronological events with running total,
  top-up and cash-out at any time, delete events (the initial buy-in can't be deleted).
  Buy-in is always derived from the stack events.
- **Session detail/edit**: every field editable by tap, delete with confirmation
- **Statistics**: All / Cash games / Tournaments sections with every brief 5.9 row, date-range chips,
  and a gross vs net-of-staking toggle when any tournament has sell actions
- **Stat detail**: line (cumulative) or bar (per bucket) chart, grouped by Unit/Month/Year/Duration,
  with a EUR/BB toggle for cash money metrics
- **Calendar**: All/Month/Year, all 14 metric tabs, a rolling "30 last days" row, months grouped by
  year, and tapping a month opens the Feed filtered to it
- **More**: account email, sync status, currency (synced with web), log out
- **Sync**: optimistic local edits, an offline cache, retry, realtime from other devices, and a refresh
  when the app returns to the foreground

## What's not (yet), use the web app for these

- Filter sheet beyond date range (game/stakes/location/bankroll/group)
- Calendar heatmap grid (5.12), Reports (5.13)
- Bankroll screen and risk of ruin, transactions, Sell Action editor (sell actions created on web
  are respected in all native stats), Top 10, Players/notes, hand histories
- Settings management of games/locations/types beyond adding inline, JSON export/import
- Push notifications, widgets, Apple/Google sign-in
- Not verified on a physical device or simulator: everything here was checked headlessly
  (typecheck, lint, web + iOS + Android bundles, Node tests, live backend test)

### Known behaviour notes

- The brief lists "median" among the statistics, but the web registry has no median formula, so none
  is shipped here either. That keeps both apps reporting the same numbers.
- As on web, an ended session whose hands were only *estimated* stores `hands_count = null` and is
  left out of BB/100. Enter a real hand count to include it.
- Ending a session while paused counts the open pause as break time. The web app drops the open pause
  in that case. Native deliberately does the former and a test covers it.
- The gross/net staking toggle is a per-device preference and isn't synced.
