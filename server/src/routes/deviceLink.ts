/**
 * AegisLink — Device linking HTTP routes (multi-device)
 *
 * Link tokens are short-lived (5 min), single-use, and stored only in memory.
 * Rate limited to 3 pending tokens per aegisId at a time.
 * The relay never logs IPs or aegisId pairs.
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import type { Server as SocketServer } from 'socket.io';
import { devicesRepo } from '../db/client.js';

// ── In-memory token store ──────────────────────────────────────────────────────

interface LinkToken {
  aegisId: string;
  deviceId: string; // the originating device
  expiresAt: number;
}

const linkTokenStore = new Map<string, LinkToken>();
// aegisId -> count of pending (unexpired) tokens
const pendingTokensPerAegis = new Map<string, number>();

const TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_PENDING_TOKENS = 3;

// Decrement the pending count helper (clamp to 0).
function decrementPending(aegisId: string) {
  const current = pendingTokensPerAegis.get(aegisId) ?? 0;
  const next = current - 1;
  if (next <= 0) {
    pendingTokensPerAegis.delete(aegisId);
  } else {
    pendingTokensPerAegis.set(aegisId, next);
  }
}

// ── Zod schemas ────────────────────────────────────────────────────────────────

const AEGIS_ID_RE = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

const LinkRequestSchema = z.object({
  aegisId: z.string().regex(AEGIS_ID_RE),
  deviceId: z.string().min(1).max(128),
});

const LinkConfirmSchema = z.object({
  linkToken: z.string().min(1).max(128),
  newDeviceId: z.string().min(1).max(128),
  newDevicePubKey: z.string().min(1).max(256),
});

const RevokeParamsSchema = z.object({
  aegisId: z.string().regex(AEGIS_ID_RE),
  deviceId: z.string().min(1).max(128),
});

// ── Factory ────────────────────────────────────────────────────────────────────

export function createDeviceLinkRouter(io: SocketServer): Router {
  const router = Router();

  // Helper: emit to all sockets authenticated under a given aegisId.
  function emitToAegisId(aegisId: string, event: string, data: unknown) {
    io.to(`aegis:${aegisId}`).emit(event, data);
  }

  // POST /devices/link-request
  router.post('/link-request', (req, res) => {
    const parsed = LinkRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_PAYLOAD' });
      return;
    }
    const { aegisId, deviceId } = parsed.data;

    // Rate limit: max MAX_PENDING_TOKENS unexpired tokens per aegisId.
    const pending = pendingTokensPerAegis.get(aegisId) ?? 0;
    if (pending >= MAX_PENDING_TOKENS) {
      res.status(429).json({ error: 'RATE_LIMITED' });
      return;
    }

    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + TOKEN_TTL_MS;

    linkTokenStore.set(token, { aegisId, deviceId, expiresAt });
    pendingTokensPerAegis.set(aegisId, pending + 1);

    // Auto-expire the token.
    setTimeout(() => {
      if (linkTokenStore.has(token)) {
        linkTokenStore.delete(token);
        decrementPending(aegisId);
      }
    }, TOKEN_TTL_MS).unref();

    res.status(200).json({ linkToken: token, expiresAt });
  });

  // POST /devices/link-confirm
  router.post('/link-confirm', (req, res) => {
    const parsed = LinkConfirmSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_PAYLOAD' });
      return;
    }
    const { linkToken, newDeviceId, newDevicePubKey } = parsed.data;

    const entry = linkTokenStore.get(linkToken);
    if (!entry) {
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }
    if (entry.expiresAt < Date.now()) {
      linkTokenStore.delete(linkToken);
      decrementPending(entry.aegisId);
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }

    // Invalidate immediately — single-use.
    linkTokenStore.delete(linkToken);
    decrementPending(entry.aegisId);

    const { aegisId } = entry;

    // Persist in SQLite.
    devicesRepo.upsert({
      device_id: newDeviceId,
      aegis_id: aegisId,
      device_pub_key: newDevicePubKey,
      device_name: 'AegisLink Device',
      platform: 'mobile',
      linked_at: Date.now(),
    }).then(() => {
      // Notify Device A so it can do secure E2EE key handoff to Device B.
      emitToAegisId(aegisId, 'device_linked', {
        newDeviceId,
        newDevicePubKey,
      });
      res.status(200).json({ ok: true, aegisId });
    }).catch(() => {
      res.status(500).json({ error: 'SERVER_ERROR' });
    });
  });

  // DELETE /devices/:aegisId/:deviceId
  router.delete('/:aegisId/:deviceId', (req, res) => {
    const parsed = RevokeParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_PAYLOAD' });
      return;
    }
    const { aegisId, deviceId } = parsed.data;

    devicesRepo.revoke(deviceId, aegisId).then((revoked) => {
      if (!revoked) {
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }
      // Notify all sockets under this aegisId so they can update their device list.
      emitToAegisId(aegisId, 'device_revoked', { deviceId });
      res.status(200).json({ ok: true });
    }).catch(() => {
      res.status(500).json({ error: 'SERVER_ERROR' });
    });
  });

  return router;
}
