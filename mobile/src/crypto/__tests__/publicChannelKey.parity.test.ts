/**
 * publicChannelKey.parity — cross-platform known-answer vectors
 *
 * These vectors were produced by the SERVER module
 * (server/src/crypto/publicChannelKey.ts) with fixed seeds. The mobile port MUST
 * reproduce every deterministic output byte-for-byte, verify server-made
 * signatures, and decrypt a server-sealed post. Any drift here means mobile and
 * relay/desktop disagree on the wire — interop silently breaks (golden rule #5).
 *
 * Regenerate with server/_genvectors.mts if the wire format intentionally changes.
 */

import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import {
  deriveChannelId,
  deriveChannelDeliveryToken,
  hashChannelDeliveryToken,
  verifyChannelDeliveryToken,
  buildManifestSignedInput,
  signManifest,
  verifyManifest,
  signPost,
  verifyPostSignature,
  computePostHash,
  signDelete,
  verifyDelete,
  signBan,
  verifyBan,
  signTombstone,
  verifyTombstone,
  sealChannelPost,
  openChannelPost,
  wrapCEK,
  unwrapCEK,
  verifyChainLink,
  signDelegation,
  verifyDelegatedPost,
  type ChannelManifestData,
  type ChannelPostInner,
  type DelegationCertData,
} from '../publicChannelKey';

// ── Server-generated vectors (fixed seeds) ──────────────────────────────────
const V = {
  channelSeed: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=',
  channelPub: 'ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=',
  senderSeed: 'yMfGxcTDwsHAv769vLu6ubi3trW0s7KxsK+urayrqqk=',
  senderPub: 'J07WsmgF0v6NBgUp7povKHY7aXbZxf0d7jj/NrO3aTk=',
  salt: 'AwoRGB8mLTQ7QklQV15lbA==',
  capability: 'BRIfLDlGU2BteoeUoa67yNXi7/wJFiMwPUpXZHF+i5g=',
  channelId: 'SKKk3vgfTWu1MxRtJYx6DA==',
  deliveryToken: 'wd37KdoGKJF9GBOJ4W6m7w',
  deliveryTokenHash: 'SJVeY+PwwZjcWhq9+AxKjMonSq6n+xACtvDzWhk03wM=',
  manifestInput:
    'SKKk3vgfTWu1MxRtJYx6DAMKERgfJi00O0JJUFdeZWx5tVYuj+ZU+UB4sRLoqYunkB+FOuaVvtfg45ELrQSWZEG4rZ8ASZwjIjudPg5Am3FAGJsqTZqCllHkIZ7R5sQUNuf+uL49YQwpS/0tJ4xW3jcMT7uifdFPJA46Ja51BgcAAAAAAZd0INwAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//////////AQ==',
  manifestSig:
    '9vUpuJUAbcSALXfElX+4YTJj0YVjhPLW5p8Z1dIKhEeGJEXgcHPA/QfyigCx6bCeC2lYVu1m+++TPboN46AaDQ==',
  post: {
    from: 'AEGIS-TESTSENDER',
    body: 'hello sealed channel',
    ts: 1750000123456,
    seqNum: 0,
    prevHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    ttlMs: 0,
    attachmentsHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  },
  postSig:
    '5H09FSBr0gqg4xAdUl+80ERB/zO7UQ6SQzjORwY8kqq+xpMhEWfOg5tAXSZboH7FMnPw0y5bequcQC+OSS9hDQ==',
  postHash: '97k5S8p+dOn3ke2wQ1rDTMEFWibOHMs9UXZ9WyRhA0E=',
  deleteSig:
    't/RwVaToXrOQGwc2oCn3e1R+5hl6cl1UEduy1xp+LPtmR06qrLfSTO3+C9C6MWHwomZ5nOOOiHhICyj4y61KAQ==',
  banRecord: 'BAN:AEGIS-BADACTOR',
  banSig:
    'fAxSyi0QZOw9NgbXEcMQyzR3XyXd+L/M4puudITbXmra9blYpAtzoZdxdBZJRp3VFPUf2zRQLwQEYZAW54SCCg==',
  tombstoneTs: 1750000999999,
  tombstoneSig:
    'hcnofmq9vMuFOtoQ1f/SkuVQMXMClLMeVBVDv286NMp2bVPk8gQ8/rCZlqrjIFka0OsNQmVbrnIi7PWjys8jDw==',
  cek: 'ERQXGh0gIyYpLC8yNTg7PkFER0pNUFNWWVxfYmVoa24=',
  sealed: {
    ciphertextB64:
      '3JFqjKmNPKn41dcgejvBLLcyZnd1r/rTdKZyMO2WCfklGP8rAeuVgxDabK9Ij1ev4hoz8rqx+pX8ou5IbIzzcmsa4e96LrgtdFm6Ow1L3kGii1RGSnJ8E3TIS7Rx0u6T2WCgD4GHPBLzYOv3dJXE6NOAbt4AIJE1gEl3vC8dEkwVh6wm9wXBbjkab+bqGBvCfDchQghGJoJMFl90s7heFI2T4MhOqLg0eOo82FV9E76uCxbsKltcNQxvCkdUw5rlgcjqr85MazrrTwSd+atWF6RJ3nULsU51os9hg4nOsEpcpP0NQqfQgIzQgT+UYQAUVuQR1P9LB3HeBjmu2/WesdIJyftB58gPSiEe3Nf+xMTiHYeMQK0mIkU/g1Q18X8NfU1gUZjCGZzXyHsCYdr/ikL9lgi0Wh2BfsTZ3hRuFGmr6FKsOgfDQp97h/AquxV6Rg==',
    nonceB64: 'PrJMYrZkrnCj20C+B7l7zcufYU0h0GOi',
    postHash: '97k5S8p+dOn3ke2wQ1rDTMEFWibOHMs9UXZ9WyRhA0E=',
  },
};

const channelKp = nacl.sign.keyPair.fromSeed(decodeBase64(V.channelSeed));
const senderKp = nacl.sign.keyPair.fromSeed(decodeBase64(V.senderSeed));
const salt = decodeBase64(V.salt);
const capability = decodeBase64(V.capability);
const cek = decodeBase64(V.cek);

function makePost(): ChannelPostInner {
  return {
    from: V.post.from,
    body: V.post.body,
    ts: V.post.ts,
    seqNum: V.post.seqNum,
    prevHash: decodeBase64(V.post.prevHash),
    ttlMs: V.post.ttlMs,
    attachmentsHash: decodeBase64(V.post.attachmentsHash),
  };
}

function makeManifest(): ChannelManifestData {
  return {
    channelId: V.channelId,
    salt,
    channelEd25519Pub: channelKp.publicKey,
    name: 'Aegis Test Channel',
    description: 'parity vector',
    avatarHash: null,
    channelType: 0,
    createdAtHourMs: 1750000000000,
    manifestSeq: 1,
    contentKeyHash: null,
    delegationsHash: new Uint8Array(32),
    revokedHash: new Uint8Array(32),
    pinnedPostSeq: -1,
    discussionsEnabled: true,
  };
}

describe('publicChannelKey — server parity (known-answer vectors)', () => {
  test('keypair seeds reproduce the server public keys', () => {
    expect(encodeBase64(channelKp.publicKey)).toBe(V.channelPub);
    expect(encodeBase64(senderKp.publicKey)).toBe(V.senderPub);
  });

  test('deriveChannelId matches server byte-for-byte', () => {
    expect(deriveChannelId(channelKp.publicKey, salt)).toBe(V.channelId);
  });

  test('deriveChannelDeliveryToken + hash match server (base64url, no pad)', () => {
    expect(deriveChannelDeliveryToken(capability, V.channelId)).toBe(V.deliveryToken);
    expect(hashChannelDeliveryToken(V.deliveryToken)).toBe(V.deliveryTokenHash);
  });

  test('verifyChannelDeliveryToken accepts the real token, rejects others', () => {
    expect(verifyChannelDeliveryToken(V.deliveryToken, V.deliveryTokenHash)).toBe(true);
    expect(verifyChannelDeliveryToken('wrong-token', V.deliveryTokenHash)).toBe(false);
    expect(verifyChannelDeliveryToken(V.deliveryToken, encodeBase64(new Uint8Array(32)))).toBe(false);
  });

  test('buildManifestSignedInput + signManifest match server bytes', () => {
    expect(encodeBase64(buildManifestSignedInput(makeManifest()))).toBe(V.manifestInput);
    expect(encodeBase64(signManifest(makeManifest(), channelKp.secretKey))).toBe(V.manifestSig);
  });

  test('verifyManifest accepts the server signature', () => {
    expect(verifyManifest(makeManifest(), decodeBase64(V.manifestSig))).toBe(true);
  });

  test('signPost + computePostHash match server bytes', () => {
    expect(encodeBase64(signPost(V.channelId, makePost(), senderKp.secretKey))).toBe(V.postSig);
    expect(encodeBase64(computePostHash(V.channelId, makePost(), decodeBase64(V.postSig)))).toBe(V.postHash);
  });

  test('verifyPostSignature accepts the server signature', () => {
    expect(verifyPostSignature(V.channelId, makePost(), decodeBase64(V.postSig), senderKp.publicKey)).toBe(true);
  });

  test('admin action signatures (delete/ban/tombstone) match + verify', () => {
    expect(encodeBase64(signDelete(V.channelId, 0, channelKp.secretKey))).toBe(V.deleteSig);
    expect(verifyDelete(V.channelId, 0, decodeBase64(V.deleteSig), channelKp.publicKey)).toBe(true);

    expect(encodeBase64(signBan(V.channelId, V.banRecord, channelKp.secretKey))).toBe(V.banSig);
    expect(verifyBan(V.channelId, V.banRecord, decodeBase64(V.banSig), channelKp.publicKey)).toBe(true);

    expect(encodeBase64(signTombstone(V.channelId, V.tombstoneTs, channelKp.secretKey))).toBe(V.tombstoneSig);
    expect(verifyTombstone(V.channelId, V.tombstoneTs, decodeBase64(V.tombstoneSig), channelKp.publicKey)).toBe(true);
  });

  test('opens a SERVER-sealed post (cross-impl decrypt + auth)', () => {
    const opened = openChannelPost(
      V.channelId,
      V.sealed.ciphertextB64,
      V.sealed.nonceB64,
      cek,
      (from) => (from === V.post.from ? senderKp.publicKey : null)
    );
    expect(opened).not.toBeNull();
    expect(opened!.post.body).toBe(V.post.body);
    expect(opened!.post.from).toBe(V.post.from);
    expect(encodeBase64(opened!.postHash)).toBe(V.sealed.postHash);
  });

  test('rejects a server-sealed post when the signer key is unknown', () => {
    const opened = openChannelPost(V.channelId, V.sealed.ciphertextB64, V.sealed.nonceB64, cek, () => null);
    expect(opened).toBeNull();
  });
});

describe('publicChannelKey — internal round-trips', () => {
  test('wrapCEK → unwrapCEK round-trips; wrong capability fails', () => {
    const { ivB64, wrappedB64 } = wrapCEK(cek, capability, V.channelId);
    const unwrapped = unwrapCEK(ivB64, wrappedB64, capability, V.channelId);
    expect(unwrapped).not.toBeNull();
    expect(encodeBase64(unwrapped!)).toBe(V.cek);

    const badCap = new Uint8Array(32).fill(9);
    expect(unwrapCEK(ivB64, wrappedB64, badCap, V.channelId)).toBeNull();
  });

  test('seal → open round-trips locally', () => {
    const post = makePost();
    const sealed = sealChannelPost(V.channelId, post, senderKp.secretKey, cek);
    const opened = openChannelPost(
      V.channelId,
      sealed.ciphertextB64,
      sealed.nonceB64,
      cek,
      () => senderKp.publicKey
    );
    expect(opened).not.toBeNull();
    expect(opened!.post.body).toBe(post.body);
    expect(encodeBase64(opened!.postHash)).toBe(encodeBase64(sealed.postHash));
  });

  test('verifyChainLink links post N to post N-1', () => {
    const post0 = makePost();
    const sig0 = signPost(V.channelId, post0, senderKp.secretKey);
    const hash0 = computePostHash(V.channelId, post0, sig0);
    expect(verifyChainLink(V.channelId, post0, sig0, hash0)).toBe(true);
    expect(verifyChainLink(V.channelId, post0, sig0, new Uint8Array(32))).toBe(false);
  });

  test('verifyDelegatedPost accepts a valid delegated post, honors revocation', () => {
    const delegatee = nacl.sign.keyPair();
    const cert: DelegationCertData = {
      channelId: V.channelId,
      delegateeEd25519Pub: delegatee.publicKey,
      validFrom: 0,
      validUntil: 0,
      delegationSeq: 5,
    };
    const certSig = signDelegation(cert, channelKp.secretKey);
    const post = makePost();
    const postSig = signPost(V.channelId, post, delegatee.secretKey);

    expect(verifyDelegatedPost(V.channelId, post, postSig, cert, certSig, channelKp.publicKey, new Set())).toBe(true);
    expect(verifyDelegatedPost(V.channelId, post, postSig, cert, certSig, channelKp.publicKey, new Set([5]))).toBe(false);
  });
});
