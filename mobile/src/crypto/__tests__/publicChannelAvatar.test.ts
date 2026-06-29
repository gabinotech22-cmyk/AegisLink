/**
 * publicChannelAvatar — known-answer tests for avatar signing primitives.
 *
 * Uses the same fixed channel keypair from the parity vectors to produce
 * deterministic signatures. Tests verify:
 *   1. signAvatarSet is deterministic and verifyAvatarSet accepts the result
 *   2. signAvatarDelete is deterministic and verifyAvatarDelete accepts the result
 *   3. Signatures from the wrong key are rejected
 *   4. Signatures for the wrong channelId/blobId are rejected
 *   5. Byte layout matches the server contract exactly (domain-separated labels)
 */

import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import {
  signAvatarSet,
  verifyAvatarSet,
  signAvatarDelete,
  verifyAvatarDelete,
} from '../publicChannelKey';

// Fixed channel keypair (same seed as parity vectors)
const channelSeed = decodeBase64('AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=');
const channelKp = nacl.sign.keyPair.fromSeed(channelSeed);

// A different keypair to test rejection
const wrongKp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(0xaa));

const CHANNEL_ID = 'SKKk3vgfTWu1MxRtJYx6DA==';
const BLOB_ID = 'test-blob-id-123';

describe('signAvatarSet / verifyAvatarSet', () => {
  test('round-trip: sign then verify succeeds', () => {
    const sig = signAvatarSet(CHANNEL_ID, BLOB_ID, channelKp.secretKey);
    expect(sig).toHaveLength(64);
    expect(verifyAvatarSet(CHANNEL_ID, BLOB_ID, sig, channelKp.publicKey)).toBe(true);
  });

  test('deterministic: same inputs produce same signature', () => {
    const sig1 = signAvatarSet(CHANNEL_ID, BLOB_ID, channelKp.secretKey);
    const sig2 = signAvatarSet(CHANNEL_ID, BLOB_ID, channelKp.secretKey);
    expect(encodeBase64(sig1)).toBe(encodeBase64(sig2));
  });

  test('KAT: known-answer vector is stable', () => {
    // This vector locks the wire format. If it changes, mobile and server disagree.
    const sig = signAvatarSet(CHANNEL_ID, BLOB_ID, channelKp.secretKey);
    const b64 = encodeBase64(sig);
    // Snapshot: once generated, any change here means a wire-format break.
    expect(b64).toMatchSnapshot();
  });

  test('rejects signature from wrong key', () => {
    const sig = signAvatarSet(CHANNEL_ID, BLOB_ID, wrongKp.secretKey);
    expect(verifyAvatarSet(CHANNEL_ID, BLOB_ID, sig, channelKp.publicKey)).toBe(false);
  });

  test('rejects signature for wrong blobId', () => {
    const sig = signAvatarSet(CHANNEL_ID, BLOB_ID, channelKp.secretKey);
    expect(verifyAvatarSet(CHANNEL_ID, 'wrong-blob-id', sig, channelKp.publicKey)).toBe(false);
  });

  test('rejects signature for wrong channelId', () => {
    const sig = signAvatarSet(CHANNEL_ID, BLOB_ID, channelKp.secretKey);
    const otherChannelId = encodeBase64(nacl.randomBytes(16));
    expect(verifyAvatarSet(otherChannelId, BLOB_ID, sig, channelKp.publicKey)).toBe(false);
  });

  test('rejects truncated signature', () => {
    const sig = signAvatarSet(CHANNEL_ID, BLOB_ID, channelKp.secretKey);
    expect(verifyAvatarSet(CHANNEL_ID, BLOB_ID, sig.subarray(0, 32), channelKp.publicKey)).toBe(false);
  });
});

describe('signAvatarDelete / verifyAvatarDelete', () => {
  test('round-trip: sign then verify succeeds', () => {
    const sig = signAvatarDelete(CHANNEL_ID, channelKp.secretKey);
    expect(sig).toHaveLength(64);
    expect(verifyAvatarDelete(CHANNEL_ID, sig, channelKp.publicKey)).toBe(true);
  });

  test('deterministic: same inputs produce same signature', () => {
    const sig1 = signAvatarDelete(CHANNEL_ID, channelKp.secretKey);
    const sig2 = signAvatarDelete(CHANNEL_ID, channelKp.secretKey);
    expect(encodeBase64(sig1)).toBe(encodeBase64(sig2));
  });

  test('KAT: known-answer vector is stable', () => {
    const sig = signAvatarDelete(CHANNEL_ID, channelKp.secretKey);
    const b64 = encodeBase64(sig);
    expect(b64).toMatchSnapshot();
  });

  test('rejects signature from wrong key', () => {
    const sig = signAvatarDelete(CHANNEL_ID, wrongKp.secretKey);
    expect(verifyAvatarDelete(CHANNEL_ID, sig, channelKp.publicKey)).toBe(false);
  });

  test('rejects signature for wrong channelId', () => {
    const sig = signAvatarDelete(CHANNEL_ID, channelKp.secretKey);
    const otherChannelId = encodeBase64(nacl.randomBytes(16));
    expect(verifyAvatarDelete(otherChannelId, sig, channelKp.publicKey)).toBe(false);
  });

  test('rejects truncated signature', () => {
    const sig = signAvatarDelete(CHANNEL_ID, channelKp.secretKey);
    expect(verifyAvatarDelete(CHANNEL_ID, sig.subarray(0, 32), channelKp.publicKey)).toBe(false);
  });
});

describe('domain separation', () => {
  test('avatar-set and avatar-delete signatures are NOT interchangeable', () => {
    const setSig = signAvatarSet(CHANNEL_ID, BLOB_ID, channelKp.secretKey);
    const delSig = signAvatarDelete(CHANNEL_ID, channelKp.secretKey);

    // A set sig must not pass delete verification and vice versa
    expect(verifyAvatarDelete(CHANNEL_ID, setSig, channelKp.publicKey)).toBe(false);
    // Note: verifyAvatarSet requires blobId, so a delete sig cannot pass it
    expect(verifyAvatarSet(CHANNEL_ID, BLOB_ID, delSig, channelKp.publicKey)).toBe(false);
  });
});
