// Minimal hand-rolled SVG line chart (locked decision: no dependencies).
// Tier 2/3 reuse this for stat detail and reports.

import { fmtNum } from '../format.js';

// points: [{x, y}] with x ascending. Returns an SVG string.
export function lineChart({ points, width = 340, height = 150, padX = 12, padY = 16, includeZero = true, gridLines = 3, color = 'var(--accent)' }) {
  if (!points || points.length < 2) {
    return '<div class="chart-empty">Not enough data yet</div>';
  }
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  let x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (includeZero) { y0 = Math.min(y0, 0); y1 = Math.max(y1, 0); }
  if (x1 === x0) x1 = x0 + 1;
  if (y1 === y0) { y1 += 1; y0 -= 1; }
  const X = v => padX + ((v - x0) / (x1 - x0)) * (width - 2 * padX);
  const Y = v => height - padY - ((v - y0) / (y1 - y0)) * (height - 2 * padY);

  let grid = '';
  for (let i = 0; i <= gridLines; i++) {
    const v = y0 + ((y1 - y0) * i) / gridLines;
    const y = Y(v).toFixed(1);
    grid += `<line x1="${padX}" y1="${y}" x2="${width - padX}" y2="${y}" stroke="#2a2a2a" stroke-dasharray="3 4"/>`;
    grid += `<text x="${padX + 2}" y="${y - 3}" font-size="9" fill="var(--text-tertiary)">${fmtNum(v)}</text>`;
  }
  const path = points
    .map((p, i) => (i ? 'L' : 'M') + X(p.x).toFixed(1) + ' ' + Y(p.y).toFixed(1))
    .join(' ');
  return `<svg class="line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="line chart">` +
    `${grid}<path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

// Stat-detail chart (brief 5.10): line or bar over [{x, y, label}].
// Green line/bars on dark bg, dashed gridlines, zero line, sparse x labels.
// `spanBars` sizes each bar from the previous x to its own x (Duration view,
// where x is cumulative hours) instead of uniform slots.
export function seriesChart({ points, type = 'line', width = 340, height = 200, fmtY = fmtNum, spanBars = false, gridLines = 4 }) {
  if (!points || !points.length || (type === 'line' && points.length < 2)) {
    return '<div class="chart-empty">Not enough data yet</div>';
  }
  const padL = 40, padR = 10, padT = 12, padB = 24;
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  let y0, y1;
  ({ y0, y1, gridLines } = niceScale(ys, gridLines));
  const innerW = width - padL - padR, innerH = height - padT - padB;
  const Y = v => padT + innerH - ((v - y0) / (y1 - y0)) * innerH;
  let X, barW = 0, barLeft = null;
  if (type === 'bar') {
    if (spanBars) {
      const xmax = Math.max(...xs) || 1;
      X = v => padL + (v / xmax) * innerW;
      barLeft = i => X(i ? points[i - 1].x : 0);
    } else {
      const slot = innerW / points.length;
      barW = Math.max(1.5, slot * 0.7);
      X = (v, i) => padL + slot * i + slot / 2;
    }
  } else {
    let x0 = Math.min(...xs), x1 = Math.max(...xs);
    if (x1 === x0) x1 = x0 + 1;
    X = v => padL + ((v - x0) / (x1 - x0)) * innerW;
  }

  let svg = '';
  for (let i = 0; i <= gridLines; i++) {
    const v = y0 + ((y1 - y0) * i) / gridLines;
    const y = Y(v).toFixed(1);
    svg += `<line x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}" stroke="#2a2a2a" stroke-dasharray="3 4"/>`;
    svg += `<text x="${padL - 6}" y="${(+y + 3).toFixed(1)}" font-size="9" fill="var(--text-tertiary)" text-anchor="end">${fmtY(v)}</text>`;
  }
  if (y0 < 0) {
    svg += `<line x1="${padL}" y1="${Y(0).toFixed(1)}" x2="${width - padR}" y2="${Y(0).toFixed(1)}" stroke="#6b6b6b" stroke-width="0.8"/>`;
  }

  const xAt = (p, i) => (type === 'bar' && spanBars) ? (barLeft(i) + X(p.x)) / 2 : X(p.x, i);
  const nLabels = Math.min(points.length, 5);
  const idxs = new Set();
  for (let k = 0; k < nLabels; k++) idxs.add(Math.round((k * (points.length - 1)) / Math.max(1, nLabels - 1)));
  for (const i of idxs) {
    const p = points[i];
    svg += `<text x="${xAt(p, i).toFixed(1)}" y="${height - 7}" font-size="9" fill="var(--text-tertiary)" text-anchor="middle">${esc(p.label ?? '')}</text>`;
  }

  if (type === 'bar') {
    points.forEach((p, i) => {
      const yTop = Y(Math.max(0, p.y)), yBot = Y(Math.min(0, p.y));
      let x, w;
      if (spanBars) { x = barLeft(i); w = Math.max(1, X(p.x) - x - 1); } else { w = barW; x = X(p.x, i) - w / 2; }
      const fill = p.y < 0 ? 'var(--negative)' : 'var(--accent)';
      svg += `<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0.8, yBot - yTop).toFixed(1)}" rx="1.5" fill="${fill}"/>`;
    });
  } else {
    const d = points.map((p, i) => (i ? 'L' : 'M') + X(p.x).toFixed(1) + ' ' + Y(p.y).toFixed(1)).join(' ');
    const last = points[points.length - 1];
    svg += `<path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    svg += `<circle cx="${X(last.x).toFixed(1)}" cy="${Y(last.y).toFixed(1)}" r="3" fill="var(--accent)"/>`;
  }
  return `<svg class="line-chart stat-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${type} chart">${svg}</svg>`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Y range always including 0, snapped to a round 1/2/2.5/5 x 10^n step.
// Shared by seriesChart and barChart so both render identical gridlines.
export function niceScale(ys, gridLines = 4) {
  let y0 = Math.min(0, ...ys), y1 = Math.max(0, ...ys);
  if (y1 === y0) { y1 += 1; y0 -= y0 === 0 ? 0 : 1; }
  const raw = (y1 - y0) / gridLines;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(v => v >= raw) || 10 * mag;
  y0 = Math.floor(y0 / step) * step; y1 = Math.ceil(y1 / step) * step;
  return { y0, y1, gridLines: Math.max(1, Math.round((y1 - y0) / step)) };
}

// Category bar chart (Reports drill-downs, brief 5.13): one bar per bucket,
// same palette/gridlines as seriesChart. bars: [{key, label, y, empty?}].
// Each bar group is a focusable <g data-key> so screens can wire taps.
// `selected` highlights one key; `labelEvery` thins x labels (e.g. 3 for 24h).
export function barChart({ bars, width = 340, height = 210, fmtY = fmtNum, selected = null, labelEvery = 1, gridLines = 4, ariaLabel = 'bar chart' }) {
  if (!bars || !bars.length) return '<div class="chart-empty">Not enough data yet</div>';
  const padL = 40, padR = 8, padT = 12, padB = 24;
  const ys = bars.map(b => (Number.isFinite(b.y) ? b.y : 0));
  const sc = niceScale(ys, gridLines);
  const { y0, y1 } = sc;
  const innerW = width - padL - padR, innerH = height - padT - padB;
  const Y = v => padT + innerH - ((v - y0) / (y1 - y0)) * innerH;
  const slot = innerW / bars.length;
  const w = Math.max(2, slot * 0.68);
  let svg = '';
  for (let i = 0; i <= sc.gridLines; i++) {
    const v = y0 + ((y1 - y0) * i) / sc.gridLines;
    const y = Y(v).toFixed(1);
    svg += `<line x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}" stroke="#2a2a2a" stroke-dasharray="3 4"/>`;
    svg += `<text x="${padL - 6}" y="${(+y + 3).toFixed(1)}" font-size="9" fill="var(--text-tertiary)" text-anchor="end">${esc(fmtY(v))}</text>`;
  }
  if (y0 < 0) {
    svg += `<line x1="${padL}" y1="${Y(0).toFixed(1)}" x2="${width - padR}" y2="${Y(0).toFixed(1)}" stroke="#6b6b6b" stroke-width="0.8"/>`;
  }
  bars.forEach((b, i) => {
    const cx = padL + slot * i + slot / 2;
    const v = ys[i];
    const yTop = Y(Math.max(0, v)), yBot = Y(Math.min(0, v));
    const fill = b.empty ? '#2a2a2a' : v < 0 ? 'var(--negative)' : 'var(--accent)';
    const sel = selected !== null && String(b.key) === String(selected);
    const dim = selected !== null && !sel ? ' opacity="0.45"' : '';
    svg += `<g class="bar" data-key="${esc(b.key)}" tabindex="${b.empty ? -1 : 0}" role="button" aria-label="${esc(b.label)}: ${esc(fmtY(v))}"${dim}>` +
      `<rect x="${(cx - slot / 2).toFixed(1)}" y="${padT}" width="${slot.toFixed(1)}" height="${innerH}" fill="transparent"/>` +
      `<rect x="${(cx - w / 2).toFixed(1)}" y="${yTop.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0.8, yBot - yTop).toFixed(1)}" rx="1.5" fill="${fill}"${sel ? ' stroke="#fff" stroke-width="1"' : ''}/></g>`;
    if (i % labelEvery === 0) {
      svg += `<text x="${cx.toFixed(1)}" y="${height - 7}" font-size="9" fill="var(--text-tertiary)" text-anchor="middle">${esc(b.short ?? b.label)}</text>`;
    }
  });
  return `<svg class="line-chart stat-chart bar-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(ariaLabel)}">${svg}</svg>`;
}
