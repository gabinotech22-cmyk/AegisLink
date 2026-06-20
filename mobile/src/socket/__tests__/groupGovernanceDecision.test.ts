/**
 * decideGovernanceUpdate — pure verify-before-trust + anti-rollback contract for
 * group governance propagation (Phase 2b).
 *
 * Real Ed25519 throughout: the owner signs the exact canonical governance bytes
 * the receiver reconstructs, so any verification regression (wrong field order,
 * skipped signature check, accepting a rollback) fails the suite.
 */
import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { signGroupGovernance, type GroupPermissions } from '../../crypto/groupSig';
import { DEFAULT_PERMISSIONS } from '../../crypto/groupRoles';
import { decideGovernanceUpdate, type ClaimedGovernance } from '../groupMetadataDecision';

const ownerKeys = nacl.sign.keyPair();
const ownerPubB64 = encodeBase64(ownerKeys.publicKey);
const OWNER_ID = 'owner-aegis-id';
const GROUP_ID = 'group-gov-1';

function makeClaim(
  overrides: Partial<{ admins: string[]; moderators: string[]; permissions: GroupPermissions; govVersion: number }> = {},
): ClaimedGovernance {
  const admins = overrides.admins ?? ['admin-2'];
  const moderators = overrides.moderators ?? ['mod-1'];
  const permissions = overrides.permissions ?? DEFAULT_PERMISSIONS;
  const govVersion = overrides.govVersion ?? 2;
  const govSig = signGroupGovernance(
    { groupId: GROUP_ID, ownerId: OWNER_ID, admins, moderators, permissions, govVersion },
    ownerKeys.secretKey,
  );
  return { admins, moderators, permissions, govSig, govVersion };
}

const base = {
  groupId: GROUP_ID,
  trustedAdminId: OWNER_ID,
  localGovVersion: 1,
  ownerSigningKeyB64: ownerPubB64,
};

describe('decideGovernanceUpdate', () => {
  it('applies a valid, newer, owner-signed governance', () => {
    const d = decideGovernanceUpdate({ ...base, claimed: makeClaim() });
    expect(d.kind).toBe('apply');
    if (d.kind === 'apply') {
      expect(d.govVersion).toBe(2);
      expect(d.admins).toEqual(['admin-2']);
    }
  });

  it('skips when no governance is claimed', () => {
    expect(decideGovernanceUpdate({ ...base, claimed: null }).kind).toBe('skip');
  });

  it('skips when the owner key cannot be resolved', () => {
    expect(decideGovernanceUpdate({ ...base, claimed: makeClaim(), ownerSigningKeyB64: null }).kind).toBe('skip');
  });

  it('skips when there is no trusted admin', () => {
    expect(decideGovernanceUpdate({ ...base, trustedAdminId: undefined, claimed: makeClaim() }).kind).toBe('skip');
  });

  it('rejects stale/rollback governance (version not newer)', () => {
    // Claim at v1 against local v1 — not strictly newer.
    const d = decideGovernanceUpdate({ ...base, claimed: makeClaim({ govVersion: 1 }) });
    expect(d.kind).toBe('stale');
  });

  it('rejects a tampered permission (signature no longer matches)', () => {
    const claim = makeClaim();
    const tampered: ClaimedGovernance = {
      ...claim,
      permissions: { ...claim.permissions, whoCanCall: 'admins' },
    };
    expect(decideGovernanceUpdate({ ...base, claimed: tampered }).kind).toBe('reject');
  });

  it('rejects governance signed by a non-owner key', () => {
    const impostor = nacl.sign.keyPair();
    const claim = makeClaim();
    const forged: ClaimedGovernance = {
      ...claim,
      govSig: signGroupGovernance(
        { groupId: GROUP_ID, ownerId: OWNER_ID, admins: claim.admins, moderators: claim.moderators, permissions: claim.permissions, govVersion: claim.govVersion },
        impostor.secretKey,
      ),
    };
    expect(decideGovernanceUpdate({ ...base, claimed: forged }).kind).toBe('reject');
  });
});
