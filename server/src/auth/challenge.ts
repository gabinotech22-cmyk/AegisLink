import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { identityRepo } from '../db/client.js';

const { encodeBase64, decodeBase64 } = naclUtil;

/**
 * Challenge/response key-ownership proof.
 *
 *   server -> client: { ephemeralPubKey, nonce, ciphertext }
 *      where ciphertext = nacl.box(randomBytes32, nonce, claimedPubKey, ephemeralSecretKey)
 *
 *   client opens with: nacl.box.open(ct, nonce, ephemeralPubKey, mySecretKey)
 *   only the holder of the secretKey paired with `claimedPubKey` recovers the
 *   original 32 random bytes.
 *
 *   client -> server: { plain: base64(randomBytes32) }
 *
 * Server compares; if equal AND within TTL, the socket is authenticated as
 * `claimedAegisId`. Replays are useless because the ephemeral key + nonce + 32
 * random bytes are fresh per connection.
 */

export interface Challenge {
  ephemeralPubKeyB64: string;
  nonceB64: string;
  ciphertextB64: string;
  /** Server-side only. The plaintext bytes the client must echo back. */
  expectedB64: string;
  issuedAt: number;
}

export interface WireChallenge {
  ephemeralPubKey: string;
  nonce: string;
  ciphertext: string;
}

const CHALLENGE_TTL_MS = 30_000;

export async function issueChallenge(claimedAegisId: string): Promise<Challenge | null> {
  const identity = await identityRepo.get(claimedAegisId);
  if (!identity) return null;
  const claimedPubKey = decodeBase64(identity.public_key_b64);
  if (claimedPubKey.length !== nacl.box.publicKeyLength) return null;

  const ephemeral = nacl.box.keyPair();
  const plain = nacl.randomBytes(32);
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ciphertext = nacl.box(plain, nonce, claimedPubKey, ephemeral.secretKey);

  return {
    ephemeralPubKeyB64: encodeBase64(ephemeral.publicKey),
    nonceB64: encodeBase64(nonce),
    ciphertextB64: encodeBase64(ciphertext),
    expectedB64: encodeBase64(plain),
    issuedAt: Date.now(),
  };
}

export function challengeWire(c: Challenge): WireChallenge {
  return {
    ephemeralPubKey: c.ephemeralPubKeyB64,
    nonce: c.nonceB64,
    ciphertext: c.ciphertextB64,
  };
}

export function verifyResponse(challenge: Challenge, responseB64: unknown): boolean {
  if (typeof responseB64 !== 'string') return false;
  if (Date.now() - challenge.issuedAt > CHALLENGE_TTL_MS) return false;
  return constantTimeEqual(responseB64, challenge.expectedB64);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
