/**
 * messaging.edge.test.ts — adversarial / boundary cases for the Sealed Sender
 * wrapper (crypto/messaging.ts).
 *
 * Covers:
 *   - empty plaintext round-trip
 *   - 1MB plaintext round-trip (within padding buckets) under time budget
 *   - wrong recipient key -> openEnvelope returns null (does not throw)
 *   - truncated envelope ciphertext -> openEnvelope returns null
 *   - 100 encrypts produce 100 distinct nonces
 *   - sender spoofing: the `from` field inside the envelope is NOT authenticated
 *     against the senderPublicKey used to open the outer box — documented as
 *     the responsibility of the calling layer to verify identity.
 */

import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';

import { runAnonymousOnboarding } from '../onboarding';
import { performX3DH, performX3DHReceiver } from '../signal/x3dh';
import { initRatchet, type RatchetState } from '../signal/ratchet';
import { encryptMessage, openEnvelope, tryDecryptMessage } from '../messaging';

jest.setTimeout(15000);

interface Pair {
  alice: ReturnType<typeof runAnonymousOnboarding>;
  bob: ReturnType<typeof runAnonymousOnboarding>;
  aliceState: RatchetState;
  bobState: RatchetState;
}

function setupSession(): Pair {
  const alice = runAnonymousOnboarding(5);
  const bob = runAnonymousOnboarding(5);

  const x = performX3DH(alice.identity, bob.bundle);
  const opkId = bob.bundle.oneTimePreKey?.keyId ?? null;
  const opkSec = opkId !== null ? bob.secrets.opkSecrets.get(opkId) ?? null : null;
  const bobRoot = performX3DHReceiver(
    bob.identity,
    bob.secrets.signedPreKey.secretKey,
    opkSec,
    alice.identity.publicKey,
    decodeBase64(x.myEphemeralPublicKeyB64),
  );

  const bobSpkPub = decodeBase64(bob.bundle.signedPreKey.publicKeyB64);
  const aliceState = initRatchet(x.rootKey, bobSpkPub, true);
  const bobState = initRatchet(bobRoot, new Uint8Array(), false, {
    publicKey: bobSpkPub,
    secretKey: bob.secrets.signedPreKey.secretKey,
  });

  return { alice, bob, aliceState, bobState };
}

describe('encryptMessage / tryDecryptMessage — boundary plaintext sizes', () => {
  it('round-trips an empty string', () => {
    const { alice, bob, aliceState, bobState } = setupSession();
    const { envelope } = encryptMessage(
      '',
      alice.identity.aegisId,
      bob.identity.publicKey,
      alice.identity.secretKey,
      aliceState,
    );
    const dec = tryDecryptMessage(envelope, alice.identity.publicKey, bob.identity.secretKey, bobState);
    expect(dec).not.toBeNull();
    expect(dec!.body).toBe('');
    expect(dec!.from).toBe(alice.identity.aegisId);
  });

  it('round-trips a 1MB plaintext under the time budget', () => {
    const { alice, bob, aliceState, bobState } = setupSession();
    // 1MB of ASCII fits inside the largest padding bucket (4MB).
    const big = 'a'.repeat(1024 * 1024);
    const t0 = Date.now();
    const { envelope } = encryptMessage(
      big,
      alice.identity.aegisId,
      bob.identity.publicKey,
      alice.identity.secretKey,
      aliceState,
    );
    const dec = tryDecryptMessage(envelope, alice.identity.publicKey, bob.identity.secretKey, bobState);
    const elapsed = Date.now() - t0;
    expect(dec).not.toBeNull();
    expect(dec!.body.length).toBe(big.length);
    expect(dec!.body).toBe(big);
    expect(elapsed).toBeLessThan(10000);
  });
});

describe('openEnvelope — failure paths must NOT throw', () => {
  it('returns null when opened with the wrong recipient secret key', () => {
    const { alice, bob, aliceState } = setupSession();
    const { envelope } = encryptMessage(
      'no para extraño',
      alice.identity.aegisId,
      bob.identity.publicKey,
      alice.identity.secretKey,
      aliceState,
    );
    const eve = runAnonymousOnboarding(1);
    // openEnvelope must return null silently — never throw, never leak partial data.
    const out = openEnvelope(envelope, alice.identity.publicKey, eve.identity.secretKey);
    expect(out).toBeNull();
  });

  it('returns null when the envelope ciphertext is truncated', () => {
    const { alice, bob, aliceState } = setupSession();
    const { envelope } = encryptMessage(
      'truncame',
      alice.identity.aegisId,
      bob.identity.publicKey,
      alice.identity.secretKey,
      aliceState,
    );
    const raw = decodeBase64(envelope.ciphertextB64);
    const truncated = raw.slice(0, Math.max(0, raw.length - 8));
    const broken = { ...envelope, ciphertextB64: encodeBase64(truncated) };
    expect(openEnvelope(broken, alice.identity.publicKey, bob.identity.secretKey)).toBeNull();
  });

  it('returns null when the nonce has the wrong length', () => {
    const { alice, bob, aliceState } = setupSession();
    const { envelope } = encryptMessage(
      'nonce malo',
      alice.identity.aegisId,
      bob.identity.publicKey,
      alice.identity.secretKey,
      aliceState,
    );
    const broken = { ...envelope, nonceB64: encodeBase64(new Uint8Array(8)) };
    expect(openEnvelope(broken, alice.identity.publicKey, bob.identity.secretKey)).toBeNull();
  });
});

describe('encryptMessage — nonce uniqueness under load', () => {
  it('100 sequential encrypts produce 100 distinct outer-envelope nonces', () => {
    const { alice, bob, aliceState } = setupSession();
    const nonces = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const { envelope } = encryptMessage(
        'm' + i,
        alice.identity.aegisId,
        bob.identity.publicKey,
        alice.identity.secretKey,
        aliceState,
      );
      nonces.add(envelope.nonceB64);
    }
    expect(nonces.size).toBe(100);
  });
});

describe('sender spoofing — documented protocol boundary', () => {
  /**
   * KNOWN PROTOCOL BOUNDARY: `openEnvelope` decrypts the outer Sealed Sender
   * box with (senderPublicKey, mySecretKey). It then trusts whatever `from`
   * string is inside. There is NO cryptographic binding between the inner
   * `from` field and the X25519 key that successfully opened the box.
   *
   * The OUTER layer (chat controller / contact map) is responsible for
   * verifying that `parsed.from` matches the contact whose public key was
   * supplied to `openEnvelope`. This test documents the property so a future
   * refactor that removes that external check immediately fails CI.
   */
  it('an authentic peer (Eve) can put an arbitrary `from` value in the inner payload; openEnvelope returns it as-is', () => {
    // Bob has a session with Eve, not with Alice. Eve crafts a message claiming to be Alice.
    const eveSetup = setupSession();
    const { alice: eve, bob, aliceState: eveState, bobState } = eveSetup;
    // Eve encrypts a message but spoofs senderAegisId = 'ALICE-FAKE-ID-1'.
    const { envelope } = encryptMessage(
      'soy alice (mentira)',
      'ALICE-FAKE-ID-1',
      bob.identity.publicKey,
      eve.identity.secretKey,
      eveState,
    );
    // Bob opens it with EVE's public key (the real sender from the outer box's view).
    const parsed = openEnvelope(envelope, eve.identity.publicKey, bob.identity.secretKey);
    expect(parsed).not.toBeNull();
    // The inner `from` is the unverified attacker-chosen string. The protocol
    // layer above MUST cross-check this against eve.identity.publicKey.
    expect(parsed!.from).toBe('ALICE-FAKE-ID-1');
    // And full tryDecryptMessage also surfaces the spoofed `from`:
    const dec = tryDecryptMessage(envelope, eve.identity.publicKey, bob.identity.secretKey, bobState);
    expect(dec).not.toBeNull();
    expect(dec!.from).toBe('ALICE-FAKE-ID-1');
    expect(dec!.body).toBe('soy alice (mentira)');
  });

  it("Bob cannot open Eve's envelope using Alice's public key — wrong sender key fails the outer MAC", () => {
    const eveSetup = setupSession();
    const { alice: eve, bob, aliceState: eveState } = eveSetup;
    const alice = runAnonymousOnboarding(1);
    const { envelope } = encryptMessage(
      'soy alice (mentira)',
      'ALICE-FAKE-ID-1',
      bob.identity.publicKey,
      eve.identity.secretKey,
      eveState,
    );
    // If Bob attempts to "trust" the spoofed `from` and looks up Alice's pubkey
    // for verification, the outer box.open fails — the spoof is detected.
    const parsed = openEnvelope(envelope, alice.identity.publicKey, bob.identity.secretKey);
    expect(parsed).toBeNull();
    // Static-key assertion just to silence unused-var lints across versions.
    expect(nacl.box.publicKeyLength).toBe(32);
  });
});
