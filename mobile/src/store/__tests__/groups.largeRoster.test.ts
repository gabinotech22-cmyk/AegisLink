/**
 * groups store — large-group v2 roster-by-reference contract
 *
 * Step 2 of the large-groups plan. Locks the security-critical invariants of
 * the size-gated signing path so a future refactor can't silently regress them:
 *
 *   - computeRosterHash is deterministic and order-independent (both sides of
 *     the wire MUST land on identical bytes).
 *   - Small groups (≤ LARGE_GROUP_THRESHOLD) sign v1 (roster inlined); large
 *     groups (> threshold) sign v2 (roster BY REFERENCE = hash + version).
 *     We prove the gate with REAL Ed25519 verification, not a stub.
 *   - MAX_GROUP_MEMBERS (1024) is enforced in createGroup and addMember.
 *   - rosterVersion starts at 1 and bumps monotonically on add/remove.
 *
 * Uses real tweetnacl / @noble/hashes — only the side-effecting deps are mocked.
 */

import nacl from 'tweetnacl';
import { decodeBase64 } from 'tweetnacl-util';

// One real admin keypair drives every signature in this suite.
const mockAdminKeys = nacl.sign.keyPair();

// ── db/local (top-level imports in the store) ──────────────────────────────
const mockSaveGroup = jest.fn().mockResolvedValue(undefined);
jest.mock('../../db/local', () => ({
  __esModule: true,
  loadGroups: jest.fn().mockResolvedValue([]),
  saveGroup: (...args: unknown[]) => mockSaveGroup(...args),
  deleteGroup: jest.fn().mockResolvedValue(undefined),
  deleteContactMessages: jest.fn().mockResolvedValue(undefined),
}));

// ── store/identity (lazy required by signAsAdmin) — REAL signing key ───────
jest.mock('../identity', () => ({
  __esModule: true,
  useIdentity: {
    getState: () => ({ identity: { aegisId: 'admin-id', signingSecretKey: mockAdminKeys.secretKey } }),
  },
}));

// ── socket/client (lazy required by removeMember's re-key) ─────────────────
jest.mock('../../socket/client', () => ({
  __esModule: true,
  broadcastGroupMetadata: jest.fn().mockResolvedValue(undefined),
  forgetGroupAvatarSent: jest.fn(),
  rekeyGroupAfterRemoval: jest.fn().mockResolvedValue(undefined),
}));

// ── store/messages (leaveGroup → clearChat) ────────────────────────────────
jest.mock('../messages', () => ({
  __esModule: true,
  useMessages: { getState: () => ({ clearChat: jest.fn() }) },
}));

import { useGroups, computeRosterHash, LARGE_GROUP_THRESHOLD, MAX_GROUP_MEMBERS } from '../groups';
import type { StoredGroup } from '../../db/local';

const pub = mockAdminKeys.publicKey;

/** Re-verify a stored adminSig against the canonical v1 (roster inlined) bytes. */
function verifiesAsV1(g: StoredGroup): boolean {
  const sorted = [...g.members].sort();
  const bytes = new TextEncoder().encode(
    JSON.stringify(['aegis.group.v1', g.id, g.name, sorted, g.createdAt]),
  );
  return nacl.sign.detached.verify(bytes, decodeBase64(g.adminSig as string), pub);
}

/** Re-verify a stored adminSig against the canonical v2 (roster by reference) bytes. */
function verifiesAsV2(g: StoredGroup): boolean {
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      'aegis.group.v2',
      g.id,
      g.name,
      computeRosterHash(g.members),
      g.rosterVersion ?? 1,
      g.createdAt,
    ]),
  );
  return nacl.sign.detached.verify(bytes, decodeBase64(g.adminSig as string), pub);
}

/** N synthetic member ids including the admin (so the admin is always a member). */
function membersOf(n: number): string[] {
  const out = ['admin-id'];
  for (let i = 0; out.length < n; i++) out.push(`m-${i}`);
  return out;
}

describe('groups store — large-group v2 roster-by-reference', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useGroups.setState({ groups: [] });
  });

  it('computeRosterHash is deterministic and order-independent', () => {
    const a = computeRosterHash(['c', 'a', 'b']);
    const b = computeRosterHash(['a', 'b', 'c']);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(computeRosterHash(['a', 'b'])).not.toBe(computeRosterHash(['a', 'b', 'c']));
  });

  it('small group signs v1 (roster inlined), not v2', async () => {
    const g = await useGroups.getState().createGroup('Small', membersOf(3));
    expect(g.members.length).toBeLessThanOrEqual(LARGE_GROUP_THRESHOLD);
    expect(verifiesAsV1(g)).toBe(true);
    expect(verifiesAsV2(g)).toBe(false);
    expect(g.rosterVersion).toBe(1);
  });

  it('large group signs v2 (roster by reference), not v1', async () => {
    const g = await useGroups.getState().createGroup('Large', membersOf(65));
    expect(g.members.length).toBeGreaterThan(LARGE_GROUP_THRESHOLD);
    expect(verifiesAsV2(g)).toBe(true);
    expect(verifiesAsV1(g)).toBe(false);
    expect(g.rosterVersion).toBe(1);
  });

  it('rosterVersion bumps on addMember and removeMember, re-signing v2', async () => {
    const g = await useGroups.getState().createGroup('Grow', membersOf(65));
    expect(g.rosterVersion).toBe(1);

    await useGroups.getState().addMember(g.id, 'newcomer');
    const afterAdd = useGroups.getState().groups.find((x) => x.id === g.id) as StoredGroup;
    expect(afterAdd.rosterVersion).toBe(2);
    expect(afterAdd.members).toContain('newcomer');
    // Signature must still verify against the NEW roster hash + version.
    expect(verifiesAsV2(afterAdd)).toBe(true);

    await useGroups.getState().removeMember(g.id, 'newcomer');
    const afterRemove = useGroups.getState().groups.find((x) => x.id === g.id) as StoredGroup;
    expect(afterRemove.rosterVersion).toBe(3);
    expect(afterRemove.members).not.toContain('newcomer');
    expect(verifiesAsV2(afterRemove)).toBe(true);
  });

  it('createGroup rejects past MAX_GROUP_MEMBERS', async () => {
    await expect(
      useGroups.getState().createGroup('TooBig', membersOf(MAX_GROUP_MEMBERS + 1)),
    ).rejects.toThrow('group_member_limit');
  });

  it('addMember rejects when it would exceed MAX_GROUP_MEMBERS', async () => {
    const g = await useGroups.getState().createGroup('AtCap', membersOf(MAX_GROUP_MEMBERS));
    await expect(useGroups.getState().addMember(g.id, 'one-too-many')).rejects.toThrow(
      'group_member_limit',
    );
  });
});
