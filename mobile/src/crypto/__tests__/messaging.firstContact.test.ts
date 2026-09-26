/**
 * Federation F3b — first-contact bootstrap over the sealed v2 envelope.
 *
 * Across relays there is no v1 (aegisId) transport, so the FIRST sealed message
 * must carry the X3DH init and let a recipient who has never heard of the
 * sender authenticate it:
 *   - the sender embeds its Ed25519 signing key in the sealed layer (`spk`) and
 *     a first-contact block (`fc`: identity key, home relay, mailbox root) in
 *     the inner; the wire itself still carries NO sender identity;
 *   - the opener accepts an unknown sender ONLY when the caller opts in
 *     (allowFirstContact) AND the envelope is a real bootstrap (x3dh + fc);
 *   - a KNOWN contact's pinned signing key always wins over an embedded one;
 *   - without the opt-in nothing changes: unknown sender → rejected, as before.
 * Same file (vitest imports aside) runs on desktop.
 */
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { runAnonymousOnboarding } from '../onboarding';
import { performX3DH } from '../signal/x3dh';
import { initRatchet } from '../signal/ratchet';
import { encryptMessageV2, openEnvelopeV2, type FirstContactBlock } from '../messaging';
import { vk } from './helpers/rawIdentity';

const NOW = 1_750_000_000_000;
const ONION = 'pg6mmjiyjmcrsslvykfwnntlaru7p5svn6y2ymmju6nubxndf4pscryd.onion';

function signingPub(identity: { signingPublicKey: Uint8Array }): Uint8Array {
  return identity.signingPublicKey;
}

/** Alice performs X3DH against Bob's bundle; her state carries the pending x3dhInit. */
function aliceInitState() {
  const alice = runAnonymousOnboarding(5);
  const bob = runAnonymousOnboarding(5);
  const x = performX3DH(alice.identity, bob.bundle);
  const state = initRatchet('self', x.rootKey, decodeBase64(bob.bundle.signedPreKey.publicKeyB64), true);
  state.x3dhInit = { aliceEKB64: x.myEphemeralPublicKeyB64, spkId: bob.bundle.signedPreKey.keyId, opkId: bob.bundle.oneTimePreKey?.keyId ?? null };
  const fc: FirstContactBlock = { ik: alice.identity.publicKeyB64, relay: ONION, root: encodeBase64(nacl.randomBytes(32)) };
  return { alice, bob, state, fc };
}

const unknown = () => null;

describe('first-contact sealed v2 (F3b)', () => {
  it('a bootstrap envelope from an unknown sender opens ONLY with the opt-in, and reports the TOFU key', () => {
    const { alice, bob, state, fc } = aliceInitState();
    const { wire, newState } = encryptMessageV2('hola', alice.identity.aegisId, bob.identity.publicKey, alice.identity.signingSecretKey, state, NOW,
      { block: fc, senderSigningPublicKey: signingPub(alice.identity) });
    expect(Object.keys(wire).sort()).toEqual(['ciphertext', 'epk', 'nonce']); // still no identity on the wire
    expect(newState.x3dhInit).toBeUndefined(); // consumed

    // Without opt-in: rejected exactly as before.
    expect(openEnvelopeV2(wire, bob.identity.secretKey, unknown, NOW)).toBeNull();

    const inner = openEnvelopeV2(wire, bob.identity.secretKey, unknown, NOW, { allowFirstContact: true });
    expect(inner).not.toBeNull();
    expect(inner!.from).toBe(alice.identity.aegisId);
    expect(inner!.tofuSigningKeyB64).toBe(encodeBase64(signingPub(alice.identity)));
    expect(inner!.x3dh).toEqual(state.x3dhInit);
    expect(inner!.fc).toEqual(fc);
  });

  it('an unknown sender WITHOUT a bootstrap (no x3dh/fc) is rejected even with the opt-in', () => {
    const { alice, bob, state } = aliceInitState();
    delete state.x3dhInit;
    const { wire } = encryptMessageV2('hola', alice.identity.aegisId, bob.identity.publicKey, alice.identity.signingSecretKey, state, NOW,
      { block: { ik: alice.identity.publicKeyB64, relay: null, root: 'r' }, senderSigningPublicKey: signingPub(alice.identity) });
    expect(openEnvelopeV2(wire, bob.identity.secretKey, unknown, NOW, { allowFirstContact: true })).toBeNull();
  });

  it('a known contact keeps its pinned key: an embedded key never overrides it', () => {
    const { alice, bob, state, fc } = aliceInitState();
    const impostorSigning = nacl.sign.keyPair();
    // The impostor signs as "alice" and embeds ITS key; Bob already pins Alice's real key.
    const { wire } = encryptMessageV2('hola', alice.identity.aegisId, bob.identity.publicKey, vk(impostorSigning.secretKey), state, NOW,
      { block: fc, senderSigningPublicKey: impostorSigning.publicKey });
    const pinned = (from: string) => (from === alice.identity.aegisId ? signingPub(alice.identity) : null);
    expect(openEnvelopeV2(wire, bob.identity.secretKey, pinned, NOW, { allowFirstContact: true })).toBeNull();
  });

  it('a tampered fc block (bad shape) is rejected', () => {
    const { alice, bob, state } = aliceInitState();
    const bad = { ik: alice.identity.publicKeyB64, relay: 42, root: 'r' } as unknown as FirstContactBlock;
    const { wire } = encryptMessageV2('hola', alice.identity.aegisId, bob.identity.publicKey, alice.identity.signingSecretKey, state, NOW,
      { block: bad, senderSigningPublicKey: signingPub(alice.identity) });
    expect(openEnvelopeV2(wire, bob.identity.secretKey, unknown, NOW, { allowFirstContact: true })).toBeNull();
  });

  it('a non-bootstrap v2 (no firstContact arg) still never carries x3dh even if the state has one', () => {
    const { alice, bob, state } = aliceInitState();
    const { wire } = encryptMessageV2('hola', alice.identity.aegisId, bob.identity.publicKey, alice.identity.signingSecretKey, state, NOW);
    const inner = openEnvelopeV2(wire, bob.identity.secretKey, (f) => (f === alice.identity.aegisId ? signingPub(alice.identity) : null), NOW);
    expect(inner).not.toBeNull();
    expect(inner!.x3dh).toBeUndefined();
    expect(inner!.fc).toBeUndefined();
  });
});
