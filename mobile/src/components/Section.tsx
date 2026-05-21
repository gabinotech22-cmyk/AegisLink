import { View, Text, Pressable } from 'react-native';
import type { ReactNode } from 'react';
import type { Theme } from '../theme/vault';
import { I } from './icons';

interface SectionProps {
  t: Theme;
  label: string;
  hint?: string;
  children: ReactNode;
}

/**
 * Settings section: monospace caps label + rounded grouping. Matches the
 * `Section` / `SectionX` / `SectP` components shared across prototype files.
 */
export function Section({ t, label, hint, children }: SectionProps) {
  return (
    <View style={{ marginBottom: 18 }}>
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          paddingHorizontal: 22,
          paddingBottom: 6,
        }}
      >
        <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1 }}>
          {label}
        </Text>
        {hint ? (
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, letterSpacing: 0.6 }}>
            {hint}
          </Text>
        ) : null}
      </View>
      <View
        style={{
          marginHorizontal: 18,
          backgroundColor: t.surface,
          borderRadius: t.radius,
          borderWidth: 1,
          borderColor: t.border,
          overflow: 'hidden',
        }}
      >
        {children}
      </View>
    </View>
  );
}

interface RowProps {
  t: Theme;
  icon?: ReactNode;
  label: string;
  sub?: string;
  onPress?: () => void;
  trailing?: ReactNode;
  danger?: boolean;
  noBorder?: boolean;
}

export function Row({ t, icon, label, sub, onPress, trailing, danger, noBorder }: RowProps) {
  const labelColor = danger ? t.danger : t.text;
  const content = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: noBorder ? 0 : 1,
        borderBottomColor: t.divider,
      }}
    >
      {icon ? <View style={{ width: 22, alignItems: 'center' }}>{icon}</View> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontFamily: t.font, fontSize: 14, color: labelColor }}>{label}</Text>
        {sub ? (
          <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>{sub}</Text>
        ) : null}
      </View>
      {trailing ?? (onPress ? <I.Chevron size={14} color={t.textFaint} /> : null)}
    </View>
  );
  return onPress ? (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: t.surface2 }}
      style={({ pressed }) => ({ backgroundColor: pressed ? t.surface2 : 'transparent' })}
    >
      {content}
    </Pressable>
  ) : (
    content
  );
}

interface ToggleProps {
  t: Theme;
  icon?: ReactNode;
  label: string;
  sub?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  noBorder?: boolean;
  disabled?: boolean;
}

export function Toggle({ t, icon, label, sub, value, onChange, noBorder, disabled }: ToggleProps) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 11,
        borderBottomWidth: noBorder ? 0 : 1,
        borderBottomColor: t.divider,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {icon && <View style={{ width: 24, alignItems: 'center' }}>{icon}</View>}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontFamily: t.font, fontSize: 14, color: t.text }}>{label}</Text>
        {sub ? (
          <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>{sub}</Text>
        ) : null}
      </View>
      <Pressable
        onPress={() => !disabled && onChange(!value)}
        style={{
          width: 44,
          height: 26,
          borderRadius: 99,
          backgroundColor: value ? t.accent : t.surface3,
          justifyContent: 'center',
          paddingHorizontal: 3,
        }}
      >
        <View
          style={{
            width: 20,
            height: 20,
            borderRadius: 10,
            backgroundColor: value ? t.accentInk : '#fff',
            alignSelf: value ? 'flex-end' : 'flex-start',
          }}
        />
      </Pressable>
    </View>
  );
}

interface StatProps {
  t: Theme;
  label: string;
  val: string;
}

export function Stat({ t, label, val }: StatProps) {
  return (
    <View
      style={{
        padding: 12,
        backgroundColor: t.surface2,
        borderRadius: t.radiusS,
      }}
    >
      <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, letterSpacing: 1.1 }}>
        {label}
      </Text>
      <Text
        style={{
          fontFamily: t.fontDisplay,
          fontSize: 22,
          color: t.text,
          marginTop: 2,
          fontWeight: '600',
          letterSpacing: -0.4,
        }}
      >
        {val}
      </Text>
    </View>
  );
}
