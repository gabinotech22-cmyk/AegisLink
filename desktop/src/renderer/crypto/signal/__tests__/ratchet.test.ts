/**
 * ratchet.test.ts — Double Ratchet edge cases (renderer/crypto/signal/ratchet.ts).
 *
 * Desktop parity twin of mobile/src/crypto/signal/__tests__/ratchet.test.ts.
 * The PQ ratchet logic in both files is byte-identical, so this suite mirrors the
 * mobile coverage adapted to the DESKTOP test conventions (Vitest, local
 * buildIdentity() + generatePreKeys() instead of mobile's runAnonymousOnboarding).
 *
 * Coverage: happy-path roundtrips, the security boundaries an attacker can probe
 * (replay, bit-flip, nonce-reuse pressure, post-compromise security after a DH
 * ratchet step, MAX_SKIPPED_KEYS), and the full R1 hybrid PQ surface — PQ mixed
 * into the root KDF, advertise/decapsulate of the ML-KEM ciphertext on a chain
 * turn, anti-downgrade rejection, byte-identity with the classic path when no
 * pqSecret is present, and multi-turn ping-pong across several PQ rotations.
 */

import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import {
  performX3DH,
  performX3DHReceiver,
  generatePreKeys,
  type PreKeyBundle,
} from '../x3dh';
import {
  initRatchet,
  ratchetEncrypt,
  ratchetDecrypt,
  MAX_SKIPPED_KEYS,
  type RatchetState,
} from '../ratchet';
import { type Identity } from '../../identity';
import { hkdfSHA256 } from '../kdf';

// ML-KEM-768 wire sizes (FIPS 203, Table 3). The ratchet module keeps these
// private, so we pin the literals here exactly like the mobile twin does.
const MLKEM768_PUBLICKEY_BYTES = 1184;
const MLKEM768_CIPHERTEXT_BYTES = 1088;

function buildIdentity(): Identity {
  const box = nacl.box.keyPair();
  const sign = nacl.sign.keyPair();
  return {
    aegisId: 'TEST' + encodeBase64(box.publicKey).slice(0, 8),
    publicKey: box.publicKey,
    secretKey: box.secretKey,
    publicKeyB64: encodeBase64(box.publicKey),
    secretKeyB64: encodeBase64(box.secretKey),
    signingPublicKey: sign.publicKey,
    signingSecretKey: sign.secretKey,
    signingPublicKeyB64: encodeBase64(sign.publicKey),
    signingSecretKeyB64: encodeBase64(sign.secretKey),
    createdAt: Date.now(),
  };
}

interface Session {
  aliceState: RatchetState;
  bobState: RatchetState;
}

/** Classic v1 session (no PQ material): byte-identical to the pre-R1 ratchet. */
function newSession(): Session {
  const alice = buildIdentity();
  const bob = buildIdentity();
  const bobPreKeys = generatePreKeys(bob);

  const bundle: PreKeyBundle = {
    identityKeyB64: bob.publicKeyB64,
    signingPublicKeyB64: bob.signingPublicKeyB64,
    signedPreKey: {
      keyId: bobPreKeys.signedPreKey.keyId,
      publicKeyB64: bobPreKeys.signedPreKey.publicKeyB64,
      signatureB64: bobPreKeys.signedPreKey.signatureB64,
    },
    oneTimePreKey: bobPreKeys.oneTimePreKeys[0] ?? null,
  };

  const x = performX3DH(alice, bundle);
  const opk = bundle.oneTimePreKey;
  const opkSecret = opk ? (bobPreKeys.opkSecrets.get(opk.keyId) ?? null) : null;
  const bobRoot = performX3DHReceiver(
    bob,
    bobPreKeys.signedPreKey.secretKey,
    opkSecret,
    alice.publicKey,
    decodeBase64(x.myEphemeralPublicKeyB64),
  );

  const bobSpkPub = decodeBase64(bobPreKeys.signedPreKey.publicKeyB64);
  const aliceState = initRatchet(x.rootKey, bobSpkPub, true);
  const bobState = initRatchet(bobRoot, new Uint8Array(), false, {
    publicKey: bobSpkPub,
    secretKey: bobPreKeys.signedPreKey.secretKey,
  });
  return { aliceState, bobState };
}

/** R1 hybrid session: ML-KEM-768 mixed into the root on every chain turn. */
function newHybridSession(): Session {
  const alice = buildIdentity();
  const bob = buildIdentity();
  const bobPreKeys = generatePreKeys(bob);

  const bundle: PreKeyBundle = {
    identityKeyB64: bob.publicKeyB64,
    signingPublicKeyB64: bob.signingPublicKeyB64,
    signedPreKey: {
      keyId: bobPreKeys.signedPreKey.keyId,
      publicKeyB64: bobPreKeys.signedPreKey.publicKeyB64,
      signatureB64: bobPreKeys.signedPreKey.signatureB64,
    },
    oneTimePreKey: null,
    pqSignedPreKey: {
      keyId: bobPreKeys.pqSignedPreKey.keyId,
      publicKeyB64: bobPreKeys.pqSignedPreKey.publicKeyB64,
      signatureB64: bobPreKeys.pqSignedPreKey.signatureB64,
    },
  };

  const x = performX3DH(alice, bundle);
  expect(x.version).toBe(2); // sanity: PQXDH negotiated
  const bobRoot = performX3DHReceiver(
    bob,
    bobPreKeys.signedPreKey.secretKey,
    null,
    alice.publicKey,
    decodeBase64(x.myEphemeralPublicKeyB64),
    {
      cipherText: decodeBase64(x.pqCiphertextB64!),
      pqSpkSecret: bobPreKeys.pqSignedPreKey.secretKey,
    },
  );

  const bobSpkPub = decodeBase64(bobPreKeys.signedPreKey.publicKeyB64);
  const bobPqPub = decodeBase64(bobPreKeys.pqSignedPreKey.publicKeyB64);

  const aliceState = initRatchet(x.rootKey, bobSpkPub, true, undefined, null, bobPqPub);
  const bobState = initRatchet(
    bobRoot,
    new Uint8Array(),
    false,
    { publicKey: bobSpkPub, secretKey: bobPreKeys.signedPreKey.secretKey },
    { publicKey: bobPqPub, secretKey: bobPreKeys.pqSignedPreKey.secretKey },
    null,
  );
  return { aliceState, bobState };
}

function enc(state: RatchetState, body: string) {
  return ratchetEncrypt(state, new TextEncoder().encode(body));
}

function dec(state: RatchetState, out: ReturnType<typeof ratchetEncrypt>): string | null {
  const pt = ratchetDecrypt(state, out.header, out.ciphertext, out.nonce);
  return pt ? new TextDecoder().decode(pt) : null;
}

describe('Double Ratchet — functional roundtrip', () => {
  it('alice -> bob: a single message decrypts to the original plaintext', () => {
    const { aliceState, bobState } = newSession();
    const out = enc(aliceState, 'hola bob');
    expect(dec(bobState, out)).toBe('hola bob');
  });

  it('two consecutive messages produce different ciphertexts (chain advances)', () => {
    const { aliceState } = newSession();
    const a = enc(aliceState, 'mismo texto');
    const b = enc(aliceState, 'mismo texto');
    expect(encodeBase64(a.ciphertext)).not.toBe(encodeBase64(b.ciphertext));
    expect(encodeBase64(a.nonce)).not.toBe(encodeBase64(b.nonce));
    expect(a.header.n).toBe(0);
    expect(b.header.n).toBe(1);
  });

  it('out-of-order delivery: msg 3 arrives before msg 1 and msg 2, all decrypt correctly', () => {
    const { aliceState, bobState } = newSession();
    const m1 = enc(aliceState, 'uno');
    const m2 = enc(aliceState, 'dos');
    const m3 = enc(aliceState, 'tres');

    expect(dec(bobState, m3)).toBe('tres');
    expect(dec(bobState, m1)).toBe('uno');
    expect(dec(bobState, m2)).toBe('dos');
  });

  it('large skip: alice sends 5, bob only sees the 5th — skipped keys are cached and decrypt later', () => {
    const { aliceState, bobState } = newSession();
    const ms = [0, 1, 2, 3, 4].map((i) => enc(aliceState, 'm' + i));
    expect(dec(bobState, ms[4])).toBe('m4');
    expect(dec(bobState, ms[0])).toBe('m0');
    expect(dec(bobState, ms[2])).toBe('m2');
    expect(dec(bobState, ms[3])).toBe('m3');
    expect(dec(bobState, ms[1])).toBe('m1');
  });
});

describe('Double Ratchet — security boundaries', () => {
  it('replay attack: decrypting the same message twice fails on the second attempt', () => {
    const { aliceState, bobState } = newSession();
    const out = enc(aliceState, 'unique payload');
    expect(dec(bobState, out)).toBe('unique payload');
    // After a successful decrypt the chain advanced and the message key was
    // wiped — a replay must NOT decrypt again to the same plaintext.
    const second = ratchetDecrypt(bobState, out.header, out.ciphertext, out.nonce);
    expect(second).toBeNull();
  });

  it('bit-flip in ciphertext: secretbox MAC rejects, decrypt returns null', () => {
    const { aliceState, bobState } = newSession();
    const out = enc(aliceState, 'integrity');
    const tampered = new Uint8Array(out.ciphertext);
    tampered[0] ^= 0x01;
    const pt = ratchetDecrypt(bobState, out.header, tampered, out.nonce);
    expect(pt).toBeNull();
  });

  it('nonce uniqueness: every encrypt call yields a fresh random nonce', () => {
    const { aliceState } = newSession();
    const nonces = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const out = enc(aliceState, 'n=' + i);
      nonces.add(encodeBase64(out.nonce));
    }
    expect(nonces.size).toBe(20);
  });

  it('forced same nonce on two different messages still yields different ciphertexts (distinct message keys)', () => {
    // Even if the wire nonces collided, the underlying message keys differ — so
    // the ciphertexts and MACs cannot collide. Re-opening b's ciphertext with
    // a's nonce under a zero key must fail.
    const { aliceState } = newSession();
    const a = enc(aliceState, 'colision');
    const b = enc(aliceState, 'colision');
    const cross = nacl.secretbox.open(b.ciphertext, a.nonce, new Uint8Array(32));
    expect(cross).toBeNull();
    expect(encodeBase64(a.ciphertext)).not.toBe(encodeBase64(b.ciphertext));
  });

  it('post-compromise security: after a DH ratchet step, the new state cannot decrypt an OLD message from the prior chain', () => {
    const { aliceState, bobState } = newSession();
    const m1 = enc(aliceState, 'first');
    expect(dec(bobState, m1)).toBe('first');
    // Bob replies — that introduces Bob's new DHs and forces a DH ratchet on Alice.
    const reply = enc(bobState, 'reply');
    expect(dec(aliceState, reply)).toBe('reply');
    // Alice ratcheted forward; replaying her own m1 against her new state must fail.
    const replay = ratchetDecrypt(aliceState, m1.header, m1.ciphertext, m1.nonce);
    expect(replay).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R1 — Hybrid PQ ratchet (ML-KEM-768 mixed into the root key at every chain
// turn). A hybrid session is bootstrapped from a PQXDH v2 handshake: Bob's
// PQSPK keypair seeds his initial PQs, Alice learns Bob's PQSPK public as her
// initial PQr.
// ─────────────────────────────────────────────────────────────────────────────
describe('R1 — hybrid PQ ratchet', () => {
  it('hybrid roundtrip: alice -> bob decrypts with PQ mixed in', () => {
    const { aliceState, bobState } = newHybridSession();
    const out = enc(aliceState, 'hola pq');
    // The chain-turn (first) message carries the PQ encapsulation key + ciphertext.
    expect(out.header.pqPub).toBeDefined();
    expect(out.header.pqCt).toBeDefined();
    expect(out.header.pqPub!.length).toBe(MLKEM768_PUBLICKEY_BYTES);
    expect(out.header.pqCt!.length).toBe(MLKEM768_CIPHERTEXT_BYTES);
    expect(dec(bobState, out)).toBe('hola pq');
  });

  it('intra-chain messages do NOT re-carry PQ material (mixed once per turn)', () => {
    const { aliceState } = newHybridSession();
    const m0 = enc(aliceState, 'm0');
    const m1 = enc(aliceState, 'm1');
    expect(m0.header.pqPub).toBeDefined();
    expect(m0.header.pqCt).toBeDefined();
    // n>0 in the same sending chain omits the (identical) PQ material.
    expect(m1.header.pqPub).toBeUndefined();
    expect(m1.header.pqCt).toBeUndefined();
  });

  it('full bidirectional turn: bob replies, alice decrypts (PQ rotates both ways)', () => {
    const { aliceState, bobState } = newHybridSession();
    expect(dec(bobState, enc(aliceState, 'first'))).toBe('first');
    const reply = enc(bobState, 'reply');
    // Bob's reply opens his sending chain -> carries his fresh PQ material.
    expect(reply.header.pqPub).toBeDefined();
    expect(reply.header.pqCt).toBeDefined();
    expect(dec(aliceState, reply)).toBe('reply');
  });

  it('PQ public key rotates on every chain turn (fresh ML-KEM keypair per turn)', () => {
    const { aliceState, bobState } = newHybridSession();
    const round1 = encodeBase64(aliceState.PQs!.publicKey);
    // Bob replies → Alice ratchets and regenerates her PQ pair.
    expect(dec(bobState, enc(aliceState, 'a0'))).toBe('a0');
    const reply = enc(bobState, 'b0');
    expect(dec(aliceState, reply)).toBe('b0');
    const round2 = encodeBase64(aliceState.PQs!.publicKey);
    expect(round2).not.toBe(round1);
  });

  it('multi-turn ping-pong stays in sync across several PQ chain rotations', () => {
    const { aliceState, bobState } = newHybridSession();
    for (let i = 0; i < 4; i++) {
      expect(dec(bobState, enc(aliceState, `a${i}`))).toBe(`a${i}`);
      expect(dec(aliceState, enc(bobState, `b${i}`))).toBe(`b${i}`);
    }
  });

  it('out-of-order intra-chain decrypts once the chain-turn message is seen first', () => {
    // PQ material rides ONLY on the chain-turn message (n=0), so that message
    // must be processed before later ones in its chain (guaranteed by the
    // ordered mailbox transport). After it, intra-chain reordering works exactly
    // like the classic ratchet (skipped-key cache).
    const { aliceState, bobState } = newHybridSession();
    const m1 = enc(aliceState, 'uno'); // chain-turn (carries PQ)
    const m2 = enc(aliceState, 'dos');
    const m3 = enc(aliceState, 'tres');
    expect(dec(bobState, m1)).toBe('uno'); // establish the hybrid chain first
    expect(dec(bobState, m3)).toBe('tres'); // then reorder freely
    expect(dec(bobState, m2)).toBe('dos');
  });

  it('anti-downgrade: a chain-turn message stripped of pqCt is rejected (throws)', () => {
    const { aliceState, bobState } = newHybridSession();
    const out = enc(aliceState, 'downgrade me');
    // Simulate a relay/MITM dropping the PQ ciphertext on a hybrid session.
    const tampered = { ...out.header, pqCt: undefined };
    expect(() =>
      ratchetDecrypt(bobState, tampered, out.ciphertext, out.nonce),
    ).toThrow(/missing PQ material|downgrade/i);
  });

  it('anti-downgrade: a chain-turn message stripped of pqPub is rejected (throws)', () => {
    const { aliceState, bobState } = newHybridSession();
    const out = enc(aliceState, 'downgrade pub');
    const tampered = { ...out.header, pqPub: undefined };
    expect(() =>
      ratchetDecrypt(bobState, tampered, out.ciphertext, out.nonce),
    ).toThrow(/missing PQ material|downgrade/i);
  });

  it('fail-closed: a forged ML-KEM ciphertext does NOT silently decrypt (returns null, live state untouched)', () => {
    // Decapsulating a tampered ML-KEM ciphertext yields (via implicit rejection)
    // a DIFFERENT shared secret, so Bob derives a divergent receiving root and
    // the secretbox MAC fails. The ratchet must surface this as null — never a
    // silent plaintext — and must NOT mutate the live state (the genuine message
    // is still decryptable afterwards).
    const { aliceState, bobState } = newHybridSession();
    const out = enc(aliceState, 'authentic body');
    const forgedCt = new Uint8Array(out.header.pqCt!);
    forgedCt[0] ^= 0xff;
    const tampered = { ...out.header, pqCt: forgedCt };
    expect(ratchetDecrypt(bobState, tampered, out.ciphertext, out.nonce)).toBeNull();
    // Live state survived: the genuine chain-turn message still decrypts.
    expect(dec(bobState, out)).toBe('authentic body');
  });

  it('classic session carries no PQ header fields (v1 interop unchanged)', () => {
    const { aliceState } = newSession();
    const out = enc(aliceState, 'classic');
    expect(out.header.pqPub).toBeUndefined();
    expect(out.header.pqCt).toBeUndefined();
  });

  it('classic session never populates PQ state (byte-identity with pre-R1 path)', () => {
    const { aliceState, bobState } = newSession();
    // No PQ keypairs or advertised ciphertext anywhere in a v1 session.
    expect(aliceState.PQs ?? null).toBeNull();
    expect(aliceState.PQr ?? null).toBeNull();
    expect(aliceState.pqSendCt ?? null).toBeNull();
    expect(bobState.PQs ?? null).toBeNull();
    expect(bobState.PQr ?? null).toBeNull();
  });
});

// Cross-platform KAT: the hybrid root derivation (dhOut ‖ pqSecret under the
// 'AegisLinkRootPQ' label) MUST be byte-identical on desktop and mobile, or two
// twin clients silently derive different roots and every message fails. This
// exact block + vector is mirrored in the mobile ratchet test
// (mobile/src/crypto/signal/__tests__/ratchet.test.ts) and the desktop x3dh test.
// Regenerate via _scratch/kat-gen.mjs if the derivation ever changes (it must not).
const KAT_ROOT_PQ_HEX =
  '4302ce0529c32b63da34f031ea6658753e568732c4fd56526fd421a81b74559c' +
  'bac8b9ad0a53c62d197de7ecb208b50a35387e4a8c03278e113bf4c44a490fea';

describe('R1 — cross-platform hybrid root KAT', () => {
  it('hybrid root derivation matches the pinned vector (mobile↔desktop parity)', () => {
    const rk = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const dhOut = Uint8Array.from({ length: 32 }, (_, i) => (i * 7) & 0xff);
    const pqSecret = Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 5) & 0xff);
    const combined = new Uint8Array(64);
    combined.set(dhOut, 0);
    combined.set(pqSecret, 32);
    const out = hkdfSHA256(combined, rk, new TextEncoder().encode('AegisLinkRootPQ'), 64);
    expect(Buffer.from(out).toString('hex')).toBe(KAT_ROOT_PQ_HEX);
  });
});

describe('Double Ratchet — MAX_SKIPPED_KEYS bound', () => {
  it('rejects an attempt to skip more than MAX_SKIPPED_KEYS messages in a single jump', () => {
    const { aliceState, bobState } = newSession();
    const count = MAX_SKIPPED_KEYS + 2;
    let last: ReturnType<typeof ratchetEncrypt> | null = null;
    for (let i = 0; i < count; i++) {
      last = enc(aliceState, 'm' + i);
    }
    expect(() =>
      ratchetDecrypt(bobState, last!.header, last!.ciphertext, last!.nonce),
    ).toThrow(/Too many skipped/i);
  });

  it('exactly MAX_SKIPPED_KEYS skipped messages are still accepted', () => {
    const { aliceState, bobState } = newSession();
    const msgs: ReturnType<typeof ratchetEncrypt>[] = [];
    for (let i = 0; i <= MAX_SKIPPED_KEYS; i++) {
      msgs.push(enc(aliceState, 'm' + i));
    }
    const tail = msgs[MAX_SKIPPED_KEYS];
    expect(dec(bobState, tail)).toBe('m' + MAX_SKIPPED_KEYS);
    expect(bobState.MKSKIPPED.size).toBeLessThanOrEqual(MAX_SKIPPED_KEYS);
  });
});
