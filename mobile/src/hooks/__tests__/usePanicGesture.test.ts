/**
 * usePanicGesture — gesture-trigger logic tests.
 *
 * Covers the configured gestures plus the off state:
 *   - 'tap': exactly TAP_COUNT_REQUIRED taps inside the window fire onTrigger
 *     DIRECTLY (no dialog — the trigger lives only on the lock-screen logo, so
 *     3 deliberate taps are unambiguous); fewer taps never do.
 *   - 'hold': registerLongPress fires onTrigger directly (no dialog — a 3s
 *     intentional press already implies intent).
 *   - 'shake': accident-prone, so it shows the confirmation dialog first; only
 *     confirming fires onTrigger.
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

// Accelerometer (shake gesture) — capture the listener the hook registers so a
// test can feed it a synthetic measurement. `mock`-prefixed so jest allows the
// factory to reference it; virtual so it works whether or not expo-sensors is
// installed in the test environment.
type AccelListener = (m: { x: number; y: number; z: number }) => void;
let mockAccelListener: AccelListener | null = null;
const mockAccelRemove = jest.fn();
jest.mock('expo-sensors', () => ({
  Accelerometer: {
    setUpdateInterval: jest.fn(),
    addListener: (cb: AccelListener) => { mockAccelListener = cb; return { remove: mockAccelRemove }; },
  },
}), { virtual: true });

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
  mockAccelListener = null;
});

describe("gesture === 'tap'", () => {
  it('3 rapid taps fire onTrigger directly, without a dialog', async () => {
    configureGesture('tap');
    const onTrigger = jest.fn();
    const { result } = renderHook(() => usePanicGesture(onTrigger));
    await waitFor(() => expect(mockSsGet).toHaveBeenCalled());

    act(() => {
      result.current.registerTap();
      result.current.registerTap();
      result.current.registerTap();
    });

    // Triple-tap lives only on the lock-screen logo → deliberate, so it fires
    // immediately with NO confirmation. (Only shake routes through a dialog.)
    expect(mockThemedAlert).not.toHaveBeenCalled();
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('2 taps fire nothing', async () => {
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

describe("gesture === 'shake'", () => {
  it('a strong shake shows the confirm; only confirming fires onTrigger', async () => {
    configureGesture('shake');
    const onTrigger = jest.fn();
    renderHook(() => usePanicGesture(onTrigger));
    // setup() reads config async, then registers the accelerometer listener.
    await waitFor(() => expect(mockAccelListener).not.toBeNull());

    // magnitude = sqrt(3²+3²+3²) ≈ 5.2 g > SHAKE_THRESHOLD (2.8)
    act(() => { mockAccelListener!({ x: 3, y: 3, z: 3 }); });

    // Shake is accident-prone (pocket, walking), so it MUST confirm first.
    expect(mockThemedAlert).toHaveBeenCalledTimes(1);
    expect(onTrigger).not.toHaveBeenCalled();
    pressConfirmDelete();
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('a gentle movement below threshold does nothing', async () => {
    configureGesture('shake');
    const onTrigger = jest.fn();
    renderHook(() => usePanicGesture(onTrigger));
    await waitFor(() => expect(mockAccelListener).not.toBeNull());

    // magnitude = sqrt(1²+1²+1²) ≈ 1.73 g < 2.8
    act(() => { mockAccelListener!({ x: 1, y: 1, z: 1 }); });

    expect(mockThemedAlert).not.toHaveBeenCalled();
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
