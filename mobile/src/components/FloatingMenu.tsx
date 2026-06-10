/**
 * FloatingMenu — Vault-styled floating action menu (long-press / "..." menus).
 *
 * Replaces the legacy bottom-anchored Modal sheets with a centered, floating
 * card: dimmed backdrop, scale+fade "pop" entrance, Vault tokens throughout.
 *
 * Contract: pressing an item ALWAYS closes the menu first (via onClose), then
 * runs the item's onPress. Callers do not need to call onClose themselves.
 */

import { useEffect, useRef } from 'react';
import { Modal, View, Text, Pressable, Animated, Easing, type ViewStyle } from 'react-native';
import type { ReactNode } from 'react';
import type { Theme } from '../theme/vault';

export interface FloatingMenuItem {
  key: string;
  icon: ReactNode;
  label: string;
  /** Invoked AFTER the menu has been closed (see onClose contract above). */
  onPress: () => void;
  /** Renders the icon/label in t.danger and skips the trailing divider logic specially. */
  danger?: boolean;
}

export interface FloatingMenuProps {
  t: Theme;
  visible: boolean;
  onClose: () => void;
  /** Optional header title, fontDisplay 16/600. */
  title?: string;
  /** Optional header subtitle, fontMono 10 uppercase letterSpacing — e.g. an Aegis ID. */
  subtitle?: string;
  items: FloatingMenuItem[];
  /**
   * Optional extra content rendered ABOVE the item list (e.g. a quick-reaction
   * row). Rendered below the header divider (if any).
   */
  topContent?: ReactNode;
}

const ENTER_DURATION = 160;

export function FloatingMenu({ t, visible, onClose, title, subtitle, items, topContent }: FloatingMenuProps) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      progress.setValue(0);
      Animated.timing(progress, {
        toValue: 1,
        duration: ENTER_DURATION,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }
  }, [visible, progress]);

  const cardStyle: Animated.WithAnimatedObject<ViewStyle> = {
    opacity: progress,
    transform: [
      {
        scale: progress.interpolate({
          inputRange: [0, 1],
          outputRange: [0.92, 1],
        }),
      },
    ],
  };

  function handleItemPress(item: FloatingMenuItem) {
    onClose();
    item.onPress();
  }

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close menu"
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.55)',
          justifyContent: 'center',
          alignItems: 'center',
          paddingHorizontal: 28,
        }}
      >
        <Animated.View
          style={[
            {
              width: '100%',
              maxWidth: 340,
              alignSelf: 'center',
              backgroundColor: t.surface,
              borderRadius: t.radiusL,
              borderWidth: 1,
              borderColor: t.border,
              overflow: 'hidden',
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 8 },
              shadowOpacity: 0.3,
              shadowRadius: 24,
              elevation: 16,
            },
            cardStyle,
          ]}
        >
          {/* Stop propagation so taps inside the card don't dismiss it */}
          <Pressable onPress={(e) => e.stopPropagation?.()}>
            {(title || subtitle) ? (
              <View
                style={{
                  paddingHorizontal: 18,
                  paddingTop: 16,
                  paddingBottom: 12,
                  borderBottomWidth: 1,
                  borderBottomColor: t.divider,
                }}
              >
                {title ? (
                  <Text
                    numberOfLines={1}
                    style={{ fontFamily: t.fontDisplay, fontSize: 16, fontWeight: '600', color: t.text }}
                  >
                    {title}
                  </Text>
                ) : null}
                {subtitle ? (
                  <Text
                    numberOfLines={1}
                    style={{
                      fontFamily: t.fontMono,
                      fontSize: 10,
                      color: t.textDim,
                      letterSpacing: 1,
                      textTransform: 'uppercase',
                      marginTop: title ? 4 : 0,
                    }}
                  >
                    {subtitle}
                  </Text>
                ) : null}
              </View>
            ) : null}

            {topContent}

            {items.map((item, idx) => (
              <View key={item.key}>
                <Pressable
                  onPress={() => handleItemPress(item)}
                  accessibilityRole="button"
                  accessibilityLabel={item.label}
                  android_ripple={{ color: t.surface2 }}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 14,
                    paddingVertical: 14,
                    paddingHorizontal: 18,
                    backgroundColor: pressed ? t.surface2 : 'transparent',
                  })}
                >
                  {item.icon}
                  <Text
                    style={{
                      fontFamily: t.font,
                      fontSize: 15,
                      fontWeight: '500',
                      color: item.danger ? t.danger : t.text,
                    }}
                  >
                    {item.label}
                  </Text>
                </Pressable>
                {idx < items.length - 1 ? (
                  <View style={{ height: 1, backgroundColor: t.divider, marginLeft: 18 }} />
                ) : null}
              </View>
            ))}
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}
