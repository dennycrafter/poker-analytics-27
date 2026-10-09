// Feed: month-grouped session list, segmented tabs (ALL/SESSIONS/HANDS/NOTES),
// + menu, live badge. Rows navigate to detail views.

import { navigate } from '../router.js';
import { getState } from '../store.js';
import { icon } from '../icons.js';
import { esc, openSheet } from '../ui.js';
import { getCurrency, fmtMoney, moneyClass, fmtDur, weekdayAbbr, dayNum, monthLabel, fmtClock } from '../format.js';
import { sessionNet, groupByMonth, playSeconds } from '../stats.js';
import { stakingMode } from './stats.js';
import { getFilter, applyFilter, isActive } from '../filters.js';
import { filterButtonHtml, filterPillHtml, wireFilter } from './filter.js';
import { openNoteSheet } from './players.js';
import { openTransactionSheet, openNewBankrollSheet } from './bankroll.js';

// Results follow the Statistics staking toggle (formula 1) so a staked
// tournament shows the same number in Feed, Detail, Top 10 and Statistics.
// Cash sessions and unstaked tournaments are identical in both modes.
export function sessionRowHtml(doc, s, netOverride = null) {
  const cur = getCurrency(doc);
  const d = new Date(s.start_time);
  const net = netOverride === null ? sessionNet(doc, s, stakingMode(doc)) : netOverride;
  const game = doc.games.find(g => g.id === s.game_id);
  let title;
  if (s.kind === 'cash') {
    title = `${cur} ${s.small_blind}/${s.big_blind} ${game ? game.name : ''}`;
  } else {
    title = `${cur} ${s.initial_buy_in} ${game ? game.name : ''}`;
  }
  const secs = s.is_live ? playSeconds(s) : s.duration_seconds;
  const loc = doc.locations.find(l => l.id === s.location_id);
  const live = s.is_live ? '<span class="live-badge"><span class="live-dot"></span>LIVE</span>' : '';
  return `<a class="session-row" href="${s.is_live ? '#/live/' + s.id : '#/session/' + s.id}">
    <div class="date-col"><span class="dow">${weekdayAbbr(d)}</span><span class="dnum">${dayNum(d)}</span></div>
    <div class="mid">
      <div class="row-title">${live}${esc(title)}</div>
      <div class="row-sub">
        ${icon('clock')}<span>${fmtDur(secs)}</span>
        <span class="dotsep"></span>${icon('table')}<span>${s.table_size}-max</span>
        ${loc ? `<span class="dotsep"></span>${icon('pin')}<span>${esc(loc.name)}</span>` : ''}
      </div>
    </div>
    <div class="right">
      <span class="net ${moneyClass(net)}">${fmtMoney(net, cur)}</span>
      ${icon('chevron', 'chev')}
    </div>
  </a>`;
}

function handsTabHtml(doc) {
  const rows = doc.hand_histories
    .slice()
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .map(h => {
      const s = doc.sessions.find(x => x.id === h.session_id);
      const when = s ? new Date(s.start_time) : new Date(h.created_at);
      return `<a class="simple-row" href="#/hand/${h.id}">
        <div class="mid">
          <div class="row-title">${esc(h.comment || 'Hand history')}</div>
          <div class="row-sub"><span>${weekdayAbbr(when)} ${dayNum(when)} · ${fmtClock(when)}</span></div>
        </div>
        ${icon('chevron', 'chev')}
      </a>`;
    });
  return rows.length ? rows.join('')
    : '<div class="empty-block">No hand histories yet.</div>';
}

function notesTabHtml(doc) {
  const rows = doc.player_notes
    .slice()
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .map(n => {
      return `<a class="simple-row" href="#/note/${n.id}">
        <div class="mid">
          <div class="row-title">${esc(n.player_name)}</div>
          <div class="row-sub"><span>${esc(n.note)}</span></div>
        </div>
        ${icon('chevron', 'chev')}
      </a>`;
    });
  return rows.length ? rows.join('')
    : '<div class="empty-block">No player notes yet.</div>';
}

function plusMenu() {
  openSheet({
    title: 'Add',
    bodyHtml: [
      ['cash', icon('cash'), 'Cash game'],
      ['tournament', icon('trophy'), 'Tournament'],
      ['hand', icon('hand'), 'Hand history'],
      ['note', icon('note'), 'Player note'],
      ['txn', icon('wallet'), 'Transaction'],
      ['bank', icon('wallet'), 'Bankroll'],
    ].map(([act, ic, label]) =>
      `<button class="sheet-row" data-act="${act}">${ic}<span>${label}</span><span class="icon chev">${icon('chevron')}</span></button>`
    ).join(''),
    onMount(sheet, close) {
      sheet.querySelector('[data-act=cash]').addEventListener('click', () => navigate('/new/cash'));
      sheet.querySelector('[data-act=tournament]').addEventListener('click', () => navigate('/new/tournament'));
      const then = fn => () => { close(); fn(); };
      sheet.querySelector('[data-act=note]').addEventListener('click', then(() => openNoteSheet()));
      sheet.querySelector('[data-act=txn]').addEventListener('click', then(() => openTransactionSheet()));
      sheet.querySelector('[data-act=bank]').addEventListener('click', then(openNewBankrollSheet));
      // Hand-history entry is not in scope yet (brief 5.1 allows "coming soon").
      sheet.querySelector('[data-act=hand]').addEventListener('click', then(() => openSheet({
        title: 'Coming soon',
        bodyHtml: '<p style="padding:8px 4px;color:var(--text-secondary);font-size:15px">Adding hand histories is built in a later update.</p>',
      })));
    },
  });
}

export function FeedScreen(root, doc) {
  const seg = window.__feedSeg || 'sessions';
  const cur = getCurrency(doc);
  const ended = doc.sessions.filter(s => !s.is_live);

  let listHtml = '';
  if (seg === 'hands') {
    listHtml = handsTabHtml(doc);
  } else if (seg === 'notes') {
    listHtml = notesTabHtml(doc);
  } else {
    // Feed keeps its own filter (brief 9). Live sessions stay visible on ALL
    // so the in-progress session is never hidden by a filter.
    const f = getFilter(doc, 'feed');
    const base = seg === 'all' ? doc.sessions : ended;
    const shown = base.filter(s => s.is_live || applyFilter(f, [s]).length);
    const groups = groupByMonth(shown);
    if (!groups.length) {
      listHtml = base.length && isActive(f)
        ? '<div class="empty-block">No sessions match this filter.</div>'
        : '<div class="empty-block">No sessions yet. Tap + to log your first one.</div>';
    } else {
      listHtml = groups.map(g => {
        const mode = stakingMode(doc);
        const total = g.sessions.reduce((a, s) => a + sessionNet(doc, s, mode), 0);
        return `<div class="month-head"><span>${monthLabel(new Date(g.sessions[0].start_time))}</span>
            <span class="net ${moneyClass(total)}">${fmtMoney(total, cur)}</span></div>` +
          g.sessions.map(s => sessionRowHtml(doc, s)).join('');
      }).join('');
    }
  }

  root.innerHTML = `
    <header class="topbar">
      ${filterButtonHtml(doc, 'feed')}
      <h1>Feed</h1>
      <button class="topbtn accent" data-act="plus" aria-label="Add session">${icon('plus')}</button>
    </header>
    ${filterPillHtml(doc, 'feed')}
    <div class="segmented" role="tablist">
      ${['all', 'sessions', 'hands', 'notes'].map(k =>
        `<button role="tab" aria-selected="${seg === k}" data-seg="${k}"
          class="${seg === k ? 'active' : ''}">${k.toUpperCase()}</button>`).join('')}
    </div>
    <div class="list">${listHtml}</div>`;

  root.querySelector('[data-act=plus]').addEventListener('click', plusMenu);
  wireFilter(root, 'feed');
  root.querySelectorAll('.segmented [data-seg]').forEach(btn => {
    btn.addEventListener('click', () => {
      window.__feedSeg = btn.dataset.seg;
      FeedScreen(root, getState());
    });
  });
}
