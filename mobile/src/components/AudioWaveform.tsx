/**
 * AudioWaveform — animated waveform bar visualiser for audio bubbles.
 *
 * - 30 bars, heights seeded from durMs (deterministic, not random)
 * - Bars left of playhead: t.accent
 * - Bars right of playhead: t.border
 * - Tap a bar position to seek
 */

import { useRef, useCallback } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import type { ViewStyle } from 'react-native';
import type { Theme } from '../theme/vault';

const BAR_COUNT = 30;
const BAR_GAP = 2;

/** Deterministic pseudo-random height (0-1) for bar i given a seed. */
function barHeight(seed: number, i: number): number {
  // Cheap LCG-style hash, no external deps
  const h = Math.abs(Math.sin(seed * 9301 + i * 49297 + 233280) * 233280);
  const normalised = (h % 1000) / 1000;
  // Clamp to [0.18, 1] so no bar is invisible
  return 0.18 + normalised * 0.82;
}

interface Props {
  /** Duration in milliseconds — used as waveform seed */
  durMs: number;
  /** Current playback position in milliseconds */
  posMs: number;
  /** Total container width in dp */
  width: number;
  /** Maximum bar height in dp */
  maxBarHeight?: number;
  /** Called with the seek position in milliseconds when user taps */
  onSeek?: (posMs: number) => void;
  t: Theme;
  style?: ViewStyle;
  /** Whether the bubble is "me" (outgoing) — affects colours */
  isMe?: boolean;
}

export function AudioWaveform({
  durMs,
  posMs,
  width,
  maxBarHeight = 28,
  onSeek,
  t,
  style,
  isMe = false,
}: Props) {
  const containerRef = useRef<View>(null);

  // Pre-compute bar heights (stable across renders — only depends on durMs)
  const seed = durMs > 0 ? durMs : 1;
  const heights = Array.from({ length: BAR_COUNT }, (_, i) => barHeight(seed, i));

  const progress = durMs > 0 ? Math.min(1, posMs / durMs) : 0;
  const filledBars = Math.round(progress * BAR_COUNT);

  const barWidth = Math.max(2, (width - BAR_GAP * (BAR_COUNT - 1)) / BAR_COUNT);

  const handlePress = useCallback(
    (barIndex: number) => {
      if (!onSeek || durMs <= 0) return;
      const seekMs = Math.round((barIndex / BAR_COUNT) * durMs);
      onSeek(seekMs);
    },
    [onSeek, durMs],
  );

  return (
    <View
      ref={containerRef}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'flex-end',
          width,
          height: maxBarHeight,
          gap: BAR_GAP,
        },
        style,
      ]}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
    >
      {heights.map((h, i) => {
        const filled = i < filledBars;
        const barH = Math.max(3, h * maxBarHeight);
        const color = filled
          ? isMe
            ? 'rgba(255,255,255,0.9)'
            : t.accent
          : isMe
            ? 'rgba(255,255,255,0.28)'
            : t.border;

        return (
          <Pressable
            key={i}
            accessibilityLabel={`Seek to position ${i + 1} of ${BAR_COUNT}`}
            onPress={() => handlePress(i)}
            hitSlop={4}
            style={{ width: barWidth, height: maxBarHeight, justifyContent: 'flex-end' }}
          >
            <View
              style={{
                width: barWidth,
                height: barH,
                borderRadius: 2,
                backgroundColor: color,
              }}
            />
          </Pressable>
        );
      })}
    </View>
  );
}
