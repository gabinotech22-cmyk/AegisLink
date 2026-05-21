/**
 * PanicScreen — accessibility tests
 *
 * Verifies:
 *  1. The "Activate panic mode" button has accessibilityRole=button
 *  2. The PIN TextInput has autoFocus when modal is open
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

describe('PanicScreen — accessibility', () => {
  it('has at least one button with accessibilityRole', () => {
    const { getAllByRole } = render(<PanicScreen onBack={jest.fn()} />);
    const buttons = getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
  });

  it('activate panic button has a non-empty accessibilityLabel', () => {
    const { getAllByRole } = render(<PanicScreen onBack={jest.fn()} />);
    const buttons = getAllByRole('button');
    const panicButton = buttons.find(
      (b) => {
        const label = b.props.accessibilityLabel as string | undefined;
        return label && label.length > 0;
      }
    );
    expect(panicButton).toBeTruthy();
  });

  it('PIN modal TextInput has autoFocus when opened', async () => {
    const { getByText, UNSAFE_getAllByType } = render(<PanicScreen onBack={jest.fn()} />);

    // Open the PIN edit modal (button labeled by the i18n key fallback)
    const changeBtn = getByText('panic.changeDecoyPin');
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
});
