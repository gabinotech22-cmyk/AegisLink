/**
 * accountDeletion.test.ts — B-2 regression.
 *
 * The relay's DELETE /identity/:id (server/src/routes/identity.ts) authenticates
 * by verifying an Ed25519 detached signature over
 *   `${aegisId}:delete:${floor(ts / 30000)}`
 * against the stored signing public key. If the client signed a different
 * string, the wrong key, or hit the wrong URL/method, every deletion would 403
 * and the account would be undeletable. This pins the request shape + signature
 * and the ok/non-ok mapping the UI relies on (only ok ⇒ local wipe).
 */

import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { utf8ToBytes } from '@noble/hashes/utils';

jest.mock('../../config', () => ({ SERVER_URL: 'https://relay.test' }));

import { deleteAccountOnRelay } from '../accountDeletion';
import type { Identity } from '../identity';

const AEGIS_ID = 'ABC-DEFG-HJKM';

function makeIdentity(): { identity: Identity; signingPublicKey: Uint8Array } {
  const sign = nacl.sign.keyPair();
  const identity = {
    aegisId: AEGIS_ID,
    signingSecretKey: sign.secretKey,
    signingPublicKeyB64: encodeBase64(sign.publicKey),
  } as unknown as Identity;
  return { identity, signingPublicKey: sign.publicKey };
}

function mockResponse(status: number, body: unknown): Response {
  return {
    status,
    statusText: `HTTP ${status}`,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('deleteAccountOnRelay (mobile ↔ server auth parity)', () => {
  it('issues a DELETE to /identity/:id with a signature the server will accept', async () => {
    const { identity, signingPublicKey } = makeIdentity();
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse(200, { deleted: true }));

    const result = await deleteAccountOnRelay(identity);

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://relay.test/identity/${AEGIS_ID}`);
    expect(init.method).toBe('DELETE');

    const sent = JSON.parse(init.body as string) as { sig: string; ts: number };
    expect(typeof sent.sig).toBe('string');
    // ts is fresh (well within the server's ±60s window).
    expect(Math.abs(Date.now() - sent.ts)).toBeLessThan(5_000);

    // Reproduce the server's verification: signature must validate over the
    // exact `${aegisId}:delete:${bucket}` message with the signing public key.
    const bucket = Math.floor(sent.ts / 30_000);
    const msg = utf8ToBytes(`${AEGIS_ID}:delete:${bucket}`);
    const valid = nacl.sign.detached.verify(msg, Buffer.from(sent.sig, 'base64'), signingPublicKey);
    expect(valid).toBe(true);
  });

  it('treats 404 (no server-side record) as success', async () => {
    const { identity } = makeIdentity();
    jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse(404, { error: 'not_found' }));
    await expect(deleteAccountOnRelay(identity)).resolves.toEqual({ ok: true, status: 404 });
  });

  it('returns ok:false with the relay reason on 403 (so the caller does NOT wipe)', async () => {
    const { identity } = makeIdentity();
    jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse(403, { error: 'invalid_signature' }));
    const result = await deleteAccountOnRelay(identity);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toBe('invalid_signature');
  });

  it('returns ok:false on a network error without throwing', async () => {
    const { identity } = makeIdentity();
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
    const result = await deleteAccountOnRelay(identity);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('network error');
  });
});
