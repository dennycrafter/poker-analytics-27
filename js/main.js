// App shell: gates the app behind Supabase auth, boots cloud sync for the
// signed-in user, renders the persistent frame (live banner, screen
// container, bottom tab bar), wires routing and the 1s tick.

import { subscribe, getState, startSync, stopSync, whenSaved, replaceDoc, genId, onSyncStatus } from './store.js';
import { supabase } from './supabase-client.js';
import { renderRoute, currentPath, routeTab, resetRouteHistory } from './router.js';
import { skeletonScreen } from './skeleton.js';
import { tick, onTick } from './tick.js';
import { icon } from './icons.js';
import { getLiveSession } from './domain.js';
import { fmtTimer } from './format.js';
import { playSeconds } from './stats.js';
import { AuthScreen } from './screens/auth.js';
import { isSheetOpen, confirmSheet, toast } from './ui.js';
import { legacyCounts, legacyHasRecords, legacyToDoc } from './cloud-map.js';

const TABS = [
  { id: 'feed', label: 'Feed', icon: 'feed', path: '/feed' },
  { id: 'stats', label: 'Stats', icon: 'stats', path: '/stats' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar', path: '/calendar' },
  { id: 'reports', label: 'Reports', icon: 'reports', path: '/reports' },
  { id: 'more', label: 'More', icon: 'more', path: '/more' },
];

// Tier 1/2 localStorage document, offered once for migration into the cloud.
const LEGACY_KEY = 'poker-analytics-27:v1';
const LEGACY_DONE_KEY = 'pa27:legacy-migrated';

let currentUserId = null;
let shellMounted = false;
let pendingRemote = false;
// True between sign-in and the first usable document (device cache or the
// first cloud pull). Screens would otherwise render the blank document and
// flash "No sessions yet" at a user who has hundreds.
let booting = false;

function liveBannerHtml(live) {
  const t = fmtTimer(playSeconds(live));
  return `<a class="live-banner" href="#/live/${live.id}">
    <span class="live-dot"></span> LIVE
    <span class="live-banner-timer" data-role="banner-timer">${t.main}<span class="sec">${t.sec}</span></span>
    <span class="live-banner-cta">Resume ${icon('chevron')}</span>
  </a>`;
}

function renderShell() {
  const root = document.getElementById('app');
  root.innerHTML = `<div id="phone">
    <div id="live-banner-slot"></div>
    <main id="screen" tabindex="-1"></main>
    <nav id="tabbar" aria-label="Main navigation">
      <span class="tab-indicator" aria-hidden="true"></span>
      ${TABS.map(t =>
        `<a class="tab" data-tab="${t.id}" href="#${t.path}">
          ${icon(t.icon)}<span>${t.label}</span>
        </a>`).join('')}
    </nav>
  </div>`;
  shellMounted = true;
}

function paintBanner() {
  const slot = document.getElementById('live-banner-slot');
  if (!slot) return;
  const live = getLiveSession(getState());
  // The live screen itself already shows the timer; the banner links back to it.
  const onLive = live && currentPath().startsWith('/live/');
  slot.innerHTML = live && !onLive ? liveBannerHtml(live) : '';
}

// Highlights the active tab and slides the indicator bar under it.
function paintTabs(tab) {
  const idx = Math.max(0, TABS.findIndex(t => t.id === tab));
  document.querySelectorAll('#tabbar .tab').forEach(el => {
    const on = el.dataset.tab === tab;
    el.classList.toggle('active', on);
    if (on) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  });
  const bar = document.querySelector('#tabbar .tab-indicator');
  if (bar) bar.style.transform = `translateX(${idx * 100}%)`;
}

function paintSkeleton() {
  const tab = routeTab();
  document.getElementById('screen').innerHTML = skeletonScreen(tab);
  paintTabs(tab);
}

function paintBannerAndTabs() {
  if (!shellMounted) return;
  if (booting) { paintSkeleton(); return; }
  pendingRemote = false;
  paintBanner();
  const { tab } = renderRoute();
  paintTabs(tab);
}

// A remote change must never wipe what the user is in the middle of: an open
// sheet, a half-filled start form, or a focused input. Those renders wait
// (the banner still updates) and run as soon as the user is done.
function userIsEditing() {
  const a = document.activeElement;
  const typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT');
  return isSheetOpen() || typing || currentPath().startsWith('/new/');
}

subscribe((_doc, { source }) => {
  // Any delivered document (cache paint or first pull) ends the skeleton.
  booting = false;
  if (source === 'remote' && userIsEditing()) {
    pendingRemote = true;
    paintBanner();
    return;
  }
  paintBannerAndTabs();
});

window.addEventListener('hashchange', () => { if (currentUserId) paintBannerAndTabs(); });

// Banner timer ticks on its own (it is computed from start_time and pauses in
// the row, so a session started on another device runs here too).
onTick(() => {
  const el = document.querySelector('[data-role=banner-timer]');
  const live = getLiveSession(getState());
  if (el && live) {
    const t = fmtTimer(playSeconds(live));
    el.innerHTML = `${t.main}<span class="sec">${t.sec}</span>`;
  }
  if (pendingRemote && !userIsEditing()) paintBannerAndTabs();
});
setInterval(tick, 1000);

// A write the server rejected is rolled back to server state; tell the user
// instead of letting the change silently disappear.
onSyncStatus(s => {
  if (s.state === 'error') toast('A change could not be saved and was undone.', { tone: 'error' });
});

// --- legacy migration -------------------------------------------------------

function readLegacy() {
  try {
    return JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
  } catch (e) {
    console.error('migration: unreadable local data', e);
    return null;
  }
}

function offerMigration(uid) {
  if (localStorage.getItem(LEGACY_DONE_KEY) === uid) return;
  const legacy = readLegacy();
  if (!legacyHasRecords(legacy)) return;
  const c = legacyCounts(legacy);
  confirmSheet({
    title: 'Move local data to your account?',
    message: `This device has ${c.sessions} sessions, ${c.transactions} transactions, ${c.notes} player notes and ${c.hands} hand histories saved locally. Upload them to your account so they sync everywhere.`,
    confirmLabel: 'Migrate local data',
    onConfirm: async () => {
      replaceDoc(legacyToDoc(legacy, genId));
      const ok = await whenSaved(30000);
      if (!ok) {
        // Leave the legacy-done flag unset so the offer returns next sign-in.
        toast('Some local data could not be uploaded; the original copy stays on this device.');
        return;
      }
      localStorage.setItem(LEGACY_DONE_KEY, uid);
      toast(`Migrated ${c.sessions} sessions`);
    },
  });
}

// --- auth lifecycle ---------------------------------------------------------

function showAuth(mode = 'login') {
  shellMounted = false;
  AuthScreen(document.getElementById('app'), { mode });
}

async function enterApp(user) {
  if (currentUserId === user.id) return;
  currentUserId = user.id;
  resetRouteHistory();
  renderShell();
  // Skeleton until data exists. A device cache ends it instantly: startSync
  // notifies with the cached document before its cloud pull (see subscribe).
  booting = true;
  paintSkeleton();
  try {
    const { cloudEmpty } = await startSync(user.id);
    if (currentUserId !== user.id) return;
    booting = false;
    paintBannerAndTabs();
    if (cloudEmpty) offerMigration(user.id);
  } catch (e) {
    console.error('sync: initial load failed', e);
    booting = false;
    paintBannerAndTabs();
    toast('Could not load your data. Check your connection.', { tone: 'error' });
  }
}

function leaveApp() {
  currentUserId = null;
  booting = false;
  resetRouteHistory();
  stopSync();
  showAuth();
}

supabase.auth.onAuthStateChange((event, session) => {
  // Defer: supabase-js forbids awaiting its own calls inside this callback.
  setTimeout(() => {
    if (event === 'PASSWORD_RECOVERY') { currentUserId = null; stopSync(); showAuth('recovery'); return; }
    if (session && session.user) enterApp(session.user);
    else if (event === 'SIGNED_OUT' || event === 'INITIAL_SESSION') leaveApp();
  }, 0);
});
