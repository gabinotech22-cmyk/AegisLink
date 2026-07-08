/**
 * callkeep.test.ts — iOS CallKit integration (calls/callkeep.ts).
 *
 * Guards the two zero-metadata invariants that make CallKit acceptable under
 * AegisLink's "no metadata at the OS layer" principle:
 *
 *   1. setup() disables Recents (`includesCallsInRecents: false`) — calls are
 *      NEVER written to the iOS system call log.
 *   2. displayIncomingCall() shows GENERIC labels — the caller's real aegisId /
 *      contact name is NEVER handed to CallKit (which would leak it to the OS
 *      call UI, lock screen, and Siri). Regression for security golden rule #2.
 */

// Native module + runtime mocks. NOTE: the mock object is defined INSIDE the
// factory — the factory runs at import time, before any top-level `const` would
// be initialized (jest hoists jest.mock above imports).
jest.mock('react-native-callkeep', () => ({
  __esModule: true,
  default: {
    setup: jest.fn(() => Promise.resolve(true)),
    addEventListener: jest.fn(),
    displayIncomingCall: jest.fn(),
    setCurrentCallActive: jest.fn(),
    endCall: jest.fn(),
    setMutedCall: jest.fn(),
  },
}));
jest.mock('../../runtime', () => ({ IS_EXPO_GO: false, WEBRTC_AVAILABLE: true }));
jest.mock('../../socket/calls', () => ({
  acceptCall: jest.fn(),
  endCall: jest.fn(),
  toggleMute: jest.fn(),
}));

import RNCallKeep from 'react-native-callkeep';
import { initCallKeep, displayIncomingCall } from '../callkeep';

const mockCallKeep = RNCallKeep as unknown as {
  setup: jest.Mock;
  displayIncomingCall: jest.Mock;
};

describe('callkeep — zero-metadata CallKit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('setup keeps calls OUT of the iOS Recents / system call log', () => {
    initCallKeep();
    expect(mockCallKeep.setup).toHaveBeenCalledTimes(1);
    const opts = mockCallKeep.setup.mock.calls[0][0];
    expect(opts.ios.includesCallsInRecents).toBe(false);
  });

  it('displayIncomingCall never leaks the caller identity to CallKit', () => {
    const realAegisId = 'aegis1secretidentity9999';
    const realName = 'Alice Realname';

    displayIncomingCall('call-uuid-1', realAegisId, realName, false);

    expect(mockCallKeep.displayIncomingCall).toHaveBeenCalledTimes(1);
    const args = mockCallKeep.displayIncomingCall.mock.calls[0];
    // args = [uuid, handle, localizedCallerName, handleType, hasVideo]
    expect(args[0]).toBe('call-uuid-1');
    expect(args[1]).not.toBe(realAegisId);
    expect(args[2]).not.toBe(realName);
    // The whole call must not contain the real identity anywhere.
    expect(JSON.stringify(args)).not.toContain(realAegisId);
    expect(JSON.stringify(args)).not.toContain(realName);
  });

  it('displayIncomingCall is idempotent per callId (PushKit + socket dedupe)', () => {
    displayIncomingCall('dup-uuid', 'x', 'y', false);
    displayIncomingCall('dup-uuid', 'x', 'y', false);
    expect(mockCallKeep.displayIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('retries setup after a transient failure (does not latch on reject)', async () => {
    // Fresh module so _setupDone starts false, independent of earlier tests.
    jest.resetModules();
    const RNCallKeepFresh = (require('react-native-callkeep') as { default: { setup: jest.Mock } }).default;
    RNCallKeepFresh.setup
      .mockImplementationOnce(() => Promise.reject(new Error('transient')))
      .mockImplementationOnce(() => Promise.resolve(true));
    const { initCallKeep: initFresh } = require('../callkeep') as typeof import('../callkeep');

    initFresh();
    await new Promise((r) => setImmediate(r)); // let the rejected setup settle
    expect(RNCallKeepFresh.setup).toHaveBeenCalledTimes(1);

    initFresh(); // must retry because the failed setup left _setupDone false
    await new Promise((r) => setImmediate(r));
    expect(RNCallKeepFresh.setup).toHaveBeenCalledTimes(2);
  });
});
