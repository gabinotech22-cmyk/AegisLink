import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import {
  type GroupPermissions,
  canonicalGroupBytes,
  signGroupMetadata,
  verifyGroupMetadata,
  signGroupGovernance,
  verifyGroupGovernance,
} from '../groupSig';
import {
  DEFAULT_PERMISSIONS,
  resolveRole,
  can,
  effectivePermissions,
} from '../groupRoles';

const OWNER = 'AAA-BBBB-CCCC';
const ADMIN = 'DDD-EEEE-FFFF';
const MOD = 'GGG-HHHH-IIII';
const MEMBER = 'JJJ-KKKK-LLLL';

function govArgs(overrides: Partial<{
  admins: string[];
  moderators: string[];
  permissions: GroupPermissions;
  govVersion: number;
}> = {}) {
  return {
    groupId: 'group-1',
    ownerId: OWNER,
    admins: overrides.admins ?? [ADMIN],
    moderators: overrides.moderators ?? [MOD],
    permissions: overrides.permissions ?? DEFAULT_PERMISSIONS,
    govVersion: overrides.govVersion ?? 1,
  };
}

describe('governance signature (aegis.group.gov.v1)', () => {
  it('round-trips: a signature by the owner verifies against the owner pubkey', () => {
    const kp = nacl.sign.keyPair();
    const args = govArgs();
    const sig = signGroupGovernance(args, kp.secretKey);
    expect(verifyGroupGovernance(args, sig, encodeBase64(kp.publicKey))).toBe(true);
  });

  it('is order-independent for admins/moderators sets', () => {
    const kp = nacl.sign.keyPair();
    const sig = signGroupGovernance(
      govArgs({ admins: [ADMIN, 'ZZZ-ZZZZ-ZZZZ'], moderators: [MOD, 'YYY-YYYY-YYYY'] }),
      kp.secretKey,
    );
    // Same sets, reversed insertion order → still verifies (canonical sort).
    const verified = verifyGroupGovernance(
      govArgs({ admins: ['ZZZ-ZZZZ-ZZZZ', ADMIN], moderators: ['YYY-YYYY-YYYY', MOD] }),
      sig,
      encodeBase64(kp.publicKey),
    );
    expect(verified).toBe(true);
  });

  it('rejects a tampered permission (member promotes whoCanCall to everyone)', () => {
    const kp = nacl.sign.keyPair();
    const sig = signGroupGovernance(govArgs(), kp.secretKey);
    // whoCanCall is 'admins' by default (see groupRoles.ts DEFAULT_PERMISSIONS),
    // so promoting it to 'everyone' is a genuine change to the signed permission
    // set — verification against the original signature must fail.
    const tampered = govArgs({
      permissions: { ...DEFAULT_PERMISSIONS, whoCanCall: 'everyone' },
    });
    expect(verifyGroupGovernance(tampered, sig, encodeBase64(kp.publicKey))).toBe(false);
  });

  it('rejects a rollback: replaying an older govVersion with stale roles fails', () => {
    const kp = nacl.sign.keyPair();
    // v2 demotes ADMIN to a plain member.
    const current = govArgs({ admins: [], govVersion: 2 });
    const sig = signGroupGovernance(current, kp.secretKey);
    // Attacker replays the signature but claims the old (v1) admin set.
    const replay = govArgs({ admins: [ADMIN], govVersion: 1 });
    expect(verifyGroupGovernance(replay, sig, encodeBase64(kp.publicKey))).toBe(false);
  });

  it('rejects a signature from a non-owner key', () => {
    const owner = nacl.sign.keyPair();
    const impostor = nacl.sign.keyPair();
    const args = govArgs();
    const sig = signGroupGovernance(args, impostor.secretKey);
    expect(verifyGroupGovernance(args, sig, encodeBase64(owner.publicKey))).toBe(false);
  });
});

describe('v1 metadata signature is untouched by the governance layer', () => {
  it('still produces identical canonical bytes and verifies', () => {
    const kp = nacl.sign.keyPair();
    const meta = { groupId: 'g', groupName: 'Squad', members: [OWNER, MEMBER], createdAt: 1000 };
    // Stable snapshot guards against any accidental wire-format drift.
    expect(new TextDecoder().decode(canonicalGroupBytes(meta))).toBe(
      JSON.stringify(['aegis.group.v1', 'g', 'Squad', [MEMBER, OWNER].sort(), 1000]),
    );
    const sig = signGroupMetadata(meta, kp.secretKey);
    expect(verifyGroupMetadata(meta, sig, encodeBase64(kp.publicKey))).toBe(true);
  });
});

describe('resolveRole', () => {
  const group = { adminId: OWNER, admins: [ADMIN], moderators: [MOD] };

  it('resolves each tier correctly', () => {
    expect(resolveRole(group, OWNER)).toBe('owner');
    expect(resolveRole(group, ADMIN)).toBe('admin');
    expect(resolveRole(group, MOD)).toBe('mod');
    expect(resolveRole(group, MEMBER)).toBe('member');
  });

  it('owner wins even if also listed as admin/mod', () => {
    expect(resolveRole({ adminId: OWNER, admins: [OWNER], moderators: [OWNER] }, OWNER)).toBe('owner');
  });

  it('unknown ids and empty governance default to member', () => {
    expect(resolveRole({}, MEMBER)).toBe('member');
  });
});

describe('can — permission gates', () => {
  const group = { adminId: OWNER, admins: [ADMIN], moderators: [MOD] };

  it('applies DEFAULT_PERMISSIONS when none are set', () => {
    expect(effectivePermissions(group)).toEqual(DEFAULT_PERMISSIONS);
  });

  it('default: only sending is everyone; calls, invites and editing info are admins-only', () => {
    // whoCanCall defaults to 'admins' — starting a group voice channel posts a
    // join banner to the WHOLE group, so it is an owner/admin action by default
    // (see groupRoles.ts DEFAULT_PERMISSIONS). A plain member cannot start one.
    expect(can(group, MEMBER, 'call')).toBe(false);
    expect(can(group, MOD, 'call')).toBe(true);
    expect(can(group, ADMIN, 'call')).toBe(true);
    expect(can(group, OWNER, 'call')).toBe(true);
    expect(can(group, MEMBER, 'send')).toBe(true);
    expect(can(group, MEMBER, 'editInfo')).toBe(false);
    expect(can(group, MOD, 'editInfo')).toBe(true);
  });

  it('owner can always do everything regardless of scope', () => {
    const locked: GroupPermissions = {
      whoCanInvite: 'admins',
      whoCanSend: 'admins',
      whoCanCall: 'admins',
      whoCanEditInfo: 'admins',
    };
    const g = { ...group, permissions: locked };
    expect(can(g, OWNER, 'send')).toBe(true);
    expect(can(g, OWNER, 'call')).toBe(true);
  });

  it('respects an everyone scope for a normally-restricted action', () => {
    const g = { ...group, permissions: { ...DEFAULT_PERMISSIONS, whoCanCall: 'everyone' as const } };
    expect(can(g, MEMBER, 'call')).toBe(true);
  });
});
