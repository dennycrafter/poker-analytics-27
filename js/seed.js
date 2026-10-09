// Deterministic demo seed (brief section 10). A fixed PRNG seed means
// "Reset demo data" reproduces the exact same dataset for a given "now".

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildSeed(nowMs) {
  const rnd = mulberry32(0x504B3237); // "PK27"
  const rand = () => rnd();
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const weighted = (pairs) => {
    const r = rand();
    let acc = 0;
    for (const [v, w] of pairs) { acc += w; if (r < acc) return v; }
    return pairs[pairs.length - 1][0];
  };
  const gauss = () => {
    let u = 0, v = 0;
    while (!u) u = rand();
    while (!v) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  const now = new Date(nowMs);
  const at = (daysBack, hour, minute = 0) => {
    const d = new Date(now);
    d.setDate(d.getDate() - daysBack);
    d.setHours(hour, minute, 0, 0);
    return d;
  };
  const iso = (d) => d.toISOString();

  const doc = {
    version: 1,
    settings: { currency: 'EUR' },
    bankrolls: [{ id: 'bk-live', name: 'Live', is_default: true, created_at: iso(at(150, 12)) }],
    games: [
      { id: 'g-nlh', name: "NL Hold'em" },
      { id: 'g-plo', name: 'PLO' },
    ],
    tournament_types: [
      { id: 'tt-mtt', name: 'MTT' },
      { id: 'tt-sng', name: 'SNG' },
    ],
    locations: [
      { id: 'loc-ucd', name: 'UCD' },
      { id: 'loc-stillo', name: 'Stillo Game' },
      { id: 'loc-casino', name: 'Casino Dublin' },
      { id: 'loc-home', name: 'Home Game' },
    ],
    groups: [],
    sessions: [], stack_events: [], sell_actions: [], transactions: [],
    player_notes: [], hand_histories: [],
  };

  // Bankroll "Live": starting deposit + one withdrawal + one expense.
  doc.transactions.push(
    { id: 'txn-001', bankroll_id: 'bk-live', kind: 'deposit', amount: 300, description: 'Starting deposit', occurred_at: iso(at(150, 12)) },
    { id: 'txn-002', bankroll_id: 'bk-live', kind: 'withdrawal', amount: -100, description: 'Cash withdrawal', occurred_at: iso(at(70, 18)) },
    { id: 'txn-003', bankroll_id: 'bk-live', kind: 'other', amount: -25, description: 'Travel and expenses', occurred_at: iso(at(20, 10)) },
  );

  const TOUR_SLOTS = new Set([3, 8, 13, 18, 24, 29, 34, 38]);
  const HOURS = [19, 20, 21, 18, 22, 14, 15, 16, 20, 21];
  const TDEFS = [
    { name: 'UCD Tuesday MTT', type: 'tt-mtt', buy: 20, entries: 72, pos: 30, prize: 0, hours: 3.5 },
    { name: 'Stillo Nightly SNG', type: 'tt-sng', buy: 10, entries: 9, pos: 4, prize: 0, hours: 1.5 },
    { name: 'Casino Dublin Sunday Special', type: 'tt-mtt', buy: 50, entries: 120, pos: 1, prize: 480, hours: 7 },
    { name: 'UCD Weekly', type: 'tt-mtt', buy: 15, entries: 45, pos: 12, prize: 15, hours: 3 },
    { name: 'Stillo Tuesday MTT', type: 'tt-mtt', buy: 25, entries: 60, pos: 3, prize: 90, hours: 5 },
    { name: 'Home Game SNG', type: 'tt-sng', buy: 10, entries: 6, pos: 2, prize: 20, hours: 2 },
    { name: 'Casino Dublin Deepstack', type: 'tt-mtt', buy: 30, entries: 80, pos: 55, prize: 0, hours: 4, rebuy: 25 },
    { name: 'Stillo Weekend Special', type: 'tt-mtt', buy: 25, entries: 66, pos: 9, prize: 60, hours: 4.5, sell: true },
  ];
  let cashN = 0, tourN = 0;

  for (let i = 0; i < 40; i++) {
    const daysBack = Math.max(1, Math.round(146 - i * (144 / 39) + (rand() * 2 - 1)));
    const start = at(daysBack, pick(HOURS), Math.floor(rand() * 12) * 5);
    let s;

    if (!TOUR_SLOTS.has(i)) {
      // ---- cash session ----
      cashN++;
      const stakes = weighted([[0.1, 0.5], [0.25, 0.35], [0.5, 0.15]]);
      const hours = 2 + Math.round(rand() * 60) / 12; // 2..7h in 5-min steps
      const end = new Date(start.getTime() + hours * 3600 * 1000);
      const sb = stakes;         // brief stakes are written SB/BB: 0.1/0.2, 0.25/0.5, 0.5/1
      const bb = sb * 2;
      const game = rand() < 0.8 ? 'g-nlh' : 'g-plo';
      const loc = weighted([['loc-ucd', 0.42], ['loc-stillo', 0.28], ['loc-casino', 0.18], ['loc-home', 0.12]]);
      const table = weighted([[6, 0.2], [7, 0.15], [8, 0.15], [9, 0.4], [10, 0.1]]);
      const buyIn = Math.round(pick([100, 100, 150]) * bb * 100) / 100;
      // Winning player at roughly +5 BB/hour with real variance.
      let netBB = hours * 5 + gauss() * 45 * Math.sqrt(hours);
      if (i >= 10 && i <= 12) netBB = -(30 + rand() * 50);   // engineered losing streak
      if (i === 21 || i === 30) netBB = -(20 + rand() * 40); // scattered losses
      if (i === 16) netBB = 120 + rand() * 80;               // big win
      if (i === 33) netBB = 100 + rand() * 60;               // big win
      const net = Math.round(netBB * bb * 2) / 2;            // table money settles in 0.5 steps
      const cashedOut = Math.max(0, Math.round((buyIn + net) * 2) / 2);
      const tips = cashedOut > buyIn + 30 && rand() < 0.5 ? pick([5, 10]) : 0;
      const withHands = rand() < 0.85;
      const breakSec = rand() < 0.2 ? pick([900, 1800]) : 0;
      s = {
        id: 'sess-c' + String(cashN).padStart(2, '0'),
        kind: 'cash',
        game_id: game, location_id: loc, bankroll_id: 'bk-live', group_id: null,
        table_size: table,
        start_time: iso(start), end_time: iso(end),
        duration_seconds: Math.round((end - start) / 1000),
        break_seconds: breakSec,
        hands_count: withHands ? Math.round(hours * (28 + rand() * 6)) : null,
        hands_count_estimated: true,
        comment: null, opponents: null,
        is_live: false, tracked_via_stack: false, paused_at: null,
        small_blind: sb, big_blind: bb, buy_in: buyIn, cashed_out: cashedOut, tips,
        created_at: iso(start), updated_at: iso(end),
      };
    } else {
      // ---- tournament session ----
      tourN++;
      const t = TDEFS[(tourN - 1) % TDEFS.length];
      const end = new Date(start.getTime() + t.hours * 3600 * 1000);
      const loc = weighted([['loc-ucd', 0.4], ['loc-stillo', 0.3], ['loc-casino', 0.2], ['loc-home', 0.1]]);
      s = {
        id: 'sess-t' + String(tourN).padStart(2, '0'),
        kind: 'tournament',
        game_id: 'g-nlh', location_id: loc, bankroll_id: 'bk-live', group_id: null,
        table_size: 9,
        start_time: iso(start), end_time: iso(end),
        duration_seconds: Math.round(t.hours * 3600),
        break_seconds: 0,
        hands_count: null, hands_count_estimated: true,
        comment: null, opponents: null,
        is_live: false, tracked_via_stack: false, paused_at: null,
        tournament_type_id: t.type, tournament_name: t.name,
        initial_buy_in: t.buy, total_buy_in: t.buy + (t.rebuy || 0),
        prize: t.prize, position: t.pos, entries: t.entries,
        tips: 0,
        created_at: iso(start), updated_at: iso(end),
      };
      if (t.sell) {
        doc.sell_actions.push({ id: 'sell-001', session_id: s.id, percentage: 30, markup: 1.1, backer_name: 'M. Byrne' });
      }
    }
    doc.sessions.push(s);
  }

  const firstCash = doc.sessions.find(x => x.kind === 'cash');
  doc.player_notes.push(
    { id: 'note-001', session_id: firstCash.id, player_name: "Paddy O'Shea", note: 'Chases draws too far. Folds to turn barrels.', created_at: iso(at(40, 23)) },
    { id: 'note-002', session_id: null, player_name: 'Eoin K.', note: 'Home game regular. Talks a lot, plays tight.', created_at: iso(at(15, 22)) },
    { id: 'note-003', session_id: null, player_name: 'Sandra M.', note: 'Tilts after losing a big pot, opens way too wide.', created_at: iso(at(6, 21)) },
  );
  doc.hand_histories.push({
    id: 'hh-001',
    session_id: firstCash.id,
    raw_text: 'Blinds 0.25/0.5. Hero in MP with As Kd, raises to 1.5. Button calls. Flop Ks 7d 3c. Hero bets 2, button calls. Turn 9h. Hero bets 4, button raises to 12, hero calls. River 2s. Hero checks, button shoves 28, hero calls. Button shows Qs Qc. Hero wins 87 with kings up.',
    comment: 'Cooler against the table regular',
    created_at: iso(at(30, 23)),
  });

  return doc;
}
