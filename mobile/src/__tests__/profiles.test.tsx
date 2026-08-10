/**
 * Section 11 — Multiple Isolated Profiles
 * Tests: ProfileSwitcherScreen rendering, CreateProfileScreen steps, useProfiles store.
 */
import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// ProfileSwitcher surfaces user prompts via themedAlert() (the in-app themed
// dialog), not RN's Alert.alert. Mock it so the assertions observe the real path.
jest.mock('../components/AlertHost', () => ({ themedAlert: jest.fn() }));
import { themedAlert } from '../components/AlertHost';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000000',
      text: '#ffffff',
      textDim: '#aaaaaa',
      textFaint: '#555555',
      accentInk: '#000000',
      accent: '#00FF88',
      accentDeep: '#003322',
      surface: '#111111',
      surface2: '#222222',
      surface3: '#333333',
      border: '#333333',
      borderStrong: '#555555',
      divider: '#222222',
      radius: 12,
      radiusS: 8,
      radiusL: 16,
      font: 'Inter',
      fontMono: 'IBMPlexMono',
      fontDisplay: 'Inter',
      dark: true,
    },
  }),
}));

jest.mock('../components/icons', () => ({
  I: {
    ChevronL: () => null,
    Plus: () => null,
    Check: () => null,
    Chevron: () => null,
    Shield: () => null,
  },
}));

jest.mock('../components/TopBar', () => ({
  TopBar: ({ title, left, right }: { title: string; left?: React.ReactNode; right?: React.ReactNode }) => {
    const { View, Text } = require('react-native');
    return (
      <View>
        {left}
        <Text>{title}</Text>
        {right}
      </View>
    );
  },
}));

// Mock expo-secure-store
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

// Mock db/local
jest.mock('../db/local', () => ({
  setActiveDbSlot: jest.fn(),
  resetDbConnection: jest.fn(),
  closeActiveDatabase: jest.fn().mockResolvedValue(undefined),
  saveIdentity: jest.fn().mockResolvedValue(undefined),
  deleteIdentitySlot: jest.fn().mockResolvedValue(undefined),
}));

// Mock crypto/identity
jest.mock('../crypto/identity', () => ({
  createIdentity: jest.fn(() => ({
    aegisId: 'ABC-DEF1-GH23',
    publicKey: new Uint8Array(32),
    secretKey: new Uint8Array(32),
    publicKeyB64: 'cHVibGljS2V5QmFzZTY0',
    secretKeyB64: 'c2VjcmV0S2V5QmFzZTY0',
    signingPublicKey: new Uint8Array(32),
    signingSecretKey: new Uint8Array(64),
    signingPublicKeyB64: 'c2lnbmluZ1B1YkI2NA==',
    signingSecretKeyB64: 'c2lnbmluZ1NlY0I2NA==',
    createdAt: 1700000000000,
  })),
}));

// Mock tweetnacl
jest.mock('tweetnacl', () => ({
  randomBytes: jest.fn(() => new Uint8Array(32)),
}));

// Mock tweetnacl-util
jest.mock('tweetnacl-util', () => ({
  encodeBase64: jest.fn(() => 'bW9ja0tleQ=='),
}));

// Mock socket/client
jest.mock('../socket/client', () => ({
  getSocket: jest.fn(() => null),
  connect: jest.fn(),
}));

// Mock crypto/registration + signal/x3dh
jest.mock('../crypto/registration', () => ({
  fetchPowChallenge: jest.fn().mockRejectedValue(new Error('offline')),
  solvePoW: jest.fn(),
  uploadIdentityAndPrekeys: jest.fn(),
}));

jest.mock('../crypto/signal/x3dh', () => ({
  generatePreKeys: jest.fn(() => ({
    signedPreKey: { keyId: 1, secretKey: new Uint8Array(32), publicKeyB64: '', signatureB64: '' },
    opkSecrets: new Map(),
    oneTimePreKeys: [],
  })),
  ensureDevicePreKeys: jest.fn(async () => ({
    signedPreKey: { keyId: 1, secretKey: new Uint8Array(32), publicKeyB64: '', signatureB64: '' },
    opkSecrets: new Map(),
    oneTimePreKeys: [],
  })),
}));

jest.mock('../config', () => ({ SERVER_URL: 'http://localhost:3000' }));

// Mock stores that switchProfile touches
jest.mock('./contacts', () => ({ useContacts: { setState: jest.fn(), getState: () => ({ hydrate: jest.fn() }) } }), { virtual: true });
jest.mock('./groups', () => ({ useGroups: { setState: jest.fn(), getState: () => ({ hydrate: jest.fn() }) } }), { virtual: true });
jest.mock('./messages', () => ({ useMessages: { setState: jest.fn() } }), { virtual: true });
jest.mock('./identity', () => ({
  useIdentity: {
    getState: jest.fn(() => ({
      identity: { aegisId: 'ABC-DEF1-GH23', createdAt: 1700000000000 },
      displayName: 'yo',
      avatarColor: '#05b875',
      activeSlotId: 'self',
      hydrate: jest.fn().mockResolvedValue(undefined),
    })),
    setState: jest.fn(),
  },
}), { virtual: true });

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { ProfileSwitcherScreen } from '../screens/ProfileSwitcher';
import { CreateProfileScreen } from '../screens/CreateProfile';
import { useProfiles } from '../store/profiles';

// ─── ProfileSwitcherScreen ───────────────────────────────────────────────────

describe('ProfileSwitcherScreen', () => {
  beforeEach(() => {
    // Seed profiles store with two profiles.
    useProfiles.setState({
      activeSlotId: 'self',
      profiles: [
        { slotId: 'self', aegisId: 'ABC-DEF1-GH23', displayName: 'Personal', avatarColor: '#05b875', createdAt: 1700000000000, isActive: true },
        { slotId: 'XYZ-1111-2222', aegisId: 'XYZ-1111-2222', displayName: 'Trabajo', avatarColor: '#8b5cf6', createdAt: 1700000001000, isActive: false },
      ],
    });
  });

  it('muestra todos los perfiles', () => {
    const { getByText } = render(
      <ProfileSwitcherScreen onBack={jest.fn()} onCreateProfile={jest.fn()} />
    );
    expect(getByText('Personal')).toBeTruthy();
    expect(getByText('Trabajo')).toBeTruthy();
  });

  it('muestra indicador ACTIVO en el perfil activo', () => {
    const { getByText } = render(
      <ProfileSwitcherScreen onBack={jest.fn()} onCreateProfile={jest.fn()} />
    );
    expect(getByText('ACTIVE')).toBeTruthy();
  });

  it('muestra estado vacío cuando no hay perfiles', () => {
    useProfiles.setState({ profiles: [], activeSlotId: 'self' });
    const { getByText } = render(
      <ProfileSwitcherScreen onBack={jest.fn()} onCreateProfile={jest.fn()} />
    );
    expect(getByText(/No profiles found/i)).toBeTruthy();
  });

  it('navega a CreateProfile al pulsar el botón "+"', () => {
    const onCreateProfile = jest.fn();
    const { getByText } = render(
      <ProfileSwitcherScreen onBack={jest.fn()} onCreateProfile={onCreateProfile} />
    );
    fireEvent.press(getByText('New profile'));
    expect(onCreateProfile).toHaveBeenCalled();
  });

  it('muestra alerta de confirmación al pulsar un perfil inactivo', () => {
    const alertSpy = themedAlert as jest.Mock;
    alertSpy.mockClear();
    const { getByText } = render(
      <ProfileSwitcherScreen onBack={jest.fn()} onCreateProfile={jest.fn()} />
    );
    fireEvent.press(getByText('Trabajo'));
    expect(alertSpy).toHaveBeenCalledWith(
      'Change profile',
      expect.any(String),
      expect.any(Array)
    );
  });

  it('muestra alerta de eliminación en long-press de perfil no primario', () => {
    const alertSpy = themedAlert as jest.Mock;
    alertSpy.mockClear();
    const { getByText } = render(
      <ProfileSwitcherScreen onBack={jest.fn()} onCreateProfile={jest.fn()} />
    );
    fireEvent(getByText('Trabajo'), 'longPress');
    expect(alertSpy).toHaveBeenCalledWith(
      expect.stringContaining('Trabajo'),
      expect.any(String),
      expect.any(Array)
    );
  });

  it('impide eliminar el perfil primario', () => {
    const alertSpy = themedAlert as jest.Mock;
    alertSpy.mockClear();
    const { getByText } = render(
      <ProfileSwitcherScreen onBack={jest.fn()} onCreateProfile={jest.fn()} />
    );
    fireEvent(getByText('Personal'), 'longPress');
    // For the primary profile, should alert about primary profile protection
    expect(alertSpy).toHaveBeenCalledWith(
      'Cannot delete',
      expect.any(String)
    );
  });
});

// ─── CreateProfileScreen ─────────────────────────────────────────────────────

describe('CreateProfileScreen', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('muestra spinner en el paso de generación', () => {
    const { getByText } = render(
      <CreateProfileScreen onBack={jest.fn()} onCreated={jest.fn()} />
    );
    expect(getByText('Generating identity')).toBeTruthy();
  });

  it('avanza al paso de nombre tras la generación', async () => {
    const { getByText } = render(
      <CreateProfileScreen onBack={jest.fn()} onCreated={jest.fn()} />
    );
    act(() => { jest.advanceTimersByTime(2000); });
    await waitFor(() => expect(getByText('Choose a name')).toBeTruthy());
  });

  it('muestra el AegisID generado en el paso de nombre', async () => {
    const { getByText } = render(
      <CreateProfileScreen onBack={jest.fn()} onCreated={jest.fn()} />
    );
    act(() => { jest.advanceTimersByTime(2000); });
    await waitFor(() => expect(getByText('ABC-DEF1-GH23')).toBeTruthy());
  });
});

// ─── useProfiles store ────────────────────────────────────────────────────────

describe('useProfiles store', () => {
  it('tiene activeSlotId = "self" por defecto', () => {
    expect(useProfiles.getState().activeSlotId).toBe('self');
  });

  it('updateProfileMeta actualiza displayName y avatarColor', async () => {
    useProfiles.setState({
      profiles: [
        { slotId: 'self', aegisId: 'ABC-DEF1-GH23', displayName: 'Antiguo', avatarColor: '#05b875', createdAt: 0, isActive: true },
      ],
      activeSlotId: 'self',
    });
    const SecureStore = require('expo-secure-store');
    await act(async () => {
      await useProfiles.getState().updateProfileMeta('self', 'Nuevo nombre', '#3b82f6');
    });
    const updated = useProfiles.getState().profiles.find((p) => p.slotId === 'self');
    expect(updated?.displayName).toBe('Nuevo nombre');
    expect(updated?.avatarColor).toBe('#3b82f6');
    expect(SecureStore.setItemAsync).toHaveBeenCalled();
  });

  it('removeProfile lanza error si es el último perfil', async () => {
    useProfiles.setState({
      profiles: [
        { slotId: 'self', aegisId: 'ABC-DEF1-GH23', displayName: 'Solo', avatarColor: '#05b875', createdAt: 0, isActive: true },
      ],
      activeSlotId: 'self',
    });
    await expect(useProfiles.getState().removeProfile('self')).rejects.toThrow(
      'Cannot remove the last profile.'
    );
  });

  it('removeProfile lanza error si se intenta eliminar el perfil primario', async () => {
    useProfiles.setState({
      profiles: [
        { slotId: 'self', aegisId: 'ABC-DEF1-GH23', displayName: 'Personal', avatarColor: '#05b875', createdAt: 0, isActive: true },
        { slotId: 'XYZ-1111-2222', aegisId: 'XYZ-1111-2222', displayName: 'Extra', avatarColor: '#8b5cf6', createdAt: 1, isActive: false },
      ],
      activeSlotId: 'self',
    });
    await expect(useProfiles.getState().removeProfile('self')).rejects.toThrow(
      'Cannot remove the primary profile.'
    );
  });
});

// ─── createProfile — regresión: segunda identidad "real" y sincronizable ───────

describe('useProfiles.createProfile (regresión multi-perfil)', () => {
  function presetIdentity(aegisId: string) {
    const base = require('../crypto/identity').createIdentity();
    return { ...base, aegisId, publicKeyB64: `pk-${aegisId}` };
  }

  beforeEach(() => {
    const SecureStore = require('expo-secure-store');
    SecureStore.setItemAsync.mockClear();
    SecureStore.getItemAsync.mockClear();
    SecureStore.getItemAsync.mockResolvedValue(null);
    useProfiles.setState({
      profiles: [
        { slotId: 'self', aegisId: 'ABC-DEF1-GH23', displayName: 'Personal', avatarColor: '#05b875', createdAt: 0, isActive: true },
      ],
      activeSlotId: 'self',
    });
  });

  it('persiste displayName/avatarColor bajo las claves por-slot (el nombre sí llega a Ajustes)', async () => {
    const SecureStore = require('expo-secure-store');
    await act(async () => {
      await useProfiles.getState().createProfile('JOSE', '#8b5cf6', presetIdentity('NB6-YTJ3-6ETM') as never);
    });
    const setCalls = SecureStore.setItemAsync.mock.calls;
    expect(setCalls).toEqual(expect.arrayContaining([
      expect.arrayContaining(['aegis.NB6-YTJ3-6ETM.displayName', 'JOSE']),
    ]));
    expect(setCalls).toEqual(expect.arrayContaining([
      expect.arrayContaining(['aegis.NB6-YTJ3-6ETM.avatarColor', '#8b5cf6']),
    ]));
  });

  it('NO hace registro PoW inline (ese camino omitía el PQSPK y colgaba "Creando…")', async () => {
    const reg = require('../crypto/registration');
    reg.fetchPowChallenge.mockClear();
    reg.uploadIdentityAndPrekeys.mockClear();
    await act(async () => {
      await useProfiles.getState().createProfile('X', '#3b82f6', presetIdentity('NEW-3333-4444') as never);
    });
    expect(reg.fetchPowChallenge).not.toHaveBeenCalled();
    expect(reg.uploadIdentityAndPrekeys).not.toHaveBeenCalled();
  });

  it('persiste la identidad pre-generada por el wizard (mismo AegisID que se mostró)', async () => {
    let profile: { slotId: string; aegisId: string } | undefined;
    await act(async () => {
      profile = await useProfiles.getState().createProfile('X', '#3b82f6', presetIdentity('WIZ-5555-6666') as never);
    });
    expect(profile?.slotId).toBe('WIZ-5555-6666');
    expect(profile?.aegisId).toBe('WIZ-5555-6666');
  });

  it('registra el slot en aegis.slotsList (para que el wipe alcance su DB y claves)', async () => {
    const SecureStore = require('expo-secure-store');
    await act(async () => {
      await useProfiles.getState().createProfile('X', '#3b82f6', presetIdentity('SLT-7777-8888') as never);
    });
    const slotsListCall = SecureStore.setItemAsync.mock.calls.find((c: unknown[]) => c[0] === 'aegis.slotsList');
    expect(slotsListCall).toBeTruthy();
    expect(JSON.parse(slotsListCall[1] as string)).toContain('SLT-7777-8888');
  });
});
