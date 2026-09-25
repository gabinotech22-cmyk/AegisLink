/**
 * RelayQrScanner — the camera modal behind "Scan relay QR" in My relay.
 *
 * What it must guarantee:
 *   - the QR printed by infra/selfhost/show-qr.sh (`http://<56>.onion`) is
 *     handed back as the canonical onion host, once;
 *   - anything else (a contact link, a group invite, a clearnet URL) is
 *     rejected with a hint and NEVER reaches the screen — the scanner only
 *     reads relay addresses;
 *   - without camera permission it asks for it instead of opening the camera.
 */
import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000', text: '#fff', textDim: '#aaa', accent: '#05b875', danger: '#f33',
      font: 'System', fontMono: 'monospace', fontDisplay: 'System',
    },
  }),
}));
jest.mock('../icons', () => ({ I: new Proxy({}, { get: () => () => null }) }));
jest.mock('../Button', () => {
  const React = require('react') as typeof import('react');
  const { Pressable, Text } = require('react-native') as typeof import('react-native');
  return {
    PrimaryButton: ({ label, onPress }: { label: string; onPress?: () => void }) =>
      React.createElement(Pressable, { onPress, testID: `btn:${label}` }, React.createElement(Text, null, label)),
  };
});

const mockPermission = { granted: true };
const mockRequestPermission = jest.fn();
let capturedOnScan: ((r: { data: string; type: string }) => void) | null = null;
jest.mock('expo-camera', () => {
  const React = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  return {
    useCameraPermissions: () => [mockPermission, mockRequestPermission],
    CameraView: ({ onBarcodeScanned }: { onBarcodeScanned: (r: { data: string; type: string }) => void }) => {
      capturedOnScan = onBarcodeScanned;
      return React.createElement(View, { testID: 'camera-view' });
    },
  };
});

import { RelayQrScanner } from '../RelayQrScanner';

const ONION = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwx.onion';

function scan(data: string) {
  act(() => { capturedOnScan?.({ data, type: 'qr' }); });
}

describe('RelayQrScanner', () => {
  beforeEach(() => {
    mockPermission.granted = true;
    mockRequestPermission.mockReset();
    capturedOnScan = null;
  });

  it('hands back the canonical onion from the QR that show-qr.sh prints', () => {
    const onOnion = jest.fn();
    render(<RelayQrScanner visible onClose={jest.fn()} onOnion={onOnion} />);
    scan(`http://${ONION.toUpperCase()}/`);
    expect(onOnion).toHaveBeenCalledTimes(1);
    expect(onOnion).toHaveBeenCalledWith(ONION);
  });

  it('rejects a contact link, a group invite and a clearnet URL without calling back', () => {
    const onOnion = jest.fn();
    const { getByTestId } = render(<RelayQrScanner visible onClose={jest.fn()} onOnion={onOnion} />);
    for (const data of [
      `aegislink://v2/ABC-DEFG-HJKM/${'A'.repeat(43)}=/${ONION}/${'B'.repeat(43)}=`,
      'aegislink://group/v1/g1/Family/ADMIN',
      'https://evil.example/relay',
      `http://${'a'.repeat(55)}.onion`,
    ]) {
      scan(data);
      expect(getByTestId('relay-qr-hint').props.children).toBe('relaySettings.scanNotRelay');
    }
    expect(onOnion).not.toHaveBeenCalled();
  });

  it('ignores the same code fired repeatedly by the camera', () => {
    const onOnion = jest.fn();
    render(<RelayQrScanner visible onClose={jest.fn()} onOnion={onOnion} />);
    scan('not a relay');
    scan('not a relay');
    scan(`http://${ONION}`);
    expect(onOnion).toHaveBeenCalledTimes(1);
  });

  it('asks for camera permission instead of opening the camera', () => {
    mockPermission.granted = false;
    const { getByTestId, queryByTestId } = render(<RelayQrScanner visible onClose={jest.fn()} onOnion={jest.fn()} />);
    expect(queryByTestId('camera-view')).toBeNull();
    fireEvent.press(getByTestId('btn:scanQR.allowCameraBtn'));
    expect(mockRequestPermission).toHaveBeenCalled();
  });

  it('closes on X', () => {
    const onClose = jest.fn();
    const { getByTestId } = render(<RelayQrScanner visible onClose={onClose} onOnion={jest.fn()} />);
    fireEvent.press(getByTestId('relay-qr-close'));
    expect(onClose).toHaveBeenCalled();
  });
});
