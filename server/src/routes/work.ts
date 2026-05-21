import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import tweetnaclUtil from 'tweetnacl-util';
const { decodeBase64 } = tweetnaclUtil;
import { z } from 'zod';
import { identityRepo, workRepo, workspaceRepo } from '../db/client.js';

const router = Router();

// ── Schemas ───────────────────────────────────────────────────────────────────

const CreateOrgSchema = z.object({
  name: z.string().min(2).max(80),
  adminId: z.string().min(10),
  policyKeyRotationDays: z.number().int().min(7).max(365).default(90),
});

const InviteSchema = z.object({
  aegisId: z.string().min(10),
  sig: z.string().min(1),
  ts: z.number().int().positive(),
  team: z.string().min(1).max(80).default('General'),
  role: z.enum(['admin', 'member']).default('member'),
});

const JoinSchema = z.object({
  token: z.string().min(10),
  aegisId: z.string().min(10),
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

async function isOrgAdmin(orgId: string, aegisId: string): Promise<boolean> {
  const org = await workRepo.getOrg(orgId);
  if (!org) return false;
  if (org.admin_id === aegisId) return true;
  const member = await workRepo.getMember(orgId, aegisId);
  return member?.role === 'admin';
}

function audit(orgId: string, kind: 'info' | 'warn' | 'ok', message: string): void {
  void workRepo.addAudit({ id: randomUUID(), org_id: orgId, kind, message, created_at: Date.now() });
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /work/org — create a new work org
router.post('/org', async (req, res) => {
  const parsed = CreateOrgSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }
  const { name, adminId, policyKeyRotationDays } = parsed.data;
  const orgId = randomUUID();
  await workRepo.createOrg({ org_id: orgId, name, admin_id: adminId, policy_key_rotation_days: policyKeyRotationDays, created_at: Date.now() });
  await workRepo.addMember({ org_id: orgId, aegis_id: adminId, team: 'Admins', role: 'admin', joined_at: Date.now() });
  audit(orgId, 'ok', `Organization "${name}" created`);
  res.json({ orgId });
});

// GET /work/org/:orgId — get org + stats (public, no auth required)
router.get('/org/:orgId', async (req, res) => {
  const org = await workRepo.getOrg(req.params.orgId);
  if (!org) { res.status(404).json({ error: 'not_found' }); return; }
  const [members, devices] = await Promise.all([
    workRepo.listMembers(org.org_id),
    workRepo.listDevices(org.org_id),
  ]);
  const verified = devices.filter((d) => d.status === 'verified').length;
  const pending = devices.filter((d) => d.status === 'pending').length;
  res.json({
    orgId: org.org_id,
    name: org.name,
    adminId: org.admin_id,
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
  const [adminOk, sigOk] = await Promise.all([
    isOrgAdmin(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'list_members', sig, ts),
  ]);
  if (!adminOk || !sigOk) { res.status(403).json({ error: 'forbidden' }); return; }
  const members = await workRepo.listMembers(req.params.orgId);
  res.json({ members });
});

// GET /work/org/:orgId/devices?aegisId=&sig=&ts=
router.get('/org/:orgId/devices', async (req, res) => {
  const parsed = AdminQuerySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }
  const { aegisId, sig, ts } = parsed.data;
  const [adminOk, sigOk] = await Promise.all([
    isOrgAdmin(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'list_devices', sig, ts),
  ]);
  if (!adminOk || !sigOk) { res.status(403).json({ error: 'forbidden' }); return; }
  const devices = await workRepo.listDevices(req.params.orgId);
  res.json({ devices });
});

// GET /work/org/:orgId/audit?aegisId=&sig=&ts=&limit=
router.get('/org/:orgId/audit', async (req, res) => {
  const parsed = AdminQuerySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }
  const { aegisId, sig, ts } = parsed.data;
  const [adminOk, sigOk] = await Promise.all([
    isOrgAdmin(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'list_audit', sig, ts),
  ]);
  if (!adminOk || !sigOk) { res.status(403).json({ error: 'forbidden' }); return; }
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const log = await workRepo.listAudit(req.params.orgId, limit);
  res.json({ log });
});

// POST /work/org/:orgId/invite
router.post('/org/:orgId/invite', async (req, res) => {
  const parsed = InviteSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }
  const { aegisId, sig, ts, team, role } = parsed.data;
  const [adminOk, sigOk] = await Promise.all([
    isOrgAdmin(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'create_invite', sig, ts),
  ]);
  if (!adminOk || !sigOk) { res.status(403).json({ error: 'forbidden' }); return; }
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
  audit(req.params.orgId, 'info', `Invite token created for team "${team}"`);
  res.json({ token });
});

// POST /work/join — member accepts invite (no admin sig required — uses invite token)
router.post('/join', async (req, res) => {
  const parsed = JoinSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }
  const { token, aegisId, deviceName, platform, deviceId } = parsed.data;
  const invite = await workRepo.getInvite(token);
  if (!invite || invite.used || invite.expires_at < Date.now()) {
    res.status(400).json({ error: 'invalid_or_expired_token' });
    return;
  }
  const now = Date.now();
  await workRepo.useInvite(token);
  await workRepo.addMember({ org_id: invite.org_id, aegis_id: aegisId, team: invite.team, role: invite.role, joined_at: now });
  await workRepo.upsertDevice({ device_id: deviceId, org_id: invite.org_id, aegis_id: aegisId, name: deviceName, platform, status: 'pending', last_seen: now, enrolled_at: now });
  audit(invite.org_id, 'info', `New member joined team "${invite.team}" · device pending verification`);
  res.json({ orgId: invite.org_id, team: invite.team, role: invite.role });
});

// PATCH /work/org/:orgId/device/:deviceId
router.patch('/org/:orgId/device/:deviceId', async (req, res) => {
  const parsed = DeviceStatusSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }
  const { aegisId, sig, ts, status } = parsed.data;
  const [adminOk, sigOk] = await Promise.all([
    isOrgAdmin(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'set_device_status', sig, ts),
  ]);
  if (!adminOk || !sigOk) { res.status(403).json({ error: 'forbidden' }); return; }
  await workRepo.setDeviceStatus(req.params.deviceId, req.params.orgId, status);
  const actionLabel = status === 'revoked' ? 'revoked' : 'verified';
  audit(req.params.orgId, status === 'revoked' ? 'warn' : 'ok', `Device ${req.params.deviceId} ${actionLabel}`);
  res.json({ ok: true });
});

// DELETE /work/org/:orgId/members/:aegisId
router.delete('/org/:orgId/members/:aegisId', async (req, res) => {
  const parsed = RemoveMemberSchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }
  const { aegisId, sig, ts } = parsed.data;
  const [adminOk, sigOk] = await Promise.all([
    isOrgAdmin(req.params.orgId, aegisId),
    verifyAdminSig(req.params.orgId, aegisId, 'remove_member', sig, ts),
  ]);
  if (!adminOk || !sigOk) { res.status(403).json({ error: 'forbidden' }); return; }
  await workRepo.removeMember(req.params.orgId, req.params.aegisId);
  audit(req.params.orgId, 'warn', `Member ${req.params.aegisId.slice(0, 8)}… removed from org`);
  res.json({ ok: true });
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

// POST /work/workspace/:id/invite — add a member (admin only)
router.post('/workspace/:id/invite', async (req, res) => {
  const body = InviteWorkspaceMemberSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }

  const workspaceId = req.params.id;
  const { aegisId, role } = body.data;

  // Caller identity comes from a signed header in production; for now we require
  // adminAegisId in body to verify admin status without storing session state.
  const adminQuery = z.object({ adminAegisId: z.string().regex(AEGIS_ID_WS_RE) }).safeParse(req.body);
  if (!adminQuery.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }
  const adminAegisId = adminQuery.data.adminAegisId;

  try {
    const [ws, adminMember] = await Promise.all([
      workspaceRepo.get(workspaceId),
      workspaceRepo.isMember(workspaceId, adminAegisId),
    ]);

    if (!ws) { res.status(404).json({ error: 'NOT_FOUND' }); return; }
    if (!adminMember || ws.admin_id !== adminAegisId) {
      res.status(403).json({ error: 'FORBIDDEN' }); return;
    }

    await workspaceRepo.addMember({ workspace_id: workspaceId, aegis_id: aegisId, role, joined_at: Date.now() });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// DELETE /work/workspace/:id/member/:memberId?adminAegisId= — remove member
router.delete('/workspace/:id/member/:memberId', async (req, res) => {
  const query = z.object({ adminAegisId: z.string().regex(AEGIS_ID_WS_RE) }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: 'INVALID_PAYLOAD' }); return; }

  const workspaceId = req.params.id;
  const memberId = req.params.memberId;
  const adminAegisId = query.data.adminAegisId;

  if (!AEGIS_ID_WS_RE.test(memberId)) {
    res.status(400).json({ error: 'INVALID_PAYLOAD' }); return;
  }

  try {
    const [ws, adminMember] = await Promise.all([
      workspaceRepo.get(workspaceId),
      workspaceRepo.isMember(workspaceId, adminAegisId),
    ]);

    if (!ws) { res.status(404).json({ error: 'NOT_FOUND' }); return; }
    if (!adminMember || ws.admin_id !== adminAegisId) {
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

export default router;
