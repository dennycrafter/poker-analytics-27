// Deterministic generator for the synthetic PokerNow fixtures in this folder.
// Every sentence shape, column list and quirk below is copied from real public
// exports (see docs/pokernow-format.md); the players, ids and cards are made up
// so no real person's data is committed. Re-run with:
//   node tests/fixtures/pokernow/generate.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUITS = ['♠', '♥', '♦', '♣'];
const MIN = 60000;

class Game {
  constructor({ seed, decimals, sb, bb, variant = "No Limit Texas Hold'em", exporter }) {
    this.r = rng(seed);
    this.decimals = decimals;
    this.sb = sb; this.bb = bb;
    this.variant = variant;
    this.exporter = exporter;      // player id whose hole cards the log shows
    this.lines = [];               // { entry, ms }
    this.players = new Map();      // id -> { id, name, seat, stack, seated, standing }
    this.rows = [];                // ledger stints
    this.hand = 0;
    this.dealer = -1;
  }
  fmt(n) { return this.decimals ? n.toFixed(2) : String(Math.round(n)); }
  tag(p) { return `""${p.name} @ ${p.id}""`.replace(/""/g, '"'); }
  emit(entry, ms) { this.lines.push({ entry, ms }); }
  player(id, name) {
    if (!this.players.has(id)) this.players.set(id, { id, name, seat: null, stack: 0, seated: false, standing: false });
    return this.players.get(id);
  }
  openRow(p) { return this.rows.find(r => r.id === p.id && r.end == null && r.open); }

  requestAndApprove(id, name, stack, ms) {
    const p = this.player(id, name);
    this.emit(`The player ${this.tag(p)} requested a seat.`, ms);
    this.emit(`The admin approved the player ${this.tag(p)} participation with a stack of ${this.fmt(stack)}.`, ms + 2500);
  }
  // A seat taken before the game starts: approved, then quits before hand #1.
  // PokerNow writes no "joined" line and leaves session_start_at blank.
  preStartSeat(id, name, stack, ms, quitMs) {
    const p = this.player(id, name);
    this.requestAndApprove(id, name, stack, ms);
    this.emit(`The player ${this.tag(p)} quits the game with a stack of ${this.fmt(stack)}.`, quitMs);
    this.rows.push({ id, name: p.name, start: null, end: quitMs + 2, buy_in: stack, buy_out: stack, stack: 0, open: false });
  }
  join(id, name, seat, stack, ms) {
    const p = this.player(id, name);
    Object.assign(p, { seat, stack, seated: true, standing: false });
    this.emit(`The player ${this.tag(p)} joined the game with a stack of ${this.fmt(stack)}.`, ms);
    // The ledger stamps the seat a few ms after the log line (observed 2-7 ms).
    this.rows.push({ id, name: p.name, start: ms + 3, end: null, buy_in: stack, buy_out: 0, stack, open: true });
  }
  quit(id, ms) {
    const p = this.players.get(id);
    this.emit(`The player ${this.tag(p)} quits the game with a stack of ${this.fmt(p.stack)}.`, ms);
    const row = this.openRow(p);
    row.buy_out += p.stack; row.stack = 0; row.end = ms + 5; row.open = false;
    p.stack = 0; p.seated = false; p.standing = false;
  }
  adjust(id, delta, ms) {
    const p = this.players.get(id);
    const from = p.stack, to = Math.round((p.stack + delta) * 100) / 100;
    this.emit(`The admin updated the player ${this.tag(p)} stack from ${this.fmt(from)} to ${this.fmt(to)}.`, ms);
    const row = this.openRow(p);
    if (delta > 0) row.buy_in += delta; else row.buy_out += -delta;
    p.stack = to; row.stack = to;
  }
  standUp(id, ms) { const p = this.players.get(id); p.standing = true; this.emit(`The player ${this.tag(p)} stand up with the stack of ${this.fmt(p.stack)}.`, ms); }
  sitBack(id, ms) { const p = this.players.get(id); p.standing = false; this.emit(`The player ${this.tag(p)} sit back with the stack of ${this.fmt(p.stack)}.`, ms); }
  changeId(oldId, newId, ms) {
    const p = this.players.get(oldId);
    this.players.delete(oldId);
    p.id = newId;
    this.players.set(newId, p);
    for (const r of this.rows) if (r.id === oldId) r.id = newId;
    this.emit(`The player ${this.tag(p)} changed the ID from ${oldId} to ${newId} because authenticated login.`, ms);
  }
  blinds(sb, bb, ms) {
    this.emit(`The game's small blind was changed from ${this.fmt(this.sb)} to ${this.fmt(sb)}.`, ms);
    this.emit(`The game's big blind was changed from ${this.fmt(this.bb)} to ${this.fmt(bb)}.`, ms);
    this.emit(`The game's ante was changed from ${this.fmt(0)} to ${this.fmt(0)}.`, ms);
    this.sb = sb; this.bb = bb;
  }
  deal(n) {
    const deck = [];
    for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
    for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(this.r() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    return deck.slice(0, n);
  }
  handId() { let s = ''; for (let i = 0; i < 12; i++) s += '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(this.r() * 36)]; return s; }

  // One hand of NLH-style action: SB, BB, an open-raise, BB defends or folds,
  // flop c-bet, fold or showdown. Stacks stay exact so the ledger reconciles.
  playHand(ms) {
    const active = [...this.players.values()].filter(p => p.seated && !p.standing && p.stack >= this.bb).sort((a, b) => a.seat - b.seat);
    if (active.length < 2) return ms;
    this.hand += 1;
    this.dealer = (this.dealer + 1) % active.length;
    const at = i => active[(this.dealer + i) % active.length];
    const dealer = at(0), sbP = active.length === 2 ? at(0) : at(1), bbP = active.length === 2 ? at(1) : at(2);
    const button = this.r() < 0.05 ? '(dead button)' : `(dealer: ${this.tag(dealer)})`;
    this.emit(`-- starting hand #${this.hand} (id: ${this.handId()})  (${this.variant}) ${button} --`, ms);
    // Real logs omit players who stood up from the Player stacks line.
    const allSeated = [...this.players.values()].filter(p => p.seated && !p.standing).sort((a, b) => a.seat - b.seat);
    this.emit(`Player stacks: ${allSeated.map(p => `#${p.seat} ${this.tag(p)} (${this.fmt(p.stack)})`).join(' | ')}`, ms);
    const cards = this.deal(active.length * 2 + 5);
    const hole = new Map(active.map((p, i) => [p.id, [cards[2 * i], cards[2 * i + 1]]]));
    const board = cards.slice(active.length * 2);
    const me = this.players.get(this.exporter);
    if (me && hole.has(me.id)) this.emit(`Your hand is ${hole.get(me.id).join(', ')}`, ms);
    const sb = Math.min(this.sb, sbP.stack);
    this.emit(`${this.tag(sbP)} posts a small blind of ${this.fmt(sb)}`, ms);
    this.emit(`${this.tag(bbP)} posts a big blind of ${this.fmt(this.bb)}`, ms);
    sbP.stack -= sb; bbP.stack -= this.bb;
    let pot = sb + this.bb;
    const open = 3 * this.bb, cbet = 4 * this.bb;
    const candidates = active.filter(p => p !== bbP && p.stack + (p === sbP ? sb : 0) >= open + cbet);
    let t = ms + 4000 + Math.floor(this.r() * 8000);
    if (!candidates.length) {
      this.emit(`${this.tag(sbP)} folds`, t);
      bbP.stack += pot;
      this.emit(`Uncalled bet of ${this.fmt(this.bb - sb)} returned to ${this.tag(bbP)}`, t + 500);
      this.emit(`${this.tag(bbP)} collected ${this.fmt(pot)} from pot`, t + 500);
      this.emit(`-- ending hand #${this.hand} --`, t + 500);
      return t + 500;
    }
    const raiser = candidates[Math.floor(this.r() * candidates.length)];
    for (const p of active) if (p !== raiser && p !== bbP && p !== sbP) { this.emit(`${this.tag(p)} folds`, t); t += 1500; }
    this.emit(`${this.tag(raiser)} raises to ${this.fmt(open)}`, t); t += 2000;
    raiser.stack -= open - (raiser === sbP ? sb : 0); pot += open - (raiser === sbP ? sb : 0);
    if (raiser !== sbP) { this.emit(`${this.tag(sbP)} folds`, t); t += 1500; }
    if (bbP.stack < open - this.bb + cbet || this.r() < 0.35) {
      this.emit(`${this.tag(bbP)} folds`, t); t += 800;
      this.emit(`Uncalled bet of ${this.fmt(open - this.bb)} returned to ${this.tag(raiser)}`, t);
      raiser.stack += pot; this.emit(`${this.tag(raiser)} collected ${this.fmt(pot - (open - this.bb))} from pot`, t);
      this.emit(`-- ending hand #${this.hand} --`, t);
      return t;
    }
    this.emit(`${this.tag(bbP)} calls ${this.fmt(open)}`, t); t += 2000;
    bbP.stack -= open - this.bb; pot += open - this.bb;
    this.emit(`Flop:  [${board.slice(0, 3).join(', ')}]`, t); t += 3000;
    this.emit(`${this.tag(bbP)} checks`, t); t += 2500;
    this.emit(`${this.tag(raiser)} bets ${this.fmt(cbet)}`, t); t += 3000;
    raiser.stack -= cbet;
    if (this.r() < 0.45) {
      this.emit(`${this.tag(bbP)} folds`, t); t += 800;
      this.emit(`Uncalled bet of ${this.fmt(cbet)} returned to ${this.tag(raiser)}`, t);
      raiser.stack += cbet + pot;
      this.emit(`${this.tag(raiser)} collected ${this.fmt(pot)} from pot`, t);
      this.emit(`-- ending hand #${this.hand} --`, t);
      return t;
    }
    this.emit(`${this.tag(bbP)} calls ${this.fmt(cbet)}`, t); t += 2000;
    bbP.stack -= cbet; pot += 2 * cbet;
    this.emit(`Turn: ${board.slice(0, 3).join(', ')} [${board[3]}]`, t); t += 3000;
    this.emit(`${this.tag(bbP)} checks`, t); t += 2000;
    this.emit(`${this.tag(raiser)} checks`, t); t += 2000;
    this.emit(`River: ${board.slice(0, 4).join(', ')} [${board[4]}]`, t); t += 3000;
    this.emit(`${this.tag(bbP)} checks`, t); t += 2000;
    this.emit(`${this.tag(raiser)} checks`, t); t += 1500;
    this.emit(`${this.tag(raiser)} shows a ${hole.get(raiser.id).join(', ')}.`, t);
    this.emit(`${this.tag(bbP)} shows a ${hole.get(bbP.id).join(', ')}.`, t);
    t += 500;
    const winner = this.r() < 0.5 ? raiser : bbP;
    winner.stack += pot;
    this.emit(`${this.tag(winner)} collected ${this.fmt(pot)} from pot with High Card, ${hole.get(winner.id)[0]} (combination: ${board.join(', ')})`, t);
    this.emit(`-- ending hand #${this.hand} --`, t);
    return t;
  }
  // Plays hands back to back until `until`, running `hooks` (ms -> fn) between hands.
  run(from, until, hooks = []) {
    const queue = [...hooks].sort((a, b) => a[0] - b[0]);
    let t = from;
    while (t < until) {
      while (queue.length && queue[0][0] <= t) queue.shift()[1](t);
      const end = this.playHand(t);
      t = Math.max(end + 2000, t + 75000 + Math.floor(this.r() * 60000));
    }
    while (queue.length && queue[0][0] <= until) queue.shift()[1](until);
  }

  // Real logs are newest-first; `order` = ms * 100 + index within that ms.
  logCsv(cutoff = Infinity) {
    const lines = this.lines.filter(l => l.ms <= cutoff).map((l, i) => ({ ...l, i }));
    lines.sort((a, b) => a.ms - b.ms || a.i - b.i);
    const out = [];
    let lastMs = null, k = 0;
    for (const l of lines) { k = l.ms === lastMs ? k + 1 : 0; lastMs = l.ms; out.push({ ...l, order: l.ms * 100 + k }); }
    out.reverse();
    const q = s => `"${s.replace(/"/g, '""')}"`;
    return ['entry,at,order', ...out.map(l => `${q(l.entry)},${new Date(l.ms).toISOString()},${l.order}`)].join('\n') + '\n';
  }
  // Ledger as PokerNow writes it: newest start first, rows without a start
  // last, cents when the table uses decimal chips, blank buy_out on an open
  // seat that never cashed anything out.
  ledgerCsv() {
    const unit = this.decimals ? 100 : 1;
    const c = n => String(Math.round(n * unit));
    const rows = [...this.rows].sort((a, b) => (b.start ?? -1) - (a.start ?? -1));
    // Open seats report the stack at export time.
    for (const r of rows) if (r.open) r.stack = this.players.get(r.id).stack;
    const nets = rows.reduce((t, r) => t + r.buy_out + r.stack - r.buy_in, 0);
    if (Math.abs(nets) > 1e-6) throw new Error(`chips not conserved: ${nets}`);
    const body = rows.map(r => {
      const net = r.buy_out + r.stack - r.buy_in;
      const name = this.players.get(r.id)?.name ?? r.name;
      return [`"${name}"`, r.id, r.start == null ? '' : new Date(r.start).toISOString(), r.end == null ? '' : new Date(r.end).toISOString(),
        c(r.buy_in), r.open && r.buy_out === 0 ? '' : c(r.buy_out), c(r.stack), c(net)].join(',');
    });
    return ['player_nickname,player_id,session_start_at,session_end_at,buy_in,buy_out,stack,net', ...body].join('\n') + '\n';
  }
}

const at = (h, m, s = 0) => Date.UTC(2026, 8, 10, h, m, s);
const ME = 'Qv7mPa27Dn';

// --- 1. Full realistic home game (decimal chips, ledger in cents) -------------
function homeGame(stopAt) {
  const g = new Game({ seed: 27, decimals: true, sb: 0.10, bb: 0.20, exporter: ME });
  g.blinds(0.25, 0.5, at(17, 50, 12));
  // Theo first gets a seat by mistake and quits before the game starts.
  g.preStartSeat('Th3oXk91aZ', 'Theo', 50, at(17, 51, 3), at(17, 52, 40));
  g.requestAndApprove(ME, 'Denis', 50, at(17, 53, 10));
  g.requestAndApprove('R0okP9fT2c', 'Rook', 50, at(17, 54, 0));
  g.requestAndApprove('tmpMara0x1', 'Mara', 50, at(17, 55, 31));
  g.requestAndApprove('Th3oXk91aZ', 'Theo', 100, at(17, 56, 2));
  g.requestAndApprove('KasiaW8nnQ', 'Kasia', 50, at(17, 57, 45));
  const start = at(18, 0, 4);
  g.join(ME, 'Denis', 2, 50, start);
  g.join('R0okP9fT2c', 'Rook', 4, 50, start);
  g.join('tmpMara0x1', 'Mara', 5, 50, start);
  g.join('Th3oXk91aZ', 'Theo', 7, 100, start);
  g.join('KasiaW8nnQ', 'Kasia', 9, 50, start);
  const hooks = [
    [at(18, 46), t => { g.requestAndApprove('F1nnLc0dE4', 'Finn', 60, t); g.join('F1nnLc0dE4', 'Finn', 1, 60, t + 30000); }],
    [at(19, 10), t => g.adjust(ME, 50, t)],                           // admin top-up for me
    [at(19, 40), t => g.standUp(ME, t)],
    [at(19, 52), t => g.sitBack(ME, t)],
    [at(20, 15), t => g.quit('KasiaW8nnQ', t)],
    [at(20, 31), t => { g.requestAndApprove('KasiaW8nnQ', 'Kasia', 40, t); g.join('KasiaW8nnQ', 'Kasia', 9, 40, t + 15000); }],
    [at(20, 40), t => g.changeId('tmpMara0x1', 'MaraAuth7Q', t)],
    [at(21, 5), t => g.adjust('R0okP9fT2c', -30, t)],                 // Rook takes 30 off the table
    [at(21, 34), t => g.quit(ME, t)],
    [at(21, 41), t => g.quit('F1nnLc0dE4', t)],
    [at(21, 47), t => g.quit('MaraAuth7Q', t)],
    [at(21, 49), t => g.emit(`The admin ${g.tag(g.players.get('R0okP9fT2c'))} enqueued the game stop on next hand.`, t)],
  ];
  g.run(start, stopAt, hooks.filter(([ms]) => ms <= stopAt));
  return g;
}

// --- 2. "Me" twice at one table: same nickname, two player ids ----------------
// Denis plays from the phone (exporter) while someone else also calls himself
// "Denis"; both sit for the whole game.
function dupNames() {
  const g = new Game({ seed: 99, decimals: true, sb: 0.1, bb: 0.2, exporter: ME });
  const start = Date.UTC(2026, 8, 18, 19, 0, 7);
  for (const [id, name, seat, stack] of [[ME, 'Denis', 1, 20], ['dNs2xOther', 'Denis', 3, 20], ['OlaPq4Kd8s', 'Ola', 6, 20]]) {
    g.requestAndApprove(id, name, stack, start - 120000 - seat * 1000);
    g.join(id, name, seat, stack, start);
  }
  g.run(start, start + 70 * MIN, [[start + 68 * MIN, t => { for (const id of [ME, 'dNs2xOther', 'OlaPq4Kd8s']) g.quit(id, t); }]]);
  return g;
}

// --- 3. Second table, integer chips, overlapping the home game (multi-table) --
function onlineTable() {
  const g = new Game({ seed: 5, decimals: false, sb: 10, bb: 20, exporter: ME });
  const start = at(19, 30, 11);
  for (const [id, name, seat] of [[ME, 'Denis', 3], ['Zed7Hq2LmP', 'Zed', 5], ['YuriAa0Bb1', 'Yuri', 8]]) {
    g.requestAndApprove(id, name, 2000, start - 60000 - seat * 1000);
    g.join(id, name, seat, 2000, start);
  }
  g.run(start, at(21, 0), [[at(20, 58), t => { for (const id of [ME, 'Zed7Hq2LmP', 'YuriAa0Bb1']) g.quit(id, t); }]]);
  return g;
}

const write = (rel, text) => {
  const p = join(HERE, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};

const full = homeGame(at(21, 52));
write('ledger_pglPa27Home01.csv', full.ledgerCsv());
write('poker_now_log_pglPa27Home01.csv', full.logCsv());

// Same game exported mid-session at 20:05: my seat is still open (no cash-out).
const live = homeGame(at(20, 5));
write('live/ledger_pglPa27Home01.csv', live.ledgerCsv());
write('live/poker_now_log_pglPa27Home01.csv', live.logCsv());

const dup = dupNames();
write('ledger_pglPa27DupName.csv', dup.ledgerCsv());
write('poker_now_log_pglPa27DupName.csv', dup.logCsv());

const online = onlineTable();
write('ledger_pglPa27Online2.csv', online.ledgerCsv());
write('poker_now_log_pglPa27Online2.csv', online.logCsv());

console.log('hands:', { full: full.hand, live: live.hand, dup: dup.hand, online: online.hand });
