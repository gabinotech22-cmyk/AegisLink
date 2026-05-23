/**
 * Section 12 — Scheduled Messages
 * Tests: SchedulePicker rendering, validation, ScheduledScreen empty state.
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { Alert } from 'react-native';

// ─── Mocks ────────────────────────────────────────────────────────────────────

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
      warn: '#FFCC00',
      danger: '#FF4444',
      dark: true,
      radius: 12,
      radiusS: 8,
      font: 'Inter',
      fontMono: 'JetBrainsMono',
      fontDisplay: 'Inter',
    },
  }),
}));

jest.mock('../store/scheduledMessages', () => ({
  useScheduledMessages: () => ({
    scheduled: [],
    loadPending: jest.fn().mockResolvedValue(undefined),
    cancelScheduled: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock('../store/contacts', () => ({
  useContacts: (selector: (s: { contacts: [] }) => unknown) =>
    selector({ contacts: [] }),
}));

jest.mock('../components/icons', () => ({
  I: new Proxy({}, {
    get: () => () => null,
  }),
}));

jest.mock('../components/TopBar', () => ({
  TopBar: ({ title }: { title: string }) => {
    const { Text } = require('react-native');
    const mockReact = require('react');
    return mockReact.createElement(Text, null, title);
  },
}));

// ─── SchedulePicker ───────────────────────────────────────────────────────────

import { SchedulePicker } from '../components/SchedulePicker';

describe('SchedulePicker', () => {
  it('renders without crashing when visible', () => {
    const { getByText } = render(
      <SchedulePicker visible onClose={jest.fn()} onConfirm={jest.fn()} />,
    );
    expect(getByText('Programar mensaje')).toBeTruthy();
  });

  it('shows Cancelar and Programar buttons', () => {
    const { getByText } = render(
      <SchedulePicker visible onClose={jest.fn()} onConfirm={jest.fn()} />,
    );
    expect(getByText('Cancelar')).toBeTruthy();
    expect(getByText('Programar')).toBeTruthy();
  });

  it('calls onClose when Cancelar is pressed', () => {
    const onClose = jest.fn();
    const { getByText } = render(
      <SchedulePicker visible onClose={onClose} onConfirm={jest.fn()} />,
    );
    fireEvent.press(getByText('Cancelar'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows alert when date is set to invalid value', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const onConfirm = jest.fn();

    // Test the validation logic directly without relying on Modal onShow
    const { getByText } = render(
      <SchedulePicker visible onClose={jest.fn()} onConfirm={onConfirm} />,
    );

    // The component starts with empty strings (onShow not called in test env),
    // pressing confirm should show validation alert.
    fireEvent.press(getByText('Programar'));
    expect(alertSpy).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });
});

// ─── ScheduledScreen ──────────────────────────────────────────────────────────

import { ScheduledScreen } from '../screens/Scheduled';

describe('ScheduledScreen', () => {
  it('renders empty state when no messages', () => {
    const { getByText } = render(<ScheduledScreen onBack={jest.fn()} />);
    expect(getByText(/No hay mensajes programados/)).toBeTruthy();
  });

  it('renders title', () => {
    const { getByText } = render(<ScheduledScreen onBack={jest.fn()} />);
    expect(getByText('Mensajes Programados')).toBeTruthy();
  });
});
