/**
 * auth.test.ts — challenge/response key-ownership proof (auth/challenge.ts).
 *
 * Verifies the Ed25519/X25519 box challenge that authenticates a socket as the
 * holder of the secret key paired with a registered identity.
 *
 * Cases:
 *   - valid response authenticates
 *   - expired challenge is rejected (TTL)
 *   - wrong/forged plaintext is rejected
 *   - replay against a fresh challenge fails (each challenge is unique)
 *   - unknown identity yields no challenge
 */

import nacl from 'tweetnacl';
import tweetnaclUtil from 'tweetnacl-util';

process.env['AEGIS_DB_PATH'] = ':memory:';

const { encodeBase64 } = tweetnaclUtil;

const { identityRepo } = await import('../db/client.js');
const { issueChallenge, verifyResponse } = await import('../auth/challenge.js');

const AEGIS_ID = 'ABC-2345-6789';

// The client's long-term X25519 keypair. issueChallenge encrypts to publicKey.
const clientKeys = nacl.box.keyPair();

beforeAll(async () => {
  await identityRepo.insert({
    aegis_id: AEGIS_ID,
    public_key_b64: encodeBase64(clientKeys.publicKey),
    signing_public_key_b64: encodeBase64(nacl.sign.keyPair().publicKey),
    created_at: Date.now(),
  });
});

/** Simulate the client: open the box and recover the plaintext to echo back. */
function solve(challenge: {
  ephemeralPubKeyB64: string;
  nonceB64: string;
  ciphertextB64: string;
}): string {
  const { decodeBase64 } = tweetnaclUtil;
  const opened = nacl.box.open(
    decodeBase64(challenge.ciphertextB64),
    decodeBase64(challenge.nonceB64),
    decodeBase64(challenge.ephemeralPubKeyB64),
    clientKeys.secretKey,
  );
  if (!opened) throw new Error('client could not open challenge');
  return encodeBase64(opened);
}

describe('challenge-response auth', () => {
  it('authenticates a valid response from the key holder', async () => {
    const challenge = await issueChallenge(AEGIS_ID);
    expect(challenge).not.toBeNull();
    const answer = solve(challenge!);
    expect(verifyResponse(challenge!, answer)).toBe(true);
  });

  it('rejects an expired challenge', async () => {
    const challenge = await issueChallenge(AEGIS_ID);
    const answer = solve(challenge!);
    // Force the challenge past its 30s TTL.
    challenge!.issuedAt = Date.now() - 31_000;
    expect(verifyResponse(challenge!, answer)).toBe(false);
  });

  it('rejects a forged / wrong plaintext', async () => {
    const challenge = await issueChallenge(AEGIS_ID);
    const forged = encodeBase64(nacl.randomBytes(32));
    expect(verifyResponse(challenge!, forged)).toBe(false);
  });

  it('rejects a non-string response', async () => {
    const challenge = await issueChallenge(AEGIS_ID);
    expect(verifyResponse(challenge!, undefined)).toBe(false);
    expect(verifyResponse(challenge!, 12345)).toBe(false);
    expect(verifyResponse(challenge!, { plain: 'x' })).toBe(false);
  });

  it('issues a unique challenge each time (replay-resistant)', async () => {
    const c1 = await issueChallenge(AEGIS_ID);
    const c2 = await issueChallenge(AEGIS_ID);
    expect(c1!.ciphertextB64).not.toEqual(c2!.ciphertextB64);
    expect(c1!.expectedB64).not.toEqual(c2!.expectedB64);
    // A response valid for c1 must NOT validate against the fresh c2.
    const answer1 = solve(c1!);
    expect(verifyResponse(c1!, answer1)).toBe(true);
    expect(verifyResponse(c2!, answer1)).toBe(false);
  });

  it('returns null for an unknown identity', async () => {
    const challenge = await issueChallenge('ZZZ-9999-9999');
    expect(challenge).toBeNull();
  });

  it('rejects a wrong-key holder (different secret key)', async () => {
    const challenge = await issueChallenge(AEGIS_ID);
    const attacker = nacl.box.keyPair();
    const { decodeBase64 } = tweetnaclUtil;
    const opened = nacl.box.open(
      decodeBase64(challenge!.ciphertextB64),
      decodeBase64(challenge!.nonceB64),
      decodeBase64(challenge!.ephemeralPubKeyB64),
      attacker.secretKey,
    );
    // Attacker cannot even open the box.
    expect(opened).toBeNull();
  });
});
