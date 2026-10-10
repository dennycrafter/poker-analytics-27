// Statistics tab (brief 5.9) and stat detail (brief 5.10), plus the
// "Am I a winner?" card (variance brief, iteration 2). All numbers come from
// metrics.js / stats.js over the Statistics tab's own filter applied to ENDED
// sessions (live sessions never count — brief 6); the winner card's math
// comes from js/inference.js per its pinned contract.

import { navigate } from '../router.js';
import { getState, mutate } from '../store.js';
import { icon } from '../icons.js';
import { esc } from '../ui.js';
import { getCurrency, moneyClass, fmtNum } from '../format.js';
import { endedSessions, hasStaking } from '../stats.js';
import { getFilter, applyFilter } from '../filters.js';
import { SCOPES, SECTIONS, METRICS, fmtMetric, metricClass, fmtAxis, buildSeries } from '../metrics.js';
import { seriesChart } from '../charts/svg.js';
import { chartBox } from '../layout.js';
import { filterButtonHtml, filterPillHtml, wireFilter } from './filter.js';
import { winrateStats, hoursToKnow, MIN_SESSIONS, NEED_MORE_MESSAGE } from '../inference.js';
import {
  cashRows, usableRows, hasAllHands, bbAvailable, clampConfidence,
  accuracyDefault, fmtRateShort, fmtRateFull, ciSentence, chancePct, bellCurveGeom,
} from '../winner-ui.js';

// Gross vs net-of-staking (formula 1). Persisted UI preference; default net.
export function stakingMode(doc) {
  return (doc.ui && doc.ui.staking_mode) === 'gross' ? 'gross' : 'net';
}
function setStakingMode(mode) {
  mutate(d => { d.ui = d.ui || {}; d.ui.staking_mode = mode; });
}

export function statsSessions(doc) {
  return applyFilter(getFilter(doc, 'stats'), endedSessions(doc));
}

function stakingToggleHtml(mode) {
  return `<div class="segmented staking-toggle" role="tablist" aria-label="Tournament result basis">
    ${[['net', 'Net of staking'], ['gross', 'Gross']].map(([k, l]) =>
      `<button role="tab" data-staking="${k}" aria-selected="${mode === k}" class="${mode === k ? 'active' : ''}">${l}</button>`).join('')}
  </div>`;
}

function wireStaking(root) {
  root.querySelectorAll('[data-staking]').forEach(b =>
    b.addEventListener('click', () => setStakingMode(b.dataset.staking)));
}

// ---------------------------------------------------------------------------
// "Am I a winner?" card (variance brief, iteration 2). Cash-only: the card
// runs the brief-7 winrate inference (js/inference.js) over the filtered
// cash sessions. Confidence % persists in doc.ui like the staking toggle;
// unit and the accuracy what-if input are per-visit state, remembered per
// unit, like the detail screen's view object.
// ---------------------------------------------------------------------------

const winnerState = {
  unit: 'usd',
  accuracy: { usd: accuracyDefault('usd'), bb: accuracyDefault('bb') },
};

export function winnerConfidence(doc) {
  return clampConfidence(doc.ui && doc.ui.winner_confidence_pct);
}
function setWinnerConfidence(pct) {
  mutate(d => { d.ui = d.ui || {}; d.ui.winner_confidence_pct = clampConfidence(pct); });
}

function winnerUnitToggleHtml(unit, cur) {
  return `<div class="segmented winner-unit" role="tablist" aria-label="Winner card units">
    ${[['usd', cur], ['bb', 'BB']].map(([k, l]) =>
      `<button role="tab" data-winner-unit="${k}" aria-selected="${unit === k}" class="${unit === k ? 'active' : ''}">${esc(l)}</button>`).join('')}
  </div>`;
}

// Bell curve of the possible true winrate: shaded interval band, dashed
// break-even line at 0, interval bound labels (dropped when they would
// collide with each other or with the 0 label).
function bellCurveSvg(geom, ci, unit, cur, confPct) {
  if (!geom) return '';
  const fmt = v => fmtRateShort(v, unit, cur);
  const clampX = x => Math.max(geom.padL + 16, Math.min(geom.width - geom.padR - 16, x));
  let labels = '';
  if (geom.hiX - geom.loX >= 70) {
    labels += `<text x="${clampX(geom.loX).toFixed(1)}" y="${geom.height - 4}" font-size="9" fill="var(--text-tertiary)" text-anchor="middle">${esc(fmt(ci[0]))}</text>`;
    labels += `<text x="${clampX(geom.hiX).toFixed(1)}" y="${geom.height - 4}" font-size="9" fill="var(--text-tertiary)" text-anchor="middle">${esc(fmt(ci[1]))}</text>`;
  }
  if (Math.abs(geom.zeroX - geom.loX) >= 34 && Math.abs(geom.hiX - geom.zeroX) >= 34) {
    labels += `<text x="${geom.zeroX.toFixed(1)}" y="${geom.height - 4}" font-size="9" fill="var(--text-tertiary)" text-anchor="middle">0</text>`;
  }
  return `<svg class="line-chart" viewBox="0 0 ${geom.width} ${geom.height}" role="img" aria-label="Bell curve of your possible true winrate">
      ${geom.bandPath ? `<path d="${geom.bandPath}" fill="var(--accent-dim)"/>` : ''}
      <path d="${geom.curvePath}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <line x1="${geom.zeroX.toFixed(1)}" y1="${geom.yTop.toFixed(1)}" x2="${geom.zeroX.toFixed(1)}" y2="${geom.yBase.toFixed(1)}" stroke="#6b6b6b" stroke-width="0.8" stroke-dasharray="3 4"/>
      ${labels}
    </svg>
    <div class="chart-caption">Possible true winrate. Shaded: ${confPct}% interval. Dashed line: break even.</div>`;
}

export function renderWinnerCard(doc, list, cur) {
  const cash = SCOPES.cash.pick(list);
  if (!cash.length) return '';
  const allRows = cashRows(doc, cash);
  const rows = usableRows(allRows);
  const confPct = winnerConfidence(doc);
  const stats = rows.length >= MIN_SESSIONS
    ? winrateStats(rows, { unit: winnerState.unit, confidence: confPct / 100 })
    : null;

  let body;
  if (!stats) {
    body = `<div class="hint">${esc(NEED_MORE_MESSAGE)}</div>`;
  } else {
    const isBB = winnerState.unit === 'bb';
    const chance = chancePct(stats.chanceWinner);
    const hours = hoursToKnow(stats.sd, winnerState.accuracy[winnerState.unit]);
    const geom = bellCurveGeom({ wr: stats.wr, se: stats.se, ci: stats.ci, ...chartBox(340, 160) });
    body = `
      ${bbAvailable(allRows) ? winnerUnitToggleHtml(winnerState.unit, cur) : ''}
      <div class="stat-card-top"><span class="lbl">Observed winrate</span><span class="lbl">${rows.length} sessions</span></div>
      <div class="big-num stat-total ${moneyClass(stats.wr)}">${esc(fmtRateFull(stats.wr, winnerState.unit, cur))}</div>
      <div class="stat-card-top"><span class="lbl">Standard error</span><span class="lbl">${esc(fmtRateFull(stats.se, winnerState.unit, cur))}</span></div>
      <div class="stat-card-top">
        <span class="lbl">${confPct}% confidence interval</span>
        <span class="lbl">${esc(fmtRateShort(stats.ci[0], winnerState.unit, cur))} to ${esc(fmtRateShort(stats.ci[1], winnerState.unit, cur))}</span>
      </div>
      <div class="stat-card-top">
        <span class="lbl">Confidence %</span>
        <input class="input winner-confidence" data-role="winner-confidence" type="number" inputmode="numeric"
          min="50" max="99" step="1" value="${confPct}" style="width:70px" aria-label="Confidence percent">
      </div>
      ${bellCurveSvg(geom, stats.ci, winnerState.unit, cur, confPct)}
      <div class="stat-card-top"><span class="lbl">Chance you're a winner</span><span class="lbl">${chance === null ? '--' : chance + '%'}</span></div>
      <div class="stat-card-top">
        <span class="lbl">Hours until you know within</span>
        <span class="lbl"><input class="input" data-role="winner-accuracy" type="number" inputmode="decimal"
          min="0.01" step="any" value="${winnerState.accuracy[winnerState.unit]}" style="width:70px"
          aria-label="Accuracy in ${isBB ? 'big blinds per hour' : 'currency per hour'}"> ${isBB ? 'BB/hr' : esc(cur) + '/hr'}</span>
      </div>
      <div class="stat-card-top"><span class="lbl">Hours needed at 95%</span><span class="lbl">about ${fmtNum(Math.round(hours))} hours</span></div>
      <div class="hint">${esc(ciSentence({ confidence: confPct, ci: stats.ci, unit: winnerState.unit, currency: cur }))}</div>`;
  }
  return `<div class="card winner-card" data-card="winner">
    <div class="stat-card-top"><span class="lbl">Am I a winner?</span><span class="lbl">Cash</span></div>${body}
  </div>`;
}

function wireWinnerCard(root) {
  root.querySelectorAll('[data-winner-unit]').forEach(b =>
    b.addEventListener('click', () => { winnerState.unit = b.dataset.winnerUnit; StatsScreen(root, getState()); }));
  const conf = root.querySelector('[data-role=winner-confidence]');
  if (conf) conf.addEventListener('change', () => setWinnerConfidence(conf.value)); // mutate rerenders
  const acc = root.querySelector('[data-role=winner-accuracy]');
  if (acc) acc.addEventListener('change', () => {
    const v = Number(acc.value);
    if (!(v > 0)) return; // ignore empty or non-positive input; rerender restores the old value
    winnerState.accuracy[winnerState.unit] = v;
    StatsScreen(root, getState());
  });
}

// SD/100 hands rows (variance brief, iteration 2): only when every cash
// session in the filter recorded hands. Plain rows, not links: they have no
// detail page. $ and BB variants, matching the list's $/BB row pairs.
function sd100RowsHtml(doc, scoped, cur) {
  const rows = cashRows(doc, scoped);
  if (!hasAllHands(rows)) return [];
  const ok = usableRows(rows);
  const usd = winrateStats(ok, { unit: 'per100' });
  if (!usd || !Number.isFinite(usd.sd)) return [];
  const row = (label, value) => `<div class="stat-row"><div class="stat-main">
      <span class="stat-label">${esc(label)}</span><span class="stat-value">${value}</span>
    </div></div>`;
  const out = [row('SD per 100 hands', esc(fmtMoney(usd.sd, cur)))];
  const bbOk = ok.filter(r => r.bb > 0);
  const bb = winrateStats(bbOk.map(r => ({ ...r, p: r.p / r.bb })), { unit: 'per100' });
  if (bbOk.length && bb && Number.isFinite(bb.sd)) {
    out.push(row('SD per 100 hands in BB', esc(fmtNum(bb.sd)) + ' BB'));
  }
  return out;
}

export function StatsScreen(root, doc) {
  const cur = getCurrency(doc);
  const all = endedSessions(doc);
  const list = statsSessions(doc);
  const mode = stakingMode(doc);
  const showStaking = list.some(s => hasStaking(doc, s));

  let body;
  if (!all.length) {
    body = '<div class="empty-state">Play a session to see your stats.</div>';
  } else if (!list.length) {
    body = '<div class="empty-state">No sessions match this filter.</div>';
  } else {
    const sections = [];
    for (const scope of ['all', 'cash', 'tournament']) {
      const scoped = SCOPES[scope].pick(list);
      if (!scoped.length) continue; // Cash / Tournaments only when any match
      const sd100 = scope === 'cash' ? sd100RowsHtml(doc, scoped, cur) : [];
      const rows = SECTIONS[scope].flatMap(id => {
        const def = METRICS[id];
        const v = def.value(doc, scoped, mode);
        const rowHtml = `<a class="stat-row" href="#/stats/${scope}/${id}" data-metric="${id}">
          <div class="stat-main">
            <span class="stat-label">${esc(def.label)}</span>
            <span class="stat-value ${metricClass(def, v)}">${fmtMetric(def, v, cur)}</span>
          </div>
          ${icon('chevron', 'chev')}
        </a>`;
        // SD/100 hands rows follow SD/hr (stddev) in the cash section.
        return id === 'stddev' && sd100.length ? [rowHtml, ...sd100] : [rowHtml];
      }).join('');
      sections.push(`<section class="stat-section" data-scope="${scope}">
        <div class="month-head"><span>${SCOPES[scope].label}</span><span class="hint">${scoped.length} ${scoped.length === 1 ? 'session' : 'sessions'}</span></div>
        ${rows}
      </section>`);
    }
    body = (showStaking ? stakingToggleHtml(mode) : '') + renderWinnerCard(doc, list, cur) + `<div class="list">${sections.join('')}</div>`;
  }

  root.innerHTML = `
    <header class="topbar">
      ${filterButtonHtml(doc, 'stats')}
      <h1>Statistics</h1>
      <span class="topbtn" style="visibility:hidden"></span>
    </header>
    ${filterPillHtml(doc, 'stats')}
    ${body}`;
  wireFilter(root, 'stats');
  wireStaking(root);
  wireWinnerCard(root);
}

// ---------------------------------------------------------------------------
// Stat detail. View options (group / chart / bb) live in memory per visit
// and persist across re-renders; staking mode is the shared preference.

const view = { key: null, group: 'unit', chart: 'line', bb: false };

const GROUPS = [['unit', 'Unit'], ['month', 'Month'], ['year', 'Year'], ['duration', 'Duration']];

export function StatDetailScreen(root, doc, scope, metricId) {
  const baseDef = METRICS[metricId];
  if (!baseDef || !SCOPES[scope] || !SECTIONS[scope].includes(metricId)) { navigate('/stats'); return; }
  const cur = getCurrency(doc);
  const mode = stakingMode(doc);
  const scoped = SCOPES[scope].pick(statsSessions(doc));
  // A newly opened stat starts in its native units (BB rows open in BB).
  const key = scope + '/' + metricId;
  if (view.key !== key) { view.key = key; view.bb = !!baseDef.money; }

  // BB toggle: cash metrics that have a BB twin (or are the BB twin of a money metric).
  const bbPair = scope === 'cash' ? (baseDef.bb || baseDef.money || null) : null;
  const baseIsBB = !!baseDef.money;
  const showBB = bbPair && view.bb !== baseIsBB;
  const id = showBB ? bbPair : metricId;
  const def = METRICS[id];
  const staking = scope !== 'cash' && def.staking && scoped.some(s => hasStaking(doc, s));

  const total = def.value(doc, scoped, mode);
  const pts = buildSeries(doc, id, scoped, { group: view.group, chart: view.chart, mode });
  const chart = scoped.length
    ? seriesChart({
      points: pts, type: view.chart, ...chartBox(340, 210),
      fmtY: v => fmtAxis(def, v), spanBars: view.group === 'duration',
    })
    : '<div class="chart-empty">No sessions match this filter.</div>';

  const xCaption = {
    unit: view.chart === 'bar' ? 'Per session' : 'Cumulative, per session',
    month: view.chart === 'bar' ? 'Per month' : 'Cumulative, by month',
    year: view.chart === 'bar' ? 'Per year' : 'Cumulative, by year',
    duration: view.chart === 'bar' ? 'Per session, over cumulative hours played' : 'Cumulative, over hours played',
  }[view.group];

  root.innerHTML = `
    <div class="screen stat-detail">
      <header class="topbar">
        <button class="topbtn" data-act="back" aria-label="Back">${icon('back')}</button>
        <h1 class="topbar-title-sm">${esc(def.label)}</h1>
        <button class="topbtn chart-type" data-act="chart-type" aria-label="Show as ${view.chart === 'line' ? 'bar' : 'line'} chart">
          ${icon(view.chart === 'line' ? 'bars' : 'line')}
        </button>
      </header>
      ${filterPillHtml(doc, 'stats')}
      <div class="live-card stat-card">
        <div class="stat-card-top">
          <span class="lbl">${esc(SCOPES[scope].label)}</span>
          <span class="lbl">${scoped.length} ${scoped.length === 1 ? 'game' : 'games'}</span>
        </div>
        <div class="big-num stat-total ${metricClass(def, total)}">${fmtMetric(def, total, cur)}</div>
        ${staking ? `<div class="hint">${mode === 'net' ? 'Net of staking' : 'Gross (before staking)'}</div>` : ''}
      </div>
      <div class="card chart-card">
        ${chart}
        <div class="chart-caption">${esc(xCaption)}</div>
      </div>
      <div class="segmented group-toggle" role="tablist" aria-label="Group by">
        ${GROUPS.map(([k, l]) => `<button role="tab" data-group="${k}" aria-selected="${view.group === k}" class="${view.group === k ? 'active' : ''}">${l}</button>`).join('')}
      </div>
      <div class="detail-toggles">
        <div class="segmented chart-toggle" role="tablist" aria-label="Chart type">
          ${[['line', 'Line'], ['bar', 'Bar']].map(([k, l]) => `<button role="tab" data-chart="${k}" aria-selected="${view.chart === k}" class="${view.chart === k ? 'active' : ''}">${l}</button>`).join('')}
        </div>
        ${bbPair ? `<div class="segmented bb-toggle" role="tablist" aria-label="Units">
          ${[[false, cur], [true, 'BB']].map(([k, l]) => `<button role="tab" data-bb="${k}" aria-selected="${view.bb === k}" class="${view.bb === k ? 'active' : ''}">${l}</button>`).join('')}
        </div>` : ''}
      </div>
      ${staking ? stakingToggleHtml(mode) : ''}
    </div>`;

  root.querySelector('[data-act=back]').addEventListener('click', () => navigate('/stats'));
  wireFilter(root, 'stats');
  wireStaking(root);
  const rerender = () => StatDetailScreen(root, getState(), scope, metricId);
  root.querySelector('[data-act=chart-type]').addEventListener('click', () => { view.chart = view.chart === 'line' ? 'bar' : 'line'; rerender(); });
  root.querySelectorAll('[data-group]').forEach(b => b.addEventListener('click', () => { view.group = b.dataset.group; rerender(); }));
  root.querySelectorAll('[data-chart]').forEach(b => b.addEventListener('click', () => { view.chart = b.dataset.chart; rerender(); }));
  root.querySelectorAll('[data-bb]').forEach(b => b.addEventListener('click', () => { view.bb = b.dataset.bb === 'true'; rerender(); }));
}
