// Settings (brief 5.16): currency; manage Games / Locations / Tournament
// types / Groups (add, rename, delete when unused); Export JSON; Import JSON;
// Load demo data. Currency, master data and notes sync via user_settings;
// sessions and transactions via their own tables — all through the store.

import { navigate } from '../router.js';
import { getState, replaceDoc, genId, whenSaved, getSyncStatus } from '../store.js';
import { icon } from '../icons.js';
import { esc, toast, openSheet, confirmSheet, textSheet, selectSheet } from '../ui.js';
import { getCurrency } from '../format.js';
import { setCurrency, addMasterItem, renameMasterItem, deleteMasterItem, getLiveSession } from '../domain.js';
import { MASTER_META, CURRENCIES, masterUsage, masterNameError, masterDeleteError, currencyError } from '../manage.js';
import { exportPayload, exportFilename, parseImport, demoDoc } from '../backup.js';
import { sessionsCsv, transactionsCsv, csvExportFilename } from '../csv-export.js';

const MANAGED = ['games', 'locations', 'tournament_types', 'groups'];

function header(title, back) {
  return `<header class="topbar">
    <button class="topbtn" data-act="back" aria-label="Back">${icon('back')}</button>
    <h1>${esc(title)}</h1>
    <span class="topbtn" style="visibility:hidden"></span>
  </header>`;
}

function row(key, label, value) {
  return `<button class="field-row" data-row="${esc(key)}">
    <span class="field-name">${esc(label)}</span>
    <span class="field-value">${value}${icon('chevron', 'chev')}</span>
  </button>`;
}

function pickCurrency() {
  const cur = getCurrency(getState());
  const opts = [...new Set([cur, ...CURRENCIES])].map(c => ({ id: c, name: c }));
  selectSheet({
    title: 'Currency', options: opts, selectedId: cur, allowNone: false, addPlaceholder: 'Other code',
    onSave(sel) {
      const code = String(sel.newName || sel.id || '').trim().toUpperCase();
      const err = currencyError(code);
      if (err) { toast(err); return; }
      setCurrency(code);
      toast(`Currency set to ${code}`);
    },
  });
}

function downloadJson(doc) {
  const blob = new Blob([JSON.stringify(exportPayload(doc), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = exportFilename();
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Exported ${doc.sessions.length} sessions`);
}

// CSV exports (STEP E): same headers the importer maps, so a round trip works.
function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportSessionsCsv() {
  const doc = getState();
  const csv = sessionsCsv(doc);
  if (!csv) { toast('No ended sessions to export yet'); return; }
  downloadText(csvExportFilename('sessions'), csv, 'text/csv');
  toast(`Exported ${sessionsCount(doc)} ended session${sessionsCount(doc) === 1 ? '' : 's'}`);
}

function exportTxnsCsv() {
  const doc = getState();
  const csv = transactionsCsv(doc);
  if (!csv) { toast('No bankroll transactions to export yet'); return; }
  downloadText(csvExportFilename('transactions'), csv, 'text/csv');
  toast('Exported bankroll transactions');
}

function sessionsCount(doc) {
  const live = getLiveSession(doc);
  return doc.sessions.length - (live ? 1 : 0);
}

// Apply a whole replacement document (import / demo reset) and wait for the
// cloud to confirm, so the toast reflects what was actually saved. A rejected
// replace is rolled back by the store, so the honest message is "restored".
async function applyReplacement(next, okMsg) {
  replaceDoc(next);
  const ok = await whenSaved(30000);
  if (ok) toast(okMsg);
  else if (getSyncStatus().state === 'error') toast('The server rejected this import. Your previous data was restored.', { tone: 'error' });
  else toast('Saved on this device; some changes are still syncing to your account.');
}

function importFile(file) {
  const reader = new FileReader();
  reader.onerror = () => { console.error('import: read failed', reader.error); toast('Could not read that file'); };
  reader.onload = () => {
    const res = parseImport(String(reader.result || ''), genId);
    if (!res.ok) { toast(res.error); return; }
    const c = res.counts;
    confirmSheet({
      title: 'Replace your data?',
      message: `Import ${c.sessions} sessions, ${c.transactions} transactions, ${c.notes} player notes and ${c.hands} hand histories. This REPLACES everything in your account on every device. Export first if you want a backup.`,
      confirmLabel: 'Import and replace', danger: true,
      onConfirm: () => applyReplacement(res.doc, `Imported ${c.sessions} sessions`),
    });
  };
  reader.readAsText(file);
}

function resetDemo() {
  if (getLiveSession(getState())) { toast('End the live session before loading demo data'); return; }
  confirmSheet({
    title: 'Load demo data?',
    message: 'This REPLACES all sessions, transactions, notes and settings in your account with the demo dataset (about 40 sessions). Export first if you want to keep your data.',
    confirmLabel: 'Load demo', danger: true,
    onConfirm: () => applyReplacement(demoDoc(Date.now(), genId), 'Demo data loaded'),
  });
}

export function SettingsScreen(root, doc) {
  const cur = getCurrency(doc);
  root.innerHTML = `
    <div class="screen">
      ${header('Settings')}
      <div class="section-label" style="padding-left:0">General</div>
      <div class="rows" style="padding:0">${row('currency', 'Currency', esc(cur))}</div>
      <div class="section-label" style="padding-left:0">Manage</div>
      <div class="rows" style="padding:0">
        ${MANAGED.map(k => row('list:' + k, MASTER_META[k].title, `<span class="hint">${(doc[k] || []).length}</span>`)).join('')}
        ${row('bankrolls', 'Bankrolls', `<span class="hint">${doc.bankrolls.length}</span>`)}
      </div>
      <div class="section-label" style="padding-left:0">Data</div>
      <div class="rows" style="padding:0">
        ${row('export', 'Export all data (JSON)', '')}
        ${row('export-csv', 'Export sessions (CSV)', '')}
        ${row('export-txns', 'Export bankroll (CSV)', '')}
        ${row('import', 'Import JSON', '')}
        ${row('import-csv', 'Import CSV / PokerNow', '')}
        ${row('reset', 'Load demo data', '')}
      </div>
      <input type="file" accept="application/json,.json" data-role="file" hidden>
      <p class="hint" style="margin-top:12px">Import and Load demo data replace everything in your account (synced to all your devices). Filters and display preferences stay on this device.</p>
      <div class="spacer-40"></div>
    </div>`;
  root.querySelector('[data-act=back]').addEventListener('click', () => navigate('/more'));
  const on = (key, fn) => root.querySelector(`[data-row="${key}"]`).addEventListener('click', fn);
  on('currency', pickCurrency);
  for (const k of MANAGED) on('list:' + k, () => navigate('/more/settings/' + k));
  on('bankrolls', () => navigate('/more/bankroll'));
  on('export', () => downloadJson(getState()));
  on('export-csv', exportSessionsCsv);
  on('export-txns', exportTxnsCsv);
  on('import-csv', () => navigate('/more/import'));
  const file = root.querySelector('[data-role=file]');
  file.addEventListener('change', () => { if (file.files[0]) importFile(file.files[0]); file.value = ''; });
  on('import', () => file.click());
  on('reset', resetDemo);
}

export function MasterListScreen(root, doc, listKey) {
  const meta = MASTER_META[listKey];
  if (!meta || !MANAGED.includes(listKey)) { navigate('/more/settings'); return; }
  const items = doc[listKey] || [];
  root.innerHTML = `
    <div class="screen">
      <header class="topbar">
        <button class="topbtn" data-act="back" aria-label="Back">${icon('back')}</button>
        <h1>${esc(meta.title)}</h1>
        <button class="topbtn accent" data-act="add" aria-label="Add ${esc(meta.singular)}">${icon('plus')}</button>
      </header>
      <div class="rows" style="padding:0">
        ${items.length ? items.map(it => {
          const used = masterUsage(doc, listKey, it.id);
          return `<button class="field-row" data-item="${esc(it.id)}">
            <span class="field-name">${esc(it.name)}</span>
            <span class="field-value"><span class="hint">${used} ${used === 1 ? 'session' : 'sessions'}</span>${icon('chevron', 'chev')}</span>
          </button>`;
        }).join('') : `<div class="empty-block">No ${esc(meta.title.toLowerCase())} yet. Tap + to add one.</div>`}
      </div>
      <div class="spacer-40"></div>
    </div>`;
  root.querySelector('[data-act=back]').addEventListener('click', () => navigate('/more/settings'));
  root.querySelector('[data-act=add]').addEventListener('click', () => textSheet({
    title: `New ${meta.singular}`, label: 'Name', value: '', multiline: false,
    onSave(v) {
      const err = masterNameError(getState(), listKey, v);
      if (err) { toast(err); return; }
      addMasterItem(listKey, v.trim());
      toast('Added');
    },
  }));
  root.querySelectorAll('[data-item]').forEach(el => el.addEventListener('click', () => {
    const it = getState()[listKey].find(x => x.id === el.dataset.item);
    if (it) itemSheet(listKey, it);
  }));
}

function itemSheet(listKey, it) {
  const meta = MASTER_META[listKey];
  openSheet({
    title: it.name,
    bodyHtml: `
      <button class="sheet-row" data-a="rename">${icon('note')}<span>Rename</span></button>
      <button class="sheet-row danger" data-a="delete">${icon('trash')}<span>Delete</span></button>`,
    onMount(sheet, close) {
      sheet.querySelector('[data-a=rename]').addEventListener('click', () => {
        close();
        textSheet({
          title: `Rename ${meta.singular}`, label: 'Name', value: it.name, multiline: false,
          onSave(v) {
            const err = masterNameError(getState(), listKey, v, it.id);
            if (err) { toast(err); return; }
            renameMasterItem(listKey, it.id, v.trim());
            toast('Renamed');
          },
        });
      });
      sheet.querySelector('[data-a=delete]').addEventListener('click', () => {
        close();
        const err = masterDeleteError(getState(), listKey, it.id);
        if (err) { toast(err); return; }
        confirmSheet({
          title: `Delete ${meta.singular}?`, message: `"${it.name}" is not used by any session.`,
          confirmLabel: 'Delete', danger: true,
          onConfirm() { deleteMasterItem(listKey, it.id); toast('Deleted'); },
        });
      });
    },
  });
}
