/**
 * VoiceRecorderScreen — recorder lifecycle regression tests
 *
 * Reproduces the production bug "Only one Recording object can be prepared at a
 * given time": expo-av allows a single prepared Audio.Recording per process, so
 * an orphan left by a previous mount must be released before preparing a new one.
 *
 * Covers:
 *  1. Remount after recording releases the orphan (stopAndUnloadAsync) before the
 *     second prepareToRecordAsync.
 *  2. Double-tap on the record button does not fire two prepareToRecordAsync.
 */

import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';

// ── i18n: return the fallback string ─────────────────────────────────────────
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fb?: string) => fb ?? _k }),
}));

// ── theme ─────────────────────────────────────────────────────────────────────
jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000', text: '#fff', textDim: '#aaa', textFaint: '#555', surface2: '#222',
      surface3: '#333', accent: '#00FF88', accentInk: '#000', danger: '#e63946',
      borderStrong: '#555', font: 'System', fontMono: 'monospace',
    },
  }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../components/icons', () => ({
  I: new Proxy({}, { get: () => () => null }),
}));

jest.mock('../../components/TopBar', () => ({ TopBar: () => null }));

// ── expo-av: track every Recording instance created ───────────────────────────
const recordingInstances: Array<{
  prepareToRecordAsync: jest.Mock;
  startAsync: jest.Mock;
  stopAndUnloadAsync: jest.Mock;
  getURI: jest.Mock;
  getStatusAsync: jest.Mock;
}> = [];

jest.mock('expo-av', () => {
  const makeRecording = () => {
    const inst = {
      prepareToRecordAsync: jest.fn().mockResolvedValue(undefined),
      startAsync: jest.fn().mockResolvedValue(undefined),
      stopAndUnloadAsync: jest.fn().mockResolvedValue(undefined),
      getURI: jest.fn().mockReturnValue('file:///rec.m4a'),
      getStatusAsync: jest.fn().mockResolvedValue({ isRecording: true, durationMillis: 1000, metering: -20 }),
    };
    recordingInstances.push(inst);
    return inst;
  };
  return {
    Audio: {
      requestPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
      setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
      Recording: jest.fn().mockImplementation(makeRecording),
      RecordingOptionsPresets: { HIGH_QUALITY: {} },
      Sound: { createAsync: jest.fn() },
    },
    ResizeMode: { CONTAIN: 'contain' },
  };
});

import { VoiceRecorderScreen } from '../VoiceRecorder';

beforeEach(() => {
  jest.clearAllMocks();
  recordingInstances.length = 0;
});

describe('VoiceRecorderScreen — recorder lifecycle', () => {
  it('releases an orphaned recorder on remount before preparing a new one', async () => {
    // First mount → start recording (creates recorder #0, leaves it active)
    const first = render(<VoiceRecorderScreen onBack={jest.fn()} onSend={jest.fn()} />);
    await act(async () => {
      fireEvent.press(first.getByLabelText('Grabar nota de voz'));
    });
    await waitFor(() => expect(recordingInstances.length).toBe(1));
    expect(recordingInstances[0].prepareToRecordAsync).toHaveBeenCalledTimes(1);

    // Unmount WITHOUT stopping — simulates the Modal closing mid-recording,
    // leaving recorder #0 orphaned at the module level.
    first.unmount();

    // Second mount → start recording again. The orphan (#0) must be released
    // (stopAndUnloadAsync) before recorder #1 is prepared.
    const second = render(<VoiceRecorderScreen onBack={jest.fn()} onSend={jest.fn()} />);
    await act(async () => {
      fireEvent.press(second.getByLabelText('Grabar nota de voz'));
    });

    await waitFor(() => expect(recordingInstances.length).toBe(2));
    // The orphan was torn down…
    expect(recordingInstances[0].stopAndUnloadAsync).toHaveBeenCalled();
    // …and the fresh recorder prepared successfully.
    expect(recordingInstances[1].prepareToRecordAsync).toHaveBeenCalledTimes(1);

    second.unmount();
  });

  it('double-tap on record does not create two prepared recorders', async () => {
    const { getByLabelText } = render(<VoiceRecorderScreen onBack={jest.fn()} onSend={jest.fn()} />);
    const btn = getByLabelText('Grabar nota de voz');

    // Two synchronous taps before the first start resolves.
    await act(async () => {
      fireEvent.press(btn);
      fireEvent.press(btn);
    });

    await waitFor(() => expect(recordingInstances.length).toBeGreaterThanOrEqual(1));
    // The busy lock must prevent a second concurrent recorder.
    expect(recordingInstances.length).toBe(1);
    expect(recordingInstances[0].prepareToRecordAsync).toHaveBeenCalledTimes(1);
  });
});

// ── iOS audit fix #4: audio session restored after stopping (earpiece-routing
// regression). Without this, sending a note without ever tapping Preview
// leaves allowsRecordingIOS: true for the rest of the app session — all
// later audio (including notification sound FX) routes through the iOS
// earpiece instead of the speaker. ────────────────────────────────────────────
describe('VoiceRecorderScreen — audio session restore (earpiece-routing regression)', () => {
  it('restores allowsRecordingIOS to false after stopRecording, even without previewing', async () => {
    const { getByLabelText } = render(<VoiceRecorderScreen onBack={jest.fn()} onSend={jest.fn()} />);
    await act(async () => {
      fireEvent.press(getByLabelText('Grabar nota de voz'));
    });
    await waitFor(() => expect(recordingInstances.length).toBe(1));

    const { Audio } = require('expo-av') as { Audio: { setAudioModeAsync: jest.Mock } };
    Audio.setAudioModeAsync.mockClear(); // isolate the stop-time call from the start-time call

    await act(async () => {
      fireEvent.press(getByLabelText('Detener grabación'));
    });

    await waitFor(() =>
      expect(Audio.setAudioModeAsync).toHaveBeenCalledWith({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
      }),
    );
  });

  it('restores allowsRecordingIOS to false on unmount mid-recording (back out without stopping)', async () => {
    const { getByLabelText, unmount } = render(<VoiceRecorderScreen onBack={jest.fn()} onSend={jest.fn()} />);
    await act(async () => {
      fireEvent.press(getByLabelText('Grabar nota de voz'));
    });
    await waitFor(() => expect(recordingInstances.length).toBe(1));

    const { Audio } = require('expo-av') as { Audio: { setAudioModeAsync: jest.Mock } };
    Audio.setAudioModeAsync.mockClear();

    unmount();

    await waitFor(() =>
      expect(Audio.setAudioModeAsync).toHaveBeenCalledWith({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
      }),
    );
  });
});
