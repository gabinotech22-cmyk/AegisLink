/**
 * Group dissolution signing/verification — pure crypto core (desktop parity
 * with mobile/src/crypto/__tests__ coverage of canonicalGroupDissolveBytes /
 * signGroupDissolve / verifyGroupDissolve).
 *
 * The full envelope receive path (socket/client.ts connect()/envelope
 * handler) touches window.aegis (secureStorage, db/local) and is out of scope
 * for this node-env vitest config (see desktop/vitest.config.ts) — the same
 * reason spkRotation.test.ts and calls.sealedSenderPolicy.test.ts test the
 * PURE decision/crypto functions directly rather than driving the socket.
 * The receive-path's admin/signature gate itself
 * (contact.aegisId === existingGroup.adminId && dissolveAdminId === existingGroup.adminId
 * && verifyGroupDissolve(...)) is a direct, mechanical composition of the
 * primitives tested here — mirroring exactly how mobile's receive-path gate is
 * built from crypto/groupSig.ts's verifyGroupDissolve.
 *
 * This is security-critical: an unauthenticated/forgeable dissolve would let
 * ANY sender wipe a group for every member. These tests lock:
 *   - a signature made by the real admin key verifies.
 *   - a signature made by a DIFFERENT (non-admin) key does NOT verify against
 *     the admin's public key — the same check the receive path performs
 *     before ever honoring `dissolved: true`.
 *   - a signature over the WRONG groupId/adminId/createdAt (tampered payload,
 *     or replayed against a different group) does NOT verify.
 */

import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { signGroupDissolve, verifyGroupDissolve } from '../client';

function keypair() {
  const sign = nacl.sign.keyPair();
  return { secretKey: sign.secretKey, publicKeyB64: encodeBase64(sign.publicKey) };
}

const GROUP_ID = 'g-shared';
const CREATED_AT = 1_700_000_000_000;

describe('desktop group dissolution — signGroupDissolve / verifyGroupDissolve', () => {
  it('a signature made by the real admin key verifies successfully', () => {
    const admin = keypair();
    const sig = signGroupDissolve({ groupId: GROUP_ID, adminId: 'admin-id', createdAt: CREATED_AT }, admin.secretKey);

    expect(
      verifyGroupDissolve({ groupId: GROUP_ID, adminId: 'admin-id', createdAt: CREATED_AT }, sig, admin.publicKeyB64),
    ).toBe(true);
  });

  it('rejects a signature made by a DIFFERENT (non-admin) key — cannot forge dissolution', () => {
    const admin = keypair();
    const impostor = keypair();
    // Impostor signs the exact same claimed bytes, but with their OWN key.
    const forgedSig = signGroupDissolve(
      { groupId: GROUP_ID, adminId: 'admin-id', createdAt: CREATED_AT },
      impostor.secretKey,
    );

    // Verifying against the REAL admin's public key must fail — this is the
    // exact check the receive path runs before ever honoring `dissolved: true`.
    expect(
      verifyGroupDissolve(
        { groupId: GROUP_ID, adminId: 'admin-id', createdAt: CREATED_AT },
        forgedSig,
        admin.publicKeyB64,
      ),
    ).toBe(false);
  });

  it('rejects a signature replayed against a DIFFERENT groupId', () => {
    const admin = keypair();
    const sig = signGroupDissolve({ groupId: GROUP_ID, adminId: 'admin-id', createdAt: CREATED_AT }, admin.secretKey);

    expect(
      verifyGroupDissolve(
        { groupId: 'g-other-group', adminId: 'admin-id', createdAt: CREATED_AT },
        sig,
        admin.publicKeyB64,
      ),
    ).toBe(false);
  });

  it('rejects a signature whose adminId or createdAt was tampered with', () => {
    const admin = keypair();
    const sig = signGroupDissolve({ groupId: GROUP_ID, adminId: 'admin-id', createdAt: CREATED_AT }, admin.secretKey);

    expect(
      verifyGroupDissolve(
        { groupId: GROUP_ID, adminId: 'someone-else', createdAt: CREATED_AT },
        sig,
        admin.publicKeyB64,
      ),
    ).toBe(false);
    expect(
      verifyGroupDissolve(
        { groupId: GROUP_ID, adminId: 'admin-id', createdAt: CREATED_AT + 1 },
        sig,
        admin.publicKeyB64,
      ),
    ).toBe(false);
  });

  it('rejects a malformed/garbage signature or public key without throwing', () => {
    expect(
      verifyGroupDissolve(
        { groupId: GROUP_ID, adminId: 'admin-id', createdAt: CREATED_AT },
        'not-a-real-signature',
        'not-a-real-pubkey',
      ),
    ).toBe(false);
  });
});
