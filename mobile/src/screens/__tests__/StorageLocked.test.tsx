/**
 * StorageLockedScreen — the two exits are destructive and go through an
 * explicit confirmation; cancelling touches nothing.
 */
import { render, fireEvent, waitFor } from '@testing-library/react-native';

type AlertButton = { text: string; style?: string; onPress?: () => void };
const mockThemedAlert = jest.fn();
jest.mock('../../components/AlertHost', () => ({
  themedAlert: (...a: unknown[]) => mockThemedAlert(...a),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000', surface: '#111', surface2: '#222', text: '#fff', textDim: '#aaa',
      textFaint: '#666', accent: '#05b875', accentDeep: '#0a2e1e', accentInk: '#000',
      danger: '#e63946', warn: '#f59e0b', border: '#222', borderStrong: '#333',
      divider: '#1a1a1a', radius: 12, radiusS: 8, font: 'System', fontMono: 'monospace',
      fontDisplay: 'System',
    },
  }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import { StorageLockedScreen } from '../StorageLocked';

function lastAlertButtons(): AlertButton[] {
  const call = mockThemedAlert.mock.calls[mockThemedAlert.mock.calls.length - 1] as [string, string, AlertButton[]];
  return call[2];
}

beforeEach(() => mockThemedAlert.mockReset());

describe('StorageLockedScreen', () => {
  it('reset: asks first, runs onReset only on the destructive confirm', async () => {
    const onReset = jest.fn().mockResolvedValue(undefined);
    const onRestore = jest.fn().mockResolvedValue(undefined);
    const { getByText } = render(<StorageLockedScreen onReset={onReset} onRestore={onRestore} />);

    fireEvent.press(getByText('storageLocked.reset'));
    expect(onReset).not.toHaveBeenCalled();
    const buttons = lastAlertButtons();
    expect(buttons.map((b) => b.style)).toEqual(['cancel', 'destructive']);

    buttons[0].onPress?.(); // cancel
    expect(onReset).not.toHaveBeenCalled();

    fireEvent.press(getByText('storageLocked.reset'));
    lastAlertButtons()[1].onPress?.();
    await waitFor(() => expect(onReset).toHaveBeenCalledTimes(1));
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('restore: same confirmation, runs onRestore', async () => {
    const onReset = jest.fn().mockResolvedValue(undefined);
    const onRestore = jest.fn().mockResolvedValue(undefined);
    const { getByText } = render(<StorageLockedScreen onReset={onReset} onRestore={onRestore} />);

    fireEvent.press(getByText('storageLocked.restore'));
    lastAlertButtons()[1].onPress?.();
    await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1));
    expect(onReset).not.toHaveBeenCalled();
  });
});
