/**
 * SwipeableMessage
 * Wraps a single chat bubble with a swipe-left gesture that reveals a
 * "Delete" action button. Uses Reanimated 3 (worklet) + GestureDetector.
 *
 * Rules:
 *  – Swipe < 80 px → snaps back
 *  – Swipe ≥ 80 px → Alert.alert confirmation, then onDelete()
 *  – useReduceMotion() → skip all spring/timing animations
 */
import React, { useCallback } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
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

const DELETE_THRESHOLD = 80;
const DELETE_BTN_WIDTH = 80;

interface Props {
  children: React.ReactNode;
  onDelete: () => void;
  /** If true the row is not swipeable (e.g. deleted/tombstone bubbles). */
  disabled?: boolean;
}

export function SwipeableMessage({ children, onDelete, disabled }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const translateX = useSharedValue(0);
  const reduceMotion = useReducedMotion() ?? false;

  const showConfirm = useCallback(() => {
    Alert.alert(
      i18nT('chat.deleteMessageTitle', 'Delete message'),
      i18nT('chat.deleteMessageConfirm', 'Are you sure you want to delete this message?'),
      [
        {
          text: i18nT('common.cancel', 'Cancel'),
          style: 'cancel',
          onPress: () => {
            translateX.value = reduceMotion ? 0 : withSpring(0);
          },
        },
        {
          text: i18nT('chat.delete', 'Delete'),
          style: 'destructive',
          onPress: () => {
            translateX.value = reduceMotion ? 0 : withTiming(0, { duration: 200 });
            onDelete();
          },
        },
      ]
    );
  }, [onDelete, translateX, reduceMotion, i18nT]);

  const panGesture = Gesture.Pan()
    .enabled(!disabled)
    .activeOffsetX([-10, 10])
    .failOffsetY([-15, 15])
    .onUpdate((e) => {
      // Only allow left swipe (negative translation)
      const clampedX = Math.min(0, e.translationX);
      if (reduceMotion) {
        translateX.value = clampedX;
      } else {
        translateX.value = clampedX;
      }
    })
    .onEnd((e) => {
      const committed = e.translationX <= -DELETE_THRESHOLD;
      if (committed) {
        // Snap to reveal the delete button, then wait for user confirmation
        translateX.value = reduceMotion
          ? -DELETE_BTN_WIDTH
          : withSpring(-DELETE_BTN_WIDTH, { damping: 20, stiffness: 200 });
        runOnJS(showConfirm)();
      } else {
        translateX.value = reduceMotion ? 0 : withSpring(0, { damping: 20, stiffness: 200 });
      }
    });

  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const btnOpacity = useAnimatedStyle(() => {
    const progress = Math.min(1, -translateX.value / DELETE_BTN_WIDTH);
    return { opacity: progress };
  });

  return (
    <View style={styles.container}>
      {/* Delete button revealed behind the bubble */}
      <Animated.View style={[styles.deleteBtn, btnOpacity, { backgroundColor: t.danger }]}>
        <Text style={[styles.deleteBtnText, { fontFamily: t.font }]}>
          {i18nT('chat.delete', 'Delete')}
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
  deleteBtn: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: DELETE_BTN_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
  deleteBtnText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 13,
  },
});
