// Reports tab (brief 5.13). Highlights (best day / week / month / year,
// biggest win and loss), Day Time Efficiency hour-of-day chart, and one
// "Best" section per dimension. Tapping a section opens /reports/:dim with a
// bar chart of every value in that dimension. Like Calendar, Reports has no
// filter of its own (brief 3) and covers all ENDED sessions.

import { navigate } from '../router.js';
import { getState } from '../store.js';
import { icon } from '../icons.js';
import { esc } from '../ui.js';
import { getCurrency, fmtMoney, moneyClass, fmtNum, fmtHours } from '../format.js';
import { endedSessions } from '../stats.js';
import {
  DIMENSIONS, dimensionBuckets, bestOf, bestPeriod, extremeSessions,
  periodLabel, hourRangeLabel,
} from '../reports.js';
import { barChart } from '../charts/svg.js';
import { chartBox } from '../layout.js';
import { stakingMode } from './stats.js';
import { sessionRowHtml } from './feed.js';
import { drillToPeriod, drillToFilter } from './drill.js';

const MIN_SESSIONS = 5; // brief 8: "Log at least 5 sessions to unlock reports."
const EMPTY = '<div class="empty-state">Log at least 5 sessions to unlock reports.</div>';
const hiddenBtn = '<span class="topbtn" style="visibility:hidden"></span>';

function compactMoney(v) {
  if (Math.abs(v) >= 1000) return fmtNum(v / 1000) + 'k';
  return fmtNum(v);
}

// Hour bars: 24 buckets, label every 3rd hour.
export function hourBars(buckets, metric) {
  return buckets.map(b => ({
    key: b.key, label: hourRangeLabel(b.key), short: String(b.key),
    y: metric === 'rate' ? (b.rate ?? 0) : b.net, empty: b.count === 0,
  }));
}

function bestRowsHtml(dim, buckets, cur) {
  const { byNet, byRate } = bestOf(buckets);
  const name = b => (dim.hourly ? hourRangeLabel(b.key) : dim.money ? fmtMoney(Number(b.key), cur) : b.label);
  const row = (lbl, b, val) => `<div class="rep-best-row">
      <span class="rep-best-what">${esc(lbl)}</span>
      <span class="rep-best-name">${b ? esc(name(b)) : '--'}</span>
      <span class="rep-best-val ${b ? moneyClass(val) : 'dim'}">${b ? fmtMoney(val, cur) + (lbl === 'Net hourly rate' ? '/h' : '') : '--'}</span>
    </div>`;
  return row('Net result', byNet, byNet && byNet.net) + row('Net hourly rate', byRate, byRate && byRate.rate);
}

function highlightRow(id, label, sub, value, cls) {
  return `<button class="cal-row" data-hl="${esc(id)}">
    <span class="cal-label">${esc(label)}<span class="cal-sub">${esc(sub)}</span></span>
    <span class="cal-value ${cls}">${value}</span>
    ${icon('chevron', 'chev')}
  </button>`;
}

export function ReportsScreen(root, doc) {
  const all = endedSessions(doc);
  const head = `<header class="topbar">${hiddenBtn}<h1>Reports</h1>${hiddenBtn}</header>`;
  if (all.length < MIN_SESSIONS) { root.innerHTML = head + EMPTY; return; }
  const cur = getCurrency(doc);
  const mode = stakingMode(doc);

  // Highlights
  const hl = [];
  for (const [kind, title] of [['day', 'Best day'], ['week', 'Best week'], ['month', 'Best month'], ['year', 'Best year']]) {
    const b = bestPeriod(doc, all, kind, mode);
    if (b) hl.push(highlightRow(`${kind}:${b.key}`, title, `${periodLabel(kind, b.key)} · ${b.count} ${b.count === 1 ? 'session' : 'sessions'}`, fmtMoney(b.net, cur), moneyClass(b.net)));
  }
  const { win, loss } = extremeSessions(doc, all, mode);
  const sessSub = s => {
    const d = new Date(s.start_time);
    return periodLabel('day', `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`) +
      ' · ' + (s.kind === 'cash' ? 'Cash' : 'Tournament');
  };
  if (win) hl.push(highlightRow('s:' + win.session.id, 'Biggest win', sessSub(win.session), fmtMoney(win.net, cur), moneyClass(win.net)));
  if (loss) hl.push(highlightRow('s:' + loss.session.id, 'Biggest loss', sessSub(loss.session), fmtMoney(loss.net, cur), moneyClass(loss.net)));

  // Hour of day (Day Time Efficiency) — chart inline, tap a bar -> Feed.
  const hourDim = DIMENSIONS[0];
  const hb = dimensionBuckets(doc, hourDim, all, mode);
  const hourChart = barChart({
    bars: hourBars(hb, 'net'), ...chartBox(340, 180), labelEvery: 3, fmtY: compactMoney,
    ariaLabel: 'Net result by hour of day',
  });

  const sections = DIMENSIONS.map(dim => {
    const buckets = dim.hourly ? hb : dimensionBuckets(doc, dim, all, mode);
    if (!buckets.some(b => b.count > 0)) return '';
    return `<section class="rep-section" data-dim="${dim.id}">
      <a class="rep-head" href="#/reports/${dim.id}">
        <span class="rep-title">${esc(dim.title)}</span>
        <span class="rep-best-label">Best</span>
        ${icon('chevron', 'chev')}
      </a>
      ${dim.hourly ? `<div class="card chart-card rep-hour-chart">${hourChart}
        <div class="chart-caption">Net result by hour · tap a bar for its sessions</div></div>` : ''}
      <a class="rep-best" href="#/reports/${dim.id}">${bestRowsHtml(dim, buckets, cur)}</a>
    </section>`;
  }).join('');

  root.innerHTML = `${head}
    <div class="list rep-list">
      <div class="month-head"><span>Highlights</span></div>
      ${hl.join('')}
      ${sections}
      <div class="spacer-40"></div>
    </div>`;

  root.querySelectorAll('[data-hl]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.hl;
    const i = id.indexOf(':');
    const kind = id.slice(0, i), key = id.slice(i + 1);
    if (kind === 's') navigate('/session/' + key);
    else drillToPeriod(kind, key);
  }));
  root.querySelectorAll('.rep-hour-chart g.bar[data-key]').forEach(g => {
    const go = () => { if (hb[Number(g.dataset.key)].count) drillToFilter({ hour: Number(g.dataset.key) }); };
    g.addEventListener('click', go);
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
}

// ---------------------------------------------------------------------------
// Dimension detail: bar chart of every bucket (Net result | Net hourly rate),
// bucket list; tapping a bar/row selects it and lists its sessions, with a
// "View in Feed" shortcut where the Feed filter can express the bucket.

const detail = { dim: null, metric: 'net', sel: null };

export function ReportDetailScreen(root, doc, dimId) {
  const dim = DIMENSIONS.find(d => d.id === dimId);
  if (!dim) { navigate('/reports'); return; }
  const all = endedSessions(doc);
  if (all.length < MIN_SESSIONS) { navigate('/reports'); return; }
  if (detail.dim !== dimId) { detail.dim = dimId; detail.sel = null; detail.metric = 'net'; }
  const cur = getCurrency(doc);
  const mode = stakingMode(doc);
  const buckets = dimensionBuckets(doc, dim, all, mode);
  const shown = dim.hourly ? buckets : buckets.filter(b => b.count > 0);
  const nameOf = b => (dim.hourly ? hourRangeLabel(b.key) : dim.money ? fmtMoney(Number(b.key), cur) : b.label);
  const valOf = b => (detail.metric === 'rate' ? b.rate : b.net);

  const bars = dim.hourly
    ? hourBars(buckets, detail.metric)
    : shown.map(b => ({ key: b.key, label: nameOf(b), short: shortLabel(dim, b), y: valOf(b) ?? 0, empty: false }));
  const chart = barChart({
    bars, ...chartBox(340, 210), labelEvery: dim.hourly ? 3 : 1, fmtY: compactMoney,
    selected: detail.sel, ariaLabel: `${dim.title} by ${detail.metric === 'rate' ? 'net hourly rate' : 'net result'}`,
  });

  const rows = shown.filter(b => b.count > 0).map(b => {
    const v = valOf(b);
    const sel = detail.sel !== null && String(detail.sel) === String(b.key);
    return `<button class="rep-bucket${sel ? ' sel' : ''}" data-key="${esc(b.key)}">
      <span class="cal-label">${esc(nameOf(b))}<span class="cal-sub">${b.count} ${b.count === 1 ? 'session' : 'sessions'} · ${fmtHours(b.hours)}</span></span>
      <span class="cal-value ${v === null ? 'dim' : moneyClass(v)}">${v === null ? '--' : fmtMoney(v, cur) + (detail.metric === 'rate' ? '/h' : '')}</span>
    </button>`;
  }).join('');

  let selHtml = '';
  const selB = detail.sel === null ? null : buckets.find(b => String(b.key) === String(detail.sel));
  if (selB && selB.count) {
    const feedF = dim.feed ? dim.feed(selB.key) : null;
    const sorted = [...selB.sessions].sort((a, b) => Date.parse(b.start_time) - Date.parse(a.start_time));
    selHtml = `<div class="month-head"><span>${esc(nameOf(selB))}</span>
        <span class="net ${moneyClass(selB.net)}">${fmtMoney(selB.net, cur)}</span></div>
      ${dim.hourly ? '<div class="hint rep-note">Each session counts only the minutes it spent in this hour.</div>' : ''}
      ${feedF ? `<button class="btn-secondary rep-feed" data-act="feed">View in Feed ${icon('chevron')}</button>` : ''}
      ${sorted.map(s => sessionRowHtml(doc, s)).join('')}`;
  }

  root.innerHTML = `
    <div class="screen stat-detail">
      <header class="topbar">
        <button class="topbtn" data-act="back" aria-label="Back">${icon('back')}</button>
        <h1 class="topbar-title-sm">${esc(dim.title)}</h1>
        ${hiddenBtn}
      </header>
      <div class="card chart-card">${chart}
        <div class="chart-caption">${detail.metric === 'rate' ? 'Net hourly rate' : 'Net result'} · tap a bar</div></div>
      <div class="segmented" role="tablist" aria-label="Metric">
        ${[['net', 'Net result'], ['rate', 'Net hourly rate']].map(([k, l]) => `<button role="tab" data-m="${k}" aria-selected="${detail.metric === k}" class="${detail.metric === k ? 'active' : ''}">${l}</button>`).join('')}
      </div>
      <div class="rep-buckets">${rows}</div>
      ${selHtml}
      <div class="spacer-40"></div>
    </div>`;

  const rerender = () => ReportDetailScreen(root, getState(), dimId);
  const select = key => { detail.sel = String(detail.sel) === String(key) ? null : key; rerender(); };
  root.querySelector('[data-act=back]').addEventListener('click', () => navigate('/reports'));
  root.querySelectorAll('[data-m]').forEach(b => b.addEventListener('click', () => { detail.metric = b.dataset.m; rerender(); }));
  root.querySelectorAll('g.bar[data-key]').forEach(g => {
    const b = buckets.find(x => String(x.key) === g.dataset.key);
    if (!b || !b.count) return;
    g.addEventListener('click', () => select(b.key));
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(b.key); } });
  });
  root.querySelectorAll('.rep-bucket[data-key]').forEach(el => {
    const b = buckets.find(x => String(x.key) === el.dataset.key);
    el.addEventListener('click', () => select(b.key));
  });
  const feedBtn = root.querySelector('[data-act=feed]');
  if (feedBtn && selB) feedBtn.addEventListener('click', () => drillToFilter(dim.feed(selB.key)));
}

function shortLabel(dim, b) {
  if (dim.id === 'weekday') return b.label.slice(0, 3);
  if (dim.id === 'duration') return `${b.key}h`;
  if (dim.id === 'general') return b.key === 'cash' ? 'Cash' : 'Tourn.';
  if (dim.id === 'buyin') return fmtNum(Number(b.key));
  if (dim.id === 'location') return b.label.length > 9 ? b.label.slice(0, 8) + '…' : b.label;
  return b.label;
}
