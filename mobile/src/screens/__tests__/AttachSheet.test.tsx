/**
 * AttachSheetScreen — unit tests
 *
 * Verifies:
 *  1.  Renders without crashing
 *  2.  Renders a back button (Pressable with onPress=onBack)
 *  3.  handlePhoto happy path: manipulateAsync called with original URI
 *  4.  handlePhoto happy path: setPendingMedia called with processed URI (not original)
 *  5.  handlePhoto happy path: onBack called after success
 *  6.  handlePhoto: permission denied → setPendingMedia NOT called
 *  7.  handlePhoto: permission denied → onBack NOT called
 *  8.  handlePhoto: manipulateAsync throws → setPendingMedia NOT called (fail-closed)
 *  9.  handlePhoto: picker canceled → setPendingMedia NOT called
 *  10. handleCamera happy path: setPendingMedia called with processed URI
 *  11. handleCamera: permission denied → setPendingMedia NOT called
 *  12. Pressing file button calls onPick('file')
 *  13. Voice/audio option is NOT rendered (voice notes now use the
 *      composer's inline mic button — see AttachSheet.tsx comment)
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync } from 'expo-image-manipulator';

// ── safe-area-context ──────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ── react-i18next ──────────────────────────────────────────────────────────
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// ── ThemeContext ───────────────────────────────────────────────────────────
jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000',
      surface: '#111',
      surface2: '#222',
      surface3: '#333',
      text: '#fff',
      textDim: '#aaa',
      textFaint: '#666',
      accent: '#05b875',
      accentDeep: '#0a2e1e',
      accentInk: '#000',
      danger: '#e63946',
      warn: '#f59e0b',
      border: '#222',
      borderStrong: '#333',
      divider: '#1a1a1a',
      bubbleIn: '#222',
      bubbleInText: '#fff',
      bubbleOut: '#05b875',
      bubbleOutText: '#000',
      radius: 12,
      radiusS: 8,
      radiusL: 20,
      font: 'System',
      fontMono: 'monospace',
      fontDisplay: 'System',
      dark: true,
    },
  }),
}));

// ── icons ──────────────────────────────────────────────────────────────────
jest.mock('../../components/icons', () => ({
  I: new Proxy({}, { get: () => () => null }),
}));

// ── TopBar — render left prop so the back Pressable appears in the tree ────
jest.mock('../../components/TopBar', () => ({
  TopBar: ({ title, left }: { title: string; left?: import('react').ReactNode }) => {
    const React = require('react') as typeof import('react');
    const { View, Text } = require('react-native') as typeof import('react-native');
    return React.createElement(View, null, left, React.createElement(Text, null, title));
  },
}));

// ── expo-image-picker ──────────────────────────────────────────────────────
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  MediaType: { Images: 'images' },
}));

// ── expo-image-manipulator ─────────────────────────────────────────────────
jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: jest.fn(),
  SaveFormat: { JPEG: 'jpeg' },
}));

// ── pickingGuard — execute fn() directly (no lock-screen side-effects) ─────
jest.mock('../../utils/pickingGuard', () => ({
  withPickingGuard: jest.fn((fn: () => unknown) => fn()),
}));

// ── messages store ─────────────────────────────────────────────────────────
const mockSetPendingMedia = jest.fn();

jest.mock('../../store/messages', () => ({
  useMessages: jest.fn((sel: (s: unknown) => unknown) =>
    sel({ setPendingMedia: mockSetPendingMedia })
  ),
}));

// ── Subject under test (imported AFTER all mocks) ─────────────────────────
import { AttachSheetScreen } from '../AttachSheet';

// ── Shared test helpers ────────────────────────────────────────────────────
const ORIGINAL_URI = 'file://original.jpg';
const PROCESSED_URI = 'file://processed.jpg';

describe('AttachSheetScreen', () => {
  const onBack = jest.fn();
  const onPick = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    // Default happy-path setup for photo flow
    (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
    (ImagePicker.requestCameraPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ uri: ORIGINAL_URI }],
    });
    (ImagePicker.launchCameraAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ uri: ORIGINAL_URI }],
    });
    (manipulateAsync as jest.Mock).mockResolvedValue({ uri: PROCESSED_URI });
  });

  // ── 1. Renders without crashing ─────────────────────────────────────────
  it('renders without crashing', () => {
    const { toJSON } = render(<AttachSheetScreen onBack={onBack} onPick={onPick} />);
    expect(toJSON()).toBeTruthy();
  });

  // ── 2. Renders a back button ─────────────────────────────────────────────
  //       The back Pressable has onPress={onBack} and hitSlop={8}.
  //       UNSAFE_getAllByProps queries by prop values regardless of type identity.
  it('renders a back button (Pressable with onPress=onBack)', () => {
    const { UNSAFE_getAllByProps } = render(
      <AttachSheetScreen onBack={onBack} onPick={onPick} />
    );
    const backBtns = UNSAFE_getAllByProps({ onPress: onBack });
    expect(backBtns.length).toBeGreaterThanOrEqual(1);
  });

  // ── 3. handlePhoto happy path: manipulateAsync called with original URI ──
  it('calls manipulateAsync with the original URI when gallery permission is granted', async () => {
    const { getByText } = render(<AttachSheetScreen onBack={onBack} onPick={onPick} />);
    fireEvent.press(getByText('attachSheet.photo'));
    await waitFor(() => {
      expect(manipulateAsync).toHaveBeenCalledWith(
        ORIGINAL_URI,
        [{ resize: { width: 1280 } }],
        { compress: 0.85, format: 'jpeg' }
      );
    });
  });

  // ── 4. handlePhoto happy path: setPendingMedia called with processed URI ─
  it('calls setPendingMedia with the processed URI (not the original)', async () => {
    const { getByText } = render(<AttachSheetScreen onBack={onBack} onPick={onPick} />);
    fireEvent.press(getByText('attachSheet.photo'));
    await waitFor(() => {
      expect(mockSetPendingMedia).toHaveBeenCalledWith(PROCESSED_URI);
      expect(mockSetPendingMedia).not.toHaveBeenCalledWith(ORIGINAL_URI);
    });
  });

  // ── 5. handlePhoto happy path: onBack called after success ───────────────
  it('calls onBack() after a successful photo pick', async () => {
    const { getByText } = render(<AttachSheetScreen onBack={onBack} onPick={onPick} />);
    fireEvent.press(getByText('attachSheet.photo'));
    await waitFor(() => {
      expect(onBack).toHaveBeenCalledTimes(1);
    });
  });

  // ── 6. handlePhoto: permission denied → setPendingMedia NOT called ────────
  it('does NOT call setPendingMedia when gallery permission is denied', async () => {
    (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
    const { getByText } = render(<AttachSheetScreen onBack={onBack} onPick={onPick} />);
    fireEvent.press(getByText('attachSheet.photo'));
    await waitFor(() => {
      expect(mockSetPendingMedia).not.toHaveBeenCalled();
    });
  });

  // ── 7. handlePhoto: permission denied → onBack NOT called ────────────────
  it('does NOT call onBack() when gallery permission is denied', async () => {
    (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
    const { getByText } = render(<AttachSheetScreen onBack={onBack} onPick={onPick} />);
    fireEvent.press(getByText('attachSheet.photo'));
    await waitFor(() => {
      expect(onBack).not.toHaveBeenCalled();
    });
  });

  // ── 8. handlePhoto: manipulateAsync throws → setPendingMedia NOT called ──
  //       (fail-closed: never return original URI with EXIF intact)
  it('does NOT call setPendingMedia when stripExif (manipulateAsync) throws — fail-closed', async () => {
    (manipulateAsync as jest.Mock).mockRejectedValue(new Error('manipulate failed'));
    const { getByText } = render(<AttachSheetScreen onBack={onBack} onPick={onPick} />);
    fireEvent.press(getByText('attachSheet.photo'));
    await waitFor(() => {
      expect(mockSetPendingMedia).not.toHaveBeenCalledWith(ORIGINAL_URI);
      expect(mockSetPendingMedia).not.toHaveBeenCalled();
    });
  });

  // ── 9. handlePhoto: picker canceled → setPendingMedia NOT called ──────────
  it('does NOT call setPendingMedia when the image picker is canceled', async () => {
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({ canceled: true, assets: [] });
    const { getByText } = render(<AttachSheetScreen onBack={onBack} onPick={onPick} />);
    fireEvent.press(getByText('attachSheet.photo'));
    await waitFor(() => {
      expect(mockSetPendingMedia).not.toHaveBeenCalled();
    });
  });

  // ── 10. handleCamera happy path: setPendingMedia called with processed URI
  it('calls setPendingMedia with the processed URI after a successful camera capture', async () => {
    const { getByText } = render(<AttachSheetScreen onBack={onBack} onPick={onPick} />);
    fireEvent.press(getByText('attachSheet.camera'));
    await waitFor(() => {
      expect(mockSetPendingMedia).toHaveBeenCalledWith(PROCESSED_URI);
      expect(mockSetPendingMedia).not.toHaveBeenCalledWith(ORIGINAL_URI);
    });
  });

  // ── 11. handleCamera: permission denied → setPendingMedia NOT called ──────
  it('does NOT call setPendingMedia when camera permission is denied', async () => {
    (ImagePicker.requestCameraPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
    const { getByText } = render(<AttachSheetScreen onBack={onBack} onPick={onPick} />);
    fireEvent.press(getByText('attachSheet.camera'));
    await waitFor(() => {
      expect(mockSetPendingMedia).not.toHaveBeenCalled();
    });
  });

  // ── 12. Pressing file button calls onPick('file') ─────────────────────────
  it("calls onPick('file') when the file button is pressed", () => {
    const { getByText } = render(<AttachSheetScreen onBack={onBack} onPick={onPick} />);
    fireEvent.press(getByText('attachSheet.file'));
    expect(onPick).toHaveBeenCalledWith('file');
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  // ── 13. Voice/audio option is NOT rendered ────────────────────────────────
  //        Voice notes are now sent from the inline mic button in the chat
  //        composer (reactive, hides while typing), so the attach sheet no
  //        longer offers a 'voice'/'audio' tile.
  it("does NOT render a voice/audio option", () => {
    const { queryByText } = render(<AttachSheetScreen onBack={onBack} onPick={onPick} />);
    expect(queryByText('attachSheet.audio')).toBeNull();
    expect(queryByText('attachSheet.voice')).toBeNull();
  });
});
