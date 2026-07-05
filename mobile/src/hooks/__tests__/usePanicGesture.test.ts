/**
 * usePanicGesture — gesture-trigger logic tests.
 *
 * Covers the three configured gestures plus the off state:
 *   - 'tap': exactly TAP_COUNT_REQUIRED taps inside the window show the
 *     confirmation; confirming fires onTrigger; fewer taps never do.
 *   - 'hold': registerLongPress fires onTrigger directly (no dialog — a 3s
 *     intentional press already implies intent).
 *   - 'off' / no config: neither entry point does anything.
 * The gesture is read from SecureStore config at mount (async), so each test
 * waits for the setup effect before poking the returned callbacks.
 */
import { renderHook, waitFor, act } from '@testing-library/react-native';

const mockSsGet = jest.fn();
jest.mock('../../utils/secureStore', () => ({
  ss: {
    get: (...a: unknown[]) => mockSsGet(...a),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  },
}));

type AlertButton = { text: string; style?: string; onPress?: () => void };
const mockThemedAlert = jest.fn();
jest.mock('../../components/AlertHost', () => ({
  themedAlert: (...a: unknown[]) => mockThemedAlert(...a),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
}));

import { usePanicGesture } from '../usePanicGesture';

function configureGesture(gesture: string | null) {
  mockSsGet.mockResolvedValue(gesture === null ? null : JSON.stringify({ gesture }));
}

/** The destructive button of the confirm dialog (what actually wipes). */
function pressConfirmDelete(): void {
  const buttons = mockThemedAlert.mock.calls[0][2] as AlertButton[];
  const destructive = buttons.find((b) => b.style === 'destructive');
  destructive?.onPress?.();
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("gesture === 'tap'", () => {
  it('3 rapid taps show the confirm; confirming fires onTrigger', async () => {
    configureGesture('tap');
    const onTrigger = jest.fn();
    const { result } = renderHook(() => usePanicGesture(onTrigger));
    await waitFor(() => expect(mockSsGet).toHaveBeenCalled());

    act(() => {
      result.current.registerTap();
      result.current.registerTap();
      result.current.registerTap();
    });

    expect(mockThemedAlert).toHaveBeenCalledTimes(1);
    // The wipe must NOT run until the user confirms the dialog.
    expect(onTrigger).not.toHaveBeenCalled();
    pressConfirmDelete();
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('2 taps never show the confirm', async () => {
    configureGesture('tap');
    const onTrigger = jest.fn();
    const { result } = renderHook(() => usePanicGesture(onTrigger));
    await waitFor(() => expect(mockSsGet).toHaveBeenCalled());

    act(() => {
      result.current.registerTap();
      result.current.registerTap();
    });

    expect(mockThemedAlert).not.toHaveBeenCalled();
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('registerLongPress is a no-op when gesture is tap', async () => {
    configureGesture('tap');
    const onTrigger = jest.fn();
    const { result } = renderHook(() => usePanicGesture(onTrigger));
    await waitFor(() => expect(mockSsGet).toHaveBeenCalled());

    act(() => { result.current.registerLongPress(); });
    expect(onTrigger).not.toHaveBeenCalled();
  });
});

describe("gesture === 'hold'", () => {
  it('registerLongPress fires onTrigger directly, without a dialog', async () => {
    configureGesture('hold');
    const onTrigger = jest.fn();
    const { result } = renderHook(() => usePanicGesture(onTrigger));
    await waitFor(() => expect(mockSsGet).toHaveBeenCalled());

    act(() => { result.current.registerLongPress(); });
    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(mockThemedAlert).not.toHaveBeenCalled();
  });

  it('registerTap is a no-op when gesture is hold', async () => {
    configureGesture('hold');
    const onTrigger = jest.fn();
    const { result } = renderHook(() => usePanicGesture(onTrigger));
    await waitFor(() => expect(mockSsGet).toHaveBeenCalled());

    act(() => {
      result.current.registerTap();
      result.current.registerTap();
      result.current.registerTap();
    });
    expect(mockThemedAlert).not.toHaveBeenCalled();
    expect(onTrigger).not.toHaveBeenCalled();
  });
});

describe('gesture off / unconfigured', () => {
  it.each([['off'], [null]])('neither taps nor long-press fire (config: %s)', async (g) => {
    configureGesture(g as string | null);
    const onTrigger = jest.fn();
    const { result } = renderHook(() => usePanicGesture(onTrigger));
    await waitFor(() => expect(mockSsGet).toHaveBeenCalled());

    act(() => {
      result.current.registerTap();
      result.current.registerTap();
      result.current.registerTap();
      result.current.registerLongPress();
    });
    expect(mockThemedAlert).not.toHaveBeenCalled();
    expect(onTrigger).not.toHaveBeenCalled();
  });
});
