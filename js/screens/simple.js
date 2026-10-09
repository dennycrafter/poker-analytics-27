// Tier-1 screens that are not the core loop yet: Statistics / Calendar /
// Reports show their section-8 empty states, More lists its rows with
// "coming soon" behavior, and HandView / NoteView give seeded hand
// histories and player notes a basic read view (full management in Tier 4).

import { navigate } from '../router.js';
import { getState } from '../store.js';
import { icon } from '../icons.js';
import { esc, toast } from '../ui.js';
import { fmtDateShort, fmtClock } from '../format.js';

const EMPTY = {
  '/stats': 'Play a session to see your stats.',
  '/calendar': 'Play a session to see your stats.',
  '/reports': 'Log at least 5 sessions to unlock reports.',
};

function emptyTabHtml(title, path) {
  return `
    <header class="topbar">
      <span class="topbtn" style="visibility:hidden"></span>
      <h1>${title}</h1>
      <span class="topbtn" style="visibility:hidden"></span>
    </header>
    <div class="empty-state">${esc(EMPTY[path] || 'Nothing here yet.')}</div>`;
}

export function StatsScreen(root, doc) { root.innerHTML = `<div class="screen">${emptyTabHtml('Statistics', '/stats')}</div>`; }
export function CalendarScreen(root, doc) { root.innerHTML = `<div class="screen">${emptyTabHtml('Calendar', '/calendar')}</div>`; }
export function ReportsScreen(root, doc) { root.innerHTML = `<div class="screen">${emptyTabHtml('Reports', '/reports')}</div>`; }

export function MoreScreen(root) {
  const rows = [
    { icon: 'wallet', label: 'Bankroll', soon: true },
    { icon: 'gear', label: 'Settings', soon: true },
    { icon: 'trophy', label: 'Top 10', soon: true },
    { icon: 'note', label: 'Players', soon: true },
  ];
  root.innerHTML = `
    <div class="screen">
      <header class="topbar">
        <span class="topbtn" style="visibility:hidden"></span>
        <h1>More</h1>
        <span class="topbtn" style="visibility:hidden"></span>
      </header>
      <div class="rows">
        ${rows.map(r => `
          <div class="field-row" data-row="${r.label}">
            <span class="field-name row-icon">${icon(r.icon)}${r.label}</span>
            <span class="field-value">${r.soon ? '<span class="hint">coming soon</span>' : ''}${icon('chevron', 'chev')}</span>
          </div>`).join('')}
      </div>
    </div>`;
  for (const r of rows) {
    root.querySelector(`[data-row="${r.label}"]`).addEventListener('click', () => {
      toast(`${r.label} arrives in a later update`);
    });
  }
}

// Read-only views reachable from the Feed HANDS / NOTES tabs.
export function HandView(root, doc, handId) {
  const h = getState().hand_histories.find(x => x.id === handId);
  if (!h) { navigate('/feed'); return; }
  const s = getState().sessions.find(x => x.id === h.session_id);
  const when = s ? new Date(s.start_time) : new Date(h.created_at);
  root.innerHTML = `
    <div class="modal-screen">
      <header class="topbar">
        <button class="topbtn" data-act="back" aria-label="Back">${icon('back')}</button>
        <h1>Hand history</h1>
        <span class="topbtn" style="visibility:hidden"></span>
      </header>
      <div class="form">
        <div class="section-label">${esc(fmtDateShort(when))} ${esc(fmtClock(when))}${h.comment ? ' · ' + esc(h.comment) : ''}</div>
        <pre class="raw-text">${esc(h.raw_text || '')}</pre>
        <div class="spacer-40"></div>
      </div>
    </div>`;
  root.querySelector('[data-act=back]').addEventListener('click', () => navigate('/feed'));
}

export function NoteView(root, doc, noteId) {
  const n = getState().player_notes.find(x => x.id === noteId);
  if (!n) { navigate('/feed'); return; }
  const when = new Date(n.created_at);
  root.innerHTML = `
    <div class="modal-screen">
      <header class="topbar">
        <button class="topbtn" data-act="back" aria-label="Back">${icon('back')}</button>
        <h1>Player note</h1>
        <span class="topbtn" style="visibility:hidden"></span>
      </header>
      <div class="form">
        <div class="live-card">
          <div class="live-title">${esc(n.player_name)}</div>
          <div class="section-label">${esc(fmtDateShort(when))} ${esc(fmtClock(when))}</div>
        </div>
        <div class="note-body">${esc(n.note || '')}</div>
        <div class="spacer-40"></div>
      </div>
    </div>`;
  root.querySelector('[data-act=back]').addEventListener('click', () => navigate('/feed'));
}
