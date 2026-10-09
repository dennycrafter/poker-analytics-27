// More menu (brief 5.14) plus the read views behind the Feed HANDS / NOTES
// tabs. A note's Edit button opens the shared player-note sheet.

import { navigate } from '../router.js';
import { getState } from '../store.js';
import { icon } from '../icons.js';
import { esc, toast, confirmSheet } from '../ui.js';
import { currentUser, signOut } from '../account.js';
import { fmtDateShort, fmtClock } from '../format.js';
import { openNoteSheet } from './players.js';

export function MoreScreen(root) {
  const rows = [
    { icon: 'wallet', label: 'Bankroll', to: '/more/bankroll' },
    { icon: 'gear', label: 'Settings', to: '/more/settings' },
    { icon: 'trophy', label: 'Top 10', to: '/more/top10' },
    { icon: 'users', label: 'Players', to: '/more/players' },
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
          <a class="field-row" href="#${r.to}" data-row="${r.label}">
            <span class="field-name row-icon">${icon(r.icon)}${r.label}</span>
            <span class="field-value">${icon('chevron', 'chev')}</span>
          </a>`).join('')}
      </div>
      <div class="section-label account-label">Account</div>
      <div class="rows">
        <div class="field-row" data-row="account">
          <span class="field-name">Signed in as</span>
          <span class="field-value" data-role="email">…</span>
        </div>
      </div>
      <button class="btn-danger" data-act="signout">Sign out</button>
    </div>`;
  currentUser()
    .then(u => {
      const el = root.querySelector('[data-role=email]');
      if (el) el.textContent = u ? u.email : '--';
    })
    .catch(e => console.error('more: could not read account', e));
  root.querySelector('[data-act=signout]').addEventListener('click', () => {
    confirmSheet({
      title: 'Sign out?',
      message: 'Your data stays in your account. Sign in again on any device to see it.',
      confirmLabel: 'Sign out',
      danger: true,
      onConfirm: async () => {
        const err = await signOut();
        if (err) toast(err);
      },
    });
  });
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
        <button class="topbtn accent" data-act="edit" aria-label="Edit note">${icon('note')}</button>
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
  root.querySelector('[data-act=edit]').addEventListener('click', () => openNoteSheet({ note: n }));
}
