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
    grid += `<text x="${padX + 2}" y="${y - 3}" font-size="9" fill="#6b6b6b">${fmtNum(v)}</text>`;
  }
  const path = points
    .map((p, i) => (i ? 'L' : 'M') + X(p.x).toFixed(1) + ' ' + Y(p.y).toFixed(1))
    .join(' ');
  return `<svg class="line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="line chart">` +
    `${grid}<path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
