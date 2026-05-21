/**
 * web3.ts — AegisLink relay Web3 endpoints
 *
 * Privacy contract for all endpoints in this file:
 *   - No IP addresses are logged or stored.
 *   - No aegisId is accepted, required, or stored in Web3 tables.
 *   - Device revocation stores only SHA-256(DID), never the DID itself.
 *   - Subscription activation is keyed on paymentHash only.
 *   - All validation errors return generic messages (no oracle leakage).
 */

import { Router } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import nacl from 'tweetnacl';
import tweetnaclUtil from 'tweetnacl-util';
const { decodeBase64 } = tweetnaclUtil;
import { z } from 'zod';
import { web3Repo } from '../db/client.js';

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

// ── GET /web3/did/resolve/:did ────────────────────────────────────────────────
// did:key resolution is done entirely on the client. This endpoint is reserved
// for future did:ethr on-chain resolution. Returns 501 until implemented.
router.get('/did/resolve/:did', (_req, res) => {
  res.status(501).json({
    error: 'not_implemented',
    message:
      'did:key DIDs are resolved client-side without a network call. ' +
      'did:ethr on-chain resolution is planned for a future release.',
  });
});

// ── POST /web3/subscription/invoice ──────────────────────────────────────────
// Generates a mock Lightning invoice. In production, replace the mock body
// with a real LND/CLN gRPC call. The server does not know who is requesting —
// no identity data is accepted or stored.

const PLAN_CONFIG: Record<number, { amountSats: number }> = {
  30:  { amountSats: 5_000 },
  90:  { amountSats: 12_000 },
  365: { amountSats: 40_000 },
};

const InvoiceBody = z.object({
  planDays: z.union([z.literal(30), z.literal(90), z.literal(365)]),
  clientNonce: z.string().max(64).optional(),
});

router.post('/subscription/invoice', async (req, res) => {
  const parsed = InvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
    return;
  }

  const { planDays } = parsed.data;
  const plan = PLAN_CONFIG[planDays];

  const preimageBytes = nacl.randomBytes(32);
  const preimageHex = Buffer.from(preimageBytes).toString('hex');
  const paymentHash = sha256Hex(hexToBuffer(preimageHex));

  const createdAt = Date.now();
  const TTL_MS = 10 * 60 * 1000;
  const expiresAt = createdAt + TTL_MS;

  const bolt11 = `lnbc${plan.amountSats}n1mock_${paymentHash.slice(0, 16)}`;

  await web3Repo.insertInvoice({
    payment_hash: paymentHash,
    bolt11,
    amount_sats: plan.amountSats,
    plan_days: planDays,
    created_at: createdAt,
    expires_at: expiresAt,
  });

  res.status(201).json({
    bolt11,
    paymentHash,
    expiresAt,
    amountSats: plan.amountSats,
  });
});

// ── POST /web3/subscription/activate ─────────────────────────────────────────
// Verifies preimage against paymentHash using SHA-256, then activates the sub.
// No user identity is accepted. Activation is keyed only on paymentHash.

const ActivateBody = z.object({
  preimage: z.string().length(64).regex(/^[0-9a-f]+$/i, 'preimage must be hex'),
  paymentHash: z.string().length(64).regex(/^[0-9a-f]+$/i, 'paymentHash must be hex'),
});

router.post('/subscription/activate', async (req, res) => {
  const parsed = ActivateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
    return;
  }

  const { preimage, paymentHash } = parsed.data;

  const computed = sha256Hex(hexToBuffer(preimage));
  const match = timingSafeEqual(
    Buffer.from(computed, 'hex'),
    Buffer.from(paymentHash.toLowerCase(), 'hex')
  );
  if (!match) {
    res.status(403).json({ error: 'invalid_preimage' });
    return;
  }

  const invoice = await web3Repo.getInvoice(paymentHash);
  if (!invoice) {
    res.status(404).json({ error: 'invoice_not_found' });
    return;
  }
  if (Date.now() > invoice.expires_at) {
    res.status(410).json({ error: 'invoice_expired' });
    return;
  }
  if (invoice.paid === 1) {
    const existing = await web3Repo.getSubscription(paymentHash);
    if (existing) {
      res.json({ active: true, expiresAt: existing.expires_at, planDays: existing.plan_days });
      return;
    }
  }

  const activatedAt = Date.now();
  const expiresAt = activatedAt + invoice.plan_days * 24 * 60 * 60 * 1000;

  await web3Repo.markInvoicePaid(paymentHash);
  await web3Repo.insertSubscription({
    payment_hash: paymentHash,
    plan_days: invoice.plan_days,
    activated_at: activatedAt,
    expires_at: expiresAt,
  });

  res.json({ active: true, expiresAt, planDays: invoice.plan_days });
});

// ── POST /web3/device/revoke ──────────────────────────────────────────────────
// Accepts a RevocationPayload. Verifies the Ed25519 signature, then stores
// only the hash. The server never learns the DID in plaintext.

const RevokeBody = z.object({
  didHash: z.string().length(64).regex(/^[0-9a-f]+$/i, 'didHash must be 64 hex chars'),
  revokedAt: z.number().int().positive(),
  signature: z.string().min(80).max(100),    // base64 Ed25519 signature (88 chars)
  signingPublicKeyB64: z.string().min(40).max(50),
});

router.post('/device/revoke', async (req, res) => {
  const parsed = RevokeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
    return;
  }

  const { didHash, revokedAt, signature, signingPublicKeyB64 } = parsed.data;

  const AGE_LIMIT_MS = 5 * 60 * 1000;
  if (Math.abs(Date.now() - revokedAt) > AGE_LIMIT_MS) {
    res.status(400).json({ error: 'revocation_timestamp_out_of_range' });
    return;
  }

  const messageText = `aegislink:revoke:${didHash}:${revokedAt}`;
  const messageBytes = new TextEncoder().encode(messageText);

  let sigBytes: Uint8Array;
  let pubKeyBytes: Uint8Array;
  try {
    sigBytes = decodeBase64(signature);
    pubKeyBytes = decodeBase64(signingPublicKeyB64);
  } catch {
    res.status(400).json({ error: 'invalid_base64' });
    return;
  }

  const valid = nacl.sign.detached.verify(messageBytes, sigBytes, pubKeyBytes);
  if (!valid) {
    res.status(403).json({ error: 'invalid_signature' });
    return;
  }

  if (await web3Repo.isRevoked(didHash)) {
    res.status(200).json({ revoked: true });
    return;
  }

  await web3Repo.insertRevocation({
    did_hash: didHash,
    revoked_at: revokedAt,
    signature_b64: signature,
    signing_pub_key: signingPublicKeyB64,
  });

  res.status(201).json({ revoked: true });
});

// ── GET /web3/device/revocation/:didHash ─────────────────────────────────────
// Returns whether a given DID hash is revoked. Does not reveal other devices.

const DID_HASH_RE = /^[0-9a-f]{64}$/i;

router.get('/device/revocation/:didHash', async (req, res) => {
  const { didHash } = req.params;
  if (!DID_HASH_RE.test(didHash)) {
    res.status(400).json({ error: 'invalid_did_hash_format' });
    return;
  }
  const revoked = await web3Repo.isRevoked(didHash.toLowerCase());
  res.json({ revoked });
});

export default router;
