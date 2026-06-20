/**
 * buildOutgoingEnvelope — sealed-sender (v1/v2) transport selector.
 *
 * This is the single selector shared by the group fan-out (sendGroupMessage)
 * and the offline retry (flushOutbox), and it mirrors the inline selector in
 * sendMessage. Phase 3 of the sealed-sender epic routes GROUP message content
 * through it so a group send hides the sender's aegisId from the relay exactly
 * as a 1:1 send does.
 *
 * Pins the three branches:
 *   1. flag v2 + established session + delivery token present  → envelope:v2 (no `from`, carries epk + deliveryToken)
 *   2. flag v2 + established session + NO token                → envelope (v1 fallback)
 *   3. flag v2 + session still has x3dhInit (first contact)    → envelope (v1 bootstrap)
 *
 * The crypto modules are mocked to distinguishable return shapes so the test
 * asserts the SELECTION, not the (separately-tested) encryption.
 */

// The flag is read at module load from ../config — mock it to v2 so the v2
// branch is reachable. (The default app build is v1; the env flag opts in.)
jest.mock('../../config', () => ({
  __esModule: true,
  SERVER_URL: 'http://localhost:3000',
  ONION_URL: null,
  RELAY_URL: 'http://localhost:3000',
  SEALED_TRANSPORT_VERSION: 'v2',
}));

// Delivery-token resolution is the gate for v2 — control it per test.
const mockGetContactDeliveryToken = jest.fn();
jest.mock('../../crypto/deliveryToken', () => ({
  __esModule: true,
  getContactDeliveryToken: (...a: unknown[]) => mockGetContactDeliveryToken(...a),
  getOwnDeliveryToken: jest.fn(),
  hashDeliveryToken: jest.fn(),
  setContactDeliveryToken: jest.fn(),
}));

// Distinguishable encrypt outputs so we can tell which path was taken.
jest.mock('../../crypto/messaging', () => ({
  __esModule: true,
  encryptMessage: jest.fn(() => ({
    envelope: { ciphertextB64: 'v1-ct', nonceB64: 'v1-nonce' },
    newState: { tag: 'v1-state' },
  })),
  encryptMessageV2: jest.fn(() => ({
    wire: { ciphertext: 'v2-ct', nonce: 'v2-nonce', epk: 'v2-epk' },
    newState: { tag: 'v2-state' },
  })),
  openEnvelope: jest.fn(),
  openEnvelopeV2: jest.fn(),
}));

// Heavy module-load deps pulled in transitively by client.ts.
jest.mock('../../crypto/signal/x3dh', () => ({
  performX3DH: jest.fn(), performX3DHReceiver: jest.fn(), generatePreKeys: jest.fn(), shouldUsePqReceiver: jest.fn(),
}));
jest.mock('../../crypto/signal/ratchet', () => ({
  initRatchet: jest.fn(), ratchetEncrypt: jest.fn(), ratchetDecrypt: jest.fn(), trimOldSkippedKeys: jest.fn(), MAX_SKIPPED_KEYS: 1000,
}));
jest.mock('../../db/local', () => ({ __esModule: true, getActiveDbSlot: () => 'self' }));
jest.mock('../../store/contacts', () => ({ __esModule: true, useContacts: { getState: () => ({ contacts: [] }) } }));
jest.mock('../../store/messages', () => ({ __esModule: true, useMessages: { getState: () => ({ append: jest.fn() }) } }));
jest.mock('../../store/identity', () => ({ __esModule: true, useIdentity: { getState: () => ({ displayName: 'Me' }) } }));
jest.mock('../../store/preferences', () => ({ __esModule: true, usePreferences: { getState: () => ({ onionRouting: false }) } }));
jest.mock('../../store/connection', () => ({ __esModule: true, useConnection: { getState: () => ({ setOnline: jest.fn() }) } }));
jest.mock('../../api', () => ({ __esModule: true, lookupIdentity: jest.fn(), ApiError: class extends Error {} }));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'uuid') }));
jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));

import { buildOutgoingEnvelope } from '../client';
import type { Identity } from '../../crypto/identity';
import type { RatchetState } from '../../crypto/signal/ratchet';

const identity = {
  aegisId: 'self', publicKey: new Uint8Array(32), secretKey: new Uint8Array(32),
  publicKeyB64: 'p', secretKeyB64: 's', signingPublicKey: new Uint8Array(32),
  signingSecretKey: new Uint8Array(64), signingPublicKeyB64: 'sp', signingSecretKeyB64: 'ss', createdAt: 0,
} as Identity;

const established = {} as RatchetState; // no x3dhInit → established
const firstContact = { x3dhInit: { aliceEKB64: 'ek', spkId: 1, opkId: null } } as unknown as RatchetState;

describe('buildOutgoingEnvelope — sealed-sender v1/v2 selector', () => {
  beforeEach(() => jest.clearAllMocks());

  it('established session + delivery token → v2 (no from; epk + deliveryToken on wire)', async () => {
    mockGetContactDeliveryToken.mockResolvedValue('the-token');
    const out = await buildOutgoingEnvelope('payload', 'peer', new Uint8Array(32), identity, established);
    expect(out.event).toBe('envelope:v2');
    expect(out.wire).toEqual({ ciphertext: 'v2-ct', nonce: 'v2-nonce', epk: 'v2-epk', deliveryToken: 'the-token' });
    expect('from' in out.wire).toBe(false);
    expect(out.newState).toEqual({ tag: 'v2-state' });
  });

  it('established session but NO delivery token → v1 fallback', async () => {
    mockGetContactDeliveryToken.mockResolvedValue(null);
    const out = await buildOutgoingEnvelope('payload', 'peer', new Uint8Array(32), identity, established);
    expect(out.event).toBe('envelope');
    expect(out.wire).toEqual({ ciphertext: 'v1-ct', nonce: 'v1-nonce' });
  });

  it('first-contact session (pending x3dhInit) → v1 even with a token (never queried)', async () => {
    mockGetContactDeliveryToken.mockResolvedValue('the-token');
    const out = await buildOutgoingEnvelope('payload', 'peer', new Uint8Array(32), identity, firstContact);
    expect(out.event).toBe('envelope');
    expect(mockGetContactDeliveryToken).not.toHaveBeenCalled();
  });
});
