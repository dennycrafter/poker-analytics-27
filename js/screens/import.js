// Import screen (IT1): bring sessions in from anywhere. The pick step takes
// any CSV, XLSX, JSON, TXT, PNG or JPG file (drop or pick) plus a big "Paste
// anything" box. Sources route through the pure flow machine in
// js/import-flow.js: known formats (BankrollCoach, PA27 exports, PokerNow)
// parse instantly, other tables and text are read by the server AI, and when
// the AI is unavailable a manual column-mapping step reads tables instead.
// Every path ends in the same preview: editable rows, duplicates unticked and
// labeled "Already in your app", low-confidence rows flagged "Check this",
// and nothing written until Import is pressed. After commit the wizard shows
// the batch id (undo lives in Settings, Import history).
//
// The STEP E flows for PokerNow files (which player is you) and generic CSV
// column mapping are preserved; the flow machine hands generic CSVs back to
// them (phase 'legacy'). The IT1 contract modules (js/import-smart.js,
// js/import-ai.js) and the store's batch functions load dynamically, so the
// wizard degrades to the legacy mapper if a sibling module has not landed
// yet instead of crashing the app at boot.
//
// Wizard state is module-level so a store notification mid-wizard (a remote
// change re-renders the route) does not throw away the chosen file or
// mapping. It is reset when the route is left (hashchange) or a new source
// is picked.

import { navigate } from '../router.js';
import { getState, importSessions } from '../store.js';
import { icon } from '../icons.js';
import { esc, toast } from '../ui.js';
import { IMPORT_FIELDS, analyzeCsv, buildImport, sessionFingerprint, draftNetResult } from '../csv-import.js';
import { importPokerNow } from '../pokernow-import.js';
import { netResult } from '../stats.js';
import { getLiveSession } from '../domain.js';
import { getCurrency, fmtMoney } from '../format.js';
import { createImportFlow, rowView, summarizePreview, acceptedRows, jsonToTable, xlsxToRows, PREVIEW_RENDER_CAP } from '../import-flow.js';

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
const AI_TIMEOUT_MS = 60000;
const AI_ENDPOINT = '/api/import-ai';

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
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtNet(n, cur) {
  if (!Number.isFinite(n)) return '-';
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

// --- contract modules (dynamic: siblings may not have landed yet) -------------

const tryImport = spec => import(spec).catch(e => {
  console.error(`import: ${spec} unavailable`, e);
  return null;
});

let contractDepsPromise = null;

function contractDeps() {
  if (!contractDepsPromise) contractDepsPromise = loadContractDeps();
  return contractDepsPromise;
}

async function loadContractDeps() {
  const [smart, ai, store] = await Promise.all([
    tryImport('../import-smart.js'),
    tryImport('../import-ai.js'),
    tryImport('../store.js'),
  ]);
  return {
    detectFormat: smart && smart.detectFormat,
    parseBankrollCoachRows: smart && smart.parseBankrollCoachRows,
    parsePastedText: smart && smart.parsePastedText,
    parseGenericTable: smart && smart.parseGenericTable,
    buildTableRequest: ai && ai.buildTableRequest,
    applyMapping: ai && ai.applyMapping,
    scoreConfidence: ai && ai.scoreConfidence,
    rowsFromAi: ai && ai.rowsFromAi,
    manualMappingShape: ai && ai.manualMappingShape,
    parsePokernow: importPokerNow,
    findDuplicates: rows => (store && typeof store.findDuplicates === 'function'
      ? store.findDuplicates(getState(), rows) : []),
    // The screen keeps the promise so the async commit can be observed and
    // reported back to the machine (COMMITTED / COMMIT_FAILED).
    commit: rows => {
      const p = storeCommit(store, rows);
      wiz.lastCommit = p;
      return p;
    },
  };
}

async function ensureFlow() {
  if (!wiz.flow) {
    const deps = await contractDeps();
    wiz.storeNs = await tryImport('../store.js');
    wiz.flow = createImportFlow(deps);
  }
  return wiz.flow;
}

// The store's batch contract: stage, then commit the same batch id. Missing
// functions (a sibling lane not merged yet) resolve to null, which the flow
// machine turns into a plain error instead of a partial write.
async function storeCommit(store, rows) {
  if (!store || typeof store.stageImport !== 'function' || typeof store.commitImport !== 'function') {
    console.error('import: store batch contract (stageImport/commitImport) is not available');
    return null;
  }
  const doc = getState();
  const staged = await store.stageImport(doc, rows);
  if (!staged || !staged.batchId) return null;
  await store.commitImport(doc, staged.batchId, rows);
  return { batchId: staged.batchId };
}

// --- pick step -----------------------------------------------------------------

function pickHtml(doc) {
  const bankOpts = ['<option value="">Account default</option>']
    .concat(doc.bankrolls.map(b =>
      `<option value="${esc(b.id)}"${wiz.bankrollId === b.id ? ' selected' : ''}>${esc(b.name)}</option>`))
    .join('');
  return `
    <p class="hint" style="margin-top:12px">
      Bring sessions in from anywhere: another app's export, a spreadsheet, a
      screenshot, or pasted notes. Known formats are read instantly, anything
      else is read by AI on the server. Nothing is imported until you review
      the preview.
    </p>
    <div data-role="drop" role="button" tabindex="0" aria-label="Choose a file to import"
      style="margin:10px 0 12px;padding:22px 14px;border:1.5px dashed var(--border);border-radius:12px;background:var(--bg-secondary);text-align:center;cursor:pointer">
      <div style="font-size:15px">Drop a file here</div>
      <div class="hint" style="margin-top:4px">CSV, XLSX, JSON, TXT, PNG or JPG, or tap to pick one</div>
    </div>
    <input type="file" accept=".csv,.tsv,.txt,.json,.xlsx,.png,.jpg,.jpeg" data-role="file" hidden>
    <div class="rows" style="padding:0">
      <label class="field-row" style="cursor:default"><span class="field-name">Or paste anything</span></label>
    </div>
    <textarea class="input" data-role="paste" rows="6"
      placeholder="Paste rows or notes, e.g. Oct 3 1/2 at Lodge +340 5h"
      style="width:100%;padding:10px;font-size:14px;background:var(--bg-secondary)"></textarea>
    <button class="btn-primary" data-act="paste-read" style="margin-top:10px">Read this text</button>
    <div class="rows" style="padding:0;margin-top:6px">
      <label class="field-row"><span class="field-name">Bankroll for sessions without a Bankroll column</span>
        <span class="field-value"><select class="input" data-role="bank">${bankOpts}</select></span>
      </label>
    </div>
    <p class="hint" style="margin-top:12px">
      Files are read on this device only.
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
    ? '<div class="import-issue">⚠️ You already have a live session. This import includes another one, and it will be skipped unless you end yours first.</div>'
    : '';
  const errors = r.errors.map(w => `<div class="import-issue">⚠️ ${esc(w.message || String(w))}</div>`).join('');
  const stackBits = fresh.reduce((n, d) => n + (d.stack_events ? d.stack_events.length : 0), 0);
  const headBits = [
    `${fresh.length} of ${r.sessions.length} session${r.sessions.length === 1 ? '' : 's'} ready`,
    dups ? `${dups} already imported` : '',
    stackBits ? `${stackBits} stack events` : '',
  ].filter(Boolean).join(' · ');
  return `
    <div class="section-label" style="padding-left:0">Preview · ${esc(headBits)}</div>
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
    s.dateOrderAmbiguous ? 'Date order is ambiguous: check the first rows.' : '',
    s.dateOrderConflict ? 'Rows disagree on the date order, so some may be misread.' : '',
    s.mixedCurrencies ? `Mixed currencies in the file (${Object.keys(s.currencies).join(', ')}); only ${esc(s.currency)} imports.` : '',
  ].filter(Boolean).map(t => `<div class="import-issue">⚠️ ${esc(t)}</div>`).join('');
  return `
    <div class="section-label" style="padding-left:0">Preview · ${esc(bits)} · ${esc(netBits)}</div>
    <div class="rows" style="padding:0">${rows || '<div class="empty-block">No rows can be imported with this mapping.</div>'}</div>
    ${meta}${rejects}${moreRejected}${mappingErrorsHtml(b.mappingErrors)}
    ${b.accepted.length ? `<button class="btn-primary" data-act="commit" style="margin-top:12px">Import ${b.accepted.length} session${b.accepted.length === 1 ? '' : 's'}</button>` : ''}`;
}

// --- flow machine steps ------------------------------------------------------------

function flowHtml() {
  const st = wiz.flow.state;
  if (st.phase === 'ai' || st.phase === 'committing') return flowBusyHtml(st);
  if (st.phase === 'error') return flowErrorHtml(st);
  if (st.phase === 'manual') return manualMappingHtml();
  if (st.phase === 'preview') return flowPreviewHtml();
  if (st.phase === 'committed') return flowDoneHtml(st);
  return '';
}

function flowBusyHtml(st) {
  const what = st.kind === 'image' ? 'image' : st.kind === 'table' ? 'table' : 'text';
  const busy = st.phase === 'committing'
    ? 'Saving the import.'
    : `Reading the ${what} with AI on the server. This can take a moment.`;
  return `
    <p class="hint" style="margin-top:12px">${esc(busy)}</p>
    ${st.phase === 'ai' ? '<button class="btn-danger" data-act="restart" style="margin-top:12px">Cancel</button>' : ''}`;
}

function flowErrorHtml(st) {
  return `
    <div class="import-warnings" style="margin-top:12px">
      <div class="import-issue">⚠️ ${esc(st.error || 'This source could not be read.')}</div>
    </div>
    <button class="btn-danger" data-act="restart" style="margin-top:12px">Choose a different file</button>`;
}

// manualMappingShape may be { headers, fields: [{ key, label, suggestion }] },
// a bare field array, or another shape a sibling lane picked; normalize it.
function mappingFields(shape) {
  if (!shape) return null;
  const fields = Array.isArray(shape) ? shape : shape.fields;
  if (!Array.isArray(fields) || !fields.length) return null;
  return fields.map(f => typeof f === 'string'
    ? { key: f, label: f }
    : {
      key: f.key !== undefined ? f.key : f.field,
      label: f.label !== undefined ? f.label : (f.key || f.field),
      suggestion: f.suggestion !== undefined ? f.suggestion
        : (f.suggested !== undefined ? f.suggested : f.suggestedColumn),
    });
}

function mappingHeaders(shape, fallback) {
  if (Array.isArray(shape)) return fallback || [];
  const h = shape && Array.isArray(shape.headers) && shape.headers.length ? shape.headers : fallback;
  return h || [];
}

function manualMappingHtml() {
  const st = wiz.flow.state;
  const fields = mappingFields(st.mappingShape);
  const headers = mappingHeaders(st.mappingShape, st.headers);
  if (!fields || !headers.length) {
    return `
      <div class="import-warnings" style="margin-top:12px">
        <div class="import-issue">⚠️ This table needs a column mapping, but the mapping could not be read.</div>
      </div>
      <button class="btn-danger" data-act="restart" style="margin-top:12px">Choose a different file</button>`;
  }
  const opts = sel => ['<option value="">Not in this file</option>']
    .concat(headers.map((h, i) =>
      `<option value="${i}"${sel === i ? ' selected' : ''}>${esc(String(h || `Column ${i + 1}`))}</option>`))
    .join('');
  const rows = fields.map(f =>
    `<label class="field-row"><span class="field-name">${esc(String(f.label))}</span>
      <span class="field-value"><select class="input" data-map="${esc(String(f.key))}">${opts(f.suggestion)}</select></span>
    </label>`).join('');
  return `
    <p class="hint" style="margin-top:12px">
      AI is not available, so map the columns yourself. Pick which column holds
      each field. Nothing is saved until you press Import.
    </p>
    <div class="rows" style="padding:0">${rows}</div>
    <button class="btn-primary" data-act="flow-map" style="margin-top:12px">Continue</button>
    <button class="btn-danger" data-act="restart" style="margin-top:10px">Choose a different file</button>`;
}

function previewCell(i, field, label, value, kind = 'text') {
  return `<label style="display:flex;flex-direction:column;gap:3px;min-width:0">
    <span style="font-size:11px;color:var(--text-tertiary)">${esc(label)}</span>
    <input class="input" type="${kind}" data-edit="${i}" data-field="${field}" value="${esc(value)}" style="width:100%">
  </label>`;
}

function previewRowHtml(pr) {
  const i = pr.index;
  const v = rowView(pr.row);
  const flags = `<span data-flags="${i}" style="font-size:12px;${pr.duplicate ? 'color:var(--text-tertiary)' : (pr.flag ? 'color:var(--negative)' : '')}">${esc(pr.labels.join(' · '))}</span>`;
  const typeCell = `<label style="display:flex;flex-direction:column;gap:3px;min-width:0">
    <span style="font-size:11px;color:var(--text-tertiary)">Type</span>
    <select class="input" data-edit="${i}" data-field="type" style="width:100%">
      <option value="cash"${v.type === 'tournament' ? '' : ' selected'}>Cash</option>
      <option value="tournament"${v.type === 'tournament' ? ' selected' : ''}>Tournament</option>
    </select></label>`;
  return `<div style="border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:8px;background:var(--bg-secondary)">
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-secondary)">
      <input type="checkbox" data-accept="${i}"${pr.accepted ? ' checked' : ''}>
      <span>Row ${i + 1}</span>${flags}
    </label>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px">
      ${typeCell}
      ${previewCell(i, 'date', 'Date', v.date)}
      ${previewCell(i, 'stakes', 'Stakes', v.stakes)}
      ${previewCell(i, 'game', 'Game', v.game)}
      ${previewCell(i, 'location', 'Location', v.location)}
      ${previewCell(i, 'buy_in', 'Buy-in', v.buyIn, 'number')}
      ${previewCell(i, 'cash_out', 'Cash-out', v.cashOut, 'number')}
      ${previewCell(i, 'profit', 'Profit', v.profit, 'number')}
      ${previewCell(i, 'hours', 'Hours', v.hours, 'number')}
      ${previewCell(i, 'hands', 'Hands', v.hands, 'number')}
    </div>
  </div>`;
}

function flowPreviewHtml() {
  const st = wiz.flow.state;
  const s = summarizePreview(st.previewRows);
  const shown = st.previewRows.slice(0, PREVIEW_RENDER_CAP);
  const capNote = st.previewRows.length > shown.length
    ? `<p class="hint" style="margin:0 0 10px">Showing the first ${shown.length} of ${st.previewRows.length} rows. Every row imports.</p>` : '';
  return `
    <div class="section-label" style="padding-left:0">Preview</div>
    <p class="hint" style="margin:6px 0 10px" data-role="flow-summary">${esc(s.text)}</p>
    ${capNote}
    <div class="rows" style="padding:0">${shown.map(previewRowHtml).join('')}</div>
    ${st.error ? `<div class="import-warnings" style="margin-top:10px"><div class="import-issue">⚠️ ${esc(st.error)}</div></div>` : ''}
    ${s.button ? `<button class="btn-primary" data-act="flow-import" style="margin-top:12px">${esc(s.button)}</button>` : ''}
    <button class="btn-danger" data-act="restart" style="margin-top:10px">Choose a different file</button>`;
}

function flowDoneHtml(st) {
  const canUndo = Boolean(st.batchId) && wiz.storeNs && typeof wiz.storeNs.undoImport === 'function';
  return `
    <div class="section-label" style="padding-left:0">Imported ${st.committedCount} session${st.committedCount === 1 ? '' : 's'}</div>
    ${st.batchId ? `<p class="hint" style="margin:0 0 8px">Batch id: ${esc(String(st.batchId))}</p>` : ''}
    <p class="hint" style="margin:0 0 8px">This batch is listed in Settings under Import history.</p>
    ${canUndo ? '<button class="btn-danger" data-act="flow-undo" style="margin-top:12px">Undo import</button>' : ''}
    <button class="btn-primary" data-act="restart" style="margin-top:10px">Import another file</button>
    <button class="btn-danger" data-act="back" style="margin-top:10px">Back to settings</button>`;
}

// --- done (legacy flows) -----------------------------------------------------------

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
  if (!wiz) {
    wiz = { step: 'pick', bankrollId: null, mePicks: {}, nickname: '', dateOrder: null, flow: null, storeNs: null, fileMime: '', pnErrors: [], lastCommit: null };
  }
  wiz.currency = getCurrency(doc).toUpperCase();

  const flowDone = wiz.step === 'flow' && wiz.flow && wiz.flow.state.phase === 'committed';
  const body = {
    pick: () => pickHtml(doc),
    'pn-me': () => pnMeHtml(),
    'pn-preview': () => pnPreviewHtml(),
    map: () => csvMapHtml(),
    flow: () => flowHtml(),
    done: () => doneHtml(),
  }[wiz.step] || (() => pickHtml(doc));

  root.innerHTML = `
    <div class="screen">
      ${header(flowDone || wiz.step === 'done' ? 'Import complete' : 'Import sessions')}
      ${body()}
      <div class="spacer-40"></div>
    </div>`;

  const on = (sel, fn) => root.querySelector(sel).addEventListener('click', fn);

  on('[data-act=back]', () => { wiz = null; navigate('/more/settings'); });
  const restart = root.querySelector('[data-act=restart]');
  if (restart) restart.addEventListener('click', () => { wiz = null; renderRouteImport(root, doc); });

  // pick step
  const drop = root.querySelector('[data-role=drop]');
  if (drop) {
    const file = root.querySelector('[data-role=file]');
    const bank = root.querySelector('[data-role=bank]');
    if (bank) bank.addEventListener('change', () => { wiz.bankrollId = bank.value || null; });
    drop.addEventListener('click', () => file.click());
    drop.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); }
    });
    const dropTone = e => {
      e.preventDefault();
      drop.style.borderColor = e.type === 'dragover' ? 'var(--accent)' : 'var(--border)';
    };
    drop.addEventListener('dragover', dropTone);
    drop.addEventListener('dragleave', dropTone);
    drop.addEventListener('drop', e => {
      dropTone(e);
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(root, doc, f);
    });
    file.addEventListener('change', () => {
      const f = file.files[0];
      file.value = '';
      if (!f) return;
      handleFile(root, doc, f);
    });
  }
  const pasteBtn = root.querySelector('[data-act=paste-read]');
  if (pasteBtn) pasteBtn.addEventListener('click', () => {
    const ta = root.querySelector('[data-role=paste]');
    const text = ta ? ta.value : '';
    if (!text.trim()) { toast('Paste some text first'); return; }
    handlePaste(root, doc, text);
  });

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

  // flow machine steps
  if (wiz.step === 'flow') bindFlow(root, doc);

  // commit (shared by PokerNow preview and CSV mapping)
  const commit = root.querySelector('[data-act=commit]');
  if (commit) commit.addEventListener('click', () => commitImport(root, doc));

  // The map step's preview is a patch target (column/date/header changes swap
  // it without a route re-render) — populate it after every shell render so
  // the preview and its commit button exist from the first paint onward.
  if (wiz.step === 'map') rebuildPreview(root, doc);
}

function bindFlow(root, doc) {
  root.querySelectorAll('[data-accept]').forEach(cb => cb.addEventListener('change', () => {
    wiz.flow.handle('TOGGLE_ROW', { index: Number(cb.dataset.accept), accepted: cb.checked });
    patchPreview(root);
  }));
  root.querySelectorAll('[data-edit]').forEach(inp => inp.addEventListener('change', () => {
    wiz.flow.handle('EDIT_ROW', { index: Number(inp.dataset.edit), patch: { [inp.dataset.field]: inp.value } });
    patchRow(root, Number(inp.dataset.edit));
    patchPreview(root);
  }));
  const mapBtn = root.querySelector('[data-act=flow-map]');
  if (mapBtn) mapBtn.addEventListener('click', () => {
    const mapping = {};
    root.querySelectorAll('select[data-map]').forEach(sel => {
      mapping[sel.dataset.map] = sel.value === '' ? null : Number(sel.value);
    });
    wiz.flow.handle('MAPPING', { mapping });
    renderRouteImport(root, doc);
  });
  const imp = root.querySelector('[data-act=flow-import]');
  if (imp) imp.addEventListener('click', () => flowImport(root, doc));
  const undo = root.querySelector('[data-act=flow-undo]');
  if (undo) undo.addEventListener('click', () => flowUndo(root, doc));
}

// Edits and toggles patch the summary, button label, and the row's flag chip
// in place: a full re-render would throw away input focus and scroll.
function patchPreview(root) {
  const s = summarizePreview(wiz.flow.state.previewRows);
  const sum = root.querySelector('[data-role=flow-summary]');
  if (sum) sum.textContent = s.text;
  const btn = root.querySelector('[data-act=flow-import]');
  if (btn && s.button) btn.textContent = s.button;
  else if (btn && !s.button) btn.remove();
}

function patchRow(root, index) {
  const pr = wiz.flow.state.previewRows[index];
  if (!pr) return;
  const chip = root.querySelector(`[data-flags="${index}"]`);
  if (chip) {
    chip.textContent = pr.labels.join(' · ');
    chip.style.color = pr.duplicate ? 'var(--text-tertiary)' : (pr.flag ? 'var(--negative)' : '');
  }
}

// Re-render the wizard in place (same route, same root).
function renderRouteImport(root, doc) {
  ImportScreen(root, doc);
}

// --- source intake ------------------------------------------------------------------

const extOf = name => {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
};

const readAs = (file, mode) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onerror = () => reject(r.error || new Error('read failed'));
  r.onload = () => resolve(r.result);
  if (mode === 'buffer') r.readAsArrayBuffer(file);
  else if (mode === 'dataurl') r.readAsDataURL(file);
  else r.readAsText(file);
});

// A new source clears the old wizard's leftovers but keeps the bankroll pick.
function freshForSource() {
  wiz.mePicks = {};
  wiz.nickname = '';
  wiz.dateOrder = null;
  wiz.pn = null;
  wiz.pnErrors = [];
  wiz.analysis = null;
  wiz.build = null;
  wiz.result = null;
}

async function handleFile(root, doc, file) {
  freshForSource();
  wiz.fileName = file.name;
  wiz.fileMime = file.type || '';
  wiz.text = '';
  const ext = extOf(file.name);
  const isImage = (file.type || '').startsWith('image/') || ['png', 'jpg', 'jpeg'].includes(ext);
  const isXlsx = ext === 'xlsx' || (file.type || '').includes('spreadsheet');
  try {
    if (isImage) {
      const dataUrl = await readAs(file, 'dataurl');
      const base64 = String(dataUrl || '').split(',')[1] || '';
      if (!base64) { toast('Could not read that file'); return; }
      await startFlowSource(root, doc, { name: file.name, mime: wiz.fileMime || 'image/png', base64 });
      return;
    }
    if (isXlsx) {
      const buf = await readAs(file, 'buffer');
      const table = await xlsxToRows(buf);
      if (!table) { toast('This spreadsheet could not be read. Save it as CSV and try again.'); return; }
      await startFlowSource(root, doc, {
        name: file.name, mime: wiz.fileMime || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        text: '', headers: table.headers, rows: table.rows,
      });
      return;
    }
    const text = String(await readAs(file, 'text') || '');
    wiz.text = text;
    if (ext === 'csv' || ext === 'tsv' || ext === 'txt' || ext === '') {
      // PokerNow first, then known formats, then the existing mapper.
      detectAndPrepare(root, doc);
      return;
    }
    const t = jsonToTable(text);
    await startFlowSource(root, doc, {
      name: file.name, mime: wiz.fileMime || '', text,
      headers: t ? t.headers : undefined,
      rows: t ? t.rows : undefined,
    });
  } catch (e) {
    console.error('import: read failed', e);
    toast('Could not read that file');
  }
}

async function handlePaste(root, doc, text) {
  freshForSource();
  wiz.fileName = '';
  wiz.fileMime = 'text/plain';
  wiz.text = text;
  // Only a real JSON table becomes headers/rows here: prose keeps the whole
  // text, so the machine can try its instant smart parse before the AI.
  const t = jsonToTable(text);
  await startFlowSource(root, doc, {
    name: '', mime: 'text/plain', text,
    headers: t ? t.headers : undefined,
    rows: t ? t.rows : undefined,
  });
}

// A JSON file that is a flat table becomes { headers, rows }; everything else
// (PA27 exports, nested shapes, prose) travels as text.
function buildCsvTable(text) {
  const a = analyzeCsv(text, {});
  if (!a.ok || !a.records.length || a.columnCount < 2) return null;
  const headers = a.headers || Array.from({ length: a.columnCount }, (_, i) => `Column ${i + 1}`);
  const rows = a.records.filter(r => !r.error).map(r => {
    const o = {};
    headers.forEach((h, i) => { o[h] = r.cells[i] === undefined ? '' : r.cells[i]; });
    return o;
  });
  return { headers, rows };
}

async function startFlowSource(root, doc, payload) {
  const flow = await ensureFlow();
  flow.handle('SOURCE', payload);
  const st = flow.state;
  if (st.phase === 'legacy') {
    // Generic CSV: the existing column mapper handles it (with its toast).
    startGeneric(root, doc);
    if (wiz.pnErrors.length) toast(wiz.pnErrors[0].message || 'Not a PokerNow export, using the column mapper');
    return;
  }
  wiz.step = 'flow';
  renderRouteImport(root, doc);
  if (st.phase === 'ai') runAi(root, doc);
}

async function runAi(root, doc) {
  const flow = wiz.flow;
  const payload = flow.aiPayload();
  if (!payload) {
    flow.handle('AI_UNAVAILABLE');
    renderRouteImport(root, doc);
    return;
  }
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS) : null;
  try {
    const res = await fetch(AI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (timer) clearTimeout(timer);
    if (!res.ok) {
      console.error('import: ai endpoint returned', res.status);
      flow.handle('AI_UNAVAILABLE');
    } else {
      const json = await res.json();
      flow.handle('AI_RESULT', { json });
    }
  } catch (e) {
    if (timer) clearTimeout(timer);
    console.error('import: ai request failed', e);
    flow.handle('AI_UNAVAILABLE');
  }
  renderRouteImport(root, doc);
}

function flowImport(root, doc) {
  const st = wiz.flow.handle('IMPORT');
  if (st.phase === 'committing') {
    const count = acceptedRows(st.previewRows).length;
    wiz.lastCommit.then(res => {
      wiz.flow.handle('COMMITTED', { batchId: res && res.batchId, count });
    }).catch(e => {
      console.error('import: commit failed', e);
      wiz.flow.handle('COMMIT_FAILED');
    }).finally(() => renderRouteImport(root, doc));
  }
  renderRouteImport(root, doc);
}

async function flowUndo(root, doc) {
  const st = wiz.flow.state;
  try {
    if (!wiz.storeNs || typeof wiz.storeNs.undoImport !== 'function') throw new Error('undoImport unavailable');
    await wiz.storeNs.undoImport(getState(), st.batchId);
    toast('Import undone');
  } catch (e) {
    console.error('import: undo failed', e);
    toast('The undo did not complete');
    return;
  }
  wiz.flow.handle('RESET');
  wiz.step = 'pick';
  wiz.flow = null;
  renderRouteImport(root, doc);
}

// --- PokerNow flow ------------------------------------------------------------------

// After a file is chosen: try PokerNow first, then known formats via the flow
// machine, then fall back to the generic mapper.
function detectAndPrepare(root, doc) {
  const r = importPokerNow([{ name: wiz.fileName, text: wiz.text }]);
  if (r.status === 'ok' && r.sessions.length) {
    wiz.pn = r; wiz.step = 'pn-preview';
    renderRouteImport(root, doc);
    return;
  }
  if (r.status === 'ambiguous' || r.status === 'not_found') {
    wiz.pn = r; wiz.step = 'pn-me';
    renderRouteImport(root, doc);
    return;
  }
  // Not a PokerNow file (or an unreadable one): keep the parser's own
  // complaint for the mapper, and let the flow machine look for a known
  // format before handing the table back to the generic mapper.
  wiz.pnErrors = r.errors && r.errors.length ? r.errors : [];
  const table = buildCsvTable(wiz.text);
  startFlowSource(root, doc, {
    name: wiz.fileName || '', mime: wiz.fileMime || 'text/csv', text: wiz.text,
    headers: table ? table.headers : undefined,
    rows: table ? table.rows : undefined,
    legacyGeneric: true,
  });
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
    wiz = { step: 'pick', bankrollId: wiz.bankrollId, mePicks: {}, nickname: '', dateOrder: null, flow: null, storeNs: wiz.storeNs, fileMime: '', pnErrors: [] };
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
