// Statistics registry (brief 5.9 / 5.10): which metrics appear in which
// section, how each is computed (via stats.js formulas) and formatted, and
// how the stat-detail series are built. Pure: no DOM.

import * as S from './stats.js';
import { fmtMoney, fmtNum, fmtHours, monthKey } from './format.js';

export const SCOPES = {
  all: { label: 'All', pick: list => list },
  cash: { label: 'Cash games', pick: S.cashOnly },
  tournament: { label: 'Tournaments', pick: S.tournamentsOnly },
};

// unit: money | rate | bb | bbrate | bb100 | pct | count | hours
// value(doc, sessions, mode) -> number | null
const M = {
  net: { label: 'Net result', unit: 'money', staking: true, bb: 'net_bb',
    value: (d, l, m) => l.length ? S.totalNet(d, l, m) : null },
  hourly: { label: 'Net hourly rate', unit: 'rate', staking: true, bb: 'hourly_bb',
    value: (d, l, m) => S.netHourlyRate(d, l, m) },
  avg_net: { label: 'Average net result', unit: 'money', staking: true, bb: 'avg_net_bb',
    value: (d, l, m) => S.avgNet(d, l, m) },
  count: { label: 'Number of sessions', unit: 'count', value: (d, l) => l.length },
  records: { label: 'Number of records', unit: 'count', value: (d, l) => l.length },
  avg_duration: { label: 'Average duration', unit: 'hours', value: (d, l) => S.avgDuration(l) },
  duration: { label: 'Duration of play', unit: 'hours', value: (d, l) => l.length ? S.durationOfPlay(l) : null },
  hands: { label: 'Hands count', unit: 'count', value: (d, l) => S.handsTotal(l) },
  bb100: { label: 'BB per 100 hands', unit: 'bb100', value: (d, l) => S.bbPer100Agg(d, l) },
  hourly_bb: { label: 'Hourly rate in BB', unit: 'bbrate', money: 'hourly', value: (d, l) => S.hourlyRateBB(d, l) },
  avg_net_bb: { label: 'Average net result in BB', unit: 'bb', money: 'avg_net', value: (d, l) => S.avgNetBB(d, l) },
  stddev: { label: 'Standard deviation per hour', unit: 'rate', bb: 'stddev_bb', signless: true,
    value: (d, l, m) => S.stdDevPerHour(d, l, m) },
  stddev_bb: { label: 'Standard deviation per hour in BB', unit: 'bbrate', money: 'stddev', signless: true,
    value: (d, l) => S.stdDevPerHourBB(d, l) },
  win_ratio: { label: 'Win ratio', unit: 'pct', staking: true, value: (d, l, m) => S.winRatio(d, l, m) },
  net_bb: { label: 'Net result in BB', unit: 'bb', money: 'net', value: (d, l) => S.totalNetBB(d, l) },
  avg_buyin: { label: 'Average buy-in', unit: 'money', signless: true, value: (d, l) => S.avgBuyIn(d, l) },
  roi: { label: 'ROI', unit: 'pct', value: (d, l) => S.roi(d, l) },
  itm: { label: 'ITM ratio', unit: 'pct', value: (d, l) => S.itmRatio(d, l) },
};
export const METRICS = M;

// Exactly the rows listed in brief 5.9, in order.
export const SECTIONS = {
  all: ['net', 'hourly', 'avg_net', 'count', 'avg_duration', 'duration', 'hands'],
  cash: ['net', 'hourly', 'bb100', 'hourly_bb', 'avg_net', 'avg_net_bb', 'stddev', 'win_ratio', 'records', 'net_bb', 'avg_buyin'],
  tournament: ['net', 'hourly', 'roi', 'itm', 'records', 'avg_buyin'],
};

export function metricValue(doc, metricId, sessions, mode = 'net') {
  const def = M[metricId];
  return def ? def.value(doc, sessions, mode) : null;
}

// Display string for a metric value. `currency` for money units.
export function fmtMetric(def, v, currency) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '--';
  switch (def.unit) {
    case 'money': return fmtMoney(v, currency);
    case 'rate': return fmtMoney(v, currency) + '/h';
    case 'bb': return fmtNum(v) + ' BB';
    case 'bbrate': return fmtNum(v) + ' BB/h';
    case 'bb100': return fmtNum(v) + ' BB';
    case 'pct': return fmtNum(v * 100) + '%';
    case 'hours': return fmtHours(v);
    default: return String(Math.round(v));
  }
}

// Colour class: results green/red; neutral metrics (counts, durations, std
// dev, buy-ins, ratios) stay white.
export function metricClass(def, v) {
  if (v === null || !Number.isFinite(v) || def.signless) return '';
  if (['money', 'rate', 'bb', 'bbrate', 'bb100'].includes(def.unit) || def === M.roi) {
    return v > 0 ? 'pos' : v < 0 ? 'neg' : '';
  }
  return '';
}

// Axis tick formatting (compact, no currency).
export function fmtAxis(def, v) {
  if (def.unit === 'pct') return fmtNum(v * 100) + '%';
  if (def.unit === 'hours') return fmtNum(v) + 'h';
  if (Math.abs(v) >= 1000) return fmtNum(v / 1000) + 'k';
  return fmtNum(v);
}

function chrono(list) {
  return [...list].sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
}

const MONTHS3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Stat-detail series. Returns [{x, y, label}] in chronological order.
//  line: y = metric over ALL sessions up to and including this point (cumulative).
//  bar:  y = metric over just this point's own bucket (per session / month / year).
//  group: unit (x = session #) | month | year | duration (x = cumulative hours).
export function buildSeries(doc, metricId, sessions, { group = 'unit', chart = 'line', mode = 'net' } = {}) {
  const def = M[metricId];
  const list = chrono(sessions);
  if (!def || !list.length) return [];
  const val = l => def.value(doc, l, mode);

  if (group === 'month' || group === 'year') {
    const buckets = new Map();
    for (const s of list) {
      const d = new Date(s.start_time);
      const k = group === 'month' ? monthKey(d) : String(d.getFullYear());
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(s);
    }
    const keys = [...buckets.keys()];
    const out = [];
    let upTo = [];
    keys.forEach((k, i) => {
      const own = buckets.get(k);
      upTo = upTo.concat(own);
      const label = group === 'month'
        ? MONTHS3[Number(k.slice(5)) - 1] + ' ' + k.slice(2, 4)
        : k;
      out.push({ x: i + 1, y: chart === 'bar' ? val(own) : val(upTo), label, n: own.length });
    });
    return out.filter(p => p.y !== null && Number.isFinite(p.y));
  }

  const out = [];
  let hours = 0;
  list.forEach((s, i) => {
    hours += S.sessionHours(s);
    const y = chart === 'bar' ? val([s]) : val(list.slice(0, i + 1));
    const x = group === 'duration' ? hours : i + 1;
    out.push({ x, y, label: group === 'duration' ? fmtNum(hours) + 'h' : '#' + (i + 1) });
  });
  return out.filter(p => p.y !== null && Number.isFinite(p.y));
}
