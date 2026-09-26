/**
 * Slice 2b.3c — UnifiedPush endpoint binding (Android, no Google).
 *
 * Locks the properties that matter for privacy and for not losing wakes:
 *  - nothing is registered or sent until the user picked a distributor;
 *  - one UnifiedPush instance PER MAILBOX, so an endpoint is never bound to two
 *    epochs' or two profiles' mailboxes (R1);
 *  - the new instance is registered BEFORE the old ones are dropped (the
 *    connector forgets the distributor when its last registration goes);
 *  - an endpoint that arrives later is bound on the socket that asked;
 *  - only https endpoints are sent (the relay's SSRF guard refuses the rest);
 *  - off Android it is a no-op.
 */
type Listener = (payload: unknown) => void;
const mockListeners: Record<string, Listener[]> = {};
let mockOS = 'android';
const mockNative = {
  getDistributors: jest.fn(async (): Promise<string[]> => []),
  getSavedDistributor: jest.fn(async (): Promise<string | null> => null),
  saveDistributor: jest.fn(async () => true),
  register: jest.fn(async (_i: string) => true),
  unregister: jest.fn(async (_i: string) => true),
  getEndpoint: jest.fn(async (_i: string): Promise<string | null> => null),
  getInstances: jest.fn(async (): Promise<string[]> => []),
  removeDistributor: jest.fn(async () => true),
};

jest.mock('react-native', () => ({
  Platform: { get OS() { return mockOS; } },
  NativeModules: { get AegisUnifiedPush() { return mockOS === 'android' ? mockNative : undefined; } },
  DeviceEventEmitter: {
    addListener: (ev: string, cb: Listener) => {
      (mockListeners[ev] ??= []).push(cb);
      return { remove: () => {} };
    },
  },
  AppRegistry: { registerHeadlessTask: jest.fn() },
}));

import {
  bindUnifiedPushEndpoint,
  disableUnifiedPush,
  enableUnifiedPush,
  instanceFor,
  isUnifiedPushAvailable,
} from '../unifiedPush';

const MB1 = 'ab+c/def==';
const MB2 = 'zz+y/xw0=';
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  mockOS = 'android';
  for (const f of Object.values(mockNative)) f.mockClear();
  mockNative.getSavedDistributor.mockResolvedValue(null);
  mockNative.getEndpoint.mockResolvedValue(null);
  mockNative.getInstances.mockResolvedValue([]);
});

describe('UnifiedPush endpoint binding', () => {
  it('does nothing until the user picked a distributor', async () => {
    const emit = jest.fn();
    await bindUnifiedPushEndpoint({ emit }, MB1);
    expect(emit).not.toHaveBeenCalled();
    expect(mockNative.register).not.toHaveBeenCalled();
  });

  it('one instance per mailbox (R1): base64url of the mailbox id, different per epoch/profile', () => {
    expect(instanceFor(MB1)).toBe('mb-ab-c_def');
    expect(instanceFor(MB1)).not.toBe(instanceFor(MB2));
  });

  it('binds a known endpoint for THIS mailbox and retires the other instances', async () => {
    mockNative.getSavedDistributor.mockResolvedValue('io.heckel.ntfy');
    mockNative.getEndpoint.mockImplementation(async (i: string) =>
      i === instanceFor(MB1) ? 'https://ntfy.example/upAbc?up=1' : null,
    );
    mockNative.getInstances.mockResolvedValue([instanceFor(MB2), instanceFor(MB1)]);
    const emit = jest.fn();
    await bindUnifiedPushEndpoint({ emit }, MB1);
    expect(emit).toHaveBeenCalledWith('mailbox:push:endpoint', { mailboxId: MB1, endpoint: 'https://ntfy.example/upAbc?up=1' });
    expect(mockNative.unregister).toHaveBeenCalledWith(instanceFor(MB2));
    expect(mockNative.unregister).not.toHaveBeenCalledWith(instanceFor(MB1));
  });

  it('registers a new mailbox BEFORE dropping the old one, and binds the endpoint when it arrives', async () => {
    mockNative.getSavedDistributor.mockResolvedValue('io.heckel.ntfy');
    mockNative.getInstances.mockResolvedValue([instanceFor(MB1)]);
    const order: string[] = [];
    mockNative.register.mockImplementation(async (i: string) => (order.push(`register ${i}`), true));
    mockNative.unregister.mockImplementation(async (i: string) => (order.push(`unregister ${i}`), true));
    const emit = jest.fn();
    await bindUnifiedPushEndpoint({ emit }, MB2);
    expect(order).toEqual([`register ${instanceFor(MB2)}`, `unregister ${instanceFor(MB1)}`]);
    expect(emit).not.toHaveBeenCalled();

    // The distributor answers: native stores it and emits the event.
    mockNative.getEndpoint.mockResolvedValue('https://ntfy.example/upNew');
    for (const cb of mockListeners.AegisUnifiedPushEndpoint ?? []) cb('mb-unrelated');
    await flush();
    expect(emit).not.toHaveBeenCalled();
    for (const cb of mockListeners.AegisUnifiedPushEndpoint ?? []) cb(instanceFor(MB2));
    await flush();
    expect(emit).toHaveBeenCalledWith('mailbox:push:endpoint', { mailboxId: MB2, endpoint: 'https://ntfy.example/upNew' });
  });

  it('never sends a non-https endpoint', async () => {
    mockNative.getSavedDistributor.mockResolvedValue('io.heckel.ntfy');
    mockNative.getEndpoint.mockResolvedValue('http://10.0.0.1/up');
    const emit = jest.fn();
    await bindUnifiedPushEndpoint({ emit }, MB1);
    expect(emit).not.toHaveBeenCalled();
  });

  it('opt-in saves the distributor; opt-out unregisters everything and forgets it', async () => {
    await enableUnifiedPush('io.heckel.ntfy');
    expect(mockNative.saveDistributor).toHaveBeenCalledWith('io.heckel.ntfy');
    await disableUnifiedPush();
    expect(mockNative.removeDistributor).toHaveBeenCalled();
  });

  it('is a no-op off Android', async () => {
    mockOS = 'ios';
    expect(isUnifiedPushAvailable()).toBe(false);
    const emit = jest.fn();
    await bindUnifiedPushEndpoint({ emit }, MB1);
    await disableUnifiedPush();
    expect(emit).not.toHaveBeenCalled();
    expect(mockNative.removeDistributor).not.toHaveBeenCalled();
  });
});
