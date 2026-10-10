// Variance screen (brief sections 4 to 6): tabs for Cash, Tournaments and
// Your Year. Pure state and derivation live in js/variance-ui-state.js; the
// simulation contracts (js/variance-cash.js, js/variance-tour.js,
// js/year-sim.js) are loaded lazily so the screen still opens if one is not
// merged yet, with a plain message when a run needs it. Inputs persist per
// device in localStorage; the settings sync mapping has no variance key yet
// (noted in the completion report), so nothing here writes to user data.

import {
  TABS, CASH_NEED_MESSAGE, normalizeTab, nextSeed, cashStats, commonBB,
  cashPrefill, tourStats, bandCurve, samplePaths, percentileRows,
  downswingRows, downswingChance, floorHpm, downswingHorizons, rorRows, round2,
  defaultTourTypes, addTourType, normalizeTourTypes,
  normalizePath, yearRows, yearExtremes, mergeUiState, binsOf, tourRor, tourBankrollFor,
} from '../variance-ui-state.js';
import { statsSessions } from './stats.js';
import { fmtMoney, fmtNum, getCurrency, moneyClass } from '../format.js';
import { icon } from '../icons.js';
import { esc } from '../ui.js';
import { barChart, niceScale } from '../charts/svg.js';

const STORE_KEY = 'pa27.variance.ui';
const CSS_HREF = 'css/variance.css';
const ROR_NOTE = 'Assumes you never move down. Moving down when you lose a lot of your bankroll makes real risk much lower.';
const TOUR_SKEW_NOTE = 'Tournament results are skewed: most runs lose a bit, a few big scores carry the average.';
const YEAR_NOTE = 'This is what a normal year looks like at your real winrate.';
const RISK_LEVELS = [[0.5, '50%'], [0.2, '20%'], [0.05, '5%'], [0.01, '1%']];

// Lazy contract loader; a missing module becomes null instead of breaking
// the whole screen at import time.
let mathCache = null;
function loadMath() {
  if (!mathCache) {
    const grab = url => import(url).catch(err => ({ err }));
    mathCache = Promise.all([
      grab('../variance-cash.js'), grab('../variance-tour.js'), grab('../year-sim.js'),
    ]).then(([cash, tour, year]) => ({ cash: cash.err ? null : cash, tour: tour.err ? null : tour, year: year.err ? null : year }));
  }
  return mathCache;
}

function loadState() {
  try { return mergeUiState(JSON.parse(localStorage.getItem(STORE_KEY) || 'null')); }
  catch (e) { console.error('variance: could not read saved inputs', e); return mergeUiState(null); }
}

function saveState(state) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { console.error('variance: could not save inputs', e); }
}

// Own stylesheet, attached once (css/styles.css belongs to other lanes).
function ensureStylesheet() {
  if (document.querySelector('link[data-variance-css]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = CSS_HREF;
  link.dataset.varianceCss = '';
  document.head.appendChild(link);
}

// ---------- shared formatting ----------

export function fmtPct(fraction) {
  if (!Number.isFinite(fraction)) return '--';
  const pct = fraction * 100;
  if (pct > 0 && pct < 0.1) return '<0.1%';
  if (pct <= 100 && pct > 99.9) return '>99.9%';
  return fmtNum(Math.round(pct * 10) / 10) + '%';
}

export function rorClass(fraction) {
  const pct = fraction * 100;
  return pct > 30 ? 'ror-high' : pct >= 10 ? 'ror-mid' : 'ror-low';
}

// 1234 -> "1.2k" so axis labels fit the 44px gutter.
function compact(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return fmtNum(v / 1e6) + 'M';
  if (a >= 1e3) return fmtNum(Math.round(v / 100) / 10) + 'k';
  return fmtNum(Math.round(v));
}

function moneyHtml(v, cur) {
  return `<span class="${moneyClass(Math.round(v))}">${esc(fmtMoney(Math.round(v), cur))}</span>`;
}

// Money produced in $ inside the simulation, shown in the tab's unit.
function unitMoney(v, ui, cur) {
  if (ui.unit !== 'BB') return moneyHtml(v, cur);
  const bb = Math.max(0.01, ui.bbSize);
  return `<span class="${moneyClass(v / bb)}">${esc(fmtNum(Math.round((v / bb) * 10) / 10))} BB</span>`;
}

function statRow(label, valueHtml, hint = '') {
  return `<div class="stat-row vs-stat">
    <div class="stat-main">
      <span class="stat-label">${label}</span>
      <span class="stat-value">${valueHtml}</span>
      ${hint ? `<span class="hint">${hint}</span>` : ''}
    </div>
  </div>`;
}

// Small label/value grid cell for percentiles and month rows.
function cell(q, v, extra = '') {
  return `<div><span class="vs-q">${q}</span><span class="vs-qv ${extra}">${v}</span></div>`;
}

function triple(cells) {
  return `<div class="vs-triple">${cells.join('')}</div>`;
}

function ladderHtml(pct, keys, ui, cur) {
  const rows = percentileRows(pct, keys);
  if (!rows.length) return '<p class="hint vs-note">Percentiles are not available for these inputs.</p>';
  return rows.map(r => cell(r.label, unitMoney(r.value, ui, cur))).reduce((acc, c, i) => {
    const chunk = Math.floor(i / 3);
    (acc[chunk] = acc[chunk] || []).push(c);
    return acc;
  }, []).map(triple).join('');
}

// ---------- charts ----------

// Profit-space fan chart: 95% band, EV line, sample paths, zero line.
function projectionChart({ band, paths, xMax, unitLabel, evEnd }) {
  const W = 340, H = 200, padL = 44, padR = 8, padT = 10, padB = 22;
  const pts = [...band, ...paths.flat()].map(p => p.v !== undefined ? p.v : p.lo).filter(Number.isFinite);
  const ys = [0, evEnd || 0, ...band.flatMap(b => [b.lo, b.hi]), ...pts];
  const sc = niceScale(ys, 4);
  const X = t => padL + (t / xMax) * (W - padL - padR);
  const Y = v => padT + (H - padT - padB) - ((v - sc.y0) / (sc.y1 - sc.y0)) * (H - padT - padB);
  let svg = '';
  for (let i = 0; i <= sc.gridLines; i++) {
    const v = sc.y0 + ((sc.y1 - sc.y0) * i) / sc.gridLines;
    const y = Y(v).toFixed(1);
    svg += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#2a2a2a" stroke-dasharray="3 4"/>`;
    svg += `<text x="${padL - 6}" y="${(+y + 3).toFixed(1)}" font-size="9" fill="#6b6b6b" text-anchor="end">${esc(compact(v))}</text>`;
  }
  if (band.length) {
    const upper = band.map(b => `${X(b.t).toFixed(1)} ${Y(b.hi).toFixed(1)}`);
    const lower = band.slice().reverse().map(b => `${X(b.t).toFixed(1)} ${Y(b.lo).toFixed(1)}`);
    svg += `<path class="vs-band" d="M${upper.join(' L')} L${lower.join(' L')} Z"/>`;
  }
  for (const sp of paths) {
    svg += `<path class="vs-sample" d="${sp.map((p, i) => (i ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(p.v).toFixed(1)).join(' ')}"/>`;
  }
  svg += `<path class="vs-median" d="M${X(0).toFixed(1)} ${Y(0).toFixed(1)} L${X(xMax).toFixed(1)} ${Y(evEnd || 0).toFixed(1)}"/>`;
  svg += `<line class="vs-zero" x1="${padL}" y1="${Y(0).toFixed(1)}" x2="${W - padR}" y2="${Y(0).toFixed(1)}"/>`;
  svg += `<text x="${padL}" y="${H - 6}" font-size="9" fill="#6b6b6b">0</text>`;
  svg += `<text x="${W - padR}" y="${H - 6}" font-size="9" fill="#6b6b6b" text-anchor="end">${esc(fmtNum(xMax))} ${esc(unitLabel)}</text>`;
  const label = `Projection in ${unitLabel}: EV line, shaded 95% band and sample runs`;
  return `<svg class="line-chart vs-fan" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${svg}</svg>`;
}

const chartLegend = `<div class="vs-legend"><span><i class="vs-key vs-key-band"></i>95% band</span><span><i class="vs-key vs-key-median"></i>EV</span><span><i class="vs-key vs-key-sample"></i>Sample runs</span></div>`;

function histChart(finals, ariaLabel) {
  const bars = binsOf(finals, 16).map(b => ({ ...b, y: b.count, label: b.short }));
  return barChart({ bars, height: 170, fmtY: v => fmtNum(v), labelEvery: 3, ariaLabel });
}

// ---------- form pieces ----------

function fieldHtml(key, label, value, opts = {}) {
  const type = opts.type || 'number';
  return `<label class="field vs-field" for="f-${key}">
    <span class="field-label">${label}</span>
    <input class="input" id="f-${key}" data-key="${key}" type="${type}"${type === 'number' ? ' inputmode="decimal"' : ''}
      step="${opts.step || '1'}"${opts.min !== undefined ? ` min="${opts.min}"` : ''} value="${esc(value)}"${opts.disabled ? ' disabled' : ''}>
  </label>`;
}

function segChips(group, options, active) {
  return `<div class="chips" role="radiogroup" aria-label="${esc(group)}">
    ${options.map(([v, l]) => `<button type="button" class="chip${String(v) === String(active) ? ' active' : ''}" role="radio" aria-checked="${String(v) === String(active)}" data-${group}="${v}">${l}</button>`).join('')}
  </div>`;
}

// ---------- cash tab ----------

function cashFormHtml(state, stats, cur) {
  const ui = state.cash;
  const prefilled = stats && stats.usd;
  const banner = prefilled
    ? `<p class="hint vs-note">Based on ${fmtNum(stats.n)} filtered sessions (${esc(fmtNum(Math.round(stats.hours)))} hours).</p>`
    : `<p class="hint vs-note">${esc(CASH_NEED_MESSAGE)}</p>`;
  const unit = ui.unit;
  const rateLabel = unit === 'BB' ? 'bb per 100 hands' : 'per hour';
  const volLabel = ui.volumeUnit === 'hands' ? 'Volume (hands)' : 'Volume (hours)';
  const bbCell = unit === 'BB' ? fieldHtml('bbSize', 'Big blind', ui.bbSize, { step: '0.01', min: 0.01 }) : '';
  return `
    ${banner}
    <div class="chip-row" style="display:flex;gap:8px;flex-wrap:wrap">
      <button type="button" class="chip" data-act="use-stats">Use my stats</button>
      <button type="button" class="chip" data-act="reset-stats">Reset to my stats</button>
    </div>
    <div class="field">
      <span class="field-label">Units</span>
      ${segChips('unit', [['$', '$'], ['BB', 'BB']], unit)}
    </div>
    <div class="field">
      <span class="field-label">Volume in</span>
      ${segChips('vol', [['hours', 'Hours'], ['hands', ui.volumeUnit === 'hands' || (stats && stats.hasHands) ? 'Hands' : 'Hands (no hand counts)']], ui.volumeUnit)}
    </div>
    <div class="vs-grid">
      ${fieldHtml('wr', `Win rate (${esc(unit === 'BB' ? 'bb/100' : '$/hr')})`, ui.wr, { step: '0.1' })}
      ${fieldHtml('sd', `Std dev (${esc(unit === 'BB' ? 'bb/100' : '$/hr')})`, ui.sd, { step: '0.1', min: 0.01 })}
      ${fieldHtml('volume', volLabel, ui.volume, { step: '1', min: 1 })}
      ${fieldHtml('bankroll', 'Bankroll', ui.bankroll, { step: '1', min: 0 })}
      ${bbCell}
      ${fieldHtml('x', `Downswing of at least (${esc(unit)})`, ui.x === null ? '' : ui.x, { step: '10', min: 0 })}
      ${fieldHtml('hpm', 'Hours per month', ui.hpm === null ? '' : ui.hpm, { step: '1', min: 0 })}
    </div>
    <p class="hint vs-note">${ui.volumeUnit === 'hands' ? `Hand counts give about ${esc(fmtNum(Math.round(stats && stats.handsPerHour || 30)))} hands per hour across these sessions.` : `Rates shown ${esc(rateLabel)}.`}</p>`;
}

function cashResultsHtml(out, ui, cur) {
  const proj = out.proj, downs = out.downs, rows = out.rows;
  const T = out.hoursT;
  const parts = [];
  parts.push(`<div class="section-label vs-section">Projection over ${esc(fmtNum(Math.round(T)))} hours</div>`);
  parts.push(`<div class="chart-card vs-chart">${projectionChart({ band: out.band, paths: out.paths, xMax: T, unitLabel: 'hours', evEnd: proj.mean })}
    ${chartLegend}</div>`);
  parts.push(`<div class="rows vs-rows">
    ${statRow('Mean result', unitMoney(proj.mean, ui, cur))}
    ${statRow('SD of the result', unitMoney(proj.sd, ui, cur))}
    ${statRow('Chance of a loss', `<span class="${rorClass(proj.chanceOfLoss)}">${fmtPct(proj.chanceOfLoss)}</span>`)}
  </div>`);
  parts.push(`<div class="section-label vs-section">Result percentiles</div>`);
  parts.push(ladderHtml(proj.percentiles, [1, 5, 25, 50, 75, 95, 99], ui, cur));
  if (downs && downs.size) {
    const d = downswingRows(downs);
    parts.push(`<div class="section-label vs-section">Downswings over ${esc(fmtNum(Math.round(T)))} hours</div>`);
    parts.push(triple(d.size.map(r => cell(`Size ${r.label}`, unitMoney(r.value, ui, cur)))));
    parts.push(triple(d.length.map(r => cell(`Length ${r.label}`, esc(fmtNum(Math.round(r.value))) + 'h'))));
  }
  if (out.chances) {
    parts.push(`<div class="section-label vs-section">Chance of a downswing of at least ${esc(fmtNum(round2(ui.x)))}</div>`);
    for (const [k, label] of [['month', 'in a month'], ['quarter', 'in a quarter'], ['year', 'in a year']]) {
      const c = out.chances[k];
      if (c === null || c === undefined) continue;
      parts.push(statRow(label.charAt(0).toUpperCase() + label.slice(1), fmtPct(c),
        out.hpmFloored ? 'Using at least 10 hours per month.' : ''));
    }
  }
  if (rows) {
    parts.push(`<div class="section-label vs-section">Bankroll</div>`);
    parts.push(`<div class="rows vs-rows">
      ${statRow('Risk of ruin at your bankroll', `<span class="${rorClass(rows.current)}">${fmtPct(rows.current)}</span>`)}
      ${rows.table.map(r => statRow(`Bankroll for ${esc(r.label)} risk of ruin`, moneyHtml(r.bankroll, cur))).join('')}
    </div>`);
    if (out.sensitivity && out.sensitivity.length) {
      parts.push(`<div class="section-label vs-section">What if your winrate is wrong?</div>`);
      parts.push(`<div class="rows vs-rows">${out.sensitivity.map(r => statRow(
        esc(r.label || r.name || 'Row'),
        `<span class="${rorClass(r.ror)}">${fmtPct(r.ror)}</span>`,
        r.bankroll !== undefined && r.bankroll !== null ? `Bankroll for 5% risk: ${esc(fmtMoney(Math.round(r.bankroll), cur))}` : '',
      )).join('')}</div>`);
    }
    parts.push(`<p class="hint vs-note">${esc(ROR_NOTE)}</p>`);
  }
  return parts.join('');
}

// ---------- tournaments tab ----------

function typeFormHtml(t, idx, cur) {
  return `<div class="vs-type" data-tidx="${idx}">
    <div class="vs-grid">
      ${fieldHtml(`t${idx}-name`, 'Name', t.name, { type: 'text' })}
      ${fieldHtml(`t${idx}-buyin`, 'Buy-in', t.buyin, { step: '1', min: 0 })}
      ${fieldHtml(`t${idx}-rakePct`, 'Rake %', t.rakePct, { step: '0.5', min: 0 })}
      ${fieldHtml(`t${idx}-entries`, 'Entries', t.entries, { step: '1', min: 2 })}
      ${fieldHtml(`t${idx}-percentPaidPct`, 'Percent paid', t.percentPaidPct, { step: '0.5', min: 0 })}
      ${fieldHtml(`t${idx}-roiPct`, 'ROI %', t.roiPct, { step: '1' })}
      ${fieldHtml(`t${idx}-events`, 'Events', t.events, { step: '1', min: 1 })}
    </div>
    <div class="chip-row"><button type="button" class="chip" data-act="remove-type" data-idx="${idx}">Remove</button></div>
  </div>`;
}

function tourFormHtml(state, tstats, cur) {
  const warn = state.tournaments.statsN
    ? `<p class="hint vs-note">Your ROI comes from only ${fmtNum(state.tournaments.statsN)} events and is mostly noise. Most players should model 10% to 30%.</p>`
    : '';
  return `
    ${tstats ? `<p class="hint vs-note">${fmtNum(tstats.n)} tournaments in your filtered sessions.</p>` : '<p class="hint vs-note">Log tournaments to prefill from your stats.</p>'}
    <div class="chip-row" style="display:flex;gap:8px;flex-wrap:wrap">
      <button type="button" class="chip" data-act="tour-use-stats">Use my stats</button>
      <button type="button" class="chip" data-act="add-type">Add type</button>
    </div>
    ${warn}
    ${state.tournaments.types.map((t, i) => typeFormHtml(t, i, cur)).join('')}
    ${fieldHtml('bankroll', 'Bankroll', state.tournaments.bankroll, { step: '1', min: 0 })}`;
}

function perTypeHtml(rows, cur) {
  if (!Array.isArray(rows) || !rows.length) return '';
  return rows.map(r => `<div class="rows vs-rows">
    ${statRow(esc(r.name || 'Type'),
      `${fmtPct(r.itmPct)} in the money`,
      `Prize pool ${esc(fmtMoney(Math.round(r.prizePool || 0), cur))} · 1st pays ${esc(fmtMoney(Math.round(r.firstPrize || 0), cur))}`)}
    ${triple([
      cell('EV / event', moneyHtml(r.ev || 0, cur)),
      cell('SD / event', moneyHtml(r.sd || 0, cur)),
      cell('Events', esc(fmtNum(r.events || 0))),
    ])}
  </div>`).join('');
}

function rorBlockHtml(minRunning, bankroll, cur, title) {
  if (!Array.isArray(minRunning) || !minRunning.length) return '';
  const current = tourRor(minRunning, bankroll);
  const table = RISK_LEVELS.map(([r, label]) => ({ label, bankroll: tourBankrollFor(minRunning, r) }));
  return `<div class="section-label vs-section">${esc(title)}</div>
    <div class="rows vs-rows">
      ${statRow('Risk of ruin at your bankroll', `<span class="${rorClass(current || 0)}">${fmtPct(current || 0)}</span>`)}
      ${table.map(r => statRow(`Bankroll for ${esc(r.label)} risk of ruin`, r.bankroll === null ? '--' : moneyHtml(r.bankroll, cur))).join('')}
    </div>
    <p class="hint vs-note">${esc(ROR_NOTE)}</p>`;
}

function tourResultsHtml(out, cur) {
  const sim = out.sim, totalEvents = out.totalEvents;
  const parts = [];
  const totals = sim.totals || {};
  parts.push(`<div class="section-label vs-section">Over ${esc(fmtNum(totalEvents))} events</div>`);
  parts.push(`<div class="rows vs-rows">
    ${statRow('Mean result', moneyHtml(totals.mean || 0, cur))}
    ${statRow('SD of the result', moneyHtml(totals.sd || 0, cur))}
    ${statRow('Chance of a loss', `<span class="${rorClass(totals.chanceOfLoss || 0)}">${fmtPct(totals.chanceOfLoss || 0)}</span>`)}
  </div>`);
  if (totals.percentiles) {
    parts.push(`<div class="section-label vs-section">Result percentiles</div>`);
    parts.push(ladderHtml(totals.percentiles, [1, 5, 10, 25, 50, 75, 90, 95, 99], { unit: '$' }, cur));
  }
  if (Array.isArray(sim.paths) && sim.paths.length) {
    parts.push(`<div class="section-label vs-section">Sample paths</div>`);
    parts.push(`<div class="chart-card vs-chart">${projectionChart({
      band: [], paths: sim.paths.map(normalizePath), xMax: totalEvents, unitLabel: 'events', evEnd: totals.mean || 0,
    })}${chartLegend}<div class="chart-caption">${esc(TOUR_SKEW_NOTE)}</div></div>`);
  }
  if (Array.isArray(sim.finals) && sim.finals.length) {
    parts.push(`<div class="section-label vs-section">Result distribution</div>`);
    parts.push(`<div class="chart-card vs-chart">${histChart(sim.finals, 'Distribution of simulated total results')}</div>`);
  }
  const per = perTypeHtml(sim.perType, cur);
  if (per) parts.push(`<div class="section-label vs-section">By event type</div>${per}`);
  parts.push(rorBlockHtml(sim.minRunning, out.bankroll, cur, 'Bankroll over these events'));
  parts.push(rorBlockHtml(out.long && out.long.minRunning, out.bankroll, cur, 'Bankroll over a long run (2,000 events)'));
  return parts.join('');
}

// ---------- year tab ----------

function yearFormHtml(state, hpmDefault) {
  return `
    <p class="hint vs-note">${esc(YEAR_NOTE)}</p>
    <div class="vs-grid">
      ${fieldHtml('hpm', 'Hours per month', state.year.hpm === null ? (hpmDefault || '') : state.year.hpm, { step: '1', min: 0 })}
    </div>
    <p class="hint vs-note">${hpmDefault ? `Your average over the last 90 days is about ${esc(fmtNum(Math.round(hpmDefault)))} hours per month (minimum 10).` : 'Enter your hours per month (minimum 10).'}</p>`;
}

function yearResultsHtml(out, cur) {
  const y = out.year;
  const rows = yearRows(y);
  if (!rows.length) return '<p class="hint vs-note">The year simulation did not return months. Check the inputs and try again.</p>';
  const annual = rows.reduce((a, r) => ({ result: a.result + r.result, ev: a.ev + r.ev }), { result: 0, ev: 0 });
  const ext = yearExtremes(y);
  const parts = [];
  parts.push(`<div class="rows vs-rows">
    ${statRow('Annual result', moneyHtml(annual.result, cur), `Against an EV of ${esc(fmtMoney(Math.round(annual.ev), cur))}`)}
    ${ext.luckiest !== null ? statRow('Luckiest month', esc(rows[ext.luckiest].label), `${esc(fmtNum(rows[ext.luckiest].z))} SD above EV`) : ''}
    ${ext.unluckiest !== null ? statRow('Unluckiest month', esc(rows[ext.unluckiest].label), `${esc(fmtNum(rows[ext.unluckiest].z))} SD below EV`) : ''}
  </div>`);
  parts.push(`<div class="section-label vs-section">Month by month</div>`);
  for (const r of rows) {
    const luck = r.luck === 'lucky' ? ' (lucky)' : r.luck === 'unlucky' ? ' (unlucky)' : '';
    parts.push(triple([
      cell(esc(r.label) + luck, moneyHtml(r.result, cur), moneyClass(Math.round(r.result))),
      cell('EV', moneyHtml(r.ev, cur)),
      cell('SDs from EV', esc(fmtNum(r.z))),
    ]));
  }
  return parts.join('');
}

// ---------- screen ----------

export function VarianceScreen(root, doc) {
  ensureStylesheet();
  const cur = getCurrency(doc);
  const state = loadState();
  const results = { cash: '', tournaments: '', year: '' };
  let defaultHpm = null;

  const sessions = () => statsSessions(doc);

  function readForm() {
    root.querySelectorAll('input[data-key]').forEach(inp => {
      const raw = inp.value.trim() === '' ? null : Number(inp.value);
      const key = inp.dataset.key;
      if (state.tab === 'cash') {
        state.cash[key] = raw;
      } else if (state.tab === 'tournaments') {
        if (key === 'bankroll') state.tournaments.bankroll = raw === null ? 0 : raw;
        else {
          const block = inp.closest('[data-tidx]');
          if (block) {
            const t = state.tournaments.types[Number(block.dataset.tidx)];
            if (t) t[key] = key === 'name' ? (inp.value.trim() || null) : raw;
          }
        }
      } else if (state.tab === 'year') {
        if (key === 'hpm') state.year.hpm = raw;
      }
    });
  }

  function showFormError(msg) {
    const el = root.querySelector('[data-role=error]');
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  function setOut(tab, html) {
    results[tab] = html;
    const out = root.querySelector('[data-role=results]');
    if (out && state.tab === tab) out.innerHTML = html || emptyHtml(tab);
  }

  const emptyHtml = tab => `<div class="empty-state vs-empty"><p>${{
    cash: 'Set your inputs and tap Simulate.',
    tournaments: 'Set your event types and tap Simulate.',
    year: 'Set your hours per month and tap Simulate year.',
  }[tab] || 'Tap Simulate.'}</p></div>`;

  function setBusy(b) {
    const btn = root.querySelector('button[type=submit]');
    if (btn) { btn.disabled = b; btn.textContent = b ? 'Simulating...' : submitLabel(); }
    const out = root.querySelector('[data-role=results]');
    if (out) { if (b) out.setAttribute('aria-busy', 'true'); else out.removeAttribute('aria-busy'); }
  }

  const submitLabel = () => (state.tab === 'year' ? 'Simulate year' : 'Simulate');

  // Display-unit cash inputs -> $ per hour plus a horizon in hours.
  function cashToDollarInputs(ui, hph) {
    const bb = ui.unit === 'BB' ? Math.max(0.01, ui.bbSize || 1) : 1;
    let wr = Number(ui.wr) * bb;
    let sd = Number(ui.sd) * bb;
    let hoursT = Number(ui.volume);
    if (ui.volumeUnit === 'hands') {
      const perHour = hph > 0 ? hph : 30;
      wr = wr * perHour / 100;
      sd = sd * perHour / 100;
      hoursT = Number(ui.volume) / perHour;
    }
    return { wr, sd, hoursT, ok: Number.isFinite(wr) && Number.isFinite(sd) && sd > 0 && Number.isFinite(hoursT) && hoursT > 0 };
  }

  function cashStatsOrNull() {
    return cashStats(doc, sessions());
  }

  function useMyStats() {
    const stats = cashStatsOrNull();
    const prefill = cashPrefill(stats, state.cash.unit, state.cash.volumeUnit);
    if (!prefill) { showFormError(CASH_NEED_MESSAGE); return false; }
    showFormError(null);
    state.cash.wr = prefill.wr;
    state.cash.sd = prefill.sd;
    state.cash.volume = prefill.volume;
    const bb = commonBB(doc, sessions());
    if (bb) state.cash.bbSize = bb;
    saveState(state);
    return true;
  }

  async function runCash() {
    const M = await loadMath();
    if (!M.cash) { setOut('cash', `<p class="hint vs-note">Cash variance math is not available yet.</p>`); return; }
    const ui = state.cash;
    const stats = cashStatsOrNull();
    const hph = stats && stats.handsPerHour > 0 ? stats.handsPerHour : 30;
    const p = cashToDollarInputs(ui, hph);
    if (!p.ok) { showFormError('Enter a win rate, an SD and a volume to project.'); return; }
    showFormError(null);
    saveState(state);
    setBusy(true);
    try {
      const proj = M.cash.project({ wr: p.wr, sd: p.sd, hoursT: p.hoursT });
      const downs = M.cash.downswings({ wr: p.wr, sd: p.sd, totalHours: p.hoursT, paths: 2000, seed: state.seeds.cash });
      const chances = {};
      let hpmFloored = false;
      if (Number.isFinite(Number(ui.x)) && ui.x !== null && Number(ui.x) > 0) {
        const horizons = downswingHorizons({ hpm: ui.hpm, volumeUnit: ui.volumeUnit, handsPerHour: hph });
        hpmFloored = floorHpm(ui.hpm) !== Number(ui.hpm);
        for (const [k, hrs] of Object.entries(horizons)) {
          const d = M.cash.downswings({ wr: p.wr, sd: p.sd, totalHours: hrs, paths: 1000, seed: state.seeds.cash + 1 });
          chances[k] = d && d.size ? downswingChance(Number(ui.x) * (ui.unit === 'BB' ? Math.max(0.01, ui.bbSize || 1) : 1), d.size) : null;
        }
      }
      const rows = rorRows({
        wr: p.wr, sd: p.sd, bankroll: ui.bankroll,
        rorFn: B => M.cash.ror(B, p.wr, p.sd),
        bankrollForFn: r => M.cash.bankrollFor(r, p.wr, p.sd),
      });
      const sensitivity = typeof M.cash.sensitivityRows === 'function'
        ? M.cash.sensitivityRows(p.wr, p.sd, ui.bankroll) : null;
      setOut('cash', cashResultsHtml({
        proj, downs, rows, chances, hpmFloored, hoursT: p.hoursT,
        band: bandCurve({ wr: p.wr, sd: p.sd, hoursT: p.hoursT, steps: 40 }),
        paths: samplePaths({ wr: p.wr, sd: p.sd, hoursT: p.hoursT, count: 20, seed: state.seeds.cash, steps: 40 }),
        sensitivity: Array.isArray(sensitivity) ? sensitivity : null,
      }, ui, cur));
    } catch (e) {
      console.error('variance: cash simulation failed', e);
      setOut('cash', `<p class="hint vs-note">The cash simulation failed. Check the inputs and try again.</p>`);
    } finally {
      setBusy(false);
    }
  }

  async function runTour() {
    const M = await loadMath();
    if (!M.tour) { setOut('tournaments', `<p class="hint vs-note">Tournament variance math is not available yet.</p>`); return; }
    const types = normalizeTourTypes(state.tournaments.types);
    const totalEvents = types.reduce((a, t) => a + Number(t.events || 0), 0);
    if (!totalEvents) { showFormError('Set at least one event across your types.'); return; }
    showFormError(null);
    saveState(state);
    setBusy(true);
    try {
      const sim = M.tour.simulate({ types, runs: 10000, seed: state.seeds.tour });
      // Same mix stretched to a 2,000-event long run for the RoR table.
      const factor = 2000 / totalEvents;
      const scaled = types.map(t => ({ ...t, events: Math.max(1, Math.round(Number(t.events || 0) * factor)) }));
      const long = M.tour.simulate({ types: scaled, runs: 10000, seed: state.seeds.tour + 1 });
      setOut('tournaments', tourResultsHtml({ sim, long, totalEvents, bankroll: state.tournaments.bankroll }, cur));
    } catch (e) {
      console.error('variance: tournament simulation failed', e);
      setOut('tournaments', `<p class="hint vs-note">The tournament simulation failed. Check the inputs and try again.</p>`);
    } finally {
      setBusy(false);
    }
  }

  function defaultHpmOrNull() {
    return defaultHpm;
  }

  async function computeDefaultHpm() {
    const M = await loadMath();
    if (M.cash && typeof M.cash.avgHoursPerMonth === 'function') {
      defaultHpm = M.cash.avgHoursPerMonth(sessions(), Date.now());
    }
  }

  async function runYear() {
    const M = await loadMath();
    if (!M.year) { setOut('year', `<p class="hint vs-note">The year simulation is not available yet.</p>`); return; }
    const hpm = floorHpm(state.year.hpm === null ? defaultHpmOrNull() : state.year.hpm);
    // "My real winrate": the filtered-session rates, falling back to the
    // Cash tab inputs when there are not enough sessions.
    const stats = cashStatsOrNull();
    const wr = stats && stats.usd ? stats.usd.wr : Number(state.cash.wr);
    const sd = stats && stats.usd ? stats.usd.sd : Number(state.cash.sd);
    if (!(Number.isFinite(wr) && Number.isFinite(sd) && sd > 0)) {
      showFormError(CASH_NEED_MESSAGE);
      return;
    }
    showFormError(null);
    saveState(state);
    setBusy(true);
    try {
      const year = M.year.simulateYear({ wr, sd, hoursPerMonth: hpm, seed: state.seeds.year });
      setOut('year', yearResultsHtml({ year }, cur));
    } catch (e) {
      console.error('variance: year simulation failed', e);
      setOut('year', `<p class="hint vs-note">The year simulation failed. Check the inputs and try again.</p>`);
    } finally {
      setBusy(false);
    }
  }

  function run() {
    if (state.tab === 'cash') return runCash();
    if (state.tab === 'tournaments') return runTour();
    return runYear();
  }

  function wire() {
    root.querySelector('[data-act=back]').addEventListener('click', () => { location.hash = '#/more'; });
    root.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
      const t = normalizeTab(b.dataset.tab);
      if (t === state.tab) return;
      readForm();
      state.tab = t;
      saveState(state);
      render();
    }));
    const form = root.querySelector('form');
    form.addEventListener('submit', e => { e.preventDefault(); readForm(); run(); });
    root.querySelectorAll('[data-unit]').forEach(b => b.addEventListener('click', () => {
      readForm();
      state.cash.unit = b.dataset.unit === 'BB' ? 'BB' : '$';
      saveState(state);
      render();
    }));
    root.querySelectorAll('[data-vol]').forEach(b => b.addEventListener('click', () => {
      readForm();
      state.cash.volumeUnit = b.dataset.vol === 'hands' ? 'hands' : 'hours';
      saveState(state);
      render();
    }));
    root.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
      const act = b.dataset.act;
      if (act === 'use-stats' || act === 'reset-stats') {
        if (useMyStats()) { render(); run(); }
      } else if (act === 'tour-use-stats') {
        const tstats = tourStats(doc, sessions());
        if (!tstats) { showFormError('Log tournaments to prefill from your stats.'); return; }
        showFormError(null);
        const first = state.tournaments.types[0] || addTourType(state.tournaments.types)[0];
        first.buyin = round2(tstats.avgBuyIn);
        if (tstats.avgField !== null) first.entries = Math.max(2, Math.round(tstats.avgField));
        if (tstats.roiPct !== null) first.roiPct = round2(tstats.roiPct);
        state.tournaments.statsN = tstats.n;
        saveState(state);
        render();
        run();
      } else if (act === 'add-type') {
        readForm();
        state.tournaments.types = addTourType(state.tournaments.types);
        saveState(state);
        render();
      } else if (act === 'remove-type') {
        readForm();
        state.tournaments.types.splice(Number(b.dataset.idx), 1);
        if (!state.tournaments.types.length) state.tournaments.types = defaultTourTypes();
        saveState(state);
        render();
      } else if (act === 'reroll') {
        readForm();
        state.seeds[state.tab === 'cash' ? 'cash' : state.tab === 'tournaments' ? 'tour' : 'year'] =
          nextSeed(state.seeds[state.tab === 'cash' ? 'cash' : state.tab === 'tournaments' ? 'tour' : 'year']);
        saveState(state);
        run();
      }
    }));
  }

  function render() {
    const tab = state.tab;
    const stats = tab === 'cash' || tab === 'year' ? cashStatsOrNull() : null;
    const tstats = tab === 'tournaments' ? tourStats(doc, sessions()) : null;
    const rerollLabel = tab === 'year' ? 'Re-roll year' : 'Re-roll';
    root.innerHTML = `
      <div class="screen vs-screen">
        <header class="topbar">
          <button class="topbtn" data-act="back" aria-label="Back">${icon('back')}</button>
          <h1 class="topbar-title-sm">Variance</h1>
          <span class="topbtn" style="visibility:hidden"></span>
        </header>
        <div class="segmented vs-seg" role="tablist" aria-label="Variance tabs">
          ${TABS.map(t => `<button role="tab" data-tab="${t.key}" aria-selected="${tab === t.key}" class="${tab === t.key ? 'active' : ''}">${t.label}</button>`).join('')}
        </div>
        <form class="form vs-form" novalidate>
          ${tab === 'cash' ? cashFormHtml(state, stats, cur) : ''}
          ${tab === 'tournaments' ? tourFormHtml(state, tstats, cur) : ''}
          ${tab === 'year' ? yearFormHtml(state, defaultHpmOrNull()) : ''}
          <p class="form-error vs-error" data-role="error" role="alert" hidden></p>
          <button class="btn-primary" type="submit">${submitLabel()}</button>
          <div class="vs-seed-row">
            <span class="hint">Seed <span data-role="seed">${state.seeds[tab === 'cash' ? 'cash' : tab === 'tournaments' ? 'tour' : 'year']}</span></span>
            <button type="button" class="vs-reroll" data-act="reroll">${rerollLabel}</button>
          </div>
        </form>
        <div data-role="results" aria-live="polite">${results[tab] || emptyHtml(tab)}</div>
        <div class="spacer-40"></div>
      </div>`;
    wire();
  }

  render();
  computeDefaultHpm().then(() => {
    // Refresh the placeholder now that the 90-day average is known.
    if (state.tab === 'year' && state.year.hpm === null) {
      const inp = root.querySelector('#f-hpm');
      if (inp && !inp.value) inp.placeholder = defaultHpm ? String(Math.round(defaultHpm)) : '';
    }
  });
}
