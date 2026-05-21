/**
 * SwipeableMessage
 * Wraps a single chat bubble with a swipe-left gesture that triggers reply.
 * Uses Reanimated 3 (worklet) + GestureDetector.
 *
 * Rules:
 *  – Swipe < 64 px → snaps back
 *  – Swipe ≥ 64 px → snaps to hint position, calls onReply(), then snaps back
 *  – useReduceMotion() → skip all spring/timing animations
 */
import React, { useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '../theme/ThemeContext';

const REPLY_THRESHOLD = 64;
const HINT_WIDTH = 56;

interface Props {
  children: React.ReactNode;
  onDelete: () => void;
  onReply?: () => void;
  /** If true the row is not swipeable (e.g. deleted/tombstone bubbles). */
  disabled?: boolean;
}

export function SwipeableMessage({ children, onDelete: _onDelete, onReply, disabled }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const translateX = useSharedValue(0);
  const reduceMotion = useReducedMotion() ?? false;

  const triggerReply = useCallback(() => {
    onReply?.();
  }, [onReply]);

  const snapBack = useCallback(() => {
    translateX.value = reduceMotion ? 0 : withSpring(0, { damping: 20, stiffness: 200 });
  }, [translateX, reduceMotion]);

  const panGesture = Gesture.Pan()
    .enabled(!disabled)
    .activeOffsetX([-10, 10])
    .failOffsetY([-15, 15])
    .onUpdate((e) => {
      // Only allow left swipe (negative translation), clamp at -HINT_WIDTH * 1.5
      translateX.value = Math.max(-HINT_WIDTH * 1.5, Math.min(0, e.translationX));
    })
    .onEnd((e) => {
      const committed = e.translationX <= -REPLY_THRESHOLD;
      if (committed) {
        // Snap to hint, fire reply, then snap back
        translateX.value = reduceMotion
          ? -HINT_WIDTH
          : withSpring(-HINT_WIDTH, { damping: 18, stiffness: 220 });
        runOnJS(triggerReply)();
        // Snap back after a short visual pause
        setTimeout(() => {
          runOnJS(snapBack)();
        }, 300);
      } else {
        translateX.value = reduceMotion ? 0 : withSpring(0, { damping: 20, stiffness: 200 });
      }
    });

  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const hintOpacity = useAnimatedStyle(() => {
    const progress = Math.min(1, -translateX.value / HINT_WIDTH);
    return { opacity: progress };
  });

  return (
    <View style={styles.container}>
      {/* Reply hint revealed behind the bubble */}
      <Animated.View style={[styles.replyHint, hintOpacity, { backgroundColor: t.accent }]}>
        {/* Curved reply arrow using Unicode */}
        <Text style={[styles.replyIcon, { color: t.accentInk }]}>
          {i18nT('chat.replyIcon', '↩')}
        </Text>
      </Animated.View>

      {/* Swipeable row */}
      <GestureDetector gesture={panGesture}>
        <Animated.View style={rowStyle}>{children}</Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
  replyHint: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: HINT_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
  replyIcon: {
    fontSize: 22,
    fontWeight: '700',
  },
});
