// Start session form (brief 5.2 / 5.5): full-screen modal for cash or
// tournament. "Start" opens live tracking; "Log past session" switches to
// after-the-fact mode with validation (no future start, no end < start).

import { navigate } from '../router.js';
import { getState, mutate, genId } from '../store.js';
import { icon } from '../icons.js';
import { esc, toast, selectSheet, openSheet } from '../ui.js';
import { startLiveCash, startLiveTournament, logPastSession, getLiveSession, addSellActions } from '../domain.js';
import { openSellSheet } from './sell.js';
import { makeSellAction, soldPercent } from '../staking.js';
import { toLocalInputValue, fmtNum } from '../format.js';

const STAKE_CHIPS = [[0.1, 0.2], [0.25, 0.5], [0.5, 1], [1, 2], [2, 5], [5, 10]];

export function StartScreen(root, doc, kind) {
  const state = {
    game_id: doc.games[0] ? doc.games[0].id : null,
    small_blind: 0.1,
    big_blind: 0.2,
    buy_in: 100,
    initial_buy_in: 10,
    location_id: lastLocationId(doc),
    table_size: 9,
    bankroll_id: (doc.bankrolls.find(b => b.is_default) || doc.bankrolls[0] || {}).id || null,
    tournament_type_id: doc.tournament_types[0] ? doc.tournament_types[0].id : null,
    tournament_name: '',
    past: false,
    cashed_out: null,
    tips: 0,
    hands_count: null,
    prize: null,
    position: null,
    entries: null,
    __start: null,
    // Pending sell actions (brief 5.6); attached when the session is created.
    sells: [],
  };

  function lastLocationId(d) {
    const withLoc = d.sessions.filter(s => s.location_id)
      .sort((a, b) => Date.parse(b.start_time) - Date.parse(a.start_time));
    return withLoc.length ? withLoc[0].location_id : (d.locations[0] || {}).id || null;
  }

  const name = kind === 'cash' ? 'Cash game' : 'Tournament';

  function fieldRow(label, valueHtml, opts = {}) {
    return `<div class="field-row" data-field="${opts.key || ''}">
      <span class="field-name">${esc(label)}</span>
      <span class="field-value">${valueHtml}${opts.chevron ? icon('chevron', 'chev') : ''}</span>
    </div>`;
  }

  function render() {
    const loc = doc.locations.find(l => l.id === state.location_id);
    const bank = doc.bankrolls.find(b => b.id === state.bankroll_id);
    const ttype = doc.tournament_types.find(t => t.id === state.tournament_type_id);

    let body = `
      <div class="field-label" style="margin-bottom:6px">Game</div>
      <div class="chip-row">
        ${doc.games.map(g => `<button type="button" class="chip ${g.id === state.game_id ? 'active' : ''}" data-game="${g.id}">${esc(g.name)}</button>`).join('')}
      </div>`;

    if (kind === 'cash') {
      body += `
      <div class="field-label" style="margin:18px 0 6px">Stakes</div>
      <div class="stakes-inputs">
        <label class="field"><span class="field-label">Small blind</span>
          <input class="input" data-role="sb" type="number" step="0.01" min="0" value="${state.small_blind}"></label>
        <label class="field"><span class="field-label">Big blind</span>
          <input class="input" data-role="bb" type="number" step="0.01" min="0" value="${state.big_blind}"></label>
      </div>
      <div class="chip-row">
        ${STAKE_CHIPS.map(([sb, bb]) =>
          `<button type="button" class="chip ${sb === state.small_blind && bb === state.big_blind ? 'active' : ''}" data-stake="${sb}/${bb}">${sb}/${bb}</button>`).join('')}
      </div>
      <label class="field" style="margin-top:14px"><span class="field-label">Starting buy-in</span>
        <input class="input" data-role="buyin" type="number" inputmode="decimal" step="0.01" min="0" value="${state.buy_in}"></label>`;
    } else {
      body += `
      <label class="field" style="margin-top:14px"><span class="field-label">Initial buy-in</span>
        <input class="input" data-role="initbuy" type="number" inputmode="decimal" step="0.01" min="0" value="${state.initial_buy_in}"></label>
      <label class="field"><span class="field-label">Tournament name (optional)</span>
        <input class="input" data-role="tname" type="text" value="${esc(state.tournament_name)}" placeholder="e.g. Tuesday Nighter"></label>`;
    }

    if (state.past) {
      body += `
      <div class="section-label">${kind === 'cash' ? 'Session results' : 'Results'}</div>
      <div class="stakes-inputs">
        <label class="field"><span class="field-label">Start time</span>
          <input class="input" data-role="start" type="datetime-local"
            value="${toLocalInputValue(state.__start || new Date())}"></label>
        <label class="field"><span class="field-label">End time</span>
          <input class="input" data-role="end" type="datetime-local" value=""></label>
      </div>
      <div class="sheet-error" data-role="time-err" hidden></div>
      ${kind === 'cash' ? `
      <div class="stakes-inputs">
        <label class="field"><span class="field-label">Buy-in</span>
          <input class="input" data-role="past-buyin" type="number" step="0.01" min="0" value="${state.buy_in}"></label>
        <label class="field"><span class="field-label">Cashed out</span>
          <input class="input" data-role="past-cashed" type="number" step="0.01" min="0" value="${state.cashed_out ?? ''}"></label>
      </div>
      <div class="stakes-inputs">
        <label class="field"><span class="field-label">Tips</span>
          <input class="input" data-role="past-tips" type="number" step="0.01" min="0" value="${state.tips || ''}"></label>
        <label class="field"><span class="field-label">Hands count</span>
          <input class="input" data-role="past-hands" type="number" step="1" min="0" value="${state.hands_count ?? ''}"></label>
      </div>` : `
      <div class="stakes-inputs">
        <label class="field"><span class="field-label">Prize</span>
          <input class="input" data-role="past-prize" type="number" step="0.01" min="0" value="${state.prize ?? ''}"></label>
        <label class="field"><span class="field-label">Position</span>
          <input class="input" data-role="past-pos" type="number" step="1" min="1" value="${state.position ?? ''}"></label>
      </div>
      <div class="stakes-inputs">
        <label class="field"><span class="field-label">Entries</span>
          <input class="input" data-role="past-entries" type="number" step="1" min="1" value="${state.entries ?? ''}"></label>
        <label class="field"><span class="field-label">Rebuys/add-ons total</span>
          <input class="input" data-role="past-rebuys" type="number" step="0.01" min="0" value="0"></label>
      </div>`}
      <button class="btn-primary" data-act="save-past" style="margin-top:18px">${kind === 'cash' ? 'Save cash session' : 'Save tournament'}</button>`;
    } else {
      body += `
      <div class="section-label" style="margin-top:18px">Setup</div>
      ${fieldRow('Location', esc(loc ? loc.name : '--'), { key: 'location', chevron: true })}
      ${kind === 'tournament' ? fieldRow('Type', esc(ttype ? ttype.name : '--'), { key: 'ttype', chevron: true }) : ''}
      ${fieldRow('Table size', `${state.table_size}-max`, { key: 'table', chevron: true })}
      ${fieldRow('Bankroll', esc(bank ? bank.name : '--'), { key: 'bank', chevron: true })}
      ${fieldRow('Date', state.__start ? toLocalInputValue(state.__start).replace('T', ' ') : 'Now', { key: 'date', chevron: true })}`;
    }

    root.innerHTML = `
      <div class="modal-screen">
        <header class="topbar">
          <button class="topbtn" data-act="cancel">Cancel</button>
          <h1>${esc(name)}</h1>
          ${kind === 'tournament'
            ? `<button class="topbtn" data-act="sell" style="color:var(--accent);font-size:13px">${sellLabel()}</button>`
            : '<span class="topbtn" style="visibility:hidden"></span>'}
        </header>
        <div class="form">${body}</div>
        <div class="modal-footer">
          <button class="btn-secondary" data-act="past">${state.past ? 'Back to live setup' : 'Log past session'}</button>
          ${state.past ? '' : '<button class="btn-primary" data-act="start">Start</button>'}
        </div>
      </div>`;

    // --- wiring ---
    root.querySelector('[data-act=cancel]').addEventListener('click', () => navigate('/feed'));

    root.querySelectorAll('[data-game]').forEach(chip => chip.addEventListener('click', () => {
      state.game_id = chip.dataset.game; render();
    }));
    root.querySelectorAll('[data-stake]').forEach(chip => chip.addEventListener('click', () => {
      const [sb, bb] = chip.dataset.stake.split('/').map(Number);
      state.small_blind = sb; state.big_blind = bb; render();
    }));

    // Numeric/text inputs write straight into form state. Empty parses to
    // null for optional fields, 0 for required stakes/buy-ins.
    const REQUIRED_NUMBERS = new Set(['small_blind', 'big_blind', 'buy_in', 'initial_buy_in']);
    const INPUT_BINDINGS = {
      sb: 'small_blind', bb: 'big_blind', buyin: 'buy_in', initbuy: 'initial_buy_in',
      'past-buyin': 'buy_in', 'past-cashed': 'cashed_out', 'past-tips': 'tips',
      'past-hands': 'hands_count', 'past-prize': 'prize', 'past-pos': 'position',
      'past-entries': 'entries',
    };
    root.querySelectorAll('input[data-role]').forEach(inp => {
      inp.addEventListener('input', () => {
        const role = inp.dataset.role;
        if (role === 'tname') { state.tournament_name = inp.value; return; }
        const key = INPUT_BINDINGS[role];
        if (!key) return;
        const raw = inp.value.trim();
        const n = raw === '' ? NaN : Number(raw);
        state[key] = Number.isFinite(n) ? n : (REQUIRED_NUMBERS.has(key) ? 0 : null);
      });
    });

    if (state.past) {
      root.querySelector('[data-act=save-past]').addEventListener('click', savePast);
    } else {
    const row = key => root.querySelector(`[data-field="${key}"]`);
      row('location').addEventListener('click', () =>
        pickList('Location', 'locations', state.location_id, v => { state.location_id = v; render(); }, true));
      if (kind === 'tournament') {
        row('ttype').addEventListener('click', () =>
          pickList('Tournament type', 'tournament_types', state.tournament_type_id, v => { state.tournament_type_id = v; render(); }, true));
      }
      row('table').addEventListener('click', () =>
        pickNumber('Table size', state.table_size, 2, 10, v => { state.table_size = v; render(); }, '-max'));
      row('bank').addEventListener('click', () =>
        pickList('Bankroll', 'bankrolls', state.bankroll_id, v => { state.bankroll_id = v; render(); }, false));
      row('date').addEventListener('click', () =>
        pickDateTime('Start time', v => { state.__start = v; render(); }));
      root.querySelector('[data-act=start]').addEventListener('click', startLive);
    }
    root.querySelector('[data-act=past]').addEventListener('click', () => {
      state.past = !state.past; render();
    });
    const sellBtn = root.querySelector('[data-act=sell]');
    if (sellBtn) sellBtn.addEventListener('click', openSell);
  }

  function sellLabel() {
    const p = soldPercent(state.sells);
    return p > 0 ? `Sold ${fmtNum(p)}%` : 'Sell %';
  }

  // Updates only the button label: a full re-render would drop un-bound
  // inputs (past-mode times) the user may already have typed.
  function openSell() {
    const refresh = () => {
      const btn = root.querySelector('[data-act=sell]');
      if (btn) btn.textContent = sellLabel();
    };
    openSellSheet({
      actions: state.sells,
      onAdd(v) { state.sells.push(makeSellAction(genId('sell'), null, v)); refresh(); },
      onDelete(id) { state.sells = state.sells.filter(a => a.id !== id); refresh(); },
    });
  }

  // Choose from a list; optionally add a brand-new named entity (committed
  // through the store immediately, then selected).
  function pickList(title, listKey, selectedId, onPick, allowAdd) {
    const options = doc[listKey];
    selectSheet({
      title, options, selectedId, allowNone: false,
      addPlaceholder: allowAdd ? 'Add new' : null,
      onSave: sel => {
        if (sel && sel.newName) {
          let newId = null;
          mutate(d => {
            const item = { id: genId('x'), name: sel.newName };
            if (listKey === 'bankrolls') item.is_default = false;
            d[listKey].push(item);
            newId = item.id;
          });
          onPick(newId);
          return;
        }
        onPick(sel ? sel.id : null);
      },
    });
  }

  function pickNumber(title, value, min, max, onPick, suffix = '') {
    const opts = [];
    for (let i = min; i <= max; i++) opts.push({ id: String(i), name: i + suffix });
    selectSheet({
      title, options: opts, selectedId: String(value), allowNone: false,
      onSave: sel => onPick(Number(sel.id)),
    });
  }

  function pickDateTime(title, onPick) {
    openSheet({
      title,
      bodyHtml: `
        <label class="field"><span class="field-label">Date and time</span>
          <input class="input" data-role="dt" type="datetime-local" value="${toLocalInputValue(new Date())}">
        </label>
        <div class="sheet-error" data-role="err" hidden></div>
        <button class="btn-primary" data-act="ok">Save</button>`,
      onMount(sheet, close) {
        const input = sheet.querySelector('[data-role=dt]');
        const err = sheet.querySelector('[data-role=err]');
        sheet.querySelector('[data-act=ok]').addEventListener('click', () => {
          const d = new Date(input.value);
          if (!input.value || Number.isNaN(d.getTime())) {
            err.textContent = 'Enter a valid date and time'; err.hidden = false; return;
          }
          if (d.getTime() > Date.now()) {
            err.textContent = 'Time cannot be in the future'; err.hidden = false; return;
          }
          close(); onPick(d);
        });
      },
    });
  }

  function validatePastTimes(startD, endD) {
    if (!startD || Number.isNaN(startD.getTime())) return 'Enter a start time';
    if (startD.getTime() > Date.now()) return 'Start time cannot be in the future';
    if (!endD || Number.isNaN(endD.getTime())) return 'Enter an end time';
    if (endD.getTime() < startD.getTime()) return 'End time cannot be before start time';
    if (endD.getTime() > Date.now()) return 'End time cannot be in the future';
    return null;
  }

  function savePast() {
    const startD = new Date(root.querySelector('[data-role=start]').value);
    const endD = root.querySelector('[data-role=end]').value
      ? new Date(root.querySelector('[data-role=end]').value) : null;
    const err = validatePastTimes(startD, endD);
    if (err) {
      const el = root.querySelector('[data-role=time-err]');
      el.textContent = err; el.hidden = false;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    let id;
    if (kind === 'cash') {
      id = logPastSession({
        kind: 'cash',
        game_id: state.game_id, location_id: state.location_id, bankroll_id: state.bankroll_id,
        group_id: null, table_size: state.table_size,
        start_time: startD, end_time: endD,
        small_blind: state.small_blind, big_blind: state.big_blind,
        buy_in: state.buy_in || 0, cashed_out: state.cashed_out || 0,
        tips: state.tips || 0, hands_count: state.hands_count,
      });
    } else {
      const rebuys = Number(root.querySelector('[data-role=past-rebuys]').value || 0);
      id = logPastSession({
        kind: 'tournament',
        game_id: state.game_id, location_id: state.location_id, bankroll_id: state.bankroll_id,
        group_id: null, table_size: state.table_size,
        start_time: startD, end_time: endD,
        tournament_type_id: state.tournament_type_id,
        tournament_name: root.querySelector('[data-role=tname]').value.trim() || null,
        initial_buy_in: state.initial_buy_in || 0,
        total_buy_in: (state.initial_buy_in || 0) + rebuys,
        prize: state.prize || 0, position: state.position, entries: state.entries,
        tips: 0, hands_count: null,
      });
    }
    if (state.sells.length) addSellActions(id, state.sells);
    toast('Session saved');
    navigate('/session/' + id);
  }

  function startLive() {
    if (getLiveSession(getState())) {
      // Only one live session at a time (brief section 6).
      toast('A live session is already running');
      return;
    }
    const startDate = state.__start || new Date();
    if (startDate.getTime() > Date.now()) { toast('Start time cannot be in the future'); return; }
    let id;
    if (kind === 'cash') {
      id = startLiveCash({
        game_id: state.game_id, location_id: state.location_id, bankroll_id: state.bankroll_id,
        group_id: null, table_size: state.table_size,
        small_blind: state.small_blind, big_blind: state.big_blind,
        buy_in: state.buy_in || 0,
        start_time: startDate.toISOString(),
      });
    } else {
      id = startLiveTournament({
        game_id: state.game_id, location_id: state.location_id, bankroll_id: state.bankroll_id,
        group_id: null, table_size: state.table_size,
        tournament_type_id: state.tournament_type_id, tournament_name: state.tournament_name || null,
        initial_buy_in: state.initial_buy_in || 0,
        start_time: startDate.toISOString(),
      });
    }
    if (kind === 'tournament' && state.sells.length) addSellActions(id, state.sells);
    navigate('/live/' + id);
  }

  render();
}
