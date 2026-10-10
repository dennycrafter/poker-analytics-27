// Poker Analytics 27 service worker (STEP C): installable, app-shell offline.
//
// What it does:
//   - precaches the app shell (index.html, css, every js module, icons) into a
//     cache named after VERSION, and drops older caches on activate;
//   - same-origin static assets: cache-first (falls back to network and
//     caches the result, so a module added after this list still works
//     offline once it has loaded online);
//   - navigations: network-first, falling back to the cached shell offline.
// What it never does:
//   - touch Supabase / API / auth traffic. Those requests are not intercepted
//     at all, so the browser handles them exactly as without a worker. Offline
//     DATA sync is STEP D; offline, the shell loads but data calls still fail.
//
// Deploys: bump VERSION whenever any shell file changes. Static assets are
// served cache-first, so without a bump returning visitors keep the old files.

const VERSION = 'pa27-2026-10-10-it5-2';
const CACHE = `pa27-shell-${VERSION}`;

// Paths are relative to this file, so the app also works under a sub-path.
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/styles.css',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-192.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'js/account.js',
  'js/backup.js',
  'js/bankroll.js',
  'js/charts/svg.js',
  'js/cloud-map.js',
  'js/config.js',
  'js/csv-export.js',
  'js/csv-import.js',
  'js/dates.js',
  'js/desktop.js',
  'js/domain.js',
  'js/equity-state.js',
  'js/equity-worker.js',
  'js/equity.js',
  'js/filters.js',
  'js/format.js',
  'js/hours.js',
  'js/icons.js',
  'js/idb.js',
  'js/import-ai.js',
  'js/import-smart.js',
  'js/inference.js',
  'js/layout.js',
  'js/main.js',
  'js/manage.js',
  'js/metrics.js',
  'js/motion.js',
  'js/pokernow-import.js',
  'js/pwa.js',
  'js/rankings.js',
  'js/reports.js',
  'js/router.js',
  'js/screens/auth.js',
  'js/screens/bankroll.js',
  'js/screens/calendar.js',
  'js/screens/detail.js',
  'js/screens/drill.js',
  'js/screens/equity.js',
  'js/screens/feed.js',
  'js/screens/filter.js',
  'js/screens/import.js',
  'js/screens/live.js',
  'js/screens/picker.js',
  'js/screens/players.js',
  'js/screens/reports.js',
  'js/screens/sell.js',
  'js/screens/settings.js',
  'js/screens/simple.js',
  'js/screens/stack.js',
  'js/screens/start.js',
  'js/screens/stats.js',
  'js/screens/top10.js',
  'js/screens/variance.js',
  'js/seed.js',
  'js/session-math.js',
  'js/skeleton.js',
  'js/staking.js',
  'js/stats.js',
  'js/store.js',
  'js/supabase-client.js',
  'js/tick.js',
  'js/ui.js',
  'js/variance-cash.js',
  'js/variance-tour.js',
  'js/variance.js',
  'js/year-sim.js',
  'js/vendor/supabase.js',
  'js/vendor/xlsx.full.min.js',
];

// Never-cache guard. Anything that is data, auth or realtime goes straight to
// the network untouched: the Supabase project host (REST, auth, realtime,
// storage, functions) and any same-origin API-style path a proxy might add.
const API_HOST_RE = /(^|\.)supabase\.(co|in|net)$/i;
const API_PATH_RE = /^\/(rest|auth|realtime|storage|functions|graphql|api)\/v?\d*/i;

function isApiRequest(url) {
  return API_HOST_RE.test(url.hostname) || API_PATH_RE.test(url.pathname);
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: 'reload' bypasses the HTTP cache so a new VERSION gets new bytes.
    await cache.addAll(SHELL.map(p => new Request(p, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('pa27-shell-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

const shellUrl = () => new URL('index.html', self.registration.scope).href;

async function networkFirstNavigation(request) {
  try {
    const res = await fetch(request);
    // Keep the offline shell current with whatever the server just served.
    if (res.ok && res.type === 'basic') {
      const cache = await caches.open(CACHE);
      await cache.put(shellUrl(), res.clone());
    }
    return res;
  } catch (err) {
    const cached = await caches.match(shellUrl());
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: false });
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok && res.type === 'basic') {
    const cache = await caches.open(CACHE);
    await cache.put(request, res.clone());
  }
  return res;
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Cross-origin (Supabase, CDNs) and API paths: do not call respondWith, so
  // the request is never intercepted, cached or answered from cache.
  if (url.origin !== self.location.origin || isApiRequest(url)) return;
  if (request.mode === 'navigation') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  event.respondWith(cacheFirst(request));
});
