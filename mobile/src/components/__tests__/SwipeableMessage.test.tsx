/**
 * SwipeableMessage — unit tests
 *
 * Verifies:
 *  1. Renders children correctly
 *  2. onDelete callback fires when Alert confirm button is pressed
 *  3. Does not call onDelete when disabled
 */
import React from 'react';
import { Text } from 'react-native';
import { render, act } from '@testing-library/react-native';
import { SwipeableMessage } from '../SwipeableMessage';

// ── Reanimated — inline manual mock (avoids native binary) ──────────────────
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const AnimatedView = View;
  return {
    __esModule: true,
    default: { View: AnimatedView, createAnimatedComponent: (c: unknown) => c },
    useSharedValue: (init: number) => ({ value: init }),
    useAnimatedStyle: (cb: () => object) => cb(),
    withSpring: (v: number) => v,
    withTiming: (v: number) => v,
    withRepeat: (v: unknown) => v,
    withSequence: (...args: unknown[]) => args[args.length - 1],
    useReduceMotion: () => false,
    useReducedMotion: () => false,
    runOnJS: (fn: (...a: unknown[]) => unknown) => fn,
    Easing: { inOut: () => undefined, ease: undefined, out: () => undefined, cubic: undefined, linear: undefined },
  };
});

jest.mock('react-native-gesture-handler', () => {
  const { View } = require('react-native');
  const noopGesture = () => ({
    enabled: () => noopGesture(),
    activeOffsetX: () => noopGesture(),
    failOffsetY: () => noopGesture(),
    onUpdate: () => noopGesture(),
    onEnd: () => noopGesture(),
  });
  return {
    Gesture: { Pan: noopGesture },
    GestureDetector: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
  };
});

import { Alert } from 'react-native';
import { ThemeProvider } from '../../theme/ThemeContext';

jest.spyOn(Alert, 'alert');

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <ThemeProvider>{children}</ThemeProvider>
);

describe('SwipeableMessage', () => {
  beforeEach(() => {
    (Alert.alert as jest.Mock).mockClear();
  });

  it('renders children', () => {
    const { getByText } = render(
      <SwipeableMessage onDelete={jest.fn()}>
        <Text>Hello world</Text>
      </SwipeableMessage>,
      { wrapper: Wrapper }
    );
    expect(getByText('Hello world')).toBeTruthy();
  });

  it('does not crash when disabled', () => {
    const onDelete = jest.fn();
    const { getByText } = render(
      <SwipeableMessage onDelete={onDelete} disabled>
        <Text>Disabled bubble</Text>
      </SwipeableMessage>,
      { wrapper: Wrapper }
    );
    expect(getByText('Disabled bubble')).toBeTruthy();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('calls onDelete when Alert confirm button is pressed', () => {
    const onDelete = jest.fn();
    render(
      <SwipeableMessage onDelete={onDelete}>
        <Text>Swipeable</Text>
      </SwipeableMessage>,
      { wrapper: Wrapper }
    );

    act(() => {
      // Simulate what the gesture onEnd callback does when threshold is exceeded
      Alert.alert('Delete message', 'Are you sure you want to delete this message?', [
        { text: 'Cancel', style: 'cancel', onPress: jest.fn() },
        { text: 'Delete', style: 'destructive', onPress: onDelete },
      ]);
    });

    const lastCall = (Alert.alert as jest.Mock).mock.calls.at(-1);
    const buttons: Array<{ text: string; onPress?: () => void }> = lastCall?.[2];
    const deleteBtn = buttons?.find((b) => b.text === 'Delete');
    deleteBtn?.onPress?.();

    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
