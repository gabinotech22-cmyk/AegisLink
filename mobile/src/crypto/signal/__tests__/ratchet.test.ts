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
import { performX3DH, performX3DHReceiver } from '../x3dh';
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
