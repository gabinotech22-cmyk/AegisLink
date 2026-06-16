/**
 * Pure verify-before-trust decision logic for v2 group metadata.
 *
 * This module extracts the security-critical decision that lives inside the
 * `group_msg` handler in socket/client.ts (the `if (isV2) { ... }` branch). It
 * is deliberately PURE and deterministic: no I/O, no store access, no file
 * writes, no async key resolution. The caller resolves the admin's signing key
 * and passes it in; this function only decides WHAT should happen. The handler
 * then performs the corresponding side effects (saveGroup / hydrate / avatar
 * persistence). Purity is exactly what makes this unit-testable in isolation.
 *
 * The canonical v2 signing bytes and roster hash come from ../crypto/groupSig —
 * the single source of truth shared with socket/client.ts and store/groups.ts —
 * so the verifier here can never drift from the signer.
 */
import {
  computeRosterHash,
  verifyGroupMetadataV2,
} from '../crypto/groupSig';

// Re-export so existing importers (e.g. the decision unit tests) keep resolving
// computeRosterHash from this module.
export { computeRosterHash };

/** Locally-trusted view of a group already persisted on this device. */
export interface V2ExistingGroup {
  adminId?: string;
  members: string[];
  name: string;
  rosterVersion?: number;
}

/** Untrusted metadata claimed by an inbound v2 group_msg. */
export interface V2Claimed {
  groupId: string;
  groupName: string;
  createdAt?: number;
  /** Present ONLY on a carrier (full roster inlined); undefined on content. */
  members?: string[];
  adminId?: string;
  adminSig?: string;
  rosterHash: string;
  rosterVersion: number;
}

export interface V2DecisionInput {
  /** Locally-trusted group, or null if this group is unknown to us. */
  existing: V2ExistingGroup | null;
  /** Our own aegisId — used to confirm we belong to a newly-created group. */
  localAegisId: string;
  /** aegisId of whoever relayed this message. */
  senderId: string;
  /** Untrusted, claimed metadata from the wire. */
  claimed: V2Claimed;
  /**
   * Admin signing public key (Base64) already resolved by the caller, or null
   * if it could not be resolved. Null ⇒ signature is unverifiable.
   */
  adminSigningKeyB64: string | null;
}

/**
 * The decision. The handler maps each kind to the same side effects it
 * performed inline before this refactor. Avatar handling is intentionally
 * NOT modelled here (it is I/O); the handler applies the avatar exactly as
 * before on createGroup / updateRoster.
 */
export type V2Decision =
  /** Hard discard — handler returns false. */
  | { kind: 'reject' }
  /** Consume without touching the group — handler returns true. */
  | { kind: 'drop' }
  /** Materialize a brand-new group from a valid carrier. */
  | {
      kind: 'createGroup';
      name: string;
      members: string[];
      createdAt: number;
      adminId: string;
      adminSig: string;
      rosterVersion: number;
    }
  /** Authoritative roster rotation on an existing group (valid admin carrier). */
  | {
      kind: 'updateRoster';
      name: string;
      members: string[];
      adminSig: string;
      rosterVersion: number;
    }
  /** Content message: apply only a signed admin name change to an existing group. */
  | { kind: 'updateNameOnly'; name: string; adminSig: string }
  /** Do not mutate metadata — fall through and render the body with local roster. */
  | { kind: 'renderOnly' };

/**
 * Decide what to do with the v2 metadata of an inbound group_msg.
 *
 * Verify-before-trust: a carrier's inlined roster is checked against the signed
 * rosterHash, then the admin Ed25519 signature is verified, then admin identity
 * is confirmed — in that order — before any trust is extended.
 */
export function decideV2GroupMetadata(input: V2DecisionInput): V2Decision {
  const { existing, localAegisId, senderId, claimed, adminSigningKeyB64 } = input;
  const { groupId, groupName, members, adminId, adminSig, rosterHash, rosterVersion, createdAt } = claimed;

  // carrier ships the full member list; content references the roster by hash only.
  const isCarrier = Array.isArray(members);

  // v2 admin signature check over the roster reference (hash + version).
  const sigValid = (): boolean => {
    if (!adminId || !adminSig || typeof createdAt !== 'number') return false;
    if (!adminSigningKeyB64) return false;
    return verifyGroupMetadataV2(
      { groupId, groupName, rosterHash, rosterVersion, createdAt },
      adminSig,
      adminSigningKeyB64,
    );
  };

  if (!existing) {
    // ── Unknown group ────────────────────────────────────────────────────────
    // Only a CARRIER can materialize membership; content is dropped silently
    // (the carrier will arrive and create the group).
    if (!isCarrier) {
      return { kind: 'drop' };
    }
    const carrierMembers = members as string[];
    // verify-before-trust: hash ↔ inlined list, THEN signature, THEN membership.
    if (computeRosterHash(carrierMembers) !== rosterHash) {
      return { kind: 'reject' };
    }
    if (!sigValid()) {
      return { kind: 'reject' };
    }
    if (!carrierMembers.includes(localAegisId)) {
      return { kind: 'reject' };
    }
    return {
      kind: 'createGroup',
      name: groupName,
      members: carrierMembers,
      createdAt: createdAt as number,
      adminId: adminId as string,
      adminSig: adminSig as string,
      rosterVersion,
    };
  }

  // ── Existing group ─────────────────────────────────────────────────────────
  const isAdmin =
    !!existing.adminId && senderId === existing.adminId && adminId === existing.adminId;
  const localRosterVersion = existing.rosterVersion ?? 1;

  if (isCarrier) {
    // Carrier on an existing group: authoritative roster update. Verify
    // hash ↔ members, then signature, then admin identity.
    const carrierMembers = members as string[];
    const hashOk = computeRosterHash(carrierMembers) === rosterHash;
    if (hashOk && isAdmin && sigValid()) {
      return {
        kind: 'updateRoster',
        name: groupName,
        members: carrierMembers,
        adminSig: adminSig as string,
        rosterVersion,
      };
    }
    // hash mismatch OR (not admin / sig invalid): no-op, just render.
    return { kind: 'renderOnly' };
  }

  // CONTENT message on an existing group: the roster is NOT inlined, so we must
  // NOT mutate membership from it — the carrier is the only authority for the
  // roster. We may apply a signed name change when the signed roster reference
  // matches our local roster and we are not behind on version.
  if (!sigValid()) {
    return { kind: 'renderOnly' };
  }
  if (rosterVersion > localRosterVersion) {
    // We are behind; the carrier hasn't reached us yet. Render, don't mutate.
    return { kind: 'renderOnly' };
  }
  // rosterVersion <= local: metadata is current (or stale-but-equal). If the
  // signed roster hash matches our local roster, the signed name is authoritative.
  const localHash = computeRosterHash(existing.members);
  if (localHash === rosterHash && groupName !== existing.name && isAdmin) {
    return { kind: 'updateNameOnly', name: groupName, adminSig: adminSig as string };
  }
  return { kind: 'renderOnly' };
}
