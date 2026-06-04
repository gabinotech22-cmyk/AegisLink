/**
 * useSoundFX — in-app sound + haptic feedback for AegisLink
 *
 * Design goals:
 * - Lazy-initialised: sounds are loaded once on first use, not at import time
 * - Graceful degradation: any load/play failure is swallowed silently in
 *   production (only warned in __DEV__ mode)
 * - Reduce-motion aware: when AccessibilityInfo.isReduceMotionEnabled() is
 *   true the audio is suppressed and only a light haptic is emitted
 * - Android audio focus: staysActiveInBackground: false so we never steal
 *   audio focus from music apps
 * - expo-haptics is loaded dynamically (optional peer dep); falls back to
 *   react-native Vibration when unavailable
 */

import { AccessibilityInfo, Vibration } from 'react-native';
import { Audio } from 'expo-av';

// ─── Haptics helper ───────────────────────────────────────────────────────────

type HapticStyle = 'light' | 'heavy';
type HapticNotification = 'success';

function hapticImpact(style: HapticStyle): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Haptics = require('expo-haptics') as {
      impactAsync: (s: unknown) => Promise<void>;
      ImpactFeedbackStyle: { Light: unknown; Heavy: unknown };
    };
    const s = style === 'heavy'
      ? Haptics.ImpactFeedbackStyle.Heavy
      : Haptics.ImpactFeedbackStyle.Light;
    void Haptics.impactAsync(s).catch(() => {});
  } catch {
    // expo-haptics not installed — fall back to Vibration
    Vibration.vibrate(style === 'heavy' ? 40 : 10);
  }
}

function hapticNotification(type: HapticNotification): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Haptics = require('expo-haptics') as {
      notificationAsync: (t: unknown) => Promise<void>;
      NotificationFeedbackType: { Success: unknown };
    };
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  } catch {
    Vibration.vibrate(type === 'success' ? [0, 10, 50, 10] : [0, 30]);
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

type SoundKey =
  | 'msg_sent'
  | 'msg_received'
  | 'call_incoming'
  | 'call_ringback'
  | 'call_connected'
  | 'call_ended';

// ─── Asset resolver ───────────────────────────────────────────────────────────

function getAsset(key: SoundKey): number | null {
  // Metro bundler resolves require() statically; the files may not exist in
  // dev/CI environments, so we catch the error and return null gracefully.
  try {
    switch (key) {
      case 'msg_sent':
        return require('../../assets/sounds/msg_sent.mp3') as number;
      case 'msg_received':
        return require('../../assets/sounds/msg_received.mp3') as number;
      case 'call_incoming':
        return require('../../assets/sounds/call_incoming.mp3') as number;
      case 'call_ringback':
        return require('../../assets/sounds/call_ringback.mp3') as number;
      case 'call_connected':
        return require('../../assets/sounds/call_connected.mp3') as number;
      case 'call_ended':
        return require('../../assets/sounds/call_ended.mp3') as number;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ─── Lazy sound cache ─────────────────────────────────────────────────────────

const soundCache = new Map<SoundKey, Audio.Sound>();
let audioModeReady = false;

async function ensureAudioMode(): Promise<void> {
  if (audioModeReady) return;
  try {
    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: false,
      staysActiveInBackground: false,
      allowsRecordingIOS: false,
    });
    audioModeReady = true;
  } catch (e) {
    if (__DEV__) console.warn('[SoundFX] setAudioModeAsync failed:', e);
  }
}

async function loadSound(key: SoundKey): Promise<Audio.Sound | null> {
  if (soundCache.has(key)) return soundCache.get(key) ?? null;

  const asset = getAsset(key);
  if (asset === null) return null;

  try {
    const { sound } = await Audio.Sound.createAsync(asset, { shouldPlay: false });
    soundCache.set(key, sound);
    return sound;
  } catch (e) {
    if (__DEV__) console.warn(`[SoundFX] Could not load sound "${key}":`, e);
    return null;
  }
}

async function playSound(key: SoundKey, loop = false): Promise<void> {
  await ensureAudioMode();

  const cached = soundCache.get(key);
  if (cached) {
    try {
      await cached.stopAsync();
      await cached.setPositionAsync(0);
      await cached.setIsLoopingAsync(loop);
      await cached.playAsync();
      return;
    } catch {
      soundCache.delete(key);
    }
  }

  const sound = await loadSound(key);
  if (!sound) return;

  try {
    await sound.setIsLoopingAsync(loop);
    await sound.playAsync();
  } catch (e) {
    if (__DEV__) console.warn(`[SoundFX] Could not play sound "${key}":`, e);
  }
}

async function isReduceMotionEnabled(): Promise<boolean> {
  try {
    return await AccessibilityInfo.isReduceMotionEnabled();
  } catch {
    return false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * SoundFX — singleton object with one method per in-app audio event.
 *
 * Import and call directly — no hook setup required:
 *   import { SoundFX } from '../hooks/useSoundFX';
 *   await SoundFX.msgSent();
 */
export const SoundFX = {
  /** Short bip confirming a message was queued for delivery. */
  async msgSent(): Promise<void> {
    const reduced = await isReduceMotionEnabled();
    hapticImpact('light');
    if (reduced) return;
    await playSound('msg_sent');
  },

  /** Soft tone on incoming message. */
  async msgReceived(): Promise<void> {
    const reduced = await isReduceMotionEnabled();
    hapticNotification('success');
    if (reduced) return;
    await playSound('msg_received');
  },

  /** Looping ringback tone while the outgoing call waits for the other party to answer. */
  async callRingback(): Promise<void> {
    const reduced = await isReduceMotionEnabled();
    hapticImpact('light');
    if (reduced) return;
    await playSound('call_ringback', /* loop */ true);
  },

  /** Looping ring for an incoming call. */
  async callIncoming(): Promise<void> {
    const reduced = await isReduceMotionEnabled();
    hapticImpact('heavy');
    if (reduced) return;
    await playSound('call_incoming', /* loop */ true);
  },

  /** Short chord played when the call is answered and media is flowing. */
  async callConnected(): Promise<void> {
    const reduced = await isReduceMotionEnabled();
    hapticImpact('light');
    await SoundFX.stopAll();
    if (reduced) return;
    await playSound('call_connected');
  },

  /** Descending tone played when the call is terminated or declined. */
  async callEnded(): Promise<void> {
    const reduced = await isReduceMotionEnabled();
    hapticNotification('success');
    await SoundFX.stopAll();
    if (reduced) return;
    await playSound('call_ended');
  },

  /** Stop all currently playing sounds. Safe when no sounds are loaded. */
  async stopAll(): Promise<void> {
    const keys = Array.from(soundCache.keys());
    await Promise.all(
      keys.map(async (key) => {
        const sound = soundCache.get(key);
        if (!sound) return;
        try {
          await sound.stopAsync();
          await sound.setPositionAsync(0);
          await sound.setIsLoopingAsync(false);
        } catch {
          // Sound may already be unloaded — ignore
        }
      })
    );
  },
} as const;
