/**
 * ntfyMailboxPush.relay.test.ts
 *
 * Fase 4 · Slice 2b.1 — server-side wake-up publish on the mailbox path.
 * docs/FASE4-SLICE2B-PUSH-DESIGN.md §5.3, §9 (2b.1).
 *
 * Verifies:
 *   - a `mailboxTopic()` unit test (base64 -> base64url, no padding)
 *   - an `envelope:mb` to an OFFLINE mailbox with the flag ON triggers exactly
 *     one publish to the topic derived from the recipient mailbox id
 *   - an `envelope:mb` delivered to an ONLINE mailbox triggers zero publishes
 *   - with the flag OFF, zero publishes even when the recipient is offline
 *
 * Mirrors the harness in mailboxAuth.relay.test.ts.
 */

process.env['AEGIS_DB_PATH'] = ':memory:';

import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as SocketServer } from 'socket.io';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

const { encodeBase64, decodeBase64 } = naclUtil;

import { mailboxTopic } from '../push/ntfy.js';

const notifyMailboxMock = jest.fn(async () => {});
jest.mock('../push/ntfy.js', () => {
  const actual = jest.requireActual('../push/ntfy.js') as typeof import('../push/ntfy.js');
  return {
    ...actual,
    notifyMailbox: (mailboxIdB64: string) => notifyMailboxMock(mailboxIdB64),
  };
});

describe('mailboxTopic()', () => {
  test('converts standard base64 to unpadded base64url', () => {
    // '+', '/' and trailing '=' padding are the three chars ntfy topics reject.
    expect(mailboxTopic('ab+c/de==')).toBe('ab-c_de');
    expect(mailboxTopic('AAAA')).toBe('AAAA');
    expect(mailboxTopic('a+b/c=')).toBe('a-b_c');
  });
});

describe('Slice 2b.1 — mailbox wake-up publish on offline enqueue', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: SocketServer;
  let serverUrl: string;
  let attachRelay: typeof import('../relay/handler.js').attachRelay;
  let initDb: typeof import('../db/client.js').initDb;
  let mailboxIdForSignPublicKey: typeof import('../crypto/mailbox.js').mailboxIdForSignPublicKey;

  beforeAll(async () => {
    ({ attachRelay } = await import('../relay/handler.js'));
    ({ initDb } = await import('../db/client.js'));
    ({ mailboxIdForSignPublicKey } = await import('../crypto/mailbox.js'));

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
    io.disconnectSockets(true);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => { io.close(() => resolve()); });
    await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
    await new Promise((resolve) => setTimeout(resolve, 50));
  }, 10_000);

  beforeEach(() => {
    notifyMailboxMock.mockClear();
  });

  interface MailboxKeys { signKeyPair: nacl.SignKeyPair; mailboxId: string }
  function makeMailbox(seed: number): MailboxKeys {
    const seedBytes = new Uint8Array(32);
    new DataView(seedBytes.buffer).setUint32(0, seed, false);
    const signKeyPair = nacl.sign.keyPair.fromSeed(seedBytes);
    return { signKeyPair, mailboxId: mailboxIdForSignPublicKey(signKeyPair.publicKey) };
  }

  function connectMailbox(keys: MailboxKeys): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const socket = clientIo(serverUrl, {
        auth: {
          mailboxId: keys.mailboxId,
          mailboxSignPubKey: encodeBase64(keys.signKeyPair.publicKey),
          platform: 'mobile',
        },
        transports: ['websocket'],
        reconnection: false,
      });
      const timer = setTimeout(() => { socket.disconnect(); reject(new Error('mailbox auth timeout')); }, 8_000);
      socket.on('mailbox:challenge', (c: { nonce: string }) => {
        const sig = nacl.sign.detached(decodeBase64(c.nonce), keys.signKeyPair.secretKey);
        socket.emit('mailbox:auth:response', { sig: encodeBase64(sig) });
      });
      socket.on('auth:ok', () => { clearTimeout(timer); resolve(socket); });
      socket.on('error_msg', (e: { code: string }) => { clearTimeout(timer); socket.disconnect(); reject(new Error(`Server error: ${e.code}`)); });
      socket.on('connect_error', (err: Error) => { clearTimeout(timer); reject(err); });
    });
  }

  type MbAck = { ok: boolean; delivered?: boolean; queued?: boolean; error?: string };
  function sendMb(socket: ClientSocket, payload: Record<string, unknown>): Promise<MbAck> {
    return new Promise((resolve) => {
      socket.emit('envelope:mb', payload, (res: MbAck) => resolve(res));
    });
  }

  function makeMbWire(toMailboxId: string, id: string): Record<string, unknown> {
    return {
      id, to: toMailboxId,
      ciphertext: encodeBase64(nacl.randomBytes(48)),
      nonce: encodeBase64(nacl.randomBytes(24)),
      epk: encodeBase64(nacl.randomBytes(32)),
    };
  }

  test('offline mailbox + flag ON -> exactly one publish to topic=recipient mailbox id', async () => {
    const prev = process.env['PUSH_MAILBOX_ENABLED'];
    process.env['PUSH_MAILBOX_ENABLED'] = 'on';
    try {
      const sender = makeMailbox(91001);
      const recipient = makeMailbox(91002); // never connects -> offline

      const senderSock = await connectMailbox(sender);
      const ack = await sendMb(senderSock, makeMbWire(recipient.mailboxId, 'mb-push-1'));
      expect(ack.ok).toBe(true);
      expect(ack.queued).toBe(true);

      await new Promise((r) => setTimeout(r, 50));
      expect(notifyMailboxMock).toHaveBeenCalledTimes(1);
      expect(notifyMailboxMock).toHaveBeenCalledWith(recipient.mailboxId);

      senderSock.disconnect();
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      if (prev === undefined) delete process.env['PUSH_MAILBOX_ENABLED'];
      else process.env['PUSH_MAILBOX_ENABLED'] = prev;
    }
  }, 30_000);

  test('online mailbox -> zero publishes (delivered live, never queued)', async () => {
    const prev = process.env['PUSH_MAILBOX_ENABLED'];
    process.env['PUSH_MAILBOX_ENABLED'] = 'on';
    try {
      const sender = makeMailbox(91011);
      const recipient = makeMailbox(91012);

      const recSock = await connectMailbox(recipient);
      const senderSock = await connectMailbox(sender);

      const ack = await sendMb(senderSock, makeMbWire(recipient.mailboxId, 'mb-push-2'));
      expect(ack.ok).toBe(true);
      expect(ack.delivered).toBe(true);

      await new Promise((r) => setTimeout(r, 50));
      expect(notifyMailboxMock).not.toHaveBeenCalled();

      senderSock.disconnect();
      recSock.disconnect();
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      if (prev === undefined) delete process.env['PUSH_MAILBOX_ENABLED'];
      else process.env['PUSH_MAILBOX_ENABLED'] = prev;
    }
  }, 30_000);

});


// The relay hook itself always calls notifyMailbox() on an offline enqueue -
// the ON/OFF flag gate lives INSIDE notifyMailbox, so "flag off -> zero
// publishes" is verified end-to-end against the real (unmocked) notifyMailbox
// in ntfy.unit.test.ts (this file mocks the whole module, so it can't
// exercise that gate).
