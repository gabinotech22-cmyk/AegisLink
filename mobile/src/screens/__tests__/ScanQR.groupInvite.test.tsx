/**
 * ScanQRScreen — group invite routing
 *
 * Verifies:
 *  1. Scanning a group invite QR (aegislink://group/v1/… or the universal
 *     https /g# form) calls onGroupInvite with the parsed {groupId,
 *     groupName, adminId} — NOT addFromQR (no duplicated join logic).
 *  2. Scanning an identity QR still goes through the existing addFromQR path
 *     and does NOT call onGroupInvite.
 *  3. Scanning a group invite QR when `onGroupInvite` is NOT wired (e.g. the
 *     scanner opened from the identity verification flow) shows an explicit,
 *     orientational alert instead of a silent no-op or the generic
 *     "invalid QR" message — and does NOT call addFromQR.
 */

import React from 'react';
import { render, act } from '@testing-library/react-native';
import { Alert } from 'react-native';
import {
  encodeGroupInviteLink,
  encodeGroupInviteLinkUniversal,
  encodeIdentityQR,
} from '../../crypto/qr';

// ── safe-area-context ──────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ── react-i18next ──────────────────────────────────────────────────────────
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fallback?: string) => fallback ?? k }),
}));

// ── ThemeContext ───────────────────────────────────────────────────────────
jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000', text: '#fff', textDim: '#aaa', accent: '#05b875', accentInk: '#000',
      font: 'System', fontMono: 'monospace', fontDisplay: 'System',
    },
  }),
}));

// ── icons ──────────────────────────────────────────────────────────────────
jest.mock('../../components/icons', () => ({
  I: new Proxy({}, { get: () => () => null }),
}));

jest.mock('../../components/Button', () => ({
  PrimaryButton: () => null,
}));

// ── expo-camera — granted permission, capture onBarcodeScanned ─────────────
let capturedOnScan: ((r: { data: string; type: string }) => void) | null = null;
jest.mock('expo-camera', () => {
  const React = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  return {
    useCameraPermissions: () => [{ granted: true }, jest.fn()],
    CameraView: ({ onBarcodeScanned }: { onBarcodeScanned: (r: { data: string; type: string }) => void }) => {
      capturedOnScan = onBarcodeScanned;
      return React.createElement(View, { testID: 'camera-view' });
    },
  };
});

// ── contacts / identity stores ──────────────────────────────────────────────
const mockAddFromQR = jest.fn();
const mockConfirmKeyChange = jest.fn();

jest.mock('../../store/contacts', () => ({
  useContacts: jest.fn((sel: (s: unknown) => unknown) =>
    sel({ addFromQR: mockAddFromQR, confirmKeyChange: mockConfirmKeyChange })
  ),
}));

jest.mock('../../store/identity', () => ({
  useIdentity: jest.fn((sel: (s: unknown) => unknown) => sel({ identity: null })),
}));

// ── Subject under test (imported AFTER all mocks) ──────────────────────────
import { ScanQRScreen } from '../ScanQR';

describe('ScanQRScreen — group invite routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedOnScan = null;
  });

  it('routes a scheme-form group invite QR to onGroupInvite without calling addFromQR', () => {
    const onGroupInvite = jest.fn();
    const onAdded = jest.fn();
    render(<ScanQRScreen onCancel={jest.fn()} onAdded={onAdded} onGroupInvite={onGroupInvite} />);

    const link = encodeGroupInviteLink('g-123', 'Mi Grupo', 'ADM-1111-2222');
    expect(capturedOnScan).not.toBeNull();
    act(() => {
      capturedOnScan!({ data: link, type: 'qr' });
    });

    expect(onGroupInvite).toHaveBeenCalledWith('g-123', 'Mi Grupo', 'ADM-1111-2222');
    expect(mockAddFromQR).not.toHaveBeenCalled();
  });

  it('routes a universal https group invite QR (/g#) to onGroupInvite', () => {
    const onGroupInvite = jest.fn();
    render(<ScanQRScreen onCancel={jest.fn()} onAdded={jest.fn()} onGroupInvite={onGroupInvite} />);

    const link = encodeGroupInviteLinkUniversal('g-456', 'Otro Grupo', 'ADM-9999-8888');
    act(() => {
      capturedOnScan!({ data: link, type: 'qr' });
    });

    expect(onGroupInvite).toHaveBeenCalledWith('g-456', 'Otro Grupo', 'ADM-9999-8888');
    expect(mockAddFromQR).not.toHaveBeenCalled();
  });

  it('shows an explicit alert when a group invite QR is scanned without onGroupInvite wired (wrong context)', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const onAdded = jest.fn();
    render(<ScanQRScreen onCancel={jest.fn()} onAdded={onAdded} />);

    const link = encodeGroupInviteLink('g-789', 'Grupo Equivocado', 'ADM-1234-5678');
    act(() => {
      capturedOnScan!({ data: link, type: 'qr' });
    });

    expect(alertSpy).toHaveBeenCalledTimes(1);
    const [title, desc] = alertSpy.mock.calls[0] as [string, string];
    expect(title).toBe('Group invitation');
    expect(desc).toMatch(/group invitation/i);
    expect(desc).not.toMatch(/Not an AegisLink QR/i);
    expect(mockAddFromQR).not.toHaveBeenCalled();
    expect(onAdded).not.toHaveBeenCalled();

    alertSpy.mockRestore();
  });

  it('still routes identity QR codes through addFromQR and does NOT call onGroupInvite', async () => {
    const onGroupInvite = jest.fn();
    mockAddFromQR.mockResolvedValue({ kind: 'added', contact: { aegisId: 'CKT-30J2-M3EE' } });

    render(<ScanQRScreen onCancel={jest.fn()} onAdded={jest.fn()} onGroupInvite={onGroupInvite} />);

    const key = 'A'.repeat(43) + '=';
    const link = encodeIdentityQR('CKT-30J2-M3EE', key);
    await act(async () => {
      capturedOnScan!({ data: link, type: 'qr' });
    });

    expect(onGroupInvite).not.toHaveBeenCalled();
    expect(mockAddFromQR).toHaveBeenCalledWith('CKT-30J2-M3EE', key);
  });
});
