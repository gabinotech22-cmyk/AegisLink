/**
 * push.ts — ACCEPT_CALL / DECLINE_CALL notification action regression tests
 *
 * Field bug: pressing "Contestar"/"Rechazar" on the incoming-call notification
 * (whether the app was minimized-but-alive or fully killed) never actually
 * answered or declined the call — it just opened the 1:1 chat. Root cause:
 * the `aegislink-call` notification category registers ACCEPT_CALL/DECLINE_CALL
 * buttons, but addNotificationResponseReceivedListener never checked for those
 * action identifiers; the only call-related branch checked
 * `data?.type === 'call_invite'`, a value neither the local notification
 * (`type: 'call'`) nor the server wake push (`kind: 'call_wakeup'`) ever sets —
 * dead code.
 *
 * The fix adds explicit ACCEPT_CALL/DECLINE_CALL branches that either act
 * directly (offer already local — app was alive in background) or mark
 * `pendingAction` + reconnect (offer not arrived yet — app was killed), so
 * `processIncomingInvite` (socket/calls.ts) can act the instant the relay
 * redelivers the queued invite.
 */

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn().mockResolvedValue(undefined),
  setNotificationCategoryAsync: jest.fn().mockResolvedValue(undefined),
  addNotificationResponseReceivedListener: jest.fn(),
  getLastNotificationResponseAsync: jest.fn().mockResolvedValue(null),
  getPermissionsAsync: jest.fn().mockResolvedValue({ granted: false, canAskAgain: false }),
  scheduleNotificationAsync: jest.fn().mockResolvedValue('notif-id-1'),
  dismissNotificationAsync: jest.fn().mockResolvedValue(undefined),
  AndroidImportance: { HIGH: 4, MAX: 5 },
  AndroidNotificationPriority: { MAX: 'max' },
}));
jest.mock('../../config', () => ({ SERVER_URL: 'https://example.test' }));

const mockCallState = {
  status: 'idle' as string,
  pendingOffer: null as string | null,
  peer: null as string | null,
  pendingAction: null as 'accept' | 'decline' | null,
  setPendingAction: jest.fn((a: 'accept' | 'decline' | null) => { mockCallState.pendingAction = a; }),
};
jest.mock('../../store/call', () => ({ useCall: { getState: () => mockCallState } }));

jest.mock('../../store/identity', () => ({
  useIdentity: { getState: () => ({ identity: { aegisId: 'me' } }) },
}));

const mockConnect = jest.fn();
const mockIsConnected = jest.fn().mockReturnValue(false);
jest.mock('../../socket/client', () => ({
  connect: (...args: unknown[]) => mockConnect(...args),
  isConnected: () => mockIsConnected(),
}));

const mockAcceptCall = jest.fn();
const mockEndCall = jest.fn();
jest.mock('../../socket/calls', () => ({
  acceptCall: (...args: unknown[]) => mockAcceptCall(...args),
  endCall: (...args: unknown[]) => mockEndCall(...args),
}));

import * as Notifications from 'expo-notifications';
import { registerForPush } from '../push';
import type { Identity } from '../../crypto/identity';

const mockAddListener = Notifications.addNotificationResponseReceivedListener as jest.Mock;

function fakeResponse(actionIdentifier: string, data: Record<string, unknown>) {
  return {
    actionIdentifier,
    notification: { request: { content: { data }, identifier: 'notif-1' } },
  };
}

describe('push.ts — ACCEPT_CALL / DECLINE_CALL notification actions', () => {
  // attachLocalNotificationHandlers() (and thus addNotificationResponseReceivedListener)
  // is idempotent — registered once per module lifetime, exactly like in
  // production (App.tsx calls registerForPush once). Capture the listener a
  // single time and reuse it; per-test jest.clearAllMocks() would otherwise
  // wipe the recorded registration call before later tests could read it.
  let listener: (response: unknown) => void;

  beforeAll(async () => {
    await registerForPush({ aegisId: 'me' } as Identity);
    listener = mockAddListener.mock.calls[0][0] as (response: unknown) => void;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCallState.status = 'idle';
    mockCallState.pendingOffer = null;
    mockCallState.peer = null;
    mockCallState.pendingAction = null;
    mockIsConnected.mockReturnValue(false);
  });

  it('ACCEPT_CALL answers directly when the offer already arrived (app alive in background)', () => {
    mockCallState.status = 'incoming-ringing';
    mockCallState.pendingOffer = 'sdp-offer';
    mockCallState.peer = 'caller-1';

    listener(fakeResponse('ACCEPT_CALL', { fromAegisId: 'caller-1', type: 'call', isVideo: false }));

    expect(mockAcceptCall).toHaveBeenCalledTimes(1);
    expect(mockCallState.setPendingAction).not.toHaveBeenCalled();
  });

  it('DECLINE_CALL ends the call directly when the offer already arrived', () => {
    mockCallState.status = 'incoming-ringing';
    mockCallState.pendingOffer = 'sdp-offer';
    mockCallState.peer = 'caller-1';

    listener(fakeResponse('DECLINE_CALL', { fromAegisId: 'caller-1', type: 'call', isVideo: false }));

    expect(mockEndCall).toHaveBeenCalledWith('declined');
  });

  it('acting on the notification retracts that call banner up front (by callId)', () => {
    mockCallState.status = 'incoming-ringing';
    mockCallState.pendingOffer = 'sdp-offer';
    mockCallState.peer = 'caller-1';
    const mockDismiss = Notifications.dismissNotificationAsync as jest.Mock;

    listener(fakeResponse('ACCEPT_CALL', { fromAegisId: 'caller-1', type: 'call', callId: 'call-42' }));

    // Deterministic id keyed by callId — the same one showIncomingCallNotification used.
    expect(mockDismiss).toHaveBeenCalledWith('incoming-call-call-42');
  });

  it('ACCEPT_CALL marks pendingAction and reconnects when no offer has arrived yet (killed app)', () => {
    listener(fakeResponse('ACCEPT_CALL', { kind: 'call_wakeup' }));

    expect(mockAcceptCall).not.toHaveBeenCalled();
    expect(mockCallState.pendingAction).toBe('accept');
    expect(mockConnect).toHaveBeenCalledWith({ aegisId: 'me' });
  });

  it('DECLINE_CALL marks pendingAction and reconnects when no offer has arrived yet (killed app)', () => {
    listener(fakeResponse('DECLINE_CALL', { kind: 'call_wakeup' }));

    expect(mockEndCall).not.toHaveBeenCalled();
    expect(mockCallState.pendingAction).toBe('decline');
    expect(mockConnect).toHaveBeenCalledWith({ aegisId: 'me' });
  });

  it('a plain tap on the call notification body does not auto-accept or auto-decline', () => {
    mockCallState.status = 'incoming-ringing';
    mockCallState.pendingOffer = 'sdp-offer';
    mockCallState.peer = 'caller-1';

    listener(fakeResponse('expo.modules.notifications.actions.DEFAULT', {
      fromAegisId: 'caller-1', type: 'call', isVideo: false,
    }));

    expect(mockAcceptCall).not.toHaveBeenCalled();
    expect(mockEndCall).not.toHaveBeenCalled();
  });
});
