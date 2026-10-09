// Design tokens from the brief (section 2), shared with the web app's css.
import { StyleSheet } from 'react-native';

import type { Tone } from '../lib/format';

export const colors = {
  bg: '#0a0a0a',
  bg2: '#161616',
  bg3: '#1f1f1f',
  border: '#2a2a2a',
  text: '#ffffff',
  text2: '#a8a8a8',
  text3: '#6b6b6b',
  accent: '#4ade80',
  accentDim: '#4ade8033',
  negative: '#f87171',
  warning: '#facc15',
} as const;

export const PAD = 16;

export function toneColor(t: Tone | 'pos' | 'neg' | ''): string {
  return t === 'pos' ? colors.accent : t === 'neg' ? colors.negative : colors.text;
}

export const type = StyleSheet.create({
  big: { color: colors.text, fontSize: 44, fontWeight: '300', fontVariant: ['tabular-nums'] },
  mid: { color: colors.text, fontSize: 24, fontWeight: '300', fontVariant: ['tabular-nums'] },
  body: { color: colors.text, fontSize: 16, fontWeight: '400' },
  small: { color: colors.text2, fontSize: 13 },
  label: { color: colors.text2, fontSize: 12, fontWeight: '500', textTransform: 'uppercase', letterSpacing: 0.6 },
  title: { color: colors.text, fontSize: 17, fontWeight: '600' },
});
