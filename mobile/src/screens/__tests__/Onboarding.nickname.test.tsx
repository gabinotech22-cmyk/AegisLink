/**
 * OnboardingScreen — 'nickname' step unit tests
 *
 * Verifies:
 *  1. Advancing past the 'show' step (pressing Continue) renders the
 *     'nickname' step with its TextInput, Continue button and Skip link.
 *  2. Typing a nickname and pressing "Continue" calls updateProfile with the
 *     trimmed text and the current avatarColor, then proceeds (onDone fires).
 *  3. Pressing "Skip for now" does NOT call updateProfile but still proceeds.
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

// ── safe-area-context ──────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ── react-i18next — return the key itself, but resolve {{name}} interpolation
//    minimally so nicknameDefault's placeholder text is inspectable if needed.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown> | string) => {
      if (opts && typeof opts === 'object' && 'name' in opts) {
        return `${key}:${(opts as { name: string }).name}`;
      }
      return key;
    },
  }),
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
      accentInk: '#000',
      danger: '#e63946',
      border: '#222',
      borderStrong: '#333',
      divider: '#1a1a1a',
      radius: 12,
      radiusS: 8,
      font: 'System',
      fontMono: 'monospace',
      fontDisplay: 'System',
    },
    dark: true,
    toggle: jest.fn(),
  }),
}));

// ── i18n/useLocale ─────────────────────────────────────────────────────────
jest.mock('../../i18n/useLocale', () => ({
  useLocale: () => ({ locale: 'en', setLocale: jest.fn() }),
}));

// ── icons ──────────────────────────────────────────────────────────────────
jest.mock('../../components/icons', () => ({
  I: {
    Sun: () => null,
    Moon: () => null,
    Copy: () => null,
    Key: () => null,
  },
}));

// ── AegisMark ──────────────────────────────────────────────────────────────
jest.mock('../../components/AegisMark', () => ({
  AegisMark: () => null,
  AegisWord: () => null,
}));

// ── clipboard ──────────────────────────────────────────────────────────────
jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn().mockResolvedValue(undefined),
}));

// ── fingerprint (real sha256-based — deterministic, safe to leave unmocked,
//    but mocked here to keep the test hermetic and fast). ────────────────────
jest.mock('../../crypto/fingerprint', () => ({
  fingerprintHex: jest.fn(() => ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee', 'ffff', '1111', '2222']),
}));

// ── DIDManager — avoid touching secure-store/native deps ────────────────────
jest.mock('../../web3/did/DIDManager', () => ({
  getOrCreateDID: jest.fn().mockResolvedValue({ did: 'did:aegis:mock', profileId: 'mock', derivedAt: 0 }),
}));

// ── registration + x3dh — registration is invoked by handleEnter; mock so it
//    resolves instantly without any network/crypto work. ───────────────────
jest.mock('../../crypto/registration', () => ({
  fetchPowChallenge: jest.fn().mockResolvedValue({ challenge: 'c', difficulty: 1 }),
  solvePoW: jest.fn().mockResolvedValue('nonce'),
  uploadIdentityAndPrekeys: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../crypto/signal/x3dh', () => ({
  ensureDevicePreKeys: jest.fn().mockResolvedValue({
    signedPreKey: { keyId: 1, secretKey: new Uint8Array(), publicKeyB64: '', signatureB64: '' },
    opkSecrets: [],
    oneTimePreKeys: [],
  }),
}));

jest.mock('../../config', () => ({ RELAY_URL: 'https://example.invalid' }));

// ── identity store ───────────────────────────────────────────────────────
const mockUpdateProfile = jest.fn().mockResolvedValue(undefined);
const mockGenerate = jest.fn();

const mockIdentity = {
  aegisId: 'AEGIS-TEST-1234',
  publicKey: new Uint8Array(32),
  publicKeyB64: 'pub',
  secretKeyB64: 'sec',
  signingPublicKey: new Uint8Array(32),
  signingPublicKeyB64: 'spub',
  signingSecretKeyB64: 'ssec',
  createdAt: 0,
};

jest.mock('../../store/identity', () => ({
  useIdentity: jest.fn(() => ({
    identity: mockIdentity,
    generate: mockGenerate,
    avatarColor: '#5bf2b9',
    updateProfile: mockUpdateProfile,
    retryPublish: jest.fn().mockResolvedValue(undefined),
  })),
}));

// ── Subject under test (imported AFTER mocks) ──────────────────────────────
import { OnboardingScreen } from '../Onboarding';

describe('OnboardingScreen — nickname step', () => {
  const onDone = jest.fn();
  const onRestore = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateProfile.mockResolvedValue(undefined);
  });

  async function renderAtNicknameStep() {
    const utils = render(<OnboardingScreen onDone={onDone} onRestore={onRestore} dbReady />);
    // Step 0 'welcome' -> generate identity (mocked to resolve instantly).
    fireEvent.press(utils.getByText('onboarding.generateBtn'));
    // Step 1 'generating' -> skip the spinner animation to reach 'show' immediately.
    await waitFor(() => utils.getByText('onboarding.skipAnimation'));
    fireEvent.press(utils.getByText('onboarding.skipAnimation'));
    // Step 2 'show' -> the primary button is now labelled 'onboarding.continueBtn'
    // and advances to 'nickname' instead of registering directly.
    await waitFor(() => utils.getByText('onboarding.continueBtn'));
    fireEvent.press(utils.getByText('onboarding.continueBtn'));
    return utils;
  }

  it('renders the nickname step with input, Continue and Skip after advancing from "show"', async () => {
    const { getByText, getByPlaceholderText } = await renderAtNicknameStep();

    expect(getByText('onboarding.nicknameTitle')).toBeTruthy();
    expect(getByText('onboarding.nicknameSubtitle')).toBeTruthy();
    expect(getByText('onboarding.skipNickname')).toBeTruthy();
    // Placeholder is the derived default name (aegisId lowercased, dashes stripped)
    expect(getByPlaceholderText('aegistest1234')).toBeTruthy();
  });

  it('calls updateProfile with the trimmed nickname and current avatarColor, then proceeds', async () => {
    const { getByPlaceholderText, getByText } = await renderAtNicknameStep();

    fireEvent.changeText(getByPlaceholderText('aegistest1234'), '  Nova  ');
    fireEvent.press(getByText('onboarding.continueBtn'));

    await waitFor(() => {
      expect(mockUpdateProfile).toHaveBeenCalledWith('Nova', '#5bf2b9', null);
    });
    await waitFor(() => {
      expect(onDone).toHaveBeenCalled();
    });
  });

  it('does NOT call updateProfile when "Skip for now" is pressed, but still proceeds', async () => {
    const { getByText } = await renderAtNicknameStep();

    fireEvent.press(getByText('onboarding.skipNickname'));

    await waitFor(() => {
      expect(onDone).toHaveBeenCalled();
    });
    expect(mockUpdateProfile).not.toHaveBeenCalled();
  });

  it('does NOT call updateProfile when Continue is pressed with an empty nickname', async () => {
    const { getByText } = await renderAtNicknameStep();

    fireEvent.press(getByText('onboarding.continueBtn'));

    await waitFor(() => {
      expect(onDone).toHaveBeenCalled();
    });
    expect(mockUpdateProfile).not.toHaveBeenCalled();
  });
});
