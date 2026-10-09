// Hash-based router (locked decision 3): browser refresh and back work
// everywhere, including mid-live-session.

import { getState } from './store.js';
import { FeedScreen } from './screens/feed.js';
import { StartScreen } from './screens/start.js';
import { LiveScreen } from './screens/live.js';
import { StackScreen } from './screens/stack.js';
import { DetailScreen } from './screens/detail.js';
import { MoreScreen, HandView, NoteView } from './screens/simple.js';
import { CalendarScreen, CalendarGridScreen } from './screens/calendar.js';
import { ReportsScreen, ReportDetailScreen } from './screens/reports.js';
import { StatsScreen, StatDetailScreen } from './screens/stats.js';
import { BankrollScreen, BankrollDetailScreen } from './screens/bankroll.js';
import { SettingsScreen, MasterListScreen } from './screens/settings.js';
import { PlayersScreen, PlayerDetailScreen } from './screens/players.js';
import { Top10Screen } from './screens/top10.js';
import { VarianceScreen } from './screens/variance.js';
import { closeSheets } from './ui.js';

const ROUTES = [
  { re: /^\/feed$/, tab: 'feed', render: (r, d) => FeedScreen(r, d) },
  { re: /^\/stats$/, tab: 'stats', render: (r, d) => StatsScreen(r, d) },
  { re: /^\/stats\/(all|cash|tournament)\/([a-z0-9_]+)$/, tab: 'stats', render: (r, d, m) => StatDetailScreen(r, d, m[1], m[2]) },
  { re: /^\/calendar$/, tab: 'calendar', render: (r, d) => CalendarScreen(r, d) },
  { re: /^\/calendar\/grid$/, tab: 'calendar', render: (r, d) => CalendarGridScreen(r, d) },
  { re: /^\/reports$/, tab: 'reports', render: (r, d) => ReportsScreen(r, d) },
  { re: /^\/reports\/([a-z]+)$/, tab: 'reports', render: (r, d, m) => ReportDetailScreen(r, d, m[1]) },
  { re: /^\/more$/, tab: 'more', render: (r, d) => MoreScreen(r, d) },
  { re: /^\/more\/bankroll$/, tab: 'more', render: (r, d) => BankrollScreen(r, d) },
  { re: /^\/more\/bankroll\/([A-Za-z0-9_-]+)$/, tab: 'more', render: (r, d, m) => BankrollDetailScreen(r, d, m[1]) },
  { re: /^\/more\/settings$/, tab: 'more', render: (r, d) => SettingsScreen(r, d) },
  { re: /^\/more\/settings\/(games|locations|tournament_types|groups)$/, tab: 'more', render: (r, d, m) => MasterListScreen(r, d, m[1]) },
  { re: /^\/more\/top10$/, tab: 'more', render: (r, d) => Top10Screen(r, d) },
  { re: /^\/more\/variance$/, tab: 'more', render: (r, d) => VarianceScreen(r, d) },
  { re: /^\/more\/players$/, tab: 'more', render: (r, d) => PlayersScreen(r, d) },
  { re: /^\/more\/players\/(.+)$/, tab: 'more', render: (r, d, m) => PlayerDetailScreen(r, d, m[1]) },
  { re: /^\/new\/(cash|tournament)$/, tab: 'feed', render: (r, d, m) => StartScreen(r, d, m[1]) },
  { re: /^\/live\/([A-Za-z0-9-]+)\/stack$/, tab: 'feed', render: (r, d, m) => StackScreen(r, d, m[1]) },
  { re: /^\/live\/([A-Za-z0-9-]+)$/, tab: 'feed', render: (r, d, m) => LiveScreen(r, d, m[1]) },
  { re: /^\/session\/([A-Za-z0-9-]+)$/, tab: 'feed', render: (r, d, m) => DetailScreen(r, d, m[1]) },
  { re: /^\/hand\/([A-Za-z0-9-]+)$/, tab: 'feed', render: (r, d, m) => HandView(r, d, m[1]) },
  { re: /^\/note\/([A-Za-z0-9-]+)$/, tab: 'feed', render: (r, d, m) => NoteView(r, d, m[1]) },
];

let cleanups = [];

// Screens register per-render cleanup (tick handlers, listeners).
export function addCleanup(fn) { cleanups.push(fn); }

function runCleanups() {
  for (const fn of cleanups) { try { fn(); } catch (e) { console.error('cleanup failed', e); } }
  cleanups = [];
}

export function currentPath() {
  let h = location.hash.replace(/^#/, '');
  if (!h || h === '/') h = '/feed';
  return h;
}

export function navigate(path) {
  if (currentPath() === path) { renderRoute(); return; }
  location.hash = '#' + path;
}

// Renders the active route. Returns { tab, path } for the shell.
export function renderRoute() {
  runCleanups();
  closeSheets();
  const root = document.getElementById('screen');
  const doc = getState();
  const path = currentPath();
  for (const r of ROUTES) {
    const m = path.match(r.re);
    if (m) {
      r.render(root, doc, m);
      return { tab: r.tab, path };
    }
  }
  FeedScreen(root, doc);
  return { tab: 'feed', path: '/feed' };
}
