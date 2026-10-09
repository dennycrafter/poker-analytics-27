// Calendar tab (brief 5.11) and the daily / monthly heatmap grid (5.12).
// Every value comes from the shared metric registry (metrics.js), i.e. the
// same section-7 formulas the Statistics tab runs. Calendar has no filter of
// its own (brief 3: only Feed and Statistics do) and covers ALL ended
// sessions; tournament results follow the shared staking preference.

import { navigate } from '../router.js';
import { getState } from '../store.js';
import { icon } from '../icons.js';
import { esc } from '../ui.js';
import { getCurrency, fmtMoney, moneyClass, monthKey } from '../format.js';
import { endedSessions, localDayKey } from '../stats.js';
import { METRICS, CALENDAR_METRICS, calendarValue, fmtMetric, metricClass } from '../metrics.js';
import {
  groupBy, monthKeyOf, yearKeyOf, dayKeyOf, monthSpan, last30Days,
  periodLabel, periodTotals, heatLevel,
} from '../reports.js';
import { stakingMode } from './stats.js';
import { drillToPeriod, drillToLast30, drillToAll } from './drill.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const MON3 = MONTHS.map(m => m.slice(0, 3));
const PILLS = [['all', 'All'], ['month', 'Month'], ['year', 'Year']];

// View state survives re-renders within the session (like stat detail).
const view = { pill: 'month', metric: 'net', grid: 'day', sel: null };

const EMPTY = '<div class="empty-state">Play a session to see your stats.</div>';

function topbar(title, left, right) {
  return `<header class="topbar">${left}<h1>${title}</h1>${right}</header>`;
}
const hiddenBtn = '<span class="topbtn" style="visibility:hidden"></span>';

function rowHtml({ id, label, sub, value, cls, tappable = true }) {
  return `<${tappable ? 'button' : 'div'} class="cal-row${tappable ? '' : ' disabled'}" data-row="${esc(id)}">
    <span class="cal-label">${esc(label)}${sub ? `<span class="cal-sub">${esc(sub)}</span>` : ''}</span>
    <span class="cal-value ${cls}">${value}</span>
    ${tappable ? icon('chevron', 'chev') : '<span class="chev-space"></span>'}
  </${tappable ? 'button' : 'div'}>`;
}

function sessionsWord(n) { return n + (n === 1 ? ' session' : ' sessions'); }

export function CalendarScreen(root, doc) {
  const all = endedSessions(doc);
  const right = `<button class="topbtn" data-act="grid" aria-label="Open heatmap">${icon('grid')}</button>`;
  if (!all.length) {
    root.innerHTML = `<div class="screen">${topbar('Calendar', hiddenBtn, hiddenBtn)}${EMPTY}</div>`;
    return;
  }
  const cur = getCurrency(doc);
  const mode = stakingMode(doc);
  const cm = CALENDAR_METRICS.find(m => m.id === view.metric) || CALENDAR_METRICS[0];
  const def = METRICS[cm.id];
  const cell = list => {
    const v = list.length ? calendarValue(doc, cm, list, mode) : null;
    return { value: fmtMetric(def, v, cur), cls: metricClass(def, v) };
  };

  const rows = [];
  const l30 = last30Days(all);
  rows.push(rowHtml({ id: 'last30', label: '30 last days', sub: sessionsWord(l30.length), ...cell(l30), tappable: l30.length > 0 }));

  if (view.pill === 'all') {
    rows.push(`<div class="month-head"><span>All time</span></div>`);
    rows.push(rowHtml({ id: 'all', label: 'All sessions', sub: sessionsWord(all.length), ...cell(all) }));
  } else if (view.pill === 'year') {
    const byYear = groupBy(all, yearKeyOf);
    rows.push('<div class="month-head"><span>By year</span></div>');
    for (const y of [...byYear.keys()].sort().reverse()) {
      const l = byYear.get(y);
      rows.push(rowHtml({ id: 'y:' + y, label: y, sub: sessionsWord(l.length), ...cell(l) }));
    }
  } else {
    const byMonth = groupBy(all, monthKeyOf);
    const byYear = groupBy(all, yearKeyOf);
    let year = null;
    for (const mk of monthSpan(all)) {
      const y = mk.slice(0, 4);
      if (y !== year) {
        year = y;
        const yc = cell(byYear.get(y) || []);
        rows.push(`<div class="month-head"><span>${y}</span><span class="cal-head-val ${yc.cls}">${yc.value}</span></div>`);
      }
      const l = byMonth.get(mk) || [];
      rows.push(rowHtml({
        id: 'm:' + mk, label: MONTHS[Number(mk.slice(5)) - 1],
        sub: l.length ? sessionsWord(l.length) : 'No sessions', ...cell(l), tappable: l.length > 0,
      }));
    }
  }

  root.innerHTML = `
    ${topbar('Calendar', hiddenBtn, right)}
    <div class="segmented cal-pills" role="tablist" aria-label="Period">
      ${PILLS.map(([k, l]) => `<button role="tab" data-pill="${k}" aria-selected="${view.pill === k}" class="${view.pill === k ? 'active' : ''}">${l}</button>`).join('')}
    </div>
    <div class="metric-tabs" role="tablist" aria-label="Metric">
      ${CALENDAR_METRICS.map(m => `<button role="tab" data-metric="${m.id}" aria-selected="${m.id === cm.id}" class="metric-tab${m.id === cm.id ? ' active' : ''}">${esc(METRICS[m.id].label)}</button>`).join('')}
    </div>
    ${cm.scope === 'cash' ? '<div class="cal-note">Cash sessions only, matching the Statistics Cash section</div>' : ''}
    <div class="list cal-list">${rows.join('')}</div>`;

  const rerender = () => CalendarScreen(root, getState());
  root.querySelector('[data-act=grid]').addEventListener('click', () => navigate('/calendar/grid'));
  root.querySelectorAll('[data-pill]').forEach(b => b.addEventListener('click', () => { view.pill = b.dataset.pill; rerender(); }));
  root.querySelectorAll('[data-metric]').forEach(b => b.addEventListener('click', () => {
    view.metric = b.dataset.metric;
    rerender();
  }));
  const tabs = root.querySelector('.metric-tabs');
  const active = tabs.querySelector('.metric-tab.active');
  if (active) tabs.scrollLeft = Math.max(0, active.offsetLeft - 16);
  root.querySelectorAll('button.cal-row[data-row]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.row;
    if (id === 'last30') drillToLast30();
    else if (id === 'all') drillToAll();
    else if (id.startsWith('y:')) drillToPeriod('year', id.slice(2));
    else if (id.startsWith('m:')) drillToPeriod('month', id.slice(2));
  }));
}

// ---------------------------------------------------------------------------
// Heatmap grid (brief 5.12). Day: one 7-column (Mon-Sun) grid per month for
// the last 12 months, newest first. Month: 12 squares per year, all years.
// Colour = sign of that period's net result (green / red / grey), with three
// intensity steps relative to the biggest absolute value on screen.

function lastMonths(nowMs, n) {
  const out = [];
  const d = new Date(nowMs);
  d.setDate(1); d.setHours(0, 0, 0, 0);
  for (let i = 0; i < n; i++) { out.push(new Date(d)); d.setMonth(d.getMonth() - 1); }
  return out;
}

function cellHtml(kind, key, t, maxAbs, label, future, cur) {
  if (future) return `<span class="hm-cell future" aria-hidden="true"></span>`;
  const lvl = heatLevel(t ? t.net : 0, t ? t.count : 0, maxAbs);
  const sel = view.sel && view.sel.kind === kind && view.sel.key === key;
  const desc = t ? `${label}: ${fmtMoney(t.net, cur)}, ${sessionsWord(t.count)}` : `${label}: no sessions`;
  return `<button class="hm-cell hm-${lvl}${sel ? ' sel' : ''}" data-kind="${kind}" data-key="${key}" aria-label="${esc(desc)}"></button>`;
}

function dayGridHtml(doc, all, mode, cur, nowMs) {
  const totals = periodTotals(doc, all, dayKeyOf, mode);
  const months = lastMonths(nowMs, 12);
  const visible = [];
  for (const [k, t] of totals) if (months.some(m => k.startsWith(monthKey(m)))) visible.push(Math.abs(t.net));
  const maxAbs = visible.length ? Math.max(...visible) : 0;
  const today = localDayKey(new Date(nowMs));
  return `<div class="hm-months">${months.map(m => {
    const y = m.getFullYear(), mo = m.getMonth();
    const days = new Date(y, mo + 1, 0).getDate();
    const lead = (m.getDay() + 6) % 7; // Monday-first offset
    let cells = '';
    for (let i = 0; i < lead; i++) cells += '<span class="hm-cell blank" aria-hidden="true"></span>';
    let mNet = 0, mCount = 0;
    for (let d = 1; d <= days; d++) {
      const key = localDayKey(new Date(y, mo, d));
      const t = totals.get(key);
      if (t) { mNet += t.net; mCount += t.count; }
      cells += cellHtml('day', key, t, maxAbs, periodLabel('day', key), key > today, cur);
    }
    return `<div class="hm-month">
      <div class="hm-month-head"><span>${MON3[mo]} ${y}</span>
        <span class="${mCount ? moneyClass(mNet) : 'dim'}">${mCount ? fmtMoney(mNet, cur) : '--'}</span></div>
      <div class="hm-dow">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(x => `<span>${x}</span>`).join('')}</div>
      <div class="hm-grid">${cells}</div>
    </div>`;
  }).join('')}</div>`;
}

function monthGridHtml(doc, all, mode, cur, nowMs) {
  const totals = periodTotals(doc, all, monthKeyOf, mode);
  const maxAbs = Math.max(0, ...[...totals.values()].map(t => Math.abs(t.net)));
  const years = [...new Set(all.map(yearKeyOf))].sort().reverse();
  const nowKey = monthKey(new Date(nowMs));
  return years.map(y => {
    const yl = all.filter(s => yearKeyOf(s) === y);
    const yNet = [...totals.entries()].filter(([k]) => k.startsWith(y)).reduce((a, [, t]) => a + t.net, 0);
    const cells = MON3.map((name, i) => {
      const key = `${y}-${String(i + 1).padStart(2, '0')}`;
      return `<div class="hm-mcell">${cellHtml('month', key, totals.get(key), maxAbs, periodLabel('month', key), key > nowKey, cur)}<span>${name}</span></div>`;
    }).join('');
    return `<div class="hm-year">
      <div class="hm-month-head"><span>${y}</span><span class="${moneyClass(yNet)}">${fmtMoney(yNet, cur)}</span></div>
      <div class="hm-mgrid">${cells}</div>
      <div class="hint hm-year-sub">${sessionsWord(yl.length)}</div>
    </div>`;
  }).join('');
}

function selectionCardHtml(doc, all, mode, cur) {
  if (!view.sel) return `<div class="hm-info hint">Tap a square to see its result.</div>`;
  const { kind, key } = view.sel;
  const list = all.filter(s => (kind === 'day' ? dayKeyOf(s) : monthKeyOf(s)) === key);
  const net = list.length ? METRICS.net.value(doc, list, mode) : null;
  return `<div class="hm-info">
    <div class="hm-info-main">
      <span class="lbl">${esc(periodLabel(kind, key))}</span>
      <span class="hm-info-val ${list.length ? moneyClass(net) : 'dim'}">${list.length ? fmtMoney(net, cur) : 'No sessions'}</span>
      ${list.length ? `<span class="hint">${sessionsWord(list.length)}</span>` : ''}
    </div>
    ${list.length ? `<button class="btn-secondary hm-open" data-act="open">View sessions ${icon('chevron')}</button>` : ''}
  </div>`;
}

export function CalendarGridScreen(root, doc) {
  const all = endedSessions(doc);
  const back = `<button class="topbtn" data-act="back" aria-label="Back">${icon('back')}</button>`;
  if (!all.length) {
    root.innerHTML = `<div class="screen">${topbar('Heatmap', back, hiddenBtn)}${EMPTY}</div>`;
    root.querySelector('[data-act=back]').addEventListener('click', () => navigate('/calendar'));
    return;
  }
  const cur = getCurrency(doc);
  const mode = stakingMode(doc);
  const nowMs = Date.now();
  if (view.sel && view.sel.kind !== view.grid) view.sel = null;
  const body = view.grid === 'day' ? dayGridHtml(doc, all, mode, cur, nowMs) : monthGridHtml(doc, all, mode, cur, nowMs);

  root.innerHTML = `
    <div class="screen heatmap-screen">
      ${topbar('Heatmap', back, hiddenBtn)}
      <div class="segmented" role="tablist" aria-label="Granularity">
        ${[['day', 'Day'], ['month', 'Month']].map(([k, l]) => `<button role="tab" data-grid="${k}" aria-selected="${view.grid === k}" class="${view.grid === k ? 'active' : ''}">${l}</button>`).join('')}
      </div>
      <div class="hm-legend">
        <span><i class="hm-cell hm-pos-3"></i>Win</span><span><i class="hm-cell hm-neg-3"></i>Loss</span>
        <span><i class="hm-cell hm-none"></i>No play / even</span>
      </div>
      ${selectionCardHtml(doc, all, mode, cur)}
      <div class="hm-body">${body}</div>
    </div>`;

  const rerender = () => CalendarGridScreen(root, getState());
  root.querySelector('[data-act=back]').addEventListener('click', () => navigate('/calendar'));
  root.querySelectorAll('[data-grid]').forEach(b => b.addEventListener('click', () => { view.grid = b.dataset.grid; rerender(); }));
  root.querySelectorAll('button.hm-cell[data-key]').forEach(b => b.addEventListener('click', () => {
    view.sel = { kind: b.dataset.kind, key: b.dataset.key };
    rerender();
  }));
  const open = root.querySelector('[data-act=open]');
  if (open) open.addEventListener('click', () => drillToPeriod(view.sel.kind, view.sel.key));
}
