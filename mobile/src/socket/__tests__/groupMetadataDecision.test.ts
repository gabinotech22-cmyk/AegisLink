/**
 * decideV2GroupMetadata — pure verify-before-trust contract for v2 group
 * metadata (large groups, roster-by-reference).
 *
 * This locks the security-critical decision extracted from the group_msg
 * handler in socket/client.ts. Every signature here is REAL Ed25519: we sign
 * the exact canonical v2 bytes the receiver reconstructs, so a verification
 * regression (wrong byte order, skipped check, trust-before-verify) fails the
 * suite instead of silently shipping. The module under test is fully pure —
 * no mocks of stores, db, or filesystem are required.
 */
import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';

import {
  decideV2GroupMetadata,
  computeRosterHash,
  type V2DecisionInput,
} from '../groupMetadataDecision';

// One real admin keypair signs every authentic message in this suite.
const adminKeys = nacl.sign.keyPair();
const adminPubB64 = encodeBase64(adminKeys.publicKey);

const ADMIN_ID = 'admin-aegis-id';
const SELF_ID = 'self-aegis-id';
const OTHER_ID = 'other-aegis-id';
const GROUP_ID = 'group-123';
const CREATED_AT = 1_700_000_000_000;

/** Sign the canonical v2 bytes with the admin key (mirror of the receiver). */
function signV2(args: {
  groupId: string;
  groupName: string;
  rosterHash: string;
  rosterVersion: number;
  createdAt: number;
  key?: nacl.SignKeyPair;
}): string {
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      'aegis.group.v2',
      args.groupId,
      args.groupName,
      args.rosterHash,
      args.rosterVersion,
      args.createdAt,
    ]),
  );
  return encodeBase64(nacl.sign.detached(bytes, (args.key ?? adminKeys).secretKey));
}

/** Members of a small roster that always includes both admin and self. */
function roster(extra: string[] = []): string[] {
  return [ADMIN_ID, SELF_ID, ...extra];
}

describe('decideV2GroupMetadata — unknown group', () => {
  it('1. content (no carrier) for unknown group → drop', () => {
    const members = roster();
    const rosterHash = computeRosterHash(members);
    const input: V2DecisionInput = {
      existing: null,
      localAegisId: SELF_ID,
      senderId: ADMIN_ID,
      claimed: {
        groupId: GROUP_ID,
        groupName: 'G',
        createdAt: CREATED_AT,
        // no members → content
        adminId: ADMIN_ID,
        adminSig: signV2({ groupId: GROUP_ID, groupName: 'G', rosterHash, rosterVersion: 1, createdAt: CREATED_AT }),
        rosterHash,
        rosterVersion: 1,
      },
      adminSigningKeyB64: adminPubB64,
    };
    expect(decideV2GroupMetadata(input).kind).toBe('drop');
  });

  it('2. carrier with roster-hash mismatch → reject', () => {
    const members = roster(['m1']);
    const wrongHash = computeRosterHash(roster(['someone-else']));
    const input: V2DecisionInput = {
      existing: null,
      localAegisId: SELF_ID,
      senderId: ADMIN_ID,
      claimed: {
        groupId: GROUP_ID,
        groupName: 'G',
        createdAt: CREATED_AT,
        members,
        adminId: ADMIN_ID,
        adminSig: signV2({ groupId: GROUP_ID, groupName: 'G', rosterHash: wrongHash, rosterVersion: 1, createdAt: CREATED_AT }),
        rosterHash: wrongHash, // signed but does NOT match the inlined members
        rosterVersion: 1,
      },
      adminSigningKeyB64: adminPubB64,
    };
    expect(decideV2GroupMetadata(input).kind).toBe('reject');
  });

  it('3. carrier with invalid admin signature → reject', () => {
    const attacker = nacl.sign.keyPair();
    const members = roster(['m1']);
    const rosterHash = computeRosterHash(members);
    const input: V2DecisionInput = {
      existing: null,
      localAegisId: SELF_ID,
      senderId: ADMIN_ID,
      claimed: {
        groupId: GROUP_ID,
        groupName: 'G',
        createdAt: CREATED_AT,
        members,
        adminId: ADMIN_ID,
        // signed by the WRONG key
        adminSig: signV2({ groupId: GROUP_ID, groupName: 'G', rosterHash, rosterVersion: 1, createdAt: CREATED_AT, key: attacker }),
        rosterHash,
        rosterVersion: 1,
      },
      adminSigningKeyB64: adminPubB64,
    };
    expect(decideV2GroupMetadata(input).kind).toBe('reject');
  });

  it('3b. carrier with no resolvable admin key → reject', () => {
    const members = roster(['m1']);
    const rosterHash = computeRosterHash(members);
    const input: V2DecisionInput = {
      existing: null,
      localAegisId: SELF_ID,
      senderId: ADMIN_ID,
      claimed: {
        groupId: GROUP_ID,
        groupName: 'G',
        createdAt: CREATED_AT,
        members,
        adminId: ADMIN_ID,
        adminSig: signV2({ groupId: GROUP_ID, groupName: 'G', rosterHash, rosterVersion: 1, createdAt: CREATED_AT }),
        rosterHash,
        rosterVersion: 1,
      },
      adminSigningKeyB64: null, // caller could not resolve the key
    };
    expect(decideV2GroupMetadata(input).kind).toBe('reject');
  });

  it('4. valid carrier but local id NOT in members → reject', () => {
    const members = [ADMIN_ID, OTHER_ID]; // self is absent
    const rosterHash = computeRosterHash(members);
    const input: V2DecisionInput = {
      existing: null,
      localAegisId: SELF_ID,
      senderId: ADMIN_ID,
      claimed: {
        groupId: GROUP_ID,
        groupName: 'G',
        createdAt: CREATED_AT,
        members,
        adminId: ADMIN_ID,
        adminSig: signV2({ groupId: GROUP_ID, groupName: 'G', rosterHash, rosterVersion: 1, createdAt: CREATED_AT }),
        rosterHash,
        rosterVersion: 1,
      },
      adminSigningKeyB64: adminPubB64,
    };
    expect(decideV2GroupMetadata(input).kind).toBe('reject');
  });

  it('5. valid carrier → createGroup with correct fields', () => {
    const members = roster(['m1', 'm2']);
    const rosterHash = computeRosterHash(members);
    const adminSig = signV2({ groupId: GROUP_ID, groupName: 'My Group', rosterHash, rosterVersion: 3, createdAt: CREATED_AT });
    const input: V2DecisionInput = {
      existing: null,
      localAegisId: SELF_ID,
      senderId: ADMIN_ID,
      claimed: {
        groupId: GROUP_ID,
        groupName: 'My Group',
        createdAt: CREATED_AT,
        members,
        adminId: ADMIN_ID,
        adminSig,
        rosterHash,
        rosterVersion: 3,
      },
      adminSigningKeyB64: adminPubB64,
    };
    const d = decideV2GroupMetadata(input);
    expect(d).toEqual({
      kind: 'createGroup',
      name: 'My Group',
      members,
      createdAt: CREATED_AT,
      adminId: ADMIN_ID,
      adminSig,
      rosterVersion: 3,
    });
  });
});

describe('decideV2GroupMetadata — existing group', () => {
  const existingMembers = roster(['m1', 'm2']);

  function existing(overrides: Partial<{ adminId: string; members: string[]; name: string; rosterVersion: number }> = {}) {
    return {
      adminId: ADMIN_ID,
      members: existingMembers,
      name: 'Existing',
      rosterVersion: 2,
      ...overrides,
    };
  }

  it('6. carrier from admin, hash ok, sig ok → updateRoster', () => {
    const newMembers = roster(['m1', 'm2', 'm3']);
    const rosterHash = computeRosterHash(newMembers);
    const adminSig = signV2({ groupId: GROUP_ID, groupName: 'Renamed', rosterHash, rosterVersion: 3, createdAt: CREATED_AT });
    const input: V2DecisionInput = {
      existing: existing(),
      localAegisId: SELF_ID,
      senderId: ADMIN_ID,
      claimed: {
        groupId: GROUP_ID,
        groupName: 'Renamed',
        createdAt: CREATED_AT,
        members: newMembers,
        adminId: ADMIN_ID,
        adminSig,
        rosterHash,
        rosterVersion: 3,
      },
      adminSigningKeyB64: adminPubB64,
    };
    expect(decideV2GroupMetadata(input)).toEqual({
      kind: 'updateRoster',
      name: 'Renamed',
      members: newMembers,
      adminSig,
      rosterVersion: 3,
    });
  });

  it('7. carrier where sender is NOT the admin → renderOnly', () => {
    const newMembers = roster(['m1', 'm2', 'm3']);
    const rosterHash = computeRosterHash(newMembers);
    // Signature is valid, but the relaying sender is not the admin.
    const adminSig = signV2({ groupId: GROUP_ID, groupName: 'Renamed', rosterHash, rosterVersion: 3, createdAt: CREATED_AT });
    const input: V2DecisionInput = {
      existing: existing(),
      localAegisId: SELF_ID,
      senderId: OTHER_ID, // not admin
      claimed: {
        groupId: GROUP_ID,
        groupName: 'Renamed',
        createdAt: CREATED_AT,
        members: newMembers,
        adminId: ADMIN_ID,
        adminSig,
        rosterHash,
        rosterVersion: 3,
      },
      adminSigningKeyB64: adminPubB64,
    };
    expect(decideV2GroupMetadata(input).kind).toBe('renderOnly');
  });

  it('8. carrier with roster-hash mismatch → renderOnly', () => {
    const newMembers = roster(['m1', 'm2', 'm3']);
    const wrongHash = computeRosterHash(roster(['x']));
    const adminSig = signV2({ groupId: GROUP_ID, groupName: 'Renamed', rosterHash: wrongHash, rosterVersion: 3, createdAt: CREATED_AT });
    const input: V2DecisionInput = {
      existing: existing(),
      localAegisId: SELF_ID,
      senderId: ADMIN_ID,
      claimed: {
        groupId: GROUP_ID,
        groupName: 'Renamed',
        createdAt: CREATED_AT,
        members: newMembers, // does not hash to wrongHash
        adminId: ADMIN_ID,
        adminSig,
        rosterHash: wrongHash,
        rosterVersion: 3,
      },
      adminSigningKeyB64: adminPubB64,
    };
    expect(decideV2GroupMetadata(input).kind).toBe('renderOnly');
  });

  it('9. content with invalid signature → renderOnly', () => {
    const attacker = nacl.sign.keyPair();
    const rosterHash = computeRosterHash(existingMembers);
    const adminSig = signV2({ groupId: GROUP_ID, groupName: 'NewName', rosterHash, rosterVersion: 2, createdAt: CREATED_AT, key: attacker });
    const input: V2DecisionInput = {
      existing: existing(),
      localAegisId: SELF_ID,
      senderId: ADMIN_ID,
      claimed: {
        groupId: GROUP_ID,
        groupName: 'NewName',
        createdAt: CREATED_AT,
        // no members → content
        adminId: ADMIN_ID,
        adminSig,
        rosterHash,
        rosterVersion: 2,
      },
      adminSigningKeyB64: adminPubB64,
    };
    expect(decideV2GroupMetadata(input).kind).toBe('renderOnly');
  });

  it('10. content with rosterVersion newer than local → renderOnly (await carrier)', () => {
    // Sign against a roster the local device does NOT have yet (newer version).
    const futureMembers = roster(['m1', 'm2', 'm3', 'm4']);
    const rosterHash = computeRosterHash(futureMembers);
    const adminSig = signV2({ groupId: GROUP_ID, groupName: 'NewName', rosterHash, rosterVersion: 9, createdAt: CREATED_AT });
    const input: V2DecisionInput = {
      existing: existing({ rosterVersion: 2 }),
      localAegisId: SELF_ID,
      senderId: ADMIN_ID,
      claimed: {
        groupId: GROUP_ID,
        groupName: 'NewName',
        createdAt: CREATED_AT,
        adminId: ADMIN_ID,
        adminSig,
        rosterHash,
        rosterVersion: 9, // > local (2)
      },
      adminSigningKeyB64: adminPubB64,
    };
    expect(decideV2GroupMetadata(input).kind).toBe('renderOnly');
  });

  it('11. content, version<=local, hash matches local, name changed, admin → updateNameOnly', () => {
    const rosterHash = computeRosterHash(existingMembers);
    const adminSig = signV2({ groupId: GROUP_ID, groupName: 'NewName', rosterHash, rosterVersion: 2, createdAt: CREATED_AT });
    const input: V2DecisionInput = {
      existing: existing({ name: 'OldName', rosterVersion: 2 }),
      localAegisId: SELF_ID,
      senderId: ADMIN_ID,
      claimed: {
        groupId: GROUP_ID,
        groupName: 'NewName',
        createdAt: CREATED_AT,
        adminId: ADMIN_ID,
        adminSig,
        rosterHash,
        rosterVersion: 2, // == local
      },
      adminSigningKeyB64: adminPubB64,
    };
    expect(decideV2GroupMetadata(input)).toEqual({
      kind: 'updateNameOnly',
      name: 'NewName',
      adminSig,
    });
  });

  it('12. content, version<=local, hash does NOT match local roster → renderOnly', () => {
    // Signed roster hash references a different roster than the one we store.
    const otherRosterHash = computeRosterHash(roster(['different']));
    const adminSig = signV2({ groupId: GROUP_ID, groupName: 'NewName', rosterHash: otherRosterHash, rosterVersion: 2, createdAt: CREATED_AT });
    const input: V2DecisionInput = {
      existing: existing({ name: 'OldName', rosterVersion: 2 }),
      localAegisId: SELF_ID,
      senderId: ADMIN_ID,
      claimed: {
        groupId: GROUP_ID,
        groupName: 'NewName',
        createdAt: CREATED_AT,
        adminId: ADMIN_ID,
        adminSig,
        rosterHash: otherRosterHash, // signed, valid, but != local roster hash
        rosterVersion: 2,
      },
      adminSigningKeyB64: adminPubB64,
    };
    expect(decideV2GroupMetadata(input).kind).toBe('renderOnly');
  });
});
