/**
 * deviceLink.relay.test.ts
 *
 * Regression for external audit 2026-09-16 AL-01 (device linking was broken
 * end-to-end and revocation was never enforced):
 *   (a) the relay forwards the EPHEMERAL `mobilePubKey` the phone boxed with, so
 *       the desktop can actually `nacl.box.open` the identity payload — it used
 *       to forward the identity's permanent X25519 key (decrypt always failed);
 *   (b) approval acks the mobile `{ok:true}` (it used to time out client-side);
 *   (c) the link row is persisted and `device:list` returns it in the shape
 *       both clients render (it used to return `{count, platforms}` — a shape
 *       no client understood — so the list was always empty);
 *   (d) a desktop session is admitted only with an ACTIVE link row for its
 *       deviceId — no row → `device_not_linked`;
 *   (e) after `device:revoke` the desktop is disconnected and cannot re-auth.
 *
 * Self-contained harness (mirrors pushRegisterAck.relay.test.ts).
 */

process.env['AEGIS_DB_PATH'] = ':memory:';

import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Server as SocketServer } from 'socket.io';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

const { encodeBase64, decodeBase64, decodeUTF8, encodeUTF8 } = naclUtil;

import { identityRepo, initDb } from '../db/client.js';
import { attachRelay } from '../relay/handler.js';

const BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function base32Segment(len: number, seed: number): string {
  let s = '';
  let n = seed;
  for (let i = 0; i < len; i++) {
    s += BASE32_ALPHABET[n % 32];
    n = Math.floor(n / 32);
    if (n === 0) n = seed + i + 1;
  }
  return s;
}
function makeAegisId(seed: number): string {
  return `${base32Segment(3, seed)}-${base32Segment(4, seed * 7)}-${base32Segment(4, seed * 13)}`;
}

interface AgentKeys { boxKeyPair: nacl.BoxKeyPair; signKeyPair: nacl.SignKeyPair; aegisId: string }
function makeAgentKeys(seed: number): AgentKeys {
  const seedBytes = new Uint8Array(32);
  const view = new DataView(seedBytes.buffer);
  view.setUint32(0, seed, false);
  view.setUint32(4, seed * 31337, false);
  return {
    boxKeyPair: nacl.box.keyPair.fromSecretKey(seedBytes),
    signKeyPair: nacl.sign.keyPair.fromSeed(seedBytes),
    aegisId: makeAegisId(seed),
  };
}

function solveChallenge(wire: { ephemeralPubKey: string; nonce: string; ciphertext: string }, secretKey: Uint8Array): string {
  const plain = nacl.box.open(decodeBase64(wire.ciphertext), decodeBase64(wire.nonce), decodeBase64(wire.ephemeralPubKey), secretKey);
  if (!plain) throw new Error('Challenge decryption failed');
  return encodeBase64(plain);
}

let httpServer: ReturnType<typeof createServer>;
let io: SocketServer;
let serverUrl: string;
const open: ClientSocket[] = [];

beforeAll(async () => {
  await initDb();
  const app = express();
  httpServer = createServer(app);
  io = new SocketServer(httpServer, { cors: { origin: '*' } });
  attachRelay(io);
  await new Promise<void>((resolve) => { httpServer.listen(0, '127.0.0.1', () => resolve()); });
  const { port } = httpServer.address() as AddressInfo;
  serverUrl = `http://127.0.0.1:${port}`;
}, 30_000);

afterAll(async () => {
  for (const s of open) s.disconnect();
  io.disconnectSockets(true);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => { io.close(() => resolve()); });
  await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
  await new Promise((resolve) => setTimeout(resolve, 50));
}, 10_000);

async function registerAgent(keys: AgentKeys): Promise<void> {
  await identityRepo.insert({
    aegis_id: keys.aegisId,
    public_key_b64: encodeBase64(keys.boxKeyPair.publicKey),
    signing_public_key_b64: encodeBase64(keys.signKeyPair.publicKey),
    created_at: Date.now(),
  });
}

/** Authenticate as `keys` with the given platform/deviceId; resolves on auth:ok, rejects with the error code. */
function connectAs(keys: AgentKeys, platform: 'mobile' | 'desktop', deviceId?: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = clientIo(serverUrl, {
      auth: { aegisId: keys.aegisId, platform, ...(deviceId ? { deviceId } : {}) },
      transports: ['websocket'],
      reconnection: false,
    });
    open.push(socket);
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error('auth_timeout')); }, 8_000);
    socket.on('auth:challenge', (wire: { ephemeralPubKey: string; nonce: string; ciphertext: string }) => {
      socket.emit('auth:response', { plain: solveChallenge(wire, keys.boxKeyPair.secretKey) });
    });
    // Only auth-phase errors reject; after auth:ok the socket keeps living and
    // non-fatal `error_msg` events (e.g. a rejected payload) must not kill it.
    const onErr = (e: { code: string }) => { clearTimeout(timer); socket.disconnect(); reject(new Error(e.code)); };
    socket.on('error_msg', onErr);
    socket.on('auth:ok', () => { clearTimeout(timer); socket.off('error_msg', onErr); resolve(socket); });
    socket.on('connect_error', (err: Error) => { clearTimeout(timer); reject(err); });
  });
}

/** An unauthenticated desktop socket that registers a pending link. */
function desktopLinkRequest(targetAegisId: string, desktopPubKey: string, deviceId: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = clientIo(serverUrl, {
      auth: { linkRequest: true },
      transports: ['websocket'],
      reconnection: false,
    });
    open.push(socket);
    const timer = setTimeout(() => reject(new Error('link_pending_timeout')), 8_000);
    socket.on('connect', () => {
      socket.emit('device:link', { targetAegisId, desktopPubKey, deviceId, deviceName: 'Test Desktop' });
    });
    socket.on('device:link', (res: { status?: string }) => {
      if (res.status === 'pending') { clearTimeout(timer); resolve(socket); }
    });
    socket.on('connect_error', (err: Error) => { clearTimeout(timer); reject(err); });
  });
}

function emitWithAck<T>(socket: ClientSocket, event: string, payload?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), 5_000);
    const cb = (res: T) => { clearTimeout(timer); resolve(res); };
    if (payload === undefined) socket.emit(event, cb);
    else socket.emit(event, payload, cb);
  });
}

describe('device linking (audit 2026-09-16 AL-01)', () => {
  const owner = makeAgentKeys(9101);
  const desktopEphemeral = nacl.box.keyPair();
  const desktopPubKeyB64 = encodeBase64(desktopEphemeral.publicKey);
  const desktopDeviceId = randomUUID();
  const secretPayload = { aegisId: owner.aegisId, publicKeyB64: 'pk', secretKeyB64: 'sk', signingPublicKeyB64: 'spk', signingSecretKeyB64: 'ssk' };

  let mobile: ClientSocket;
  let desktopPending: ClientSocket;

  beforeAll(async () => {
    await registerAgent(owner);
    mobile = await connectAs(owner, 'mobile', 'mobile-primary');
    desktopPending = await desktopLinkRequest(owner.aegisId, desktopPubKeyB64, desktopDeviceId);
  }, 20_000);

  test('a desktop with no link row is refused before the session opens (fail-closed)', async () => {
    await expect(connectAs(owner, 'desktop', randomUUID())).rejects.toThrow('device_not_linked');
    await expect(connectAs(owner, 'desktop')).rejects.toThrow('device_not_linked');
  });

  test('approve forwards the EPHEMERAL mobile key so the desktop can decrypt, and acks the mobile', async () => {
    const approved = new Promise<{ encryptedPayload: string; nonceB64: string; mobilePubKey: string }>((resolve) => {
      desktopPending.once('device:link:approved', resolve);
    });

    // Exactly what mobile/src/screens/Devices.tsx does: a fresh ephemeral pair per approval.
    const mobileEphemeral = nacl.box.keyPair();
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const boxed = nacl.box(decodeUTF8(JSON.stringify(secretPayload)), nonce, desktopEphemeral.publicKey, mobileEphemeral.secretKey);

    const ack = await emitWithAck<{ ok: boolean; error?: string }>(mobile, 'device:link:approve', {
      desktopPubKey: desktopPubKeyB64,
      encryptedPayload: encodeBase64(boxed),
      nonceB64: encodeBase64(nonce),
      mobilePubKey: encodeBase64(mobileEphemeral.publicKey),
    });
    expect(ack).toEqual({ ok: true });

    const wire = await approved;
    // The relay must forward the ephemeral key — NOT the identity's permanent one.
    expect(wire.mobilePubKey).toBe(encodeBase64(mobileEphemeral.publicKey));
    expect(wire.mobilePubKey).not.toBe(encodeBase64(owner.boxKeyPair.publicKey));

    // Exactly what desktop/src/renderer/screens/LinkDevice.tsx does.
    const opened = nacl.box.open(decodeBase64(wire.encryptedPayload), decodeBase64(wire.nonceB64), decodeBase64(wire.mobilePubKey), desktopEphemeral.secretKey);
    expect(opened).not.toBeNull();
    expect(JSON.parse(encodeUTF8(opened!))).toEqual(secretPayload);

    // The permanent identity key would NOT open it — proving the old behaviour was fatal.
    expect(nacl.box.open(decodeBase64(wire.encryptedPayload), decodeBase64(wire.nonceB64), owner.boxKeyPair.publicKey, desktopEphemeral.secretKey)).toBeNull();
  });

  test('the link is persisted: device:list returns it in the shape the clients render', async () => {
    const res = await emitWithAck<{ ok: boolean; devices?: Array<{ id: string; name: string; platform: string; linkedAt: number }> }>(mobile, 'device:list');
    expect(res.ok).toBe(true);
    expect(res.devices).toHaveLength(1);
    expect(res.devices![0]).toMatchObject({ id: desktopDeviceId, name: 'Test Desktop', platform: 'desktop' });
    expect(typeof res.devices![0]!.linkedAt).toBe('number');
  });

  test('a linked desktop authenticates; after revoke it is disconnected and cannot re-auth', async () => {
    const desktop = await connectAs(owner, 'desktop', desktopDeviceId);
    const revokedEvent = new Promise<{ deviceId: string }>((resolve) => desktop.once('device:revoked', resolve));
    const disconnected = new Promise<void>((resolve) => desktop.once('disconnect', () => resolve()));

    const ack = await emitWithAck<{ ok: boolean; error?: string }>(mobile, 'device:revoke', { deviceId: desktopDeviceId });
    expect(ack).toEqual({ ok: true });
    expect(await revokedEvent).toEqual({ deviceId: desktopDeviceId });
    await disconnected;

    await expect(connectAs(owner, 'desktop', desktopDeviceId)).rejects.toThrow('device_not_linked');

    const list = await emitWithAck<{ ok: boolean; devices?: unknown[] }>(mobile, 'device:list');
    expect(list.devices).toHaveLength(0);
  });

  test('revoking an unknown device answers not_found', async () => {
    const ack = await emitWithAck<{ ok: boolean; error?: string }>(mobile, 'device:revoke', { deviceId: 'nope' });
    expect(ack).toEqual({ ok: false, error: 'not_found' });
  });

  test('approve without mobilePubKey is rejected (schema must not silently drop it again)', async () => {
    const ack = await emitWithAck<{ ok: boolean; error?: string }>(mobile, 'device:link:approve', {
      desktopPubKey: desktopPubKeyB64,
      encryptedPayload: 'AAAA',
      nonceB64: 'AAAA',
    });
    expect(ack).toEqual({ ok: false, error: 'invalid_payload' });
  });
});
