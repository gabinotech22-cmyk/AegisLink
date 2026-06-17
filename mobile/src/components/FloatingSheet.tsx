/**
 * FloatingSheet — Vault-styled floating window primitive.
 *
 * The canonical container for ALL of AegisLink's transient surfaces (attach,
 * message actions, pickers, prompts…). It is the generic sibling of
 * FloatingMenu: instead of a fixed item list it renders arbitrary `children`
 * inside the same floating card — dimmed backdrop, scale+fade "pop" entrance,
 * Vault tokens throughout. NEVER a full-screen push; always a window that
 * floats over the current context, matching the visual prototype.
 *
 * Contract:
 *  • Tapping the backdrop calls onClose. Taps inside the card never dismiss.
 *  • Header (title/subtitle) is optional and styled identically to FloatingMenu.
 *  • `maxWidth` lets denser surfaces (e.g. the attach grid) breathe wider than
 *    the default action-menu width without diverging from the card chrome.
 */

import { useEffect, useRef } from 'react';
import { Modal, View, Text, Pressable, Animated, Easing, type ViewStyle } from 'react-native';
import type { ReactNode } from 'react';
import type { Theme } from '../theme/vault';

export interface FloatingSheetProps {
  t: Theme;
  visible: boolean;
  onClose: () => void;
  /** Optional header title, fontDisplay 16/600. */
  title?: string;
  /** Optional header subtitle, fontMono 10 uppercase letterSpacing. */
  subtitle?: string;
  /** Card max width. Default 340 (matches FloatingMenu). Use ~420 for grids. */
  maxWidth?: number;
  children: ReactNode;
}

const ENTER_DURATION = 160;

export function FloatingSheet({
  t,
  visible,
  onClose,
  title,
  subtitle,
  maxWidth = 340,
  children,
}: FloatingSheetProps) {
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
      { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) },
    ],
  };

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.55)',
          justifyContent: 'center',
          alignItems: 'center',
          paddingHorizontal: 24,
        }}
      >
        <Animated.View
          style={[
            {
              width: '100%',
              maxWidth,
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
            {children}
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}
