// Import screen (STEP E): CSV and PokerNow session import with preview before
// commit. PokerNow exports are detected first (js/pokernow-import.js); any
// other CSV falls through to the generic mapper (js/csv-import.js) where the
// user maps columns and sees per-row validation before committing. Everything
// lands through store.importSessions — one save, per-row rejections, and the
// same duplicate / one-live-session guards the preview promised.
//
// Wizard state is module-level so a store notification mid-wizard (a remote
// change re-renders the route) does not throw away the chosen file or mapping.
// It is reset when the route is left (hashchange) or a new file is picked.

import { navigate } from '../router.js';
import { getState, importSessions } from '../store.js';
import { icon } from '../icons.js';
import { esc, toast } from '../ui.js';
import { IMPORT_FIELDS, analyzeCsv, buildImport, sessionFingerprint, draftNetResult } from '../csv-import.js';
import { importPokerNow } from '../pokernow-import.js';
import { netResult } from '../stats.js';
import { getLiveSession } from '../domain.js';
import { getCurrency, fmtMoney } from '../format.js';

let wiz = null;

// Reset the wizard when the hash leaves the import route. Registered once at
// module load: a per-render listener is removed by the router's cleanup pass
// before the same hashchange event reaches it (the router's own listener
// registered first), so the reset never fired on route leave. Guarded for
// non-browser harnesses (Node test stubs) that never navigate.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('hashchange', () => {
    if (!location.hash.includes('/more/import')) wiz = null;
  });
}

const FIELD_OPTIONS = [{ key: '', label: 'Ignore' }, ...IMPORT_FIELDS.map(f => ({ key: f.key, label: f.label }))];
const PREVIEW_ROWS = 5;
const PREVIEW_REJECTS = 5;

function header(title) {
  return `<header class="topbar">
    <button class="topbtn" data-act="back" aria-label="Back">${icon('back')}</button>
    <h1>${esc(title)}</h1>
    <span class="topbtn" style="visibility:hidden"></span>
  </header>`;
}

function fieldOptionsHtml(selected) {
  return FIELD_OPTIONS.map(o =>
    `<option value="${esc(o.key)}"${o.key === (selected || '') ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
}

// Fingerprint set over the sessions the store already has — the same identity
// the store enforces, so the preview's duplicate counts are the truth.
function storeFingerprints() {
  const doc = getState();
  return new Set(doc.sessions.map(s => sessionFingerprint(s, netResult(doc, s))));
}

function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtNet(n, cur) {
  if (!Number.isFinite(n)) return '—';
  const s = fmtMoney(Math.abs(n), cur);
  return (n < 0 ? `−${s}` : `+${s}`);
}

function warnList(warnings, limit = 6) {
  if (!warnings.length) return '';
  const shown = warnings.slice(0, limit).map(w =>
    `<div class="import-issue">⚠️ ${esc(w.message || String(w))}</div>`).join('');
  const more = warnings.length > limit
    ? `<div class="import-issue">…and ${warnings.length - limit} more</div>` : '';
  return `<div class="import-warnings">${shown}${more}</div>`;
}

// --- pick step -----------------------------------------------------------------

function pickHtml(doc) {
  const bankOpts = ['<option value="">Account default</option>']
    .concat(doc.bankrolls.map(b =>
      `<option value="${esc(b.id)}"${wiz.bankrollId === b.id ? ' selected' : ''}>${esc(b.name)}</option>`))
    .join('');
  return `
    <p class="hint" style="margin-top:12px">
      PokerNow exports are detected automatically — drop the ledger CSV (and the
      full log if you exported one). Any other CSV opens the column mapper so
      you can match it to your sessions.
    </p>
    <div class="rows" style="padding:0">
      <button class="field-row" data-act="choose">
        <span class="field-name">Choose a CSV file</span>
        <span class="field-value">${icon('chevron', 'chev')}</span>
      </button>
      <label class="field-row"><span class="field-name">Bankroll for sessions without a Bankroll column</span>
        <span class="field-value"><select class="input" data-role="bank">${bankOpts}</select></span>
      </label>
    </div>
    <input type="file" accept=".csv,text/csv" data-role="file" hidden>
    <p class="hint" style="margin-top:12px">
      Nothing is imported until you review the preview. The file is read on this
      device only.
    </p>`;
}

// --- PokerNow: pick "me" ---------------------------------------------------------

function pnMeHtml() {
  const r = wiz.pn;
  const picks = wiz.mePicks || {};
  const ambiguous = r.tables.filter(t => t.status === 'ambiguous' && t.candidates);
  const rows = ambiguous.map((t, i) => {
    const opts = t.candidates.map(c => {
      const bits = [c.nicknames.join(' / ') || c.player_id];
      if (Number.isFinite(c.ledger_net)) bits.push(`net ${fmtNet(c.ledger_net, wiz.currency)}`);
      if (c.hands) bits.push(`${c.hands} hands`);
      if (c.seats) bits.push(`${c.seats} seat${c.seats === 1 ? '' : 's'}`);
      return `<option value="${esc(c.player_id)}"${picks[i] === c.player_id ? ' selected' : ''}>${esc(bits.join(' · '))}</option>`;
    }).join('');
    return `<label class="field-row"><span class="field-name">Table ${esc(String(t.tableId || i + 1)).slice(0, 24)}</span>
      <span class="field-value"><select class="input" data-me="${i}"><option value="">Pick yourself…</option>${opts}</select></span>
    </label>`;
  }).join('');
  const notFound = r.tables.some(t => t.status === 'not_found');
  const nickRow = notFound ? `
    <label class="field"><span class="field-label">Which nickname did you play under?</span>
      <input class="input" data-role="nick" type="text" value="${esc(wiz.nickname || '')}" placeholder="e.g. Denis"></label>` : '';
  return `
    <p class="hint" style="margin-top:12px">
      This looks like a PokerNow export, but it isn't clear which player is you.
      ${ambiguous.length ? 'Pick yourself at each table.' : 'Tell me your nickname and I will find your sessions.'}
    </p>
    ${rows}${nickRow}
    <button class="btn-primary" data-act="pn-go" style="margin-top:12px">Continue</button>`;
}

// --- PokerNow: preview -------------------------------------------------------------

function pnPreviewHtml() {
  const r = wiz.pn;
  const cur = wiz.currency;
  // Surface what the store would refuse: sessions whose import_key the store
  // has already recorded are skipped at commit — say so before the commit.
  const keys = getState().import_keys || {};
  const isDup = d => d.source && d.source.import_key && keys[d.source.import_key];
  const fresh = r.sessions.filter(d => !isDup(d));
  const dups = r.sessions.length - fresh.length;
  const rows = r.sessions.map(d => {
    const s = d.session;
    const bits = [
      fmtWhen(s.start_time),
      s.kind === 'tournament' ? 'Tournament' : 'Cash',
      s.game_name || '', s.location_name || '',
      s.is_live ? 'live' : fmtNet(draftNetResult(s), cur),
      isDup(d) ? '⚠️ already imported from this file' : '',
    ].filter(Boolean);
    return `<div class="field-row" style="cursor:default"><span class="field-name">${esc(bits.join(' · '))}</span></div>`;
  }).join('');
  const live = fresh.some(d => d.session.is_live);
  const liveWarn = live && getLiveSession(getState())
    ? '<div class="import-issue">⚠️ You already have a live session. This import includes another one — it will be skipped unless you end yours first.</div>'
    : '';
  const errors = r.errors.map(w => `<div class="import-issue">⚠️ ${esc(w.message || String(w))}</div>`).join('');
  const stackBits = fresh.reduce((n, d) => n + (d.stack_events ? d.stack_events.length : 0), 0);
  const headBits = [
    `${fresh.length} of ${r.sessions.length} session${r.sessions.length === 1 ? '' : 's'} ready`,
    dups ? `${dups} already imported` : '',
    stackBits ? `${stackBits} stack events` : '',
  ].filter(Boolean).join(' · ');
  return `
    <div class="section-label" style="padding-left:0">Preview — ${esc(headBits)}</div>
    <div class="rows" style="padding:0">${rows || '<div class="empty-block">No sessions found in this file.</div>'}</div>
    ${liveWarn}${errors}${warnList(r.warnings)}
    ${fresh.length ? `<button class="btn-primary" data-act="commit" style="margin-top:12px">Import ${fresh.length} session${fresh.length === 1 ? '' : 's'}</button>` : ''}
    <button class="btn-danger" data-act="restart" style="margin-top:10px">Choose a different file</button>`;
}

// --- generic CSV: mapping + preview ------------------------------------------------

function mappingErrorsHtml(mv) {
  if (!mv || !mv.errors || !mv.errors.length) return '';
  return `<div class="import-warnings">${mv.errors.map(e => `<div class="import-issue">⚠️ ${esc(e)}</div>`).join('')}</div>`;
}

function csvMapHtml() {
  const a = wiz.analysis;
  const cur = getCurrency(getState());
  const headers = a.headers || a.columnLabels || [];
  const cols = Array.from({ length: a.columnCount }, (_, i) => {
    const name = headers[i] ? headers[i] : `Column ${i + 1}`;
    return `<label class="field-row"><span class="field-name">${esc(name)}</span>
      <span class="field-value"><select class="input" data-col="${i}">${fieldOptionsHtml(wiz.mapping[i])}</select></span>
    </label>`;
  }).join('');
  const headerToggle = `<label class="field-row"><span class="field-name">First row is headers</span>
    <span class="field-value"><input type="checkbox" data-role="hdr"${a.hasHeader ? ' checked' : ''}></span></label>`;
  const dateToggle = wiz.build && wiz.build.summary && wiz.build.summary.dateOrderAmbiguous ? `
    <div class="segmented" role="tablist" style="padding:0 0 12px">
      <button role="tab" data-order="DMY" class="${wiz.dateOrder === 'DMY' ? 'active' : ''}">Day/Month/Year</button>
      <button role="tab" data-order="MDY" class="${wiz.dateOrder === 'MDY' ? 'active' : ''}">Month/Day/Year</button>
    </div>` : '';
  return `
    <p class="hint" style="margin-top:12px">
      Map each column to a field. Times without a zone are read as local time;
      rows in a different currency are rejected, not converted.
    </p>
    <div class="rows" style="padding:0">${headerToggle}${cols}</div>
    ${dateToggle}
    <div data-role="preview">${csvPreviewHtml()}</div>`;
}

function csvPreviewHtml() {
  const b = wiz.build;
  if (!b || !b.ok) return '';
  const s = b.summary;
  const cur = s.currency ? s.currency.toLowerCase() : getCurrency(getState()).toLowerCase();
  const bits = [
    `${s.accepted} of ${s.totalRows} row${s.totalRows === 1 ? '' : 's'} ready`,
    s.kinds.cash ? `${s.kinds.cash} cash` : '',
    s.kinds.tournament ? `${s.kinds.tournament} tournament` : '',
    s.duplicates ? `${s.duplicates} duplicate${s.duplicates === 1 ? '' : 's'} skipped` : '',
  ].filter(Boolean).join(' · ');
  const netBits = `Net ${fmtNet(b.accepted.reduce((n, d) => n + d.net_result, 0), cur)}`;
  const rows = b.accepted.slice(0, PREVIEW_ROWS).map(d => {
    const g = d.session.kind === 'tournament' ? (d.refs.tournament_type || '') : (d.refs.game || '');
    const bitsRow = [
      fmtWhen(d.session.start_time),
      d.session.kind === 'tournament' ? 'Tournament' : 'Cash',
      g, d.refs.location || '',
      fmtNet(d.net_result, cur),
    ].filter(Boolean).join(' · ');
    return `<div class="field-row" style="cursor:default"><span class="field-name">${esc(bitsRow)}</span></div>`;
  }).join('');
  const rejects = b.rejected.slice(0, PREVIEW_REJECTS).map(r =>
    `<div class="import-issue">⚠️ Line ${r.line}: ${esc(r.reasons.join('; '))}</div>`).join('');
  const moreRejected = b.rejected.length > PREVIEW_REJECTS
    ? `<div class="import-issue">…and ${b.rejected.length - PREVIEW_REJECTS} more unreadable rows</div>` : '';
  const meta = [
    s.dateOrderAmbiguous ? 'Date order is ambiguous — check the first rows.' : '',
    s.dateOrderConflict ? 'Rows disagree on the date order — some may be misread.' : '',
    s.mixedCurrencies ? `Mixed currencies in the file (${Object.keys(s.currencies).join(', ')}); only ${esc(s.currency)} imports.` : '',
  ].filter(Boolean).map(t => `<div class="import-issue">⚠️ ${esc(t)}</div>`).join('');
  return `
    <div class="section-label" style="padding-left:0">Preview — ${esc(bits)} · ${esc(netBits)}</div>
    <div class="rows" style="padding:0">${rows || '<div class="empty-block">No rows can be imported with this mapping.</div>'}</div>
    ${meta}${rejects}${moreRejected}${mappingErrorsHtml(b.mappingErrors)}
    ${b.accepted.length ? `<button class="btn-primary" data-act="commit" style="margin-top:12px">Import ${b.accepted.length} session${b.accepted.length === 1 ? '' : 's'}</button>` : ''}`;
}

// --- done -------------------------------------------------------------------------

function doneHtml() {
  const w = wiz.result;
  const skipped = w.skipped.map(s =>
    `<div class="import-issue">⚠️ ${s.line ? `Line ${s.line}: ` : ''}${esc(s.reason)}</div>`).join('');
  return `
    <div class="section-label" style="padding-left:0">Imported ${w.imported.length} session${w.imported.length === 1 ? '' : 's'}</div>
    ${skipped ? `<div class="section-label" style="padding-left:0">Skipped ${w.skipped.length}</div>${skipped}` : ''}
    <button class="btn-primary" data-act="restart" style="margin-top:12px">Import another file</button>
    <button class="btn-danger" data-act="back" style="margin-top:10px">Back to settings</button>`;
}

// --- render + events --------------------------------------------------------------

export function ImportScreen(root, doc) {
  if (!wiz) wiz = { step: 'pick', bankrollId: null, mePicks: {}, nickname: '', dateOrder: null };
  wiz.currency = getCurrency(doc).toUpperCase();

  const body = {
    pick: () => pickHtml(doc),
    'pn-me': () => pnMeHtml(),
    'pn-preview': () => pnPreviewHtml(),
    map: () => csvMapHtml(),
    done: () => doneHtml(),
  }[wiz.step] || (() => pickHtml(doc));

  root.innerHTML = `
    <div class="screen">
      ${header(wiz.step === 'done' ? 'Import complete' : 'Import sessions')}
      ${body()}
      <div class="spacer-40"></div>
    </div>`;

  const on = (sel, fn) => root.querySelector(sel).addEventListener('click', fn);

  on('[data-act=back]', () => { wiz = null; navigate('/more/settings'); });
  const restart = root.querySelector('[data-act=restart]');
  if (restart) restart.addEventListener('click', () => { wiz = null; renderRouteImport(root, doc); });

  // pick step
  const choose = root.querySelector('[data-act=choose]');
  if (choose) {
    const file = root.querySelector('[data-role=file]');
    const bank = root.querySelector('[data-role=bank]');
    if (bank) bank.addEventListener('change', () => { wiz.bankrollId = bank.value || null; });
    choose.addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      const f = file.files[0];
      file.value = '';
      if (!f) return;
      const reader = new FileReader();
      reader.onerror = () => { console.error('import: read failed', reader.error); toast('Could not read that file'); };
      reader.onload = () => {
        wiz = { step: 'pick', bankrollId: wiz ? wiz.bankrollId : null, mePicks: {}, nickname: '', dateOrder: null, fileName: f.name, text: String(reader.result || '') };
        detectAndPrepare(root, doc);
      };
      reader.readAsText(f);
    });
  }

  // PokerNow me-pick step
  const pnGo = root.querySelector('[data-act=pn-go]');
  if (pnGo) pnGo.addEventListener('click', () => {
    root.querySelectorAll('select[data-me]').forEach(sel => {
      if (sel.value) wiz.mePicks[sel.dataset.me] = sel.value;
    });
    const nick = root.querySelector('[data-role=nick]');
    if (nick) wiz.nickname = nick.value.trim();
    rerunPokerNow(root, doc);
  });

  // CSV mapping step
  const hdr = root.querySelector('[data-role=hdr]');
  if (hdr) hdr.addEventListener('change', () => {
    reanalyze(root, doc, hdr.checked);
  });
  root.querySelectorAll('select[data-col]').forEach(sel => sel.addEventListener('change', () => {
    wiz.mapping[Number(sel.dataset.col)] = sel.value || null;
    rebuildPreview(root, doc);
  }));
  root.querySelectorAll('[data-order]').forEach(b => b.addEventListener('click', () => {
    wiz.dateOrder = b.dataset.order;
    rebuildPreview(root, doc);
    root.querySelectorAll('[data-order]').forEach(x => {
      x.classList.toggle('active', x === b); x.setAttribute('aria-selected', String(x === b));
    });
  }));

  // commit (shared by PokerNow preview and CSV mapping)
  const commit = root.querySelector('[data-act=commit]');
  if (commit) commit.addEventListener('click', () => commitImport(root, doc));

  // The map step's preview is a patch target (column/date/header changes swap
  // it without a route re-render) — populate it after every shell render so
  // the preview and its commit button exist from the first paint onward.
  if (wiz.step === 'map') rebuildPreview(root, doc);
}

// Re-render the wizard in place (same route, same root).
function renderRouteImport(root, doc) {
  ImportScreen(root, doc);
}

// --- PokerNow flow ------------------------------------------------------------------

// After a file is chosen: try PokerNow first, fall back to the generic mapper.
function detectAndPrepare(root, doc) {
  const r = importPokerNow([{ name: wiz.fileName, text: wiz.text }]);
  if (r.status === 'ok' && r.sessions.length) {
    wiz.pn = r; wiz.step = 'pn-preview';
  } else if (r.status === 'ambiguous' || (r.status === 'not_found')) {
    wiz.pn = r; wiz.step = 'pn-me';
  } else if (r.status === 'empty' || r.status === 'invalid') {
    // Not a PokerNow file (or an unreadable one) — let the generic mapper try;
    // keep the parser's own complaint for the preview.
    wiz.pnErrors = r.errors && r.errors.length ? r.errors : [];
    startGeneric(root, doc);
    if (wiz.pnErrors.length) toast(wiz.pnErrors[0].message || 'Not a PokerNow export — using the column mapper');
    return;
  } else {
    wiz.pn = r; wiz.step = 'pn-preview';
  }
  renderRouteImport(root, doc);
}

function rerunPokerNow(root, doc) {
  const picks = Object.values(wiz.mePicks || {});
  const me = [...picks];
  if (wiz.nickname) me.push(wiz.nickname);
  const r = importPokerNow([{ name: wiz.fileName, text: wiz.text }], me.length ? { me } : {});
  wiz.pn = r;
  wiz.step = (r.status === 'ambiguous' || r.status === 'not_found') ? 'pn-me' : 'pn-preview';
  renderRouteImport(root, doc);
}

function commitPokerNow(root, doc) {
  const r = wiz.pn;
  const res = importSessions(r.sessions, { bankrollId: wiz.bankrollId || undefined });
  wiz.result = res;
  wiz.step = 'done';
  toast(`Imported ${res.imported.length} session${res.imported.length === 1 ? '' : 's'}`);
  renderRouteImport(root, doc);
}

// --- generic CSV flow -----------------------------------------------------------------

function startGeneric(root, doc) {
  reanalyze(root, doc, undefined);
}

function reanalyze(root, doc, hasHeader) {
  const a = analyzeCsv(wiz.text, typeof hasHeader === 'boolean' ? { hasHeader } : {});
  if (!a.ok) {
    toast(a.fileError || 'That file could not be read as CSV');
    wiz = { step: 'pick', bankrollId: wiz.bankrollId, mePicks: {}, nickname: '', dateOrder: null };
    renderRouteImport(root, doc);
    return;
  }
  wiz.analysis = a;
  wiz.mapping = a.mapping.slice();
  const wasMap = wiz.step === 'map';
  wiz.step = 'map';
  if (!wasMap) {
    // Pick → map transition: the pick DOM has no preview container, so the
    // full map shell must render before the preview can be patched in.
    renderRouteImport(root, doc);
    return;
  }
  rebuildPreview(root, doc);
}

function rebuildPreview(root, doc) {
  const known = storeFingerprints();
  const mapping = wiz.analysis && wiz.analysis.ok
    ? wiz.mapping.map((v, i) => (v === undefined ? wiz.analysis.mapping[i] : v))
    : wiz.mapping;
  wiz.build = buildImport(wiz.analysis, mapping, {
    currency: getCurrency(doc),
    dateOrder: wiz.dateOrder || undefined,
    isDuplicate: draft => (known.has(draft.fingerprint) ? 'Matches a session you already have' : false),
  });
  if (wiz.step === 'map') {
    const p = root.querySelector('[data-role=preview]');
    if (p) {
      p.innerHTML = csvPreviewHtml();
      // The preview is patched after the route render's binding pass, so the
      // freshly inserted commit button needs its own listener each time.
      const commit = p.querySelector('[data-act=commit]');
      if (commit) commit.addEventListener('click', () => commitImport(root, doc));
    }
  }
}

function commitCsv(root, doc) {
  const b = wiz.build;
  if (!b || !b.ok || !b.accepted.length) { toast('Nothing to import yet'); return; }
  const res = importSessions(b.accepted, { bankrollId: wiz.bankrollId || undefined });
  wiz.result = res;
  wiz.step = 'done';
  toast(`Imported ${res.imported.length} session${res.imported.length === 1 ? '' : 's'}`);
  renderRouteImport(root, doc);
}

function commitImport(root, doc) {
  if (wiz.step === 'pn-preview') commitPokerNow(root, doc);
  else if (wiz.step === 'map') commitCsv(root, doc);
}
