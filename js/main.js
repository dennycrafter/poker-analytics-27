// App shell: gates the app behind Supabase auth, boots cloud sync for the
// signed-in user, renders the persistent frame (live banner, screen
// container, bottom tab bar), wires routing and the 1s tick.

import { subscribe, getState, startSync, stopSync, whenSaved, replaceDoc, genId, onSyncStatus } from './store.js';
import { supabase } from './supabase-client.js';
import { renderRoute, currentPath } from './router.js';
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

function paintBannerAndTabs() {
  if (!shellMounted) return;
  pendingRemote = false;
  paintBanner();
  const { tab } = renderRoute();
  document.querySelectorAll('#tabbar .tab').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
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
  if (s.state === 'error') toast('A change could not be saved and was undone.');
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
  renderShell();
  paintBannerAndTabs();
  try {
    const { cloudEmpty } = await startSync(user.id);
    if (currentUserId !== user.id) return;
    paintBannerAndTabs();
    if (cloudEmpty) offerMigration(user.id);
  } catch (e) {
    console.error('sync: initial load failed', e);
    toast('Could not load your data. Check your connection.');
  }
}

function leaveApp() {
  currentUserId = null;
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
