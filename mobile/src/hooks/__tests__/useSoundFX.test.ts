/**
 * Tests for SoundFX — verifies graceful degradation and API surface.
 *
 * All native modules (expo-av, expo-haptics, react-native AccessibilityInfo)
 * are mocked so these tests run without a device or simulator.
 */

import { AccessibilityInfo } from 'react-native';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPlayAsync = jest.fn().mockResolvedValue(undefined);
const mockStopAsync = jest.fn().mockResolvedValue(undefined);
const mockUnloadAsync = jest.fn().mockResolvedValue(undefined);
const mockSetPositionAsync = jest.fn().mockResolvedValue(undefined);
const mockSetIsLoopingAsync = jest.fn().mockResolvedValue(undefined);
const mockCreateAsync = jest.fn().mockResolvedValue({
  sound: {
    playAsync: mockPlayAsync,
    stopAsync: mockStopAsync,
    unloadAsync: mockUnloadAsync,
    setPositionAsync: mockSetPositionAsync,
    setIsLoopingAsync: mockSetIsLoopingAsync,
  },
});
const mockSetAudioModeAsync = jest.fn().mockResolvedValue(undefined);

jest.mock('expo-av', () => ({
  Audio: {
    Sound: { createAsync: mockCreateAsync },
    setAudioModeAsync: mockSetAudioModeAsync,
  },
}));

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'light', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success' },
}), { virtual: true });

// Silence metro require errors for mp3 assets in the test environment
jest.mock(
  '../../assets/sounds/msg_sent.mp3',
  () => 1,
  { virtual: true },
);
jest.mock(
  '../../assets/sounds/msg_received.mp3',
  () => 2,
  { virtual: true },
);
jest.mock(
  '../../assets/sounds/call_incoming.mp3',
  () => 3,
  { virtual: true },
);
jest.mock(
  '../../assets/sounds/call_connected.mp3',
  () => 4,
  { virtual: true },
);
jest.mock(
  '../../assets/sounds/call_ended.mp3',
  () => 5,
  { virtual: true },
);
jest.mock(
  '../../assets/sounds/call_ringback.mp3',
  () => 6,
  { virtual: true },
);

// ─── Tests ────────────────────────────────────────────────────────────────────

// Import AFTER mocks are registered
import { SoundFX } from '../useSoundFX';

describe('SoundFX', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Restore default resolved values after clearAllMocks wipes them
    mockPlayAsync.mockResolvedValue(undefined);
    mockStopAsync.mockResolvedValue(undefined);
    mockUnloadAsync.mockResolvedValue(undefined);
    mockSetPositionAsync.mockResolvedValue(undefined);
    mockSetIsLoopingAsync.mockResolvedValue(undefined);
    mockCreateAsync.mockResolvedValue({
      sound: {
        playAsync: mockPlayAsync,
        stopAsync: mockStopAsync,
        unloadAsync: mockUnloadAsync,
        setPositionAsync: mockSetPositionAsync,
        setIsLoopingAsync: mockSetIsLoopingAsync,
      },
    });
    mockSetAudioModeAsync.mockResolvedValue(undefined);
    // Default: reduce motion is OFF (normal operation)
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
  });

  // ── 1. Graceful degradation when expo-av throws ───────────────────────────

  it('SoundFX.msgSent() resolves without throwing when Audio.Sound.createAsync rejects', async () => {
    mockCreateAsync.mockRejectedValueOnce(new Error('file not found'));

    // Must not throw — graceful degradation is the contract
    await expect(SoundFX.msgSent()).resolves.toBeUndefined();
  });

  // ── 2. stopAll() is safe when no sounds are cached ────────────────────────

  it('SoundFX.stopAll() resolves without throwing when cache is empty', async () => {
    // Force a fresh module state by ensuring no sounds are loaded yet.
    // stopAll iterates soundCache; if empty it should return immediately.
    await expect(SoundFX.stopAll()).resolves.toBeUndefined();
  });

  // ── 3. API surface — all expected methods are exported ───────────────────

  it('exports all required methods', () => {
    const expectedMethods: Array<keyof typeof SoundFX> = [
      'msgSent',
      'msgReceived',
      'callIncoming',
      'callConnected',
      'callEnded',
      'stopAll',
    ];

    for (const method of expectedMethods) {
      expect(typeof SoundFX[method]).toBe('function');
    }
  });

  // ── 4. callRingback is defined ────────────────────────────────────────────

  it('SoundFX.callRingback is defined as a function', () => {
    expect(typeof SoundFX.callRingback).toBe('function');
  });

  // ── 5. callRingback resolves without throwing (graceful degradation like other sounds) ──

  it('SoundFX.callRingback() resolves without throwing when sound cannot be loaded', async () => {
    // Graceful degradation: even if the audio system is unavailable (as it is
    // in the test environment where expo-av mock may not fully initialise),
    // callRingback must NOT throw.
    await expect(SoundFX.callRingback()).resolves.toBeUndefined();
  });

  // ── 6. All sound keys include 'call_ringback' ─────────────────────────────

  it('callRingback resolves without throwing even when createAsync rejects', async () => {
    mockCreateAsync.mockRejectedValueOnce(new Error('asset missing'));
    await expect(SoundFX.callRingback()).resolves.toBeUndefined();
  });
});
