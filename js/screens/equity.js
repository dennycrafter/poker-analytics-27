// Equity calculator screen (Tier 9). Standalone: no store import, state is
// device-local in localStorage. The engine runs in a module worker so long
// PLO5 multiway runs never block the UI; if workers are unavailable it falls
// back to the main thread.

import { navigate, addCleanup } from '../router.js';
import { icon } from '../icons.js';
import { esc, openSheet } from '../ui.js';
import { GAMES, MAX_PLAYERS, MIN_PLAYERS, calculateEquity, streetName, cardId } from '../equity.js';
import {
  initialEquityState, normaliseEquityState, setGame, addPlayer, removePlayer, clearCards,
  cardAt, setCard, usedCards, nextEmptySlot, boardCount, isCalculable, equityInput,
  describeCard, monteCarloMargin,
} from '../equity-state.js';

const STATE_KEY = 'pa27.equity.state';
const CSS_HREF = 'css/equity.css';
const RECALC_DELAY_MS = 120;
// Picker grid order: suits as rows (s h d c), ranks high to low.
const PICKER_SUITS = [0, 1, 2, 3];
const PICKER_RANKS = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];

function ensureStylesheet() {
  if (document.querySelector(`link[data-equity-css]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = CSS_HREF;
  link.dataset.equityCss = '';
  document.head.appendChild(link);
}

function loadState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    return raw ? normaliseEquityState(JSON.parse(raw)) : initialEquityState();
  } catch (e) {
    console.error('equity: could not read saved hands', e);
    return initialEquityState();
  }
}

function saveState(state) {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) { console.error('equity: could not save hands', e); }
}

// ---- engine runner ---------------------------------------------------------

function createRunner() {
  let worker = null;
  let seq = 0;
  const pending = new Map();       // id -> result callback
  const pendingInputs = new Map(); // id -> main-thread replay if the worker dies
  try {
    worker = new Worker(new URL('../equity-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = e => {
      const cb = pending.get(e.data.id);
      pending.delete(e.data.id);
      if (cb) cb(e.data.result);
    };
    worker.onerror = e => {
      console.error('equity: worker failed, using main thread', e);
      worker.terminate();
      worker = null;
      // Re-run anything in flight on the main thread so no request is lost.
      for (const [, job] of pendingInputs) job();
      pendingInputs.clear();
    };
  } catch (e) {
    console.error('equity: workers unavailable, using main thread', e);
    worker = null;
  }
  return {
    run(input, cb) {
      const id = ++seq;
      const local = () => setTimeout(() => cb(calculateEquity(input)), 0);
      if (!worker) { local(); return; }
      pending.set(id, result => { pendingInputs.delete(id); cb(result); });
      pendingInputs.set(id, () => { pending.delete(id); local(); });
      worker.postMessage({ id, input });
    },
    dispose() { if (worker) worker.terminate(); worker = null; pending.clear(); pendingInputs.clear(); },
  };
}

// ---- rendering -------------------------------------------------------------

function cardHtml(c, { label, attrs = '', active = false } = {}) {
  if (c === null) {
    return `<button class="eq-card eq-card-empty${active ? ' active' : ''}" ${attrs} aria-label="${esc(label)}: empty">+</button>`;
  }
  const d = describeCard(c);
  return `<button class="eq-card eq-suit-${d.suit}${active ? ' active' : ''}" ${attrs} aria-label="${esc(label)}: ${esc(d.name)}">
    <span class="eq-rank">${d.rank}</span><span class="eq-pip" aria-hidden="true">${d.symbol}</span></button>`;
}

function fmtPct(v) { return v.toFixed(1); }

function resultLine(result) {
  if (!result || result.error) return '';
  if (result.method === 'exact') {
    return `Exact · ${result.samples.toLocaleString('en-US')} runout${result.samples === 1 ? '' : 's'}`;
  }
  const m = monteCarloMargin(result.samples);
  return `Monte Carlo · ${result.samples.toLocaleString('en-US')} trials · ±${m.toFixed(2)} pts`;
}

function playerHtml(state, i, result, busy) {
  const hand = state.players[i];
  const r = result && !result.error ? result.players[i] : null;
  const best = r && result.players.every(p => p.equity <= r.equity + 1e-9);
  const random = hand.every(c => c === null);
  const cards = hand.map((c, s) =>
    cardHtml(c, { label: `Player ${i + 1} card ${s + 1}`, attrs: `data-zone="player" data-player="${i}" data-slot="${s}"` })).join('');
  return `
    <div class="eq-player" data-player-row="${i}">
      <div class="eq-player-head">
        <span class="eq-player-name">Player ${i + 1}${random ? ' <span class="eq-random">random hand</span>' : ''}</span>
        ${state.players.length > MIN_PLAYERS
          ? `<button class="eq-remove" data-remove="${i}" aria-label="Remove player ${i + 1}">${icon('x')}</button>` : ''}
      </div>
      <div class="eq-player-body eq-body-${hand.length}">
        <div class="eq-cards eq-cards-${hand.length}">${cards}</div>
        <div class="eq-equity${best ? ' best' : ''}${busy ? ' busy' : ''}" aria-live="polite">
          ${r ? `${fmtPct(r.equity)}<span class="eq-pct">%</span>` : '<span class="eq-dash">--</span>'}
        </div>
      </div>
      ${r ? `
        <div class="eq-bar" role="img" aria-label="Win ${fmtPct(r.win)}%, tie ${fmtPct(r.tie)}%, lose ${fmtPct(r.lose)}%">
          <span class="eq-bar-win" style="width:${r.win}%"></span><span class="eq-bar-tie" style="width:${r.tie}%"></span>
        </div>
        <div class="eq-wtl"><span>Win ${fmtPct(r.win)}%</span><span>Tie ${fmtPct(r.tie)}%</span><span>Lose ${fmtPct(Math.max(0, r.lose))}%</span></div>` : ''}
    </div>`;
}

export function EquityScreen(root) {
  ensureStylesheet();
  let state = loadState();
  let result = null;
  let busy = false;
  let timer = null;
  let requestSeq = 0;
  const runner = createRunner();
  addCleanup(() => { clearTimeout(timer); runner.dispose(); });

  function recalc() {
    clearTimeout(timer);
    if (!isCalculable(state)) { result = null; busy = false; render(); return; }
    busy = true;
    render();
    const id = ++requestSeq;
    timer = setTimeout(() => {
      runner.run(equityInput(state), res => {
        if (id !== requestSeq) return; // a newer edit superseded this run
        result = res;
        busy = false;
        render();
      });
    }, RECALC_DELAY_MS);
  }

  function update(next) {
    state = next;
    saveState(state);
    recalc();
  }

  function render() {
    const nBoard = boardCount(state);
    const err = result && result.error;
    root.innerHTML = `
      <div class="screen eq-screen">
        <header class="topbar">
          <button class="topbtn" data-act="back" aria-label="Back">${icon('back')}</button>
          <h1>Equity</h1>
          <button class="topbtn" data-act="clear" aria-label="Clear all cards">${icon('trash')}</button>
        </header>
        <div class="segmented" role="tablist" aria-label="Game">
          ${Object.values(GAMES).map(g =>
            `<button role="tab" data-game="${g.id}" aria-selected="${state.game === g.id}" class="${state.game === g.id ? 'active' : ''}">${esc(g.label)}</button>`).join('')}
        </div>
        <div class="eq-section-head">
          <span class="eq-label">Board</span><span class="eq-street">${streetName(nBoard)}</span>
        </div>
        <div class="eq-board">
          ${state.board.map((c, s) => cardHtml(c, { label: `Board card ${s + 1}`, attrs: `data-zone="board" data-slot="${s}"` })).join('')}
        </div>
        <div class="eq-section-head">
          <span class="eq-label">Players</span>
          <span class="eq-street">${state.players.length} of ${MAX_PLAYERS}</span>
        </div>
        <div class="eq-players">
          ${state.players.map((_, i) => playerHtml(state, i, result, busy)).join('')}
        </div>
        ${state.players.length < MAX_PLAYERS
          ? `<button class="btn-secondary eq-add" data-act="add">${icon('plus')}<span>Add player</span></button>` : ''}
        <p class="eq-meta${err ? ' eq-error' : ''}" aria-live="polite">${
          err ? esc(result.error)
            : !isCalculable(state) ? 'Tap a card slot to pick hole cards. Empty hands are dealt at random.'
            : busy ? 'Calculating…'
            : esc(resultLine(result))}</p>
        <div class="spacer-40"></div>
      </div>`;
    bind();
  }

  function bind() {
    root.querySelector('[data-act=back]').addEventListener('click', () => navigate('/more'));
    root.querySelector('[data-act=clear]').addEventListener('click', () => update(clearCards(state)));
    const add = root.querySelector('[data-act=add]');
    if (add) add.addEventListener('click', () => update(addPlayer(state)));
    root.querySelectorAll('[data-game]').forEach(b => b.addEventListener('click', () => update(setGame(state, b.dataset.game))));
    root.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', () => update(removePlayer(state, Number(b.dataset.remove)))));
    root.querySelectorAll('.eq-card[data-zone]').forEach(b => b.addEventListener('click', () => {
      const target = b.dataset.zone === 'board'
        ? { zone: 'board', slot: Number(b.dataset.slot) }
        : { zone: 'player', player: Number(b.dataset.player), slot: Number(b.dataset.slot) };
      openPicker(target);
    }));
  }

  // Card picker sheet: tapping a card fills the slot and advances to the next
  // empty slot in the same hand/board; the sheet closes when that is full.
  function openPicker(startTarget) {
    let target = startTarget;
    const title = t => (t.zone === 'board' ? `Board card ${t.slot + 1}` : `Player ${t.player + 1} · card ${t.slot + 1}`);
    openSheet({
      title: title(target),
      bodyHtml: `<div class="eq-picker" role="grid" aria-label="Choose a card"></div>
        <div class="sheet-actions">
          <button class="btn-secondary" data-act="clear-slot">Clear slot</button>
          <button class="btn-primary" data-act="done">Done</button>
        </div>`,
      onMount(sheet, close) {
        const grid = sheet.querySelector('.eq-picker');
        const titleEl = sheet.querySelector('.sheet-title');
        const paint = () => {
          titleEl.textContent = title(target);
          const used = usedCards(state);
          const current = cardAt(state, target);
          grid.innerHTML = PICKER_SUITS.map(s => `<div class="eq-picker-row" role="row">${PICKER_RANKS.map(r => {
            const c = cardId(r, s);
            const d = describeCard(c);
            const taken = used.has(c) && c !== current;
            return `<button role="gridcell" class="eq-pick eq-suit-${d.suit}${c === current ? ' active' : ''}" data-card="${c}"
              ${taken ? 'disabled aria-disabled="true"' : ''} aria-label="${esc(d.name)}${taken ? ' (in use)' : ''}">
              <span class="eq-rank">${d.rank === '10' ? 'T' : d.rank}</span><span class="eq-pip" aria-hidden="true">${d.symbol}</span></button>`;
          }).join('')}</div>`).join('');
          grid.querySelectorAll('.eq-pick:not([disabled])').forEach(b => b.addEventListener('click', () => {
            update(setCard(state, target, Number(b.dataset.card)));
            const next = nextEmptySlot(state, target);
            if (!next) { close(); return; }
            target = next;
            paint();
          }));
        };
        paint();
        sheet.querySelector('[data-act=clear-slot]').addEventListener('click', () => { update(setCard(state, target, null)); close(); });
        sheet.querySelector('[data-act=done]').addEventListener('click', close);
        const first = grid.querySelector('.eq-pick:not([disabled])');
        if (first) first.focus();
      },
    });
  }

  recalc();
}
