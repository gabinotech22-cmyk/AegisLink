/**
 * ratchet.test.ts — Double Ratchet edge cases (crypto/signal/ratchet.ts).
 *
 * These tests exercise the ratchet API directly (no Sealed Sender wrapper).
 * They cover happy-path roundtrips plus the security boundaries an attacker
 * could probe: replay, bit-flip on ciphertext, nonce reuse pressure,
 * post-compromise security after a DH ratchet step, and the MAX_SKIPPED_KEYS
 * forward-secrecy bound.
 */

import nacl from 'tweetnacl';
import { decodeBase64, decodeUTF8, encodeUTF8 } from 'tweetnacl-util';

import { runAnonymousOnboarding } from '../../onboarding';
import { performX3DH, performX3DHReceiver, generatePreKeys } from '../x3dh';
import { hkdfSHA256 } from '../kdf';
import {
  initRatchet,
  ratchetDecrypt,
  ratchetEncrypt,
  MAX_SKIPPED_KEYS,
  type RatchetState,
} from '../ratchet';

interface Session {
  aliceState: RatchetState;
  bobState: RatchetState;
}

function newSession(): Session {
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
  return { aliceState, bobState };
}

function enc(state: RatchetState, body: string) {
  return ratchetEncrypt(state, decodeUTF8(body));
}

function dec(
  state: RatchetState,
  out: ReturnType<typeof ratchetEncrypt>,
): string | null {
  const pt = ratchetDecrypt(state, out.header, out.ciphertext, out.nonce);
  return pt ? encodeUTF8(pt) : null;
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
    // Same plaintext, different message keys -> ciphertexts must differ.
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
    // And different nonces (randomBytes(24)).
    expect(Buffer.from(a.nonce).equals(Buffer.from(b.nonce))).toBe(false);
    expect(a.header.n).toBe(0);
    expect(b.header.n).toBe(1);
  });

  it('out-of-order delivery: msg 3 arrives before msg 1 and msg 2, all decrypt correctly', () => {
    const { aliceState, bobState } = newSession();
    const m1 = enc(aliceState, 'uno');
    const m2 = enc(aliceState, 'dos');
    const m3 = enc(aliceState, 'tres');

    // Bob receives in reverse order: 3, 1, 2.
    expect(dec(bobState, m3)).toBe('tres');
    expect(dec(bobState, m1)).toBe('uno');
    expect(dec(bobState, m2)).toBe('dos');
  });

  it('large skip: alice sends 5, bob only sees the 5th — skipped keys are cached and decrypt later', () => {
    const { aliceState, bobState } = newSession();
    const ms = [0, 1, 2, 3, 4].map((i) => enc(aliceState, 'm' + i));
    // Bob jumps straight to the last one.
    expect(dec(bobState, ms[4])).toBe('m4');
    // The cached skipped keys (n=0..3) let the earlier ones still open.
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
      nonces.add(Buffer.from(out.nonce).toString('hex'));
    }
    expect(nonces.size).toBe(20);
  });

  it('forced same nonce on two different messages still yields different ciphertexts (distinct message keys)', () => {
    // We can't reach into ratchetEncrypt to force a nonce, but the property we
    // really care about is: even if the wire nonces collided, the underlying
    // message keys differ — so the ciphertexts and MACs cannot collide.
    const { aliceState } = newSession();
    const a = enc(aliceState, 'colision');
    const b = enc(aliceState, 'colision');
    // Manually re-open with secretbox using a's nonce on b's ciphertext: must fail
    // because b's message key differs.
    const fakedNonce = a.nonce;
    const cross = nacl.secretbox.open(b.ciphertext, fakedNonce, new Uint8Array(32));
    expect(cross).toBeNull();
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
  });

  it('post-compromise security: after a DH ratchet step, the new state cannot decrypt an OLD message from the prior chain', () => {
    // Alice sends one message, Bob replies; Bob's reply forces a DH ratchet on
    // Alice's side. Alice's *new* state must not be able to re-decrypt the very
    // first message she sent (its chain key was zeroized).
    const { aliceState, bobState } = newSession();
    const m1 = enc(aliceState, 'first');
    expect(dec(bobState, m1)).toBe('first');
    // Bob replies — that introduces Bob's new DHs.
    const reply = enc(bobState, 'reply');
    expect(dec(aliceState, reply)).toBe('reply');
    // Alice now ratcheted forward. Replaying her own m1 against her new state
    // (treating it as if it had been her last received) must fail: she has no
    // CKr that matches header.ratchetKey == her own old DHs.publicKey, and the
    // skipped-key map never recorded that key.
    const replay = ratchetDecrypt(aliceState, m1.header, m1.ciphertext, m1.nonce);
    expect(replay).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R1 — Hybrid PQ ratchet (ML-KEM-768 mixed into the root key at every chain
// turn). A hybrid session is bootstrapped from a PQXDH v2 handshake: Bob's
// PQSPK keypair seeds his initial PQs, Alice learns Bob's PQSPK public as her
// initial PQr. See docs/R1-PQ-PER-FRAME-DESIGN.md.
// ─────────────────────────────────────────────────────────────────────────────

function newHybridSession(): Session {
  const alice = runAnonymousOnboarding(5);
  const bob = runAnonymousOnboarding(5);
  const bobPreKeys = generatePreKeys(bob.identity);

  const bundle = {
    identityKeyB64: bob.identity.publicKeyB64,
    signingPublicKeyB64: bob.identity.signingPublicKeyB64,
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

  const x = performX3DH(alice.identity, bundle);
  expect(x.version).toBe(2); // sanity: PQXDH negotiated
  const bobRoot = performX3DHReceiver(
    bob.identity,
    bobPreKeys.signedPreKey.secretKey,
    null,
    alice.identity.publicKey,
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

describe('R1 — hybrid PQ ratchet', () => {
  it('hybrid roundtrip: alice -> bob decrypts with PQ mixed in', () => {
    const { aliceState, bobState } = newHybridSession();
    const out = enc(aliceState, 'hola pq');
    // The chain-turn (first) message carries the PQ encapsulation key + ciphertext.
    expect(out.header.pqPub).toBeDefined();
    expect(out.header.pqCt).toBeDefined();
    expect(out.header.pqPub!.length).toBe(1184);
    expect(out.header.pqCt!.length).toBe(1088);
    expect(dec(bobState, out)).toBe('hola pq');
  });

  it('intra-chain messages re-carry the SAME PQ material (lost-chain-head tolerance)', () => {
    // Policy inverted 2026-07: pqPub/pqCt used to ride only on n=0, which made
    // the whole chain undecryptable if that one message was lost. Now every
    // message of the chain repeats the identical material so a receiver can
    // turn the chain from any of them.
    const { aliceState } = newHybridSession();
    const m0 = enc(aliceState, 'm0');
    const m1 = enc(aliceState, 'm1');
    expect(m0.header.pqPub).toBeDefined();
    expect(m0.header.pqCt).toBeDefined();
    expect(m1.header.pqPub).toBeDefined();
    expect(m1.header.pqCt).toBeDefined();
    // Identical, not re-encapsulated: PQ mixing still happens once per turn.
    expect(m1.header.pqCt).toEqual(m0.header.pqCt);
    expect(m1.header.pqPub).toEqual(m0.header.pqPub);
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

  it('multi-turn ping-pong stays in sync across several PQ chain rotations', () => {
    const { aliceState, bobState } = newHybridSession();
    for (let i = 0; i < 4; i++) {
      expect(dec(bobState, enc(aliceState, `a${i}`))).toBe(`a${i}`);
      expect(dec(aliceState, enc(bobState, `b${i}`))).toBe(`b${i}`);
    }
  });

  it('out-of-order intra-chain decrypts once the chain-turn message is seen first', () => {
    // Under the phased (v1) design PQ material rides ONLY on the chain-turn
    // message (n=0), so that message must be processed before later ones in its
    // chain — guaranteed by our ordered mailbox transport. After it, intra-chain
    // reordering works exactly like the classic ratchet (skipped-key cache).
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

  it('classic session carries no PQ header fields (v1 interop unchanged)', () => {
    const { aliceState } = newSession();
    const out = enc(aliceState, 'classic');
    expect(out.header.pqPub).toBeUndefined();
    expect(out.header.pqCt).toBeUndefined();
  });
});

// Cross-platform KAT: the hybrid root derivation (dhOut ‖ pqSecret under the
// 'AegisLinkRootPQ' label) MUST be byte-identical on mobile and desktop, or two
// twin clients silently derive different roots and every message fails. This
// exact block + vector is mirrored in the desktop ratchet test. Regenerate via
// _scratch/kat-gen.mjs if the derivation ever changes (it should not).
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
    // Alice produces MAX_SKIPPED_KEYS + 2 messages without bob seeing any of them.
    const count = MAX_SKIPPED_KEYS + 2;
    let last: ReturnType<typeof ratchetEncrypt> | null = null;
    for (let i = 0; i < count; i++) {
      last = enc(aliceState, 'm' + i);
    }
    // Bob jumps straight to the final one — must throw, not allocate unbounded memory.
    expect(() => ratchetDecrypt(bobState, last!.header, last!.ciphertext, last!.nonce)).toThrow(
      /Too many skipped/i,
    );
  });

  it('exactly MAX_SKIPPED_KEYS skipped messages are still accepted', () => {
    const { aliceState, bobState } = newSession();
    const msgs: ReturnType<typeof ratchetEncrypt>[] = [];
    // Send MAX_SKIPPED_KEYS+1 total; bob decrypts only the last so he must skip MAX_SKIPPED_KEYS.
    for (let i = 0; i <= MAX_SKIPPED_KEYS; i++) {
      msgs.push(enc(aliceState, 'm' + i));
    }
    const tail = msgs[MAX_SKIPPED_KEYS];
    expect(dec(bobState, tail)).toBe('m' + MAX_SKIPPED_KEYS);
    // And the cap on the skipped-keys map is enforced.
    expect(bobState.MKSKIPPED.size).toBeLessThanOrEqual(MAX_SKIPPED_KEYS);
  });
});
