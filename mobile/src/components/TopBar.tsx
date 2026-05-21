import { View, Text, type ViewStyle } from 'react-native';
import type { Theme } from '../theme/vault';
import type { ReactNode } from 'react';

interface Props {
  t: Theme;
  title: string;
  left?: ReactNode;
  right?: ReactNode;
  big?: boolean;
  style?: ViewStyle;
}

/**
 * Reusable top bar matching the prototype's `TopBar`. `big` mode displays the
 * title in the display typeface at 28px (used by Home / Groups / Privacy);
 * default mode displays at 18px for sub-screens.
 */
export function TopBar({ t, title, left, right, big = false, style }: Props) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 18,
        paddingTop: 14,
        paddingBottom: 12,
        minHeight: 52,
        borderBottomWidth: big ? 0 : 1,
        borderBottomColor: t.divider,
        ...style,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
        {left}
        <Text
          numberOfLines={1}
          style={{
            fontFamily: t.fontDisplay,
            fontWeight: '600',
            fontSize: big ? 28 : 18,
            letterSpacing: -0.5,
            color: t.text,
          }}
        >
          {title}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>{right}</View>
    </View>
  );
}
