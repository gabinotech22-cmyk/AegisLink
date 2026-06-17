/**
 * Canonical group-metadata signing — SINGLE SOURCE OF TRUTH.
 *
 * This is the only place the canonical byte representation of group metadata
 * (and its roster hash) is defined. The store (store/groups.ts), the socket
 * layer (socket/client.ts) and the pure v2 decision logic
 * (socket/groupMetadataDecision.ts) all import from here, so the Ed25519
 * signing/verification bytes can never drift apart between producer and
 * verifier.
 *
 * PURE module: depends ONLY on tweetnacl, tweetnacl-util and @noble/hashes —
 * no stores, no socket, no DB — so importing it can never create a cycle.
 *
 * Any change to the canonical bytes, the version labels ('aegis.group.v1' /
 * 'aegis.group.v2'), the member sort, or the JSON array order is a WIRE-FORMAT
 * BREAK: previously-stored admin signatures will stop verifying. Version the
 * format instead of mutating an existing one.
 */
import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

/**
 * Stable hash of a member set: sha256(utf8(JSON.stringify(sorted members))).
 * Members are sorted so the same set always hashes identically regardless of
 * insertion order. Feeds the canonical v2 signing bytes (roster by reference).
 */
export function computeRosterHash(members: string[]): string {
  const sorted = [...members].sort();
  const bytes = new TextEncoder().encode(JSON.stringify(sorted));
  return bytesToHex(sha256(bytes));
}

/**
 * Canonical v1 group-metadata signing payload — roster INLINED.
 *
 * Members are sorted lexicographically so the same set always serializes
 * identically regardless of insertion order. The key order is fixed via an
 * array literal (hand-rolled JSON) because JSON.stringify on an object literal
 * would still depend on engine insertion order. Any change here is a
 * wire-format break and old admin signatures will fail verification.
 */
export function canonicalGroupBytes(args: {
  groupId: string;
  groupName: string;
  members: string[];
  createdAt: number;
}): Uint8Array {
  const sorted = [...args.members].sort();
  const canonical = JSON.stringify([
    'aegis.group.v1',
    args.groupId,
    args.groupName,
    sorted,
    args.createdAt,
  ]);
  return new TextEncoder().encode(canonical);
}

/**
 * Canonical v2 group-metadata signing payload — roster BY REFERENCE.
 *
 * The full member list is replaced by its hash (computeRosterHash) plus a
 * monotonic rosterVersion so the admin signature is constant-size and can be
 * re-verified against any payload that carries the matching rosterHash +
 * rosterVersion (whether or not the members are inlined). Used by large groups
 * (> LARGE_GROUP_THRESHOLD members).
 */
export function canonicalGroupBytesV2(args: {
  groupId: string;
  groupName: string;
  rosterHash: string;
  rosterVersion: number;
  createdAt: number;
}): Uint8Array {
  const canonical = JSON.stringify([
    'aegis.group.v2',
    args.groupId,
    args.groupName,
    args.rosterHash,
    args.rosterVersion,
    args.createdAt,
  ]);
  return new TextEncoder().encode(canonical);
}

/** Sign v1 canonical bytes with an Ed25519 signing secret key; returns Base64. */
export function signGroupMetadata(
  args: { groupId: string; groupName: string; members: string[]; createdAt: number },
  signingSecretKey: Uint8Array,
): string {
  const sig = nacl.sign.detached(canonicalGroupBytes(args), signingSecretKey);
  return encodeBase64(sig);
}

/** Verify a v1 admin signature (Base64) over the canonical bytes. */
export function verifyGroupMetadata(
  args: { groupId: string; groupName: string; members: string[]; createdAt: number },
  sigB64: string,
  signingPublicKeyB64: string,
): boolean {
  try {
    const sig = decodeBase64(sigB64);
    const pub = decodeBase64(signingPublicKeyB64);
    if (sig.length !== nacl.sign.signatureLength) return false;
    if (pub.length !== nacl.sign.publicKeyLength) return false;
    return nacl.sign.detached.verify(canonicalGroupBytes(args), sig, pub);
  } catch {
    return false;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Governance layer — roles + permissions (aegis.group.gov.v1)
//
// ADDITIVE and INDEPENDENT of the v1/v2 metadata signature above. The roster
// signature (canonicalGroupBytes / canonicalGroupBytesV2) keeps signing exactly
// what it always signed, so previously-stored admin signatures never break. The
// governance signature is a SEPARATE detached Ed25519 signature, by the same
// owner key, over the roles + permissions. A client that predates this layer
// simply ignores govSig and falls back to default permissions (graceful
// degradation); a client that understands it verifies govSig before honoring any
// non-default role or permission.
// ───────────────────────────────────────────────────────────────────────────

/** A configurable permission is granted to one of these audiences. */
export type PermissionScope = 'everyone' | 'admins';

/**
 * Per-group configurable permissions. Each gate answers "who may do X".
 * 'admins' includes the owner and moderators (see can() in groupRoles.ts).
 */
export interface GroupPermissions {
  whoCanInvite: PermissionScope;
  whoCanSend: PermissionScope;
  whoCanCall: PermissionScope;
  whoCanEditInfo: PermissionScope;
}

/**
 * Canonical governance signing payload — roles + permissions BY VALUE.
 *
 * Covers everything a non-owner must not be able to forge: who the owner is,
 * the admin/moderator sets, the four permission gates, and a monotonic
 * govVersion that defeats rollback (a demoted admin replaying an older signed
 * governance state). admins/moderators are sorted so the same set always
 * serializes identically. Permissions are emitted as a fixed-order array (not an
 * object) so JSON key order can never drift. Any change here is a wire-format
 * break — bump to gov.v2 instead of mutating this.
 */
export function canonicalGroupGovBytes(args: {
  groupId: string;
  ownerId: string;
  admins: string[];
  moderators: string[];
  permissions: GroupPermissions;
  govVersion: number;
}): Uint8Array {
  const p = args.permissions;
  const canonical = JSON.stringify([
    'aegis.group.gov.v1',
    args.groupId,
    args.ownerId,
    [...args.admins].sort(),
    [...args.moderators].sort(),
    [p.whoCanInvite, p.whoCanSend, p.whoCanCall, p.whoCanEditInfo],
    args.govVersion,
  ]);
  return new TextEncoder().encode(canonical);
}

/** Sign governance bytes with the owner's Ed25519 signing secret key; Base64. */
export function signGroupGovernance(
  args: {
    groupId: string;
    ownerId: string;
    admins: string[];
    moderators: string[];
    permissions: GroupPermissions;
    govVersion: number;
  },
  signingSecretKey: Uint8Array,
): string {
  const sig = nacl.sign.detached(canonicalGroupGovBytes(args), signingSecretKey);
  return encodeBase64(sig);
}

/** Verify a governance signature (Base64) was made by the owner's signing key. */
export function verifyGroupGovernance(
  args: {
    groupId: string;
    ownerId: string;
    admins: string[];
    moderators: string[];
    permissions: GroupPermissions;
    govVersion: number;
  },
  sigB64: string,
  signingPublicKeyB64: string,
): boolean {
  try {
    const sig = decodeBase64(sigB64);
    const pub = decodeBase64(signingPublicKeyB64);
    if (sig.length !== nacl.sign.signatureLength) return false;
    if (pub.length !== nacl.sign.publicKeyLength) return false;
    return nacl.sign.detached.verify(canonicalGroupGovBytes(args), sig, pub);
  } catch {
    return false;
  }
}

/** Sign v2 canonical bytes with an Ed25519 signing secret key; returns Base64. */
export function signGroupMetadataV2(
  args: { groupId: string; groupName: string; rosterHash: string; rosterVersion: number; createdAt: number },
  signingSecretKey: Uint8Array,
): string {
  const sig = nacl.sign.detached(canonicalGroupBytesV2(args), signingSecretKey);
  return encodeBase64(sig);
}

/** Verify a v2 admin signature (Base64) over the canonical roster-reference bytes. */
export function verifyGroupMetadataV2(
  args: { groupId: string; groupName: string; rosterHash: string; rosterVersion: number; createdAt: number },
  sigB64: string,
  signingPublicKeyB64: string,
): boolean {
  try {
    const sig = decodeBase64(sigB64);
    const pub = decodeBase64(signingPublicKeyB64);
    if (sig.length !== nacl.sign.signatureLength) return false;
    if (pub.length !== nacl.sign.publicKeyLength) return false;
    return nacl.sign.detached.verify(canonicalGroupBytesV2(args), sig, pub);
  } catch {
    return false;
  }
}
