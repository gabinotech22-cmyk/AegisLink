/**
 * Remote panic deep-link — SUCCESS-path and near-miss tests.
 *
 * The audit-regression suite (H-5) locks in the rejection paths for malformed
 * and forged links. This suite covers the other half of "panic mode works":
 *   - a correctly signed link whose token matches the stored one actually
 *     triggers the wipe (wipeDatabase + identity reset) and returns true;
 *   - a valid signature over a token that does NOT match the stored one is
 *     rejected without wiping (replay of an old/foreign link);
 *   - a valid link with no stored panic config is rejected without wiping;
 *   - a wipeDatabase failure surfaces as `false` (never a throw).
 */
import nacl from 'tweetnacl';
import { decodeUTF8, encodeBase64 } from 'tweetnacl-util';

const mockWipeDatabase = jest.fn().mockResolvedValue(undefined);
jest.mock('../../db/local', () => ({
  wipeDatabase: (...a: unknown[]) => mockWipeDatabase(...a),
}));

const mockSsGet = jest.fn();
jest.mock('../secureStore', () => ({
  ss: {
    get: (...a: unknown[]) => mockSsGet(...a),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  },
}));

const mockReset = jest.fn().mockResolvedValue(undefined);
// Derive the identity keypair from a fixed seed so the mock factory (hoisted
// above this file by jest) and the signing code below can each recompute the
// SAME key independently, without sharing an out-of-scope variable across the
// hoist boundary (jest forbids that).
const KP_SEED = new Uint8Array(32).fill(7);
const kp = nacl.sign.keyPair.fromSeed(KP_SEED);
jest.mock('../../store/identity', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const naclLocal = require('tweetnacl') as typeof import('tweetnacl');
  const kpLocal = naclLocal.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
  return {
    useIdentity: {
      getState: () => ({
        identity: {
          aegisId: 'TEST-AAAA-BBBB',
          signingPublicKey: kpLocal.publicKey,
          signingSecretKey: kpLocal.secretKey,
        },
        reset: (...a: unknown[]) => mockReset(...a),
      }),
    },
  };
});

import { handlePanicDeepLink } from '../panicLink';

const TOKEN = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const SIG = encodeBase64(nacl.sign.detached(decodeUTF8(TOKEN), kp.secretKey));
const VALID_URL = `aegislink://panic?token=${TOKEN}&sig=${encodeURIComponent(SIG)}`;

function storeConfig(config: object | null) {
  mockSsGet.mockResolvedValue(config === null ? null : JSON.stringify(config));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('handlePanicDeepLink — success path', () => {
  it('wipes and resets identity for a valid signed link matching the stored token', async () => {
    storeConfig({ remoteToken: TOKEN, remoteTokenSig: SIG });
    const ok = await handlePanicDeepLink(VALID_URL);
    expect(ok).toBe(true);
    expect(mockWipeDatabase).toHaveBeenCalledTimes(1);
    expect(mockReset).toHaveBeenCalledTimes(1);
  });

  it('wipes BEFORE resetting identity (data gone even if reset is interrupted)', async () => {
    storeConfig({ remoteToken: TOKEN, remoteTokenSig: SIG });
    const order: string[] = [];
    mockWipeDatabase.mockImplementationOnce(async () => { order.push('wipe'); });
    mockReset.mockImplementationOnce(async () => { order.push('reset'); });
    await handlePanicDeepLink(VALID_URL);
    expect(order).toEqual(['wipe', 'reset']);
  });
});

describe('handlePanicDeepLink — near-miss rejections (no wipe)', () => {
  it('rejects a validly-signed link whose token does not match the stored one', async () => {
    // Signature verifies against our own key, but the token was rotated —
    // replaying the OLD link must not wipe.
    storeConfig({ remoteToken: 'rotated-token-uuid', remoteTokenSig: 'other-sig' });
    const ok = await handlePanicDeepLink(VALID_URL);
    expect(ok).toBe(false);
    expect(mockWipeDatabase).not.toHaveBeenCalled();
    expect(mockReset).not.toHaveBeenCalled();
  });

  it('rejects a valid link when no panic config was ever stored', async () => {
    storeConfig(null);
    const ok = await handlePanicDeepLink(VALID_URL);
    expect(ok).toBe(false);
    expect(mockWipeDatabase).not.toHaveBeenCalled();
  });

  it('rejects when the stored config is corrupt JSON', async () => {
    mockSsGet.mockResolvedValue('{not json');
    const ok = await handlePanicDeepLink(VALID_URL);
    expect(ok).toBe(false);
    expect(mockWipeDatabase).not.toHaveBeenCalled();
  });
});

describe('handlePanicDeepLink — wipe failure', () => {
  it('returns false (never throws) if wipeDatabase fails', async () => {
    storeConfig({ remoteToken: TOKEN, remoteTokenSig: SIG });
    mockWipeDatabase.mockRejectedValueOnce(new Error('disk error'));
    const ok = await handlePanicDeepLink(VALID_URL);
    expect(ok).toBe(false);
  });
});
