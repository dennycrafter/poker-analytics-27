// Stroke icons drawn with react-native-svg (no icon-font dependency).
import type { ReactElement } from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { colors } from './theme';

export type IconName =
  | 'feed' | 'stats' | 'calendar' | 'more' | 'plus' | 'chevron' | 'back' | 'clock' | 'table' | 'pin'
  | 'pause' | 'play' | 'stack' | 'close' | 'trash';

const PATHS: Record<IconName, (c: string) => ReactElement> = {
  feed: c => <Path d="M4 6h16M4 12h16M4 18h10" stroke={c} strokeWidth={2} strokeLinecap="round" />,
  stats: c => <Path d="M5 20V11M12 20V4M19 20v-6" stroke={c} strokeWidth={2} strokeLinecap="round" />,
  calendar: c => (
    <>
      <Rect x={3.5} y={5} width={17} height={15} rx={2} stroke={c} strokeWidth={2} fill="none" />
      <Path d="M3.5 10h17M8 3v4M16 3v4" stroke={c} strokeWidth={2} strokeLinecap="round" />
    </>
  ),
  more: c => (
    <>
      <Circle cx={5} cy={12} r={1.8} fill={c} />
      <Circle cx={12} cy={12} r={1.8} fill={c} />
      <Circle cx={19} cy={12} r={1.8} fill={c} />
    </>
  ),
  plus: c => <Path d="M12 5v14M5 12h14" stroke={c} strokeWidth={2} strokeLinecap="round" />,
  chevron: c => <Path d="M9 6l6 6-6 6" stroke={c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />,
  back: c => <Path d="M15 6l-6 6 6 6" stroke={c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />,
  clock: c => (
    <>
      <Circle cx={12} cy={12} r={8.5} stroke={c} strokeWidth={2} fill="none" />
      <Path d="M12 7.5V12l3 2" stroke={c} strokeWidth={2} strokeLinecap="round" fill="none" />
    </>
  ),
  table: c => <Rect x={3} y={7} width={18} height={10} rx={5} stroke={c} strokeWidth={2} fill="none" />,
  pin: c => (
    <>
      <Path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0113 0c0 4.8-6.5 11-6.5 11z" stroke={c} strokeWidth={2} fill="none" />
      <Circle cx={12} cy={10} r={2.2} fill={c} />
    </>
  ),
  pause: c => <Path d="M9 6v12M15 6v12" stroke={c} strokeWidth={2.4} strokeLinecap="round" />,
  play: c => <Path d="M8 5.5v13l10.5-6.5z" fill={c} />,
  stack: c => (
    <>
      <Path d="M5 8c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3z" stroke={c} strokeWidth={2} fill="none" />
      <Path d="M5 8v4c0 1.7 3.1 3 7 3s7-1.3 7-3V8M5 12v4c0 1.7 3.1 3 7 3s7-1.3 7-3v-4" stroke={c} strokeWidth={2} fill="none" />
    </>
  ),
  close: c => <Path d="M6 6l12 12M18 6L6 18" stroke={c} strokeWidth={2} strokeLinecap="round" />,
  trash: c => (
    <Path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" stroke={c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
  ),
};

export function Icon({ name, size = 22, color = colors.text }: { name: IconName; size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no">
      {PATHS[name](color)}
    </Svg>
  );
}
