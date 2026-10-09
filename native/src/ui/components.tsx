// Shared UI primitives in the brief's design language (section 2):
// rows, big stat rows, segmented control, buttons, text fields, bottom
// sheets (value prompt + option picker) and a dependency-free SVG line chart.
import { useState, type ReactNode } from 'react';
import {
  KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
  type KeyboardTypeOptions, type StyleProp, type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Line, Path, Rect } from 'react-native-svg';

import { fmtMoney, moneyTone } from '../lib/format';
import { Icon, type IconName } from './icons';
import { colors, PAD, toneColor, type } from './theme';

// --- layout -------------------------------------------------------------------

export function Header({ title, left, right }: { title: string; left?: ReactNode; right?: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[s.header, { paddingTop: insets.top + 8 }]}>
      <View style={s.headerSide}>{left}</View>
      <Text style={type.title} accessibilityRole="header" numberOfLines={1}>{title}</Text>
      <View style={[s.headerSide, { alignItems: 'flex-end' }]}>{right}</View>
    </View>
  );
}

export function HeaderButton({ label, icon, onPress, tone = 'accent', disabled }: {
  label: string; icon?: IconName; onPress: () => void; tone?: 'accent' | 'plain'; disabled?: boolean;
}) {
  const c = disabled ? colors.text3 : tone === 'accent' ? colors.accent : colors.text;
  return (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={12} accessibilityRole="button" accessibilityLabel={label}>
      {icon ? <Icon name={icon} color={c} /> : <Text style={[type.body, { color: c, fontWeight: '600' }]}>{label}</Text>}
    </Pressable>
  );
}

export function SectionHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <View style={s.section}>
      <Text style={[type.label, { color: colors.accent }]}>{title}</Text>
      {right}
    </View>
  );
}

export function Empty({ text }: { text: string }) {
  return <Text style={[type.body, s.empty]}>{text}</Text>;
}

export function ErrorText({ text }: { text: string | null }) {
  if (!text) return null;
  return <Text style={[type.small, { color: colors.negative, paddingHorizontal: PAD, paddingVertical: 8 }]} accessibilityRole="alert">{text}</Text>;
}

// --- values -------------------------------------------------------------------

export function Money({ amount, currency, style }: { amount: number | null; currency: string; style?: object }) {
  return <Text style={[type.body, style, { color: toneColor(moneyTone(amount)) }]}>{fmtMoney(amount, currency)}</Text>;
}

// --- rows ---------------------------------------------------------------------

export function Row({ label, value, valueColor, onPress, sub }: {
  label: string; value?: string; valueColor?: string; onPress?: () => void; sub?: string;
}) {
  const body = (
    <View style={s.row}>
      <View style={{ flex: 1 }}>
        <Text style={type.body}>{label}</Text>
        {sub ? <Text style={type.small}>{sub}</Text> : null}
      </View>
      <Text style={[type.body, { color: valueColor ?? (value === '--' ? colors.text3 : colors.text2) }]} numberOfLines={1}>
        {value ?? ''}
      </Text>
      {onPress ? <Icon name="chevron" size={18} color={colors.text3} /> : null}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${label}${value ? ', ' + value : ''}`}
      style={({ pressed }) => (pressed ? { backgroundColor: colors.bg2 } : null)}>
      {body}
    </Pressable>
  );
}

export function BigStatRow({ label, value, color, onPress }: { label: string; value: string; color?: string; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={`${label}, ${value}`} style={({ pressed }) => [s.bigRow, pressed && { backgroundColor: colors.bg2 }]}>
      <View style={{ flex: 1 }}>
        <Text style={type.label}>{label}</Text>
        <Text style={[type.mid, { color: color ?? (value === '--' ? colors.text3 : colors.text), marginTop: 2 }]}>{value}</Text>
      </View>
      {onPress ? <Icon name="chevron" size={18} color={colors.text3} /> : null}
    </Pressable>
  );
}

// --- controls -----------------------------------------------------------------

export function Segmented<T extends string>({ options, value, onChange, scroll }: {
  options: { id: T; label: string }[]; value: T; onChange: (v: T) => void; scroll?: boolean;
}) {
  const items = options.map(o => {
    const active = o.id === value;
    return (
      <Pressable key={o.id} onPress={() => onChange(o.id)} accessibilityRole="tab" accessibilityState={{ selected: active }}
        style={[s.segItem, active && s.segActive, !scroll && { flex: 1 }]}>
        <Text style={[s.segText, active && { color: colors.text }]} numberOfLines={1}>{o.label}</Text>
      </Pressable>
    );
  });
  if (scroll) {
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.segBar} contentContainerStyle={{ paddingHorizontal: PAD - 6 }}>
        {items}
      </ScrollView>
    );
  }
  return <View style={[s.segBar, { flexDirection: 'row', paddingHorizontal: PAD - 6 }]} accessibilityRole="tablist">{items}</View>;
}

export function Button({ label, onPress, kind = 'primary', disabled, style }: {
  label: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const bg = kind === 'primary' ? colors.accent : colors.bg3;
  const fg = kind === 'primary' ? colors.bg : kind === 'danger' ? colors.negative : colors.text;
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [s.button, { backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.8 : 1 }, style]}>
      <Text style={[type.body, { color: fg, fontWeight: '600' }]}>{label}</Text>
    </Pressable>
  );
}

export function Chips<T extends string | number>({ options, value, onChange }: {
  options: { id: T; label: string }[]; value: T | null; onChange: (v: T) => void;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: PAD, paddingBottom: 10 }}>
      {options.map(o => {
        const active = o.id === value;
        return (
          <Pressable key={String(o.id)} onPress={() => onChange(o.id)} accessibilityRole="button" accessibilityState={{ selected: active }}
            style={[s.chip, active && { borderColor: colors.accent, backgroundColor: colors.accentDim }]}>
            <Text style={[type.small, { color: active ? colors.accent : colors.text2 }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export function Field({ label, value, onChangeText, placeholder, keyboardType, secure, autoFocus, autoComplete, onSubmit }: {
  label: string; value: string; onChangeText: (v: string) => void; placeholder?: string;
  keyboardType?: KeyboardTypeOptions; secure?: boolean; autoFocus?: boolean;
  autoComplete?: 'email' | 'password' | 'new-password' | 'off'; onSubmit?: () => void;
}) {
  return (
    <View style={s.field}>
      <Text style={type.label}>{label}</Text>
      <TextInput
        value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={colors.text3}
        keyboardType={keyboardType} secureTextEntry={secure} autoFocus={autoFocus} autoCapitalize="none"
        autoCorrect={false} autoComplete={autoComplete} onSubmitEditing={onSubmit} accessibilityLabel={label}
        style={s.input} keyboardAppearance="dark"
      />
    </View>
  );
}

// --- sheets -------------------------------------------------------------------

export function Sheet({ visible, title, onClose, children }: { visible: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <Pressable style={s.backdrop} onPress={onClose} accessibilityLabel="Close" />
        <View style={[s.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={s.sheetHead}>
            <Text style={type.title}>{title}</Text>
            <HeaderButton label="Close" icon="close" tone="plain" onPress={onClose} />
          </View>
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export interface PromptSpec {
  title: string;
  label: string;
  initial: string;
  keyboardType?: KeyboardTypeOptions;
  placeholder?: string;
  /** Return an error message to keep the sheet open, or null to close it. */
  onSave: (raw: string) => string | null;
  /** Optional secondary action, e.g. "Use estimate" or "Clear". */
  extra?: { label: string; onPress: () => void };
}

/** One text value in a bottom sheet. */
export function PromptSheet({ spec, onClose }: { spec: PromptSpec | null; onClose: () => void }) {
  return spec ? <PromptBody spec={spec} onClose={onClose} /> : null;
}

/** Mounted per opening (keyed by useSheets), so the field starts from spec.initial. */
function PromptBody({ spec, onClose }: { spec: PromptSpec; onClose: () => void }) {
  const [raw, setRaw] = useState(spec.initial);
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const err = spec.onSave(raw);
    if (err) setError(err); else onClose();
  };
  return (
    <Sheet visible title={spec.title} onClose={onClose}>
      <Field label={spec.label} value={raw} onChangeText={setRaw} keyboardType={spec.keyboardType}
        placeholder={spec.placeholder} autoFocus onSubmit={save} />
      <ErrorText text={error} />
      <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: PAD, paddingTop: 8 }}>
        {spec.extra ? (
          <Button label={spec.extra.label} kind="secondary" style={{ flex: 1 }}
            onPress={() => { spec.extra?.onPress(); onClose(); }} />
        ) : null}
        <Button label="Save" onPress={save} style={{ flex: 1 }} />
      </View>
    </Sheet>
  );
}

export interface PickSpec {
  title: string;
  options: { id: string; label: string }[];
  selected: string | null;
  onPick: (id: string) => void;
  /** When set, the sheet offers a text field to create a new entry by name. */
  onAdd?: (name: string) => void;
}

/** Option list in a bottom sheet, with optional "add new". */
export function PickSheet({ spec, onClose }: { spec: PickSpec | null; onClose: () => void }) {
  return spec ? <PickBody spec={spec} onClose={onClose} /> : null;
}

function PickBody({ spec, onClose }: { spec: PickSpec; onClose: () => void }) {
  const [name, setName] = useState('');
  return (
    <Sheet visible title={spec.title} onClose={onClose}>
      <ScrollView style={{ maxHeight: 360 }}>
        {spec.options.map(o => (
          <Pressable key={o.id} onPress={() => { spec.onPick(o.id); onClose(); }} accessibilityRole="button"
            accessibilityState={{ selected: o.id === spec.selected }} style={s.row}>
            <Text style={[type.body, { flex: 1, color: o.id === spec.selected ? colors.accent : colors.text }]}>{o.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {spec.onAdd ? (
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10, paddingRight: PAD }}>
          <View style={{ flex: 1 }}>
            <Field label="Add new" value={name} onChangeText={setName} placeholder="Name" />
          </View>
          <Button label="Add" disabled={!name.trim()} onPress={() => { spec.onAdd?.(name.trim()); onClose(); }} />
        </View>
      ) : null}
    </Sheet>
  );
}

// --- chart --------------------------------------------------------------------

/** Minimal line chart: green line, dashed gridlines, zero baseline. */
export function LineChart({ points, height = 180, width }: { points: { x: number; y: number }[]; height?: number; width: number }) {
  if (points.length < 2 || width <= 0) {
    return <View style={{ height, justifyContent: 'center' }}><Text style={[type.small, { textAlign: 'center' }]}>Not enough data to chart yet.</Text></View>;
  }
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [yMin, yMax] = [Math.min(0, ...ys), Math.max(0, ...ys)];
  const pad = 8;
  const sx = (x: number) => pad + ((x - x0) / (x1 - x0 || 1)) * (width - 2 * pad);
  const sy = (y: number) => pad + (1 - (y - yMin) / (yMax - yMin || 1)) * (height - 2 * pad);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
  const grid = [0.25, 0.5, 0.75].map(f => pad + f * (height - 2 * pad));
  return (
    <Svg width={width} height={height} accessibilityLabel="Line chart">
      {grid.map(y => <Line key={y} x1={pad} x2={width - pad} y1={y} y2={y} stroke={colors.border} strokeDasharray="4 4" />)}
      <Line x1={pad} x2={width - pad} y1={sy(0)} y2={sy(0)} stroke={colors.text3} strokeWidth={1} />
      <Path d={d} stroke={colors.accent} strokeWidth={2} fill="none" strokeLinejoin="round" />
    </Svg>
  );
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: PAD, paddingBottom: 10, backgroundColor: colors.bg,
  },
  headerSide: { width: 80 },
  section: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: PAD, paddingTop: 20, paddingBottom: 8,
  },
  empty: { color: colors.text2, textAlign: 'center', padding: 40 },
  row: {
    minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: PAD,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  bigRow: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: PAD, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  segBar: { flexGrow: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  segItem: { paddingHorizontal: 10, paddingVertical: 12, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  segActive: { borderBottomColor: colors.accent },
  segText: { color: colors.text2, fontSize: 12, fontWeight: '500', letterSpacing: 0.8, textTransform: 'uppercase' },
  button: { height: 50, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg2 },
  field: { paddingHorizontal: PAD, paddingVertical: 8, gap: 6 },
  input: {
    color: colors.text, fontSize: 17, backgroundColor: colors.bg3, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: Platform.OS === 'ios' ? 12 : 8, borderWidth: 1, borderColor: colors.border,
  },
  backdrop: { flex: 1, backgroundColor: '#000a' },
  sheet: { backgroundColor: colors.bg2, borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingTop: 6 },
  sheetHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: PAD, paddingVertical: 12 },
});

/** Prompt + pick sheet state for a screen: call prompt(spec) / pick(spec), render `sheets`. */
export function useSheets() {
  // seq changes on every open, remounting the sheet body so its inputs reset.
  const [promptState, setPrompt] = useState<{ spec: PromptSpec; seq: number } | null>(null);
  const [pickState, setPick] = useState<{ spec: PickSpec; seq: number } | null>(null);
  const prompt = (spec: PromptSpec | null) => setPrompt(p => (spec ? { spec, seq: (p?.seq ?? 0) + 1 } : null));
  const pick = (spec: PickSpec | null) => setPick(p => (spec ? { spec, seq: (p?.seq ?? 0) + 1 } : null));
  const sheets = (
    <>
      <PromptSheet key={`prompt${promptState?.seq ?? 0}`} spec={promptState?.spec ?? null} onClose={() => prompt(null)} />
      <PickSheet key={`pick${pickState?.seq ?? 0}`} spec={pickState?.spec ?? null} onClose={() => pick(null)} />
    </>
  );
  return { prompt, pick, sheets };
}

/** Destructive confirmation in a bottom sheet (Alert.alert buttons are a no-op on web). */
export function ConfirmSheet({ visible, title, message, confirmLabel, onConfirm, onClose }: {
  visible: boolean; title: string; message: string; confirmLabel: string; onConfirm: () => void; onClose: () => void;
}) {
  return (
    <Sheet visible={visible} title={title} onClose={onClose}>
      <Text style={[type.body, { color: colors.text2, paddingHorizontal: PAD, paddingBottom: 16 }]}>{message}</Text>
      <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: PAD }}>
        <Button label="Cancel" kind="secondary" onPress={onClose} style={{ flex: 1 }} />
        <Button label={confirmLabel} kind="danger" onPress={() => { onClose(); onConfirm(); }} style={{ flex: 1 }} />
      </View>
    </Sheet>
  );
}

/** Minimal bar chart for stat drilldowns: green up, red down from a zero baseline. */
export function BarChart({ points, height = 180, width }: { points: { y: number }[]; height?: number; width: number }) {
  if (points.length === 0 || width <= 0) {
    return <View style={{ height, justifyContent: 'center' }}><Text style={[type.small, { textAlign: 'center' }]}>Not enough data to chart yet.</Text></View>;
  }
  const ys = points.map(p => p.y);
  const [yMin, yMax] = [Math.min(0, ...ys), Math.max(0, ...ys)];
  const pad = 8;
  const sy = (y: number) => pad + (1 - (y - yMin) / (yMax - yMin || 1)) * (height - 2 * pad);
  const slot = (width - 2 * pad) / points.length;
  const bar = Math.max(1, slot * 0.7);
  return (
    <Svg width={width} height={height} accessibilityLabel="Bar chart">
      <Line x1={pad} x2={width - pad} y1={sy(0)} y2={sy(0)} stroke={colors.text3} strokeWidth={1} />
      {points.map((p, i) => {
        const top = Math.min(sy(p.y), sy(0));
        return <Rect key={i} x={pad + i * slot + (slot - bar) / 2} y={top} width={bar} height={Math.max(1, Math.abs(sy(p.y) - sy(0)))}
          fill={p.y < 0 ? colors.negative : colors.accent} rx={2} />;
      })}
    </Svg>
  );
}
