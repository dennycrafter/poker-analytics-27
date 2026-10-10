// Statistics tab (brief 5.9) and stat detail (brief 5.10).
// All numbers come from metrics.js / stats.js over the Statistics tab's own
// filter applied to ENDED sessions (live sessions never count — brief 6).

import { navigate } from '../router.js';
import { getState, mutate } from '../store.js';
import { icon } from '../icons.js';
import { esc } from '../ui.js';
import { getCurrency } from '../format.js';
import { endedSessions, hasStaking } from '../stats.js';
import { getFilter, applyFilter } from '../filters.js';
import { SCOPES, SECTIONS, METRICS, fmtMetric, metricClass, fmtAxis, buildSeries } from '../metrics.js';
import { seriesChart } from '../charts/svg.js';
import { chartBox } from '../layout.js';
import { filterButtonHtml, filterPillHtml, wireFilter } from './filter.js';

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
      const rows = SECTIONS[scope].map(id => {
        const def = METRICS[id];
        const v = def.value(doc, scoped, mode);
        return `<a class="stat-row" href="#/stats/${scope}/${id}" data-metric="${id}">
          <div class="stat-main">
            <span class="stat-label">${esc(def.label)}</span>
            <span class="stat-value ${metricClass(def, v)}">${fmtMetric(def, v, cur)}</span>
          </div>
          ${icon('chevron', 'chev')}
        </a>`;
      }).join('');
      sections.push(`<section class="stat-section" data-scope="${scope}">
        <div class="month-head"><span>${SCOPES[scope].label}</span><span class="hint">${scoped.length} ${scoped.length === 1 ? 'session' : 'sessions'}</span></div>
        ${rows}
      </section>`);
    }
    body = (showStaking ? stakingToggleHtml(mode) : '') + `<div class="list">${sections.join('')}</div>`;
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
