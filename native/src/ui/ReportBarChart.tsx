// Reports bar chart (brief 5.13): draws the geometry from lib/bar-chart.ts,
// which mirrors the web barChart. Each non-empty slot is a tap target; the
// selected bar gets a white outline and the others dim, as on the web.
import { Text, View } from 'react-native';
import Svg, { G, Line, Rect, Text as SvgText } from 'react-native-svg';

import { barLayout, compactMoney, type Bar } from '../lib/bar-chart';
import type { BucketKey } from '../lib/reports';
import { colors, type } from './theme';

const FILL = { pos: colors.accent, neg: colors.negative, empty: colors.border } as const;

export function ReportBarChart({ bars, width, height = 210, labelEvery = 1, selected = null, onSelect, label }: {
  bars: Bar[]; width: number; height?: number; labelEvery?: number;
  selected?: BucketKey | null; onSelect?: (key: BucketKey) => void; label: string;
}) {
  const layout = barLayout(bars, width, height, labelEvery);
  if (!layout) {
    return <View style={{ height, justifyContent: 'center' }}><Text style={[type.small, { textAlign: 'center' }]}>Not enough data yet</Text></View>;
  }
  const isSel = (k: BucketKey) => selected !== null && String(k) === String(selected);
  return (
    <Svg width={width} height={height} accessibilityLabel={label}>
      {layout.grid.map((g, i) => (
        <G key={`g${i}`}>
          <Line x1={layout.padL} x2={width - layout.padR} y1={g.y} y2={g.y} stroke={colors.border} strokeDasharray="3 4" />
          <SvgText x={layout.padL - 6} y={g.y + 3} fontSize={9} fill={colors.text3} textAnchor="end">{compactMoney(g.value)}</SvgText>
        </G>
      ))}
      {layout.zeroY !== null ? (
        <Line x1={layout.padL} x2={width - layout.padR} y1={layout.zeroY} y2={layout.zeroY} stroke={colors.text3} strokeWidth={0.8} />
      ) : null}
      {layout.bars.map(b => {
        const tap = b.tone !== 'empty' && onSelect ? () => onSelect(b.key) : undefined;
        const sel = isSel(b.key);
        return (
          <G key={String(b.key)} opacity={selected !== null && !sel ? 0.45 : 1}>
            <Rect x={b.slotX} y={layout.padT} width={b.slotW} height={layout.innerH} fill="transparent" onPress={tap} />
            <Rect x={b.x} y={b.y} width={b.w} height={b.h} rx={1.5} fill={FILL[b.tone]} onPress={tap}
              stroke={sel ? colors.text : undefined} strokeWidth={sel ? 1 : 0} />
            {b.axisLabel !== null ? (
              <SvgText x={b.cx} y={height - 7} fontSize={9} fill={colors.text3} textAnchor="middle">{b.axisLabel}</SvgText>
            ) : null}
          </G>
        );
      })}
    </Svg>
  );
}
