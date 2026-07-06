/**
 * ProfileScreen — unit tests (B-4: critical screens without coverage)
 *
 * Verifies the behaviours that matter for privacy/UX correctness:
 *  1.  Renders title + the active identity's displayName and aegisId
 *  2.  Shows the "add status" placeholder when profileStatus is empty
 *  3.  Shows the status text when profileStatus is set
 *  4.  Account rows route to the right nav callbacks (keys/devices/appIcon/export/profiles)
 *  5.  "Delete identity" opens a confirm dialog; confirming calls reset()
 *  6.  "Create identity" opens a confirm dialog; confirming calls createSlot()
 *  7.  PhotoVisPicker writes photoVis preference
 *  8.  lastSeen / typing toggles write their preferences (inverting current value)
 *  9.  Back button invokes onBack()
 */

import React from 'react';

// ── AlertHost (themed in-app dialog) ────────────────────────────────────────
jest.mock('../../components/AlertHost', () => ({ themedAlert: jest.fn() }));
import { themedAlert } from '../../components/AlertHost';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

// ── safe-area-context ──────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ── react-i18next — identity translation (key passthrough) ──────────────────
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fallback?: unknown) => (typeof fallback === 'string' ? k : k) }),
}));

// ── ThemeContext ───────────────────────────────────────────────────────────
jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000', surface: '#111', surface2: '#222', surface3: '#333',
      text: '#fff', textDim: '#aaa', textFaint: '#666',
      accent: '#05b875', accentInk: '#000', danger: '#e63946',
      border: '#222', borderStrong: '#333', divider: '#1a1a1a',
      radius: 12, radiusS: 8, radiusL: 20,
      font: 'System', fontMono: 'monospace', fontDisplay: 'System', dark: true,
    },
  }),
}));

// ── icons — every icon renders nothing ──────────────────────────────────────
jest.mock('../../components/icons', () => ({
  I: new Proxy({}, { get: () => () => null }),
}));

// ── expo-file-system legacy (required at module load, unused in render) ──────
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });

// ── expo-image-picker ───────────────────────────────────────────────────────
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  requestCameraPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  launchImageLibraryAsync: jest.fn().mockResolvedValue({ canceled: true }),
  launchCameraAsync: jest.fn().mockResolvedValue({ canceled: true }),
}));

// ── picking guard — pass-through ────────────────────────────────────────────
jest.mock('../../utils/pickingGuard', () => ({ withPickingGuard: (fn: () => unknown) => fn() }));

// ── crypto/qr ───────────────────────────────────────────────────────────────
jest.mock('../../crypto/qr', () => ({ encodeIdentityLink: jest.fn(() => 'aegis://id/link') }));

// ── leaf components we don't exercise here ──────────────────────────────────
jest.mock('../../components/Avatar', () => ({ Avatar: () => null }));
jest.mock('../../components/AvatarCropModal', () => ({ AvatarCropModal: () => null }));
jest.mock('../../components/ShareLinkSheet', () => ({ ShareLinkSheet: () => null }));

// ── TopBar — render `left` so the back Pressable lands in the tree ──────────
jest.mock('../../components/TopBar', () => ({
  TopBar: ({ title, left }: { title: string; left?: import('react').ReactNode }) => {
    const React = require('react') as typeof import('react');
    const { View, Text } = require('react-native') as typeof import('react-native');
    return React.createElement(View, null, left, React.createElement(Text, null, title));
  },
}));

// ── Section/Row/Toggle — minimal pressable stand-ins exposing label+onPress ──
jest.mock('../../components/Section', () => {
  const React = require('react') as typeof import('react');
  const { View, Text, Pressable } = require('react-native') as typeof import('react-native');
  return {
    Section: ({ label, children }: { label?: string; children?: import('react').ReactNode }) =>
      React.createElement(View, null, label ? React.createElement(Text, null, label) : null, children),
    Row: ({ label, sub, onPress }: { label: string; sub?: string; onPress?: () => void }) =>
      React.createElement(
        Pressable,
        { onPress },
        React.createElement(Text, null, label),
        sub ? React.createElement(Text, null, sub) : null,
      ),
    Toggle: ({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) =>
      React.createElement(
        Pressable,
        { onPress: () => onChange(!value) },
        React.createElement(Text, null, label),
      ),
  };
});

// ── identity store ──────────────────────────────────────────────────────────
const mockUpdateProfile = jest.fn().mockResolvedValue(undefined);
const mockUpdateStatus = jest.fn().mockResolvedValue(undefined);
const mockReset = jest.fn().mockResolvedValue(undefined);
const mockCreateSlot = jest.fn().mockResolvedValue('slot-2');
const mockSwitchSlot = jest.fn().mockResolvedValue(undefined);
const mockIdentity: {
  identity: { aegisId: string; publicKeyB64: string } | null;
  displayName: string;
  avatarColor: string;
  avatarImage: string | null;
  profileStatus: string;
  updateProfile: jest.Mock;
  updateStatus: jest.Mock;
  reset: jest.Mock;
} = {
  identity: { aegisId: 'AEGIS-7QX', publicKeyB64: 'pubkey-b64' },
  displayName: 'Alice',
  avatarColor: '#05b875',
  avatarImage: null,
  profileStatus: '',
  updateProfile: mockUpdateProfile,
  updateStatus: mockUpdateStatus,
  reset: mockReset,
};
jest.mock('../../store/identity', () => {
  const useIdentity = jest.fn(() => mockIdentity);
  (useIdentity as unknown as { getState: () => unknown }).getState = () => ({
    createSlot: mockCreateSlot,
    switchSlot: mockSwitchSlot,
  });
  return { useIdentity };
});

// ── preferences store (selector-based) ──────────────────────────────────────
const mockSetPreference = jest.fn();
const mockPrefs: Record<string, unknown> = {
  set: mockSetPreference,
  photoVis: 'all',
  lastSeenVisible: true,
  typingVisible: false,
};
jest.mock('../../store/preferences', () => ({
  usePreferences: (sel: (s: Record<string, unknown>) => unknown) => sel(mockPrefs),
}));

// ── Subject under test (after mocks) ────────────────────────────────────────
import { ProfileScreen } from '../Profile';

type Btn = { text?: string; style?: string; onPress?: () => void | Promise<void> };

function makeProps() {
  return {
    onBack: jest.fn(),
    onDevices: jest.fn(),
    onAppIcon: jest.fn(),
    onKeys: jest.fn(),
    onExport: jest.fn(),
    onProfileSwitcher: jest.fn(),
  };
}

describe('ProfileScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIdentity.profileStatus = '';
    mockIdentity.identity = { aegisId: 'AEGIS-7QX', publicKeyB64: 'pubkey-b64' };
    mockPrefs.photoVis = 'all';
    mockPrefs.lastSeenVisible = true;
    mockPrefs.typingVisible = false;
  });

  // ── 1. Title + identity ──────────────────────────────────────────────────
  it('renders the title, displayName and aegisId', () => {
    const { getAllByText, getByText } = render(<ProfileScreen {...makeProps()} />);
    expect(getAllByText('profile.title').length).toBeGreaterThanOrEqual(1);
    expect(getByText('Alice')).toBeTruthy();
    expect(getByText('AEGIS-7QX')).toBeTruthy();
  });

  // ── 2. Empty status → placeholder ────────────────────────────────────────
  it('shows the "add status" placeholder when profileStatus is empty', () => {
    const { getByText } = render(<ProfileScreen {...makeProps()} />);
    expect(getByText('profile.addStatus')).toBeTruthy();
  });

  // ── 3. Populated status → text ───────────────────────────────────────────
  it('shows the current status text when profileStatus is set', () => {
    mockIdentity.profileStatus = 'building in public';
    const { getByText, queryByText } = render(<ProfileScreen {...makeProps()} />);
    expect(getByText('building in public')).toBeTruthy();
    expect(queryByText('profile.addStatus')).toBeNull();
  });

  // ── 4. Account rows route to nav callbacks ───────────────────────────────
  it('routes account rows to their nav callbacks', () => {
    const props = makeProps();
    const { getByText } = render(<ProfileScreen {...props} />);

    fireEvent.press(getByText('profile.identitiesAndKeys'));
    expect(props.onKeys).toHaveBeenCalledTimes(1);

    fireEvent.press(getByText('profile.linkedDevices'));
    expect(props.onDevices).toHaveBeenCalledTimes(1);

    fireEvent.press(getByText('profile.appIcon'));
    expect(props.onAppIcon).toHaveBeenCalledTimes(1);

    fireEvent.press(getByText('dataExport.export'));
    expect(props.onExport).toHaveBeenCalledTimes(1);

    fireEvent.press(getByText('profile.isolatedProfiles'));
    expect(props.onProfileSwitcher).toHaveBeenCalledTimes(1);
  });

  // ── 5. Delete identity is confirm-gated and calls reset() ────────────────
  it('confirms before deleting the identity, then calls reset()', async () => {
    const alertSpy = themedAlert as jest.Mock;
    const { getByText } = render(<ProfileScreen {...makeProps()} />);

    fireEvent.press(getByText('profile.deleteIdentity'));
    expect(alertSpy).toHaveBeenCalledWith(
      'profile.deleteIdentityTitle',
      'profile.deleteIdentityDesc',
      expect.any(Array),
    );
    // reset() must NOT fire on the prompt alone
    expect(mockReset).not.toHaveBeenCalled();

    const buttons = alertSpy.mock.calls.at(-1)?.[2] as Btn[];
    const confirm = buttons.find((b) => b.style === 'destructive');
    expect(confirm).toBeTruthy();
    await confirm!.onPress?.();
    await waitFor(() => expect(mockReset).toHaveBeenCalledTimes(1));
  });

  // ── 6. Create identity is confirm-gated and calls createSlot() ───────────
  it('confirms before creating a new identity, then calls createSlot()', async () => {
    const alertSpy = themedAlert as jest.Mock;
    const { getByText } = render(<ProfileScreen {...makeProps()} />);

    fireEvent.press(getByText('profile.createIdentity'));
    expect(alertSpy).toHaveBeenCalledWith(
      'profile.createIdentityTitle',
      'profile.createIdentityDesc',
      expect.any(Array),
    );
    expect(mockCreateSlot).not.toHaveBeenCalled();

    const buttons = alertSpy.mock.calls.at(-1)?.[2] as Btn[];
    const add = buttons.find((b) => b.text === 'common.add');
    expect(add).toBeTruthy();
    await add!.onPress?.();
    await waitFor(() => expect(mockCreateSlot).toHaveBeenCalledTimes(1));
  });

  // ── 7. PhotoVisPicker writes the photoVis preference ─────────────────────
  it('writes photoVis when a visibility option is chosen', () => {
    const { getByText } = render(<ProfileScreen {...makeProps()} />);
    // labels are upper-cased in the segmented control
    fireEvent.press(getByText('PROFILE.NOBODY'));
    expect(mockSetPreference).toHaveBeenCalledWith('photoVis', 'none');
  });

  // ── 8. Toggles invert and persist their preference ───────────────────────
  it('toggles lastSeen and typing visibility, inverting current value', () => {
    const { getByText } = render(<ProfileScreen {...makeProps()} />);

    fireEvent.press(getByText('profile.lastSeen')); // current true → false
    expect(mockSetPreference).toHaveBeenCalledWith('lastSeenVisible', false);

    fireEvent.press(getByText('profile.typingIndicator')); // current false → true
    expect(mockSetPreference).toHaveBeenCalledWith('typingVisible', true);
  });

  // ── 9. Back button ───────────────────────────────────────────────────────
  it('calls onBack() when the back button is pressed', () => {
    const props = makeProps();
    const { UNSAFE_getAllByProps } = render(<ProfileScreen {...props} />);
    const backBtns = UNSAFE_getAllByProps({ onPress: props.onBack });
    expect(backBtns.length).toBeGreaterThanOrEqual(1);
    fireEvent.press(backBtns[0]);
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  // ── 10. Isolated-profiles row hidden under duress (decoy mode) ───────────
  it('hides the "isolated profiles" row while duressActive is true', () => {
    mockPrefs.duressActive = true;
    const { queryByText } = render(<ProfileScreen {...makeProps()} />);
    expect(queryByText('profile.isolatedProfiles')).toBeNull();
    mockPrefs.duressActive = false;
  });
});
