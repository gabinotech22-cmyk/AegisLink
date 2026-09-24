/**
 * web3.ts — AegisLink relay Web3 endpoints (DID resolution only).
 *
 * Privacy contract:
 *   - No IP addresses are logged or stored.
 *   - No aegisId is accepted, required, or stored in Web3 tables.
 *   - DID revocations are stored as SHA-256(DID) only — no key, signature or
 *     timestamp — and are written exclusively by the owner-signed account
 *     deletion (routes/identity.ts), never by an unauthenticated request.
 *   - DID resolution is computed on the fly and never logged.
 *   - All validation errors return generic messages (no oracle leakage).
 *
 * The mock Lightning subscription endpoints (/subscription/invoice|activate)
 * were removed (audit 2026-09-24 P-1): payments left this repo with AegisLink
 * Work (ROADMAP Hito 1), their invoices could never be paid, and nothing here
 * accepts a write any more.
 */

import { Router, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { web3Repo } from '../db/client.js';
import { didHashHex, didKeyDocument, ed25519FromDidKey } from '../crypto/didKey.js';

const router = Router();

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

export default router;
