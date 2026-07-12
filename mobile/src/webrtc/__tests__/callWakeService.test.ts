/**
 * callWakeService — Android persistent call-wake FGS control.
 *
 *   1. start/stop drive the native module and track _running (idempotent)
 *   2. no-op on iOS (native() returns null)
 *   3. no-op when the native module is absent (Expo Go / tests)
 */

const mockStart = jest.fn(async () => true);
const mockStop = jest.fn(async () => true);

let mockPlatformOS = 'android';
let mockHasNativeModule = true;

jest.mock('react-native', () => ({
  get NativeModules() {
    return mockHasNativeModule ? { AegisWakeService: { start: mockStart, stop: mockStop } } : {};
  },
  Platform: { get OS() { return mockPlatformOS; } },
}));

import {
  startCallWakeService,
  stopCallWakeService,
  isCallWakeServiceRunning,
} from '../callWakeService';

beforeEach(() => {
  jest.clearAllMocks();
  mockPlatformOS = 'android';
  mockHasNativeModule = true;
  // reset internal _running by stopping if it thinks it's running
  stopCallWakeService();
  jest.clearAllMocks();
});

describe('callWakeService', () => {
  it('start() calls native start once and marks running; stop() calls native stop', async () => {
    startCallWakeService();
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(isCallWakeServiceRunning()).toBe(true);

    // idempotent: a second start while running does not re-call native
    startCallWakeService();
    expect(mockStart).toHaveBeenCalledTimes(1);

    stopCallWakeService();
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(isCallWakeServiceRunning()).toBe(false);
  });

  it('is a no-op on iOS', () => {
    mockPlatformOS = 'ios';
    startCallWakeService();
    expect(mockStart).not.toHaveBeenCalled();
    expect(isCallWakeServiceRunning()).toBe(false);
  });

  it('is a no-op when the native module is absent', () => {
    mockHasNativeModule = false;
    startCallWakeService();
    expect(mockStart).not.toHaveBeenCalled();
    expect(isCallWakeServiceRunning()).toBe(false);
  });
});
