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
    answerIncomingCall: jest.fn(),
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
import { initCallKeep, displayIncomingCall, answerNativeCall, hasNativeCall, endNativeCall } from '../callkeep';

const mockCallKeep = RNCallKeep as unknown as {
  setup: jest.Mock;
  displayIncomingCall: jest.Mock;
  answerIncomingCall: jest.Mock;
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
});

/**
 * Answering a CallKit-displayed call MUST fulfil the CXAnswerCallAction, because
 * that is the only thing that activates the AVAudioSession (RNCallKeep.m
 * performAnswerCallAction → configureAudioSession). Field bug 2026-08-07:
 * accepting from our own screen skipped it, so incoming calls connected mute.
 */
describe('callkeep — answering hands the audio session back to CallKit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('answerNativeCall fulfils the answer action for a call CallKit is showing', () => {
    displayIncomingCall('audio-uuid', 'peer', 'Peer', false);
    expect(hasNativeCall('audio-uuid')).toBe(true);

    answerNativeCall('audio-uuid');

    expect(mockCallKeep.answerIncomingCall).toHaveBeenCalledTimes(1);
    expect(mockCallKeep.answerIncomingCall).toHaveBeenCalledWith('audio-uuid');
  });

  it('answerNativeCall is a no-op when CallKit never showed the call', () => {
    // Foreground path: our own screen rang it, so our own audio handling applies
    // — telling CallKit to answer a call it does not know about would throw.
    expect(hasNativeCall('never-shown')).toBe(false);

    answerNativeCall('never-shown');

    expect(mockCallKeep.answerIncomingCall).not.toHaveBeenCalled();
  });

  it('hasNativeCall clears once the call is torn down', () => {
    displayIncomingCall('teardown-uuid', 'peer', 'Peer', false);
    expect(hasNativeCall('teardown-uuid')).toBe(true);

    endNativeCall('teardown-uuid');

    expect(hasNativeCall('teardown-uuid')).toBe(false);
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
