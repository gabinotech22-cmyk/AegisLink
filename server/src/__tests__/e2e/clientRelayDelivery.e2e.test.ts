/**
 * END-TO-END: the REAL mobile crypto against the REAL relay.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Six consecutive delivery bugs shipped and were fixed one at a time — #421
 * (queued messages replayed on every reconnect, forever), #422 (the stateless
 * mailbox drain was dead code), #423 (messages to a just-closed phone emitted
 * into the void), #424 (a group key thrown away), #426 (an envelope we could not
 * open acked as if stored). Every one of them lived in the same place: the seam
 * between the mobile client and the relay.
 *
 * That seam had no test. The relay suites drive synthetic clients that hand-roll
 * envelopes; the mobile suites mock the socket entirely. Both sides were green
 * while messages were being lost between them.
 *
 * This harness closes that gap. It boots the real relay (real handler, real
 * queue, real SQLite) and talks to it with the real client-side protocol
 * modules from mobile/src/crypto — the same ratchet, the same sealed-sender
 * envelope format, the same padding the app ships. If the wire contract or the
 * queue semantics drift, this goes red.
 *
 * WHAT IS REAL AND WHAT IS NOT
 * ----------------------------
 * Real: relay handler, challenge-response auth, offline queue + drain + per-device
 * ack bookkeeping, Double Ratchet, sealed-sender framing, message padding.
 * Not real: the X3DH handshake. mobile/src/crypto/signal/x3dh.ts reaches into
 * db/local (expo-sqlite) for prekey secrets, so it cannot be loaded outside the
 * app; sessions here are bootstrapped by calling initRatchet directly with a
 * shared secret. X3DH itself is covered by mobile's own unit suites — the bugs
 * this file targets are queue and ack semantics, which sit downstream of it.
 */

// MUST be set before any server module is imported.
process.env.AEGIS_DB_PATH = ':memory:';

// NOTE ON REGISTRATION BUDGET
// Production caps registration at 5 per 15 min per IP, and every party here
// registers from the same loopback address. Raising it via
// AEGIS_REG_RATELIMIT_MAX does not work from this file: ESM hoists the imports
// above any assignment, so identity.ts builds its limiter before the assignment
// runs. So the harness stays under the real limit instead — ONE shared sender
// (Alice never receives, so she has no queue to pollute) plus a fresh recipient
// per scenario, which is what keeps the per-device queue assertions isolated.

import express from 'express';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as SocketServer } from 'socket.io';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { createHash } from 'node:crypto';

import supertest, { type Agent as SuperAgent } from 'supertest';

import { attachRelay } from '../../relay/handler.js';
import identityRoutes from '../../routes/identity.js';
import { initDb, messageRepo } from '../../db/client.js';

// ── The client under test: the app's own crypto, imported from mobile/ ────────
// Extensionless relative specifiers resolve through ts-jest's `bundler`
// moduleResolution, the same way Metro resolves them in the app.
import { initRatchet, type RatchetState } from '../../../../mobile/src/crypto/signal/ratchet';
import { encryptMessage, tryDecryptMessage } from '../../../../mobile/src/crypto/messaging';
// The app's own id derivation, not a copy: an id the client would never produce
// is not a realistic test subject, and a local reimplementation would silently
// drift from the 3-4-4 Crockford format the relay validates.
import { deriveAegisId } from '../../../../mobile/src/crypto/aegisId';

const { encodeBase64, decodeBase64 } = naclUtil;

interface Party {
  aegisId: string;
  box: nacl.BoxKeyPair;
  sign: nacl.SignKeyPair;
  deviceId: string;
}

function makeParty(deviceId: string): Party {
  const box = nacl.box.keyPair();
  const sign = nacl.sign.keyPair();
  return { aegisId: deriveAegisId(box.publicKey), box, sign, deviceId };
}

// ── Registration (PoW-gated, exactly as the app does it) ──────────────────────
// The relay seals its auth challenge to the REGISTERED box public key, so an
// unregistered identity cannot hold a session: the handshake fails closed with
// bad_handshake. Registering here is not scaffolding, it is part of the contract.

function hasLeadingZeroBits(buf: Buffer, bits: number): boolean {
  const fullBytes = bits >> 3;
  for (let i = 0; i < fullBytes; i++) if (buf[i] !== 0) return false;
  const rem = bits & 7;
  return rem === 0 || (buf[fullBytes] >> (8 - rem)) === 0;
}

function solvePoW(challenge: string, difficulty: number): string {
  for (let n = 0; n < 2_000_000; n++) {
    const nonce = n.toString(16);
    if (hasLeadingZeroBits(createHash('sha256').update(nonce + challenge).digest(), difficulty)) {
      return nonce;
    }
  }
  throw new Error(`PoW unsolvable after 2M iterations (difficulty=${difficulty})`);
}

async function register(p: Party): Promise<void> {
  const res = await request.get('/identity/challenge').expect(200);
  const { challenge, difficulty } = res.body as { challenge: string; difficulty: number };
  await request.post('/identity').send({
    aegisId: p.aegisId,
    publicKey: encodeBase64(p.box.publicKey),
    signingPublicKey: encodeBase64(p.sign.publicKey),
    powChallenge: challenge,
    powNonce: solvePoW(challenge, difficulty),
  }).expect(201);
}

/** A registered party, ready to hold a session. */
async function makeRegisteredParty(deviceId: string): Promise<Party> {
  const p = makeParty(deviceId);
  await register(p);
  return p;
}

/**
 * Two ratchet states over one shared root key — what a completed X3DH leaves
 * behind. Alice is the initiator; Bob MUST start with his SPK pair as DHs so
 * their first DH step agrees (see initRatchet's own note).
 */
function pairSessions(shared: Uint8Array, bobSpk: nacl.BoxKeyPair): {
  alice: RatchetState; bob: RatchetState;
} {
  const alice = initRatchet(shared, bobSpk.publicKey, true);
  const bob = initRatchet(new Uint8Array(shared), bobSpk.publicKey, false, bobSpk);
  return { alice, bob };
}

// ── Relay lifecycle ───────────────────────────────────────────────────────────

let httpServer: HttpServer;
let io: SocketServer;
let port: number;
let request: SuperAgent;
/** Shared sender across every scenario. Never a recipient, so it owns no queue. */
let alice: Party;

beforeAll(async () => {
  await initDb();
  const app = express();
  app.use(express.json());
  app.use('/identity', identityRoutes);
  request = supertest(app);
  httpServer = createServer(app);
  // attachRelay takes the Socket.IO server, NOT the http server — passing the
  // latter silently binds its handlers to raw TCP 'connection' events.
  io = new SocketServer(httpServer, { cors: { origin: '*' } });
  attachRelay(io);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  port = (httpServer.address() as AddressInfo).port;
  // One sender for the whole file — see the registration-budget note at the top.
  alice = await makeRegisteredParty('alice-dev');
});

afterAll(async () => {
  await io.close();
  await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
});

/**
 * Answer the relay's auth challenge.
 *
 * Possession proof is DECRYPTION, not signing: the relay seals a random plaintext
 * to the identity's box public key and only the holder of the matching secret can
 * return it. Knowing an aegisId is not enough (golden rule #3).
 */
function solveChallenge(
  wire: { ephemeralPubKey: string; nonce: string; ciphertext: string },
  mySecretKey: Uint8Array,
): string {
  const plain = nacl.box.open(
    decodeBase64(wire.ciphertext),
    decodeBase64(wire.nonce),
    decodeBase64(wire.ephemeralPubKey),
    mySecretKey,
  );
  if (!plain) throw new Error('challenge decryption failed — wrong secret key?');
  return encodeBase64(plain);
}

/**
 * Connect, complete the handshake, and collect every envelope the relay pushes.
 *
 * The envelope listener is attached BEFORE auth completes on purpose: the relay
 * drains the offline queue inside onAuthenticated(), which runs before it emits
 * auth:ok, so a listener registered afterwards misses the whole backlog.
 */
async function connectAuthed(p: Party): Promise<{
  sock: ClientSocket;
  envelopes: { id: string; ciphertext: string; nonce: string }[];
}> {
  const sock = clientIo(`http://localhost:${port}`, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    // ackDelivery mirrors what mobile and desktop both advertise. Without it the
    // relay falls back to legacy delete-on-emit for backwards compatibility, and
    // the at-least-once behaviour under test would never engage.
    auth: { aegisId: p.aegisId, platform: 'mobile', deviceId: p.deviceId, ackDelivery: true },
  });
  const envelopes: { id: string; ciphertext: string; nonce: string }[] = [];
  sock.on('envelope', (env: { id: string; ciphertext: string; nonce: string }) => {
    envelopes.push(env);
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { sock.disconnect(); reject(new Error('auth timeout')); }, 10_000);
    sock.on('auth:challenge', (wire: { ephemeralPubKey: string; nonce: string; ciphertext: string }) => {
      try {
        sock.emit('auth:response', { plain: solveChallenge(wire, p.box.secretKey) });
      } catch (e) { clearTimeout(timer); reject(e as Error); }
    });
    sock.on('auth:ok', () => { clearTimeout(timer); resolve(); });
    sock.on('error_msg', (e: { code?: string }) => {
      clearTimeout(timer); reject(new Error(`error_msg ${e?.code ?? '?'}`));
    });
    sock.on('connect_error', (e: Error) => { clearTimeout(timer); reject(e); });
  });
  return { sock, envelopes };
}

/** Wait until `envelopes` holds at least `n` entries, or fail. */
async function waitForEnvelopes(
  envelopes: unknown[], n: number, whatFor: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (envelopes.length < n) {
    if (Date.now() > deadline) {
      throw new Error(`${whatFor}: got ${envelopes.length}/${n} envelopes`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

function disconnect(sock: ClientSocket | null): void {
  if (sock) { sock.removeAllListeners(); sock.disconnect(); }
}

/** Emit an envelope and resolve with the relay's ack. */
function emitEnvelope(
  sock: ClientSocket,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; queued?: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ack timeout')), 10_000);
    sock.emit('envelope', payload, (ack: { ok: boolean; queued?: boolean; error?: string }) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('E2E — offline send survives to a real reconnect (the #421/#423 class)', () => {
  it('queues for an offline recipient, drains on reconnect, and decrypts with the real ratchet', async () => {
    const bob = await makeRegisteredParty('bob-dev-1');
    const bobRatchet = nacl.box.keyPair();
    const { alice: aliceSession, bob: bobSession } = pairSessions(
      nacl.randomBytes(32), bobRatchet,
    );

    // Bob registers his device with the relay, then goes offline. Registering
    // first matters: drain bookkeeping is scoped per device id.
    disconnect((await connectAuthed(bob)).sock);

    const a = await connectAuthed(alice);
    const { envelope } = encryptMessage(
      JSON.stringify({ type: 'text', text: 'sent while you were away' }),
      alice.aegisId,
      bob.box.publicKey,
      alice.box.secretKey,
      aliceSession,
    );

    const ack = await emitEnvelope(a.sock, {
      id: 'msg-offline-1',
      to: bob.aegisId,
      ciphertext: envelope.ciphertextB64,
      nonce: envelope.nonceB64,
    });
    expect(ack.ok).toBe(true);

    // Bob comes back: the backlog arrives during the handshake, before auth:ok.
    const b = await connectAuthed(bob);
    await waitForEnvelopes(b.envelopes, 1, 'offline drain');
    expect(b.envelopes[0].id).toBe('msg-offline-1');

    // The real client-side open. A null here IS the failure mode: the wire
    // contract or the ratchet state drifted and the message is unreadable.
    const opened = tryDecryptMessage(
      { ciphertextB64: b.envelopes[0].ciphertext, nonceB64: b.envelopes[0].nonce },
      alice.box.publicKey,
      bob.box.secretKey,
      bobSession,
    );
    expect(opened).not.toBeNull();
    expect(opened!.from).toBe(alice.aegisId);
    expect(JSON.parse(opened!.body).text).toBe('sent while you were away');

    disconnect(a.sock);
    disconnect(b.sock);
  }, 30_000);
});

describe('E2E — at-least-once: the relay keeps the message until the client acks', () => {
  it('does NOT drop a drained message that was never acked, and re-drains it', async () => {
    // #421 and #426 pull in opposite directions. The relay must not delete on
    // emit (a lost delivery would be gone for good), and must stop redelivering
    // once the client confirms it actually persisted the envelope.
    const bob = await makeRegisteredParty('bob-dev-2');
    const bobRatchet = nacl.box.keyPair();
    const { alice: aliceSession } = pairSessions(nacl.randomBytes(32), bobRatchet);

    disconnect((await connectAuthed(bob)).sock);

    const a = await connectAuthed(alice);
    const { envelope } = encryptMessage(
      JSON.stringify({ type: 'text', text: 'ack me' }),
      alice.aegisId, bob.box.publicKey, alice.box.secretKey, aliceSession,
    );
    await emitEnvelope(a.sock, {
      id: 'msg-ack-1', to: bob.aegisId,
      ciphertext: envelope.ciphertextB64, nonce: envelope.nonceB64,
    });

    // First drain: Bob receives it but deliberately does NOT ack — this models
    // an app killed mid-write, or an envelope it could not open (#426).
    const b1 = await connectAuthed(bob);
    await waitForEnvelopes(b1.envelopes, 1, 'first drain');
    disconnect(b1.sock);

    // Un-acked, so the row must still be queued for this device.
    expect((await messageRepo.drainFor(bob.aegisId, bob.deviceId)).length).toBe(1);

    // Second drain: same message re-delivered, and this time acked.
    const b2 = await connectAuthed(bob);
    await waitForEnvelopes(b2.envelopes, 1, 're-drain');
    expect(b2.envelopes[0].id).toBe('msg-ack-1');

    b2.sock.emit('envelope:ack', { id: 'msg-ack-1' });
    await new Promise((r) => setTimeout(r, 300)); // let the relay record it

    // Acked by every device that had to drain it → gone. Without this the client
    // re-downloads its whole backlog on every single reconnect (#421).
    expect((await messageRepo.drainFor(bob.aegisId, bob.deviceId)).length).toBe(0);

    disconnect(a.sock);
    disconnect(b2.sock);
  }, 30_000);
});

describe('E2E — the ratchet advances across a real relay round trip', () => {
  it('delivers three messages in order and each decrypts exactly once', async () => {
    // Guards the interaction between FIFO drain order and ratchet state: a
    // reordered or duplicated delivery desynchronises the chain and every later
    // message becomes permanently undecryptable.
    const bob = await makeRegisteredParty('bob-dev-3');
    const bobRatchet = nacl.box.keyPair();
    const paired = pairSessions(nacl.randomBytes(32), bobRatchet);
    let aliceSession = paired.alice;
    let bobSession = paired.bob;

    disconnect((await connectAuthed(bob)).sock);
    const a = await connectAuthed(alice);

    const texts = ['first', 'second', 'third'];
    for (let i = 0; i < texts.length; i++) {
      const r = encryptMessage(
        JSON.stringify({ type: 'text', text: texts[i] }),
        alice.aegisId, bob.box.publicKey, alice.box.secretKey, aliceSession,
      );
      aliceSession = r.newState; // the app persists this between sends
      const ack = await emitEnvelope(a.sock, {
        id: `msg-seq-${i}`, to: bob.aegisId,
        ciphertext: r.envelope.ciphertextB64, nonce: r.envelope.nonceB64,
      });
      expect(ack.ok).toBe(true);
    }

    const b = await connectAuthed(bob);
    await waitForEnvelopes(b.envelopes, texts.length, 'sequenced drain');

    expect(b.envelopes.map((e) => e.id)).toEqual(['msg-seq-0', 'msg-seq-1', 'msg-seq-2']);
    const opened: string[] = [];
    for (const env of b.envelopes) {
      const r = tryDecryptMessage(
        { ciphertextB64: env.ciphertext, nonceB64: env.nonce },
        alice.box.publicKey, bob.box.secretKey, bobSession,
      );
      expect(r).not.toBeNull();
      bobSession = r!.newState; // the app persists the advanced state per message
      opened.push(JSON.parse(r!.body).text);
      b.sock.emit('envelope:ack', { id: env.id });
    }
    expect(opened).toEqual(texts);

    disconnect(a.sock);
    disconnect(b.sock);
  }, 30_000);
});
