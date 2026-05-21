import { Pressable, Text, type ViewStyle } from 'react-native';
import type { Theme } from '../theme/vault';

interface BtnProps {
  t: Theme;
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  full?: boolean;
  style?: ViewStyle;
}

export function PrimaryButton({ t, label, onPress, disabled, full = true, style }: BtnProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        backgroundColor: t.accent,
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        borderRadius: t.radius,
        paddingHorizontal: 20,
        paddingVertical: 15,
        alignSelf: full ? 'stretch' : 'flex-start',
        alignItems: 'center',
        ...style,
      })}
    >
      <Text
        style={{
          color: t.accentInk,
          fontFamily: t.font,
          fontSize: 15,
          fontWeight: '600',
          letterSpacing: -0.15,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function GhostButton({ t, label, onPress, disabled, full = true, style }: BtnProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: t.borderStrong,
        opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
        borderRadius: t.radius,
        paddingHorizontal: 20,
        paddingVertical: 14,
        alignSelf: full ? 'stretch' : 'flex-start',
        alignItems: 'center',
        ...style,
      })}
    >
      <Text style={{ color: t.text, fontFamily: t.font, fontSize: 14, fontWeight: '500' }}>
        {label}
      </Text>
    </Pressable>
  );
}
