/**
 * mailboxSocket — dedicated mailbox delivery socket (Fase 4 Slice 4).
 *
 * Pins the wire protocol against the server (handleMailboxConnection):
 *   - fail-closed gating: no connection unless MAILBOX_ENABLED (mode on + Tor).
 *   - handshake carries { mailboxId, mailboxSignPubKey } and NO aegisId.
 *   - a relay challenge is answered with an Ed25519 proof that VERIFIES against
 *     the same mailbox signing key (round-trips through the real mailbox.ts).
 *   - auth:ok flips isMailboxAuthed; sendViaMailbox refuses before auth.
 *   - incoming envelope:mb is handed to the onEnvelope callback.
 *
 * The native embedded-Tor bridge (`../../net/tor`) is mocked to a controllable
 * fake `TorSioSocket`; config is mocked to toggle the gate. mailbox.ts is REAL
 * so the signature check is meaningful.
 */

import { deriveMailbox, verifyMailboxAuth, epochFor, type Mailbox } from '../../crypto/mailbox';
import { decodeBase64 } from 'tweetnacl-util';

// ── Controllable fake socket (stands in for TorSioSocket) ───────────────────
type Handler = (...args: unknown[]) => void;
class FakeSocket {
  connected = false;
  handlers = new Map<string, Handler[]>();
  emitted: Array<{ event: string; payload: unknown; ack?: Handler }> = [];
  on(event: string, h: Handler) { const a = this.handlers.get(event) ?? []; a.push(h); this.handlers.set(event, a); return this; }
  emit(event: string, payload?: unknown, ack?: Handler) { this.emitted.push({ event, payload, ack }); return this; }
  removeAllListeners() { this.handlers.clear(); }
  disconnect() { this.connected = false; }
  /** Test helper: fire a server→client event. */
  fire(event: string, ...args: unknown[]) { for (const h of this.handlers.get(event) ?? []) h(...args); }
}

let lastSocket: FakeSocket | null = null;
let lastIoArgs: { url: string; opts: Record<string, unknown> } | null = null;
const mockTorSioSocket = jest.fn((url: string, auth: Record<string, unknown>) => {
  lastSocket = new FakeSocket();
  lastIoArgs = { url, opts: auth };
  return lastSocket;
});
const mockStartTor = jest.fn(async () => ({ state: 'on' as const, socksPort: 9050 }));
jest.mock('../../net/tor', () => ({
  __esModule: true,
  isTorAvailable: () => true,
  startTor: () => mockStartTor(),
  TorSioSocket: function (this: unknown, url: string, auth: Record<string, unknown>) {
    return mockTorSioSocket(url, auth);
  },
}));

// Config gate — mutated per test via the mock object below.
const mockConfig = { ONION_URL: 'http://onion.test', MAILBOX_ENABLED: true };
jest.mock('../../config', () => ({
  __esModule: true,
  get ONION_URL() { return mockConfig.ONION_URL; },
  get MAILBOX_ENABLED() { return mockConfig.MAILBOX_ENABLED; },
}));

// A deterministic mailbox from a fixed root, returned by the store mock.
const mockRoot = new Uint8Array(32).fill(7);
let mockMailbox: Mailbox;
let mockLastEpoch: number | null = null;
const mockEpochMailboxes = (epochs: number[]): Mailbox[] => epochs.map((e) => deriveMailbox(mockRoot, e));
jest.mock('../../crypto/mailboxStore', () => ({
  __esModule: true,
  getOwnCurrentMailbox: jest.fn(async () => mockMailbox),
  getOwnMailboxesForEpochs: jest.fn(async (epochs: number[]) => mockEpochMailboxes(epochs)),
  getLastMailboxConnectEpoch: jest.fn(async () => mockLastEpoch),
  setLastMailboxConnectEpoch: jest.fn(async () => {}),
}));

jest.mock('../../utils/logger', () => ({ __esModule: true, logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

// eslint-disable-next-line no-undef
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

import {
  connectMailboxSocket,
  sendViaMailbox,
  isMailboxAuthed,
  disconnectMailboxSocket,
  ownCurrentMailboxId,
} from '../mailboxSocket';

describe('mailboxSocket — dedicated mailbox delivery socket', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig.ONION_URL = 'http://onion.test';
    mockConfig.MAILBOX_ENABLED = true;
    mockMailbox = deriveMailbox(mockRoot, 19_000);
    mockLastEpoch = null;
    lastSocket = null;
    lastIoArgs = null;
    disconnectMailboxSocket();
  });

  afterEach(() => {
    // Clears any scheduled epoch-rotation timer so it can't leak across tests.
    disconnectMailboxSocket();
  });

  it('fail-closed: does not connect when MAILBOX_ENABLED is false', async () => {
    mockConfig.MAILBOX_ENABLED = false;
    const sock = await connectMailboxSocket(() => {});
    expect(sock).toBeNull();
    expect(mockTorSioSocket).not.toHaveBeenCalled();
  });

  it('handshake carries the mailbox id + signing pubkey and NO aegisId', async () => {
    await connectMailboxSocket(() => {});
    expect(mockTorSioSocket).toHaveBeenCalledTimes(1);
    const auth = lastIoArgs!.opts as Record<string, unknown>;
    expect(auth.mailboxId).toBe(mockMailbox.mailboxIdB64);
    expect(typeof auth.mailboxSignPubKey).toBe('string');
    expect('aegisId' in auth).toBe(false);
    expect(lastIoArgs!.url).toBe('http://onion.test'); // Tor
  });

  it('binds catch-up epochs since the last connect and proves each (Slice 5b)', async () => {
    const E = epochFor(Date.now());
    mockLastEpoch = E - 3; // offline across 3 epoch boundaries
    await connectMailboxSocket(() => {});

    const auth = lastIoArgs!.opts as { binds?: Array<{ mailboxId: string; mailboxSignPubKey: string }> };
    // extras = [E-3, E-2, E-1] → 3 binds, in ascending epoch order.
    const expected = mockEpochMailboxes([E - 3, E - 2, E - 1]);
    expect(auth.binds).toHaveLength(3);
    expect(auth.binds!.map((b) => b.mailboxId)).toEqual(expected.map((m) => m.mailboxIdB64));

    // Each extra bind is proven by a signature over the SAME challenge nonce.
    lastSocket!.connected = true;
    const nonceB64 = Buffer.from(new Uint8Array(32).fill(9)).toString('base64');
    lastSocket!.fire('mailbox:challenge', { nonce: nonceB64 });
    const resp = lastSocket!.emitted.find((e) => e.event === 'mailbox:auth:response');
    const extraSigs = (resp!.payload as { extraSigs: Array<{ mailboxId: string; sig: string }> }).extraSigs;
    expect(extraSigs).toHaveLength(3);
    for (let i = 0; i < expected.length; i++) {
      expect(extraSigs[i]!.mailboxId).toBe(expected[i]!.mailboxIdB64);
      const ok = verifyMailboxAuth(expected[i]!.signPublicKey, decodeBase64(nonceB64), decodeBase64(extraSigs[i]!.sig));
      expect(ok).toBe(true);
    }
  });

  it('answers the challenge with a proof that verifies against the mailbox key', async () => {
    await connectMailboxSocket(() => {});
    lastSocket!.connected = true;
    // Server issues a random challenge.
    const nonceB64 = Buffer.from(new Uint8Array(32).fill(3)).toString('base64');
    lastSocket!.fire('mailbox:challenge', { nonce: nonceB64 });

    const resp = lastSocket!.emitted.find((e) => e.event === 'mailbox:auth:response');
    expect(resp).toBeDefined();
    const sig = decodeBase64((resp!.payload as { sig: string }).sig);
    const ok = verifyMailboxAuth(mockMailbox.signPublicKey, decodeBase64(nonceB64), sig);
    expect(ok).toBe(true);
  });

  it('auth:ok flips isMailboxAuthed; send refuses before auth, works after', async () => {
    const env = { id: 'm1', to: 'mboxTo', ciphertext: 'ct', nonce: 'n', epk: 'e' };

    await connectMailboxSocket(() => {});
    lastSocket!.connected = true;
    // Before auth → null, nothing emitted.
    expect(isMailboxAuthed()).toBe(false);
    await expect(sendViaMailbox(env)).resolves.toBeNull();

    lastSocket!.fire('auth:ok');
    expect(isMailboxAuthed()).toBe(true);

    const p = sendViaMailbox(env);
    const sent = lastSocket!.emitted.find((e) => e.event === 'envelope:mb');
    expect(sent).toBeDefined();
    expect(sent!.payload).toEqual(env);
    // Relay acks delivered.
    (sent!.ack as Handler)({ ok: true, delivered: true });
    await expect(p).resolves.toEqual({ ok: true, delivered: true });
  });

  it('hands incoming envelope:mb to the onEnvelope callback', async () => {
    const received: unknown[] = [];
    await connectMailboxSocket((e) => received.push(e));
    lastSocket!.connected = true;
    const env = { id: 'i1', to: 'me', ciphertext: 'ct', nonce: 'n', epk: 'e', createdAt: 1 };
    lastSocket!.fire('envelope:mb', env);
    expect(received).toEqual([env]);
  });

  it('exposes our current mailbox id once connected, cleared on disconnect', async () => {
    await connectMailboxSocket(() => {});
    expect(ownCurrentMailboxId()).toBe(mockMailbox.mailboxIdB64);
    disconnectMailboxSocket();
    expect(ownCurrentMailboxId()).toBeNull();
    expect(isMailboxAuthed()).toBe(false);
  });
});
