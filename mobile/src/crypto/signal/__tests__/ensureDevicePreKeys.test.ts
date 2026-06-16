/**
 * Regression test for the X3DH root-key DIVERGENCE bug caused by MULTIPLE
 * concurrent registration routes each calling `generatePreKeys` independently.
 *
 * Before the fix, every route (publishToServer fire-and-forget, the socket
 * `unknown_identity` handler, Onboarding, profile creation) generated its OWN
 * random SPK/OPK set under keyId 1. The relay could end up holding the PUBLIC
 * material of one set while the durable DB held the SECRET of a DIFFERENT set
 * → DH(SPK) mismatch → divergent root keys → first message fails to decrypt.
 *
 * The fix introduces `ensureDevicePreKeys`, a single source of truth that
 * generates+persists exactly one set per slot and reconstructs the public
 * material from the persisted secrets on every subsequent call. These tests
 * prove:
 *   (a) concurrent callers converge on the SAME published public bundle, and
 *       that bundle matches scalarMult.base(secret) of the persisted secret;
 *   (b) an end-to-end X3DH where Alice uses the PUBLISHED bundle and Bob loads
 *       his SECRET from the DB derives the IDENTICAL root key (rkFp equal).
 *
 * Everything is mocked: db/local is an in-memory store; no SQLite, no network,
 * no SecureStore. No private key material is asserted on in logs.
 */

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';

// ── In-memory mock of the db/local prekey store ──────────────────────────────
const mockDbSpk = new Map<number, string>();
const mockDbOpk = new Map<number, string>();
const mockDbPqSpk = new Map<number, string>();
let mockDbSpkKeyId: number | null = null;
let mockDbPqSpkKeyId: number | null = null;
let mockSpkWriteCount = 0;
let mockPqSpkWriteCount = 0;

jest.mock('../../../db/local', () => ({
  __esModule: true,
  getActiveDbSlot: () => 'self',
  saveSpkSecret: jest.fn(async (keyId: number, b64: string) => {
    mockSpkWriteCount++;
    mockDbSpk.set(keyId, b64);
  }),
  loadSpkSecret: jest.fn(async (keyId: number) => mockDbSpk.get(keyId) ?? null),
  loadAllOpkSecrets: jest.fn(async () => new Map(mockDbOpk)),
  saveOpkSecret: jest.fn(async (keyId: number, b64: string) => { mockDbOpk.set(keyId, b64); }),
  setSpkKeyId: jest.fn(async (n: number) => { mockDbSpkKeyId = n; }),
  getSpkKeyId: jest.fn(async () => mockDbSpkKeyId),
  // PQXDH PQSPK store
  savePqSpkSecret: jest.fn(async (keyId: number, b64: string) => {
    mockPqSpkWriteCount++;
    mockDbPqSpk.set(keyId, b64);
  }),
  loadPqSpkSecret: jest.fn(async (keyId: number) => mockDbPqSpk.get(keyId) ?? null),
  setPqSpkKeyId: jest.fn(async (n: number) => { mockDbPqSpkKeyId = n; }),
  getPqSpkKeyId: jest.fn(async () => mockDbPqSpkKeyId),
}));

import {
  ensureDevicePreKeys,
  performX3DH,
  performX3DHReceiver,
  type PreKeyBundle,
} from '../x3dh';
import type { Identity } from '../../identity';

function buildIdentity(): Identity {
  const box = nacl.box.keyPair();
  const sign = nacl.sign.keyPair();
  return {
    aegisId: 'AEGIS' + encodeBase64(box.publicKey).slice(0, 6),
    publicKey: box.publicKey,
    secretKey: box.secretKey,
    publicKeyB64: encodeBase64(box.publicKey),
    secretKeyB64: encodeBase64(box.secretKey),
    signingPublicKey: sign.publicKey,
    signingSecretKey: sign.secretKey,
    signingPublicKeyB64: encodeBase64(sign.publicKey),
    signingSecretKeyB64: encodeBase64(sign.secretKey),
    createdAt: Date.now(),
  } as unknown as Identity;
}

beforeEach(() => {
  mockDbSpk.clear();
  mockDbOpk.clear();
  mockDbPqSpk.clear();
  mockDbSpkKeyId = null;
  mockDbPqSpkKeyId = null;
  mockSpkWriteCount = 0;
  mockPqSpkWriteCount = 0;
});

describe('ensureDevicePreKeys — single source of truth', () => {
  it('published public SPK/OPK always match the persisted secret (scalarMult.base)', async () => {
    const me = buildIdentity();
    const set = await ensureDevicePreKeys(me);

    // SPK public derived from the persisted secret.
    const persistedSpkSec = decodeBase64(mockDbSpk.get(set.signedPreKey.keyId)!);
    expect(encodeBase64(nacl.scalarMult.base(persistedSpkSec))).toBe(set.signedPreKey.publicKeyB64);

    // Every published OPK public matches its persisted secret.
    for (const opk of set.oneTimePreKeys) {
      const sec = decodeBase64(mockDbOpk.get(opk.keyId)!);
      expect(encodeBase64(nacl.scalarMult.base(sec))).toBe(opk.publicKeyB64);
    }

    // The SPK signature verifies under the identity signing key.
    expect(
      nacl.sign.detached.verify(
        decodeBase64(set.signedPreKey.publicKeyB64),
        decodeBase64(set.signedPreKey.signatureB64),
        me.signingPublicKey,
      ),
    ).toBe(true);
  });

  it('two CONCURRENT routes converge on the SAME published set (no race)', async () => {
    const me = buildIdentity();
    // Simulate publishToServer + unknown_identity firing in parallel.
    const [a, b] = await Promise.all([ensureDevicePreKeys(me), ensureDevicePreKeys(me)]);

    expect(a.signedPreKey.keyId).toBe(b.signedPreKey.keyId);
    expect(a.signedPreKey.publicKeyB64).toBe(b.signedPreKey.publicKeyB64);
    expect(a.oneTimePreKeys.map((o) => o.publicKeyB64)).toEqual(
      b.oneTimePreKeys.map((o) => o.publicKeyB64),
    );
    // Exactly one durable SPK secret persisted (single source of truth).
    expect(mockDbSpk.size).toBe(1);
  });

  it('a later call REUSES the persisted set (reconstructed, not regenerated)', async () => {
    const me = buildIdentity();
    const first = await ensureDevicePreKeys(me);
    const writesAfterFirst = mockSpkWriteCount;
    const pqWritesAfterFirst = mockPqSpkWriteCount;

    const second = await ensureDevicePreKeys(me);
    expect(second.signedPreKey.publicKeyB64).toBe(first.signedPreKey.publicKeyB64);
    expect(second.signedPreKey.keyId).toBe(first.signedPreKey.keyId);
    // No new SPK secret written — it was reconstructed from the DB.
    expect(mockSpkWriteCount).toBe(writesAfterFirst);
    // Same single-source-of-truth guarantee for the PQSPK.
    expect(second.pqSignedPreKey.publicKeyB64).toBe(first.pqSignedPreKey.publicKeyB64);
    expect(mockPqSpkWriteCount).toBe(pqWritesAfterFirst);
  });

  it('publishes a PQSPK whose signature verifies and whose secret is persisted', async () => {
    const me = buildIdentity();
    const set = await ensureDevicePreKeys(me);

    expect(decodeBase64(set.pqSignedPreKey.publicKeyB64).length).toBe(1184);
    // The persisted PQSPK secret is the 2400-byte ML-KEM-768 secret key.
    const persisted = mockDbPqSpk.get(set.pqSignedPreKey.keyId)!;
    expect(decodeBase64(persisted).length).toBe(2400);
    // The published PQSPK signature verifies under the identity signing key.
    expect(
      nacl.sign.detached.verify(
        decodeBase64(set.pqSignedPreKey.publicKeyB64),
        decodeBase64(set.pqSignedPreKey.signatureB64),
        me.signingPublicKey,
      ),
    ).toBe(true);
  });

  it('migrates a pre-PQXDH install (SPK present, PQSPK absent) by adding a PQSPK', async () => {
    const me = buildIdentity();
    // Simulate a legacy install: an SPK + OPK already persisted, but NO PQSPK.
    const { generatePreKeys } = require('../x3dh') as typeof import('../x3dh');
    const legacy = generatePreKeys(me, 1, 2, 1, 1);
    mockDbSpk.set(legacy.signedPreKey.keyId, encodeBase64(legacy.signedPreKey.secretKey));
    mockDbSpkKeyId = legacy.signedPreKey.keyId;
    for (const [keyId, secret] of legacy.opkSecrets) {
      mockDbOpk.set(keyId, encodeBase64(secret));
    }
    // PQSPK store intentionally empty (pre-PQXDH).
    expect(mockDbPqSpk.size).toBe(0);

    const set = await ensureDevicePreKeys(me);
    // A PQSPK was lazily generated + persisted; classic SPK was reused as-is.
    expect(set.signedPreKey.keyId).toBe(legacy.signedPreKey.keyId);
    expect(mockDbPqSpk.size).toBe(1);
    expect(decodeBase64(set.pqSignedPreKey.publicKeyB64).length).toBe(1184);
  });
});

describe('ensureDevicePreKeys — end-to-end X3DH convergence (rkFp equal)', () => {
  it('Alice uses PUBLISHED bundle, Bob loads SECRET from DB → identical root key', async () => {
    const bob = buildIdentity();
    const alice = buildIdentity();

    // Bob registers — produces the published bundle + durable secrets.
    const bobSet = await ensureDevicePreKeys(bob);
    const opkPub = bobSet.oneTimePreKeys[0];

    // Alice fetches Bob's PUBLISHED bundle from the "relay".
    const bundle: PreKeyBundle = {
      identityKeyB64: bob.publicKeyB64,
      signingPublicKeyB64: bob.signingPublicKeyB64,
      signedPreKey: {
        keyId: bobSet.signedPreKey.keyId,
        publicKeyB64: bobSet.signedPreKey.publicKeyB64,
        signatureB64: bobSet.signedPreKey.signatureB64,
      },
      oneTimePreKey: { keyId: opkPub.keyId, publicKeyB64: opkPub.publicKeyB64 },
    };
    const aliceX3DH = performX3DH(alice, bundle);

    // Bob loads his SECRETS from the DB (the receiver path), NOT from `bobSet`.
    const bobSpkSecret = decodeBase64(mockDbSpk.get(bobSet.signedPreKey.keyId)!);
    const bobOpkSecret = decodeBase64(mockDbOpk.get(opkPub.keyId)!);

    const bobRoot = performX3DHReceiver(
      bob,
      bobSpkSecret,
      bobOpkSecret,
      alice.publicKey,
      decodeBase64(aliceX3DH.myEphemeralPublicKeyB64),
    );

    // Root keys MUST match (rkFp equal) — the whole point of the fix.
    expect(encodeBase64(bobRoot)).toBe(encodeBase64(aliceX3DH.rootKey));
  });
});
