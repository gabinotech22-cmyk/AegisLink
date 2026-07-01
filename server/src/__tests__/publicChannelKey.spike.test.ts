/**
 * publicChannelKey.spike.test.ts — Phase 0 spike (docs/SEALED-PUBLIC-CHANNELS.md)
 *
 * Validates the sealed public channel crypto primitives: channel identity,
 * CEK wrap/unwrap, delivery token, manifest signing, post encrypt/decrypt
 * with Ed25519 sender authentication, hash chain integrity, editor delegation
 * certs, and channel tombstone.
 */

import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { createHash } from 'node:crypto';
import {
  deriveChannelId,
  generateChannelIdentity,
  generateCEK,
  deriveWrapKey,
  wrapCEK,
  unwrapCEK,
  deriveChannelDeliveryToken,
  hashChannelDeliveryToken,
  verifyChannelDeliveryToken,
  signManifest,
  verifyManifest,
  buildManifestSignedInput,
  sealChannelPost,
  openChannelPost,
  computePostHash,
  verifyChainLink,
  signPost,
  verifyPostSignature,
  signDelegation,
  verifyDelegation,
  verifyDelegatedPost,
  signTombstone,
  verifyTombstone,
  type ChannelManifestData,
  type ChannelPostInner,
  type DelegationCertData,
} from '../crypto/publicChannelKey.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const publisher = {
  sign: nacl.sign.keyPair(),
  aegisId: 'PUB-LISH-AAAA',
};
const subscriber = {
  sign: nacl.sign.keyPair(),
  aegisId: 'SUB-SCRI-BBBB',
};
const editor = {
  sign: nacl.sign.keyPair(),
  aegisId: 'EDT-ORCC-CCCC',
};
const mallory = {
  sign: nacl.sign.keyPair(),
  aegisId: 'MAL-LORY-XXXX',
};

const NOW = 1_750_000_000_000;
const ZERO_HASH = new Uint8Array(32); // all-zero prevHash for seqNum 0
const ZERO_ATTACHMENTS = new Uint8Array(32); // no attachments

function sha256(data: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash('sha256').update(Buffer.from(data)).digest());
}

// ── §2 — Channel identity ────────────────────────────────────────────────────

describe('channel identity', () => {
  test('deriveChannelId is deterministic for same key + salt', () => {
    const salt = nacl.randomBytes(16);
    const id1 = deriveChannelId(publisher.sign.publicKey, salt);
    const id2 = deriveChannelId(publisher.sign.publicKey, salt);
    expect(id1).toBe(id2);
  });

  test('different salt produces different channelId', () => {
    const id1 = deriveChannelId(publisher.sign.publicKey, nacl.randomBytes(16));
    const id2 = deriveChannelId(publisher.sign.publicKey, nacl.randomBytes(16));
    expect(id1).not.toBe(id2);
  });

  test('generateChannelIdentity produces valid identity', () => {
    const identity = generateChannelIdentity();
    expect(identity.channelId).toBeDefined();
    expect(identity.channelEd25519Pub.length).toBe(32);
    expect(identity.channelEd25519Secret.length).toBe(64);
    expect(identity.salt.length).toBe(16);
    const recomputed = deriveChannelId(identity.channelEd25519Pub, identity.salt);
    expect(recomputed).toBe(identity.channelId);
  });

  test('rejects invalid public key length', () => {
    expect(() => deriveChannelId(new Uint8Array(16), nacl.randomBytes(16)))
      .toThrow('invalid public key length');
  });

  test('rejects invalid salt length', () => {
    expect(() => deriveChannelId(publisher.sign.publicKey, new Uint8Array(8)))
      .toThrow('salt must be 16 bytes');
  });
});

// ── §4 — CEK wrap/unwrap + delivery token ─────────────────────────────────────

describe('CEK wrap/unwrap', () => {
  const channel = generateChannelIdentity();
  const capability = nacl.randomBytes(32);
  const cek = generateCEK();

  test('round-trip: wrap then unwrap recovers exact CEK', () => {
    const wrapped = wrapCEK(cek, capability, channel.channelId);
    const recovered = unwrapCEK(wrapped.ivB64, wrapped.wrappedB64, capability, channel.channelId);
    expect(recovered).not.toBeNull();
    expect(encodeBase64(recovered!)).toBe(encodeBase64(cek));
  });

  test('wrong capability fails unwrap', () => {
    const wrapped = wrapCEK(cek, capability, channel.channelId);
    const wrongCap = nacl.randomBytes(32);
    const recovered = unwrapCEK(wrapped.ivB64, wrapped.wrappedB64, wrongCap, channel.channelId);
    expect(recovered).toBeNull();
  });

  test('wrong channelId fails unwrap', () => {
    const wrapped = wrapCEK(cek, capability, channel.channelId);
    const otherChannel = generateChannelIdentity();
    const recovered = unwrapCEK(wrapped.ivB64, wrapped.wrappedB64, capability, otherChannel.channelId);
    expect(recovered).toBeNull();
  });

  test('tampered ciphertext fails unwrap', () => {
    const wrapped = wrapCEK(cek, capability, channel.channelId);
    const tampered = wrapped.wrappedB64.slice(0, -4) + 'AAAA';
    const recovered = unwrapCEK(wrapped.ivB64, tampered, capability, channel.channelId);
    expect(recovered).toBeNull();
  });
});

describe('delivery token', () => {
  const capability = nacl.randomBytes(32);
  const channel = generateChannelIdentity();

  test('derivation is deterministic', () => {
    const t1 = deriveChannelDeliveryToken(capability, channel.channelId);
    const t2 = deriveChannelDeliveryToken(capability, channel.channelId);
    expect(t1).toBe(t2);
  });

  test('different capability produces different token', () => {
    const t1 = deriveChannelDeliveryToken(capability, channel.channelId);
    const t2 = deriveChannelDeliveryToken(nacl.randomBytes(32), channel.channelId);
    expect(t1).not.toBe(t2);
  });

  test('hash + verify round-trip (constant-time)', () => {
    const token = deriveChannelDeliveryToken(capability, channel.channelId);
    const hash = hashChannelDeliveryToken(token);
    expect(verifyChannelDeliveryToken(token, hash)).toBe(true);
  });

  test('wrong token fails verification', () => {
    const token = deriveChannelDeliveryToken(capability, channel.channelId);
    const hash = hashChannelDeliveryToken(token);
    expect(verifyChannelDeliveryToken('wrong-token', hash)).toBe(false);
  });
});

// ── §3.3 — Manifest signing ──────────────────────────────────────────────────

describe('manifest signing', () => {
  const channel = generateChannelIdentity();
  const cek = generateCEK();

  function makeManifest(): ChannelManifestData {
    return {
      channelId: channel.channelId,
      salt: channel.salt,
      channelEd25519Pub: channel.channelEd25519Pub,
      name: 'Test Channel',
      description: 'A test public channel',
      avatarHash: null,
      channelType: 0,
      createdAtHourMs: NOW,
      manifestSeq: 1,
      contentKeyHash: sha256(cek),
      delegationsHash: new Uint8Array(32),
      revokedHash: new Uint8Array(32),
      pinnedPostSeq: -1,
      discussionsEnabled: true,
    };
  }

  test('sign and verify round-trip', () => {
    const manifest = makeManifest();
    const sig = signManifest(manifest, channel.channelEd25519Secret);
    expect(sig.length).toBe(64);
    expect(verifyManifest(manifest, sig)).toBe(true);
  });

  test('tampered name fails verification', () => {
    const manifest = makeManifest();
    const sig = signManifest(manifest, channel.channelEd25519Secret);
    const tampered = { ...manifest, name: 'Hacked Channel' };
    expect(verifyManifest(tampered, sig)).toBe(false);
  });

  test('wrong key fails verification', () => {
    const manifest = makeManifest();
    const sig = signManifest(manifest, mallory.sign.secretKey);
    expect(verifyManifest(manifest, sig)).toBe(false);
  });

  test('signed-input is deterministic', () => {
    const manifest = makeManifest();
    const input1 = buildManifestSignedInput(manifest);
    const input2 = buildManifestSignedInput(manifest);
    expect(encodeBase64(input1)).toBe(encodeBase64(input2));
  });

  test('manifest with avatar hash includes it in signed-input', () => {
    const m1 = makeManifest();
    const m2 = { ...makeManifest(), avatarHash: nacl.randomBytes(32) };
    const input1 = buildManifestSignedInput(m1);
    const input2 = buildManifestSignedInput(m2);
    expect(input1.length).not.toBe(input2.length); // avatar adds 32 bytes
  });
});

// ── §6 — Post seal/open + hash chain ──────────────────────────────────────────

describe('post seal/open', () => {
  const channel = generateChannelIdentity();
  const cek = generateCEK();

  const knownKeys: Record<string, Uint8Array> = {
    [subscriber.aegisId]: subscriber.sign.publicKey,
  };
  const resolveKey = (from: string): Uint8Array | null => knownKeys[from] ?? null;

  function makePost(seqNum: number, prevHash: Uint8Array): ChannelPostInner {
    return {
      from: subscriber.aegisId,
      body: `Message #${seqNum}`,
      ts: NOW + seqNum * 1000,
      seqNum,
      prevHash,
      ttlMs: 0,
      attachmentsHash: ZERO_ATTACHMENTS,
    };
  }

  test('round-trip: seal then open recovers authenticated post', () => {
    const post = makePost(0, ZERO_HASH);
    const sealed = sealChannelPost(channel.channelId, post, subscriber.sign.secretKey, cek);

    // Wire carries NO sender identity
    expect(sealed.ciphertextB64).not.toContain(subscriber.aegisId);

    const opened = openChannelPost(channel.channelId, sealed.ciphertextB64, sealed.nonceB64, cek, resolveKey);
    expect(opened).not.toBeNull();
    expect(opened!.post.from).toBe(subscriber.aegisId);
    expect(opened!.post.body).toBe('Message #0');
    expect(opened!.post.seqNum).toBe(0);
  });

  test('wrong CEK fails to open', () => {
    const post = makePost(0, ZERO_HASH);
    const sealed = sealChannelPost(channel.channelId, post, subscriber.sign.secretKey, cek);
    const wrongCek = generateCEK();
    const opened = openChannelPost(channel.channelId, sealed.ciphertextB64, sealed.nonceB64, wrongCek, resolveKey);
    expect(opened).toBeNull();
  });

  test('unknown sender fails authentication', () => {
    const post = makePost(0, ZERO_HASH);
    const sealed = sealChannelPost(channel.channelId, post, subscriber.sign.secretKey, cek);
    const emptyResolve = () => null;
    const opened = openChannelPost(channel.channelId, sealed.ciphertextB64, sealed.nonceB64, cek, emptyResolve);
    expect(opened).toBeNull();
  });

  test('malformed nonce fails closed (null), never throws', () => {
    const post = makePost(0, ZERO_HASH);
    const sealed = sealChannelPost(channel.channelId, post, subscriber.sign.secretKey, cek);
    const badNonce = encodeBase64(new Uint8Array(5)); // wrong length → secretbox throws
    expect(() => openChannelPost(channel.channelId, sealed.ciphertextB64, badNonce, cek, resolveKey)).not.toThrow();
    expect(openChannelPost(channel.channelId, sealed.ciphertextB64, badNonce, cek, resolveKey)).toBeNull();
  });

  test('forged sender fails signature verification', () => {
    const post: ChannelPostInner = {
      from: subscriber.aegisId, // claims to be subscriber
      body: 'forged',
      ts: NOW,
      seqNum: 0,
      prevHash: ZERO_HASH,
      ttlMs: 0,
      attachmentsHash: ZERO_ATTACHMENTS,
    };
    // But signed with mallory's key
    const sealed = sealChannelPost(channel.channelId, post, mallory.sign.secretKey, cek);
    const opened = openChannelPost(channel.channelId, sealed.ciphertextB64, sealed.nonceB64, cek, resolveKey);
    expect(opened).toBeNull();
  });
});

describe('hash chain', () => {
  const channel = generateChannelIdentity();
  const cek = generateCEK();

  function makePost(seqNum: number, prevHash: Uint8Array): ChannelPostInner {
    return {
      from: subscriber.aegisId,
      body: `Chain post #${seqNum}`,
      ts: NOW + seqNum * 1000,
      seqNum,
      prevHash,
      ttlMs: 0,
      attachmentsHash: ZERO_ATTACHMENTS,
    };
  }

  test('hash chain links correctly across 3 posts', () => {
    const post0 = makePost(0, ZERO_HASH);
    const sig0 = signPost(channel.channelId, post0, subscriber.sign.secretKey);
    const hash0 = computePostHash(channel.channelId, post0, sig0);

    const post1 = makePost(1, hash0);
    const sig1 = signPost(channel.channelId, post1, subscriber.sign.secretKey);
    const hash1 = computePostHash(channel.channelId, post1, sig1);

    const post2 = makePost(2, hash1);
    const sig2 = signPost(channel.channelId, post2, subscriber.sign.secretKey);

    // Verify chain links
    expect(verifyChainLink(channel.channelId, post0, sig0, post1.prevHash)).toBe(true);
    expect(verifyChainLink(channel.channelId, post1, sig1, post2.prevHash)).toBe(true);
  });

  test('tampered post breaks chain', () => {
    const post0 = makePost(0, ZERO_HASH);
    const sig0 = signPost(channel.channelId, post0, subscriber.sign.secretKey);
    const hash0 = computePostHash(channel.channelId, post0, sig0);

    const post1 = makePost(1, hash0);
    const sig1 = signPost(channel.channelId, post1, subscriber.sign.secretKey);

    // Tamper post0 body — hash0 should no longer match post1.prevHash
    const tamperedPost0 = { ...post0, body: 'TAMPERED' };
    expect(verifyChainLink(channel.channelId, tamperedPost0, sig0, post1.prevHash)).toBe(false);
  });

  test('reordered posts break chain', () => {
    const post0 = makePost(0, ZERO_HASH);
    const sig0 = signPost(channel.channelId, post0, subscriber.sign.secretKey);
    const hash0 = computePostHash(channel.channelId, post0, sig0);

    const post1 = makePost(1, hash0);
    const sig1 = signPost(channel.channelId, post1, subscriber.sign.secretKey);
    const hash1 = computePostHash(channel.channelId, post1, sig1);

    const post2 = makePost(2, hash1);

    // Try to verify post0 → post2 directly (skipping post1)
    expect(verifyChainLink(channel.channelId, post0, sig0, post2.prevHash)).toBe(false);
  });

  test('hash includes signature — substituting signature breaks chain', () => {
    const post0 = makePost(0, ZERO_HASH);
    const sig0 = signPost(channel.channelId, post0, subscriber.sign.secretKey);
    const hash0 = computePostHash(channel.channelId, post0, sig0);

    const post1 = makePost(1, hash0);

    // Sign post0 with a different key — hash changes
    const altSig0 = signPost(channel.channelId, post0, mallory.sign.secretKey);
    expect(verifyChainLink(channel.channelId, post0, altSig0, post1.prevHash)).toBe(false);
  });

  test('sealed post round-trip preserves hash for chain', () => {
    const post0 = makePost(0, ZERO_HASH);
    const sealed0 = sealChannelPost(channel.channelId, post0, subscriber.sign.secretKey, cek);

    const post1 = makePost(1, sealed0.postHash);
    const sealed1 = sealChannelPost(channel.channelId, post1, subscriber.sign.secretKey, cek);

    const resolveKey = (from: string) =>
      from === subscriber.aegisId ? subscriber.sign.publicKey : null;

    const opened0 = openChannelPost(channel.channelId, sealed0.ciphertextB64, sealed0.nonceB64, cek, resolveKey);
    const opened1 = openChannelPost(channel.channelId, sealed1.ciphertextB64, sealed1.nonceB64, cek, resolveKey);

    expect(opened0).not.toBeNull();
    expect(opened1).not.toBeNull();
    expect(verifyChainLink(
      channel.channelId,
      opened0!.post, opened0!.sig,
      opened1!.post.prevHash
    )).toBe(true);
  });
});

// ── §7 — Editor delegation certs ─────────────────────────────────────────────

describe('editor delegation', () => {
  const channel = generateChannelIdentity();

  function makeCert(): DelegationCertData {
    return {
      channelId: channel.channelId,
      delegateeEd25519Pub: editor.sign.publicKey,
      validFrom: 0,
      validUntil: 0,
      delegationSeq: 1,
    };
  }

  test('sign and verify delegation cert', () => {
    const cert = makeCert();
    const sig = signDelegation(cert, channel.channelEd25519Secret);
    expect(verifyDelegation(cert, sig, channel.channelEd25519Pub)).toBe(true);
  });

  test('wrong publisher key fails', () => {
    const cert = makeCert();
    const sig = signDelegation(cert, mallory.sign.secretKey);
    expect(verifyDelegation(cert, sig, channel.channelEd25519Pub)).toBe(false);
  });

  test('delegated post accepted when cert is valid', () => {
    const cert = makeCert();
    const certSig = signDelegation(cert, channel.channelEd25519Secret);
    const post: ChannelPostInner = {
      from: editor.aegisId,
      body: 'Delegated post',
      ts: NOW,
      seqNum: 0,
      prevHash: ZERO_HASH,
      ttlMs: 0,
      attachmentsHash: ZERO_ATTACHMENTS,
    };
    const postSig = signPost(channel.channelId, post, editor.sign.secretKey);

    expect(verifyDelegatedPost(
      channel.channelId, post, postSig, cert, certSig,
      channel.channelEd25519Pub, new Set()
    )).toBe(true);
  });

  test('revoked delegation rejects post', () => {
    const cert = makeCert();
    const certSig = signDelegation(cert, channel.channelEd25519Secret);
    const post: ChannelPostInner = {
      from: editor.aegisId,
      body: 'After revocation',
      ts: NOW,
      seqNum: 0,
      prevHash: ZERO_HASH,
      ttlMs: 0,
      attachmentsHash: ZERO_ATTACHMENTS,
    };
    const postSig = signPost(channel.channelId, post, editor.sign.secretKey);

    const revokedSeqs = new Set([1]); // cert.delegationSeq = 1
    expect(verifyDelegatedPost(
      channel.channelId, post, postSig, cert, certSig,
      channel.channelEd25519Pub, revokedSeqs
    )).toBe(false);
  });

  test('time-bounded delegation rejects post outside window', () => {
    const cert: DelegationCertData = {
      ...makeCert(),
      validFrom: NOW - 60_000,
      validUntil: NOW + 60_000,
    };
    const certSig = signDelegation(cert, channel.channelEd25519Secret);

    const tooLatePost: ChannelPostInner = {
      from: editor.aegisId,
      body: 'Too late',
      ts: NOW + 120_000, // outside validUntil
      seqNum: 0,
      prevHash: ZERO_HASH,
      ttlMs: 0,
      attachmentsHash: ZERO_ATTACHMENTS,
    };
    const postSig = signPost(channel.channelId, tooLatePost, editor.sign.secretKey);

    expect(verifyDelegatedPost(
      channel.channelId, tooLatePost, postSig, cert, certSig,
      channel.channelEd25519Pub, new Set()
    )).toBe(false);
  });

  test('non-delegatee signing key rejects post', () => {
    const cert = makeCert();
    const certSig = signDelegation(cert, channel.channelEd25519Secret);
    const post: ChannelPostInner = {
      from: mallory.aegisId,
      body: 'Impersonating editor',
      ts: NOW,
      seqNum: 0,
      prevHash: ZERO_HASH,
      ttlMs: 0,
      attachmentsHash: ZERO_ATTACHMENTS,
    };
    // Signed by mallory, not editor
    const postSig = signPost(channel.channelId, post, mallory.sign.secretKey);

    expect(verifyDelegatedPost(
      channel.channelId, post, postSig, cert, certSig,
      channel.channelEd25519Pub, new Set()
    )).toBe(false);
  });
});

// ── §12 — Channel tombstone ──────────────────────────────────────────────────

describe('channel tombstone', () => {
  const channel = generateChannelIdentity();

  test('sign and verify tombstone', () => {
    const sig = signTombstone(channel.channelId, NOW, channel.channelEd25519Secret);
    expect(verifyTombstone(channel.channelId, NOW, sig, channel.channelEd25519Pub)).toBe(true);
  });

  test('wrong channel key fails', () => {
    const sig = signTombstone(channel.channelId, NOW, mallory.sign.secretKey);
    expect(verifyTombstone(channel.channelId, NOW, sig, channel.channelEd25519Pub)).toBe(false);
  });

  test('tampered timestamp fails', () => {
    const sig = signTombstone(channel.channelId, NOW, channel.channelEd25519Secret);
    expect(verifyTombstone(channel.channelId, NOW + 1, sig, channel.channelEd25519Pub)).toBe(false);
  });
});

// ── CEK rotation invalidates old tokens ──────────────────────────────────────

describe('CEK rotation', () => {
  const channel = generateChannelIdentity();
  const capability1 = nacl.randomBytes(32);
  const capability2 = nacl.randomBytes(32);
  const cek1 = generateCEK();
  const cek2 = generateCEK();

  test('old delivery token invalid after capability rotation', () => {
    const token1 = deriveChannelDeliveryToken(capability1, channel.channelId);
    const hash1 = hashChannelDeliveryToken(token1);

    const token2 = deriveChannelDeliveryToken(capability2, channel.channelId);
    const hash2 = hashChannelDeliveryToken(token2);

    // Old token doesn't match new hash
    expect(verifyChannelDeliveryToken(token1, hash2)).toBe(false);
    // New token matches new hash
    expect(verifyChannelDeliveryToken(token2, hash2)).toBe(true);
    // Old token still matches old hash (but relay would have replaced it)
    expect(verifyChannelDeliveryToken(token1, hash1)).toBe(true);
  });

  test('old CEK cannot decrypt posts encrypted with new CEK', () => {
    const resolveKey = (from: string) =>
      from === subscriber.aegisId ? subscriber.sign.publicKey : null;

    const post: ChannelPostInner = {
      from: subscriber.aegisId,
      body: 'Post-rotation message',
      ts: NOW,
      seqNum: 0,
      prevHash: ZERO_HASH,
      ttlMs: 0,
      attachmentsHash: ZERO_ATTACHMENTS,
    };

    const sealed = sealChannelPost(channel.channelId, post, subscriber.sign.secretKey, cek2);
    const opened = openChannelPost(channel.channelId, sealed.ciphertextB64, sealed.nonceB64, cek1, resolveKey);
    expect(opened).toBeNull();
  });
});

// ── Relay opacity ────────────────────────────────────────────────────────────

describe('relay opacity', () => {
  const channel = generateChannelIdentity();
  const cek = generateCEK();

  test('sealed post wire data contains no sender identity or plaintext', () => {
    const post: ChannelPostInner = {
      from: subscriber.aegisId,
      body: 'Secret message with sensitive data',
      ts: NOW,
      seqNum: 0,
      prevHash: ZERO_HASH,
      ttlMs: 0,
      attachmentsHash: ZERO_ATTACHMENTS,
    };
    const sealed = sealChannelPost(channel.channelId, post, subscriber.sign.secretKey, cek);

    const wireJson = JSON.stringify(sealed);
    expect(wireJson).not.toContain(subscriber.aegisId);
    expect(wireJson).not.toContain('Secret message');
    expect(wireJson).not.toContain('sensitive data');
  });
});
