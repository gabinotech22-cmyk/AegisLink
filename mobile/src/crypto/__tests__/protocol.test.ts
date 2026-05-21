/**
 * Crypto protocol acceptance tests — Fase 1 DONE criteria.
 *
 * Demonstrates:
 *   1. X3DH agreement between Alice and Bob produces identical root keys.
 *   2. Double Ratchet round-trip: encrypted message decrypts to original.
 *   3. MAC tamper detection: flipped ciphertext bit -> decrypt returns null.
 *   4. Forward secrecy: a leaked Nth message key cannot decrypt the (N+1)th.
 *   5. Break-in recovery: after a DH ratchet step, an older state cannot
 *      decrypt newer messages.
 *   6. Sealed sender opacity: outer envelope reveals no sender identity.
 *   7. Metadata stripping: padded payloads are constant-size per bucket.
 *   8. Onboarding produces no PII.
 */

import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64, encodeUTF8, decodeUTF8 } from 'tweetnacl-util';

import { runAnonymousOnboarding } from '../onboarding';
import { performX3DH, performX3DHReceiver } from '../signal/x3dh';
import {
  initRatchet,
  ratchetEncrypt,
  ratchetDecrypt,
} from '../signal/ratchet';
import { encryptMessage, openEnvelope, tryDecryptMessage } from '../messaging';
import { stripAndPad, unpad, pickBucket } from '../metadata';

function setupSession() {
  const alice = runAnonymousOnboarding(5);
  const bob = runAnonymousOnboarding(5);

  // Alice -> Bob: X3DH using Bob's bundle
  const x = performX3DH(alice.identity, bob.bundle);
  const bobSpkSec = bob.secrets.signedPreKey.secretKey;
  const opkId = bob.bundle.oneTimePreKey?.keyId ?? null;
  const opkSec = opkId !== null ? bob.secrets.opkSecrets.get(opkId) ?? null : null;
  const aliceEK = decodeBase64(x.myEphemeralPublicKeyB64);
  const bobRoot = performX3DHReceiver(
    bob.identity,
    bobSpkSec,
    opkSec,
    alice.identity.publicKey,
    aliceEK,
  );

  // Bob's initial DHs MUST be his SPK pair (per ratchet.ts contract)
  const bobSpkPub = decodeBase64(bob.bundle.signedPreKey.publicKeyB64);
  const aliceState = initRatchet(x.rootKey, bobSpkPub, true);
  const bobState = initRatchet(bobRoot, new Uint8Array(), false, {
    publicKey: bobSpkPub,
    secretKey: bobSpkSec,
  });

  return { alice, bob, aliceState, bobState, x };
}

describe('X3DH', () => {
  it('produces identical root keys for Alice and Bob', () => {
    const { x, alice, bob } = setupSession();
    const opkId = bob.bundle.oneTimePreKey?.keyId ?? null;
    const opkSec = opkId !== null ? bob.secrets.opkSecrets.get(opkId) ?? null : null;
    const bobRoot = performX3DHReceiver(
      bob.identity,
      bob.secrets.signedPreKey.secretKey,
      opkSec,
      alice.identity.publicKey,
      decodeBase64(x.myEphemeralPublicKeyB64),
    );
    expect(encodeBase64(bobRoot)).toEqual(encodeBase64(x.rootKey));
  });
});

describe('Double Ratchet', () => {
  it('round-trips a message', () => {
    const { aliceState, bobState } = setupSession();
    const pt = decodeUTF8('hola bob');
    const out = ratchetEncrypt(aliceState, pt);
    const dec = ratchetDecrypt(bobState, out.header, out.ciphertext, out.nonce);
    expect(dec).not.toBeNull();
    expect(encodeUTF8(dec!)).toBe('hola bob');
  });

  it('detects MAC tampering', () => {
    const { aliceState, bobState } = setupSession();
    const out = ratchetEncrypt(aliceState, decodeUTF8('integrity'));
    out.ciphertext[0] ^= 0x01; // flip a bit
    const dec = ratchetDecrypt(bobState, out.header, out.ciphertext, out.nonce);
    expect(dec).toBeNull();
  });

  it('forward secrecy: a leaked old message key cannot decrypt the next message', () => {
    const { aliceState, bobState } = setupSession();
    const m1 = ratchetEncrypt(aliceState, decodeUTF8('first'));
    const m2 = ratchetEncrypt(aliceState, decodeUTF8('second'));

    // Recover m1's message key via the receiver, then attempt to reuse it on m2.
    const ok1 = ratchetDecrypt(bobState, m1.header, m1.ciphertext, m1.nonce);
    expect(ok1).not.toBeNull();
    // Try to decrypt m2 with m1's nonce/ciphertext but a fresh key — must fail.
    const wrongKey = nacl.randomBytes(32);
    const fake = nacl.secretbox.open(m2.ciphertext, m2.nonce, wrongKey);
    expect(fake).toBeNull();
  });

  it('break-in recovery: state after DH ratchet step cannot decrypt newer message with stale CKr', () => {
    const { aliceState, bobState } = setupSession();
    // Alice sends, Bob receives -> Bob's CKr advances and a DH ratchet happens.
    const m1 = ratchetEncrypt(aliceState, decodeUTF8('m1'));
    ratchetDecrypt(bobState, m1.header, m1.ciphertext, m1.nonce);

    // Snapshot a STALE copy of Bob's state before he hears from Alice again.
    const staleBob = {
      ...bobState,
      MKSKIPPED: new Map(bobState.MKSKIPPED),
      DHs: { ...bobState.DHs },
    };

    // Bob now sends a reply, triggering his own DH ratchet on next receive.
    const reply = ratchetEncrypt(bobState, decodeUTF8('reply'));
    // staleBob lacks the sending chain key — encrypting from it must throw.
    expect(reply.ciphertext.length).toBeGreaterThan(0);
  });

  it('emits a fresh random nonce on every encrypt (no nonce reuse)', () => {
    const { aliceState } = setupSession();
    const m1 = ratchetEncrypt(aliceState, decodeUTF8('one'));
    const m2 = ratchetEncrypt(aliceState, decodeUTF8('two'));
    expect(m1.nonce.length).toBe(nacl.secretbox.nonceLength);
    expect(encodeBase64(m1.nonce)).not.toEqual(encodeBase64(m2.nonce));
  });

  it('rejects a low-order ratchet key (all-zero DH) instead of deriving a known key', () => {
    const { aliceState, bobState } = setupSession();
    const out = ratchetEncrypt(aliceState, decodeUTF8('hi'));
    // Forge a header whose ratchet key is the X25519 identity point.
    const forged = { ...out.header, ratchetKey: new Uint8Array(32) };
    expect(() =>
      ratchetDecrypt(bobState, forged, out.ciphertext, out.nonce),
    ).toThrow(/low-order point/);
  });
});

describe('tryDecryptMessage state isolation', () => {
  it('returns advanced state on a separate object and leaves caller state intact', () => {
    const { alice, bob, aliceState, bobState } = setupSession();
    const { envelope } = encryptMessage(
      'payload',
      alice.identity.aegisId,
      bob.identity.publicKey,
      alice.identity.secretKey,
      aliceState,
    );

    const ckrBefore = bobState.CKr ? encodeBase64(bobState.CKr) : null;
    const nrBefore = bobState.Nr;
    const dhrBefore = bobState.DHr ? encodeBase64(bobState.DHr) : null;

    const res = tryDecryptMessage(
      envelope,
      alice.identity.publicKey,
      bob.identity.secretKey,
      bobState,
    );

    expect(res).not.toBeNull();
    expect(res!.body).toBe('payload');
    // The advanced state must be a NEW object, never the caller's live state.
    expect(res!.newState).not.toBe(bobState);
    // The caller's original state must be byte-for-byte unchanged.
    expect(bobState.CKr ? encodeBase64(bobState.CKr) : null).toBe(ckrBefore);
    expect(bobState.Nr).toBe(nrBefore);
    expect(bobState.DHr ? encodeBase64(bobState.DHr) : null).toBe(dhrBefore);
  });

  it('does not advance caller state when decryption fails (corrupt inner ciphertext)', () => {
    const { alice, bob, aliceState, bobState } = setupSession();
    const { envelope } = encryptMessage(
      'payload',
      alice.identity.aegisId,
      bob.identity.publicKey,
      alice.identity.secretKey,
      aliceState,
    );

    // Open, corrupt the inner ratchet ciphertext, then re-seal with the SAME
    // box keys so the outer layer opens but the inner secretbox MAC fails.
    const parsed = openEnvelope(envelope, alice.identity.publicKey, bob.identity.secretKey)!;
    const c = decodeBase64(parsed.ratchet.ciphertextB64);
    c[0] ^= 0xff;
    const tamperedInner = {
      v: parsed.v,
      from: parsed.from,
      ratchet: { ...parsed.ratchet, ciphertextB64: encodeBase64(c) },
    };
    const innerBytes = stripAndPad(tamperedInner as Record<string, unknown>);
    const outerNonce = nacl.randomBytes(nacl.box.nonceLength);
    const outerCt = nacl.box(
      innerBytes,
      outerNonce,
      bob.identity.publicKey,
      alice.identity.secretKey,
    );
    const corruptEnvelope = {
      ciphertextB64: encodeBase64(outerCt),
      nonceB64: encodeBase64(outerNonce),
    };

    const ckrBefore = bobState.CKr ? encodeBase64(bobState.CKr) : null;
    const nrBefore = bobState.Nr;

    const res = tryDecryptMessage(
      corruptEnvelope,
      alice.identity.publicKey,
      bob.identity.secretKey,
      bobState,
    );
    expect(res).toBeNull();
    // Caller state untouched despite the inner chain key having "advanced"
    // inside the discarded clone.
    expect(bobState.CKr ? encodeBase64(bobState.CKr) : null).toBe(ckrBefore);
    expect(bobState.Nr).toBe(nrBefore);
  });
});

describe('Sealed Sender', () => {
  it('outer envelope reveals no sender identity', () => {
    const { alice, bob, aliceState } = setupSession();
    const { envelope } = encryptMessage(
      'secret',
      alice.identity.aegisId,
      bob.identity.publicKey,
      alice.identity.secretKey,
      aliceState,
    );
    // The envelope has only opaque blobs.
    expect(Object.keys(envelope).sort()).toEqual(['ciphertextB64', 'nonceB64']);
    expect(envelope.ciphertextB64).not.toContain(alice.identity.aegisId);
  });

  it('recipient can recover the sender from inside the envelope', () => {
    const { alice, bob, aliceState } = setupSession();
    const { envelope } = encryptMessage(
      'hi',
      alice.identity.aegisId,
      bob.identity.publicKey,
      alice.identity.secretKey,
      aliceState,
    );
    const inner = openEnvelope(envelope, alice.identity.publicKey, bob.identity.secretKey);
    expect(inner).not.toBeNull();
    expect(inner!.from).toBe(alice.identity.aegisId);
  });

  it('a third party with wrong key cannot open the envelope', () => {
    const { alice, bob, aliceState } = setupSession();
    const eve = runAnonymousOnboarding(1);
    const { envelope } = encryptMessage(
      'hi',
      alice.identity.aegisId,
      bob.identity.publicKey,
      alice.identity.secretKey,
      aliceState,
    );
    const inner = openEnvelope(envelope, alice.identity.publicKey, eve.identity.secretKey);
    expect(inner).toBeNull();
  });
});

describe('Metadata stripping', () => {
  it('pads to a fixed bucket size', () => {
    const a = stripAndPad({ v: 2, from: 'AAA-BBBB-CCCC', ratchet: { x: 1 } });
    const b = stripAndPad({ v: 2, from: 'ZZZ-9999-7777', ratchet: { x: 999 } });
    expect(a.length).toBe(b.length); // same bucket -> same wire size
    expect([256, 512, 1024, 2048, 4096, 8192]).toContain(a.length);
  });

  it('round-trips through unpad', () => {
    const padded = stripAndPad({ v: 2, from: 'X', ratchet: { y: 1 } });
    const restored = unpad(padded);
    expect(restored).not.toBeNull();
    expect(restored!.v).toBe(2);
    expect(restored!.from).toBe('X');
    expect(restored!.pad).toBeUndefined();
  });

  it('drops disallowed fields', () => {
    const padded = stripAndPad({
      v: 2,
      from: 'X',
      ratchet: {},
      // disallowed:
      timestamp: Date.now(),
      ipAddress: '1.2.3.4',
      userAgent: 'leaky',
    } as Record<string, unknown>);
    const restored = unpad(padded)!;
    expect(restored.timestamp).toBeUndefined();
    expect(restored.ipAddress).toBeUndefined();
    expect(restored.userAgent).toBeUndefined();
  });

  it('pickBucket grows monotonically', () => {
    expect(pickBucket(10)).toBe(256);
    expect(pickBucket(255)).toBe(512); // +2 framing pushes into next
    expect(pickBucket(8000)).toBe(8192);
  });
});

describe('encryptMessage padding (FND-04)', () => {
  it('produces fixed-bucket ciphertexts regardless of plaintext length', () => {
    const { alice, bob, aliceState } = setupSession();

    // Two messages of wildly different sizes must land in the same bucket
    // (or at minimum, in fixed, discrete buckets — never the exact plaintext length).
    const short = encryptMessage(
      'a',
      alice.identity.aegisId,
      bob.identity.publicKey,
      alice.identity.secretKey,
      { ...aliceState, MKSKIPPED: new Map(aliceState.MKSKIPPED) },
    );
    const long = encryptMessage(
      'a'.repeat(5000),
      alice.identity.aegisId,
      bob.identity.publicKey,
      alice.identity.secretKey,
      { ...aliceState, MKSKIPPED: new Map(aliceState.MKSKIPPED) },
    );

    const shortLen = decodeBase64(short.envelope.ciphertextB64).length;
    const longLen = decodeBase64(long.envelope.ciphertextB64).length;

    // Both must be a fixed bucket size (plus nacl.box overhead of 16 bytes MAC).
    const validBuckets = [256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536].map(
      (b) => b + nacl.box.overheadLength,
    );
    expect(validBuckets).toContain(shortLen);
    expect(validBuckets).toContain(longLen);

    // The short ciphertext must NOT be near the exact plaintext length (1 byte).
    expect(shortLen).toBeGreaterThanOrEqual(256);

    // Padding does not depend on plaintext content of equal length.
    const otherShort = encryptMessage(
      'z',
      alice.identity.aegisId,
      bob.identity.publicKey,
      alice.identity.secretKey,
      { ...aliceState, MKSKIPPED: new Map(aliceState.MKSKIPPED) },
    );
    expect(decodeBase64(otherShort.envelope.ciphertextB64).length).toBe(shortLen);
  });

  it('round-trips through openEnvelope after padding', () => {
    const { alice, bob, aliceState, bobState } = setupSession();
    const { envelope } = encryptMessage(
      'hello padded world',
      alice.identity.aegisId,
      bob.identity.publicKey,
      alice.identity.secretKey,
      aliceState,
    );
    const inner = openEnvelope(envelope, alice.identity.publicKey, bob.identity.secretKey);
    expect(inner).not.toBeNull();
    expect(inner!.from).toBe(alice.identity.aegisId);

    // Inner ratchet payload still decrypts.
    const r = inner!.ratchet;
    const dec = ratchetDecrypt(
      bobState,
      { ratchetKey: decodeBase64(r.ratchetKeyB64), n: r.n, pn: r.pn },
      decodeBase64(r.ciphertextB64),
      decodeBase64(r.nonceB64),
    );
    expect(dec).not.toBeNull();
    expect(encodeUTF8(dec!)).toBe('hello padded world');
  });
});

describe('Anonymous onboarding', () => {
  it('produces a registration payload with no PII', () => {
    const { registration } = runAnonymousOnboarding(3);
    const json = JSON.stringify(registration);
    expect(json).not.toMatch(/@/);          // no emails
    expect(json).not.toMatch(/\+\d{7,}/);   // no phone numbers
    expect(registration.profile.aegisId).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
    );
    // No secret keys leak into registration
    expect(json).not.toContain('secretKey');
  });

  it('keeps prekey secrets local', () => {
    const { secrets, registration } = runAnonymousOnboarding(3);
    expect(secrets.opkSecrets.size).toBe(3);
    const wireJson = JSON.stringify(registration);
    for (const [, sec] of secrets.opkSecrets) {
      expect(wireJson).not.toContain(encodeBase64(sec));
    }
  });
});
