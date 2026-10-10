// Import flow state machine (IT1). Pure module: no DOM, no store, no clock,
// no static imports. It wires the IT1 contracts together as one reviewable
// pipeline:
//
//   detect -> known format instant parse -> AI path -> manual column mapping
//          -> preview (editable rows, duplicates unticked) -> commit -> batch id
//
// Every collaborator is injected through `deps` using the exact contract
// names the parallel lanes implement (js/import-smart.js, js/import-ai.js,
// js/store.js), so the machine is testable in Node before those files land.
// The one side effect, deps.commit(acceptedRows), runs only on the IMPORT
// event: "nothing is written until Import is pressed" is a testable fact of
// the machine, not a promise the screen makes.
//
// Row shape: parsers return rows as flat objects in PA27's session shape.
// The preview reads them through rowView(), tolerating the key spellings the
// different importers produce (start_time/date, cashed_out/cash_out,
// duration_seconds/hours, hands_count/hands). Edits patch canonical keys and
// mirror into whichever alias the row already carries.

export const CONFIDENCE_FLAG_THRESHOLD = 0.7;

// The preview renders every row; pasted text and images cap at 300 rows per
// AI run and huge tables would hang the screen. Above this the screen shows
// the first rows and says so (the cap is a render budget, not a data cut:
// unshown rows still import).
export const PREVIEW_RENDER_CAP = 300;

const CANONICAL_FIELDS = ['type', 'date', 'stakes', 'game', 'location', 'buy_in', 'cash_out', 'profit', 'hours', 'hands'];

// Every canonical field maps to the aliases the different importers emit.
const FIELD_ALIASES = {
  type: ['type', 'kind'],
  date: ['date', 'start_time'],
  stakes: ['stakes'],
  game: ['game', 'game_name'],
  location: ['location', 'location_name'],
  buy_in: ['buy_in', 'buyin'],
  cash_out: ['cash_out', 'cashed_out', 'cashout'],
  profit: ['profit', 'net_result'],
  hours: ['hours', 'duration_hours'],
  hands: ['hands', 'hands_count'],
};

const num = v => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^0-9eE+\-.]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// Tolerant read-view of a raw row for the preview table.
export function rowView(row) {
  const r = row || {};
  const first = (...keys) => {
    for (const k of keys) {
      const v = r[k];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return '';
  };
  let hours = first('hours', 'duration_hours');
  if (hours === '' && r.duration_seconds !== undefined && r.duration_seconds !== null && r.duration_seconds !== '') {
    const sec = num(r.duration_seconds);
    if (sec !== null) hours = sec / 3600;
  }
  return {
    type: String(first('type', 'kind') || 'cash'),
    date: String(first('date', 'start_time')),
    stakes: String(first('stakes')),
    game: String(first('game', 'game_name')),
    location: String(first('location', 'location_name')),
    buyIn: String(first('buy_in', 'buyin')),
    cashOut: String(first('cash_out', 'cashed_out', 'cashout')),
    profit: String(first('profit', 'net_result')),
    hours: String(hours),
    hands: String(first('hands', 'hands_count')),
    confidence: num(r.confidence),
  };
}

// Write one canonical field back to a raw row, mirroring into the alias the
// row already uses so parsers downstream keep reading it.
export function applyEdit(row, field, value) {
  const out = { ...(row || {}) };
  out[field] = value;
  for (const alias of FIELD_ALIASES[field] || [field]) {
    if (alias !== field && out[alias] !== undefined) out[alias] = value;
  }
  return out;
}

// normalizeIndexes: findDuplicates results arrive in whatever shape the store
// lane picked (indexes, booleans, or { indexes }). Accept all three.
function normalizeIndexes(v, n) {
  const set = new Set();
  if (!v) return set;
  const list = Array.isArray(v) ? v : (Array.isArray(v.indexes) ? v.indexes : []);
  for (const item of list) {
    if (typeof item === 'number' && item >= 0 && item < n) set.add(item);
  }
  if (!set.size && list.some(x => typeof x === 'boolean')) {
    list.forEach((x, i) => { if (x && i < n) set.add(i); });
  }
  return set;
}

// Decorate parsed rows for the preview: duplicates start unticked and say
// "Already in your app"; low-confidence rows start unticked too and say
// "Check this" - the brief's summary example ("52 new ... Import 52 sessions")
// counts only rows a commit would actually write at default ticks.
export function decorateRows(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const dups = normalizeIndexes(opts.duplicateIndexes, list.length);
  const confidences = opts.confidences || [];
  return list.map((row, i) => {
    const view = rowView(row);
    const duplicate = dups.has(i);
    const conf = typeof confidences[i] === 'number' ? confidences[i] : view.confidence;
    const check = !duplicate && conf !== null && conf < CONFIDENCE_FLAG_THRESHOLD;
    const labels = [];
    if (duplicate) labels.push('Already in your app');
    if (check) labels.push('Check this');
    return {
      row, index: i, edits: {},
      accepted: !duplicate && !check,
      duplicate, confidence: conf, flag: check, labels,
    };
  });
}

// The counts line and the commit button label. "New" excludes duplicates and
// rows still flagged for a check; the button counts the rows a commit would
// actually write (the user can re-tick a duplicate or clear a flag by editing).
export function summarizePreview(previewRows) {
  const rows = Array.isArray(previewRows) ? previewRows : [];
  let nNew = 0, nDup = 0, nCheck = 0, nAccepted = 0;
  for (const r of rows) {
    if (r.duplicate) nDup++;
    else if (r.flag) nCheck++;
    else nNew++;
    if (r.accepted) nAccepted++;
  }
  const parts = [];
  if (nNew) parts.push(`${nNew} new`);
  if (nDup) parts.push(`${nDup} duplicate${nDup === 1 ? '' : 's'}`);
  if (nCheck) parts.push(`${nCheck} need${nCheck === 1 ? 's' : ''} a check`);
  const text = parts.length ? parts.join(', ') : 'Nothing new to import';
  const button = nAccepted ? `Import ${nAccepted} session${nAccepted === 1 ? '' : 's'}` : '';
  return { total: rows.length, nNew, nDup, nCheck, nAccepted, text, button };
}

// Rows a commit would write: edits win over the raw row.
export function acceptedRows(previewRows) {
  return (previewRows || []).filter(r => r.accepted).map(r => ({ ...(r.row || {}), ...(r.edits || {}) }));
}

// --- JSON / XLSX / PA27 source helpers (mine, pure) -------------------------

// A PA27 export: { app: 'poker-analytics-27', format, exported_at, data }, a
// bare document with a sessions list, or a plain array of sessions. Returns
// the sessions as rows, or null.
export function pa27JsonSessions(text) {
  try {
    const raw = JSON.parse(String(text ?? ''));
    let list = null;
    if (Array.isArray(raw)) {
      list = raw;
    } else if (raw && typeof raw === 'object') {
      const data = raw.data && typeof raw.data === 'object' ? raw.data : raw;
      if (Array.isArray(data.sessions)) list = data.sessions;
    }
    if (!list) return null;
    const sessions = list.filter(s => s && typeof s === 'object' && !Array.isArray(s));
    return sessions.length ? sessions.map(s => ({ ...s })) : null;
  } catch (e) {
    return null;
  }
}

// A JSON file that is a flat table: an array of plain objects. Returns
// { headers, rows } or null (nested shapes go to the AI path as text).
export function jsonToTable(text) {
  let raw;
  try { raw = JSON.parse(String(text ?? '')); } catch (e) { return null; }
  if (!Array.isArray(raw) || !raw.length) return null;
  if (!raw.every(x => x && typeof x === 'object' && !Array.isArray(x))) return null;
  // Table cells must be primitives; nested shapes belong to the AI path.
  const isCell = v => v === null || ['string', 'number', 'boolean'].includes(typeof v);
  if (!raw.every(o => Object.values(o).every(isCell))) return null;
  const headers = [...new Set(raw.flatMap(o => Object.keys(o)))].filter(h => h && h !== '__proto__');
  if (!headers.length) return null;
  // Fill every row out to the header set: missing keys and nulls become ''
  // so the preview table and downstream mappers see a uniform shape.
  return {
    headers,
    rows: raw.map(o => {
      const row = {};
      for (const h of headers) {
        const v = o[h];
        row[h] = v === undefined || v === null ? '' : v;
      }
      return row;
    }),
  };
}

// Minimal XLSX reader (no deps, no build step): enough of the OOXML zip to
// turn the first worksheet into { headers, rows }. Handles stored and deflate
// entries, shared strings, inline strings, and numbers. Date serials are left
// as numbers (the AI mapping or manual mapping reads them).
export async function xlsxToRows(buffer) {
  const files = await unzip(buffer);
  const sheetName = Object.keys(files).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  if (!sheetName) return null;
  const sheet = files[sheetName];
  const sstName = Object.keys(files).find(n => n === 'xl/sharedStrings.xml');
  const shared = sstName ? parseSharedStrings(files[sstName]) : [];
  const grid = parseSheet(sheet, shared);
  if (!grid.length) return null;
  const headerRow = grid.find(r => r.some(c => String(c).trim() !== ''));
  const hIndex = grid.indexOf(headerRow);
  const headers = headerRow.map((h, i) => {
    const name = String(h).trim();
    return name || `Column ${i + 1}`;
  });
  const rows = [];
  for (let i = hIndex + 1; i < grid.length; i++) {
    const cells = grid[i];
    if (cells.every(c => c === '' || c === null || c === undefined)) continue;
    const row = {};
    headers.forEach((h, c) => { row[h] = cells[c] === undefined ? '' : String(cells[c]); });
    rows.push(row);
  }
  return rows.length ? { headers, rows } : null;
}

async function unzip(buffer) {
  // Copy when handed a view (Buffer/typed array) so byte offsets reset;
  // ArrayBuffer inputs wrap at zero.
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(u8.buffer);
  // Scan the tail for the end-of-central-directory record.
  let eocd = -1;
  const eocdFloor = Math.max(0, u8.length - 65557);
  for (let i = u8.length - 22; i >= eocdFloor; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not an XLSX file (zip end record missing).');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    if (dv.getUint32(lho, true) === 0x04034b50) {
      const lNameLen = dv.getUint16(lho + 26, true);
      const lExtraLen = dv.getUint16(lho + 28, true);
      const start = lho + 30 + lNameLen + lExtraLen;
      const raw = u8.subarray(start, start + csize);
      // Every part in an xlsx is text; decode once here so the parsers
      // receive strings whether the entry was stored or deflated.
      files[name] = new TextDecoder().decode(method === 0 ? raw : await inflateRaw(raw));
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

async function inflateRaw(u8) {
  // Browsers decompress natively. Node's DecompressionStream only gained
  // 'deflate-raw' in v21.2; older Node (the test harness) accepts the
  // constructor but fails the stream, so fall back to node:zlib.
  if (typeof DecompressionStream === 'function') {
    try {
      const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) {
      const isNode = typeof process !== 'undefined' && Boolean(process.versions && process.versions.node);
      if (!isNode) throw e;
    }
  }
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    const { inflateRawSync } = await import('node:zlib');
    return new Uint8Array(inflateRawSync(u8));
  }
  throw new Error('This XLSX file could not be decompressed here.');
}

const decodeXml = s => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');

function parseSharedStrings(xml) {
  const out = [];
  const sis = xml.match(/<si(?:\s[^>]*)?>[\s\S]*?<\/si>/g) || [];
  for (const si of sis) {
    const ts = si.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g) || [];
    out.push(ts.map(t => decodeXml(t.replace(/<t(?:\s[^>]*)?>/, '').replace(/<\/t>/, ''))).join(''));
  }
  return out;
}

const colIndex = ref => {
  const letters = String(ref || '').replace(/[^A-Z]/gi, '').toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

function parseSheet(xml, shared) {
  const grid = [];
  const rows = xml.match(/<row(?:\s[^>]*)?>[\s\S]*?<\/row>/g) || [];
  for (const rowXml of rows) {
    const cells = [];
    const cs = rowXml.match(/<c(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/c>)/g) || [];
    for (const cXml of cs) {
      const ref = (cXml.match(/r="([A-Z]+[0-9]+)"/) || [])[1];
      const type = (cXml.match(/t="([^"]+)"/) || [])[1];
      const ci = Math.max(colIndex(ref), 0);
      let value = '';
      if (type === 's') {
        const v = (cXml.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        value = shared[Number(v)] ?? '';
      } else if (type === 'inlineStr') {
        const ts = cXml.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g) || [];
        value = ts.map(t => decodeXml(t.replace(/<t(?:\s[^>]*)?>/, '').replace(/<\/t>/, ''))).join('');
      } else {
        const v = (cXml.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        value = v === undefined ? '' : decodeXml(v);
      }
      cells[ci] = value;
    }
    grid.push(cells);
  }
  const width = grid.reduce((m, r) => Math.max(m, r.length), 0);
  return grid.map(r => Array.from({ length: width }, (_, i) => (r[i] === undefined ? '' : r[i])));
}

// --- the machine -------------------------------------------------------------

function initialState() {
  return {
    phase: 'empty',        // empty | ai | manual | preview | legacy | committed | error
    kind: null,            // table | text | image
    source: null,          // { name, mime, text, base64 }
    format: null,          // bankrollcoach | pa27 | pokernow | pasted | generic | null
    headers: null, rows: null,
    mappingShape: null,
    sessions: [],
    previewRows: [],
    aiUnavailable: false,
    batchId: null,
    committedCount: 0,
    error: null,
  };
}

const safe = (fn, fallback) => {
  try { return fn(); } catch (e) { console.error('import-flow: contract call failed', e); return fallback; }
};

function errorState(state, message) {
  return { ...state, phase: 'error', error: message };
}

function finishParsed(state, sessions, deps) {
  const dup = deps.findDuplicates ? safe(() => deps.findDuplicates(sessions), []) : [];
  const previewRows = decorateRows(sessions, { duplicateIndexes: dup });
  return { ...state, phase: 'preview', sessions, previewRows, error: null };
}

function sourceStep(state, payload, deps) {
  const src = {
    name: String(payload.name || ''),
    mime: String(payload.mime || ''),
    text: typeof payload.text === 'string' ? payload.text : '',
    base64: String(payload.base64 || ''),
  };
  const next = { ...initialState(), source: src };
  const hasTable = Array.isArray(payload.headers) && payload.headers.length > 0 && Array.isArray(payload.rows);

  // Images always need the AI path (no on-device vision).
  if (src.base64) {
    return { ...next, phase: 'ai', kind: 'image', format: null };
  }

  const det = deps.detectFormat
    ? safe(() => deps.detectFormat({ headers: payload.headers, rows: payload.rows, text: src.text }), null) : null;
  const format = det && typeof det === 'object' ? det.format : det;

  // Known formats: instant parse, no AI.
  if (format === 'bankrollcoach' && deps.parseBankrollCoachRows && hasTable) {
    const sessions = safe(() => deps.parseBankrollCoachRows(payload.rows), null);
    if (sessions && sessions.length) return finishParsed({ ...next, format }, sessions, deps);
  }
  if (format === 'pa27') {
    const sessions = src.text ? pa27JsonSessions(src.text) : null;
    if (sessions && sessions.length) return finishParsed({ ...next, format }, sessions, deps);
  }
  if (format === 'pokernow' && typeof deps.parsePokernow === 'function' && src.text) {
    const r = safe(() => deps.parsePokernow([{ name: src.name, text: src.text }]), null);
    if (r && r.status === 'ok' && r.sessions && r.sessions.length) {
      return finishParsed({ ...next, format }, r.sessions.map(d => d.session), deps);
    }
    if (r && (r.status === 'ambiguous' || r.status === 'not_found')) {
      // The screen handles the "which player is you" step itself (legacy flow).
      return { ...next, phase: 'legacy', format };
    }
  }

  // Pasted text: the smart parser reads common formats without AI.
  if (src.text && !hasTable && deps.parsePastedText) {
    const sessions = safe(() => deps.parsePastedText(src.text), null);
    if (sessions && sessions.length) return finishParsed({ ...next, format: 'pasted' }, sessions, deps);
  }

  // A table nobody recognized: AI maps the columns, or the user does.
  if (hasTable) {
    const rows = deps.parseGenericTable
      ? safe(() => deps.parseGenericTable(payload.headers, payload.rows), null)
      : payload.rows;
    if (rows === null) return errorState(next, 'This table could not be read on this device.');
    if (payload.legacyGeneric) return { ...next, phase: 'legacy', format: format || 'generic' };
    return { ...next, phase: 'ai', kind: 'table', format: format || 'generic', headers: payload.headers, rows };
  }

  // Text with no smart parse: AI reads it.
  if (src.text) return { ...next, phase: 'ai', kind: 'text', format: null };

  return errorState(next, 'This file could not be read on this device.');
}

function aiPayloadFor(state, deps) {
  if (state.phase !== 'ai') return null;
  if (state.kind === 'table' && typeof deps.buildTableRequest === 'function') {
    return safe(() => deps.buildTableRequest(state.headers, state.rows), null);
  }
  if (state.kind === 'text') return { kind: 'text', text: state.source.text };
  if (state.kind === 'image') return { kind: 'image', dataBase64: state.source.base64, mime: state.source.mime };
  return null;
}

function reduce(state, type, payload, deps) {
  switch (type) {
    case 'SOURCE':
      return sourceStep(state, payload, deps);

    case 'AI_RESULT': {
      if (state.phase !== 'ai') return state;
      const rows = deps.rowsFromAi ? safe(() => deps.rowsFromAi(payload.json), null) : null;
      if (!rows || !rows.length) {
        return errorState(state, 'The AI reply had no readable rows. Try again, or read the file with the column mapper.');
      }
      return finishParsed({ ...state, kind: state.kind || 'text' }, rows, deps);
    }

    case 'AI_UNAVAILABLE': {
      if (state.phase !== 'ai') return state;
      // Tables can fall back to manual column mapping; text and images cannot.
      if (state.kind === 'table' && state.headers && typeof deps.manualMappingShape === 'function') {
        const shape = safe(() => deps.manualMappingShape(state.headers), null);
        if (shape) return { ...state, phase: 'manual', aiUnavailable: true, mappingShape: shape, error: null };
      }
      const why = state.kind === 'image'
        ? 'AI is not available right now, so images cannot be read. Known file formats still import without AI.'
        : 'AI is not available right now, so this text cannot be read automatically. Known file formats still import without AI.';
      return errorState(state, why);
    }

    case 'MAPPING': {
      if (state.phase !== 'manual' || !state.rows) return state;
      const mapping = payload.mapping || {};
      let sessions = deps.applyMapping
        ? safe(() => deps.applyMapping(state.rows, mapping), null) : null;
      if (!sessions || !sessions.length) {
        return errorState(state, 'This mapping did not produce readable rows. Check the picks and try again.');
      }
      sessions = sessions.map(s => {
        if (s && typeof s === 'object' && typeof s.confidence === 'number') return s;
        const c = typeof deps.scoreConfidence === 'function'
          ? safe(() => deps.scoreConfidence(s, mapping), null) : null;
        return { ...s, confidence: typeof c === 'number' ? c : undefined };
      });
      return finishParsed({ ...state }, sessions, deps);
    }

    case 'EDIT_ROW': {
      if (state.phase !== 'preview') return state;
      const pr = state.previewRows[payload.index];
      if (!pr) return state;
      const edits = { ...pr.edits };
      for (const f of CANONICAL_FIELDS) {
        if (payload.patch && payload.patch[f] !== undefined) edits[f] = payload.patch[f];
      }
      let row = pr.row;
      for (const [f, v] of Object.entries(edits)) row = applyEdit(row, f, v);
      // Reviewing a flagged row by editing it ticks it for import (it was only
      // unticked pending the check). Duplicates keep their tick state.
      const wasFlagged = pr.flag;
      const labels = pr.labels.filter(l => l !== 'Check this');
      const accepted = wasFlagged && !pr.duplicate ? true : pr.accepted;
      const previewRows = state.previewRows.slice();
      previewRows[payload.index] = { ...pr, row, edits, flag: false, labels, accepted };
      return { ...state, previewRows, error: null };
    }

    case 'TOGGLE_ROW': {
      if (state.phase !== 'preview') return state;
      const pr = state.previewRows[payload.index];
      if (!pr) return state;
      const previewRows = state.previewRows.slice();
      previewRows[payload.index] = { ...pr, accepted: Boolean(payload.accepted) };
      return { ...state, previewRows, error: null };
    }

    case 'IMPORT': {
      if (state.phase !== 'preview') return state;
      const rows = acceptedRows(state.previewRows);
      if (!rows.length) {
        return { ...state, error: 'Nothing to import yet. Tick at least one row.' };
      }
      if (typeof deps.commit !== 'function') {
        return errorState(state, 'Import is not available right now.');
      }
      const res = deps.commit(rows);
      const batchId = res && typeof res.then === 'function' ? null : (res && res.batchId) || null;
      if (res && typeof res.then === 'function') {
        // The screen resolves async commits and reports back with COMMITTED.
        return { ...state, phase: 'committing', error: null };
      }
      if (!batchId) return errorState(state, 'The import did not complete. Nothing was changed.');
      return { ...state, phase: 'committed', batchId, committedCount: rows.length, error: null };
    }

    case 'COMMITTED': {
      // Async commit resolved (screen-reported). No batch id means the store
      // contract refused the batch: nothing was written.
      if (state.phase !== 'committing') return state;
      if (!payload.batchId) return errorState(state, 'The import did not complete. Nothing was changed.');
      return { ...state, phase: 'committed', batchId: payload.batchId, committedCount: payload.count || 0, error: null };
    }

    case 'COMMIT_FAILED': {
      if (state.phase !== 'committing') return state;
      return errorState(state, 'The import did not complete. Nothing was changed.');
    }

    case 'RESET':
      return initialState();

    default:
      return state;
  }
}

// The factory. deps (all optional, all contract names):
//   detectFormat({headers, rows, text}) -> { format } | null
//   parseBankrollCoachRows(rows) -> sessions
//   parsePastedText(text) -> sessions | null
//   parseGenericTable(headers, rows) -> rows | null
//   buildTableRequest(headers, rows) -> AI request payload
//   applyMapping(rows, mapping) -> sessions
//   scoreConfidence(session, mapping) -> 0..1
//   rowsFromAi(json) -> sessions
//   manualMappingShape(headers) -> shape for the mapping screen
//   findDuplicates(rows) -> duplicate indexes (adapter around store.findDuplicates)
//   parsePokernow(files) -> legacy importer result (adapter)
//   commit(acceptedRows) -> { batchId } (adapter around stageImport+commitImport;
//        may be async, in which case the screen reports back with COMMITTED)
export function createImportFlow(deps = {}) {
  let state = initialState();
  return {
    get state() { return state; },
    handle(type, payload = {}) { state = reduce(state, type, payload, deps); return state; },
    needsAi() { return state.phase === 'ai'; },
    aiPayload() { return aiPayloadFor(state, deps); },
  };
}
