/**
 * PanicScreen — accessibility + PIN-lock gate tests
 *
 * Verifies:
 *  1. The "Activate panic mode" button has accessibilityRole=button
 *  2. The PIN TextInput has autoFocus when modal is open
 *  3. With no app PIN lock configured, the screen shows the "set up lock" gate
 *     (Configure-lock CTA, no panic config) and the CTA calls onConfigureLock
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

// ── Mocks ────────────────────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000', text: '#fff', textDim: '#aaa', textFaint: '#555',
      accent: '#00FF88', danger: '#e63946',
      surface: '#111', surface2: '#222', surface3: '#333',
      border: '#333', borderStrong: '#555',
      radius: 8, radiusS: 4,
      font: 'Inter', fontMono: 'IBMPlexMono', fontDisplay: 'Inter',
      dark: true,
    },
  }),
}));

jest.mock('../../store/identity', () => ({
  useIdentity: (sel?: (s: object) => unknown) => {
    const state = { reset: jest.fn() };
    return sel ? sel(state) : state;
  },
}));

jest.mock('../../db/local', () => ({
  wipeDatabase: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../lock/pin', () => ({
  hashPinWithSalt: jest.fn().mockResolvedValue('hashed'),
  DURESS_PIN_SALT: 'salt',
  // Panic mode is gated behind the app PIN lock; report one exists so the full
  // config renders instead of the "set up your PIN lock" gate.
  hasStoredPIN: jest.fn().mockResolvedValue(true),
  verifyPIN: jest.fn().mockResolvedValue(false),
}));

jest.mock('../../components/TopBar', () => ({
  TopBar: ({ title }: { title: string }) => {
    const { Text } = require('react-native');
    return <Text>{title}</Text>;
  },
}));

jest.mock('../../components/Section', () => ({
  Section: ({ children }: { children: React.ReactNode }) => {
    const { View } = require('react-native');
    return <View>{children}</View>;
  },
  Toggle: ({ label }: { label: string }) => {
    const { Text } = require('react-native');
    return <Text>{label}</Text>;
  },
}));

jest.mock('../../components/icons', () => ({
  I: new Proxy({}, { get: () => () => null }),
}));

// ── Import after mocks ────────────────────────────────────────────────────────
import { PanicScreen } from '../Panic';
import { hasStoredPIN } from '../../lock/pin';
import { setItemAsync } from 'expo-secure-store';

describe('PanicScreen — accessibility', () => {
  it('has at least one button with accessibilityRole', async () => {
    const { getAllByRole } = render(<PanicScreen onBack={jest.fn()} onConfigureLock={jest.fn()} />);
    // The PIN-lock gate check resolves async; wait for the full config to render.
    await waitFor(() => expect(getAllByRole('button').length).toBeGreaterThan(0));
  });

  it('activate panic button has a non-empty accessibilityLabel', async () => {
    const { getAllByRole } = render(<PanicScreen onBack={jest.fn()} onConfigureLock={jest.fn()} />);
    await waitFor(() => {
      const panicButton = getAllByRole('button').find((b) => {
        const label = b.props.accessibilityLabel as string | undefined;
        return label && label.length > 0;
      });
      expect(panicButton).toBeTruthy();
    });
  });

  it('PIN modal TextInput has autoFocus when opened', async () => {
    const { getByText, UNSAFE_getAllByType } = render(<PanicScreen onBack={jest.fn()} onConfigureLock={jest.fn()} />);

    // Open the PIN edit modal (button labeled by the i18n key fallback).
    // Wait for the async PIN-lock gate check to resolve into the full config.
    const changeBtn = await waitFor(() => getByText('panic.changeDecoyPin'));
    fireEvent.press(changeBtn);

    await waitFor(() => {
      const { TextInput } = require('react-native');
      const inputs = UNSAFE_getAllByType(TextInput);
      const pinInput = inputs.find(
        (i: { props: { secureTextEntry?: boolean } }) => i.props.secureTextEntry === true
      );
      expect(pinInput).toBeTruthy();
      expect(pinInput!.props.autoFocus).toBe(true);
    });
  });

  // Regression: saving the decoy PIN must persist duressPin:true, otherwise the
  // lock screen (which gates on config.duressPin) never enters the duress branch
  // and rejects the decoy PIN as "wrong PIN". The switch defaults off until a PIN
  // is actually set, so the save path — not the toggle — must write the flag.
  it('persists duressPin:true when the decoy PIN is saved', async () => {
    const { getByText, UNSAFE_getAllByType } = render(
      <PanicScreen onBack={jest.fn()} onConfigureLock={jest.fn()} />,
    );

    const changeBtn = await waitFor(() => getByText('panic.changeDecoyPin'));
    fireEvent.press(changeBtn);

    const { TextInput } = require('react-native');
    const pinInput = await waitFor(() => {
      const input = UNSAFE_getAllByType(TextInput).find(
        (i: { props: { secureTextEntry?: boolean } }) => i.props.secureTextEntry === true,
      );
      expect(input).toBeTruthy();
      return input!;
    });

    fireEvent.changeText(pinInput, '135790');
    fireEvent.press(getByText('panic.savePinBtn'));

    await waitFor(() => {
      const panicWrite = (setItemAsync as jest.Mock).mock.calls.find(
        ([key]) => key === 'aegis.panic.v1',
      );
      expect(panicWrite).toBeTruthy();
      expect(JSON.parse(panicWrite![1])).toMatchObject({ duressPin: true, pinHash: 'hashed' });
    });
  });

  it('gates the screen behind the PIN lock when none is configured', async () => {
    (hasStoredPIN as jest.Mock).mockResolvedValueOnce(false);
    const onConfigureLock = jest.fn();
    const { getByText, queryByText } = render(
      <PanicScreen onBack={jest.fn()} onConfigureLock={onConfigureLock} />,
    );
    // Gate shows the "configure lock" CTA and hides the panic config entirely.
    const cta = await waitFor(() => getByText('panic.configureLock'));
    expect(queryByText('panic.activatePanic')).toBeNull();
    fireEvent.press(cta);
    expect(onConfigureLock).toHaveBeenCalledTimes(1);
  });
});
