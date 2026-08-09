/**
 * workspace.auth.test.ts — the Work workspace GET reads must require a valid
 * Ed25519 signature from the caller's registered identity (Ola 7, roadmap
 * line 123: "Work GET sin firma work.ts:692,791").
 *
 * Before this, GET /work/workspace/:id and /members authenticated by membership
 * alone — i.e. by *knowing* a member's aegisId, not by *owning* it (golden rule
 * #3: conocer un ID ≠ ser el dueño del ID). Now the caller must sign
 * `${workspaceId}:${action}:${floor(ts/30_000)}` with their registered signing
 * key, exactly like the mutation endpoints (verifyAdminSig).
 */

process.env['AEGIS_DB_PATH'] = ':memory:';

import express from 'express';
import request from 'supertest';
import type { Server as SocketServer } from 'socket.io';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

const { encodeBase64, decodeUTF8 } = naclUtil;

let app: express.Express;

const signKeys = nacl.sign.keyPair();
const boxKeys = nacl.box.keyPair();
const MEMBER_ID = 'ABC-DEFG-HJKM'; // matches AEGIS_ID_WS_RE (Crockford 3-4-4)
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

function sign(workspaceId: string, action: string, ts: number, secret: Uint8Array): string {
  const bucket = Math.floor(ts / 30_000);
  return encodeBase64(nacl.sign.detached(decodeUTF8(`${workspaceId}:${action}:${bucket}`), secret));
}

beforeAll(async () => {
  const db = await import('../db/client.js');
  await db.initDb();
  await db.identityRepo.insert({
    aegis_id: MEMBER_ID,
    public_key_b64: encodeBase64(boxKeys.publicKey),
    signing_public_key_b64: encodeBase64(signKeys.publicKey),
    created_at: Date.now(),
  });
  const now = Date.now();
  await db.workspaceRepo.create({ id: WORKSPACE_ID, name_enc: 'opaque-ciphertext', admin_id: MEMBER_ID, created_at: now });
  await db.workspaceRepo.addMember({ workspace_id: WORKSPACE_ID, aegis_id: MEMBER_ID, role: 'admin', joined_at: now });

  const { createWorkRouter } = await import('../routes/work.js');
  app = express();
  app.use(express.json());
  // io is unused by the read endpoints under test.
  app.use('/work', createWorkRouter({} as unknown as SocketServer));
});

describe('GET /work/workspace/:id — signature auth', () => {
  it('returns the workspace for a valid signature from the member', async () => {
    const ts = Date.now();
    const sig = sign(WORKSPACE_ID, 'read_workspace', ts, signKeys.secretKey);
    const res = await request(app).get(`/work/workspace/${WORKSPACE_ID}`).query({ aegisId: MEMBER_ID, sig, ts });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(WORKSPACE_ID);
    expect(res.body.nameEnc).toBe('opaque-ciphertext');
  });

  it('rejects a request with no signature (400)', async () => {
    const res = await request(app).get(`/work/workspace/${WORKSPACE_ID}`).query({ aegisId: MEMBER_ID, ts: Date.now() });
    expect(res.status).toBe(400);
  });

  it('rejects a forged signature (403)', async () => {
    const ts = Date.now();
    const wrong = nacl.sign.keyPair();
    const sig = sign(WORKSPACE_ID, 'read_workspace', ts, wrong.secretKey);
    const res = await request(app).get(`/work/workspace/${WORKSPACE_ID}`).query({ aegisId: MEMBER_ID, sig, ts });
    expect(res.status).toBe(403);
  });
});

describe('GET /work/workspace/:id/members — signature auth', () => {
  it('lists members for a valid signature from the member', async () => {
    const ts = Date.now();
    const sig = sign(WORKSPACE_ID, 'list_workspace_members', ts, signKeys.secretKey);
    const res = await request(app).get(`/work/workspace/${WORKSPACE_ID}/members`).query({ aegisId: MEMBER_ID, sig, ts });
    expect(res.status).toBe(200);
    expect(res.body.members).toHaveLength(1);
    expect(res.body.members[0].aegisId).toBe(MEMBER_ID);
  });

  it('rejects a forged signature (403)', async () => {
    const ts = Date.now();
    const wrong = nacl.sign.keyPair();
    const sig = sign(WORKSPACE_ID, 'list_workspace_members', ts, wrong.secretKey);
    const res = await request(app).get(`/work/workspace/${WORKSPACE_ID}/members`).query({ aegisId: MEMBER_ID, sig, ts });
    expect(res.status).toBe(403);
  });
});

// ─── POST /work/workspace — creation must prove possession too (SEC-1) ────────
//
// Audit 2026-08 found this was the ONE route of the 32 in work.ts that took an
// identity from the request body and trusted it: `adminAegisId` went straight
// into workspaceRepo.create with no signature. Anyone could mint a workspace
// administered by someone else's identity — the exact thing the comment above
// WorkspaceReadQuerySchema says must not happen (golden rule #3: knowing an
// aegisId ≠ owning it, and #7: trust is derived server-side, never supplied).
//
// The signature is over the aegisId itself rather than a workspace id, because
// the workspace does not exist yet at creation time.

describe('POST /work/workspace — signature auth (SEC-1 regression)', () => {
  it('creates the workspace when the admin signs with their own key', async () => {
    const ts = Date.now();
    const sig = sign(MEMBER_ID, 'create_workspace', ts, signKeys.secretKey);
    const res = await request(app)
      .post('/work/workspace')
      .send({ nameEnc: 'opaque', adminAegisId: MEMBER_ID, sig, ts });
    expect(res.status).toBe(201);
    expect(typeof res.body.id).toBe('string');
  });

  it('REJECTS a workspace claiming an admin the caller does not own', async () => {
    // The attack: I know your aegisId, so I create a workspace with you as admin.
    const attacker = nacl.sign.keyPair();
    const ts = Date.now();
    const sig = sign(MEMBER_ID, 'create_workspace', ts, attacker.secretKey);
    const res = await request(app)
      .post('/work/workspace')
      .send({ nameEnc: 'opaque', adminAegisId: MEMBER_ID, sig, ts });
    expect(res.status).toBe(403);
  });

  it('REJECTS a request with no signature at all', async () => {
    // The pre-fix request shape. It must now fail validation, not succeed.
    const res = await request(app)
      .post('/work/workspace')
      .send({ nameEnc: 'opaque', adminAegisId: MEMBER_ID });
    expect(res.status).toBe(400);
  });

  it('REJECTS a stale signature outside the replay window', async () => {
    const ts = Date.now() - 5 * 60_000;
    const sig = sign(MEMBER_ID, 'create_workspace', ts, signKeys.secretKey);
    const res = await request(app)
      .post('/work/workspace')
      .send({ nameEnc: 'opaque', adminAegisId: MEMBER_ID, sig, ts });
    expect(res.status).toBe(403);
  });

  it('REJECTS a signature bound to a different action', async () => {
    // A read signature must not be replayable as a creation.
    const ts = Date.now();
    const sig = sign(MEMBER_ID, 'read_workspace', ts, signKeys.secretKey);
    const res = await request(app)
      .post('/work/workspace')
      .send({ nameEnc: 'opaque', adminAegisId: MEMBER_ID, sig, ts });
    expect(res.status).toBe(403);
  });
});
