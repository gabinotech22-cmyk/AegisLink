/**
 * Glare resolution for simultaneous ratchet desync recovery
 * (mobile/src/socket/client.ts).
 *
 * Scenario: BOTH peers detect a permanent desync at nearly the same instant
 * (e.g. both drain old queued messages on startup). Without a tiebreaker, both
 * tear down their session and both run a fresh X3DH as Alice; each then adopts
 * the OTHER's init and the two devices end on DIFFERENT root keys → still
 * desynced ("nothing arrives").
 *
 * The fix is a deterministic winner: the peer with the HIGHER aegisId is the
 * canonical initiator. Both converge on the single session whose Alice == the
 * higher aegisId:
 *   - higher peer KEEPS its own init, IGNORES the lower peer's incoming init.
 *   - lower peer ADOPTS the higher peer's init.
 *
 * This test reproduces the simultaneous handshake at the crypto layer and
 * asserts that, after applying the deterministic adoption rule, BOTH peers hold
 * the SAME root key and can decrypt the initiator's first ratchet message — i.e.
 * they converge instead of diverging.
 */

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from 'tweetnacl-util';
import { performX3DH, performX3DHReceiver } from '../../crypto/signal/x3dh';
import { initRatchet, ratchetDecrypt, ratchetEncrypt, type RatchetState } from '../../crypto/signal/ratchet';
import { deriveAegisId } from '../../crypto/identity';

interface Peer {
  aegisId: string;
  box: nacl.BoxKeyPair;
  sign: nacl.SignKeyPair;
  // Published SPK (and its secret) used when this peer plays Bob (receiver).
  spk: nacl.BoxKeyPair;
}

function buildPeer(): Peer {
  const box = nacl.box.keyPair();
  const sign = nacl.sign.keyPair();
  const spk = nacl.box.keyPair();
  return { aegisId: deriveAegisId(box.publicKey), box, sign, spk };
}

function bundleFor(p: Peer) {
  const sig = nacl.sign.detached(p.spk.publicKey, p.sign.secretKey);
  return {
    identityKeyB64: encodeBase64(p.box.publicKey),
    signingPublicKeyB64: encodeBase64(p.sign.publicKey),
    signedPreKey: { keyId: 1, publicKeyB64: encodeBase64(p.spk.publicKey), signatureB64: encodeBase64(sig) },
    oneTimePreKey: null,
  };
}

/** Mirror of amInitiatorFor in client.ts — the deterministic tiebreaker. */
const amInitiatorFor = (mine: string, peer: string) => mine > peer;

/**
 * Run an X3DH init from `alice` to `bob` and return the wire artifacts plus
 * alice's sender ratchet, exactly as sendProfileTo / encryptMessage would.
 */
function aliceInit(alice: Peer, bob: Peer) {
  const x3dh = performX3DH(
    {
      aegisId: alice.aegisId,
      publicKey: alice.box.publicKey,
      secretKey: alice.box.secretKey,
      publicKeyB64: encodeBase64(alice.box.publicKey),
      secretKeyB64: encodeBase64(alice.box.secretKey),
      signingPublicKey: alice.sign.publicKey,
      signingSecretKey: alice.sign.secretKey,
      signingPublicKeyB64: encodeBase64(alice.sign.publicKey),
      signingSecretKeyB64: encodeBase64(alice.sign.secretKey),
      createdAt: 0,
    } as any,
    bundleFor(bob),
  );
  const senderState = initRatchet(x3dh.rootKey, bob.spk.publicKey, true);
  return {
    rootKey: x3dh.rootKey,
    senderState,
    x3dhInit: {
      aliceEKB64: x3dh.myEphemeralPublicKeyB64,
      spkId: 1,
      opkId: null as number | null,
    },
  };
}

/** Bob adopts alice's init, deriving the same root key (decryptAndAppend x3dh branch). */
function bobAdopt(bob: Peer, alice: Peer, init: ReturnType<typeof aliceInit>): { rootKey: Uint8Array; state: RatchetState } {
  const rootKey = performX3DHReceiver(
    {
      aegisId: bob.aegisId,
      publicKey: bob.box.publicKey,
      secretKey: bob.box.secretKey,
      publicKeyB64: encodeBase64(bob.box.publicKey),
      secretKeyB64: encodeBase64(bob.box.secretKey),
      signingPublicKey: bob.sign.publicKey,
      signingSecretKey: bob.sign.secretKey,
      signingPublicKeyB64: encodeBase64(bob.sign.publicKey),
      signingSecretKeyB64: encodeBase64(bob.sign.secretKey),
      createdAt: 0,
    } as any,
    bob.spk.secretKey,
    null,
    alice.box.publicKey,
    decodeBase64(init.x3dhInit.aliceEKB64),
  );
  const state = initRatchet(rootKey, bob.spk.publicKey, false, {
    publicKey: bob.spk.publicKey,
    secretKey: bob.spk.secretKey,
  });
  return { rootKey, state };
}

describe('glare resolution (simultaneous desync recovery)', () => {
  it('WITHOUT a tiebreaker both peers diverge (documents the bug)', () => {
    const a = buildPeer();
    const b = buildPeer();

    // Both initiate simultaneously.
    const initA = aliceInit(a, b); // A=Alice
    const initB = aliceInit(b, a); // B=Alice

    // Naive (buggy) behaviour: each adopts the OTHER's init.
    const aAfter = bobAdopt(a, b, initB).rootKey; // A adopts B's init
    const bAfter = bobAdopt(b, a, initA).rootKey; // B adopts A's init

    // They end on DIFFERENT root keys → desynced.
    expect(encodeBase64(aAfter)).not.toEqual(encodeBase64(bAfter));
  });

  it('WITH the deterministic tiebreaker both peers converge on the higher-aegisId session', () => {
    let a = buildPeer();
    let b = buildPeer();
    // Normalise so `a` is always the LOWER aegisId and `b` the HIGHER.
    if (a.aegisId > b.aegisId) { const t = a; a = b; b = t; }
    expect(amInitiatorFor(b.aegisId, a.aegisId)).toBe(true);
    expect(amInitiatorFor(a.aegisId, b.aegisId)).toBe(false);

    // Both still detect desync and both build a fresh init (glare). But only the
    // HIGHER peer (b) actually sends; the lower (a) waits. Either way the rule is:
    //   - higher peer (b) keeps its OWN session (init from b→a)
    //   - lower peer (a) adopts b's init
    const initB = aliceInit(b, a); // b is the canonical initiator

    // Higher peer b keeps its own sender state (root = initB.rootKey).
    const bRoot = initB.rootKey;

    // Lower peer a adopts b's init.
    const aAdopt = bobAdopt(a, b, initB);
    const aRoot = aAdopt.rootKey;

    // Converged: identical root keys.
    expect(encodeBase64(aRoot)).toEqual(encodeBase64(bRoot));

    // And they can actually talk: b encrypts, a decrypts on the converged session.
    const { header, ciphertext, nonce } = ratchetEncrypt(initB.senderState, decodeUTF8('converged ✓'));
    const plain = ratchetDecrypt(aAdopt.state, header, ciphertext, nonce);
    expect(plain).not.toBeNull();
    expect(encodeUTF8(plain!)).toBe('converged ✓');
  });
});
