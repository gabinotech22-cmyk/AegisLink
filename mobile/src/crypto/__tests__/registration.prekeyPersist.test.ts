/**
 * Regression test for the REGISTRATION-path variant of the "X3DH no-spk" bug.
 *
 * The refill path (socket/client.ts:uploadPreKeys) already persisted prekey
 * secrets durably, but a FRESHLY created identity never hits refill (its OPK
 * count is already healthy at 100). Registration went through
 * `uploadIdentityAndPrekeys`, which used to discard `preKeySecrets`
 * (`void preKeySecrets`) — so the published SPK had no readable secret and a
 * peer using it hit "ABORT no-spk".
 *
 * These tests verify the durable-persistence invariant now centralized inside
 * `uploadIdentityAndPrekeys`:
 *   (a) after a successful upload the SPK secret is readable from the DB by keyId,
 *       AND the public material was POSTed to /prekeys;
 *   (b) if the durable SPK write cannot be read back, /prekeys is NOT POSTed.
 *
 * Everything is mocked: db/local (in-memory), expo-secure-store (no-op), and
 * global fetch. No real SQLite, no SecureStore, no network. No private key
 * material is asserted on in logs.
 */

import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { generatePreKeys } from '../signal/x3dh';
import type { Identity, PreKeySecrets, SignedPreKeyPublic, OneTimePreKeyPublic } from '../types';

// ── In-memory mock of the db/local prekey store ──────────────────────────────
const mockDbSpk = new Map<number, string>();
const mockDbOpk = new Map<number, string>();
let mockDbSpkKeyId: number | null = null;
let mockFailSpkWrite = false;

jest.mock('../../db/local', () => ({
  __esModule: true,
  getActiveDbSlot: () => 'self',
  saveSpkSecret: jest.fn(async (keyId: number, b64: string) => {
    if (mockFailSpkWrite) return; // simulate silent durable-write failure
    mockDbSpk.set(keyId, b64);
  }),
  loadSpkSecret: jest.fn(async (keyId: number) => mockDbSpk.get(keyId) ?? null),
  saveOpkSecret: jest.fn(async (keyId: number, b64: string) => { mockDbOpk.set(keyId, b64); }),
  setSpkKeyId: jest.fn(async (n: number) => { mockDbSpkKeyId = n; }),
}));

jest.mock('expo-secure-store', () => ({
  __esModule: true,
  AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

import { uploadIdentityAndPrekeys } from '../registration';

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

function buildPrekeys(identity: Identity, spkKeyId: number) {
  const pre = generatePreKeys(identity, 1, 4, spkKeyId);
  const secrets: PreKeySecrets = {
    signedPreKey: { keyId: pre.signedPreKey.keyId, secretKey: pre.signedPreKey.secretKey },
    opkSecrets: pre.opkSecrets,
  };
  const spkPublic: SignedPreKeyPublic = {
    keyId: pre.signedPreKey.keyId,
    publicKeyB64: pre.signedPreKey.publicKeyB64,
    signatureB64: pre.signedPreKey.signatureB64,
  };
  const opksPublic: OneTimePreKeyPublic[] = pre.oneTimePreKeys;
  return { secrets, spkPublic, opksPublic };
}

const FETCH_OK = (status: number) =>
  Promise.resolve({ ok: status < 300, status, text: async () => '', json: async () => ({}) } as Response);

describe('uploadIdentityAndPrekeys — durable SPK secret persistence invariant', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    mockDbSpk.clear();
    mockDbOpk.clear();
    mockDbSpkKeyId = null;
    mockFailSpkWrite = false;
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('persists the SPK secret in the DB (readable by keyId) AND POSTs /prekeys', async () => {
    const me = buildIdentity();
    const spkKeyId = 1;
    const { secrets, spkPublic, opksPublic } = buildPrekeys(me, spkKeyId);

    // First fetch = POST /identity (201), second = POST /prekeys (201).
    fetchMock.mockImplementation(() => FETCH_OK(201));

    const res = await uploadIdentityAndPrekeys(
      me, secrets, 'http://relay.test', 'chal', 'nonce', opksPublic, spkPublic,
    );

    expect(res.ok).toBe(true);

    // SPK secret durable + readable by keyId.
    expect(mockDbSpkKeyId).toBe(spkKeyId);
    expect(mockDbSpk.get(spkKeyId)).toBe(encodeBase64(secrets.signedPreKey.secretKey));
    // Every OPK secret persisted too.
    expect(mockDbOpk.size).toBe(secrets.opkSecrets.size);

    // /prekeys was POSTed (invariant satisfied → publish allowed).
    const prekeyCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/prekeys'));
    expect(prekeyCall).toBeDefined();

    // Privacy: the /prekeys body must NOT contain secret material.
    const body = JSON.parse((prekeyCall![1] as { body: string }).body);
    expect(JSON.stringify(body)).not.toContain('secretKey');
    expect(body.signedPreKey.publicKeyB64).toBe(spkPublic.publicKeyB64);
  });

  it('does NOT POST /prekeys when the SPK secret cannot be persisted/read back', async () => {
    mockFailSpkWrite = true; // simulate durable-store write failure
    const me = buildIdentity();
    const { secrets, spkPublic, opksPublic } = buildPrekeys(me, 1);

    // Only /identity should be hit; /prekeys must never be reached.
    fetchMock.mockImplementation(() => FETCH_OK(201));

    const res = await uploadIdentityAndPrekeys(
      me, secrets, 'http://relay.test', 'chal', 'nonce', opksPublic, spkPublic,
    );

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/could not persist SPK secret/i);

    // INVARIANT: a SPK whose secret we cannot read back is never published.
    expect(mockDbSpk.size).toBe(0);
    const prekeyCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/prekeys'));
    expect(prekeyCall).toBeUndefined();
  });
});
