// Variance simulator screen (Tier 8). Standalone by design: it depends only on
// the pure engine (js/variance.js) and presentational helpers — never on the
// store — so it can be lifted into another shell (desktop lane, native port).
// Inputs persist per device in localStorage; nothing is written to user data.

import {
  simulateCash, simulateTournament, cashParamsError, tournamentParamsError,
  normalizeCash, normalizeTournament, tournamentOutcomes,
} from '../variance.js';
import { fmtMoney, fmtNum, getCurrency } from '../format.js';
import { icon } from '../icons.js';
import { esc } from '../ui.js';
import { barChart, niceScale } from '../charts/svg.js';

const STORE_KEY = 'pa27.variance.inputs';
const CSS_HREF = 'css/variance.css';
// Main-thread budget for one tap (paths × units × sub-steps). The engine
// allows more for scripted use; the UI keeps a run under ~1-2 s on a phone.
const UI_MAX_STEPS = 2e7;

const DEFAULTS = {
  model: 'cash',
  seed: 27,
  cash: { winRate: 10, stdDev: 80, bankroll: 2000, hours: 500, paths: 2000 },
  tournament: { buyIn: 20, roiPct: 20, field: 200, itmPct: 15, steepness: 1, bankroll: 1000, tournaments: 500, paths: 2000 },
};

const CASH_FIELDS = [
  { key: 'winRate', label: 'Win rate / hour', step: '0.1', money: true },
  { key: 'stdDev', label: 'Std dev / hour', step: '0.1', money: true, min: 0 },
  { key: 'bankroll', label: 'Bankroll', step: '1', money: true, min: 0 },
  { key: 'hours', label: 'Hours', step: '1', min: 1 },
  { key: 'paths', label: 'Simulations', step: '100', min: 1 },
];
const TOURNEY_FIELDS = [
  { key: 'buyIn', label: 'Buy-in', step: '1', money: true, min: 0 },
  { key: 'roiPct', label: 'ROI %', step: '1' },
  { key: 'field', label: 'Field size', step: '1', min: 2 },
  { key: 'itmPct', label: 'ITM %', step: '1', min: 0 },
  { key: 'bankroll', label: 'Bankroll', step: '1', money: true, min: 0 },
  { key: 'tournaments', label: 'Tournaments', step: '1', min: 1 },
  { key: 'paths', label: 'Simulations', step: '100', min: 1 },
];
const PAYOUTS = [[0.7, 'Flat'], [1, 'Standard'], [1.3, 'Top-heavy']];

// ---------- pure helpers ----------

// Merges saved state over defaults so new fields survive old saves.
export function mergeSaved(saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  return {
    model: s.model === 'tournament' ? 'tournament' : 'cash',
    seed: Number.isInteger(s.seed) && s.seed >= 0 ? s.seed : DEFAULTS.seed,
    cash: { ...DEFAULTS.cash, ...(s.cash || {}) },
    tournament: { ...DEFAULTS.tournament, ...(s.tournament || {}) },
  };
}

// Screen state -> engine params (percent fields become fractions).
export function toEngineParams(state) {
  if (state.model === 'cash') return normalizeCash({ ...state.cash, seed: state.seed });
  const t = state.tournament;
  return normalizeTournament({
    buyIn: t.buyIn, roi: t.roiPct / 100, field: t.field, itm: t.itmPct / 100, steepness: t.steepness,
    bankroll: t.bankroll, tournaments: t.tournaments, paths: t.paths, seed: state.seed,
  });
}

export function paramsError(state) {
  const p = toEngineParams(state);
  const e = state.model === 'cash' ? cashParamsError(p) : tournamentParamsError(p);
  if (e) return e;
  const units = state.model === 'cash' ? p.hours * p.stepsPerHour : p.tournaments;
  if (p.paths * units > UI_MAX_STEPS) return `Too much for one run: keep simulations × ${state.model === 'cash' ? 'hours' : 'tournaments'} under ${fmtNum(UI_MAX_STEPS / 1e6)} million.`;
  return null;
}

export function rorClass(fraction) {
  const pct = fraction * 100;
  return pct > 30 ? 'ror-high' : pct >= 10 ? 'ror-mid' : 'ror-low';
}

export function fmtPct(fraction) {
  if (!Number.isFinite(fraction)) return '--';
  const pct = fraction * 100;
  if (pct > 0 && pct < 0.1) return '<0.1%';
  if (pct < 100 && pct > 99.9) return '>99.9%';
  return fmtNum(Math.round(pct * 10) / 10) + '%';
}

function loadState() {
  try { return mergeSaved(JSON.parse(localStorage.getItem(STORE_KEY) || 'null')); } catch (e) {
    console.error('variance: could not read saved inputs', e);
    return mergeSaved(null);
  }
}

function saveState(state) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { console.error('variance: could not save inputs', e); }
}

// Own stylesheet, attached once (css/styles.css belongs to other lanes).
function ensureStylesheet() {
  if (document.querySelector(`link[data-variance-css]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = CSS_HREF;
  link.dataset.varianceCss = '';
  document.head.appendChild(link);
}

// ---------- charts ----------

// Fan chart: p5–p95 band, median line, a few sample paths, start bankroll.
function fanChart(result, cur) {
  const W = 340, H = 200, padL = 44, padR = 8, padT = 10, padB = 22;
  const B = result.params.bankroll;
  const bands = [{ unit: 0, p5: B, p50: B, p95: B }, ...result.bands];
  const ys = [0, ...bands.map(b => b.p95), ...bands.map(b => b.p5)];
  for (const sp of result.samplePaths) for (const pt of sp) ys.push(pt.bankroll);
  const sc = niceScale(ys, 4);
  const xMax = result.units;
  const X = u => padL + (u / xMax) * (W - padL - padR);
  const Y = v => padT + (H - padT - padB) - ((v - sc.y0) / (sc.y1 - sc.y0)) * (H - padT - padB);
  let svg = '';
  for (let i = 0; i <= sc.gridLines; i++) {
    const v = sc.y0 + ((sc.y1 - sc.y0) * i) / sc.gridLines;
    const y = Y(v).toFixed(1);
    svg += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#2a2a2a" stroke-dasharray="3 4"/>`;
    svg += `<text x="${padL - 6}" y="${(+y + 3).toFixed(1)}" font-size="9" fill="#6b6b6b" text-anchor="end">${esc(compact(v))}</text>`;
  }
  const upper = bands.map(b => `${X(b.unit).toFixed(1)} ${Y(b.p95).toFixed(1)}`);
  const lower = bands.slice().reverse().map(b => `${X(b.unit).toFixed(1)} ${Y(b.p5).toFixed(1)}`);
  svg += `<path class="vs-band" d="M${upper.join(' L')} L${lower.join(' L')} Z"/>`;
  for (const sp of result.samplePaths) {
    svg += `<path class="vs-sample" d="${sp.map((pt, i) => (i ? 'L' : 'M') + X(pt.unit).toFixed(1) + ' ' + Y(pt.bankroll).toFixed(1)).join(' ')}"/>`;
  }
  svg += `<line class="vs-start" x1="${padL}" y1="${Y(B).toFixed(1)}" x2="${W - padR}" y2="${Y(B).toFixed(1)}"/>`;
  svg += `<path class="vs-median" d="${bands.map((b, i) => (i ? 'L' : 'M') + X(b.unit).toFixed(1) + ' ' + Y(b.p50).toFixed(1)).join(' ')}"/>`;
  if (sc.y0 < 0 || Y(0) < H - padB) svg += `<line class="vs-zero" x1="${padL}" y1="${Y(0).toFixed(1)}" x2="${W - padR}" y2="${Y(0).toFixed(1)}"/>`;
  svg += `<text x="${padL}" y="${H - 6}" font-size="9" fill="#6b6b6b">0</text>`;
  svg += `<text x="${W - padR}" y="${H - 6}" font-size="9" fill="#6b6b6b" text-anchor="end">${esc(fmtNum(xMax))} ${esc(result.unitLabel)}</text>`;
  const label = `Bankroll paths in ${cur}: median and 5th to 95th percentile band over ${xMax} ${result.unitLabel}`;
  return `<svg class="line-chart vs-fan" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${svg}</svg>`;
}

// 1234 -> "1.2k" so axis labels fit the 44px gutter.
function compact(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return fmtNum(v / 1e6) + 'M';
  if (a >= 1e3) return fmtNum(Math.round(v / 100) / 10) + 'k';
  return fmtNum(v);
}

function downswingChart(result) {
  const bars = result.maxDownswing.histogram.map((b, i) => ({
    key: i, label: `${compact(b.from)}–${compact(b.to)}`, short: compact(b.to), y: (b.count / result.paths) * 100,
  }));
  return barChart({ bars, height: 170, fmtY: v => fmtNum(v) + '%', labelEvery: 3, ariaLabel: 'Max downswing distribution, percent of simulations' });
}

// ---------- rendering ----------

function fieldHtml(f, value, cur) {
  const id = 'vs-' + f.key;
  return `<label class="field vs-field" for="${id}">
    <span class="field-label">${esc(f.label)}${f.money ? ` <span class="vs-unit">${esc(cur)}</span>` : ''}</span>
    <input class="input" id="${id}" data-key="${f.key}" type="number" inputmode="decimal" step="${f.step}"${f.min !== undefined ? ` min="${f.min}"` : ''} value="${esc(value)}">
  </label>`;
}

function formHtml(state, cur) {
  const m = state.model;
  const fields = m === 'cash' ? CASH_FIELDS : TOURNEY_FIELDS;
  const vals = state[m];
  return `
    <div class="vs-grid">${fields.map(f => fieldHtml(f, vals[f.key], cur)).join('')}</div>
    ${m === 'tournament' ? `
      <div class="field">
        <span class="field-label">Payout structure</span>
        <div class="chips" role="radiogroup" aria-label="Payout structure">
          ${PAYOUTS.map(([v, l]) => `<button type="button" class="chip${vals.steepness === v ? ' active' : ''}" role="radio" aria-checked="${vals.steepness === v}" data-steep="${v}">${l}</button>`).join('')}
        </div>
      </div>` : ''}
    <p class="form-error vs-error" data-role="error" role="alert" hidden></p>`;
}

function statRow(label, valueHtml, hint = '') {
  return `<div class="stat-row vs-stat">
    <div class="stat-main">
      <span class="stat-label">${esc(label)}</span>
      <span class="stat-value">${valueHtml}</span>
      ${hint ? `<span class="hint">${hint}</span>` : ''}
    </div>
  </div>`;
}

function money(v, cur) {
  return `<span class="${v < 0 ? 'neg' : ''}">${esc(fmtMoney(v, cur))}</span>`;
}

function resultsHtml(r, cur) {
  const a = r.analytic;
  const n = r.units, unit = r.unitLabel;
  const f = r.finalBankroll;
  const mid = r.probDownAt[Math.floor((r.probDownAt.length - 1) / 2)];
  const per = r.model === 'cash' ? 'hour' : 'tournament';
  const payout = r.payout
    ? `<p class="hint vs-note">${r.payout.paid} paid · cash rate ${fmtPct(r.payout.cashProb)} · 1st pays ${fmtNum(r.payout.top)}× · min cash ${fmtNum(r.payout.minCash)}× · SD ${esc(fmtMoney(a.sdPerUnit, cur))} per tournament</p>`
    : '';
  return `
    <div class="section-label vs-section">Bankroll over ${esc(fmtNum(n))} ${esc(unit)}</div>
    <div class="chart-card vs-chart">${fanChart(r, cur)}
      <div class="vs-legend"><span><i class="vs-key vs-key-band"></i>5–95%</span><span><i class="vs-key vs-key-median"></i>Median</span><span><i class="vs-key vs-key-sample"></i>Sample runs</span></div>
    </div>
    ${payout}
    <div class="rows vs-rows">
      ${statRow('Risk of ruin', `<span class="${rorClass(r.riskOfRuin)}">${fmtPct(r.riskOfRuin)}</span>`,
        `Simulated over ${esc(fmtNum(n))} ${esc(unit)} · formula ${fmtPct(a.ruinHorizonDiscrete)} · long run ${fmtPct(a.ruinInfinite)}`)}
      <div class="stat-row vs-stat">
        <div class="stat-main">
          <span class="stat-label">Final bankroll</span>
          <div class="vs-triple">
            <div><span class="vs-q">Worst 5%</span><span class="vs-qv">${money(f.p5, cur)}</span></div>
            <div><span class="vs-q">Median</span><span class="vs-qv">${money(f.p50, cur)}</span></div>
            <div><span class="vs-q">Best 5%</span><span class="vs-qv">${money(f.p95, cur)}</span></div>
          </div>
          <span class="hint">Expected ${esc(fmtMoney(r.params.bankroll + a.expectedNet, cur))} · SD ${esc(fmtMoney(a.sdNet, cur))} (σ√N)</span>
        </div>
      </div>
      ${statRow(`Chance of being down after ${fmtNum(n)} ${unit}`, `<span class="${rorClass(r.probDown)}">${fmtPct(r.probDown)}</span>`,
        mid ? `After ${esc(fmtNum(mid.unit))} ${esc(unit)}: ${fmtPct(mid.p)}` : '')}
      ${statRow('Max downswing (median)', esc(fmtMoney(r.maxDownswing.p50, cur)),
        `Worst 5% of runs: ${esc(fmtMoney(r.maxDownswing.p95, cur))} or more · ${esc(fmtNum(r.maxDownswing.p50 / Math.max(1e-9, Math.abs(a.meanPerUnit))))} ${per}s of EV`)}
    </div>
    <div class="section-label vs-section">Max downswing distribution</div>
    <div class="chart-card vs-chart">${downswingChart(r)}
      <div class="chart-caption">% of simulations by largest peak-to-trough drop (${esc(cur)})</div>
    </div>
    <p class="hint vs-note">${esc(fmtNum(r.paths))} simulations · seed ${r.params.seed}. Same inputs and seed always give the same result. ${r.model === 'cash' ? 'Each hour is drawn from a normal distribution with your win rate and SD.' : 'Each tournament pays places in proportion to 1/place; your ROI scales how often you cash.'}</p>`;
}

export function VarianceScreen(root, doc) {
  ensureStylesheet();
  const cur = getCurrency(doc);
  const state = loadState();
  let lastResult = null;

  function readForm() {
    root.querySelectorAll('input[data-key]').forEach(inp => {
      const v = inp.value.trim() === '' ? NaN : Number(inp.value);
      state[state.model][inp.dataset.key] = v;
    });
  }

  function showError(msg) {
    const el = root.querySelector('[data-role=error]');
    el.textContent = msg || '';
    el.hidden = !msg;
    root.querySelectorAll('input[data-key]').forEach(i => i.classList.toggle('invalid', !!msg && !Number.isFinite(Number(i.value === '' ? NaN : i.value))));
  }

  function run() {
    readForm();
    const err = paramsError(state);
    if (err) { showError(err); return; }
    showError(null);
    saveState(state);
    const out = root.querySelector('[data-role=results]');
    const btn = root.querySelector('[data-act=run]');
    btn.disabled = true;
    btn.textContent = 'Simulating…';
    out.setAttribute('aria-busy', 'true');
    // Yield a frame so the busy state paints before the synchronous run.
    setTimeout(() => {
      try {
        const p = toEngineParams(state);
        lastResult = state.model === 'cash' ? simulateCash(p) : simulateTournament(p);
        out.innerHTML = resultsHtml(lastResult, cur);
      } catch (e) {
        console.error('variance: simulation failed', e);
        showError(e instanceof RangeError ? e.message : 'Simulation failed. Check the inputs and try again.');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Simulate';
        out.removeAttribute('aria-busy');
        const seedEl = root.querySelector('[data-role=seed]');
        if (seedEl) seedEl.textContent = String(state.seed);
      }
    }, 16);
  }

  function render() {
    const tournamentHint = state.model === 'tournament' ? evHint(state, cur) : '';
    root.innerHTML = `
      <div class="screen vs-screen">
        <header class="topbar">
          <button class="topbtn" data-act="back" aria-label="Back">${icon('back')}</button>
          <h1 class="topbar-title-sm">Variance simulator</h1>
          <span class="topbtn" style="visibility:hidden"></span>
        </header>
        <div class="segmented vs-seg" role="tablist" aria-label="Model">
          ${[['cash', 'Cash'], ['tournament', 'Tournament']].map(([k, l]) =>
            `<button role="tab" data-model="${k}" aria-selected="${state.model === k}" class="${state.model === k ? 'active' : ''}">${l}</button>`).join('')}
        </div>
        <form class="form vs-form" novalidate>
          ${formHtml(state, cur)}
          ${tournamentHint}
          <button class="btn-primary" type="submit" data-act="run">Simulate</button>
          <div class="vs-seed-row">
            <span class="hint">Seed <span data-role="seed">${state.seed}</span></span>
            <button type="button" class="vs-reroll" data-act="reroll">Re-roll</button>
          </div>
        </form>
        <div data-role="results" aria-live="polite">
          ${lastResult && lastResult.model === state.model ? resultsHtml(lastResult, cur)
            : '<div class="empty-state vs-empty"><p>Set your win rate and swings, then tap Simulate.</p></div>'}
        </div>
        <div class="spacer-40"></div>
      </div>`;
    wire();
  }

  function wire() {
    root.querySelector('[data-act=back]').addEventListener('click', () => { location.hash = '#/more'; });
    root.querySelectorAll('[data-model]').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.model === state.model) return;
      readForm();
      state.model = b.dataset.model;
      saveState(state);
      render();
    }));
    root.querySelectorAll('[data-steep]').forEach(b => b.addEventListener('click', () => {
      readForm();
      state.tournament.steepness = Number(b.dataset.steep);
      render();
    }));
    root.querySelector('form').addEventListener('submit', e => { e.preventDefault(); run(); });
    root.querySelector('[data-act=reroll]').addEventListener('click', () => {
      state.seed = (Math.imul(state.seed + 1, 2654435761) >>> 0) % 1000000;
      run();
    });
  }

  render();
}

// Per-tournament EV/SD summary under the tournament form, when inputs are valid.
function evHint(state, cur) {
  const p = toEngineParams(state);
  if (tournamentParamsError(p)) return '';
  const t = tournamentOutcomes(p);
  return `<p class="hint vs-note">EV ${esc(fmtMoney(t.mean, cur))} · SD ${esc(fmtMoney(t.sd, cur))} per tournament (${fmtNum(t.sd / p.buyIn)} buy-ins)</p>`;
}
