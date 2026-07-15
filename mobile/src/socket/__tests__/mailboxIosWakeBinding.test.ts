/**
 * Slice 2b.4 — iOS wake-token binding gating.
 *
 * registerIosWakeBinding must ONLY emit `mailbox:push:token` when the client
 * flag (EXPO_PUBLIC_MAILBOX_IOS_WAKE=on) is set AND the platform is iOS AND a
 * push token exists. The reduct (stable Expo token next to rotating mailbox
 * ids) must never activate outside that double opt-in — these tests lock the
 * fail-closed behaviour.
 */

const ORIG_ENV = process.env.EXPO_PUBLIC_MAILBOX_IOS_WAKE;

let mockToken: string | null = 'ExponentPushToken[test-token]';
jest.mock('../../notifications/push', () => ({
  getLastExpoToken: () => mockToken,
}));

// Minimal RN surface: Platform.OS mutable per test; AppState listener no-op.
let mockOS = 'ios';
jest.mock('react-native', () => ({
  Platform: { get OS() { return mockOS; } },
  AppState: { addEventListener: jest.fn(), currentState: 'active' },
}));

jest.mock('../../net/tor', () => ({
  TorSioSocket: class {},
  isTorAvailable: () => false,
  startTor: async () => {},
  onTorStatus: () => () => {},
}));
jest.mock('../../crypto/mailboxStore', () => ({
  getOwnCurrentMailbox: jest.fn(),
  getOwnMailboxesForEpochs: jest.fn(),
  getLastMailboxConnectEpoch: jest.fn(),
  setLastMailboxConnectEpoch: jest.fn(),
}));

function load(flag: string | undefined) {
  jest.resetModules();
  if (flag === undefined) delete process.env.EXPO_PUBLIC_MAILBOX_IOS_WAKE;
  else process.env.EXPO_PUBLIC_MAILBOX_IOS_WAKE = flag;
  return require('../mailboxSocket') as typeof import('../mailboxSocket');
}

afterAll(() => {
  if (ORIG_ENV === undefined) delete process.env.EXPO_PUBLIC_MAILBOX_IOS_WAKE;
  else process.env.EXPO_PUBLIC_MAILBOX_IOS_WAKE = ORIG_ENV;
});

describe('registerIosWakeBinding — double opt-in gating', () => {
  beforeEach(() => {
    mockOS = 'ios';
    mockToken = 'ExponentPushToken[test-token]';
  });

  it('emits the binding when flag=on + iOS + token present', () => {
    const { registerIosWakeBinding } = load('on');
    const emit = jest.fn();
    registerIosWakeBinding({ emit }, 'mb-epoch-1');
    expect(emit).toHaveBeenCalledWith('mailbox:push:token', {
      mailboxId: 'mb-epoch-1',
      expoToken: 'ExponentPushToken[test-token]',
    });
  });

  it('never emits with the flag off (fail-closed default)', () => {
    const { registerIosWakeBinding } = load(undefined);
    const emit = jest.fn();
    registerIosWakeBinding({ emit }, 'mb-epoch-1');
    expect(emit).not.toHaveBeenCalled();
  });

  it('never emits on Android (reduct-free coverage exists there)', () => {
    mockOS = 'android';
    const { registerIosWakeBinding } = load('on');
    const emit = jest.fn();
    registerIosWakeBinding({ emit }, 'mb-epoch-1');
    expect(emit).not.toHaveBeenCalled();
  });

  it('no-op when no push token was acquired', () => {
    mockToken = null;
    const { registerIosWakeBinding } = load('on');
    const emit = jest.fn();
    registerIosWakeBinding({ emit }, 'mb-epoch-1');
    expect(emit).not.toHaveBeenCalled();
  });
});
