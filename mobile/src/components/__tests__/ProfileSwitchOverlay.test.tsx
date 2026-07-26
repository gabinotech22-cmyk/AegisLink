/**
 * ProfileSwitchOverlay — quick profile switcher opened by long-pressing the
 * Privacy tab (Section 11). Crypto-free: the store is mocked, so this asserts the
 * UI wiring only — list renders, tapping a profile switches to it, "New profile"
 * navigates — with no key material touched.
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// i18n passthrough: return the key (with the interpolated name appended) so the
// test never asserts on translated copy — profile names/ids are DATA, not i18n.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { name?: string }) => (o?.name ? `${k}:${o.name}` : k),
  }),
}));

jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000', text: '#fff', textDim: '#aaa', textFaint: '#555',
      accent: '#5bf2b9', surface2: '#1a2326', surface3: '#243033',
      border: '#333', borderStrong: '#555',
      font: 'Inter', fontMono: 'Mono', fontDisplay: 'Inter',
    },
  }),
}));

jest.mock('../icons', () => ({ I: { Check: () => null, Plus: () => null } }));
jest.mock('../AlertHost', () => ({ themedAlert: jest.fn() }));

// Avatar renders an identicon (react-native-svg) — mock to a bare view so this
// test needs no SVG and stays focused on the switch wiring.
jest.mock('../Avatar', () => ({ Avatar: () => null }));

const mockSwitch = jest.fn().mockResolvedValue(undefined);
const mockHydrate = jest.fn().mockResolvedValue(undefined);
const mockProfilesState = {
  activeSlotId: 'self',
  profiles: [
    { slotId: 'self', aegisId: 'ABC-DEF1-GH23', displayName: 'Personal', avatarColor: '#05b875', createdAt: 0, isActive: true },
    { slotId: 'XYZ-1111-2222', aegisId: 'XYZ-1111-2222', displayName: 'Trabajo', avatarColor: '#8b5cf6', createdAt: 1, isActive: false },
  ],
  switchProfile: mockSwitch,
  hydrate: mockHydrate,
};
jest.mock('../../store/profiles', () => ({
  useProfiles: (sel: (s: unknown) => unknown) => sel(mockProfilesState),
}));
jest.mock('../../store/identity', () => ({
  useIdentity: (sel: (s: unknown) => unknown) => sel({ identity: { publicKeyB64: 'pk' } }),
}));

import { ProfileSwitchOverlay } from '../ProfileSwitchOverlay';

describe('ProfileSwitchOverlay', () => {
  beforeEach(() => {
    mockSwitch.mockClear();
    mockHydrate.mockClear();
  });

  it('lista los perfiles cuando está visible', () => {
    const { getByText } = render(
      <ProfileSwitchOverlay visible onClose={jest.fn()} onCreateProfile={jest.fn()} />
    );
    expect(getByText('Personal')).toBeTruthy();
    expect(getByText('Trabajo')).toBeTruthy();
    // AegisID is shown verbatim (data, never translated).
    expect(getByText('XYZ-1111-2222')).toBeTruthy();
  });

  it('tocar un perfil inactivo llama a switchProfile con su slotId', async () => {
    const { getByText } = render(
      <ProfileSwitchOverlay visible onClose={jest.fn()} onCreateProfile={jest.fn()} />
    );
    fireEvent.press(getByText('Trabajo'));
    await waitFor(() => expect(mockSwitch).toHaveBeenCalledWith('XYZ-1111-2222'));
  });

  it('tocar el perfil ACTIVO no cambia nada, solo cierra', () => {
    const onClose = jest.fn();
    const { getByText } = render(
      <ProfileSwitchOverlay visible onClose={onClose} onCreateProfile={jest.fn()} />
    );
    fireEvent.press(getByText('Personal'));
    expect(mockSwitch).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('"Nuevo perfil" cierra y navega a crear perfil', () => {
    const onClose = jest.fn();
    const onCreateProfile = jest.fn();
    const { getByText } = render(
      <ProfileSwitchOverlay visible onClose={onClose} onCreateProfile={onCreateProfile} />
    );
    fireEvent.press(getByText('profileSwitch.newProfile'));
    expect(onCreateProfile).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
