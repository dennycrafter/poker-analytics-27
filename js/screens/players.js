// Players (brief 5.14): player notes grouped by player, with add / edit /
// delete. Notes sync through user_settings.player_notes; a "player" is the
// set of notes sharing a name (see manage.playersFromNotes).

import { navigate } from '../router.js';
import { getState } from '../store.js';
import { icon } from '../icons.js';
import { esc, toast, openSheet, confirmSheet, textSheet } from '../ui.js';
import { fmtDateShort } from '../format.js';
import { addPlayerNote, updatePlayerNote, deletePlayerNote, renamePlayer } from '../domain.js';
import { playersFromNotes, playerNoteError, playersDirectory, sessionsForPlayer } from '../manage.js';
import { sessionRowHtml } from './feed.js';

// Add (note = null) or edit a player note. `presetName` pre-fills the name.
export function openNoteSheet({ note = null, presetName = '', sessionId = null, onSaved = null } = {}) {
  const names = playersFromNotes(getState().player_notes).map(p => p.name);
  openSheet({
    title: note ? 'Edit player note' : 'Add player note',
    bodyHtml: `
      <label class="field"><span class="field-label">Player</span>
        <input class="input" data-role="name" type="text" list="pa27-players" value="${esc(note ? note.player_name : presetName)}" placeholder="Name or seat">
        <datalist id="pa27-players">${names.map(n => `<option value="${esc(n)}"></option>`).join('')}</datalist></label>
      <label class="field"><span class="field-label">Note</span>
        <textarea class="input" data-role="note" rows="4" placeholder="Tendencies, tells, sizing…">${esc(note ? note.note : '')}</textarea></label>
      <div class="sheet-error" data-role="err" hidden></div>
      <button class="btn-primary" data-act="save">Save</button>
      ${note ? '<button class="btn-danger" data-act="del" style="margin-top:10px">Delete note</button>' : ''}`,
    onMount(sheet, close) {
      const err = sheet.querySelector('[data-role=err]');
      sheet.querySelector('[data-act=save]').addEventListener('click', () => {
        const name = sheet.querySelector('[data-role=name]').value.trim();
        const text = sheet.querySelector('[data-role=note]').value.trim();
        const msg = playerNoteError(name, text);
        if (msg) { err.textContent = msg; err.hidden = false; return; }
        close();
        if (note) { updatePlayerNote(note.id, { player_name: name, note: text }); toast('Note updated'); } else {
          addPlayerNote({ player_name: name, note: text, session_id: sessionId || (note && note.session_id) || null });
          toast('Note added');
        }
        if (onSaved) onSaved(name);
      });
      const del = sheet.querySelector('[data-act=del]');
      if (del) del.addEventListener('click', () => {
        close();
        confirmSheet({
          title: 'Delete note?', message: 'This permanently removes the note.', confirmLabel: 'Delete', danger: true,
          onConfirm() { deletePlayerNote(note.id); toast('Note deleted'); },
        });
      });
      sheet.querySelector(note || presetName ? '[data-role=note]' : '[data-role=name]').focus();
    },
  });
}

export function PlayersScreen(root, doc) {
  // STEP F: the merged directory — note players plus players met at the
  // table (Opponents names from the signed-in user's own sessions).
  const players = playersDirectory(doc);
  root.innerHTML = `
    <div class="screen">
      <header class="topbar">
        <button class="topbtn" data-act="back" aria-label="Back">${icon('back')}</button>
        <h1>Players</h1>
        <button class="topbtn accent" data-act="add" aria-label="Add player note">${icon('plus')}</button>
      </header>
      <div class="list">
        ${players.length ? players.map(p => {
          const sub = p.notes.length
            ? `${p.notes.length} ${p.notes.length === 1 ? 'note' : 'notes'} · ${esc(p.notes[0].note)}`
            : p.lastSeen ? `last seen ${esc(fmtDateShort(new Date(p.lastSeen)))}` : 'no activity yet';
          return `
          <a class="simple-row" href="#/more/players/${encodeURIComponent(p.name)}" data-player="${esc(p.name)}">
            <div class="mid">
              <div class="row-title">${esc(p.name)}</div>
              <div class="row-sub"><span>${p.sessionCount} ${p.sessionCount === 1 ? 'session' : 'sessions'} · ${sub}</span></div>
            </div>
            ${icon('chevron', 'chev')}
          </a>`;
        }).join('') : '<div class="empty-block">No players yet. Opponents you enter on sessions and player notes will show up here. Tap + to write your first note.</div>'}
      </div>
      <div class="spacer-40"></div>
    </div>`;
  root.querySelector('[data-act=back]').addEventListener('click', () => navigate('/more'));
  root.querySelector('[data-act=add]').addEventListener('click', () => openNoteSheet());
}

export function PlayerDetailScreen(root, doc, rawName) {
  let name;
  try { name = decodeURIComponent(rawName); } catch (e) { navigate('/more/players'); return; }
  // STEP F: merged profile — notes plus the sessions that named this player.
  const key = name.trim().toLowerCase();
  const p = playersDirectory(doc).find(x => x.name.toLowerCase() === key);
  if (!p) { navigate('/more/players'); return; }
  const together = sessionsForPlayer(doc, p.name);
  root.innerHTML = `
    <div class="screen">
      <header class="topbar">
        <button class="topbtn" data-act="back" aria-label="Back">${icon('back')}</button>
        <h1>${esc(p.name)}</h1>
        <button class="topbtn" data-act="rename" aria-label="Rename player">${icon('note')}</button>
      </header>
      <div class="list">
        ${p.notes.map(n => `
          <button class="simple-row note-row" data-note="${esc(n.id)}">
            <div class="mid">
              <div class="row-sub"><span>${esc(fmtDateShort(new Date(n.created_at)))}${n.session_id ? ' · from a session' : ''}</span></div>
              <div class="note-text">${esc(n.note)}</div>
            </div>
            ${icon('chevron', 'chev')}
          </button>`).join('')}
      </div>
      ${together.length ? `
        <div class="section-label">Sessions together (${together.length})</div>
        <div class="list">
          ${together.map(s => sessionRowHtml(doc, s)).join('')}
        </div>` : ''}
      <button class="btn-primary" data-act="add">Add note</button>
      <div class="spacer-40"></div>
    </div>`;
  root.querySelector('[data-act=back]').addEventListener('click', () => navigate('/more/players'));
  root.querySelector('[data-act=add]').addEventListener('click', () => openNoteSheet({ presetName: p.name }));
  root.querySelectorAll('[data-note]').forEach(el => el.addEventListener('click', () => {
    const n = getState().player_notes.find(x => x.id === el.dataset.note);
    if (n) openNoteSheet({
      note: n,
      onSaved(newName) { if (newName.toLowerCase() !== p.name.toLowerCase()) navigate('/more/players/' + encodeURIComponent(newName)); },
    });
  }));
  root.querySelector('[data-act=rename]').addEventListener('click', () => textSheet({
    title: 'Rename player', label: 'Name', value: p.name, multiline: false,
    onSave(v) {
      if (!v) { toast('Enter the player name'); return; }
      renamePlayer(p.name, v);
      toast('Player renamed');
      navigate('/more/players/' + encodeURIComponent(v));
    },
  }));
}
