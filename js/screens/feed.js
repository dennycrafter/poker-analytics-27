// Feed: month-grouped session list, segmented tabs (ALL/SESSIONS/HANDS/NOTES),
// + menu, live badge. Rows navigate to detail views.

import { navigate } from '../router.js';
import { getState } from '../store.js';
import { icon } from '../icons.js';
import { esc, openSheet } from '../ui.js';
import { getCurrency, fmtMoney, moneyClass, fmtDur, weekdayAbbr, dayNum, monthLabel, fmtClock } from '../format.js';
import { netResult, groupByMonth, playSeconds } from '../stats.js';

export function sessionRowHtml(doc, s) {
  const cur = getCurrency(doc);
  const d = new Date(s.start_time);
  const net = netResult(doc, s);
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
    onMount(sheet) {
      sheet.querySelector('[data-act=cash]').addEventListener('click', () => navigate('/new/cash'));
      sheet.querySelector('[data-act=tournament]').addEventListener('click', () => navigate('/new/tournament'));
      for (const act of ['hand', 'note', 'txn', 'bank']) {
        sheet.querySelector(`[data-act=${act}]`).addEventListener('click', () => {
          // Full management screens arrive in Tier 4.
          document.querySelector('.sheet-backdrop')?.remove();
          openSheet({
            title: 'Coming soon',
            bodyHtml: '<p style="padding:8px 4px;color:var(--text-secondary);font-size:15px">This is built in a later update. Sessions are fully available now.</p>',
          });
        });
      }
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
    const shown = seg === 'all' ? doc.sessions : ended;
    const groups = groupByMonth(shown);
    if (!groups.length) {
      listHtml = '<div class="empty-block">No sessions yet. Tap + to log your first one.</div>';
    } else {
      listHtml = groups.map(g => {
        const total = g.sessions.reduce((a, s) => a + netResult(doc, s), 0);
        return `<div class="month-head"><span>${monthLabel(new Date(g.sessions[0].start_time))}</span>
            <span class="net ${moneyClass(total)}">${fmtMoney(total, cur)}</span></div>` +
          g.sessions.map(s => sessionRowHtml(doc, s)).join('');
      }).join('');
    }
  }

  root.innerHTML = `
    <header class="topbar">
      <button class="topbtn" data-act="filter" aria-label="Filter">${icon('filter')}</button>
      <h1>Feed</h1>
      <button class="topbtn accent" data-act="plus" aria-label="Add session">${icon('plus')}</button>
    </header>
    <div class="segmented" role="tablist">
      ${['all', 'sessions', 'hands', 'notes'].map(k =>
        `<button role="tab" aria-selected="${seg === k}" data-seg="${k}"
          class="${seg === k ? 'active' : ''}">${k.toUpperCase()}</button>`).join('')}
    </div>
    <div class="list">${listHtml}</div>`;

  root.querySelector('[data-act=plus]').addEventListener('click', plusMenu);
  root.querySelector('[data-act=filter]').addEventListener('click', () => {
    openSheet({ title: 'Filter', bodyHtml: '<p style="padding:8px 4px;color:var(--text-secondary);font-size:15px">Filtering arrives with Statistics in the next update.</p>' });
  });
  root.querySelectorAll('.segmented [data-seg]').forEach(btn => {
    btn.addEventListener('click', () => {
      window.__feedSeg = btn.dataset.seg;
      FeedScreen(root, getState());
    });
  });
}
