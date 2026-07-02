/**
 * publicChannelApproval.test.ts — Phase 4 approval-capability envelope (§10.2)
 *
 * The owner seals the 32-byte channel capability to the applicant's ephemeral
 * X25519 pubkey; the applicant opens it with the matching ephemeral secret.
 * Regression coverage: round-trip, wrong key, wrong channel binding, tamper.
 */

import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import {
  generateJoinEphemeral,
  sealApprovalCapability,
  openApprovalCapability,
  signApprove,
  signPendingList,
} from '../publicChannelKey';

const { encodeBase64 } = naclUtil;

const CHANNEL_ID = encodeBase64(nacl.randomBytes(32));
const OTHER_CHANNEL_ID = encodeBase64(nacl.randomBytes(32));

describe('approval capability envelope (seal/open)', () => {
  test('round-trips the capability through the sealed envelope', () => {
    const capability = nacl.randomBytes(32);
    const eph = generateJoinEphemeral();

    const envelope = sealApprovalCapability(capability, encodeBase64(eph.publicKey), CHANNEL_ID);
    const opened = openApprovalCapability(envelope, eph.secretKey, CHANNEL_ID);

    expect(opened).not.toBeNull();
    expect(Buffer.from(opened!)).toEqual(Buffer.from(capability));
  });

  test('fails closed with the wrong ephemeral secret', () => {
    const capability = nacl.randomBytes(32);
    const eph = generateJoinEphemeral();
    const otherEph = generateJoinEphemeral();

    const envelope = sealApprovalCapability(capability, encodeBase64(eph.publicKey), CHANNEL_ID);
    expect(openApprovalCapability(envelope, otherEph.secretKey, CHANNEL_ID)).toBeNull();
  });

  test('fails closed when opened under a different channelId (HKDF binding)', () => {
    const capability = nacl.randomBytes(32);
    const eph = generateJoinEphemeral();

    const envelope = sealApprovalCapability(capability, encodeBase64(eph.publicKey), CHANNEL_ID);
    expect(openApprovalCapability(envelope, eph.secretKey, OTHER_CHANNEL_ID)).toBeNull();
  });

  test('fails closed on a tampered ciphertext', () => {
    const capability = nacl.randomBytes(32);
    const eph = generateJoinEphemeral();

    const envelope = sealApprovalCapability(capability, encodeBase64(eph.publicKey), CHANNEL_ID);
    const wrapped = naclUtil.decodeBase64(envelope.wrappedB64);
    wrapped[0] ^= 0xff;
    const tampered = { ...envelope, wrappedB64: encodeBase64(wrapped) };
    expect(openApprovalCapability(tampered, eph.secretKey, CHANNEL_ID)).toBeNull();
  });

  test('rejects a capability that is not 32 bytes', () => {
    const eph = generateJoinEphemeral();
    expect(() => sealApprovalCapability(nacl.randomBytes(16), encodeBase64(eph.publicKey), CHANNEL_ID)).toThrow();
  });
});

describe('owner action signatures (pending list / approve)', () => {
  test('signApprove binds channelId + joinEpk + ts', () => {
    const owner = nacl.sign.keyPair();
    const joinEpk = encodeBase64(nacl.box.keyPair().publicKey);
    const ts = 1_700_000_000_000;

    const sig = signApprove(CHANNEL_ID, joinEpk, ts, owner.secretKey);
    // Same inputs → deterministic Ed25519 signature; any input change → different.
    expect(Buffer.from(signApprove(CHANNEL_ID, joinEpk, ts, owner.secretKey))).toEqual(Buffer.from(sig));
    expect(Buffer.from(signApprove(CHANNEL_ID, joinEpk, ts + 1, owner.secretKey))).not.toEqual(Buffer.from(sig));
    expect(Buffer.from(signApprove(OTHER_CHANNEL_ID, joinEpk, ts, owner.secretKey))).not.toEqual(Buffer.from(sig));
  });

  test('signPendingList binds channelId + ts', () => {
    const owner = nacl.sign.keyPair();
    const ts = 1_700_000_000_000;
    const sig = signPendingList(CHANNEL_ID, ts, owner.secretKey);
    expect(Buffer.from(signPendingList(CHANNEL_ID, ts + 1, owner.secretKey))).not.toEqual(Buffer.from(sig));
  });
});
