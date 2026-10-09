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
import { closeSheets } from './ui.js';
import { transitionFor } from './motion.js';

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

// Which tab a path belongs to, without rendering it (shell skeletons use this).
export function routeTab(path = currentPath()) {
  const r = ROUTES.find(x => x.re.test(path));
  return r ? r.tab : 'feed';
}

let lastPath = null;
let lastTab = null;

function animateEntrance(root, kind) {
  const el = root.firstElementChild;
  if (!el) return;
  // Animate the screen element itself, never #screen: a transform on #screen
  // would become the containing block for the fixed modal screens.
  el.classList.add('route-enter', `route-${kind}`);
  el.addEventListener('animationend', () => el.classList.remove('route-enter', `route-${kind}`), { once: true });
}

// After a navigation, move focus to the new screen so keyboard and
// screen-reader users start at its top instead of on a vanished control.
function focusNewScreen(root) {
  if (document.querySelector('.sheet-backdrop')) return; // a screen opened a sheet on mount
  const a = document.activeElement;
  if (a && root.contains(a) && a !== root) return; // the screen focused an input itself
  root.focus({ preventScroll: true });
}

// Renders the active route. Returns { tab, path } for the shell.
export function renderRoute() {
  runCleanups();
  closeSheets();
  const root = document.getElementById('screen');
  const doc = getState();
  const path = currentPath();
  let match = null;
  for (const r of ROUTES) {
    const m = path.match(r.re);
    if (m) { match = { r, m }; break; }
  }
  const tab = match ? match.r.tab : 'feed';
  const shownPath = match ? path : '/feed';
  if (match) match.r.render(root, doc, match.m);
  else FeedScreen(root, doc);

  const kind = transitionFor(lastPath, shownPath, lastTab, tab);
  const navigated = lastPath !== null && lastPath !== shownPath;
  lastPath = shownPath;
  lastTab = tab;
  if (kind) animateEntrance(root, kind);
  if (navigated) focusNewScreen(root);
  return { tab, path: shownPath };
}

// Sign-out / user switch: the next render is a first paint again.
export function resetRouteHistory() { lastPath = null; lastTab = null; }
