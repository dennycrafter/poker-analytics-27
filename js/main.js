// App shell: seeds the store, renders the persistent frame (live banner,
// screen container, bottom tab bar), wires routing and the 1s tick.

import { initStore, subscribe, getState } from './store.js';
import { buildSeed } from './seed.js';
import { renderRoute } from './router.js';
import { tick } from './tick.js';
import { icon } from './icons.js';
import { getLiveSession } from './domain.js';
import { fmtTimer } from './format.js';
import { playSeconds } from './stats.js';

const TABS = [
  { id: 'feed', label: 'Feed', icon: 'feed', path: '/feed' },
  { id: 'stats', label: 'Stats', icon: 'stats', path: '/stats' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar', path: '/calendar' },
  { id: 'reports', label: 'Reports', icon: 'reports', path: '/reports' },
  { id: 'more', label: 'More', icon: 'more', path: '/more' },
];

function liveBannerHtml(live) {
  const secs = playSeconds(live);
  const t = fmtTimer(secs);
  return `<a class="live-banner" href="#/live/${live.id}">
    <span class="live-dot"></span> LIVE
    <span class="live-banner-timer">${t.main}<span class="sec">${t.sec}</span></span>
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
}

function paintBannerAndTabs() {
  const slot = document.getElementById('live-banner-slot');
  if (!slot) return;
  const live = getLiveSession(getState());
  slot.innerHTML = live ? liveBannerHtml(live) : '';
  const { tab } = renderRoute();
  document.querySelectorAll('#tabbar .tab').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
}

initStore(buildSeed);
renderShell();

subscribe(() => {
  // Full re-render on data change (routes re-render; tick regions repaint themselves).
  paintBannerAndTabs();
});

// Re-render on every hash change.
window.addEventListener('hashchange', () => { paintBannerAndTabs(); });

// 1s tick: refresh live regions (banner timer, live screen values).
setInterval(tick, 1000);

paintBannerAndTabs();
