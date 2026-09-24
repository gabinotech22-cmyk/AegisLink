/**
 * web3.ts — AegisLink relay Web3 endpoints
 *
 * Privacy contract for all endpoints in this file:
 *   - No IP addresses are logged or stored.
 *   - No aegisId is accepted, required, or stored in Web3 tables.
 *   - DID revocations are stored as SHA-256(DID) only — no key, signature or
 *     timestamp — and are written exclusively by the owner-signed account
 *     deletion (routes/identity.ts), never by an unauthenticated request.
 *   - DID resolution is computed on the fly and never logged.
 *   - Subscription activation is keyed on paymentHash only.
 *   - All validation errors return generic messages (no oracle leakage).
 */

import { Router, type Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import nacl from 'tweetnacl';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { web3Repo } from '../db/client.js';
import { didHashHex, didKeyDocument, ed25519FromDidKey } from '../crypto/didKey.js';

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

// ── GET /web3/did/resolve/:did ────────────────────────────────────────────────
// W3C DID Resolution (https://w3c-ccg.github.io/did-resolution/) for the DID
// method AegisLink issues: did:key over the identity's Ed25519 signing key.
// The document is derived from the DID itself; the relay only contributes the
// `deactivated` flag (identity deleted by its owner). Status codes follow the
// resolution HTTP(S) binding: 200 ok · 400 invalidDid · 410 deactivated ·
// 501 methodNotSupported. did:ethr is intentionally unsupported — on-chain
// anchoring would break "anonymous by default, no wallet" (ROADMAP.md).
//
// Clients resolve their contacts' did:key locally; hitting this endpoint tells
// the relay which DID is being looked up, so it exists for the deactivation
// status and for third-party verifiers, not for routine client use.

const RESOLUTION_CONTEXT = 'https://w3id.org/did-resolution/v1';
const RESOLUTION_CONTENT_TYPE = 'application/ld+json;profile="https://w3id.org/did-resolution"';
const DID_SYNTAX_RE = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const MAX_DID_LENGTH = 256;

const resolveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'rate_limit_exceeded', retryAfterMs: 60 * 1000 });
  },
});

function sendResolution(
  res: Response,
  status: number,
  body: {
    didDocument: ReturnType<typeof didKeyDocument> | null;
    didResolutionMetadata: Record<string, string>;
    didDocumentMetadata: Record<string, boolean>;
  }
): void {
  res
    .status(status)
    .type(RESOLUTION_CONTENT_TYPE)
    .send(JSON.stringify({ '@context': RESOLUTION_CONTEXT, ...body }));
}

router.get('/did/resolve/:did', resolveLimiter, async (req, res) => {
  const did = String(req.params.did);

  if (did.length > MAX_DID_LENGTH || !DID_SYNTAX_RE.test(did)) {
    sendResolution(res, 400, {
      didDocument: null,
      didResolutionMetadata: { error: 'invalidDid' },
      didDocumentMetadata: {},
    });
    return;
  }

  if (!did.startsWith('did:key:')) {
    sendResolution(res, 501, {
      didDocument: null,
      didResolutionMetadata: { error: 'methodNotSupported' },
      didDocumentMetadata: {},
    });
    return;
  }

  // Only a canonical Ed25519 did:key resolves — a non-canonical alias of a
  // revoked key would otherwise hash differently and read as active.
  if (!ed25519FromDidKey(did)) {
    sendResolution(res, 400, {
      didDocument: null,
      didResolutionMetadata: { error: 'invalidDid' },
      didDocumentMetadata: {},
    });
    return;
  }

  const deactivated = await web3Repo.isRevoked(didHashHex(did));
  sendResolution(res, deactivated ? 410 : 200, {
    didDocument: didKeyDocument(did),
    didResolutionMetadata: { contentType: 'application/did+ld+json' },
    didDocumentMetadata: deactivated ? { deactivated: true } : {},
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

export default router;
