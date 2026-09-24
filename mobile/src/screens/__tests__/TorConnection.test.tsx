/**
 * TorConnection screen — Privacy → Network → Tor connection (bridges).
 * The screen only proposes; net/torConnection.ts validates and applies.
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000', surface: '#111', surface2: '#222', text: '#fff', textDim: '#aaa',
      textFaint: '#666', accent: '#05b875', accentInk: '#000', danger: '#e63946',
      border: '#222', divider: '#1a1a1a', radius: 12, radiusS: 8, font: 'System', fontMono: 'monospace',
    },
  }),
}));
jest.mock('../../components/icons', () => ({ I: new Proxy({}, { get: () => () => null }) }));
jest.mock('../../components/TopBar', () => ({ TopBar: () => null }));
jest.mock('../../components/Button', () => {
  const R = require('react') as typeof import('react');
  const { Pressable, Text } = require('react-native') as typeof import('react-native');
  return {
    PrimaryButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
      R.createElement(Pressable, { onPress, testID: 'apply' }, R.createElement(Text, null, label)),
  };
});

const mockState = {
  mode: 'auto',
  custom: [] as string[],
  transport: 'direct',
  progress: 100,
  bridgesAvailable: true,
  error: null as string | null,
};
const mockSet = jest.fn(async (..._a: unknown[]) => ({ ok: true, accepted: 1, rejected: 1 }) as unknown);
jest.mock('../../net/torConnection', () => ({
  useTorConnection: (sel?: (s: typeof mockState) => unknown) => (sel ? sel(mockState) : mockState),
  setTorConnection: (...a: unknown[]) => mockSet(...a),
}));

import { TorConnectionScreen } from '../TorConnection';

beforeEach(() => {
  mockSet.mockClear();
  mockState.bridgesAvailable = true;
});

describe('TorConnectionScreen', () => {
  it('shows every mode and the live transport', () => {
    const { getByTestId, getByText } = render(<TorConnectionScreen onBack={() => undefined} />);
    for (const m of ['auto', 'direct', 'snowflake', 'obfs4', 'meek', 'custom']) expect(getByTestId(`tor-mode-${m}`)).toBeTruthy();
    expect(getByText('torConnection.transport.direct')).toBeTruthy();
    expect(getByText('torConnection.connected')).toBeTruthy();
  });

  it('custom: sends the pasted text and reports ignored lines', async () => {
    const { getByTestId, findByTestId } = render(<TorConnectionScreen onBack={() => undefined} />);
    fireEvent.press(getByTestId('tor-mode-custom'));
    fireEvent.changeText(getByTestId('tor-custom-bridges'), 'obfs4 192.0.2.1:443 X\ngarbage');
    fireEvent.press(getByTestId('apply'));
    await findByTestId('tor-connection-applied');
    expect(mockSet).toHaveBeenCalledWith('custom', 'obfs4 192.0.2.1:443 X\ngarbage');
  });

  it('a fixed transport sends no custom text', async () => {
    const { getByTestId } = render(<TorConnectionScreen onBack={() => undefined} />);
    fireEvent.press(getByTestId('tor-mode-snowflake'));
    fireEvent.press(getByTestId('apply'));
    await waitFor(() => expect(mockSet).toHaveBeenCalledWith('snowflake', null));
  });

  it('shows the "no valid bridges" error', async () => {
    mockSet.mockResolvedValueOnce({ ok: false, error: 'no_valid_bridges' });
    const { getByTestId, findByText } = render(<TorConnectionScreen onBack={() => undefined} />);
    fireEvent.press(getByTestId('tor-mode-custom'));
    fireEvent.press(getByTestId('apply'));
    expect(await findByText('torConnection.noValidBridges')).toBeTruthy();
  });

  it('a binary without bridges offers only automatic and direct', () => {
    mockState.bridgesAvailable = false;
    const { queryByTestId } = render(<TorConnectionScreen onBack={() => undefined} />);
    expect(queryByTestId('tor-mode-auto')).toBeTruthy();
    expect(queryByTestId('tor-mode-direct')).toBeTruthy();
    expect(queryByTestId('tor-mode-snowflake')).toBeNull();
    expect(queryByTestId('tor-mode-custom')).toBeNull();
  });
});
