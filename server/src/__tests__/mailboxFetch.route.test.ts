/**
 * mailboxFetch.route.test.ts — stateless mailbox drain endpoint (routes/mailbox.ts).
 *
 * This endpoint lets a mobile client drain its queued mailbox in ONE stateless
 * request over Tor, instead of depending on the persistent Socket.IO mailbox
 * socket coming up on cold start (which it often does not on iOS background).
 *
 * The security-critical invariants under test:
 *   1. Possession proof: only an Ed25519 signature over the server's random
 *      challenge, under the key the mailbox id is derived from, unlocks a drain.
 *      Knowing the id is not enough (golden rule #3).
 *   2. Hijack-proof binding: a mailbox id not derived from the presented key is
 *      rejected before any queue access.
 *   3. One-time challenge: a nonce cannot be replayed.
 *   4. At-least-once: fetch never deletes on read; only the caller's OWN acked
 *      ids are deleted, and acking another mailbox's ids is a no-op (no
 *      cross-mailbox deletion).
 */

process.env['AEGIS_DB_PATH'] = ':memory:';

import express from 'express';
import request from 'supertest';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

const { encodeBase64, decodeBase64 } = naclUtil;

let app: express.Express;
let messageRepo: typeof import('../db/client.js')['messageRepo'];
let mailboxIdForSignPublicKey: typeof import('../crypto/mailbox.js')['mailboxIdForSignPublicKey'];

beforeAll(async () => {
  ({ messageRepo } = await import('../db/client.js'));
  ({ mailboxIdForSignPublicKey } = await import('../crypto/mailbox.js'));
  const { default: mailboxRoutes } = await import('../routes/mailbox.js');
  app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/mailbox', mailboxRoutes);
});

interface Mailbox {
  kp: nacl.SignKeyPair;
  id: string;
  pkB64: string;
}
function newMailbox(): Mailbox {
  const kp = nacl.sign.keyPair();
  return { kp, id: mailboxIdForSignPublicKey(kp.publicKey), pkB64: encodeBase64(kp.publicKey) };
}

let msgSeq = 0;
async function enqueue(recipient: string): Promise<string> {
  const id = `msg-${++msgSeq}-${Math.random().toString(36).slice(2)}`;
  await messageRepo.enqueue({
    id,
    recipient,
    ciphertext_b64: 'sealed-ct',
    nonce_b64: 'sealed-nonce',
    created_at: Date.now(),
    expires_at: 0,
    sender_pub_b64: null,
    epk_b64: 'sealed-epk',
  });
  return id;
}

async function getChallenge(mbx: Mailbox) {
  return request(app)
    .post('/mailbox/challenge')
    .send({ mailboxId: mbx.id, mailboxSignPubKey: mbx.pkB64 });
}
function signNonce(mbx: Mailbox, nonceB64: string): string {
  return encodeBase64(nacl.sign.detached(decodeBase64(nonceB64), mbx.kp.secretKey));
}
/** Full authenticated drain: challenge → sign → fetch. */
async function drain(mbx: Mailbox, ackIds?: string[]) {
  const c = await getChallenge(mbx);
  const nonce = c.body.nonce as string;
  return request(app)
    .post('/mailbox/fetch')
    .send({ mailboxId: mbx.id, mailboxSignPubKey: mbx.pkB64, nonce, sig: signNonce(mbx, nonce), ...(ackIds ? { ackIds } : {}) });
}

describe('POST /mailbox/challenge', () => {
  it('issues a base64 nonce for a well-formed, derivable mailbox id', async () => {
    const mbx = newMailbox();
    const r = await getChallenge(mbx);
    expect(r.status).toBe(200);
    expect(typeof r.body.nonce).toBe('string');
    expect(decodeBase64(r.body.nonce)).toHaveLength(32);
  });

  it('rejects a mailbox id NOT derived from the presented key (hijack attempt)', async () => {
    const mbx = newMailbox();
    const other = newMailbox();
    const r = await request(app)
      .post('/mailbox/challenge')
      .send({ mailboxId: other.id, mailboxSignPubKey: mbx.pkB64 }); // mismatched pair
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('bad_binding');
  });
});

describe('POST /mailbox/fetch — auth', () => {
  it('drains queued envelopes with a valid possession proof', async () => {
    const mbx = newMailbox();
    const a = await enqueue(mbx.id);
    const b = await enqueue(mbx.id);

    const r = await drain(mbx);
    expect(r.status).toBe(200);
    const ids = (r.body.envelopes as { id: string; to: string; ciphertext: string }[]).map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining([a, b]));
    // Sealed fields only, addressed to the opaque mailbox id — zero metadata.
    for (const e of r.body.envelopes) {
      expect(e.to).toBe(mbx.id);
      expect(e.ciphertext).toBe('sealed-ct');
      expect(e).not.toHaveProperty('from');
      expect(e).not.toHaveProperty('recipient');
    }
  });

  it('rejects a wrong signature (knowing the id is not enough)', async () => {
    const mbx = newMailbox();
    await enqueue(mbx.id);
    const c = await getChallenge(mbx);
    const attacker = newMailbox();
    // Sign the real nonce with a DIFFERENT key.
    const badSig = encodeBase64(nacl.sign.detached(decodeBase64(c.body.nonce), attacker.kp.secretKey));
    const r = await request(app)
      .post('/mailbox/fetch')
      .send({ mailboxId: mbx.id, mailboxSignPubKey: mbx.pkB64, nonce: c.body.nonce, sig: badSig });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('auth_failed');
  });

  it('rejects a fetch with no outstanding challenge', async () => {
    const mbx = newMailbox();
    // Never called /challenge — sign a home-made nonce.
    const nonce = encodeBase64(nacl.randomBytes(32));
    const r = await request(app)
      .post('/mailbox/fetch')
      .send({ mailboxId: mbx.id, mailboxSignPubKey: mbx.pkB64, nonce, sig: signNonce(mbx, nonce) });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('challenge_expired');
  });

  it('consumes the challenge one-time — a replay fails', async () => {
    const mbx = newMailbox();
    await enqueue(mbx.id);
    const c = await getChallenge(mbx);
    const body = { mailboxId: mbx.id, mailboxSignPubKey: mbx.pkB64, nonce: c.body.nonce, sig: signNonce(mbx, c.body.nonce) };
    const first = await request(app).post('/mailbox/fetch').send(body);
    expect(first.status).toBe(200);
    const replay = await request(app).post('/mailbox/fetch').send(body);
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe('challenge_expired');
  });
});

describe('POST /mailbox/fetch — at-least-once acking', () => {
  it('does NOT delete on read; deletes only acked ids on the next fetch', async () => {
    const mbx = newMailbox();
    const a = await enqueue(mbx.id);
    const b = await enqueue(mbx.id);

    // First drain, no ack → both still queued afterwards.
    const first = await drain(mbx);
    expect((first.body.envelopes as { id: string }[]).map((e) => e.id).sort()).toEqual([a, b].sort());

    // Re-drain WITHOUT ack → still both (read never deleted).
    const second = await drain(mbx);
    expect((second.body.envelopes as { id: string }[]).map((e) => e.id).sort()).toEqual([a, b].sort());

    // Ack `a` → it is deleted; response excludes it.
    const third = await drain(mbx, [a]);
    expect((third.body.envelopes as { id: string }[]).map((e) => e.id)).toEqual([b]);

    // Fresh drain confirms `a` is gone, `b` remains.
    const fourth = await drain(mbx);
    expect((fourth.body.envelopes as { id: string }[]).map((e) => e.id)).toEqual([b]);
  });

  it('acking another mailbox\'s id is a no-op — no cross-mailbox deletion', async () => {
    const alice = newMailbox();
    const bob = newMailbox();
    const bobMsg = await enqueue(bob.id);

    // Alice authenticates for her OWN mailbox but tries to ack Bob's message id.
    const r = await drain(alice, [bobMsg]);
    expect(r.status).toBe(200);

    // Bob's message must still be there.
    const bobDrain = await drain(bob);
    expect((bobDrain.body.envelopes as { id: string }[]).map((e) => e.id)).toContain(bobMsg);
  });
});
