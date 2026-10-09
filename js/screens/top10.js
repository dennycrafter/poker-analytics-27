// Top 10 (brief 5.14): best and worst ten ended sessions. Results follow the
// Statistics staking preference so the numbers match the Statistics tab.

import { navigate } from '../router.js';
import { icon } from '../icons.js';
import { topSessions } from '../rankings.js';
import { stakingMode } from './stats.js';
import { sessionRowHtml } from './feed.js';

const KEY = 'pa27.top10.which';

function currentWhich() {
  try { return localStorage.getItem(KEY) === 'worst' ? 'worst' : 'best'; } catch (e) { return 'best'; }
}

function setWhich(v) {
  try { localStorage.setItem(KEY, v); } catch (e) { console.error('top10: could not save tab', e); }
}

export function Top10Screen(root, doc) {
  const which = currentWhich();
  const mode = stakingMode(doc);
  const list = topSessions(doc, which, 10, mode);
  root.innerHTML = `
    <div class="screen">
      <header class="topbar">
        <button class="topbtn" data-act="back" aria-label="Back">${icon('back')}</button>
        <h1>Top 10</h1>
        <span class="topbtn" style="visibility:hidden"></span>
      </header>
      <div class="segmented" role="tablist" style="padding-left:0;padding-right:0">
        ${[['best', 'Best'], ['worst', 'Worst']].map(([k, l]) =>
          `<button role="tab" data-which="${k}" aria-selected="${which === k}" class="${which === k ? 'active' : ''}">${l}</button>`).join('')}
      </div>
      <p class="hint top10-note">By net result${mode === 'net' ? ' (net of staking)' : ' (gross)'} · ties go to the more recent session</p>
      <div class="list top10-list">
        ${list.length ? list.map((x, i) => `
          <div class="top10-item"><span class="top10-rank" aria-label="Rank ${i + 1}">${i + 1}</span>${sessionRowHtml(doc, x.s, x.net)}</div>`).join('')
          : '<div class="empty-state"><p>Play a session to see your stats.</p></div>'}
      </div>
      <div class="spacer-40"></div>
    </div>`;
  root.querySelector('[data-act=back]').addEventListener('click', () => navigate('/more'));
  root.querySelectorAll('[data-which]').forEach(b => b.addEventListener('click', () => {
    setWhich(b.dataset.which);
    Top10Screen(root, doc);
  }));
}
