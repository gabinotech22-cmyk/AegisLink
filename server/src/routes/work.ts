import { Router } from 'express';
import type { Server as SocketServer } from 'socket.io';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import tweetnaclUtil from 'tweetnacl-util';
const { decodeBase64 } = tweetnaclUtil;
import { z } from 'zod';
import rateLimit from 'express-rate-limit';

const workLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'rate_limit_exceeded', retryAfterMs: 60_000 });
  },
});
import { identityRepo, workRepo, workspaceRepo, workChannelRepo, workMessageRepo, workAttachmentRepo, workChannelPermissionRepo, getPermissions, type WorkRole } from '../db/client.js';
import path from 'node:path';
import fs from 'node:fs';

// ── Schemas ───────────────────────────────────────────────────────────────────

const CreateOrgSchema = z.object({
  name: z.string().min(2).max(80),
  adminId: z.string().min(10),
  sig: z.string().min(1),
  ts: z.number().int().positive(),
  policyKeyRotationDays: z.number().int().min(7).max(365).default(90),
});

const InviteSchema = z.object({
  aegisId: z.string().min(10),
  sig: z.string().min(1),
  ts: z.number().int().positive(),
  team: z.string().min(1).max(80).default('General'),
  role: z.enum(['owner', 'admin', 'member']).default('member'),
});

const JoinSchema = z.object({
  token: z.string().min(10),
  aegisId: z.string().min(10),
  sig: z.string().min(1),
  ts: z.number().int().positive(),
  deviceName: z.string().min(1).max(80),
  platform: z.enum(['ios', 'android', 'desktop']).default('desktop'),
  deviceId: z.string().min(10),
});

const DeviceStatusSchema = z.object({
  aegisId: z.string().min(10),
  sig: z.string().min(1),
  ts: z.number().int().positive(),
  status: z.enum(['verified', 'revoked']),
});

const AdminQuerySchema = z.object({
  aegisId: z.string().min(10),
  sig: z.string().min(1),
  ts: z.coerce.number().int().positive(),
});

const RemoveMemberSchema = z.object({
  aegisId: z.string().min(10),
  sig: z.string().min(1),
  ts: z.coerce.number().int().positive(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function verifyAdminSig(orgId: string, aegisId: string, action: string, sig: string, ts: number): Promise<boolean> {
  if (Math.abs(Date.now() - ts) > 60_000) return false;

  const identity = await identityRepo.get(aegisId);
  if (!identity || !identity.signing_public_key_b64) return false;

  let pubKeyBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    pubKeyBytes = decodeBase64(identity.signing_public_key_b64);
    sigBytes = decodeBase64(sig);
  } catch {
    return false;
  }

  const timeBucket = Math.floor(ts / 30_000);
  const encode = (bucket: number) =>
    new TextEncoder().encode(`${orgId}:${action}:${bucket}`);

  return (
    nacl.sign.detached.verify(encode(timeBucket), sigBytes, pubKeyBytes) ||
    nacl.sign.detached.verify(encode(timeBucket - 1), sigBytes, pubKeyBytes)
  );
}

async function getMemberRole(orgId: string, aegisId: string): Promise<WorkRole | null> {
  const member = await workRepo.getMember(orgId, aegisId);
  if (!member) return null;
  const role = member.role as WorkRole;
  return role;
}

interface AuditOpts {
  actor_id?: string;
  target_id?: string;
  channel_id?: string;
  metadata?: Record<string, unknown>;
}

function audit(orgId: string, kind: string, message: string, opts?: AuditOpts): void {
  void workRepo.addAudit({
    org_id: orgId,
    kind,
    message,
    actor_id: opts?.actor_id ?? null,
    target_id: opts?.target_id ?? null,
    channel_id: opts?.channel_id ?? null,
    metadata: opts?.metadata !== undefined ? JSON.stringify(opts.metadata) : null,
    created_at: Date.now(),
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

export function createWorkRouter(io: SocketServer): Router {
const router = Router();
router.use(workLimiter);

// POST /work/org — create a new work org (requires Ed25519 proof of adminId ownership)
router.post('/org', async (req, res) => {
  const parsed = CreateOrgSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }
  const { name, adminId, sig, ts, policyKeyRotationDays } = parsed.data;
  // Verify caller owns the adminId signing key — prevents impersonation
  const orgId = randomUUID();
  const sigOk = await verifyAdminSig(orgId, adminId, 'create_org', sig, ts);
  if (!sigOk) { res.status(403).json({ error: 'invalid_identity_proof' }); return; }
  await workRepo.createOrg({ org_id: orgId, name, admin_id: adminId, policy_key_rotation_days: policyKeyRotationDays, created_at: Date.now() });
  await workRepo.addMember({ org_id: orgId, aegis_id: adminId, team: 'Admins', role: 'owner', joined_at: Date.now() });
  audit(orgId, 'org.created', `Organization created`, { actor_id: adminId });
  res.json({ orgId });
});

// GET /work/org/:orgId — get org + stats (requires membership proof)
router.get('/org/:orgId', async (req, res) => {
  const org = await workRepo.getOrg(req.params.orgId);
  if (!org) { res.status(404).json({ error: 'not_found' }); return; }

  const query = AdminQuerySchema.safeParse(req.query);
  if (!query.success) {
    // Unauthenticated: return minimal public info only (no adminId, no device stats)
    const members = await workRepo.listMembers(org.org_id);
    res.json({ orgId: org.org_id, name: org.name, stats: { memberCount: members.length } });
    return;
  }
  const { aegisId, sig, ts } = query.data;
  const [member, sigOk] = await Promise.all([
    workRepo.getMember(org.org_id, aegisId),
    verifyAdminSig(org.org_id, aegisId, 'read_org', sig, ts),
  ]);
  if (!member || !sigOk) {
    res.status(403).json({ error: 'forbidden' }); return;
  }
  const [members, devices] = await Promise.all([
    workRepo.listMembers(org.org_id),
    workRepo.listDevices(org.org_id),
  ]);
  const verified = devices.filter((d) => d.status === 'verified').length;
  const pending = devices.filter((d) => d.status === 'pending').length;
  res.json({
    orgId: org.org_id,
    name: org.name,
    policyKeyRotationDays: org.policy_key_rotation_days,
    createdAt: org.created_at,
    stats: {
      memberCount: members.length,
      deviceCount: devices.length,
      verifiedDevices: verified,
      pendingDevices: pending,
    },
  });
});

// GET /work/org/:orgId/members?aegisId=&sig=&ts=
router.get('/org/:orgId/members', async (req, res) => {
  const parsed = AdminQuerySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }
  const { aegisId, sig, ts } = parsed.data;
  const [callerRole, sigOk] = await Promise.all([
    getMemberRole(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'list_members', sig, ts),
  ]);
  if (!callerRole || !sigOk || !getPermissions(callerRole).canManageMembers) {
    res.status(403).json({ error: 'forbidden' }); return;
  }
  const members = await workRepo.listMembers(req.params.orgId);
  res.json({ members });
});

// GET /work/org/:orgId/devices?aegisId=&sig=&ts=
router.get('/org/:orgId/devices', async (req, res) => {
  const parsed = AdminQuerySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }
  const { aegisId, sig, ts } = parsed.data;
  const [callerRole, sigOk] = await Promise.all([
    getMemberRole(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'list_devices', sig, ts),
  ]);
  if (!callerRole || !sigOk || !getPermissions(callerRole).canManageMembers) {
    res.status(403).json({ error: 'forbidden' }); return;
  }
  const devices = await workRepo.listDevices(req.params.orgId);
  res.json({ devices });
});

const AuditQuerySchema = AdminQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.coerce.number().int().positive().optional(),
  kind: z.string().min(1).optional(),
  actorId: z.string().min(1).optional(),
  channelId: z.string().uuid().optional(),
});

// GET /work/org/:orgId/audit — admin/owner only, paginated with filters
router.get('/org/:orgId/audit', async (req, res) => {
  const parsed = AuditQuerySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }
  const { aegisId, sig, ts, limit, before, kind, actorId, channelId } = parsed.data;
  const [callerRole, sigOk] = await Promise.all([
    getMemberRole(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'list_audit', sig, ts),
  ]);
  if (!callerRole || !sigOk || !getPermissions(callerRole).canManageMembers) {
    res.status(403).json({ error: 'FORBIDDEN' }); return;
  }
  try {
    const events = await workRepo.listAudit(req.params.orgId, { limit, before, kind, actorId, channelId });
    // hasMore: if we got exactly `limit` rows there may be more
    const hasMore = events.length === limit;
    res.json({ events, hasMore });
  } catch {
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// GET /work/org/:orgId/audit/export — owner only, returns CSV (max 10000 rows)
router.get('/org/:orgId/audit/export', async (req, res) => {
  const parsed = AdminQuerySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }
  const { aegisId, sig, ts } = parsed.data;
  const [callerRole, sigOk] = await Promise.all([
    getMemberRole(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'export_audit', sig, ts),
  ]);
  if (!callerRole || !sigOk || callerRole !== 'owner') {
    res.status(403).json({ error: 'FORBIDDEN' }); return;
  }
  try {
    const events = await workRepo.listAudit(req.params.orgId, { limit: 10000 });
    const csvHeader = 'id,kind,actor_id,target_id,channel_id,message,metadata,created_at\n';
    const csvRows = events.map((e) => {
      const escape = (v: string | null): string => {
        if (v === null) return '';
        const s = String(v);
        if (s.includes(',') || s.includes('"') || s.includes('\n')) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      };
      return [e.id, e.kind, e.actor_id, e.target_id, e.channel_id, e.message, e.metadata, String(e.created_at)]
        .map(escape)
        .join(',');
    });
    const csv = csvHeader + csvRows.join('\n');
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="audit-${req.params.orgId}-${Date.now()}.csv"`);
    res.send(csv);
  } catch {
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// POST /work/org/:orgId/invite
router.post('/org/:orgId/invite', async (req, res) => {
  const parsed = InviteSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }
  const { aegisId, sig, ts, team, role } = parsed.data;
  const [callerRole, sigOk] = await Promise.all([
    getMemberRole(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'create_invite', sig, ts),
  ]);
  if (!callerRole || !sigOk || !getPermissions(callerRole).canInvite) {
    res.status(403).json({ error: 'forbidden' }); return;
  }
  // Only owner can create owner-level invites
  if (role === 'owner' && callerRole !== 'owner') {
    res.status(403).json({ error: 'forbidden' }); return;
  }
  const token = randomUUID();
  const now = Date.now();
  await workRepo.createInvite({
    token,
    org_id: req.params.orgId,
    team,
    role,
    created_by: aegisId,
    created_at: now,
    expires_at: now + 7 * 24 * 60 * 60 * 1000,
    used: 0,
  });
  audit(req.params.orgId, 'member.invited', `Invite token created for team "${team}"`, {
    actor_id: aegisId,
    metadata: { role, team },
  });
  res.json({ token });
});

// POST /work/join — member accepts invite (requires Ed25519 proof of aegisId ownership)
router.post('/join', async (req, res) => {
  const parsed = JoinSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }
  const { token, aegisId, sig, ts, deviceName, platform, deviceId } = parsed.data;

  // Validate token first (cheap check) before doing crypto
  const invite = await workRepo.getInvite(token);
  if (!invite || invite.used || invite.expires_at < Date.now()) {
    res.status(400).json({ error: 'invalid_or_expired_token' });
    return;
  }

  // Verify caller owns the aegisId they claim — prevents token interception + identity theft
  if (Math.abs(Date.now() - ts) > 60_000) {
    res.status(403).json({ error: 'invalid_identity_proof' }); return;
  }
  const identity = await identityRepo.get(aegisId);
  if (!identity?.signing_public_key_b64) {
    res.status(403).json({ error: 'identity_not_found' }); return;
  }
  const timeBucket = Math.floor(ts / 30_000);
  const msgBytes = (bucket: number) => new TextEncoder().encode(`${token}:${aegisId}:${bucket}`);
  let sigBytes: Uint8Array;
  try { sigBytes = decodeBase64(sig); } catch { res.status(403).json({ error: 'invalid_identity_proof' }); return; }
  const pubKey = decodeBase64(identity.signing_public_key_b64);
  const sigValid = nacl.sign.detached.verify(msgBytes(timeBucket), sigBytes, pubKey)
                || nacl.sign.detached.verify(msgBytes(timeBucket - 1), sigBytes, pubKey);
  if (!sigValid) { res.status(403).json({ error: 'invalid_identity_proof' }); return; }

  const now = Date.now();
  await workRepo.useInvite(token);
  await workRepo.addMember({ org_id: invite.org_id, aegis_id: aegisId, team: invite.team, role: (invite.role as WorkRole) || 'member', joined_at: now });
  await workRepo.upsertDevice({ device_id: deviceId, org_id: invite.org_id, aegis_id: aegisId, name: deviceName, platform, status: 'pending', last_seen: now, enrolled_at: now });
  audit(invite.org_id, 'member.joined', `New member joined team "${invite.team}"`, {
    target_id: aegisId,
    metadata: { role: invite.role, team: invite.team },
  });
  res.json({ orgId: invite.org_id, team: invite.team, role: invite.role });
});

// PATCH /work/org/:orgId/device/:deviceId
router.patch('/org/:orgId/device/:deviceId', async (req, res) => {
  const parsed = DeviceStatusSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }
  const { aegisId, sig, ts, status } = parsed.data;
  const [callerRole, sigOk] = await Promise.all([
    getMemberRole(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'set_device_status', sig, ts),
  ]);
  if (!callerRole || !sigOk || !getPermissions(callerRole).canManageMembers) {
    res.status(403).json({ error: 'forbidden' }); return;
  }
  await workRepo.setDeviceStatus(req.params.deviceId, req.params.orgId, status);
  const eventKind = status === 'revoked' ? 'device.revoked' : 'device.verified';
  audit(req.params.orgId, eventKind, `Device ${req.params.deviceId} ${status}`, {
    actor_id: aegisId,
    target_id: req.params.deviceId,
  });
  res.json({ ok: true });
});

// DELETE /work/org/:orgId/members/:aegisId
router.delete('/org/:orgId/members/:aegisId', async (req, res) => {
  const parsed = RemoveMemberSchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }
  const { aegisId, sig, ts } = parsed.data;
  const [callerRole, sigOk, targetMember] = await Promise.all([
    getMemberRole(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'remove_member', sig, ts),
    workRepo.getMember(req.params.orgId, req.params.aegisId),
  ]);
  if (!callerRole || !sigOk || !getPermissions(callerRole).canKickMembers) {
    res.status(403).json({ error: 'forbidden' }); return;
  }
  // Admin cannot kick owner; only owner can kick owner (self-remove handled separately)
  if (targetMember?.role === 'owner' && callerRole !== 'owner') {
    res.status(403).json({ error: 'forbidden' }); return;
  }
  await workRepo.removeMember(req.params.orgId, req.params.aegisId);
  audit(req.params.orgId, 'member.removed', `Member removed from org`, {
    actor_id: aegisId,
    target_id: req.params.aegisId,
  });
  res.json({ ok: true });
});

// ── Channel routes ────────────────────────────────────────────────────────────

const CreateChannelSchema = z.object({
  name: z.string().min(1).max(80),
  isAnnouncements: z.boolean().default(false),
  aegisId: z.string().min(10),
  sig: z.string().min(1),
  ts: z.number().int().positive(),
});

const ChannelMessagesQuerySchema = AdminQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
});

const SearchQuerySchema = AdminQuerySchema.extend({
  q: z.string().min(2),
  channelId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// PATCH /work/org/:orgId/members/:aegisId — change a member's role (owner only)
const PatchMemberSchema = z.object({
  aegisId: z.string().min(10),
  sig: z.string().min(1),
  ts: z.number().int().positive(),
  role: z.enum(['owner', 'admin', 'member']),
});

router.patch('/org/:orgId/members/:memberId', async (req, res) => {
  const parsed = PatchMemberSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }
  const { aegisId, sig, ts, role } = parsed.data;
  const [callerRole, sigOk, targetMember] = await Promise.all([
    getMemberRole(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'patch_member_role', sig, ts),
    workRepo.getMember(req.params.orgId, req.params.memberId),
  ]);
  if (!callerRole || !sigOk) { res.status(403).json({ error: 'forbidden' }); return; }
  if (!targetMember) { res.status(404).json({ error: 'not_found' }); return; }
  const perms = getPermissions(callerRole);
  const isPromotion = role === 'admin' || role === 'owner';
  const isDemotion = targetMember.role === 'admin' && role === 'member';
  if (isPromotion && !perms.canPromoteToAdmin) { res.status(403).json({ error: 'forbidden' }); return; }
  if (isDemotion && !perms.canDemoteAdmin) { res.status(403).json({ error: 'forbidden' }); return; }
  // owner role assignment is exclusively owner-to-owner transfer
  if (role === 'owner' && callerRole !== 'owner') { res.status(403).json({ error: 'forbidden' }); return; }
  const updated = await workRepo.updateMemberRole(req.params.orgId, req.params.memberId, role as WorkRole);
  if (!updated) { res.status(404).json({ error: 'not_found' }); return; }
  audit(req.params.orgId, 'member.role_changed', `Member role changed to "${role}"`, {
    actor_id: aegisId,
    target_id: req.params.memberId,
    metadata: { from: targetMember.role, to: role },
  });
  res.json({ ok: true });
});

// POST /work/org/:orgId/channels — create a channel (admin only)
router.post('/org/:orgId/channels', async (req, res) => {
  const parsed = CreateChannelSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }
  const { name, isAnnouncements, aegisId, sig, ts } = parsed.data;
  const [callerRole, sigOk] = await Promise.all([
    getMemberRole(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'create_channel', sig, ts),
  ]);
  if (!callerRole || !sigOk || !getPermissions(callerRole).canCreateChannels) {
    res.status(403).json({ error: 'FORBIDDEN' }); return;
  }
  const channelId = randomUUID();
  const now = Date.now();
  try {
    await workChannelRepo.create({
      channel_id: channelId,
      org_id: req.params.orgId,
      name,
      is_announcements: isAnnouncements ? 1 : 0,
      created_at: now,
    });
    await workChannelPermissionRepo.seedDefaults(channelId, req.params.orgId, isAnnouncements);
    audit(req.params.orgId, 'channel.created', `Channel created`, {
      actor_id: aegisId,
      channel_id: channelId,
      metadata: { name },
    });
    res.status(201).json({ channelId });
  } catch {
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// GET /work/org/:orgId/channels?aegisId=&sig=&ts= — list channels (members only)
router.get('/org/:orgId/channels', async (req, res) => {
  const parsed = AdminQuerySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }
  const { aegisId, sig, ts } = parsed.data;
  const member = await workRepo.getMember(req.params.orgId, aegisId);
  if (!member) { res.status(403).json({ error: 'FORBIDDEN' }); return; }
  const sigOk = await verifyAdminSig(req.params.orgId, aegisId, 'list_channels', sig, ts);
  if (!sigOk) { res.status(403).json({ error: 'FORBIDDEN' }); return; }
  try {
    const channels = await workChannelRepo.listByOrg(req.params.orgId);
    res.json({
      channels: channels.map((c) => ({
        channelId: c.channel_id,
        orgId: c.org_id,
        name: c.name,
        isAnnouncements: c.is_announcements === 1,
        createdAt: c.created_at,
      })),
    });
  } catch {
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// GET /work/org/:orgId/channels/:channelId/messages?aegisId=&sig=&ts=&limit=&before=
router.get('/org/:orgId/channels/:channelId/messages', async (req, res) => {
  const parsed = ChannelMessagesQuerySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }
  const { aegisId, sig, ts, limit, before } = parsed.data;

  const [member, sigOk] = await Promise.all([
    workRepo.getMember(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'read_messages', sig, ts),
  ]);
  if (!member || !sigOk) { res.status(403).json({ error: 'FORBIDDEN' }); return; }

  // Verify channel belongs to this org
  const channel = await workChannelRepo.get(req.params.channelId);
  if (!channel || channel.org_id !== req.params.orgId) {
    res.status(404).json({ error: 'NOT_FOUND' }); return;
  }

  try {
    const rows = await workMessageRepo.getByChannel(req.params.channelId, limit, before);
    res.json({
      messages: rows.map((m) => ({
        id: m.id,
        channelId: m.channel_id,
        orgId: m.org_id,
        senderId: m.sender_id,
        body: m.body,
        type: m.type,
        createdAt: m.created_at,
      })),
    });
  } catch {
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// GET /work/org/:orgId/search?q=&aegisId=&sig=&ts=&channelId=&limit=
router.get('/org/:orgId/search', async (req, res) => {
  const parsed = SearchQuerySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }
  const { aegisId, sig, ts, q, channelId = null, limit } = parsed.data;

  const [member, sigOk] = await Promise.all([
    workRepo.getMember(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'search_messages', sig, ts),
  ]);
  if (!member || !sigOk) { res.status(403).json({ error: 'FORBIDDEN' }); return; }

  try {
    const results = await workMessageRepo.search(req.params.orgId, channelId ?? null, q, limit);
    res.json({ results, query: q, channelId: channelId ?? null });
  } catch {
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// ── File attachments ──────────────────────────────────────────────────────────
// Clients upload file content via POST /blob/upload (PoW-gated) first, then
// send the returned blobId in the channel:msg socket event or REST message post.
// These endpoints list uploaded attachments and serve the blob for download.

const FilesQuerySchema = AdminQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime({ offset: true }).optional(),
});

// GET /work/org/:orgId/channels/:channelId/files
router.get('/org/:orgId/channels/:channelId/files', async (req, res) => {
  const parsed = FilesQuerySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }
  const { aegisId, sig, ts, limit, before } = parsed.data;

  const [member, sigOk] = await Promise.all([
    workRepo.getMember(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'list_files', sig, ts),
  ]);
  if (!member || !sigOk) { res.status(403).json({ error: 'FORBIDDEN' }); return; }

  const channel = await workChannelRepo.get(req.params.channelId);
  if (!channel || channel.org_id !== req.params.orgId) {
    res.status(404).json({ error: 'NOT_FOUND' }); return;
  }

  try {
    const files = await workAttachmentRepo.getByChannel(req.params.channelId, limit, before);
    res.json({ files });
  } catch {
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// GET /work/org/:orgId/channels/:channelId/files/:attachmentId/download
router.get('/org/:orgId/channels/:channelId/files/:attachmentId/download', async (req, res) => {
  const parsed = AdminQuerySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }
  const { aegisId, sig, ts } = parsed.data;

  const [member, sigOk] = await Promise.all([
    workRepo.getMember(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'download_file', sig, ts),
  ]);
  if (!member || !sigOk) { res.status(403).json({ error: 'FORBIDDEN' }); return; }

  const attachment = await workAttachmentRepo.getById(req.params.attachmentId);
  if (
    !attachment ||
    attachment.channel_id !== req.params.channelId ||
    attachment.org_id !== req.params.orgId
  ) {
    res.status(404).json({ error: 'NOT_FOUND' }); return;
  }

  // UUID v4 format guard — prevents path traversal via blob_id
  const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!UUID_V4_RE.test(attachment.blob_id)) {
    res.status(404).json({ error: 'NOT_FOUND' }); return;
  }

  const uploadsDir = path.join(process.cwd(), 'uploads');
  const blobPath = path.join(uploadsDir, attachment.blob_id);

  if (!fs.existsSync(blobPath)) {
    res.status(404).json({ error: 'BLOB_NOT_FOUND' }); return;
  }

  res.set('Content-Type', attachment.mime_type);
  res.set('Content-Disposition', `attachment; filename="${attachment.filename.replace(/"/g, '')}"`);
  res.set('X-Content-Type-Options', 'nosniff');
  res.sendFile(blobPath);
});

// ── Workspace CRUD ────────────────────────────────────────────────────────────
// Workspaces are a lightweight alternative to full work orgs.
// The name_enc field is opaque ciphertext — the server stores it but cannot read it.

const AEGIS_ID_WS_RE = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

const CreateWorkspaceSchema = z.object({
  nameEnc: z.string().min(1).max(512),   // base64 ciphertext of workspace name
  adminAegisId: z.string().regex(AEGIS_ID_WS_RE),
});

const InviteWorkspaceMemberSchema = z.object({
  aegisId: z.string().regex(AEGIS_ID_WS_RE),
  role: z.enum(['admin', 'member']).default('member'),
});

const CallerQuerySchema = z.object({
  aegisId: z.string().regex(AEGIS_ID_WS_RE),
});

// POST /work/workspace — create a new workspace
router.post('/workspace', async (req, res) => {
  const parsed = CreateWorkspaceSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }

  const { nameEnc, adminAegisId } = parsed.data;
  const id = randomUUID();
  const now = Date.now();

  try {
    await workspaceRepo.create({ id, name_enc: nameEnc, admin_id: adminAegisId, created_at: now });
    await workspaceRepo.addMember({ workspace_id: id, aegis_id: adminAegisId, role: 'admin', joined_at: now });
    res.status(201).json({ id });
  } catch {
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// GET /work/workspace/:id?aegisId= — get workspace (members only)
router.get('/workspace/:id', async (req, res) => {
  const query = CallerQuerySchema.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }

  const workspaceId = req.params.id;
  const callerAegisId = query.data.aegisId;

  try {
    const [ws, member] = await Promise.all([
      workspaceRepo.get(workspaceId),
      workspaceRepo.isMember(workspaceId, callerAegisId),
    ]);

    if (!ws) { res.status(404).json({ error: 'NOT_FOUND' }); return; }
    if (!member) { res.status(403).json({ error: 'FORBIDDEN' }); return; }

    res.json({ id: ws.id, nameEnc: ws.name_enc, adminId: ws.admin_id, createdAt: ws.created_at });
  } catch {
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// POST /work/workspace/:id/invite — add a member (admin only, requires Ed25519 sig)
router.post('/workspace/:id/invite', async (req, res) => {
  const body = InviteWorkspaceMemberSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }

  const workspaceId = req.params.id;
  const { aegisId, role } = body.data;

  const adminQuery = z.object({
    adminAegisId: z.string().regex(AEGIS_ID_WS_RE),
    sig: z.string().min(1),
    ts: z.number().int().positive(),
  }).safeParse(req.body);
  if (!adminQuery.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }
  const { adminAegisId, sig, ts } = adminQuery.data;

  try {
    const [ws, adminMember, sigOk] = await Promise.all([
      workspaceRepo.get(workspaceId),
      workspaceRepo.isMember(workspaceId, adminAegisId),
      verifyAdminSig(workspaceId, adminAegisId, 'workspace_admin', sig, ts),
    ]);

    if (!ws) { res.status(404).json({ error: 'NOT_FOUND' }); return; }
    if (!adminMember || ws.admin_id !== adminAegisId || !sigOk) {
      res.status(403).json({ error: 'FORBIDDEN' }); return;
    }

    await workspaceRepo.addMember({ workspace_id: workspaceId, aegis_id: aegisId, role, joined_at: Date.now() });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// DELETE /work/workspace/:id/member/:memberId?adminAegisId=&sig=&ts= — remove member
router.delete('/workspace/:id/member/:memberId', async (req, res) => {
  const query = z.object({
    adminAegisId: z.string().regex(AEGIS_ID_WS_RE),
    sig: z.string().min(1),
    ts: z.coerce.number().int().positive(),
  }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }

  const workspaceId = req.params.id;
  const memberId = req.params.memberId;
  const { adminAegisId, sig, ts } = query.data;

  if (!AEGIS_ID_WS_RE.test(memberId)) {
    res.status(400).json({ error: 'INVALID_PAYLOAD' }); return;
  }

  try {
    const [ws, adminMember, sigOk] = await Promise.all([
      workspaceRepo.get(workspaceId),
      workspaceRepo.isMember(workspaceId, adminAegisId),
      verifyAdminSig(workspaceId, adminAegisId, 'workspace_admin', sig, ts),
    ]);

    if (!ws) { res.status(404).json({ error: 'NOT_FOUND' }); return; }
    if (!adminMember || ws.admin_id !== adminAegisId || !sigOk) {
      res.status(403).json({ error: 'FORBIDDEN' }); return;
    }
    // Admin cannot remove themselves
    if (memberId === adminAegisId) {
      res.status(400).json({ error: 'CANNOT_REMOVE_ADMIN' }); return;
    }

    const removed = await workspaceRepo.removeMember(workspaceId, memberId);
    if (!removed) { res.status(404).json({ error: 'MEMBER_NOT_FOUND' }); return; }
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// GET /work/workspace/:id/members?aegisId= — list members (members only)
router.get('/workspace/:id/members', async (req, res) => {
  const query = CallerQuerySchema.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }

  const workspaceId = req.params.id;
  const callerAegisId = query.data.aegisId;

  try {
    const [ws, member] = await Promise.all([
      workspaceRepo.get(workspaceId),
      workspaceRepo.isMember(workspaceId, callerAegisId),
    ]);

    if (!ws) { res.status(404).json({ error: 'NOT_FOUND' }); return; }
    if (!member) { res.status(403).json({ error: 'FORBIDDEN' }); return; }

    const members = await workspaceRepo.listMembers(workspaceId);
    res.json({
      members: members.map((m) => ({
        aegisId: m.aegis_id,
        role: m.role,
        joinedAt: m.joined_at,
      })),
    });
  } catch {
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// ── Thread (reply-chain) routes ───────────────────────────────────────────────

const PostMessageSchema = AdminQuerySchema.extend({
  body: z.string().min(1).max(65536),
  type: z.enum(['text', 'image', 'file']).default('text'),
  id: z.string().uuid(),
  parent_id: z.string().uuid().optional(),
});

// POST /work/org/:orgId/channels/:channelId/messages — post a message (REST path, supports threads)
router.post('/org/:orgId/channels/:channelId/messages', async (req, res) => {
  const parsed = PostMessageSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }
  const { aegisId, sig, ts, body, type, id, parent_id } = parsed.data;

  const [member, sigOk] = await Promise.all([
    workRepo.getMember(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'post_message', sig, ts),
  ]);
  if (!member || !sigOk) { res.status(403).json({ error: 'FORBIDDEN' }); return; }

  const channel = await workChannelRepo.get(req.params.channelId);
  if (!channel || channel.org_id !== req.params.orgId) {
    res.status(404).json({ error: 'NOT_FOUND' }); return;
  }
  if (channel.is_announcements === 1 && !getPermissions(member.role as WorkRole).canSendAnnouncements) {
    res.status(403).json({ error: 'FORBIDDEN_ANNOUNCEMENTS' }); return;
  }

  // Validate parent exists in the same channel when provided
  if (parent_id !== undefined) {
    const parent = await workMessageRepo.getById(parent_id);
    if (!parent || parent.channel_id !== req.params.channelId) {
      res.status(404).json({ error: 'PARENT_NOT_FOUND' }); return;
    }
  }

  try {
    const createdAt = Date.now();
    await workMessageRepo.insert({
      id,
      channel_id: req.params.channelId,
      org_id: req.params.orgId,
      sender_id: aegisId,
      body,
      type,
      created_at: createdAt,
      parent_id: parent_id ?? null,
    });

    const msgPayload = {
      id,
      channelId: req.params.channelId,
      orgId: req.params.orgId,
      senderId: aegisId,
      body,
      type,
      createdAt,
      parentId: parent_id ?? null,
    };

    io.to(`channel:${req.params.channelId}`).emit('channel:msg', msgPayload);

    if (parent_id !== undefined) {
      // Fetch updated reply_count from DB after insert (increment already applied)
      const updatedParent = await workMessageRepo.getById(parent_id);
      io.to(`channel:${req.params.channelId}`).emit('channel:thread_update', {
        channelId: req.params.channelId,
        parentId: parent_id,
        replyCount: updatedParent?.reply_count ?? 1,
      });
    }

    res.status(201).json(msgPayload);
  } catch {
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// DELETE /work/org/:orgId/channels/:channelId/messages/:messageId
// Admin may delete any message; member may only delete their own.
const DeleteMessageSchema = AdminQuerySchema; // aegisId + sig + ts

router.delete('/org/:orgId/channels/:channelId/messages/:messageId', async (req, res) => {
  const parsed = DeleteMessageSchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }
  const { aegisId, sig, ts } = parsed.data;

  const [member, sigOk] = await Promise.all([
    workRepo.getMember(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'delete_message', sig, ts),
  ]);
  if (!member || !sigOk) { res.status(403).json({ error: 'FORBIDDEN' }); return; }

  const message = await workMessageRepo.getById(req.params.messageId);
  if (!message || message.channel_id !== req.params.channelId) {
    res.status(404).json({ error: 'NOT_FOUND' }); return;
  }

  const isAdmin = getPermissions(member.role as WorkRole).canManageMembers;
  const isOwnMessage = message.sender_id === aegisId;
  if (!isAdmin && !isOwnMessage) {
    res.status(403).json({ error: 'FORBIDDEN' }); return;
  }

  try {
    await workMessageRepo.softDelete(req.params.messageId);
    io.to(`channel:${req.params.channelId}`).emit('channel:msg_deleted', {
      channelId: req.params.channelId,
      messageId: req.params.messageId,
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// GET /work/org/:orgId/channels/:channelId/messages/:messageId/thread
router.get('/org/:orgId/channels/:channelId/messages/:messageId/thread', async (req, res) => {
  const parsed = AdminQuerySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }
  const { aegisId, sig, ts } = parsed.data;

  const [member, sigOk] = await Promise.all([
    workRepo.getMember(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'read_thread', sig, ts),
  ]);
  if (!member || !sigOk) { res.status(403).json({ error: 'FORBIDDEN' }); return; }

  const channel = await workChannelRepo.get(req.params.channelId);
  if (!channel || channel.org_id !== req.params.orgId) {
    res.status(404).json({ error: 'NOT_FOUND' }); return;
  }

  try {
    const parent = await workMessageRepo.getById(req.params.messageId);
    if (!parent || parent.channel_id !== req.params.channelId) {
      res.status(404).json({ error: 'MESSAGE_NOT_FOUND' }); return;
    }

    const replies = await workMessageRepo.getThreadReplies(req.params.messageId, req.params.channelId);
    res.json({ parent, replies });
  } catch {
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// ── Pinned messages ───────────────────────────────────────────────────────────

const PinQuerySchema = AdminQuerySchema; // aegisId + sig + ts

const PinBodySchema = z.object({
  pin: z.boolean(),
  aegisId: z.string().min(10),
  sig: z.string().min(1),
  ts: z.number().int().positive(),
});

// GET /work/org/:orgId/channels/:channelId/pinned
router.get('/org/:orgId/channels/:channelId/pinned', async (req, res) => {
  const parsed = PinQuerySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }
  const { aegisId, sig, ts } = parsed.data;

  const [member, sigOk] = await Promise.all([
    workRepo.getMember(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'read_pinned', sig, ts),
  ]);
  if (!member || !sigOk) { res.status(403).json({ error: 'FORBIDDEN' }); return; }

  const channel = await workChannelRepo.get(req.params.channelId);
  if (!channel || channel.org_id !== req.params.orgId) {
    res.status(404).json({ error: 'NOT_FOUND' }); return;
  }

  try {
    const pins = await workMessageRepo.getPinnedMessages(req.params.channelId);
    res.json({ pins });
  } catch {
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// POST /work/org/:orgId/channels/:channelId/messages/:messageId/pin
router.post('/org/:orgId/channels/:channelId/messages/:messageId/pin', async (req, res) => {
  const parsed = PinBodySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }
  const { pin, aegisId, sig, ts } = parsed.data;

  const [callerRole, sigOk] = await Promise.all([
    getMemberRole(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'pin_message', sig, ts),
  ]);
  if (!callerRole || !sigOk || !getPermissions(callerRole).canPinMessages) {
    res.status(403).json({ error: 'FORBIDDEN' }); return;
  }

  const channel = await workChannelRepo.get(req.params.channelId);
  if (!channel || channel.org_id !== req.params.orgId) {
    res.status(404).json({ error: 'NOT_FOUND' }); return;
  }

  try {
    const found = await workMessageRepo.pinMessage(
      req.params.messageId,
      req.params.channelId,
      req.params.orgId,
      aegisId,
      pin,
    );
    if (!found) { res.status(404).json({ error: 'MESSAGE_NOT_FOUND' }); return; }

    const pinnedAt = pin ? new Date().toISOString() : null;
    io.to(`channel:${req.params.channelId}`).emit('channel:pin', {
      channelId: req.params.channelId,
      messageId: req.params.messageId,
      pin,
      pinnedBy: pin ? aegisId : null,
      pinnedAt,
    });

    const pinKind = pin ? 'message.pinned' : 'message.unpinned';
    audit(req.params.orgId, pinKind, `Message ${pin ? 'pinned' : 'unpinned'}`, {
      actor_id: aegisId,
      channel_id: req.params.channelId,
      metadata: { messageId: req.params.messageId },
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// ── Org settings endpoints ────────────────────────────────────────────────────

// GET /work/orgs/:orgId/settings — member can read
router.get('/orgs/:orgId/settings', async (req, res) => {
  const parsed = AdminQuerySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }
  const { aegisId, sig, ts } = parsed.data;

  const [member, sigOk] = await Promise.all([
    workRepo.getMember(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'read_org_settings', sig, ts),
  ]);
  if (!member || !sigOk) { res.status(403).json({ error: 'FORBIDDEN' }); return; }

  try {
    const [org, members] = await Promise.all([
      workRepo.getOrg(req.params.orgId),
      workRepo.listMembers(req.params.orgId),
    ]);
    if (!org) { res.status(404).json({ error: 'NOT_FOUND' }); return; }
    res.json({
      orgId: org.org_id,
      displayName: org.display_name ?? null,
      invitePolicy: org.invite_policy ?? 'invite_only',
      memberCount: members.length,
    });
  } catch {
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

const PatchOrgSettingsSchema = z.object({
  aegisId: z.string().min(10),
  sig: z.string().min(1),
  ts: z.number().int().positive(),
  displayName: z.string().min(1).max(48).nullable().optional(),
  invitePolicy: z.enum(['invite_only', 'open']).optional(),
});

// PATCH /work/orgs/:orgId/settings — admin/owner only
router.patch('/orgs/:orgId/settings', async (req, res) => {
  const parsed = PatchOrgSettingsSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }
  const { aegisId, sig, ts, displayName, invitePolicy } = parsed.data;

  const [callerRole, sigOk] = await Promise.all([
    getMemberRole(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'patch_org_settings', sig, ts),
  ]);
  if (!callerRole || !sigOk || !getPermissions(callerRole).canManageMembers) {
    res.status(403).json({ error: 'FORBIDDEN' }); return;
  }

  try {
    const org = await workRepo.getOrg(req.params.orgId);
    if (!org) { res.status(404).json({ error: 'NOT_FOUND' }); return; }

    const newDisplayName = displayName !== undefined ? displayName ?? null : (org.display_name ?? null);
    const newInvitePolicy = invitePolicy ?? (org.invite_policy ?? 'invite_only');

    await workRepo.updateOrgSettings(req.params.orgId, newDisplayName, newInvitePolicy);
    audit(req.params.orgId, 'org.settings_updated', `Org settings updated`, {
      actor_id: aegisId,
      metadata: { displayName: newDisplayName, invitePolicy: newInvitePolicy },
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// ── Channel retention endpoint ────────────────────────────────────────────────

const PatchRetentionSchema = z.object({
  aegisId: z.string().min(10),
  sig: z.string().min(1),
  ts: z.number().int().positive(),
  retentionDays: z.union([z.literal(7), z.literal(30), z.literal(90), z.null()]),
});

// PATCH /work/org/:orgId/channels/:channelId/retention — admin/owner only
router.patch('/org/:orgId/channels/:channelId/retention', async (req, res) => {
  const parsed = PatchRetentionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }
  const { aegisId, sig, ts, retentionDays } = parsed.data;

  const [callerRole, sigOk] = await Promise.all([
    getMemberRole(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'set_channel_retention', sig, ts),
  ]);
  if (!callerRole || !sigOk || !getPermissions(callerRole).canManageMembers) {
    res.status(403).json({ error: 'FORBIDDEN' }); return;
  }

  const channel = await workChannelRepo.get(req.params.channelId);
  if (!channel || channel.org_id !== req.params.orgId) {
    res.status(404).json({ error: 'NOT_FOUND' }); return;
  }

  try {
    await workRepo.updateChannelRetention(req.params.channelId, retentionDays);
    audit(req.params.orgId, 'channel.retention_updated', `Channel retention set to ${retentionDays ?? 'forever'}`, {
      actor_id: aegisId,
      channel_id: req.params.channelId,
      metadata: { retentionDays },
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// ── Channel permission endpoints ──────────────────────────────────────────────

const ChannelPermsQuerySchema = AdminQuerySchema;

const PutChannelPermSchema = z.object({
  aegisId: z.string().min(10),
  sig: z.string().min(1),
  ts: z.number().int().positive(),
  role: z.enum(['owner', 'admin', 'member']),
  canSend: z.boolean(),
  canReact: z.boolean(),
  canUpload: z.boolean(),
});

// GET /work/org/:orgId/channels/:channelId/permissions — members only, no admin required
router.get('/org/:orgId/channels/:channelId/permissions', async (req, res) => {
  const parsed = ChannelPermsQuerySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }
  const { aegisId, sig, ts } = parsed.data;

  const [member, sigOk] = await Promise.all([
    workRepo.getMember(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'read_channel_perms', sig, ts),
  ]);
  if (!member || !sigOk) { res.status(403).json({ error: 'FORBIDDEN' }); return; }

  const channel = await workChannelRepo.get(req.params.channelId);
  if (!channel || channel.org_id !== req.params.orgId) {
    res.status(404).json({ error: 'NOT_FOUND' }); return;
  }

  try {
    const perms = await workChannelPermissionRepo.getAll(req.params.channelId);
    res.json({ channelId: req.params.channelId, permissions: perms });
  } catch {
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// PUT /work/org/:orgId/channels/:channelId/permissions — owner only
router.put('/org/:orgId/channels/:channelId/permissions', async (req, res) => {
  const parsed = PutChannelPermSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }
  const { aegisId, sig, ts, role, canSend, canReact, canUpload } = parsed.data;

  const [callerRole, sigOk] = await Promise.all([
    getMemberRole(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'set_channel_perms', sig, ts),
  ]);
  if (!callerRole || !sigOk || !getPermissions(callerRole).canDeleteChannels) {
    // canDeleteChannels is owner-only, matching the spec for this endpoint
    res.status(403).json({ error: 'FORBIDDEN' }); return;
  }

  const channel = await workChannelRepo.get(req.params.channelId);
  if (!channel || channel.org_id !== req.params.orgId) {
    res.status(404).json({ error: 'NOT_FOUND' }); return;
  }

  try {
    await workChannelPermissionRepo.set(req.params.channelId, req.params.orgId, role as WorkRole, { canSend, canReact, canUpload });
    audit(req.params.orgId, 'channel.permissions_changed', `Channel permissions updated for role "${role}"`, {
      actor_id: aegisId,
      channel_id: req.params.channelId,
      metadata: { role, canSend, canReact, canUpload },
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

return router;
}
