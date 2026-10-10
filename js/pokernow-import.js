// PokerNow CSV import parser — PURE module (no store, stats, DOM or network).
//
// Turns PokerNow exports into session drafts shaped like the brief's Session
// model (section 4). Two real export formats are understood; provenance and
// sample lines live in docs/pokernow-format.md:
//
//   1. Session ledger  — player_nickname,player_id,session_start_at,
//      session_end_at,buy_in,buy_out,stack[,nit_escrow],net
//      One row per *seat session*: a player who quits and rejoins gets another
//      row. A blank session_end_at means "still seated at export".
//   2. Full game log   — entry,at,order. Free-text event lines (hands, blinds,
//      joins, quits, admin stack changes). Gives stakes, game variant, hands
//      count, table size and exact stack-change times, which the ledger lacks.
//
// Money in the ledger is authoritative; the log enriches it. Either file works
// alone. Nothing here assigns database ids: the caller (store wiring) resolves
// game_name / location_name to ids and writes the rows.

// --- constants ----------------------------------------------------------------

export const LEDGER_COLUMNS = ['player_nickname', 'player_id', 'session_start_at', 'session_end_at', 'buy_in', 'buy_out', 'stack', 'nit_escrow', 'net'];
export const LOG_COLUMNS = ['entry', 'at', 'order'];

const LEDGER_REQUIRED = ['player_nickname', 'player_id', 'buy_in'];
const BOM = '\uFEFF';
const MONEY_EPS = 0.005;
// Ledger and log stamp the same seat event a few ms apart.
const MATCH_MS = 5000;

// PokerNow variant strings → app game names. The first three are observed in
// real logs; the rest follow the same naming pattern (see the format note).
const VARIANTS = [
  [/^no limit texas hold'?em$/i, "NL Hold'em"],
  [/^pot limit omaha hi$/i, 'PLO'],
  [/^pot limit omaha 5 hi$/i, 'PLO5'],
  [/^pot limit omaha 6 hi$/i, 'PLO6'],
  [/^pot limit omaha (?:hi\/lo|hi-lo|8)/i, 'PLO Hi-Lo'],
  [/^limit texas hold'?em$/i, "Limit Hold'em"],
];

export function mapVariant(raw) {
  const name = String(raw || '').trim();
  if (!name) return null;
  for (const [re, mapped] of VARIANTS) if (re.test(name)) return mapped;
  return name;
}

// --- small pure helpers ---------------------------------------------------------

const round2 = n => Math.round(n * 100) / 100;
const sum = xs => xs.reduce((a, b) => a + b, 0);
const norm = s => String(s ?? '').trim().toLowerCase();

function mode(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null, bestN = 0;
  for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
  return { value: best, counts };
}

function issue(code, message, extra = {}) {
  return { code, message, ...extra };
}

// Minimal RFC-4180 reader: quoted fields, doubled quotes, embedded commas and
// newlines (PokerNow's "Game Config Changes" entries span several lines).
export function parseCsv(text) {
  const src = String(text ?? '').startsWith(BOM) ? String(text).slice(1) : String(text ?? '');
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(x => x.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(x => x.trim() !== '')) rows.push(row);
  return rows;
}

export function detectPokerNowFormat(text) {
  const first = parseCsv(String(text ?? '').split(/\r?\n/, 1)[0] || '')[0] || [];
  const cols = first.map(norm);
  if (LOG_COLUMNS.every(c => cols.includes(c))) return 'log';
  if (cols.includes('player_nickname') || cols.includes('player_id')) return 'ledger';
  return 'unknown';
}

// PokerNow file names embed the game id: ledger_pglXXXX.csv and
// poker_now_log_pglXXXX.csv (browsers may append " (1)").
export function tableIdFromFileName(name) {
  const m = /(?:^|[\\/])(?:ledger_|poker_now_log_)([A-Za-z0-9_-]+?)(?: \(\d+\))?\.csv$/i.exec(String(name || ''));
  return m ? m[1] : null;
}

// --- timestamps -----------------------------------------------------------------

// Offset (ms) of an IANA zone at a UTC instant, via Intl (no dependencies).
function zoneOffsetMs(timeZone, utcMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

function fixedOffsetMs(tz) {
  const m = /^(?:UTC|GMT)?([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(tz);
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) * 60000;
}

export function validTimeZone(tz) {
  if (tz == null || /^(utc|gmt|z)$/i.test(tz)) return true;
  if (fixedOffsetMs(tz) !== null) return true;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// Wall-clock fields interpreted in `tz` → UTC ms.
function wallToUtc(f, tz) {
  const naive = Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s, f.ms);
  if (tz == null || /^(utc|gmt|z)$/i.test(tz)) return naive;
  const fixed = fixedOffsetMs(tz);
  if (fixed !== null) return naive - fixed;
  // Two passes settle DST edges: guess with the offset at the naive instant,
  // then re-read the offset at the corrected instant.
  let utc = naive - zoneOffsetMs(tz, naive);
  utc = naive - zoneOffsetMs(tz, utc);
  return utc;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
const SLASH_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i;

// Parses a PokerNow timestamp. Real exports are ISO-8601 UTC ("...Z"); values
// with an explicit offset are honoured; naive values (e.g. after a round trip
// through a spreadsheet) are read in `opts.timeZone` and flagged `naive`.
// Returns { ms, naive } or null when unparseable.
export function parseTimestamp(raw, opts = {}) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let m = ISO_RE.exec(s);
  if (m) {
    const f = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] || 0), ms: Number((m[7] || '0').padEnd(3, '0').slice(0, 3)) };
    if (!validWall(f)) return null;
    if (m[8]) {
      const off = m[8].toUpperCase() === 'Z' ? 0 : fixedOffsetMs(m[8].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2'));
      return { ms: Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s, f.ms) - off, naive: false };
    }
    return { ms: wallToUtc(f, opts.timeZone), naive: true };
  }
  m = SLASH_RE.exec(s);
  if (m) {
    let a = +m[1], b = +m[2];
    // Spreadsheet locales disagree on day/month order; an impossible month
    // decides it, otherwise the configured order wins.
    const dmy = a > 12 || (opts.dateOrder === 'DMY' && b <= 12);
    const [mo, d] = dmy ? [b, a] : [a, b];
    let h = +m[4];
    if (m[7]) h = (h % 12) + (m[7].toUpperCase() === 'PM' ? 12 : 0);
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const f = { y, mo, d, h, mi: +m[5], s: +(m[6] || 0), ms: 0 };
    if (!validWall(f)) return null;
    return { ms: wallToUtc(f, opts.timeZone), naive: true };
  }
  return null;
}

function validWall(f) {
  if (f.mo < 1 || f.mo > 12 || f.d < 1 || f.h > 23 || f.mi > 59 || f.s > 59) return false;
  const dt = new Date(Date.UTC(f.y, f.mo - 1, f.d));
  return dt.getUTCMonth() === f.mo - 1 && dt.getUTCDate() === f.d;
}

const iso = ms => (ms == null ? null : new Date(ms).toISOString());

// --- ledger ---------------------------------------------------------------------

function parseMoney(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return { value: null, ok: true };
  if (!/^-?\d+(?:\.\d+)?$/.test(s)) return { value: null, ok: false };
  return { value: Number(s), ok: true };
}

// Parses a ledger CSV into raw rows (amounts in the ledger's own unit).
// Never throws on bad data: problems come back in `errors` / `warnings`.
export function parsePokerNowLedger(text, opts = {}) {
  const errors = [], warnings = [];
  const table = parseCsv(text);
  if (!table.length) return { columns: [], rows: [], errors: [issue('empty_file', 'Ledger file is empty.')], warnings };
  const header = table[0].map(norm);
  const idx = Object.fromEntries(header.map((c, i) => [c, i]));
  const missing = LEDGER_REQUIRED.filter(c => !(c in idx));
  if (!('buy_out' in idx) && !('stack' in idx) && !('net' in idx)) missing.push('buy_out|stack|net');
  if (missing.length) {
    return { columns: header, rows: [], errors: [issue('missing_column', `Ledger is missing required column(s): ${missing.join(', ')}.`, { columns: missing })], warnings };
  }
  for (const c of ['session_start_at', 'session_end_at']) {
    if (!(c in idx)) warnings.push(issue('missing_column', `Ledger has no ${c} column; times must come from the game log.`, { columns: [c] }));
  }
  const cell = (r, c) => (c in idx ? r[idx[c]] ?? '' : '');
  const rows = [];
  table.slice(1).forEach((r, i) => {
    const line = i + 2;
    const money = {};
    const bad = [];
    for (const c of ['buy_in', 'buy_out', 'stack', 'nit_escrow', 'net']) {
      const p = parseMoney(cell(r, c));
      if (!p.ok) bad.push(c);
      money[c] = p.value;
    }
    const start = parseTimestamp(cell(r, 'session_start_at'), opts);
    const end = parseTimestamp(cell(r, 'session_end_at'), opts);
    const badTime = [];
    if (cell(r, 'session_start_at').trim() && !start) badTime.push('session_start_at');
    if (cell(r, 'session_end_at').trim() && !end) badTime.push('session_end_at');
    const row = {
      line,
      nickname: cell(r, 'player_nickname').trim(),
      player_id: cell(r, 'player_id').trim(),
      start_ms: start ? start.ms : null,
      end_ms: end ? end.ms : null,
      naive_time: !!((start && start.naive) || (end && end.naive)),
      // Without a session_end_at column, a blank buy_out is the only "still
      // seated" signal left.
      open: 'session_end_at' in idx ? !cell(r, 'session_end_at').trim() : money.buy_out === null,
      buy_in: money.buy_in ?? 0,
      buy_out: money.buy_out ?? 0,
      stack: money.stack ?? 0,
      nit_escrow: money.nit_escrow ?? 0,
      net: money.net,
      invalid: [...bad, ...badTime],
    };
    // Some exports carry neither buy_out nor stack; recover cash-out from net.
    if (!('buy_out' in idx) && !('stack' in idx) && row.net !== null) {
      if (row.open) row.stack = row.buy_in + row.net; else row.buy_out = row.buy_in + row.net;
    }
    if (row.net !== null && !row.invalid.length) {
      const computed = row.buy_out + row.stack + row.nit_escrow - row.buy_in;
      if (Math.abs(computed - row.net) > MONEY_EPS) {
        warnings.push(issue('net_mismatch', `Ledger row ${line}: buy_out + stack - buy_in = ${round2(computed)} but net column says ${row.net}; using the components.`, { row: line }));
      }
    }
    rows.push(row);
  });
  return { columns: header, rows, errors, warnings };
}

// --- game log -------------------------------------------------------------------

const P = '"(.*?) @ ([^"\\s]+)"';
// Amounts end in a sentence period ("stack of 50.00."), so a greedy [\d.]+
// would swallow it; match the number shape exactly.
const N = '(\\d+(?:\\.\\d+)?)';
const RE = {
  start: /^-- starting hand #(\d+)\s*(?:\(id: ([^)]+)\))?\s*(?:\((.+?)\)|([^()]+?))\s*\((?:dealer: "(.*)"|dead button)\) --$/,
  end: /^-- ending hand #(\d+) --$/,
  stacks: /^Player stacks: /,
  seat: new RegExp(`#(\\d+) ${P} \\(${N}\\)`, 'g'),
  // A short-stacked all-in blind post is not the blind level.
  blind: new RegExp(`^${P} posts a (small|big) blind of ${N}(?![\\d.]| and go all in)`),
  yourHand: /^Your hand is (.+)$/,
  shows: new RegExp(`^${P} shows a (.+?)\\.?$`),
  approved: new RegExp(`^The admin approved the player ${P} participation with a stack of ${N}\\.?$`),
  joined: new RegExp(`^The player ${P} joined the game with a stack of ${N}\\.?$`),
  quits: new RegExp(`^The player ${P} quits the game with a stack of ${N}\\.?$`),
  standUp: new RegExp(`^The player ${P} stand up with the stack of ${N}\\.?$`),
  sitBack: new RegExp(`^The player ${P} sit back with the stack of ${N}\\.?$`),
  updated: new RegExp(`^The admin updated the player ${P} stack from ${N} to ${N}\\.?$`),
  idChange: new RegExp(`^The player ${P} changed the ID from (\\S+) to (\\S+) because`),
  blindChange: /^The game's (small|big) blind was changed from (\d+(?:\.\d+)?) to (\d+(?:\.\d+)?)/,
  variant: /^Poker variant defined as "(.+?)"/,
  configVariant: /\* Poker Variant: .*? » (.+)$/m,
};

// Parses a full game log into hands and per-player money/seat events.
export function parsePokerNowLog(text, opts = {}) {
  const errors = [], warnings = [];
  const table = parseCsv(text);
  if (!table.length) return emptyLog([issue('empty_file', 'Log file is empty.')]);
  const header = table[0].map(norm);
  const missing = LOG_COLUMNS.filter(c => !header.includes(c));
  if (missing.includes('entry') || missing.includes('at')) {
    return emptyLog([issue('missing_column', `Log is missing required column(s): ${missing.join(', ')}.`, { columns: missing })]);
  }
  const iE = header.indexOf('entry'), iA = header.indexOf('at'), iO = header.indexOf('order');
  const lines = [];
  table.slice(1).forEach((r, i) => {
    const t = parseTimestamp(r[iA], opts);
    if (!t) { warnings.push(issue('bad_timestamp', `Log line ${i + 2}: unreadable time "${r[iA]}"; line skipped.`, { row: i + 2 })); return; }
    const order = iO >= 0 && /^\d+$/.test(String(r[iO]).trim()) ? Number(r[iO]) : null;
    lines.push({ entry: String(r[iE] ?? ''), ms: t.ms, naive: t.naive, order, seq: i });
  });
  // Exports are newest-first; `order` breaks ties between same-millisecond
  // lines. Fall back to reversed file order when `order` is absent.
  lines.sort((a, b) => (a.ms - b.ms) || ((a.order ?? -a.seq) - (b.order ?? -b.seq)));

  const aliases = new Map();        // old id -> new id
  const nicknames = new Map();      // id -> Set(nickname)
  const events = [];                // money/seat events, chronological
  const hands = [];
  let hand = null, variant = null, decimals = false;

  const seen = (name, id) => {
    if (!nicknames.has(id)) nicknames.set(id, new Set());
    nicknames.get(id).add(name);
  };
  const amount = s => { if (/\.\d/.test(s)) decimals = true; return Number(s); };

  for (const l of lines) {
    const e = l.entry;
    let m;
    if ((m = RE.start.exec(e))) {
      const v = (m[3] || m[4] || '').trim();
      if (v) variant = v;
      hand = { number: Number(m[1]), hand_id: m[2] || null, variant, ms: l.ms, seats: [], sb: null, bb: null, mine: false, my_cards: null, shown: [] };
      hands.push(hand);
      continue;
    }
    if (RE.end.test(e)) { hand = null; continue; }
    if (hand && RE.stacks.test(e)) {
      for (const s of e.matchAll(RE.seat)) {
        seen(s[2], s[3]);
        hand.seats.push({ seat: Number(s[1]), nickname: s[2], player_id: s[3], stack: amount(s[4]) });
      }
      continue;
    }
    if (hand && (m = RE.blind.exec(e))) {
      const v = amount(m[4]);
      if (m[3] === 'small') hand.sb = v; else hand.bb = v;
      continue;
    }
    if (hand && (m = RE.yourHand.exec(e))) { hand.mine = true; hand.my_cards = cardKey(m[1]); continue; }
    if (hand && (m = RE.shows.exec(e))) { hand.shown.push({ player_id: m[2], cards: cardKey(m[3]) }); continue; }
    if ((m = RE.approved.exec(e))) { seen(m[1], m[2]); events.push({ kind: 'approve', player_id: m[2], amount: amount(m[3]), ms: l.ms }); continue; }
    if ((m = RE.joined.exec(e))) { seen(m[1], m[2]); events.push({ kind: 'join', player_id: m[2], amount: amount(m[3]), ms: l.ms }); continue; }
    if ((m = RE.quits.exec(e))) { seen(m[1], m[2]); events.push({ kind: 'quit', player_id: m[2], amount: amount(m[3]), ms: l.ms }); continue; }
    if ((m = RE.standUp.exec(e))) { events.push({ kind: 'stand', player_id: m[2], amount: amount(m[3]), ms: l.ms }); continue; }
    if ((m = RE.sitBack.exec(e))) { events.push({ kind: 'sit', player_id: m[2], amount: amount(m[3]), ms: l.ms }); continue; }
    if ((m = RE.updated.exec(e))) {
      events.push({ kind: 'adjust', player_id: m[2], from: amount(m[3]), to: amount(m[4]), ms: l.ms });
      continue;
    }
    if ((m = RE.idChange.exec(e))) { seen(m[1], m[4]); aliases.set(m[3], m[4]); continue; }
    if ((m = RE.variant.exec(e)) || (m = RE.configVariant.exec(e))) { variant = m[1].trim(); continue; }
    if ((m = RE.blindChange.exec(e))) { amount(m[3]); continue; }
  }

  // Hands whose blinds were not posted (dead SB) inherit the last known level.
  let lastSb = null;
  for (const h of hands) { if (h.sb == null) h.sb = lastSb; else lastSb = h.sb; }

  const canon = id => { let c = id, guard = 0; while (aliases.has(c) && guard++ < 20) c = aliases.get(c); return c; };
  for (const h of hands) for (const s of h.seats) s.player_id = canon(s.player_id);
  for (const ev of events) ev.player_id = canon(ev.player_id);
  for (const h of hands) for (const x of h.shown) x.player_id = canon(x.player_id);
  const names = new Map();
  for (const [id, set] of nicknames) {
    const c = canon(id);
    if (!names.has(c)) names.set(c, new Set());
    for (const n of set) names.get(c).add(n);
  }

  // The exporting account sees "Your hand is ..." in every hand it is dealt.
  // Strongest signal: a showdown revealing exactly those cards. Fallback: the
  // only player seated in every such hand.
  let exporter = null;
  const mineHands = hands.filter(h => h.mine);
  const votes = new Map();
  for (const h of mineHands) for (const x of h.shown) if (x.cards === h.my_cards) votes.set(x.player_id, (votes.get(x.player_id) || 0) + 1);
  if (votes.size === 1) exporter = [...votes.keys()][0];
  else if (mineHands.length) {
    let ids = new Set(mineHands[0].seats.map(s => s.player_id));
    for (const h of mineHands.slice(1)) ids = new Set(h.seats.map(s => s.player_id).filter(id => ids.has(id)));
    if (ids.size === 1) exporter = [...ids][0];
  }

  return {
    hands, events, errors, warnings,
    aliases: Object.fromEntries([...aliases].map(([k]) => [k, canon(k)])),
    nicknames: Object.fromEntries([...names].map(([id, s]) => [id, [...s]])),
    exporter_id: exporter,
    decimal_chips: decimals,
    first_ms: lines.length ? lines[0].ms : null,
    last_ms: lines.length ? lines[lines.length - 1].ms : null,
    naive_time: lines.some(l => l.naive),
    canon,
  };
}

// Order-independent card key: "K♦, Q♠" and "Q♠, K♦" compare equal.
function cardKey(raw) {
  return String(raw).split(',').map(c => c.trim()).filter(Boolean).sort().join(',');
}

function emptyLog(errors) {
  return { hands: [], events: [], errors, warnings: [], aliases: {}, nicknames: {}, exporter_id: null, decimal_chips: false, first_ms: null, last_ms: null, naive_time: false, canon: id => id };
}

// Rebuilds seat segments (join → quit) for one player from log events.
// Buy-in rules match the ledger: the stack you join with, plus positive admin
// stack updates; negative updates and the quit stack are buy-outs.
export function logSegments(log, playerId) {
  const segs = [];
  let cur = null;
  for (const ev of log.events) {
    if (ev.player_id !== playerId || ev.kind === 'approve') continue;
    if (ev.kind === 'join') {
      // Game restarts and "sit back" re-emit "joined" for seated players.
      if (cur) continue;
      cur = { player_id: playerId, start_ms: ev.ms, end_ms: null, buy_in: ev.amount, buy_out: 0, stack: null, breaks: [], standing: null,
        events: [{ kind: 'buy_in', amount: ev.amount, ms: ev.ms }] };
      segs.push(cur);
    } else if (!cur) {
      continue; // pre-seat approvals / stack resets are folded into the join amount
    } else if (ev.kind === 'adjust') {
      const d = ev.to - ev.from;
      if (d > 0) { cur.buy_in += d; cur.events.push({ kind: 'top_up', amount: d, ms: ev.ms }); }
      if (d < 0) { cur.buy_out += -d; cur.events.push({ kind: 'cash_out', amount: -d, ms: ev.ms }); }
    } else if (ev.kind === 'stand') {
      cur.standing = ev.ms;
    } else if (ev.kind === 'sit') {
      if (cur.standing != null) cur.breaks.push([cur.standing, ev.ms]);
      cur.standing = null;
    } else if (ev.kind === 'quit') {
      if (cur.standing != null) { cur.breaks.push([cur.standing, ev.ms]); cur.standing = null; }
      cur.end_ms = ev.ms;
      cur.buy_out += ev.amount;
      if (ev.amount > 0) cur.events.push({ kind: 'cash_out', amount: ev.amount, ms: ev.ms });
      cur = null;
    }
  }
  if (cur) {
    // Still seated at export: last observed stack is the best "current" value.
    const last = [...log.hands].reverse().find(h => h.seats.some(s => s.player_id === playerId));
    cur.stack = last ? last.seats.find(s => s.player_id === playerId).stack : null;
    if (cur.standing != null && log.last_ms != null) cur.breaks.push([cur.standing, log.last_ms]);
  }
  return segs;
}

// --- me resolution ----------------------------------------------------------------

function meList(config) {
  const raw = config.me == null ? [] : Array.isArray(config.me) ? config.me : [config.me];
  return raw.map(x => String(x).trim()).filter(Boolean);
}

// Candidates: Map canonical id -> { player_id, nicknames:Set }.
function collectPlayers(ledger, log) {
  const players = new Map();
  const add = (id, name) => {
    if (!id) return;
    if (!players.has(id)) players.set(id, { player_id: id, nicknames: new Set() });
    if (name) players.get(id).nicknames.add(name);
  };
  if (ledger) for (const r of ledger.rows) add(log ? log.canon(r.player_id) : r.player_id, r.nickname);
  if (log) for (const [id, ns] of Object.entries(log.nicknames)) for (const n of ns) add(id, n);
  return players;
}

// Returns { status: 'ok'|'ambiguous'|'not_found', ids, via, candidates }.
export function resolveMe(players, config, log) {
  const wanted = meList(config);
  if (!wanted.length) {
    if (log && log.exporter_id && players.has(log.exporter_id)) return { status: 'ok', ids: [log.exporter_id], via: 'log_exporter' };
    return { status: 'not_found', ids: [], via: 'none' };
  }
  const canon = log ? log.canon : (id => id);
  const byId = new Set(), byName = new Set();
  for (const w of wanted) {
    if (players.has(canon(w))) byId.add(canon(w));
    for (const p of players.values()) if ([...p.nicknames].some(n => norm(n) === norm(w))) byName.add(p.player_id);
  }
  // An explicit player id is never ambiguous; it pins identity outright.
  if (byId.size) return { status: 'ok', ids: [...byId], via: 'player_id' };
  if (!byName.size) return { status: 'not_found', ids: [], via: 'nickname' };
  if (byName.size === 1) return { status: 'ok', ids: [...byName], via: 'nickname' };
  if (log && log.exporter_id && byName.has(log.exporter_id)) return { status: 'ok', ids: [log.exporter_id], via: 'log_exporter' };
  if (config.duplicateNames === 'merge') return { status: 'ok', ids: [...byName], via: 'nickname_merged' };
  return { status: 'ambiguous', ids: [], via: 'nickname', candidates: [...byName] };
}

// --- session assembly ---------------------------------------------------------------

// Union of [start, end] intervals → total covered ms.
function unionMs(intervals) {
  const xs = intervals.filter(([a, b]) => a != null && b != null && b >= a).sort((p, q) => p[0] - q[0]);
  let total = 0, curA = null, curB = null;
  for (const [a, b] of xs) {
    if (curB == null || a > curB) { if (curB != null) total += curB - curA; curA = a; curB = b; }
    else if (b > curB) curB = b;
  }
  if (curB != null) total += curB - curA;
  return total;
}

function overlaps(a, b) {
  for (const x of a) for (const y of b) {
    const xe = x.end_ms ?? Infinity, ye = y.end_ms ?? Infinity;
    if (x.start_ms < ye && y.start_ms < xe) return true;
  }
  return false;
}

function ledgerScale(config, ledger, log, meIds, warnings) {
  const chip = Number(config.chipValue ?? 1);
  if (config.ledgerUnit === 'cents') return 0.01 * chip;
  if (config.ledgerUnit === 'chips') return chip;
  if (log && log.hands.length + log.events.length > 0) {
    // Calibrate against the log: the same join appears in both files.
    for (const id of meIds.concat([...new Set(ledger.rows.map(r => log.canon(r.player_id)))])) {
      const fromLog = logSegments(log, id)[0];
      const row = ledger.rows.filter(r => log.canon(r.player_id) === id && r.start_ms != null).sort((a, b) => a.start_ms - b.start_ms)[0];
      if (fromLog && row && fromLog.buy_in > 0) {
        const ratio = row.buy_in / fromLog.buy_in;
        if (Math.abs(ratio - 100) < 0.5) return 0.01 * chip;
        if (Math.abs(ratio - 1) < 0.01) return chip;
      }
    }
    return (log.decimal_chips ? 0.01 : 1) * chip;
  }
  warnings.push(issue('ledger_unit_assumed', 'No game log to calibrate the ledger unit; amounts read as chips. PokerNow writes cents (x100) when the table uses decimal chips — pass ledgerUnit: "cents" if so.'));
  return chip;
}

function blankSession(config) {
  const d = config.defaults || {};
  return {
    kind: 'cash',
    game_id: null, game_name: d.game_name ?? null,
    location_id: null, location_name: d.location_name ?? 'PokerNow',
    bankroll_id: d.bankroll_id ?? null, group_id: d.group_id ?? null,
    table_size: d.table_size ?? null,
    start_time: null, end_time: null, duration_seconds: null, break_seconds: 0,
    hands_count: null, hands_count_estimated: false,
    comment: null, opponents: null,
    is_live: false, tracked_via_stack: false,
    small_blind: d.small_blind ?? null, big_blind: d.big_blind ?? null,
    buy_in: null, cashed_out: null, tips: 0,
  };
}

// Builds one session for "me" at one table from segments (already in currency).
function assemble({ segs, log, meIds, config, tableId, ledgerUsed, warnings }) {
  const s = blankSession(config);
  const open = segs.some(g => g.end_ms == null);
  const start = Math.min(...segs.map(g => g.start_ms));
  const maxEnd = Math.max(...segs.filter(g => g.end_ms != null).map(g => g.end_ms));
  const buyIn = round2(sum(segs.map(g => g.buy_in)));
  const boughtOut = round2(sum(segs.map(g => g.buy_out)));
  const openStack = round2(sum(segs.filter(g => g.end_ms == null).map(g => g.stack ?? 0)));
  const closedStack = round2(sum(segs.filter(g => g.end_ms != null).map(g => g.stack ?? 0)));
  let closeAt = null;
  if (open && config.openSeats === 'close') {
    const at = config.exportedAt != null ? parseTimestamp(config.exportedAt, config) : null;
    closeAt = at ? at.ms : (log && log.last_ms != null ? log.last_ms : null);
    if (closeAt == null) warnings.push(issue('cannot_close_open_seat', 'openSeats is "close" but no export time is known (no log, no exportedAt); left the session live.'));
  }
  const live = open && closeAt == null;
  const end = live ? null : Math.max(open ? closeAt : -Infinity, maxEnd);

  s.start_time = iso(start);
  // Two accounts resolved as "me" sat at the same table at the same time.
  const concurrent = segs.some((a, i) => segs.some((b, j) => j > i && a.player_id !== b.player_id && overlaps([a], [b])));
  if (concurrent) {
    warnings.push(issue('concurrent_seats', `"Me" held more than one seat at once (${[...new Set(segs.map(g => g.player_id))].join(', ')}); results are summed into one session.`, { table_id: tableId }));
  }

  const breaks = segs.flatMap(g => g.breaks || []);
  if (!live) {
    const closed = segs.map(g => ({ ...g, end_ms: g.end_ms ?? end }));
    const span = end - start;
    const played = unionMs(closed.map(g => [g.start_ms, g.end_ms]));
    const standing = unionMs(breaks.map(([a, b]) => [a, Math.min(b, end)]));
    s.end_time = iso(end);
    s.duration_seconds = Math.round(span / 1000);
    s.break_seconds = Math.max(0, Math.round((span - played + standing) / 1000));
    s.buy_in = buyIn;
    s.cashed_out = round2(boughtOut + closedStack + (open ? openStack : 0));
  } else {
    s.is_live = true;
    s.tracked_via_stack = true;
    // The live timer runs from start_time, so time already spent off the
    // table (between seats, or standing up) is banked as break time.
    const lastStart = Math.max(...segs.map(g => g.start_ms));
    const seated = unionMs(segs.map(g => [g.start_ms, g.end_ms ?? lastStart]));
    const standing = unionMs(breaks.map(([a, b]) => [a, b]));
    s.break_seconds = Math.max(0, Math.round((lastStart - start - seated + standing) / 1000));
  }
  s.comment = `Imported from PokerNow${tableId ? ` game ${tableId}` : ''}`;

  // Stack events only for live sessions (brief: single source of truth).
  let stackEvents = [];
  if (live) {
    const evs = segs.flatMap(g => g.events || []).sort((a, b) => a.ms - b.ms);
    let first = true;
    stackEvents = evs.map(ev => {
      const kind = ev.kind === 'cash_out' ? 'cash_out' : first ? 'buy_in' : 'top_up';
      if (ev.kind !== 'cash_out') first = false;
      // Ledger and log stamp the same join a few ms apart; never before start.
      return { kind, amount: round2(ev.amount), occurred_at: iso(Math.max(ev.ms, start)) };
    });
    if (segs.some(g => g.approx_events)) warnings.push(issue('stack_event_time_approximate', 'Ledger rows only give totals; stack-event times are approximated from seat start/end.', { table_id: tableId }));
  }

  // Log enrichment: stakes, game, hands, table size, opponents.
  const ids = new Set(meIds);
  const myHands = log ? log.hands.filter(h => h.seats.some(x => ids.has(x.player_id))) : [];
  if (myHands.length) {
    s.hands_count = myHands.length;
    s.hands_count_estimated = false;
    s.table_size = Math.min(10, Math.max(2, Math.max(...myHands.map(h => h.seats.length))));
    const stakes = mode(myHands.filter(h => h.bb != null).map(h => `${h.sb ?? ''}/${h.bb}`));
    if (stakes.value) {
      const [sbRaw, bbRaw] = stakes.value.split('/');
      const chip = Number(config.chipValue ?? 1);
      s.big_blind = round2(Number(bbRaw) * chip);
      s.small_blind = sbRaw === '' ? round2(s.big_blind / 2) : round2(Number(sbRaw) * chip);
      if (stakes.counts.size > 1) warnings.push(issue('stakes_changed', `Blinds changed during the session (${[...stakes.counts].map(([k, n]) => `${k} x${n}`).join(', ')}); used the most-played level.`, { table_id: tableId }));
    }
    const games = mode(myHands.map(h => mapVariant(h.variant)).filter(Boolean));
    if (games.value) {
      s.game_name = games.value;
      if (games.counts.size > 1) warnings.push(issue('mixed_games', `Game rotated during the session (${[...games.counts].map(([k, n]) => `${k} x${n}`).join(', ')}); used the most-played game.`, { table_id: tableId }));
    }
    const opp = new Map();
    for (const h of myHands) for (const x of h.seats) if (!ids.has(x.player_id)) opp.set(x.nickname, (opp.get(x.nickname) || 0) + 1);
    if (opp.size) s.opponents = [...opp].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n).join(', ');
  }
  if (s.big_blind == null) warnings.push(issue('stakes_unknown', 'No game log with blinds for this table; stakes left empty (set defaults.small_blind/big_blind or edit after import).', { table_id: tableId }));
  if (s.game_name == null) warnings.push(issue('game_unknown', 'No game variant found; game left empty (set defaults.game_name or pick after import).', { table_id: tableId }));

  return {
    session: s,
    stack_events: stackEvents,
    source: {
      provider: 'pokernow',
      table_id: tableId,
      import_key: `pokernow:${tableId || 'unknown'}:${[...ids].sort().join('+')}:${s.start_time}`,
      player_ids: [...ids],
      money_from: ledgerUsed ? 'ledger' : 'log',
      current_stack: live ? openStack : null,
      segments: segs.length,
    },
  };
}

// --- table-level import ------------------------------------------------------------

function importTable({ ledgerText, logText, tableId, files }, config, carried = []) {
  const warnings = [...carried], errors = [];
  const tag = arr => arr.map(x => ({ ...x, table_id: tableId }));
  const ledger = ledgerText != null ? parsePokerNowLedger(ledgerText, config) : null;
  const log = logText != null ? parsePokerNowLog(logText, config) : null;
  if (ledger) { errors.push(...tag(ledger.errors)); warnings.push(...tag(ledger.warnings)); }
  if (log) { errors.push(...tag(log.errors)); warnings.push(...tag(log.warnings)); }
  const out = { table_id: tableId, files, status: 'ok', sessions: [], warnings, errors, me: null };
  if (errors.length) { out.status = 'invalid'; return out; }

  const ledgerOk = ledger && ledger.rows.length > 0;
  const logOk = log && (log.hands.length > 0 || log.events.length > 0);
  if (!ledgerOk && !logOk) { out.status = 'empty'; warnings.push(issue('no_rows', 'No ledger rows or log events found.', { table_id: tableId })); return out; }

  const players = collectPlayers(ledgerOk ? ledger : null, logOk ? log : null);
  const me = resolveMe(players, config, logOk ? log : null);
  out.me = { ids: me.ids, via: me.via };
  if (me.via === 'log_exporter' && meList(config).length) warnings.push(issue('me_resolved_by_log', `Nickname matched several players; picked ${me.ids[0]}, the account that exported the log.`, { table_id: tableId }));
  if (me.via === 'log_exporter' && !meList(config).length) warnings.push(issue('me_inferred', `No "me" given; used the log exporter ${me.ids[0]}.`, { table_id: tableId }));
  if (me.status === 'ambiguous') {
    out.status = 'ambiguous';
    out.candidates = me.candidates.map(id => describeCandidate(id, players, ledgerOk ? ledger : null, logOk ? log : null));
    warnings.push(issue('ambiguous_me', `"${meList(config).join(', ')}" matches ${me.candidates.length} different players; pass a player_id or duplicateNames: "merge".`, { table_id: tableId }));
    return out;
  }
  if (me.status === 'not_found') { out.status = 'not_found'; warnings.push(issue('me_not_found', `"${meList(config).join(', ') || '(none)'}" did not play at this table.`, { table_id: tableId })); return out; }

  const canon = logOk ? log.canon : (id => id);
  const ids = new Set(me.ids);
  let segs;
  if (ledgerOk) {
    const scale = ledgerScale(config, ledger, logOk ? log : null, me.ids, warnings);
    const rows = ledger.rows.filter(r => ids.has(canon(r.player_id)));
    if (!rows.length) {
      // Found only through the log (ledger exported before "me" sat down).
      warnings.push(issue('me_not_in_ledger', 'The ledger has no rows for "me"; amounts come from the game log.', { table_id: tableId }));
      return importTable({ ledgerText: null, logText, tableId, files }, config, warnings);
    }
    const bad = rows.filter(r => r.invalid.length);
    if (bad.length) {
      for (const r of bad) errors.push(issue('bad_value', `Ledger row ${r.line}: unreadable ${r.invalid.join(', ')}.`, { table_id: tableId, row: r.line }));
      out.status = 'invalid';
      return out;
    }
    if (rows.some(r => r.naive_time)) warnings.push(issue('naive_timestamp', `Ledger times had no timezone; read them as ${config.timeZone || 'UTC'}.`, { table_id: tableId }));
    const logSegs = logOk ? me.ids.flatMap(id => logSegments(log, id)) : [];
    segs = [];
    const used = new Set();
    // Oldest first so time-less rows pair with log seats in seating order.
    const ordered = [...rows].sort((a, b) => (a.start_ms ?? a.end_ms ?? 0) - (b.start_ms ?? b.end_ms ?? 0) || b.line - a.line);
    for (const r of ordered) {
      let start = r.start_ms, end = r.open ? null : r.end_ms;
      // Times missing from the ledger: borrow the matching log segment.
      const near = (a, b) => a != null && b != null && Math.abs(a - b) < MATCH_MS;
      const mine = logSegs.filter(g => g.player_id === canon(r.player_id) && !used.has(g));
      const match = start == null && end == null
        ? mine.find(g => Math.abs(g.buy_in * Number(config.chipValue ?? 1) - r.buy_in * scale) < MONEY_EPS && (g.end_ms == null) === r.open) || mine[0]
        : mine.find(g => (start != null ? near(g.start_ms, start) : near(g.end_ms, end)));
      if (match) used.add(match);
      if (start == null && match) start = match.start_ms;
      if (!r.open && end == null && match) end = match.end_ms;
      // PokerNow leaves session_start_at blank for seats taken before the game
      // started; the admin approval is the closest real seat time.
      if (start == null && end != null && logOk) {
        const approval = log.events.filter(ev => ev.kind === 'approve' && ev.player_id === canon(r.player_id) && ev.ms <= end).pop();
        if (approval) start = approval.ms;
      }
      if (start == null && end != null) {
        warnings.push(issue('missing_start', `Ledger row ${r.line} has no session_start_at; treated as a zero-length seat at its end time.`, { table_id: tableId, row: r.line }));
        start = end;
      }
      if (start == null) {
        errors.push(issue('missing_time', `Ledger row ${r.line} has no usable session time and no game log to recover it.`, { table_id: tableId, row: r.line }));
        continue;
      }
      if (!r.open && end == null) {
        errors.push(issue('missing_time', `Ledger row ${r.line} is closed but has no session_end_at.`, { table_id: tableId, row: r.line }));
        continue;
      }
      segs.push({
        player_id: canon(r.player_id), start_ms: start, end_ms: end,
        buy_in: r.buy_in * scale, buy_out: r.buy_out * scale,
        stack: (r.stack + r.nit_escrow) * scale,
        breaks: match ? match.breaks : [],
        events: match && Math.abs(match.buy_in * Number(config.chipValue ?? 1) - r.buy_in * scale) < MONEY_EPS
          ? match.events.map(e => ({ ...e, amount: e.amount * Number(config.chipValue ?? 1) }))
          : ledgerRowEvents(r, start, end, scale),
        approx_events: !(match && Math.abs(match.buy_in * Number(config.chipValue ?? 1) - r.buy_in * scale) < MONEY_EPS),
        log_match: match || null,
      });
    }
    if (errors.length) { out.status = 'invalid'; return out; }
    if (logOk) crossCheck(segs, config, warnings, tableId);
  } else {
    const chip = Number(config.chipValue ?? 1);
    segs = me.ids.flatMap(id => logSegments(log, id)).map(g => ({
      ...g, buy_in: g.buy_in * chip, buy_out: g.buy_out * chip, stack: g.stack == null ? null : g.stack * chip,
      events: g.events.map(e => ({ ...e, amount: e.amount * chip })),
    }));
    if (!segs.length) { out.status = 'not_found'; warnings.push(issue('me_not_seated', 'The log mentions "me" but never shows a seat join.', { table_id: tableId })); return out; }
    if (segs.some(g => g.end_ms == null && g.stack == null)) warnings.push(issue('current_stack_unknown', 'Still seated but no hand shows the current stack.', { table_id: tableId }));
  }
  if (logOk && log.naive_time) warnings.push(issue('naive_timestamp', `Log times had no timezone; read them as ${config.timeZone || 'UTC'}.`, { table_id: tableId }));

  const built = assemble({ segs, log: logOk ? log : null, meIds: me.ids, config, tableId, ledgerUsed: !!ledgerOk, warnings });
  validateSession(built.session, config, errors, tableId);
  if (errors.length) { out.status = 'invalid'; return out; }
  out.sessions.push(built);
  return out;
}

// Ledger-only stack events: one buy-in per seat at its start (top-ups are not
// itemised in the ledger), buy-outs at the seat end.
function ledgerRowEvents(r, start, end, scale) {
  const evs = [{ kind: 'buy_in', amount: r.buy_in * scale, ms: start }];
  if (r.buy_out > 0) evs.push({ kind: 'cash_out', amount: r.buy_out * scale, ms: end ?? start });
  return evs;
}

// Compares only seats found in both files: seats taken before the game started
// have no "joined" line, so the log cannot speak for them.
function crossCheck(segs, config, warnings, tableId) {
  const chip = Number(config.chipValue ?? 1);
  const paired = segs.filter(g => g.log_match);
  const a = round2(sum(paired.map(g => g.buy_in)));
  const b = round2(sum(paired.map(g => g.log_match.buy_in)) * chip);
  if (paired.length && Math.abs(a - b) > MONEY_EPS) {
    warnings.push(issue('ledger_log_mismatch', `Ledger buy-in ${a} differs from the log's ${b} (files exported at different times?); kept the ledger.`, { table_id: tableId }));
  }
}

function describeCandidate(id, players, ledger, log) {
  const rows = ledger ? ledger.rows.filter(r => (log ? log.canon(r.player_id) : r.player_id) === id) : [];
  const starts = rows.map(r => r.start_ms).filter(x => x != null);
  return {
    player_id: id,
    nicknames: [...(players.get(id)?.nicknames || [])],
    seats: rows.length,
    ledger_buy_in: rows.length ? sum(rows.map(r => r.buy_in)) : null,
    ledger_net: rows.length ? sum(rows.map(r => r.buy_out + r.stack + r.nit_escrow - r.buy_in)) : null,
    first_seen: starts.length ? iso(Math.min(...starts)) : null,
    hands: log ? log.hands.filter(h => h.seats.some(s => s.player_id === id)).length : null,
  };
}

function validateSession(s, config, errors, tableId) {
  const now = config.now != null ? new Date(config.now).getTime() : Date.now();
  const start = Date.parse(s.start_time);
  if (start > now + 60000) errors.push(issue('future_start', `Session start ${s.start_time} is in the future (wrong timeZone?).`, { table_id: tableId }));
  if (s.end_time && Date.parse(s.end_time) < start) errors.push(issue('end_before_start', `Session ends (${s.end_time}) before it starts (${s.start_time}).`, { table_id: tableId }));
}

// --- file grouping ----------------------------------------------------------------

function idsOfLedger(text) {
  const t = parseCsv(text);
  const i = (t[0] || []).map(norm).indexOf('player_id');
  return new Set(i < 0 ? [] : t.slice(1).map(r => String(r[i] || '').trim()).filter(Boolean));
}

function idsOfLog(text) {
  return new Set([...String(text).matchAll(/ @ ([^"\s]+)""/g)].map(m => m[1]));
}

// Pairs ledgers with logs: by the game id in the file name first, then by
// shared player ids. Anything unpaired is imported on its own.
export function groupPokerNowFiles(files) {
  const issues = [];
  const typed = files.map((f, i) => ({ ...f, idx: i, name: f.name || `file${i + 1}.csv`, format: detectPokerNowFormat(f.text), table_id: tableIdFromFileName(f.name) }));
  for (const f of typed.filter(x => x.format === 'unknown')) issues.push(issue('unknown_format', `${f.name} is neither a PokerNow ledger nor a game log.`, { file: f.name }));
  const ledgers = typed.filter(x => x.format === 'ledger');
  const logs = typed.filter(x => x.format === 'log');
  const used = new Set();
  const tables = [];
  const seenKey = new Map();
  for (const L of ledgers) {
    let mate = L.table_id ? logs.find(g => !used.has(g.idx) && g.table_id === L.table_id) : null;
    if (!mate) {
      const ids = idsOfLedger(L.text);
      let best = null, bestScore = 0;
      for (const g of logs) {
        if (used.has(g.idx) || (g.table_id && L.table_id && g.table_id !== L.table_id)) continue;
        const gi = idsOfLog(g.text);
        const shared = [...ids].filter(x => gi.has(x)).length;
        const score = ids.size ? shared / ids.size : 0;
        if (score > bestScore) { best = g; bestScore = score; }
      }
      if (best && bestScore >= 0.5) mate = best;
    }
    if (mate) used.add(mate.idx);
    tables.push({ tableId: L.table_id || mate?.table_id || null, ledgerText: L.text, logText: mate ? mate.text : null, files: [L.name, ...(mate ? [mate.name] : [])] });
  }
  for (const g of logs) if (!used.has(g.idx)) tables.push({ tableId: g.table_id, ledgerText: null, logText: g.text, files: [g.name] });
  // The same export dropped twice must not import twice.
  const unique = [];
  for (const t of tables) {
    const key = t.tableId ? `id:${t.tableId}` : `text:${t.ledgerText ?? ''}\u0000${t.logText ?? ''}`;
    if (seenKey.has(key)) { issues.push(issue('duplicate_table', `${t.files.join(' + ')} repeats ${seenKey.get(key).join(' + ')}; skipped.`, { table_id: t.tableId })); continue; }
    seenKey.set(key, t.files);
    unique.push(t);
  }
  return { tables: unique, issues };
}

// --- public entry point ---------------------------------------------------------------

/**
 * Import PokerNow exports for one player ("me").
 *
 * @param {Array<{name?: string, text: string}>|{name?: string, text: string}|string} files
 *   Ledger and/or full-log CSVs, any number of tables. A bare string is one file.
 * @param {object} config
 *   me              string | string[] — nickname(s) and/or PokerNow player id(s). Required
 *                   unless a log identifies its exporter.
 *   duplicateNames  'ask' (default) | 'merge' — a nickname matching several player ids.
 *   ledgerUnit      'auto' (default) | 'cents' | 'chips'.
 *   chipValue       currency per chip (default 1).
 *   timeZone        zone for timestamps WITHOUT an offset: 'UTC' (default), '+02:00', IANA name.
 *   dateOrder       'MDY' (default) | 'DMY' for spreadsheet-style d/m/y dates.
 *   openSeats       'live' (default) | 'close' — still-seated rows become live sessions or are
 *                   closed at exportedAt / the last log line with the current stack as cash-out.
 *   exportedAt      ISO time used by openSeats: 'close'.
 *   defaults        { game_name, small_blind, big_blind, table_size, location_name, bankroll_id, group_id }.
 *   now             clock override for the future-start check (tests).
 * @returns {{status: string, sessions: Array, tables: Array, warnings: Array, errors: Array}}
 */
export function importPokerNow(files, config = {}) {
  const list = typeof files === 'string' ? [{ text: files }] : Array.isArray(files) ? files : [files];
  const errors = [], warnings = [];
  if (config.timeZone != null && !validTimeZone(config.timeZone)) {
    return { status: 'invalid', sessions: [], tables: [], warnings, errors: [issue('bad_config', `Unknown timeZone "${config.timeZone}".`)] };
  }
  if (config.chipValue != null && !(Number(config.chipValue) > 0)) {
    return { status: 'invalid', sessions: [], tables: [], warnings, errors: [issue('bad_config', `chipValue must be a positive number, got "${config.chipValue}".`)] };
  }
  if (list.some(f => !f || typeof f.text !== 'string')) {
    return { status: 'invalid', sessions: [], tables: [], warnings, errors: [issue('bad_input', 'Every file needs a text string.')] };
  }
  const grouped = groupPokerNowFiles(list);
  warnings.push(...grouped.issues.filter(x => x.code === 'duplicate_table'));
  errors.push(...grouped.issues.filter(x => x.code === 'unknown_format'));

  const tables = grouped.tables.map(t => importTable(t, config));
  const sessions = tables.flatMap(t => t.sessions.map(s => ({ ...s, warnings: t.warnings })));
  for (const t of tables) { warnings.push(...t.warnings); errors.push(...t.errors); }

  // Multi-tabling: sessions at different tables that overlap stay separate.
  for (let i = 0; i < sessions.length; i++) for (let j = i + 1; j < sessions.length; j++) {
    const a = sessions[i].session, b = sessions[j].session;
    const ae = a.end_time ? Date.parse(a.end_time) : Infinity, be = b.end_time ? Date.parse(b.end_time) : Infinity;
    if (Date.parse(a.start_time) < be && Date.parse(b.start_time) < ae) {
      warnings.push(issue('overlapping_tables', `Sessions at ${sessions[i].source.table_id || 'table ' + (i + 1)} and ${sessions[j].source.table_id || 'table ' + (j + 1)} overlap in time (multi-tabling); kept as separate sessions.`));
    }
  }
  if (sessions.filter(s => s.session.is_live).length > 1) {
    warnings.push(issue('multiple_live', 'More than one still-open seat; the app allows one live session, so the caller must close or pick one.'));
  }
  sessions.sort((a, b) => Date.parse(a.session.start_time) - Date.parse(b.session.start_time));

  let status;
  if (errors.length) status = 'invalid';
  else if (tables.some(t => t.status === 'ambiguous')) status = 'ambiguous';
  else if (sessions.length) status = 'ok';
  else if (tables.some(t => t.status === 'not_found')) status = 'not_found';
  else status = 'empty';
  return { status, sessions, tables: tables.map(({ sessions: _s, ...t }) => t), warnings, errors };
}
