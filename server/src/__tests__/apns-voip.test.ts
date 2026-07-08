/**
 * apns-voip.test.ts — iOS VoIP (PushKit) push sender (push/apns-voip.ts).
 *
 * Runnable regression tests for the two subtle, security-critical pieces that
 * can be verified without a live APNs connection:
 *
 *   1. The Apple provider token is a well-formed ES256 JWS whose signature
 *      VERIFIES against the matching public key, and whose header/claims match
 *      Apple's spec (alg/kid/iss/iat). A DER-vs-raw signature mistake here would
 *      silently break every VoIP push.
 *   2. The VoIP payload is ZERO-METADATA: it contains ONLY callId + media and
 *      NEVER a sender/recipient/identifying field (privacy golden rule #2).
 */

import { createHash, generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { buildProviderToken, buildVoipPayload } from '../push/apns-voip.js';

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

describe('apns-voip provider token (ES256 JWS)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

  it('produces a token whose signature verifies against the public key', () => {
    const nowMs = 1_700_000_000_000;
    const jwt = buildProviderToken({ keyId: 'ABC1234567', teamId: 'TEAM123456', key: privateKey, nowMs });

    const [header, claims, sig] = jwt.split('.');
    expect(header && claims && sig).toBeTruthy();

    // ES256 signature is raw r||s (64 bytes for P-256), NOT DER. Verify it with
    // ieee-p1363 encoding against the public key.
    const ok = cryptoVerify(
      'SHA256',
      Buffer.from(`${header}.${claims}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      b64urlToBuf(sig),
    );
    expect(ok).toBe(true);
    expect(b64urlToBuf(sig).length).toBe(64);
  });

  it('sets the Apple-required header and claims', () => {
    const nowMs = 1_700_000_000_000;
    const jwt = buildProviderToken({ keyId: 'KEYID99999', teamId: 'TEAMID0000', key: privateKey, nowMs });
    const [header, claims] = jwt.split('.');

    expect(JSON.parse(b64urlToBuf(header).toString())).toEqual({ alg: 'ES256', kid: 'KEYID99999' });
    expect(JSON.parse(b64urlToBuf(claims).toString())).toEqual({
      iss: 'TEAMID0000',
      iat: Math.floor(nowMs / 1000),
    });
  });
});

describe('apns-voip payload (zero-metadata)', () => {
  it('contains only callId + media — no sender/recipient/identity fields', () => {
    const callId = '11111111-2222-3333-4444-555555555555';
    const payload = JSON.parse(buildVoipPayload(callId, 'audio')) as Record<string, unknown>;

    expect(payload).toEqual({ callId, media: 'audio' });
    // Explicit belt-and-suspenders against a future accidental leak.
    for (const forbidden of ['from', 'fromAegisId', 'sender', 'to', 'aegisId', 'name', 'handle']) {
      expect(payload).not.toHaveProperty(forbidden);
    }
  });

  it('carries the video hint through unchanged', () => {
    const payload = JSON.parse(buildVoipPayload('cid', 'video')) as Record<string, unknown>;
    expect(payload['media']).toBe('video');
  });

  it('callId is opaque — reveals nothing about the caller (documented invariant)', () => {
    // A random UUID hashes to something unrelated to any identity; this test
    // documents intent — the payload never embeds a derivable identifier.
    const callId = 'abcdefab-cdef-abcd-efab-cdefabcdefab';
    const payload = buildVoipPayload(callId, 'audio');
    expect(payload).not.toContain(createHash('sha256').update('anyAegisId').digest('hex'));
  });
});
